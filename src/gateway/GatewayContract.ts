import * as fabricGateway from '@hyperledger/fabric-gateway';
import * as fabricProtos from '@hyperledger/fabric-protos';
import { Result } from 'better-result';
import { createHash, randomBytes } from 'node:crypto';
import timestampModule from 'google-protobuf/google/protobuf/timestamp_pb.js';
import type {
  BridgeCommitResult,
  BridgeContract,
  BridgeEndorsedTransaction,
  BridgeNetwork,
  BridgeResult,
  BridgeSignedProposal,
  BridgeSubmittedTx,
  BridgeTransaction,
  BridgeUnsignedProposal,
  CommitStatus,
  SignedMessage,
  ProposalCreator,
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
  proposalCreatorCertificate,
  proposalCreatorIdentity,
  proposalCreatorMSPID,
  signedMessage,
  signingRequest,
  validateProposalRouting,
} from '../offlineSigning';

const { Timestamp } = timestampModule as typeof import('google-protobuf/google/protobuf/timestamp_pb.js');

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
    return new GatewayContract(contract, chaincodeName, this.channelName, this.timeouts);
  }
}

class GatewayContract implements BridgeContract {
  private contract: fabricGateway.Contract;
  private chaincodeName: string;
  private channelName: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(
    contract: fabricGateway.Contract,
    chaincodeName: string,
    channelName: string,
    timeouts: Required<TimeoutConfig>,
  ) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
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
      this.channelName,
      this.contract,
      this.timeouts,
    );
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
  private channelName: string;
  private contract: fabricGateway.Contract;
  private timeouts: Required<TimeoutConfig>;
  private transientData: Record<string, Buffer> = {};
  private proposalCreator?: ProposalCreator;

  constructor(
    name: string,
    chaincodeName: string,
    channelName: string,
    contract: fabricGateway.Contract,
    timeouts: Required<TimeoutConfig>,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.contract = contract;
    this.timeouts = timeouts;
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  UseSinglePeer(): BridgeResult<BridgeTransaction> {
    return Result.err(new ConfigurationError({
      message: 'UseSinglePeer() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions.',
    }));
  }

  UseEndorsingPeers(..._peerNames: string[]): BridgeResult<BridgeTransaction> {
    return Result.err(new ConfigurationError({
      message: 'UseEndorsingPeers() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions.',
    }));
  }

  SetTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = { ...transientData };
    return this;
  }

  SetProposalCreator(proposalCreator: ProposalCreator): BridgeTransaction {
    this.proposalCreator = copyProposalCreator(proposalCreator);
    return this;
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

  async SubmitAsync(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    const normalizedArgs = normalizeArgs(args);

    try {
      const submitted = await this.contract.submitAsync(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData),
      });

      return Result.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return Result.err(this.mapSubmitError(error as Error));
    }
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const normalizedArgs = normalizeArgs(args);

    try {
      const result = await this.contract.evaluate(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData),
      });
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(new EvaluationError({
        message: (error as Error).message,
      }));
    }
  }

  async NewUnsignedProposal(...args: unknown[]): Promise<BridgeResult<BridgeUnsignedProposal>> {
    const normalizedArgs = normalizeArgs(args);

    try {
      if (!this.proposalCreator) {
        return Result.err(new ConfigurationError({
          field: 'proposalCreator',
          message: 'proposalCreator is required to build an unsigned proposal for offline signing',
        }));
      }
      return Result.ok(new GatewayUnsignedProposal(buildGatewayProposal({
        channelName: this.channelName,
        chaincodeName: this.chaincodeName,
        transactionName: this.name,
        args: normalizedArgs,
        transientData: copyTransientData(this.transientData),
        proposalCreator: this.proposalCreator,
      })));
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
  timeouts: Required<TimeoutConfig>,
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
    return Result.ok(new GatewaySignedProposal(gateway, proposal, timeouts));
  } catch (error) {
    return Result.err(new SubmitError({ message: (error as Error).message }));
  }
}

class GatewayUnsignedProposal implements BridgeUnsignedProposal {
  private bytes: Buffer;
  private digest: Buffer;
  private transactionId: string;

  constructor(proposal: BuiltGatewayProposal) {
    this.bytes = Buffer.from(proposal.bytes);
    this.digest = Buffer.from(proposal.digest);
    this.transactionId = proposal.transactionId;
  }

  Bytes(): Buffer {
    return Buffer.from(this.bytes);
  }

  Digest(): Buffer {
    return Buffer.from(this.digest);
  }

  TransactionID(): string {
    return this.transactionId;
  }

  CreatorIdentity(): BridgeResult<Buffer> {
    return proposalCreatorIdentity(this.Bytes());
  }

  CreatorMSPID(): BridgeResult<string> {
    return proposalCreatorMSPID(this.Bytes());
  }

  CreatorCertificate(): BridgeResult<Buffer> {
    return proposalCreatorCertificate(this.Bytes());
  }

  SigningRequest() {
    return signingRequest(this.Bytes(), this.Digest(), { mode: 'gateway-default' });
  }

  WithSignature(signature: Buffer | Uint8Array | string): BridgeResult<SignedMessage> {
    return signedMessage(this.SigningRequest(), signature);
  }
}

class GatewaySignedProposal implements BridgeSignedProposal {
  private gateway: fabricGateway.Gateway;
  private proposal: fabricGateway.Proposal;
  private timeouts: Required<TimeoutConfig>;

  constructor(gateway: fabricGateway.Gateway, proposal: fabricGateway.Proposal, timeouts: Required<TimeoutConfig>) {
    this.gateway = gateway;
    this.proposal = proposal;
    this.timeouts = timeouts;
  }

  TransactionID(): string {
    return this.proposal.getTransactionId();
  }

  async Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>> {
    try {
      const transaction = await this.proposal.endorse();
      return Result.ok(new GatewayEndorsedTransaction(this.gateway, transaction, this.timeouts));
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
  private gateway: fabricGateway.Gateway;
  private transaction: fabricGateway.Transaction;
  private timeouts: Required<TimeoutConfig>;

  constructor(gateway: fabricGateway.Gateway, transaction: fabricGateway.Transaction, timeouts: Required<TimeoutConfig>) {
    this.gateway = gateway;
    this.transaction = transaction;
    this.timeouts = timeouts;
  }

  Bytes(): Buffer {
    return Buffer.from(this.transaction.getBytes());
  }

  Digest(): Buffer {
    return Buffer.from(this.transaction.getDigest());
  }

  Result(): Buffer {
    return Buffer.from(this.transaction.getResult());
  }

  TransactionID(): string {
    return this.transaction.getTransactionId();
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

  TransactionID(): string {
    return this.submitted.TransactionID();
  }

  CommitStatus(): CommitStatus {
    return this.commitStatus;
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

  TransactionID(): string {
    return this.submitted.getTransactionId();
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
}

function normalizeArgs(args: unknown[]): Array<string | Uint8Array> {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Uint8Array) return arg;
    return JSON.stringify(arg);
  });
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

interface BuiltGatewayProposal {
  bytes: Buffer;
  digest: Buffer;
  transactionId: string;
}

function buildGatewayProposal(options: {
  channelName: string;
  chaincodeName: string;
  transactionName: string;
  args: Array<string | Uint8Array>;
  transientData?: Record<string, Buffer>;
  proposalCreator: ProposalCreator;
}): BuiltGatewayProposal {
  const creator = serializedIdentity(options.proposalCreator);
  const nonce = randomBytes(24);
  const transactionId = createHash('sha256').update(Buffer.concat([nonce, creator])).digest('hex');

  const signatureHeader = new fabricProtos.common.SignatureHeader();
  signatureHeader.setCreator(creator);
  signatureHeader.setNonce(nonce);

  const chaincodeId = new fabricProtos.peer.ChaincodeID();
  chaincodeId.setName(options.chaincodeName);

  const chaincodeHeaderExtension = new fabricProtos.peer.ChaincodeHeaderExtension();
  chaincodeHeaderExtension.setChaincodeId(chaincodeId);

  const channelHeader = new fabricProtos.common.ChannelHeader();
  channelHeader.setType(fabricProtos.common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setTxId(transactionId);
  channelHeader.setTimestamp(Timestamp.fromDate(new Date()));
  channelHeader.setChannelId(options.channelName);
  channelHeader.setExtension$(chaincodeHeaderExtension.serializeBinary());
  channelHeader.setEpoch(0);

  const header = new fabricProtos.common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  header.setSignatureHeader(signatureHeader.serializeBinary());

  const chaincodeInput = new fabricProtos.peer.ChaincodeInput();
  chaincodeInput.setArgsList([options.transactionName, ...options.args].map(asBytes));

  const chaincodeSpec = new fabricProtos.peer.ChaincodeSpec();
  chaincodeSpec.setType(fabricProtos.peer.ChaincodeSpec.Type.NODE);
  chaincodeSpec.setChaincodeId(chaincodeId);
  chaincodeSpec.setInput(chaincodeInput);

  const invocationSpec = new fabricProtos.peer.ChaincodeInvocationSpec();
  invocationSpec.setChaincodeSpec(chaincodeSpec);

  const payload = new fabricProtos.peer.ChaincodeProposalPayload();
  payload.setInput(invocationSpec.serializeBinary());
  const transientMap = payload.getTransientmapMap();
  for (const [key, value] of Object.entries(options.transientData ?? {})) {
    transientMap.set(key, value);
  }

  const proposal = new fabricProtos.peer.Proposal();
  proposal.setHeader(header.serializeBinary());
  proposal.setPayload(payload.serializeBinary());

  const signedProposal = new fabricProtos.peer.SignedProposal();
  signedProposal.setProposalBytes(proposal.serializeBinary());

  const proposedTransaction = new fabricProtos.gateway.ProposedTransaction();
  proposedTransaction.setProposal(signedProposal);
  proposedTransaction.setTransactionId(transactionId);

  const proposalBytes = signedProposal.getProposalBytes_asU8();
  return {
    bytes: Buffer.from(proposedTransaction.serializeBinary()),
    digest: createHash('sha256').update(proposalBytes).digest(),
    transactionId,
  };
}

function serializedIdentity(proposalCreator: ProposalCreator): Buffer {
  const identity = new fabricProtos.msp.SerializedIdentity();
  identity.setMspid(proposalCreator.mspId);
  identity.setIdBytes(proposalCreator.credentials);
  return Buffer.from(identity.serializeBinary());
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value;
}

function copyProposalCreator(input: ProposalCreator): ProposalCreator {
  return {
    mspId: input.mspId,
    credentials: Buffer.from(input.credentials),
  };
}
