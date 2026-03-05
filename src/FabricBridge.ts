import { promises as fs } from "fs";
import { GatewayConnection } from "./gateway/GatewayConnection";
import { GatewayNetwork } from "./gateway/GatewayContract";
import { PeerConnection } from "./peer/PeerConnection";
import { PeerNetwork } from "./peer/PeerContract";
import { DiscoveryCache } from "./cache/DiscoveryCache";
import type { BridgeConfig, FileOrBuffer, ResolvedBridgeConfig, TimeoutConfig } from "./types/config";
import { DEFAULT_TIMEOUTS } from "./types/config";
import type {
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
} from "./types/bridge";
import { ConfigurationError, TimeoutError, FileResolveError, NotConnectedError } from "./errors/index";
import { Result } from "better-result";

function isFilePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function isPEMContent(value: string): boolean {
  return value.includes("-----BEGIN");
}

async function resolveFileOrBuffer(value: FileOrBuffer): Promise<Buffer> {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  
  if (typeof value === "string") {
    if (isPEMContent(value)) {
      return Buffer.from(value);
    }
    if (isFilePath(value)) {
      return fs.readFile(value);
    }
  }
  
  if (typeof value === "object" && "path" in value) {
    return fs.readFile(value.path);
  }
  
  throw new Error(`Unable to resolve FileOrBuffer: ${typeof value}`);
}

function resolveFileOrBufferResultAsync(value: FileOrBuffer): Promise<Result<Buffer, FileResolveError>> {
  return Result.tryPromise({
    try: () => resolveFileOrBuffer(value),
    catch: (e) => new FileResolveError({
      path: typeof value === 'string' ? value : 'unknown',
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error ? e : undefined,
    }),
  });
}

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
  private resolvedConfig: ResolvedBridgeConfig | null = null;
  private gatewayConnection: GatewayConnection | null = null;
  private peerConnection: PeerConnection | null = null;
  private discoveryCache: DiscoveryCache;
  private isConnected = false;
  private peerConnectionWarning: string | null = null;

  constructor(config: BridgeConfig) {
    this.config = applyDefaultTimeouts(config);
    this.discoveryCache = new DiscoveryCache();
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError | FileResolveError>> {
    const resolvedResult = await this.resolveConfigResult(this.config);
    
    if (!resolvedResult.isOk()) {
      return Result.err(resolvedResult.error);
    }
    
    const resolved = resolvedResult.value;
    this.resolvedConfig = resolved;

    this.gatewayConnection = new GatewayConnection(resolved);
    this.peerConnection = new PeerConnection(resolved, this.discoveryCache);

    const gatewayResult = await this.gatewayConnection.connect();
    if (!gatewayResult.isOk()) {
      return Result.err(gatewayResult.error);
    }

    if (resolved.discovery !== false) {
      const peerResult = await this.peerConnection.connect();
      if (!peerResult.isOk()) {
        this.peerConnectionWarning = `Peer connection failed, falling back to gateway mode only: ${peerResult.error.message}`;
      }
    }

    this.isConnected = true;
    return Result.ok(undefined);
  }

  private async resolveConfigResult(
    config: BridgeConfig,
  ): Promise<Result<ResolvedBridgeConfig, FileResolveError>> {
    const [credentialsResult, privateKeyResult, trustedRootsResult] = await Promise.all([
      resolveFileOrBufferResultAsync(config.identity.credentials),
      config.identity.privateKey
        ? resolveFileOrBufferResultAsync(config.identity.privateKey)
        : Promise.resolve(Result.ok<Buffer | undefined, FileResolveError>(undefined)),
      config.tlsOptions?.trustedRoots
        ? resolveFileOrBufferResultAsync(config.tlsOptions.trustedRoots)
        : Promise.resolve(Result.ok<Buffer | undefined, FileResolveError>(undefined)),
    ]);

    if (!credentialsResult.isOk()) return Result.err(credentialsResult.error);
    if (!privateKeyResult.isOk()) return Result.err(privateKeyResult.error);
    if (!trustedRootsResult.isOk()) return Result.err(trustedRootsResult.error);

    return Result.ok({
      ...config,
      identity: {
        ...config.identity,
        credentials: credentialsResult.value,
        privateKey: privateKeyResult.value,
      },
      tlsOptions: config.tlsOptions
        ? {
            ...config.tlsOptions,
            trustedRoots: trustedRootsResult.value,
          }
        : undefined,
    });
  }

  disconnect(): void {
    this.gatewayConnection?.disconnect();
    this.peerConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
    this.peerConnectionWarning = null;
  }

  async getNetwork(channelName: string): Promise<Result<BridgeNetwork, NotConnectedError>> {
    if (!this.isConnected || !this.resolvedConfig || !this.gatewayConnection || !this.peerConnection) {
      return Result.err(new NotConnectedError({
        component: 'FabricBridge',
        action: 'connect',
      }));
    }

    return Result.ok(new BridgeNetworkImpl(
      channelName,
      this.resolvedConfig,
      this.gatewayConnection,
      this.peerConnection,
      this.discoveryCache,
    ));
  }

  getConnectionWarning(): string | null {
    return this.peerConnectionWarning;
  }
}

class BridgeNetworkImpl implements BridgeNetwork {
  private channelName: string;
  private config: ResolvedBridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;

  constructor(
    channelName: string,
    config: ResolvedBridgeConfig,
    gatewayConnection: GatewayConnection,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.channelName = channelName;
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.gatewayNetwork = new GatewayNetwork(
      gatewayConnection.getGateway(),
      channelName,
      config,
    );
  }

  getContract(chaincodeName: string, contractName?: string): BridgeContract {
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
  private config: ResolvedBridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;

  constructor(
    chaincodeName: string,
    contractName: string,
    channelName: string,
    config: ResolvedBridgeConfig,
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
    );
  }
}

class BridgeTransactionImpl implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private contractName: string;
  private channelName: string;
  private config: ResolvedBridgeConfig;
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
    config: ResolvedBridgeConfig,
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
      return this.submitWithPeers(args);
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
      console.warn(
        "Peer mode submission failed, falling back to gateway mode:",
        error,
      );
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
