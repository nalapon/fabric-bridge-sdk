/**
 * TLS configuration options.
 * 
 * - If only `trustedRoots` is provided: TLS is used (server verification only)
 * - If `trustedRoots`, `clientCert`, and `clientKey` are provided: mTLS is used (mutual authentication)
 * - If no TLS options are provided: insecure connection (no TLS)
 */
export interface TlsOptions {
  /** CA certificate to verify the server's TLS certificate. Required for TLS. */
  trustedRoots?: Buffer;
  
  /** Whether to verify the server's certificate. Defaults to true. */
  verify?: boolean;
  
  /** Client TLS certificate for mTLS. Only needed if server requires client authentication. */
  clientCert?: Buffer;
  
  /** Client TLS private key for mTLS. Only needed if server requires client authentication. */
  clientKey?: Buffer;

  /**
   * Overrides the hostname used for TLS certificate verification.
   * Use when the peer's endpoint is localhost or differs from the certificate's CN/SAN.
   * Example: "peer0.org1.example.com"
   */
  sslTargetNameOverride?: string;
}

export interface BridgeConfig {
  gatewayPeer: string;
  
  identity: {
    mspId: string;
    credentials: Buffer;
    privateKey?: Buffer;
  };
  
  signer: Signer;
  
  tlsOptions?: TlsOptions;
  
  discovery?: boolean;
  
  timeouts?: TimeoutConfig;
}

export interface TimeoutConfig {
  endorse?: number;
  submit?: number;
  commit?: number;
  evaluate?: number;
  discovery?: number;
}

export type Signer = (digest: Uint8Array) => Promise<Uint8Array>;

export const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  endorse: 30000,
  submit: 30000,
  commit: 60000,
  evaluate: 30000,
  discovery: 5000,
};