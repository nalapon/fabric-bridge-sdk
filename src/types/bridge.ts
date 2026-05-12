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
  CreatorIdentity(): BridgeResult<Buffer>;
  CreatorMSPID(): BridgeResult<string>;
  CreatorCertificate(): BridgeResult<Buffer>;
  SigningRequest(): SigningRequest;
  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage>;
}

export interface BridgeSignedProposal {
  TransactionID(): string;
  Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>>;
  Evaluate(): Promise<BridgeResult<Buffer>>;
}

export interface BridgeEndorsedTransaction {
  Bytes(): Buffer;
  Result(): Buffer;
  TransactionID(): string;
  SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>>;
  Submit(): Promise<BridgeResult<BridgeCommitResult>>;
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
}

export interface BridgeSubmittedTx {
  Result(): Buffer;
  TransactionID(): string;
  WaitForCommit(): Promise<BridgeResult<CommitStatus>>;
}

export interface CommitStatus {
  blockNumber: bigint;
  status: 'VALID' | 'INVALID';
  transactionId: string;
}
