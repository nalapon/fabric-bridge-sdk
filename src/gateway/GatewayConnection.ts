import * as grpc from '@grpc/grpc-js';
import * as fabricGateway from '@hyperledger/fabric-gateway';
import { createHash } from 'crypto';
import * as gatewayProto from '@hyperledger/fabric-protos/lib/gateway/gateway_pb';
import { SerializedIdentity } from '@hyperledger/fabric-protos/lib/msp/identities_pb';
import type { BridgeConfig, Signer } from '../types/config';
import type { CommitStatus } from '../types/bridge';
import { CommitError, ConfigurationError, NotConnectedError, TimeoutError } from '../errors/index';
import { Result } from 'better-result';
import { log } from '../utils/logger';

export class GatewayConnection {
  private client: grpc.Client | null = null;
  private gateway: fabricGateway.Gateway | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    const { gatewayPeer, identity, signer, tlsOptions, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5000;
    
    log().info('GatewayConnection.connect() - Iniciando conexión');
    log().debug('GatewayConnection.connect() - Config:', {
      gatewayPeer,
      mspId: identity.mspId,
      hasTrustedRoots: !!tlsOptions?.trustedRoots,
      trustedRootsLength: tlsOptions?.trustedRoots?.length,
      hasClientCert: !!tlsOptions?.clientCert,
      clientCertLength: tlsOptions?.clientCert?.length,
      hasClientKey: !!tlsOptions?.clientKey,
      clientKeyLength: tlsOptions?.clientKey?.length,
      connectTimeout,
    });
    
    return Result.tryPromise({
      try: async () => {
        log().debug('GatewayConnection.connect() - Creando credenciales TLS');
        
        let tlsCredentials: grpc.ChannelCredentials;
        if (tlsOptions?.trustedRoots) {
          if (tlsOptions?.clientKey && tlsOptions?.clientCert) {
            log().debug('GatewayConnection.connect() - Usando mTLS (certificado cliente)');
            tlsCredentials = grpc.credentials.createSsl(
              tlsOptions.trustedRoots,
              tlsOptions.clientKey,
              tlsOptions.clientCert
            );
          } else {
            log().debug('GatewayConnection.connect() - Usando TLS normal (solo verificar servidor)');
            tlsCredentials = grpc.credentials.createSsl(tlsOptions.trustedRoots);
          }
        } else {
          log().debug('GatewayConnection.connect() - Usando conexión insegura (sin TLS)');
          tlsCredentials = grpc.credentials.createInsecure();
        }

        const hostname = tlsOptions?.sslTargetNameOverride ?? this.extractHostname(gatewayPeer);
        const clientOptions: grpc.ChannelOptions = hostname ? {
          'grpc.ssl_target_name_override': hostname,
        } : {};

        log().debug('GatewayConnection.connect() - Creando gRPC Client:', {
          endpoint: gatewayPeer,
          hostname,
          hasSslOverride: !!hostname,
        });
        
        this.client = new grpc.Client(gatewayPeer, tlsCredentials, clientOptions);
        
        log().debug('GatewayConnection.connect() - Esperando conexión ready (timeout:', connectTimeout, 'ms)');
        
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            this.client!.waitForReady(Date.now() + connectTimeout, (error) => {
              if (error) {
                const grpcError = error as Error & { code?: number; details?: string };
                log().error('GatewayConnection.connect() - Error en waitForReady:', {
                  code: grpcError.code,
                  message: grpcError.message,
                  details: grpcError.details,
                });
                reject(error);
              }
              else resolve();
            });
          }),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), connectTimeout)
          ),
        ]);

        log().debug('GatewayConnection.connect() - gRPC Client conectado, creando Fabric Gateway');
        
        this.gateway = fabricGateway.connect({
          client: this.client,
          identity: {
            mspId: identity.mspId,
            credentials: identity.credentials,
          },
          signer: this.adaptSigner(signer),
        });

        log().info('GatewayConnection.connect() - Conexión exitosa');
      },
      catch: (e) => {
        if (e instanceof Error && e.message.includes('timeout')) {
          log().error('GatewayConnection.connect() - Timeout error:', e.message);
          return new TimeoutError({
            message: `Failed to connect to gateway peer: ${gatewayPeer}`,
            operation: 'connect',
            timeout: connectTimeout,
          });
        }
        log().error('GatewayConnection.connect() - Configuration error:', e instanceof Error ? e.message : String(e));
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

  async getCommitStatus(
    channelName: string,
    transactionId: string,
  ): Promise<Result<CommitStatus, CommitError | NotConnectedError | TimeoutError | ConfigurationError>> {
    if (!this.client) {
      return Result.err(new NotConnectedError({
        component: 'GatewayConnection',
        action: 'get commit status',
      }));
    }

    const commitTimeout = this.config.timeouts?.commit ?? 60000;
    const serializedIdentity = new SerializedIdentity();
    serializedIdentity.setMspid(this.config.identity.mspId);
    serializedIdentity.setIdBytes(this.config.identity.credentials);

    const request = new gatewayProto.CommitStatusRequest();
    request.setChannelId(channelName);
    request.setTransactionId(transactionId);
    request.setIdentity(serializedIdentity.serializeBinary());

    const requestBytes = request.serializeBinary();
    const signature = await this.config.signer(createHash('sha256').update(requestBytes).digest());

    const signedRequest = new gatewayProto.SignedCommitStatusRequest();
    signedRequest.setRequest(requestBytes);
    signedRequest.setSignature(signature);

    return Result.tryPromise({
      try: async () => {
        const response = await new Promise<gatewayProto.CommitStatusResponse>((resolve, reject) => {
          this.client!.makeUnaryRequest(
            '/gateway.Gateway/CommitStatus',
            (value: gatewayProto.SignedCommitStatusRequest) => Buffer.from(value.serializeBinary()),
            (bytes: Buffer) => gatewayProto.CommitStatusResponse.deserializeBinary(new Uint8Array(bytes)),
            signedRequest,
            {
              deadline: Date.now() + commitTimeout,
            },
            (error, value) => {
              if (error) {
                reject(error);
                return;
              }

              if (!value) {
                reject(new Error('Empty commit status response'));
                return;
              }

              resolve(value);
            },
          );
        });

        const status: CommitStatus = {
          blockNumber: BigInt(response.getBlockNumber()),
          status: response.getResult() === 0 ? 'VALID' : 'INVALID',
          transactionId,
        };

        if (status.status !== 'VALID') {
          throw new CommitError({
            message: 'transaction committed with invalid validation code',
            transactionId,
            status: status.status,
          });
        }

        return status;
      },
      catch: (error) => {
        if (error instanceof CommitError) {
          return error;
        }

        if (error instanceof Error && error.message.toLowerCase().includes('deadline')) {
          return new TimeoutError({
            message: `Failed to get commit status for transaction ${transactionId}`,
            operation: 'commit',
            timeout: commitTimeout,
          });
        }

        return new CommitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId,
        });
      },
    });
  }

  async disconnect(): Promise<void> {
    this.gateway?.close();
    this.client?.close();
    this.gateway = null;
    this.client = null;
    await new Promise(resolve => setImmediate(resolve));
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
