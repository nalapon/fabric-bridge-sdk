import { GatewayConnection } from "./gateway/GatewayConnection";
import { GatewayNetwork, NewGatewaySignedProposal } from "./gateway/GatewayContract";
import { PeerConnection } from "./peer/PeerConnection";
import { NewPeerSignedProposal, PeerNetwork } from "./peer/PeerContract";
import { DiscoveryCache } from "./cache/DiscoveryCache";
import type { BridgeConfig, TimeoutConfig } from "./types/config";
import { DEFAULT_TIMEOUTS } from "./types/config";
import type {
  BridgeCommitResult,
  BridgeSignedProposal,
  BridgeNetwork,
  BridgeContract,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
  BridgeUnsignedProposal,
  CommitStatus,
  SignedMessage,
  SinglePeerOptions,
  ProposalCreator,
} from "./types/bridge";
import { ConfigurationError, EvaluationError, NotConnectedError, SubmitError, TimeoutError } from "./errors/index";
import { Result } from "better-result";
import { log } from "./utils/logger";
import { TransactionTargeting } from "./transactionTargeting";

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
      discovery: config.discovery,
    });
  }

  async connect(): Promise<Result<void, ConfigurationError | TimeoutError>> {
    log().info('FabricBridge.connect() - Iniciando conexión en modo GATEWAY');
    
    this.gatewayConnection = new GatewayConnection(this.config);

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

  async disconnect(): Promise<void> {
    log().info('FabricBridge.disconnect() - Desconectando');
    await this.gatewayConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }

  async WaitForCommit(
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
    if (!this.isConnected || !this.config || !this.gatewayConnection) {
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
      this.discoveryCache,
    ));
  }

  async NewSignedProposal(message: SignedMessage): Promise<BridgeResult<BridgeSignedProposal>> {
    if (message.routing?.mode === 'single-peer' || message.routing?.mode === 'endorsing-peers') {
      const peerConnection = new PeerConnection(this.config, this.discoveryCache);
      const connectResult = await peerConnection.connect();
      if (!connectResult.isOk()) {
        return Result.err(connectResult.error);
      }
      return NewPeerSignedProposal(peerConnection.getGateway(), this.config, message);
    }

    if (!this.gatewayConnection) {
      return Result.err(new NotConnectedError({
        component: 'FabricBridge',
        action: 'resume signed proposal',
      }));
    }

    return NewGatewaySignedProposal(
      this.gatewayConnection.getGateway(),
      message,
      { ...DEFAULT_TIMEOUTS, ...this.config.timeouts },
    );
  }
}

class BridgeNetworkImpl implements BridgeNetwork {
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private discoveryCache: DiscoveryCache;

  constructor(
    channelName: string,
    config: BridgeConfig,
    gatewayConnection: GatewayConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.channelName = channelName;
    this.config = config;
    this.discoveryCache = discoveryCache;
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
      this.discoveryCache,
    );
  }
}

class BridgeContractImpl implements BridgeContract {
  private chaincodeName: string;
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private discoveryCache: DiscoveryCache;

  constructor(
    chaincodeName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    discoveryCache: DiscoveryCache,
  ) {
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.discoveryCache = discoveryCache;
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
      this.discoveryCache,
    );
  }
}

class BridgeTransactionImpl implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private channelName: string;
  private config: BridgeConfig;
  private gatewayNetwork: GatewayNetwork;
  private discoveryCache: DiscoveryCache;
  private targeting = TransactionTargeting.gatewayDefault();
  private transientData: Record<string, Buffer> = {};
  private proposalCreator?: ProposalCreator;

  constructor(
    name: string,
    chaincodeName: string,
    channelName: string,
    config: BridgeConfig,
    gatewayNetwork: GatewayNetwork,
    discoveryCache: DiscoveryCache,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.discoveryCache = discoveryCache;
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  UseSinglePeer(options: SinglePeerOptions = {}): BridgeResult<BridgeTransaction> {
    const targeting = TransactionTargeting.singlePeer(options);
    if (!targeting.isOk()) {
      return Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result.ok(this);
  }

  UseEndorsingPeers(peerNames: string[]): BridgeResult<BridgeTransaction> {
    const targeting = TransactionTargeting.endorsingPeers(peerNames);
    if (!targeting.isOk()) {
      return Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result.ok(this);
  }

  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = copyTransientData(transientData);
    return this;
  }

  SetProposalCreator(proposalCreator: ProposalCreator): BridgeTransaction {
    this.proposalCreator = copyProposalCreator(proposalCreator);
    return this;
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

  async SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    if (this.targeting.requiresPeerMode()) {
      let connection: PeerConnection | undefined;
      try {
        const prepared = await this.createPeerTargetedTransaction('peer-targeted transactions');
        connection = prepared.connection;
        const peerConnection = prepared.connection;
        const transaction = prepared.transaction;
        const submittedResult = await transaction.SubmitAsync(...args);
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
        await connection?.disconnect();
        if (error instanceof ConfigurationError || error instanceof TimeoutError) {
          return Result.err(error);
        }
        return Result.err(new SubmitError({
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    return (await this.createGatewayTransaction()).SubmitAsync(...args);
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    if (this.targeting.requiresPeerMode()) {
      let connection: PeerConnection | undefined;
      try {
        const prepared = await this.createPeerTargetedTransaction('peer-targeted transactions');
        connection = prepared.connection;
        return await prepared.transaction.Evaluate(...args);
      } finally {
        await connection?.disconnect();
      }
    }

    return (await this.createGatewayTransaction()).Evaluate(...args);
  }

  async NewUnsignedProposal(...args: unknown[]): Promise<BridgeResult<BridgeUnsignedProposal>> {
    if (!this.proposalCreator) {
      return Result.err(new ConfigurationError({
        field: 'proposalCreator',
        message: 'proposalCreator is required to build an unsigned proposal for offline signing',
      }));
    }

    if (this.targeting.requiresPeerMode()) {
      let connection: PeerConnection | undefined;
      try {
        const prepared = await this.createPeerTargetedTransaction('build peer-targeted proposals');
        connection = prepared.connection;
        return await prepared.transaction.NewUnsignedProposal(...args);
      } finally {
        await connection?.disconnect();
      }
    }

    return (await this.createGatewayTransaction()).NewUnsignedProposal(...args);
  }

  private async createGatewayTransaction(): Promise<BridgeTransaction> {
    const gatewayContract = await this.gatewayNetwork.getContract(this.chaincodeName);
    return this.prepareTransaction(gatewayContract.Transaction(this.name));
  }

  private async createPeerTargetedTransaction(reason: string): Promise<{
    connection: PeerConnection;
    transaction: BridgeTransaction;
  }> {
    const connection = new PeerConnection(this.config, this.discoveryCache);
    const connectResult = await connection.connect();
    if (!connectResult.isOk()) {
      throw connectResult.error;
    }

    try {
      log().debug('BridgeTransactionImpl - using dedicated peer connection for:', this.chaincodeName);
      const peerNetwork = new PeerNetwork(
        connection.getGateway(),
        this.channelName,
        this.config,
        connection,
        this.discoveryCache,
      );
      const peerContract = await peerNetwork.getContract(this.chaincodeName);
      const targetedTx = this.targeting.applyToPeerTransaction(
        this.prepareTransaction(peerContract.Transaction(this.name)),
      );
      if (!targetedTx.isOk()) {
        throw targetedTx.error;
      }
      return { connection, transaction: targetedTx.value };
    } catch (error) {
      await connection.disconnect();
      throw error;
    }
  }

  private prepareTransaction(transaction: BridgeTransaction): BridgeTransaction {
    if (Object.keys(this.transientData).length > 0) {
      transaction.SetTransientData(this.transientData);
    }
    if (this.proposalCreator) {
      transaction.SetProposalCreator(this.proposalCreator);
    }
    return transaction;
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
  TransactionID(): string {
    return this.submitted.TransactionID();
  }
  CommitStatus(): CommitStatus {
    return this.commitStatus;
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
  TransactionID(): string {
    return this.transactionId;
  }
  async WaitForCommit(): Promise<BridgeResult<CommitStatus>> {
    return this.waitForCommitFn();
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
  ProposalCreator,
} from "./types/bridge";
export * from "./errors/index";

function copyTransientData(input: Record<string, Buffer>): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]),
  );
}

function copyProposalCreator(input: ProposalCreator): ProposalCreator {
  return {
    mspId: input.mspId,
    credentials: Buffer.from(input.credentials),
  };
}
