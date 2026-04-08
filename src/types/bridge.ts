import type { Result } from 'better-result';
import type {
  EndorsementError,
  DiscoveryError,
  PeerNotFoundError,
  SubmitError,
  CommitError,
  EvaluationError,
  ConfigurationError,
  TimeoutError,
  NotConnectedError,
} from '../errors/index';

export type BridgeError =
  | EndorsementError
  | DiscoveryError
  | PeerNotFoundError
  | SubmitError
  | CommitError
  | EvaluationError
  | ConfigurationError
  | TimeoutError
  | NotConnectedError;

export type BridgeResult<T> = Result<T, BridgeError>;

export interface BridgeNetwork {
  getContract(chaincodeName: string): Promise<BridgeContract>;
}

export interface BridgeContract {
  getChaincodeName(): string;

  Submit(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  SubmitAsync(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  Evaluate(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>>;
  Transaction(name: string): BridgeTransaction;

  submitTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  evaluateTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>>;
  createTransaction(name: string): BridgeTransaction;
}

export interface BridgeTransaction {
  getName(): string;
  getChaincodeName(): string;

  SetEndorsingPeers(peerNames: string[]): BridgeTransaction;
  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
  Submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;

  setEndorsingPeers(peerNames: string[]): BridgeTransaction;
  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
  submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  submitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;
}

export interface BridgeCommitResult {
  Result(): Buffer;
  TransactionID(): string;
  CommitStatus(): CommitStatus;

  getResult(): Buffer;
  getTransactionId(): string;
  getCommitStatus(): CommitStatus;
}

export interface BridgeSubmittedTx {
  Result(): Buffer;
  TransactionID(): string;
  WaitForCommit(): Promise<BridgeResult<CommitStatus>>;

  getResult(): Buffer;
  getTransactionId(): string;
  waitForCommit(): Promise<BridgeResult<CommitStatus>>;
  getStatus(): Promise<BridgeResult<CommitStatus>>;
}

export interface CommitStatus {
  blockNumber: bigint;
  status: 'VALID' | 'INVALID';
  transactionId: string;
}
