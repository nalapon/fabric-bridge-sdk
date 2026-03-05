import * as grpc from '@grpc/grpc-js';
import * as fabricGateway from '@hyperledger/fabric-gateway';
import type { ResolvedBridgeConfig, Signer } from '../types/config';
import { ConfigurationError, TimeoutError } from '../errors/index';
import { Result } from 'better-result';

export class GatewayConnection {
  private client: grpc.Client | null = null;
  private gateway: fabricGateway.Gateway | null = null;
  private config: ResolvedBridgeConfig;

  constructor(config: ResolvedBridgeConfig) {
    this.config = config;
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    const { gatewayPeer, identity, signer, tlsOptions, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5000;
    
    return Result.tryPromise({
      try: async () => {
        const tlsCredentials = tlsOptions?.trustedRoots
          ? grpc.credentials.createSsl(tlsOptions.trustedRoots)
          : grpc.credentials.createInsecure();

        const hostname = this.extractHostname(gatewayPeer);
        const clientOptions: grpc.ChannelOptions = hostname ? {
          'grpc.ssl_target_name_override': hostname,
        } : {};

        this.client = new grpc.Client(gatewayPeer, tlsCredentials, clientOptions);
        
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            this.client!.waitForReady(Date.now() + connectTimeout, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), connectTimeout)
          ),
        ]);

        this.gateway = fabricGateway.connect({
          client: this.client,
          identity: {
            mspId: identity.mspId,
            credentials: identity.credentials,
          },
          signer: this.adaptSigner(signer),
        });
      },
      catch: (e) => {
        if (e instanceof Error && e.message.includes('timeout')) {
          return new TimeoutError({
            message: `Failed to connect to gateway peer: ${gatewayPeer}`,
            operation: 'connect',
            timeout: connectTimeout,
          });
        }
        return new ConfigurationError({
          message: `Failed to connect to gateway: ${e instanceof Error ? e.message : String(e)}`,
          field: 'gatewayPeer',
        });
      },
    });
  }

  getGateway(): fabricGateway.Gateway {
    if (!this.gateway) {
      throw new Error('Gateway not connected. Call connect() first.');
    }
    return this.gateway;
  }

  disconnect(): void {
    this.gateway?.close();
    this.client?.close();
    this.gateway = null;
    this.client = null;
  }

  private adaptSigner(signer: Signer): fabricGateway.Signer {
    return async (digest: Uint8Array) => {
      const signature = await signer(digest);
      return Buffer.from(signature);
    };
  }

  private extractHostname(endpoint: string): string | undefined {
    const parts = endpoint.split(':');
    return parts[0] || undefined;
  }
}
