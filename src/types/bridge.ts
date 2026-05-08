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
  SinglePeerExecutionError,
  OfflineSigningError,
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
  | NotConnectedError
  | SinglePeerExecutionError
  | OfflineSigningError;

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

  UseSinglePeer(options?: SinglePeerOptions): BridgeResult<BridgeTransaction>;
  UseEndorsingPeers(peerNames: string[]): BridgeResult<BridgeTransaction>;
  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
  Submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;
  NewUnsignedProposal(...args: unknown[]): Promise<BridgeResult<BridgeUnsignedProposal>>;

  useSinglePeer(options?: SinglePeerOptions): BridgeResult<BridgeTransaction>;
  useEndorsingPeers(peerNames: string[]): BridgeResult<BridgeTransaction>;
  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
  submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
  submitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;
}

export type OfflineSigningRouting =
  | { mode: 'gateway-default' }
  | { mode: 'single-peer'; peers: string[] }
  | { mode: 'endorsing-peers'; peers: string[] };

export interface SigningRequest {
  bytes: string;
  digest: string;
  routing?: OfflineSigningRouting;
}

export interface SignedMessage extends SigningRequest {
  signature: string;
}

export interface BridgeUnsignedProposal {
  Bytes(): Buffer;
  Digest(): Buffer;
  TransactionID(): string;
  SigningRequest(): SigningRequest;
  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage>;

  GetBytes(): Buffer;
  GetDigest(): Buffer;
  GetTransactionID(): string;
  GetSigningRequest(): SigningRequest;
}

export interface BridgeSignedProposal {
  TransactionID(): string;
  Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>>;
  Evaluate(): Promise<BridgeResult<Buffer>>;

  GetTransactionID(): string;
}

export interface BridgeEndorsedTransaction {
  Bytes(): Buffer;
  Digest(): Buffer;
  Result(): Buffer;
  TransactionID(): string;
  SigningRequest(): SigningRequest;
  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage>;

  GetBytes(): Buffer;
  GetDigest(): Buffer;
  GetResult(): Buffer;
  GetTransactionID(): string;
  GetSigningRequest(): SigningRequest;
}

export interface BridgeSignedTransaction {
  Result(): Buffer;
  TransactionID(): string;
  SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>>;
  Submit(): Promise<BridgeResult<BridgeCommitResult>>;

  GetResult(): Buffer;
  GetTransactionID(): string;
}

export type PeerSelectionPolicy = 'round-robin' | 'random';

export interface SinglePeerOptions {
  candidates?: string[];
  policy?: PeerSelectionPolicy;
  failover?: boolean;
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
