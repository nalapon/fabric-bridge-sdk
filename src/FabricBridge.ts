import { GatewayConnection } from "./gateway/GatewayConnection";
import { GatewayNetwork } from "./gateway/GatewayContract";
import { PeerConnection } from "./peer/PeerConnection";
import { PeerNetwork } from "./peer/PeerContract";
import { DiscoveryCache } from "./cache/DiscoveryCache";
import type { BridgeConfig, TimeoutConfig } from "./types/config";
import { DEFAULT_TIMEOUTS } from "./types/config";
import type {
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
} from "./types/bridge";
import { ConfigurationError, TimeoutError, NotConnectedError } from "./errors/index";
import { Result } from "better-result";

function applyDefaultTimeouts(config: BridgeConfig): BridgeConfig {
  if (!config.timeouts) {
    return { ...config, timeouts: { ...DEFAULT_TIMEOUTS } };
  }
  
  return {
    ...config,
    timeouts: {
      ...DEFAULT_TIMEOUTS,
      ...config.timeouts,
    },
  };
}

export class FabricBridge {
  private config: BridgeConfig;
  private gatewayConnection: GatewayConnection | null = null;
  private peerConnection: PeerConnection | null = null;
  private discoveryCache: DiscoveryCache;
  private isConnected = false;

  constructor(config: BridgeConfig) {
    this.config = applyDefaultTimeouts(config);
    this.discoveryCache = new DiscoveryCache();
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    this.gatewayConnection = new GatewayConnection(this.config);
    this.peerConnection = new PeerConnection(this.config, this.discoveryCache);

    const gatewayResult = await this.gatewayConnection.connect();
    if (!gatewayResult.isOk()) {
      return Result.err(gatewayResult.error);
    }

    this.isConnected = true;
    return Result.ok(undefined);
  }

  async switchToPeerMode(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    this.gatewayConnection?.disconnect();

    const peerResult = await this.peerConnection!.connect();
    if (!peerResult.isOk()) {
      await this.gatewayConnection!.connect();
      return Result.err(peerResult.error);
    }

    return Result.ok(undefined);
  }

  async restoreGatewayMode(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    this.peerConnection?.disconnect();

    const gatewayResult = await this.gatewayConnection!.connect();
    if (!gatewayResult.isOk()) {
      return Result.err(gatewayResult.error);
    }

    return Result.ok(undefined);
  }

  disconnect(): void {
    this.gatewayConnection?.disconnect();
    this.peerConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }

  async getNetwork(channelName: string): Promise<Result<BridgeNetwork, NotConnectedError>> {
    if (!this.isConnected || !this.config || !this.gatewayConnection || !this.peerConnection) {
      return Result.err(new NotConnectedError({
        component: 'FabricBridge',
        action: 'connect',
      }));
    }

    return Result.ok(new BridgeNetworkImpl(
      channelName,
      this.config,
      this.gatewayConnection,
      this.peerConnection,
      this.discoveryCache,
      this,
    ));
  }
}

class BridgeNetworkImpl implements BridgeNetwork {
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private fabricBridge: FabricBridge;

  constructor(
    channelName: string,
    config: BridgeConfig,
    gatewayConnection: GatewayConnection,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    fabricBridge: FabricBridge,
  ) {
    this.channelName = channelName;
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.fabricBridge = fabricBridge;
    this.gatewayNetwork = new GatewayNetwork(
      gatewayConnection.getGateway(),
      channelName,
      config,
    );
  }

  async getContract(chaincodeName: string, contractName?: string): Promise<BridgeContract> {
    return new BridgeContractImpl(
      chaincodeName,
      contractName ?? "",
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.peerConnection,
      this.discoveryCache,
      this.fabricBridge,
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
  private fabricBridge: FabricBridge;

  constructor(
    chaincodeName: string,
    contractName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    fabricBridge: FabricBridge,
  ) {
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.fabricBridge = fabricBridge;
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
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    return gatewayContract.submitTransaction(name, ...args);
  }

  async evaluateTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    return gatewayContract.evaluateTransaction(name, ...args);
  }

  createTransaction(name: string): BridgeTransaction {
    return new BridgeTransactionImpl(
      name,
      this.chaincodeName,
      this.contractName,
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.peerConnection,
      this.discoveryCache,
      this.fabricBridge,
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
  private fabricBridge: FabricBridge;
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
    fabricBridge: FabricBridge,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.fabricBridge = fabricBridge;
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
    if (this.usePeerMode) {
      if (!this.config.identity.privateKey) {
        return Result.err(new ConfigurationError({
          message: 'identity.privateKey is required for setEndorsingPeers()',
          field: 'identity.privateKey',
        }));
      }

      const switchResult = await this.fabricBridge.switchToPeerMode();
      if (!switchResult.isOk()) {
        return Result.err(switchResult.error);
      }

      try {
        const peerNetwork = new PeerNetwork(
          this.peerConnection.getGateway(),
          this.channelName,
          this.config,
          this.peerConnection,
          this.discoveryCache,
        );

        const peerContract = await peerNetwork.getContract(
          this.chaincodeName,
          this.contractName,
        );

        const tx = peerContract.createTransaction(this.name);

        if (Object.keys(this.transientData).length > 0) {
          tx.setTransientData(this.transientData);
        }

        tx.setEndorsingPeers(this.endorsingPeerNames);

        return tx.submit(...args);
      } finally {
        await this.fabricBridge.restoreGatewayMode();
      }
    } else {
      const gatewayContract = await this.gatewayNetwork.getContract(
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
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
      this.contractName,
    );
    const tx = gatewayContract.createTransaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      tx.setTransientData(this.transientData);
    }

    return tx.evaluate(...args);
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
