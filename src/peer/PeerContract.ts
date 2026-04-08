import * as fabricNetwork from 'fabric-network';
import { Result } from 'better-result';
import { asBuffer, getTransactionResponse } from 'fabric-network/lib/impl/gatewayutils';
import type {
  BridgeCommitResult,
  BridgeContract,
  BridgeNetwork,
  BridgeResult,
  BridgeSubmittedTx,
  BridgeTransaction,
  CommitStatus,
} from '../types/bridge';
import type { BridgeConfig, TimeoutConfig } from '../types/config';
import type { DiscoveryResult } from '../types/discovery';
import {
  CommitError,
  DiscoveryError,
  EndorsementError,
  EvaluationError,
  PeerNotFoundError,
  SubmitError,
  TimeoutError,
} from '../errors/index';
import { DEFAULT_TIMEOUTS } from '../types/config';
import { PeerConnection } from './PeerConnection';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { log } from '../utils/logger';

export class PeerNetwork implements BridgeNetwork {
  private gateway: fabricNetwork.Gateway;
  private channelName: string;
  private timeouts: Required<TimeoutConfig>;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private networkPromise: Promise<fabricNetwork.Network> | null = null;

  constructor(
    gateway: fabricNetwork.Gateway,
    channelName: string,
    config: BridgeConfig,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
  ) {
    this.gateway = gateway;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.networkPromise = this.gateway.getNetwork(channelName);
  }

  async getContract(chaincodeName: string): Promise<BridgeContract> {
    const network = await this.networkPromise!;
    const contract = network.getContract(chaincodeName);

    return new PeerContract(
      contract as fabricNetwork.Contract,
      chaincodeName,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }
}

class PeerContract implements BridgeContract {
  private contract: fabricNetwork.Contract;
  private chaincodeName: string;
  private timeouts: Required<TimeoutConfig>;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private channelName: string;

  constructor(
    contract: fabricNetwork.Contract,
    chaincodeName: string,
    timeouts: Required<TimeoutConfig>,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  async Submit(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    const tx = this.Transaction(name);
    return tx.Submit(...args);
  }

  async SubmitAsync(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    const tx = this.Transaction(name);
    return tx.SubmitAsync(...args);
  }

  async Evaluate(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const tx = this.Transaction(name);
    return tx.Evaluate(...args);
  }

  Transaction(name: string): BridgeTransaction {
    log().debug('PeerContract.Transaction() - name:', name);
    return new PeerTransaction(
      name,
      this.chaincodeName,
      this.contract,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }

  async submitTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    return this.Submit(name, ...args);
  }

  async evaluateTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>> {
    return this.Evaluate(name, ...args);
  }

  createTransaction(name: string): BridgeTransaction {
    return this.Transaction(name);
  }
}

class PeerTransaction implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private contract: fabricNetwork.Contract;
  private timeouts: Required<TimeoutConfig>;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private channelName: string;
  private endorsingPeerNames: string[] = [];
  private transientData: Record<string, Buffer> = {};

  constructor(
    name: string,
    chaincodeName: string,
    contract: fabricNetwork.Contract,
    timeouts: Required<TimeoutConfig>,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contract = contract;
    this.timeouts = timeouts;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  SetEndorsingPeers(peerNames: string[]): BridgeTransaction {
    this.endorsingPeerNames = [...peerNames];
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
    const submittedResult = await this.SubmitAsync(...args);
    if (!submittedResult.isOk()) {
      return Result.err(submittedResult.error);
    }

    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result.err(commitStatus.error);
    }

    return Result.ok(new PeerCommitResult(submittedResult.value, commitStatus.value));
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    return this.Submit(...args);
  }

  async SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    log().debug('PeerTransaction.SubmitAsync() - transaction:', this.name, 'chaincode:', this.chaincodeName);

    const stringArgs = normalizeArgs(args);

    return Result.tryPromise({
      try: async () => {
        const transaction = await this.createPreparedTransaction();
        const submitted = await this.submitAsyncInternal(transaction, stringArgs);
        return new PeerSubmittedTx(
          submitted.result,
          submitted.transactionId,
          submitted.waitForCommit,
        );
      },
      catch: (error) => this.mapSubmitError(error as Error),
    });
  }

  async submitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    return this.SubmitAsync(...args);
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = normalizeArgs(args);

    try {
      const transaction = await this.createPreparedTransaction();
      const result = await transaction.evaluate(...stringArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(
        new EvaluationError({
          message: (error as Error).message,
        }),
      );
    }
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    return this.Evaluate(...args);
  }

  private async createPreparedTransaction(): Promise<fabricNetwork.Transaction> {
    const transaction = this.contract.createTransaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      transaction.setTransient(copyTransientData(this.transientData));
    }

    if (this.endorsingPeerNames.length > 0) {
      const discoveryResult = await this.ensureDiscovery();
      if (!discoveryResult.isOk()) {
        throw discoveryResult.error;
      }

      const endorsingPeers = this.matchPeersToEndorsers(
        discoveryResult.value,
        this.endorsingPeerNames,
      );
      if (!endorsingPeers.isOk()) {
        throw endorsingPeers.error;
      }

      if (endorsingPeers.value.length > 0) {
        transaction.setEndorsingPeers(endorsingPeers.value);
      }
    }

    return transaction;
  }

  private async submitAsyncInternal(transaction: fabricNetwork.Transaction, stringArgs: string[]): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    const tx = transaction as any;
    const network = tx.contract.network;
    const channel = network.getChannel();
    const transactionOptions = tx.gatewayOptions.eventHandlerOptions ?? {};
    const endorsement = channel.newEndorsement(this.chaincodeName);
    const proposalBuildRequest = tx.newBuildProposalRequest(stringArgs);

    endorsement.build(tx.identityContext, proposalBuildRequest);
    endorsement.sign(tx.identityContext);

    const proposalSendRequest: Record<string, unknown> = {};
    if (Number.isInteger(transactionOptions.endorseTimeout)) {
      proposalSendRequest.requestTimeout = (transactionOptions.endorseTimeout as number) * 1000;
    }

    if (tx.endorsingPeers) {
      proposalSendRequest.targets = tx.endorsingPeers;
    } else if (tx.contract.network.discoveryService) {
      proposalSendRequest.handler = await tx.contract.getDiscoveryHandler();
      if (tx.endorsingOrgs) {
        proposalSendRequest.requiredOrgs = tx.endorsingOrgs;
      }
    } else if (tx.endorsingOrgs) {
      const targets = tx.endorsingOrgs
        .map((mspid: string) => channel.getEndorsers(mspid))
        .flat();
      proposalSendRequest.targets = targets;
    } else {
      proposalSendRequest.targets = channel.getEndorsers();
    }

    const proposalResponse = await endorsement.send(proposalSendRequest);
    const result = this.getResponsePayload(proposalResponse);
    const transactionId = endorsement.getTransactionId();

    const peers = tx.endorsingPeers ?? channel.getEndorsers();
    const commitWaiter = await this.createCommitWaiter(network, peers, transactionId);

    try {
      const commit = endorsement.newCommit();
      commit.build(tx.identityContext);
      commit.sign(tx.identityContext);

      const commitSendRequest: Record<string, unknown> = {};
      if (Number.isInteger(transactionOptions.commitTimeout)) {
        commitSendRequest.requestTimeout = (transactionOptions.commitTimeout as number) * 1000;
      }

      if (proposalSendRequest.handler) {
        commitSendRequest.handler = proposalSendRequest.handler;
      } else {
        commitSendRequest.targets = channel.getCommitters();
      }

      const commitResponse = await commit.send(commitSendRequest);
      if (commitResponse.status !== 'SUCCESS') {
        const message = `Failed to commit transaction ${transactionId}, orderer response status: ${commitResponse.status}`;
        commitWaiter.fail(new SubmitError({
          message,
          transactionId,
        }));
        throw new SubmitError({
          message,
          transactionId,
        });
      }
    } catch (error) {
      commitWaiter.fail(error as Error);
      throw error;
    }

    return {
      result,
      transactionId,
      waitForCommit: commitWaiter.waitForCommit,
    };
  }

  private async createCommitWaiter(
    network: any,
    peers: any[],
    transactionId: string,
  ): Promise<{
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
    fail: (error: Error) => void;
  }> {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let resolvePromise: ((status: CommitStatus) => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;

    const cleanup = (listener: fabricNetwork.CommitListener) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      try {
        network.removeCommitListener(listener);
      } catch {
        // Listener may already be removed.
      }
    };

    const commitPromise = new Promise<CommitStatus>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const listener: fabricNetwork.CommitListener = (error, event) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(listener);

      if (error) {
        rejectPromise?.(new CommitError({
          message: error.message,
          transactionId,
        }));
        return;
      }

      if (!event) {
        rejectPromise?.(new CommitError({
          message: 'Missing commit event',
          transactionId,
        }));
        return;
      }

      const blockEvent = event.getBlockEvent();
      const status: CommitStatus = {
        blockNumber: BigInt(blockEvent.blockNumber.toString()),
        status: event.isValid ? 'VALID' : 'INVALID',
        transactionId,
      };

      if (!event.isValid) {
        rejectPromise?.(new CommitError({
          message: 'transaction committed with invalid validation code',
          transactionId,
          status: 'INVALID',
        }));
        return;
      }

      resolvePromise?.(status);
    };

    await network.addCommitListener(listener, peers, transactionId);

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup(listener);
      rejectPromise?.(new TimeoutError({
        message: `Commit event listener timeout for transaction ${transactionId}`,
        operation: 'commit',
        timeout: this.timeouts.commit,
      }));
    }, this.timeouts.commit);

    return {
      waitForCommit: async () => Result.tryPromise({
        try: async () => commitPromise,
        catch: (error) => this.mapCommitError(error as Error, transactionId),
      }),
      fail: (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup(listener);
        rejectPromise?.(error);
      },
    };
  }

  private async ensureDiscovery(): Promise<Result<DiscoveryResult, DiscoveryError>> {
    const discovery = this.discoveryCache.get(this.channelName);
    if (discovery) {
      return Result.ok(discovery);
    }

    const result = await this.peerConnection.discover(this.channelName);
    if (!result.isOk()) {
      return Result.err(result.error);
    }

    return Result.ok(result.value);
  }

  private matchPeersToEndorsers(
    discovery: DiscoveryResult,
    peerNames: string[],
  ): Result<any[], PeerNotFoundError> {
    const endorsers: any[] = [];
    const notFound: string[] = [];
    const availablePeers = Array.from(discovery.peers.keys());

    for (const peerName of peerNames) {
      const peerInfo = this.peerConnection.matchPeerByPartialName(
        discovery,
        peerName,
      );

      if (!peerInfo) {
        notFound.push(peerName);
        continue;
      }

      const network = (this.contract as any).network;
      const channel = network?.getChannel?.() || (network as any)?.channel;

      if (!channel) {
        notFound.push(peerName);
        continue;
      }

      const endorser = channel.getEndorser?.(peerInfo.endpoint);
      if (endorser) {
        endorsers.push(endorser);
        continue;
      }

      const allEndorsers = channel.getEndorsers?.() || [];
      const matched = allEndorsers.find(
        (candidate: { name?: string }) =>
          candidate.name?.includes(peerName) || peerName.includes(candidate.name || ''),
      );
      if (matched) {
        endorsers.push(matched);
      } else {
        notFound.push(peerName);
      }
    }

    if (notFound.length > 0) {
      return Result.err(
        new PeerNotFoundError({
          peerName: notFound.join(', '),
          availablePeers,
        }),
      );
    }

    return Result.ok(endorsers);
  }

  private getResponsePayload(proposalResponse: any): Buffer {
    const validEndorsementResponse = proposalResponse.responses.find(
      (endorsementResponse: { endorsement?: unknown }) => endorsementResponse.endorsement,
    );

    if (!validEndorsementResponse) {
      throw new EndorsementError({
        message: 'No valid responses from any peers',
      });
    }

    const payload = getTransactionResponse(validEndorsementResponse).payload;
    return asBuffer(payload);
  }

  private mapSubmitError(error: Error): EndorsementError | SubmitError | TimeoutError {
    if (error instanceof EndorsementError || error instanceof SubmitError || error instanceof TimeoutError) {
      return error;
    }

    if (error.message?.includes('timeout') || error.message?.includes('Timeout') || error.message?.includes('TIMEOUT')) {
      return new TimeoutError({
        message: error.message,
        operation: 'submit',
        timeout: this.timeouts.submit,
      });
    }

    return new SubmitError({
      message: error.message,
    });
  }

  private mapCommitError(error: Error, transactionId: string): CommitError | TimeoutError {
    if (error instanceof CommitError || error instanceof TimeoutError) {
      return error;
    }

    if (error.message?.includes('timeout') || error.message?.includes('Timeout') || error.message?.includes('TIMEOUT')) {
      return new TimeoutError({
        message: error.message,
        operation: 'commit',
        timeout: this.timeouts.commit,
      });
    }

    return new CommitError({
      message: error.message,
      transactionId,
    });
  }
}

class PeerCommitResult implements BridgeCommitResult {
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

class PeerSubmittedTx implements BridgeSubmittedTx {
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

function normalizeArgs(args: unknown[]): string[] {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
}

function copyTransientData(input: Record<string, Buffer>): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Buffer.from(value)]),
  );
}
