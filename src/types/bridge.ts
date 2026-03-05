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
} from '../errors/index';

export type BridgeError =
  | EndorsementError
  | DiscoveryError
  | PeerNotFoundError
  | SubmitError
  | CommitError
  | EvaluationError
  | ConfigurationError
  | TimeoutError;

export type BridgeResult<T> = Result<T, BridgeError>;

export interface BridgeNetwork {
  getContract(chaincodeName: string, contractName?: string): BridgeContract | Promise<BridgeContract>;
}

export interface BridgeContract {
  getChaincodeName(): string;
  getContractName(): string;
  
  submitTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>>;
  evaluateTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>>;
  
  createTransaction(name: string): BridgeTransaction;
}

export interface BridgeTransaction {
  getName(): string;
  getChaincodeName(): string;
  getContractName(): string;
  
  setEndorsingPeers(peerNames: string[]): BridgeTransaction;
  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
  
  submit(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
  evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;
}

export interface BridgeSubmittedTx {
  getResult(): Buffer;
  getStatus(): Promise<BridgeResult<CommitStatus>>;
}

export interface CommitStatus {
  blockNumber: bigint;
  status: 'VALID' | 'INVALID';
  transactionId: string;
}
