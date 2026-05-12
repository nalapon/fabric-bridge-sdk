import * as fabricNetwork from "fabric-network";
import type { X509Identity } from "fabric-network/lib/impl/wallet/x509identity.js";
import type { BridgeConfig } from "../types/config";
import {
  ConfigurationError,
  DiscoveryError,
  TimeoutError,
} from "../errors/index";
import { Result } from "better-result";
import type {
  DiscoveryResult,
  PeerInfo,
  OrdererInfo,
  MSPInfo,
} from "../types/discovery";
import { DiscoveryCache } from "../cache/DiscoveryCache";
import { log } from "../utils/logger";

/**
 * Detects if the endpoint is localhost based on the hostname.
 * Automatically sets asLocalhost for fabric-network discovery.
 * 
 * Returns true for:
 * - localhost
 * - 127.0.0.1
 * - ::1
 * - Any 127.x.x.x address
 * 
 * Returns false for production DNS names.
 */
function isLocalhostEndpoint(endpoint: string): boolean {
  const [host] = endpoint.split(':');
  return host === 'localhost' || 
         host === '127.0.0.1' || 
         host === '::1' ||
         (!!host && host.startsWith('127.'));
}

function sanitizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) {
    return "";
  }

  return endpoint.trim().replace(/^"+|"+$/g, "");
}

function endpointUsesTLS(config: BridgeConfig): boolean {
  return !!config.tlsOptions?.trustedRoots;
}

export class PeerConnection {
  private gateway: fabricNetwork.Gateway | null = null;
  private config: BridgeConfig;
  private discoveryCache: DiscoveryCache;

  constructor(config: BridgeConfig, discoveryCache: DiscoveryCache) {
    this.config = config;
    this.discoveryCache = discoveryCache;
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    const { identity, tlsOptions, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5000;

    log().info('PeerConnection.connect() - Iniciando conexión');
    log().debug('PeerConnection.connect() - Config:', {
      gatewayPeer: this.config.gatewayPeer,
      mspId: identity.mspId,
      hasTrustedRoots: !!tlsOptions?.trustedRoots,
      trustedRootsLength: tlsOptions?.trustedRoots?.length,
      hasClientCert: !!tlsOptions?.clientCert,
      clientCertLength: tlsOptions?.clientCert?.length,
      hasClientKey: !!tlsOptions?.clientKey,
      clientKeyLength: tlsOptions?.clientKey?.length,
      hasPrivateKey: !!identity.privateKey,
      discovery: this.config.discovery,
      connectTimeout,
    });

    return Result.tryPromise({
      try: async () => {
        log().debug('PeerConnection.connect() - Creando wallet in-memory');
        const wallet = await fabricNetwork.Wallets.newInMemoryWallet();

        if (!identity.privateKey) {
          log().error('PeerConnection.connect() - Private key no proporcionada');
          throw new Error(
            "Private key is required for peer-targeted mode. Please provide identity.privateKey in BridgeConfig",
          );
        }

        log().debug('PeerConnection.connect() - Creando identidad X.509');
        const x509Identity: X509Identity = {
          type: "X.509",
          mspId: identity.mspId,
          credentials: {
            certificate: identity.credentials.toString(),
            privateKey: identity.privateKey.toString(),
          },
        };

        await wallet.put(identity.mspId, x509Identity as fabricNetwork.Identity);
        log().debug('PeerConnection.connect() - Identidad X.509 guardada en wallet');

        const asLocalhost = isLocalhostEndpoint(this.config.gatewayPeer);
        log().debug(`PeerConnection.connect() - Auto-detected asLocalhost: ${asLocalhost} (from ${this.config.gatewayPeer})`);

        const gatewayOptions: fabricNetwork.GatewayOptions = {
          wallet,
          identity: identity.mspId,
          discovery: {
            enabled: this.config.discovery ?? true,
            asLocalhost,
          },
          eventHandlerOptions: {
            commitTimeout: Math.round(
              Math.min(this.config.timeouts?.commit ?? 5000, 5000) / 1000,
            ),
          },
          tlsInfo: tlsOptions?.clientCert && tlsOptions?.clientKey
            ? {
                certificate: tlsOptions.clientCert.toString(),
                key: tlsOptions.clientKey.toString(),
              }
            : undefined,
        };

        log().debug('PeerConnection.connect() - GatewayOptions:', {
          identity: identity.mspId,
          discoveryEnabled: gatewayOptions.discovery?.enabled,
          discoveryAsLocalhost: gatewayOptions.discovery?.asLocalhost,
          hasTlsInfo: !!gatewayOptions.tlsInfo,
        });

        this.gateway = new fabricNetwork.Gateway();

        log().debug('PeerConnection.connect() - Creando connection profile');
        const connectionProfile = this.createMinimalConnectionProfile();
        log().debug('PeerConnection.connect() - Connection profile:', JSON.stringify({
          name: connectionProfile.name,
          version: connectionProfile.version,
          organization: connectionProfile.client?.organization,
          peerCount: connectionProfile.peers ? Object.keys(connectionProfile.peers).length : 0,
        }, null, 2));

        log().debug('PeerConnection.connect() - Llamando a gateway.connect()');
        await this.gateway.connect(connectionProfile, gatewayOptions);
        
        log().info('PeerConnection.connect() - Conexión exitosa');
      },
      catch: (e) => {
        log().error('PeerConnection.connect() - Error:', e instanceof Error ? e.message : String(e));
        if (e instanceof Error && e.message.includes('timeout')) {
          return new TimeoutError({
            message: `Failed to connect to peer network: ${e.message}`,
            operation: 'connect',
            timeout: connectTimeout,
          });
        }
        return new ConfigurationError({
          message: `Failed to connect to peer network: ${e instanceof Error ? e.message : String(e)}`,
        });
      },
    });
  }

  getGateway(): fabricNetwork.Gateway {
    if (!this.gateway) {
      throw new Error("Peer gateway not connected. Call connect() first.");
    }
    return this.gateway;
  }

  async disconnect(): Promise<void> {
    log().info('PeerConnection.disconnect() - Desconectando');
    this.gateway?.disconnect();
    this.gateway = null;
    // Allow fabric-network to complete its async cleanup
    await new Promise(resolve => setImmediate(resolve));
  }

  async discover(
    channelName: string,
  ): Promise<Result<DiscoveryResult, DiscoveryError>> {
    log().debug('PeerConnection.discover() - Iniciando discovery para canal:', channelName);
    
    const cached = this.discoveryCache.get(channelName);
    if (cached && !this.discoveryCache.isStale(channelName)) {
      log().debug('PeerConnection.discover() - Usando cache para canal:', channelName);
      return Result.ok(cached);
    }

    try {
      if (!this.gateway) {
        log().error('PeerConnection.discover() - Gateway no conectado');
        throw new Error("Not connected");
      }

      log().debug('PeerConnection.discover() - Obteniendo network para canal:', channelName);
      const network = await this.gateway.getNetwork(channelName);

      const discoveryService = (network as any).discoveryService;

      if (!discoveryService) {
        log().error('PeerConnection.discover() - Discovery service no disponible');
        throw new Error("Discovery service not available");
      }

      log().debug('PeerConnection.discover() - Parseando resultados de discovery');
      const result = this.parseDiscoveryResults(discoveryService, channelName);
      
      log().info('PeerConnection.discover() - Discovery exitoso:', {
        channelName,
        peerCount: result.peers.size,
        ordererCount: result.orderers.length,
        mspCount: result.msps.size,
      });

      this.discoveryCache.set(channelName, result);

      return Result.ok(result);
    } catch (error) {
      log().error('PeerConnection.discover() - Error:', error instanceof Error ? error.message : String(error));
      
      if (cached) {
        log().debug('PeerConnection.discover() - Usando cache stale como fallback');
        setTimeout(() => this.discover(channelName).catch(() => {}), 0);
        return Result.ok(cached);
      }

      return Result.err(
        new DiscoveryError({
          message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }
  }

  private createMinimalConnectionProfile(): any {
    const { gatewayPeer, tlsOptions, identity } = this.config;
    const [hostPart] = gatewayPeer.split(":");
    const host: string = hostPart || "localhost";
    const mspId: string = identity.mspId;
    const peerName = tlsOptions?.sslTargetNameOverride ?? host;

    const profile: any = {
      name: "bridge-network",
      version: "1.0",
      client: {
        organization: mspId,
        connection: {
          timeout: {
            peer: {
              endorser: this.config.timeouts?.endorse || 30000,
            },
          },
        },
      },
      organizations: {},
      peers: {},
    };

    profile.organizations[mspId] = {
      mspid: mspId,
      peers: [peerName],
    };

    profile.peers[peerName] = {
      url: `${tlsOptions ? "grpcs" : "grpc"}://${gatewayPeer}`,
      tlsCACerts: tlsOptions?.trustedRoots
        ? {
            pem: tlsOptions.trustedRoots.toString(),
          }
        : undefined,
      grpcOptions: {
        "ssl-target-name-override": peerName,
      },
    };

    return profile;
  }

  private parseDiscoveryResults(
    discoveryService: any,
    channelName: string,
  ): DiscoveryResult {
    // Use discoveryResults property (already populated during network initialization)
    // Note: getDiscoveryResults() is async, but discoveryResults property has the cached results
    const results = discoveryService.discoveryResults || {};

    const peers = new Map<string, PeerInfo>();
    const orderers: OrdererInfo[] = [];
    const msps = new Map<string, MSPInfo>();

    // Parse peers from discovery results
    const discoveredPeers = results.peers_by_org || {};
    for (const [mspId, orgInfo] of Object.entries(discoveredPeers)) {
      const peersList = (orgInfo as any).peers || [];
      for (const peer of peersList) {
        const endpoint = this.normalizePeerEndpointIdentity(sanitizeEndpoint(peer.endpoint));
        if (peers.has(endpoint)) {
          throw new Error(`Discovery returned duplicate peer endpoint identity: ${endpoint}`);
        }
        const peerName = endpointHost(endpoint) || "unknown";
        peers.set(endpoint, {
          name: peerName,
          endpoint,
          mspId: mspId,
          chaincodes: peer.chaincodes?.map((cc: any) => cc.name) || [],
          ledgerHeight:
            (BigInt(peer.ledger_height?.high || 0) << BigInt(32)) |
            BigInt(peer.ledger_height?.low || 0),
        });
      }
    }

    // Parse orderers
    const discoveredOrderers = results.orderers || {};
    for (const [mspId, ordererInfo] of Object.entries(discoveredOrderers)) {
      const endpoints = (ordererInfo as any).endpoints || [];
      for (const endpoint of endpoints) {
        orderers.push({
          endpoint: `${endpoint.host}:${endpoint.port}`,
          mspId,
        });
      }
    }

    // Parse MSPs
    const discoveredMsps = results.msps || {};
    for (const [mspId, mspInfo] of Object.entries(discoveredMsps)) {
      msps.set(mspId, {
        id: mspId,
        tlsRootCerts:
          (mspInfo as any).tls_root_certs?.map((cert: string) =>
            Buffer.from(cert),
          ) || [],
      });
    }

    return {
      timestamp: Date.now(),
      channelName,
      peers,
      orderers,
      msps,
    };
  }

  matchPeerByEndpointIdentity(
    discoveryResult: DiscoveryResult,
    endpoint: string,
  ): PeerInfo | null {
    const canonicalEndpoint = this.normalizePeerEndpointIdentity(endpoint);
    return discoveryResult.peers.get(canonicalEndpoint) ?? null;
  }

  normalizePeerEndpointIdentity(endpoint: string): string {
    return normalizePeerEndpointIdentity(endpoint, endpointUsesTLS(this.config));
  }
}

export function normalizePeerEndpointIdentity(raw: string, tlsEnabled: boolean): string {
  const value = raw.trim();
  if (!value) {
    throw new ConfigurationError({
      field: 'peerEndpoint',
      message: 'peer endpoint must be a non-empty host:port value',
    });
  }

  const lower = value.toLowerCase();
  let scheme = tlsEnabled ? 'grpcs' : 'grpc';
  let hostPort = value;
  if (lower.startsWith('grpc://') || lower.startsWith('grpcs://')) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'grpc:' && parsed.protocol !== 'grpcs:') {
      throw new ConfigurationError({
        field: 'peerEndpoint',
        message: `peer endpoint scheme must be grpc or grpcs: ${raw}`,
      });
    }
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash || !parsed.hostname || !parsed.port) {
      throw new ConfigurationError({
        field: 'peerEndpoint',
        message: `peer endpoint must be grpc(s)://host:port: ${raw}`,
      });
    }
    scheme = parsed.protocol.slice(0, -1);
    hostPort = `${parsed.hostname}:${parsed.port}`;
  } else if (value.includes('://')) {
    throw new ConfigurationError({
      field: 'peerEndpoint',
      message: `peer endpoint scheme must be grpc or grpcs: ${raw}`,
    });
  }

  const separator = hostPort.lastIndexOf(':');
  if (separator <= 0 || separator === hostPort.length - 1) {
    throw new ConfigurationError({
      field: 'peerEndpoint',
      message: `peer endpoint must include host:port: ${raw}`,
    });
  }

  const host = hostPort.slice(0, separator).toLowerCase();
  const port = hostPort.slice(separator + 1);
  if (!/^\d+$/.test(port)) {
    throw new ConfigurationError({
      field: 'peerEndpoint',
      message: `peer endpoint port must be numeric: ${raw}`,
    });
  }

  return `${scheme}://${host}:${port}`;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(':');
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}
