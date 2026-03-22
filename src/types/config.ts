export interface BridgeConfig {
  gatewayPeer: string;
  
  identity: {
    mspId: string;
    credentials: Buffer;
    privateKey?: Buffer;
  };
  
  signer: Signer;
  
  tlsOptions?: {
    trustedRoots?: Buffer;
    verify?: boolean;
    clientCert?: Buffer;
    clientKey?: Buffer;
  };
  
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
