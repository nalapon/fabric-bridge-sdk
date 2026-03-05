export interface DiscoveryResult {
  timestamp: number;
  channelName: string;
  peers: Map<string, PeerInfo>;
  orderers: OrdererInfo[];
  msps: Map<string, MSPInfo>;
}

export interface PeerInfo {
  name: string;
  endpoint: string;
  mspId: string;
  chaincodes: string[];
  ledgerHeight: bigint;
}

export interface OrdererInfo {
  endpoint: string;
  mspId: string;
}

export interface MSPInfo {
  id: string;
  tlsRootCerts: Buffer[];
}

export type DiscoveryCacheEntry = {
  result: DiscoveryResult;
  expiresAt: number;
};
