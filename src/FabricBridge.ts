import { GatewayConnection } from "./gateway/GatewayConnection";
import { GatewayNetwork } from "./gateway/GatewayContract";
import { PeerConnection } from "./peer/PeerConnection";
import { PeerNetwork } from "./peer/PeerContract";
import { DiscoveryCache } from "./cache/DiscoveryCache";
import type { BridgeConfig } from "./types/config";
import type {
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
} from "./types/bridge";
import { ConfigurationError, TimeoutError } from "./errors/index";
import { Result } from "better-result";

export class FabricBridge {
  private config: BridgeConfig;
  private gatewayConnection: GatewayConnection;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private isConnected = false;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.discoveryCache = new DiscoveryCache();
    this.gatewayConnection = new GatewayConnection(config);
    this.peerConnection = new PeerConnection(config, this.discoveryCache);
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    // Connect to fabric-gateway (always needed)
    const gatewayResult = await this.gatewayConnection.connect();
    if (!gatewayResult.isOk()) {
      return Result.err(gatewayResult.error);
    }

    // Connect to fabric-network (if discovery is enabled)
    if (this.config.discovery !== false) {
      const peerResult = await this.peerConnection.connect();
      if (!peerResult.isOk()) {
        // Log warning but don't fail - we can still use gateway mode
        console.warn(
          "Peer connection failed, falling back to gateway mode only:",
          peerResult.error,
        );
      }
    }

    this.isConnected = true;
    return Result.ok(undefined);
  }

  disconnect(): void {
    this.gatewayConnection.disconnect();
    this.peerConnection.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }

  getNetwork(channelName: string): BridgeNetwork {
    if (!this.isConnected) {
      throw new Error("FabricBridge not connected. Call connect() first.");
    }

    return new BridgeNetworkImpl(
      channelName,
      this.config,
      this.gatewayConnection,
      this.peerConnection,
      this.discoveryCache,
    );
  }
}

class BridgeNetworkImpl implements BridgeNetwork {
  private channelName: string;
  private config: BridgeConfig;
  private gatewayConnection: GatewayConnection;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private gatewayNetwork: GatewayNetwork;

  constructor(
    channelName: string,
    config: BridgeConfig,
    gatewayConnection: GatewayConnection,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.channelName = channelName;
    this.config = config;
    this.gatewayConnection = gatewayConnection;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;

    // Create gateway network instance (default mode)
    this.gatewayNetwork = new GatewayNetwork(
      gatewayConnection.getGateway(),
      channelName,
      config,
    );
  }

  getContract(chaincodeName: string, contractName?: string): BridgeContract {
    // Return a BridgeContract that can switch modes
    return new BridgeContractImpl(
      chaincodeName,
      contractName ?? "",
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.peerConnection,
      this.discoveryCache,
    );
  }
}

class BridgeContractImpl implements BridgeContract {
  private chaincodeName: string;
  private contractName: string;
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;

  constructor(
    chaincodeName: string,
    contractName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  getContractName(): string {
    return this.contractName;
  }

  async submitTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    // Default mode: use gateway
    const gatewayContract = this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    return gatewayContract.submitTransaction(name, ...args);
  }

  async evaluateTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    // Default mode: use gateway
    const gatewayContract = this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    return gatewayContract.evaluateTransaction(name, ...args);
  }

  createTransaction(name: string): BridgeTransaction {
    // Create a BridgeTransaction that can switch modes when setEndorsingPeers is called
    return new BridgeTransactionImpl(
      name,
      this.chaincodeName,
      this.contractName,
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.peerConnection,
      this.discoveryCache,
    );
  }
}

class BridgeTransactionImpl implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private contractName: string;
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private endorsingPeerNames: string[] = [];
  private transientData: Record<string, Buffer> = {};
  private usePeerMode = false;

  constructor(
    name: string,
    chaincodeName: string,
    contractName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  getContractName(): string {
    return this.contractName;
  }

  setEndorsingPeers(peerNames: string[]): BridgeTransaction {
    this.endorsingPeerNames = peerNames;
    this.usePeerMode = true;
    return this;
  }

  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = transientData;
    return this;
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    if (this.usePeerMode && this.config.discovery !== false) {
      // Use fabric-network peer mode
      return this.submitWithPeers(args);
    } else {
      // Use fabric-gateway mode
      const gatewayContract = this.gatewayNetwork.getContract(
        this.chaincodeName,
        this.contractName,
      );
      const tx = gatewayContract.createTransaction(this.name);

      if (Object.keys(this.transientData).length > 0) {
        tx.setTransientData(this.transientData);
      }

      return tx.submit(...args);
    }
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    // Evaluation always uses gateway mode for simplicity
    // (peer targeting doesn't make much sense for queries)
    const gatewayContract = this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    const tx = gatewayContract.createTransaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      tx.setTransientData(this.transientData);
    }

    return tx.evaluate(...args);
  }

  private async submitWithPeers(
    args: unknown[],
  ): Promise<BridgeResult<BridgeSubmittedTx>> {
    try {
      // Get or create peer network
      const peerNetwork = new PeerNetwork(
        this.peerConnection.getGateway(),
        this.channelName,
        this.config,
        this.peerConnection,
        this.discoveryCache,
      );

      // Get contract from peer network
      const peerContract = await peerNetwork.getContract(
        this.chaincodeName,
        this.contractName,
      );

      // Create transaction and set endorsing peers
      const tx = peerContract.createTransaction(this.name);

      if (Object.keys(this.transientData).length > 0) {
        tx.setTransientData(this.transientData);
      }

      tx.setEndorsingPeers(this.endorsingPeerNames);

      // Submit via peer mode
      return tx.submit(...args);
    } catch (error) {
      // Fall back to gateway mode if peer mode fails
      console.warn(
        "Peer mode submission failed, falling back to gateway mode:",
        error,
      );
      const gatewayContract = this.gatewayNetwork.getContract(
        this.chaincodeName,
        this.contractName,
      );
      const tx = gatewayContract.createTransaction(this.name);

      if (Object.keys(this.transientData).length > 0) {
        tx.setTransientData(this.transientData);
      }

      return tx.submit(...args);
    }
  }
}

// Re-export types
export type { BridgeConfig, TimeoutConfig } from "./types/config";
export type {
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
} from "./types/bridge";
export * from "./errors/index";
