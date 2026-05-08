import * as fabricGateway from '@hyperledger/fabric-gateway';
import { Result } from 'better-result';
import type {
  BridgeCommitResult,
  BridgeContract,
  BridgeEndorsedTransaction,
  BridgeNetwork,
  BridgeResult,
  BridgeSignedProposal,
  BridgeSignedTransaction,
  BridgeSubmittedTx,
  BridgeTransaction,
  BridgeUnsignedProposal,
  CommitStatus,
  SignedMessage,
  SinglePeerOptions,
} from '../types/bridge';
import type { BridgeConfig, TimeoutConfig } from '../types/config';
import {
  CommitError,
  ConfigurationError,
  EndorsementError,
  EvaluationError,
  OfflineSigningError,
  SubmitError,
  TimeoutError,
} from '../errors/index';
import { DEFAULT_TIMEOUTS } from '../types/config';
import { GatewayConnection } from './GatewayConnection';
import {
  decodeSignedMessage,
  signedMessage,
  signingRequest,
  validateProposalRouting,
} from '../offlineSigning';

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

  UseSinglePeer(_options: SinglePeerOptions = {}): BridgeResult<BridgeTransaction> {
    return Result.err(new ConfigurationError({
      message: 'UseSinglePeer() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions.',
    }));
  }

  useSinglePeer(options: SinglePeerOptions = {}): BridgeResult<BridgeTransaction> {
    return this.UseSinglePeer(options);
  }

  UseEndorsingPeers(_peerNames: string[]): BridgeResult<BridgeTransaction> {
    return Result.err(new ConfigurationError({
      message: 'UseEndorsingPeers() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions.',
    }));
  }

  useEndorsingPeers(peerNames: string[]): BridgeResult<BridgeTransaction> {
    return this.UseEndorsingPeers(peerNames);
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

  async NewUnsignedProposal(...args: unknown[]): Promise<BridgeResult<BridgeUnsignedProposal>> {
    const stringArgs = normalizeArgs(args);

    try {
      const proposal = this.contract.newProposal(this.name, {
        arguments: stringArgs,
        transientData: copyTransientData(this.transientData),
      });
      return Result.ok(new GatewayUnsignedProposal(proposal));
    } catch (error) {
      return Result.err(this.mapSubmitError(error as Error));
    }
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

export function NewGatewaySignedProposal(
  gateway: fabricGateway.Gateway,
  message: SignedMessage,
): BridgeResult<BridgeSignedProposal> {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) {
    return Result.err(decoded.error);
  }
  const routing = validateProposalRouting(decoded.value.routing);
  if (!routing.isOk()) {
    return Result.err(routing.error);
  }
  if (routing.value.mode !== 'gateway-default') {
    return Result.err(new ConfigurationError({
      field: 'routing.mode',
      message: `Gateway signed proposal cannot resume ${routing.value.mode} routing`,
    }));
  }

  try {
    const unsignedProposal = gateway.newProposal(decoded.value.bytes);
    if (!Buffer.from(unsignedProposal.getDigest()).equals(decoded.value.digest)) {
      return Result.err(new OfflineSigningError({
        field: 'digest',
        message: 'digest does not match proposal bytes',
      }));
    }
    const proposal = gateway.newSignedProposal(decoded.value.bytes, decoded.value.signature);
    return Result.ok(new GatewaySignedProposal(proposal));
  } catch (error) {
    return Result.err(new SubmitError({ message: (error as Error).message }));
  }
}

export function NewGatewaySignedTransaction(
  gateway: fabricGateway.Gateway,
  message: SignedMessage,
  timeouts: Required<TimeoutConfig>,
): BridgeResult<BridgeSignedTransaction> {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) {
    return Result.err(decoded.error);
  }
  try {
    const unsignedTransaction = gateway.newTransaction(decoded.value.bytes);
    if (!Buffer.from(unsignedTransaction.getDigest()).equals(decoded.value.digest)) {
      return Result.err(new OfflineSigningError({
        field: 'digest',
        message: 'digest does not match transaction bytes',
      }));
    }
    const transaction = gateway.newSignedTransaction(decoded.value.bytes, decoded.value.signature);
    return Result.ok(new GatewaySignedTransaction(transaction, timeouts));
  } catch (error) {
    return Result.err(new SubmitError({ message: (error as Error).message }));
  }
}

class GatewayUnsignedProposal implements BridgeUnsignedProposal {
  private proposal: fabricGateway.Proposal;

  constructor(proposal: fabricGateway.Proposal) {
    this.proposal = proposal;
  }

  Bytes(): Buffer {
    return Buffer.from(this.proposal.getBytes());
  }

  GetBytes(): Buffer {
    return this.Bytes();
  }

  Digest(): Buffer {
    return Buffer.from(this.proposal.getDigest());
  }

  GetDigest(): Buffer {
    return this.Digest();
  }

  TransactionID(): string {
    return this.proposal.getTransactionId();
  }

  GetTransactionID(): string {
    return this.TransactionID();
  }

  SigningRequest() {
    return signingRequest(this.Bytes(), this.Digest(), { mode: 'gateway-default' });
  }

  GetSigningRequest() {
    return this.SigningRequest();
  }

  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage> {
    return signedMessage(this.SigningRequest(), signature);
  }
}

class GatewaySignedProposal implements BridgeSignedProposal {
  private proposal: fabricGateway.Proposal;

  constructor(proposal: fabricGateway.Proposal) {
    this.proposal = proposal;
  }

  TransactionID(): string {
    return this.proposal.getTransactionId();
  }

  GetTransactionID(): string {
    return this.TransactionID();
  }

  async Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>> {
    try {
      const transaction = await this.proposal.endorse();
      return Result.ok(new GatewayEndorsedTransaction(transaction));
    } catch (error) {
      return Result.err(new EndorsementError({ message: (error as Error).message }));
    }
  }

  async Evaluate(): Promise<BridgeResult<Buffer>> {
    try {
      const result = await this.proposal.evaluate();
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(new EvaluationError({ message: (error as Error).message }));
    }
  }
}

class GatewayEndorsedTransaction implements BridgeEndorsedTransaction {
  private transaction: fabricGateway.Transaction;

  constructor(transaction: fabricGateway.Transaction) {
    this.transaction = transaction;
  }

  Bytes(): Buffer {
    return Buffer.from(this.transaction.getBytes());
  }

  GetBytes(): Buffer {
    return this.Bytes();
  }

  Digest(): Buffer {
    return Buffer.from(this.transaction.getDigest());
  }

  GetDigest(): Buffer {
    return this.Digest();
  }

  Result(): Buffer {
    return Buffer.from(this.transaction.getResult());
  }

  GetResult(): Buffer {
    return this.Result();
  }

  TransactionID(): string {
    return this.transaction.getTransactionId();
  }

  GetTransactionID(): string {
    return this.TransactionID();
  }

  SigningRequest() {
    return signingRequest(this.Bytes(), this.Digest());
  }

  GetSigningRequest() {
    return this.SigningRequest();
  }

  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage> {
    return signedMessage(this.SigningRequest(), signature);
  }
}

class GatewaySignedTransaction implements BridgeSignedTransaction {
  private transaction: fabricGateway.Transaction;
  private timeouts: Required<TimeoutConfig>;

  constructor(transaction: fabricGateway.Transaction, timeouts: Required<TimeoutConfig>) {
    this.transaction = transaction;
    this.timeouts = timeouts;
  }

  Result(): Buffer {
    return Buffer.from(this.transaction.getResult());
  }

  GetResult(): Buffer {
    return this.Result();
  }

  TransactionID(): string {
    return this.transaction.getTransactionId();
  }

  GetTransactionID(): string {
    return this.TransactionID();
  }

  async SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>> {
    try {
      const submitted = await this.transaction.submit();
      return Result.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return Result.err(new SubmitError({ message: (error as Error).message, transactionId: this.TransactionID() }));
    }
  }

  async Submit(): Promise<BridgeResult<BridgeCommitResult>> {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) {
      return Result.err(submitted.error);
    }

    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) {
      return Result.err(status.error);
    }

    return Result.ok(new GatewayCommitResult(submitted.value, status.value));
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
