import * as fabricNetwork from "fabric-network";
import type { X509Identity } from "fabric-network/lib/impl/wallet/x509identity";
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

export class PeerConnection {
  private gateway: fabricNetwork.Gateway | null = null;
  private config: BridgeConfig;
  private discoveryCache: DiscoveryCache;

  constructor(config: BridgeConfig, discoveryCache: DiscoveryCache) {
    this.config = config;
    this.discoveryCache = discoveryCache;
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    try {
      const { identity, tlsOptions } = this.config;

      // Create wallet with identity
      const wallet = await fabricNetwork.Wallets.newInMemoryWallet();
      const cert = Buffer.isBuffer(identity.credentials)
        ? identity.credentials.toString()
        : identity.credentials;

      // fabric-network X509Identity requires credentials with certificate and privateKey
      // We need the private key for fabric-network's wallet
      const privateKey = identity.privateKey
        ? identity.privateKey.toString()
        : "";

      if (!privateKey) {
        throw new Error(
          "Private key is required for peer-targeted mode. Please provide identity.privateKey in BridgeConfig",
        );
      }

      const x509Identity: X509Identity = {
        type: "X.509",
        mspId: identity.mspId,
        credentials: {
          certificate: cert,
          privateKey: privateKey,
        },
      };

      await wallet.put(identity.mspId, x509Identity as fabricNetwork.Identity);

      // Create gateway connection options
      const gatewayOptions: fabricNetwork.GatewayOptions = {
        wallet,
        identity: identity.mspId,
        discovery: {
          enabled: this.config.discovery ?? true,
          asLocalhost: true, // Convert discovered hostnames to localhost for local test-network
        },
        clientTlsIdentity: tlsOptions ? identity.mspId : undefined,
      };

      this.gateway = new fabricNetwork.Gateway();

      // Note: fabric-network requires a connection profile
      // We'll use minimal connection profile with just the gateway peer
      const connectionProfile = this.createMinimalConnectionProfile();

      await this.gateway.connect(connectionProfile, gatewayOptions);

      return Result.ok(undefined);
    } catch (error) {
      return Result.err(
        new ConfigurationError({
          message: `Failed to connect to peer network: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  }

  getGateway(): fabricNetwork.Gateway {
    if (!this.gateway) {
      throw new Error("Peer gateway not connected. Call connect() first.");
    }
    return this.gateway;
  }

  disconnect(): void {
    this.gateway?.disconnect();
    this.gateway = null;
  }

  async discover(
    channelName: string,
  ): Promise<Result<DiscoveryResult, DiscoveryError>> {
    // Check cache first
    const cached = this.discoveryCache.get(channelName);
    if (cached && !this.discoveryCache.isStale(channelName)) {
      return Result.ok(cached);
    }

    try {
      if (!this.gateway) {
        throw new Error("Not connected");
      }

      // Get network - this triggers initialization which performs discovery automatically
      const network = await this.gateway.getNetwork(channelName);

      // Get discovery service from NETWORK (fabric-network NetworkImpl), not from channel
      // fabric-network automatically creates and uses discovery service during network initialization
      const discoveryService = (network as any).discoveryService;

      if (!discoveryService) {
        throw new Error("Discovery service not available");
      }

      // Discovery was already performed during network initialization
      // Just parse the results that are already available
      const result = this.parseDiscoveryResults(discoveryService, channelName);

      // Update cache
      this.discoveryCache.set(channelName, result);

      return Result.ok(result);
    } catch (error) {
      // If we have stale cached data, return it as fallback
      if (cached) {
        // Trigger background refresh for next time
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
      peers: [host],
    };

    profile.peers[host] = {
      url: `${tlsOptions ? "grpcs" : "grpc"}://${gatewayPeer}`,
      tlsCACerts: tlsOptions?.trustedRoots
        ? {
            pem: tlsOptions.trustedRoots.toString(),
          }
        : undefined,
      grpcOptions: {
        "ssl-target-name-override": host,
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
        const peerName = peer.endpoint?.split(":")[0] || "unknown";
        peers.set(peerName, {
          name: peerName,
          endpoint: peer.endpoint || "",
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

  matchPeerByPartialName(
    discoveryResult: DiscoveryResult,
    partialName: string,
  ): PeerInfo | null {
    // First try exact match
    if (discoveryResult.peers.has(partialName)) {
      return discoveryResult.peers.get(partialName)!;
    }

    // Try partial match
    for (const [peerName, peerInfo] of discoveryResult.peers) {
      if (peerName.includes(partialName) || partialName.includes(peerName)) {
        return peerInfo;
      }
    }

    // Try matching by endpoint hostname
    for (const [, peerInfo] of discoveryResult.peers) {
      const endpointHostname = peerInfo.endpoint.split(":")[0];
      if (!endpointHostname) continue;
      if (
        endpointHostname.includes(partialName) ||
        partialName.includes(endpointHostname)
      ) {
        return peerInfo;
      }
    }

    return null;
  }
}
