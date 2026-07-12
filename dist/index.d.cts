import * as better_result from 'better-result';
import { Result } from 'better-result';
import { KeyObject } from 'node:crypto';

/**
 * TLS configuration options.
 *
 * - If only `trustedRoots` is provided: TLS is used (server verification only)
 * - If `trustedRoots`, `clientCert`, and `clientKey` are provided: mTLS is used (mutual authentication)
 * - If no TLS options are provided: insecure connection (no TLS)
 */
interface TlsOptions {
    /** CA certificate to verify the server's TLS certificate. Required for TLS. */
    trustedRoots?: Buffer;
    /** Whether to verify the server's certificate. Defaults to true. */
    verify?: boolean;
    /** Client TLS certificate for mTLS. Only needed if server requires client authentication. */
    clientCert?: Buffer;
    /** Client TLS private key for mTLS. Only needed if server requires client authentication. */
    clientKey?: Buffer;
    /**
     * Overrides the hostname used for TLS certificate verification.
     * Use when the peer's endpoint is localhost or differs from the certificate's CN/SAN.
     * Example: "peer0.org1.example.com"
     */
    sslTargetNameOverride?: string;
}
interface BridgeConfig {
    gatewayEndpoint: string;
    discoverySeed?: string;
    ordererEndpoint?: string;
    identity: {
        mspId: string;
        credentials: Buffer;
    };
    signer: Signer;
    gatewayTls?: TlsOptions;
    discoveryTls?: TlsOptions;
    ordererTls?: TlsOptions;
    discovery?: boolean;
    timeouts?: TimeoutConfig;
}
interface TimeoutConfig {
    endorse?: number;
    submit?: number;
    commit?: number;
    evaluate?: number;
    discovery?: number;
}
type Signer = (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
declare const DEFAULT_TIMEOUTS: Required<TimeoutConfig>;

type FailoverCategory = 'timeout' | 'peer-unavailable' | 'transport' | 'non-retryable' | 'unknown';
interface FailoverDecision {
    eligible: boolean;
    category: FailoverCategory;
    reason: string;
}

/** Safe peer attribution retained from a Fabric Gateway endorsement failure. */
type EndorsementDetail = {
    message: string;
    endpoint: string;
    mspId: string;
};
declare const EndorsementError_base: better_result.TaggedErrorClass<"EndorsementError", {
    message: string;
    details?: EndorsementDetail[];
}>;
declare class EndorsementError extends EndorsementError_base {
}
declare const DiscoveryError_base: better_result.TaggedErrorClass<"DiscoveryError", {
    message: string;
    cause?: Error;
}>;
declare class DiscoveryError extends DiscoveryError_base {
}
declare const PeerNotFoundError_base: better_result.TaggedErrorClass<"PeerNotFoundError", {
    peerName: string;
    availablePeers: string[];
}>;
declare class PeerNotFoundError extends PeerNotFoundError_base {
}
declare const SinglePeerExecutionError_base: better_result.TaggedErrorClass<"SinglePeerExecutionError", {
    message: string;
    operation: string;
    channel: string;
    chaincode: string;
    transaction: string;
    eligiblePeers: string[];
    attempts: Array<{
        peer: string;
        cause: string;
        failover: FailoverDecision;
    }>;
}>;
declare class SinglePeerExecutionError extends SinglePeerExecutionError_base {
}
declare const SubmitError_base: better_result.TaggedErrorClass<"SubmitError", {
    message: string;
    transactionId?: string;
}>;
declare class SubmitError extends SubmitError_base {
}
declare const CommitError_base: better_result.TaggedErrorClass<"CommitError", {
    message: string;
    transactionId: string;
    status?: string;
}>;
declare class CommitError extends CommitError_base {
}
declare const EvaluationError_base: better_result.TaggedErrorClass<"EvaluationError", {
    message: string;
    details?: string;
}>;
declare class EvaluationError extends EvaluationError_base {
}
declare const ChaincodeEventError_base: better_result.TaggedErrorClass<"ChaincodeEventError", {
    message: string;
    chaincodeName: string;
}>;
declare class ChaincodeEventError extends ChaincodeEventError_base {
}
declare const ConfigurationError_base: better_result.TaggedErrorClass<"ConfigurationError", {
    message: string;
    field?: string;
}>;
declare class ConfigurationError extends ConfigurationError_base {
}
declare const TimeoutError_base: better_result.TaggedErrorClass<"TimeoutError", {
    message: string;
    operation: string;
    timeout: number;
}>;
declare class TimeoutError extends TimeoutError_base {
}
declare const NotConnectedError_base: better_result.TaggedErrorClass<"NotConnectedError", {
    component: string;
    action: string;
}>;
declare class NotConnectedError extends NotConnectedError_base {
}
declare const OfflineSigningError_base: better_result.TaggedErrorClass<"OfflineSigningError", {
    message: string;
    field?: string;
}>;
declare class OfflineSigningError extends OfflineSigningError_base {
}

type BridgeError = EndorsementError | DiscoveryError | PeerNotFoundError | SubmitError | CommitError | EvaluationError | ChaincodeEventError | ConfigurationError | TimeoutError | NotConnectedError | SinglePeerExecutionError | OfflineSigningError;
type BridgeResult<T> = Result<T, BridgeError>;
interface BridgeNetwork {
    getContract(chaincodeName: string): Promise<BridgeContract>;
    ChaincodeEvents(chaincodeName: string, options?: ChaincodeEventsOptions): Promise<BridgeResult<ChaincodeEventStream>>;
}
interface BridgeContract {
    getChaincodeName(): string;
    Submit(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
    SubmitAsync(name: string, ...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
    Evaluate(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>>;
    Transaction(name: string): BridgeTransaction;
}
interface BridgeTransaction {
    getName(): string;
    getChaincodeName(): string;
    UseSinglePeer(): BridgeResult<BridgeTransaction>;
    UseEndorsingPeers(...peerNames: string[]): BridgeResult<BridgeTransaction>;
    SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction;
    SetProposalCreator(proposalCreator: ProposalCreator): BridgeTransaction;
    Submit(...args: unknown[]): Promise<BridgeResult<BridgeCommitResult>>;
    SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>>;
    Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>>;
    NewUnsignedProposal(...args: unknown[]): Promise<BridgeResult<BridgeUnsignedProposal>>;
}
interface ProposalCreator {
    mspId: string;
    credentials: Buffer;
}
type OfflineSigningRouting = {
    mode: 'gateway-default';
} | {
    mode: 'single-peer';
    peers: string[];
} | {
    mode: 'endorsing-peers';
    peers: string[];
};
interface SigningRequest {
    bytes: string;
    digest: string;
    routing?: OfflineSigningRouting;
}
interface SignedMessage extends SigningRequest {
    signature: string;
}
interface BridgeUnsignedProposal {
    Bytes(): Buffer;
    Digest(): Buffer;
    TransactionID(): string;
    CreatorIdentity(): BridgeResult<Buffer>;
    CreatorMSPID(): BridgeResult<string>;
    CreatorCertificate(): BridgeResult<Buffer>;
    SigningRequest(): SigningRequest;
    WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage>;
}
interface BridgeSignedProposal {
    TransactionID(): string;
    Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>>;
    Evaluate(): Promise<BridgeResult<Buffer>>;
}
interface BridgeEndorsedTransaction {
    Bytes(): Buffer;
    Digest(): Buffer;
    Result(): Buffer;
    TransactionID(): string;
    SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>>;
    Submit(): Promise<BridgeResult<BridgeCommitResult>>;
}
interface BridgeCommitResult {
    Result(): Buffer;
    TransactionID(): string;
    CommitStatus(): CommitStatus;
}
interface BridgeSubmittedTx {
    Result(): Buffer;
    TransactionID(): string;
    WaitForCommit(): Promise<BridgeResult<CommitStatus>>;
}
interface CommitStatus {
    blockNumber: bigint;
    status: string;
    transactionId: string;
}
interface ChaincodeEvent {
    blockNumber: bigint;
    transactionId: string;
    chaincodeName: string;
    eventName: string;
    payload: Buffer;
}
interface Checkpoint {
    getBlockNumber(): bigint | undefined;
    getTransactionId(): string | undefined;
}
interface Checkpointer extends Checkpoint {
    checkpointBlock(blockNumber: bigint): Promise<void>;
    checkpointTransaction(blockNumber: bigint, transactionId: string): Promise<void>;
    checkpointChaincodeEvent(event: ChaincodeEvent): Promise<void>;
}
interface ChaincodeEventsOptions {
    startBlock?: bigint;
    checkpoint?: Checkpoint;
}
interface ChaincodeEventStream {
    Recv(): Promise<BridgeResult<ChaincodeEvent | null>>;
    Close(): void;
}

declare class FabricBridge {
    private config;
    private gatewayConnection;
    private discoveryCache;
    private isConnected;
    constructor(config: BridgeConfig);
    connect(): Promise<Result<void, ConfigurationError | TimeoutError>>;
    disconnect(): Promise<void>;
    WaitForCommit(channelName: string, transactionId: string): Promise<BridgeResult<CommitStatus>>;
    getNetwork(channelName: string): Promise<Result<BridgeNetwork, NotConnectedError>>;
    NewSignedProposal(message: SignedMessage): Promise<BridgeResult<BridgeSignedProposal>>;
}

/**
 * Creates a private-key signer that returns the signature synchronously.
 *
 * Use this signer when an integration needs a synchronous bridge signer.
 */
declare function createSyncPrivateKeySigner(key: KeyObject): Signer;

interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
declare function setLogger(newLogger: Logger): void;
declare function enableDebugLogging(): void;
declare function disableDebugLogging(): void;

export { type BridgeCommitResult, type BridgeConfig, type BridgeContract, type BridgeEndorsedTransaction, type BridgeError, type BridgeNetwork, type BridgeResult, type BridgeSignedProposal, type BridgeSubmittedTx, type BridgeTransaction, type BridgeUnsignedProposal, type ChaincodeEvent, ChaincodeEventError, type ChaincodeEventStream, type ChaincodeEventsOptions, type Checkpoint, type Checkpointer, CommitError, type CommitStatus, ConfigurationError, DEFAULT_TIMEOUTS, DiscoveryError, type EndorsementDetail, EndorsementError, EvaluationError, FabricBridge, type Logger, NotConnectedError, OfflineSigningError, type OfflineSigningRouting, PeerNotFoundError, type ProposalCreator, type SignedMessage, type Signer, type SigningRequest, SinglePeerExecutionError, SubmitError, type TimeoutConfig, TimeoutError, type TlsOptions, createSyncPrivateKeySigner, disableDebugLogging, enableDebugLogging, setLogger };
