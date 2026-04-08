import * as fabricGateway from '@hyperledger/fabric-gateway';
import { Result } from 'better-result';
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
import {
  CommitError,
  EndorsementError,
  EvaluationError,
  SubmitError,
  TimeoutError,
} from '../errors/index';
import { DEFAULT_TIMEOUTS } from '../types/config';
import { GatewayConnection } from './GatewayConnection';

export class GatewayNetwork implements BridgeNetwork {
  private gatewayConnection: GatewayConnection;
  private channelName: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(gatewayConnection: GatewayConnection, channelName: string, config: BridgeConfig) {
    this.gatewayConnection = gatewayConnection;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  }

  async getContract(chaincodeName: string): Promise<BridgeContract> {
    const gateway = this.gatewayConnection.getGateway();
    const network = gateway.getNetwork(this.channelName);
    const contract = network.getContract(chaincodeName);
    return new GatewayContract(contract, chaincodeName, this.timeouts);
  }
}

class GatewayContract implements BridgeContract {
  private contract: fabricGateway.Contract;
  private chaincodeName: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(
    contract: fabricGateway.Contract,
    chaincodeName: string,
    timeouts: Required<TimeoutConfig>,
  ) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
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
    const stringArgs = normalizeArgs(args);

    try {
      const result = await this.contract.evaluate(name, {
        arguments: stringArgs,
      });
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(this.mapError(error as Error, 'evaluate'));
    }
  }

  Transaction(name: string): BridgeTransaction {
    return new GatewayTransaction(
      name,
      this.chaincodeName,
      this.contract,
      this.timeouts,
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

  private mapError(
    error: Error,
    operation: 'submit' | 'evaluate',
  ): EndorsementError | SubmitError | EvaluationError | TimeoutError {
    const errorDetails = (error as { details?: Array<{ message?: string; endpoint?: string }> }).details || [];
    const detailMessages = errorDetails
      .map((detail) => `${detail.message ?? 'unknown error'} (${detail.endpoint ?? 'unknown endpoint'})`)
      .join('; ');
    const fullMessage = detailMessages ? `${error.message}: ${detailMessages}` : error.message;

    if (error.message?.includes('timeout') || error.message?.includes('TIMEOUT')) {
      const timeoutValue = operation === 'submit' ? this.timeouts.submit : this.timeouts.evaluate;
      return new TimeoutError({
        message: fullMessage,
        operation,
        timeout: timeoutValue,
      });
    }

    if (operation === 'evaluate') {
      return new EvaluationError({
        message: fullMessage,
        details: detailMessages,
      });
    }

    return new SubmitError({
      message: fullMessage,
    });
  }
}

class GatewayTransaction implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private contract: fabricGateway.Contract;
  private timeouts: Required<TimeoutConfig>;
  private transientData: Record<string, Buffer> = {};

  constructor(
    name: string,
    chaincodeName: string,
    contract: fabricGateway.Contract,
    timeouts: Required<TimeoutConfig>,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contract = contract;
    this.timeouts = timeouts;
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  SetEndorsingPeers(_peerNames: string[]): BridgeTransaction {
    throw new Error(
      'SetEndorsingPeers() is not supported in gateway mode. ' +
      'Use FabricBridge with discovery enabled for peer-targeted transactions.',
    );
  }

  setEndorsingPeers(peerNames: string[]): BridgeTransaction {
    return this.SetEndorsingPeers(peerNames);
  }

  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = { ...transientData };
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

    return Result.ok(new GatewayCommitResult(submittedResult.value, commitStatus.value));
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>> {
    return this.Submit(...args);
  }

  async SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    const stringArgs = normalizeArgs(args);

    try {
      const submitted = await this.contract.submitAsync(this.name, {
        arguments: stringArgs,
        transientData: copyTransientData(this.transientData),
      });

      return Result.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return Result.err(this.mapSubmitError(error as Error));
    }
  }

  async submitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    return this.SubmitAsync(...args);
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = normalizeArgs(args);

    try {
      const result = await this.contract.evaluate(this.name, {
        arguments: stringArgs,
        transientData: copyTransientData(this.transientData),
      });
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(new EvaluationError({
        message: (error as Error).message,
      }));
    }
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    return this.Evaluate(...args);
  }

  private mapSubmitError(error: Error): EndorsementError | SubmitError | TimeoutError {
    if (error.message?.includes('timeout') || error.message?.includes('TIMEOUT')) {
      return new TimeoutError({
        message: error.message,
        operation: 'submit',
        timeout: this.timeouts.submit,
      });
    }

    if (error.name === 'EndorseError') {
      return new EndorsementError({
        message: error.message,
      });
    }

    return new SubmitError({
      message: error.message,
    });
  }
}

class GatewayCommitResult implements BridgeCommitResult {
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

class GatewaySubmittedTx implements BridgeSubmittedTx {
  private submitted: fabricGateway.SubmittedTransaction;
  private timeouts: Required<TimeoutConfig>;

  constructor(submitted: fabricGateway.SubmittedTransaction, timeouts: Required<TimeoutConfig>) {
    this.submitted = submitted;
    this.timeouts = timeouts;
  }

  Result(): Buffer {
    return Buffer.from(this.submitted.getResult());
  }

  getResult(): Buffer {
    return this.Result();
  }

  TransactionID(): string {
    return this.submitted.getTransactionId();
  }

  getTransactionId(): string {
    return this.TransactionID();
  }

  async WaitForCommit(): Promise<BridgeResult<CommitStatus>> {
    try {
      const status = await this.submitted.getStatus({
        deadline: Date.now() + this.timeouts.commit,
      });

      if (!status.successful) {
        return Result.err(new CommitError({
          message: 'transaction committed with invalid validation code',
          transactionId: status.transactionId,
          status: 'INVALID',
        }));
      }

      return Result.ok({
        blockNumber: status.blockNumber,
        status: 'VALID',
        transactionId: status.transactionId,
      });
    } catch (error) {
      return Result.err(new CommitError({
        message: (error as Error).message,
        transactionId: this.submitted.getTransactionId(),
      }));
    }
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

function copyTransientData(input: Record<string, Buffer>): Record<string, Buffer> | undefined {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map(([key, value]) => [key, Buffer.from(value)]),
  );
}
