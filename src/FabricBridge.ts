import { GatewayConnection } from "./gateway/GatewayConnection";
import { GatewayNetwork } from "./gateway/GatewayContract";
import { PeerConnection } from "./peer/PeerConnection";
import { PeerNetwork } from "./peer/PeerContract";
import { DiscoveryCache } from "./cache/DiscoveryCache";
import type { BridgeConfig, TimeoutConfig } from "./types/config";
import { DEFAULT_TIMEOUTS } from "./types/config";
import type {
  BridgeCommitResult,
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
  CommitStatus,
} from "./types/bridge";
import { ConfigurationError, EvaluationError, NotConnectedError, SubmitError, TimeoutError } from "./errors/index";
import { Result } from "better-result";
import { log } from "./utils/logger";

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
    
    log().debug('FabricBridge creado', {
      gatewayPeer: config.gatewayPeer,
      mspId: config.identity.mspId,
      hasTlsOptions: !!config.tlsOptions,
      hasTrustedRoots: !!config.tlsOptions?.trustedRoots,
      hasClientCert: !!config.tlsOptions?.clientCert,
      hasClientKey: !!config.tlsOptions?.clientKey,
      hasPrivateKey: !!config.identity.privateKey,
      discovery: config.discovery,
    });
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    log().info('FabricBridge.connect() - Iniciando conexión en modo GATEWAY');
    
    this.gatewayConnection = new GatewayConnection(this.config);
    this.peerConnection = new PeerConnection(this.config, this.discoveryCache);

    log().debug('FabricBridge.connect() - Llamando a GatewayConnection.connect()');
    const gatewayResult = await this.gatewayConnection.connect();
    
    if (!gatewayResult.isOk()) {
      log().error('FabricBridge.connect() - Error en GatewayConnection.connect():', gatewayResult.error);
      return Result.err(gatewayResult.error);
    }

    this.isConnected = true;
    log().info('FabricBridge.connect() - Conexión GATEWAY exitosa');
    return Result.ok(undefined);
  }

  async switchToPeerMode(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    log().info('FabricBridge.switchToPeerMode() - Cambiando a modo PEER');
    
    await this.gatewayConnection?.disconnect();
    log().debug('FabricBridge.switchToPeerMode() - GatewayConnection desconectado');

    log().debug('FabricBridge.switchToPeerMode() - Llamando a PeerConnection.connect()');
    const peerResult = await this.peerConnection!.connect();
    
    if (!peerResult.isOk()) {
      log().error('FabricBridge.switchToPeerMode() - Error en PeerConnection.connect():', peerResult.error);
      log().debug('FabricBridge.switchToPeerMode() - Intentando restaurar conexión GATEWAY');
      await this.gatewayConnection!.connect();
      return Result.err(peerResult.error);
    }

    log().info('FabricBridge.switchToPeerMode() - Conexión PEER exitosa');
    return Result.ok(undefined);
  }

  async restoreGatewayMode(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    log().info('FabricBridge.restoreGatewayMode() - Restaurando modo GATEWAY');
    
    await this.peerConnection?.disconnect();
    log().debug('FabricBridge.restoreGatewayMode() - PeerConnection desconectado');

    log().debug('FabricBridge.restoreGatewayMode() - Llamando a GatewayConnection.connect()');
    const gatewayResult = await this.gatewayConnection!.connect();
    
    if (!gatewayResult.isOk()) {
      log().error('FabricBridge.restoreGatewayMode() - Error:', gatewayResult.error);
      return Result.err(gatewayResult.error);
    }

    log().info('FabricBridge.restoreGatewayMode() - Modo GATEWAY restaurado exitosamente');
    return Result.ok(undefined);
  }

  async disconnect(): Promise<void> {
    log().info('FabricBridge.disconnect() - Desconectando');
    await this.gatewayConnection?.disconnect();
    await this.peerConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }

  async waitForCommit(
    channelName: string,
    transactionId: string,
  ): Promise<BridgeResult<CommitStatus>> {
    if (!this.gatewayConnection) {
      return Result.err(new NotConnectedError({
        component: 'FabricBridge',
        action: 'wait for commit',
      }));
    }

    return this.gatewayConnection.getCommitStatus(channelName, transactionId);
  }

  async getNetwork(channelName: string): Promise<Result<BridgeNetwork, NotConnectedError>> {
    if (!this.isConnected || !this.config || !this.gatewayConnection || !this.peerConnection) {
      log().error('FabricBridge.getNetwork() - No conectado');
      return Result.err(new NotConnectedError({
        component: 'FabricBridge',
        action: 'connect',
      }));
    }

    log().debug('FabricBridge.getNetwork() - Creando BridgeNetwork para canal:', channelName);
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
      gatewayConnection,
      channelName,
      config,
    );
  }

  async getContract(chaincodeName: string): Promise<BridgeContract> {
    return new BridgeContractImpl(
      chaincodeName,
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
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private fabricBridge: FabricBridge;

  constructor(
    chaincodeName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    fabricBridge: FabricBridge,
  ) {
    this.chaincodeName = chaincodeName;
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

  async Submit(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeCommitResult>> {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
    );
    return gatewayContract.Submit(name, ...args);
  }

  async SubmitAsync(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeSubmittedTx>> {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
    );
    return gatewayContract.SubmitAsync(name, ...args);
  }

  async Evaluate(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
    );
    return gatewayContract.Evaluate(name, ...args);
  }

  Transaction(name: string): BridgeTransaction {
    return new BridgeTransactionImpl(
      name,
      this.chaincodeName,
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.peerConnection,
      this.discoveryCache,
      this.fabricBridge,
    );
  }

  async submitTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeCommitResult>> {
    return this.Submit(name, ...args);
  }

  async evaluateTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    return this.Evaluate(name, ...args);
  }

  createTransaction(name: string): BridgeTransaction {
    return this.Transaction(name);
  }
}

class BridgeTransactionImpl implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
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
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    fabricBridge: FabricBridge,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
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

  SetEndorsingPeers(peerNames: string[]): BridgeTransaction {
    this.endorsingPeerNames = peerNames;
    this.usePeerMode = true;
    return this;
  }

  setEndorsingPeers(peerNames: string[]): BridgeTransaction {
    return this.SetEndorsingPeers(peerNames);
  }

  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = copyTransientData(transientData);
    return this;
  }

  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    return this.SetTransientData(transientData);
  }

  async Submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    const submitted = await this.SubmitAsync(...args);
    if (!submitted.isOk()) {
      return Result.err(submitted.error);
    }

    const commitStatus = await submitted.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result.err(commitStatus.error);
    }

    return Result.ok(new BridgeCommitResultImpl(submitted.value, commitStatus.value));
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    return this.Submit(...args);
  }

  async SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    if (this.usePeerMode) {
      if (!this.config.identity.privateKey) {
        return Result.err(new ConfigurationError({
          message: 'identity.privateKey is required for SetEndorsingPeers()',
          field: 'identity.privateKey',
        }));
      }

      const peerConnection = new PeerConnection(this.config, this.discoveryCache);
      const connectResult = await peerConnection.connect();
      if (!connectResult.isOk()) {
        return Result.err(connectResult.error);
      }

      try {
        log().debug('BridgeTransactionImpl.SubmitAsync() - using dedicated peer connection for:', this.chaincodeName);

        const peerNetwork = new PeerNetwork(
          peerConnection.getGateway(),
          this.channelName,
          this.config,
          peerConnection,
          this.discoveryCache,
        );

        log().debug('BridgeTransactionImpl.SubmitAsync() - calling peerNetwork.getContract():', this.chaincodeName);
        const peerContract = await peerNetwork.getContract(
          this.chaincodeName,
        );

        const tx = peerContract.Transaction(this.name);

        if (Object.keys(this.transientData).length > 0) {
          tx.SetTransientData(this.transientData);
        }

        tx.SetEndorsingPeers(this.endorsingPeerNames);

        const submittedResult = await tx.SubmitAsync(...args);
        if (!submittedResult.isOk()) {
          await peerConnection.disconnect();
          return Result.err(submittedResult.error);
        }

        const commitPromise = submittedResult.value.WaitForCommit()
          .finally(async () => {
            await peerConnection.disconnect();
          });
        void commitPromise.catch(() => undefined);

        return Result.ok(new DeferredSubmittedTransaction(
          submittedResult.value.Result(),
          submittedResult.value.TransactionID(),
          () => commitPromise,
        ));
      } catch (error) {
        await peerConnection.disconnect();
        return Result.err(new SubmitError({
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
    );
    const tx = gatewayContract.Transaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      tx.SetTransientData(this.transientData);
    }

    return tx.SubmitAsync(...args);
  }

  async submitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    return this.SubmitAsync(...args);
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    if (this.usePeerMode) {
      if (!this.config.identity.privateKey) {
        return Result.err(new ConfigurationError({
          message: 'identity.privateKey is required for SetEndorsingPeers()',
          field: 'identity.privateKey',
        }));
      }

      const peerConnection = new PeerConnection(this.config, this.discoveryCache);
      const connectResult = await peerConnection.connect();
      if (!connectResult.isOk()) {
        return Result.err(connectResult.error);
      }

      try {
        const peerNetwork = new PeerNetwork(
          peerConnection.getGateway(),
          this.channelName,
          this.config,
          peerConnection,
          this.discoveryCache,
        );

        const peerContract = await peerNetwork.getContract(this.chaincodeName);
        const tx = peerContract.Transaction(this.name);

        if (Object.keys(this.transientData).length > 0) {
          tx.SetTransientData(this.transientData);
        }

        tx.SetEndorsingPeers(this.endorsingPeerNames);
        return await tx.Evaluate(...args);
      } finally {
        await peerConnection.disconnect();
      }
    }

    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName,
    );
    const tx = gatewayContract.Transaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      tx.SetTransientData(this.transientData);
    }

    return tx.Evaluate(...args);
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    return this.Evaluate(...args);
  }
}

class BridgeCommitResultImpl implements BridgeCommitResult {
  private submitted: BridgeSubmittedTx;
  private commitStatus: CommitStatus;

  constructor(submitted: BridgeSubmittedTx, commitStatus: CommitStatus) {
    this.submitted = submitted;
    this.commitStatus = commitStatus;
  }

  Result(): Buffer {
    return this.submitted.Result();
  }

  getResult(): Buffer {
    return this.Result();
  }

  TransactionID(): string {
    return this.submitted.TransactionID();
  }

  getTransactionId(): string {
    return this.TransactionID();
  }

  CommitStatus(): CommitStatus {
    return this.commitStatus;
  }

  getCommitStatus(): CommitStatus {
    return this.CommitStatus();
  }
}

class DeferredSubmittedTransaction implements BridgeSubmittedTx {
  private result: Buffer;
  private transactionId: string;
  private waitForCommitFn: () => Promise<BridgeResult<CommitStatus>>;

  constructor(
    result: Buffer,
    transactionId: string,
    waitForCommitFn: () => Promise<BridgeResult<CommitStatus>>,
  ) {
    this.result = result;
    this.transactionId = transactionId;
    this.waitForCommitFn = waitForCommitFn;
  }

  Result(): Buffer {
    return this.result;
  }

  getResult(): Buffer {
    return this.Result();
  }

  TransactionID(): string {
    return this.transactionId;
  }

  getTransactionId(): string {
    return this.TransactionID();
  }

  async WaitForCommit(): Promise<BridgeResult<CommitStatus>> {
    return this.waitForCommitFn();
  }

  async waitForCommit(): Promise<BridgeResult<CommitStatus>> {
    return this.WaitForCommit();
  }

  async getStatus(): Promise<BridgeResult<CommitStatus>> {
    return this.WaitForCommit();
  }
}

// Re-export types
export type { BridgeConfig, TimeoutConfig } from "./types/config";
export type {
  BridgeCommitResult,
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
  CommitStatus,
} from "./types/bridge";
export * from "./errors/index";

function copyTransientData(input: Record<string, Buffer>): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]),
  );
}
