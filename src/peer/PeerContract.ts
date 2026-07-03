import { Result } from "better-result";
import * as fabricProtos from "@hyperledger/fabric-protos";
import type {
  BridgeCommitResult,
  BridgeContract,
  BridgeEndorsedTransaction,
  BridgeResult,
  BridgeSignedProposal,
  BridgeSubmittedTx,
  BridgeTransaction,
  BridgeUnsignedProposal,
  CommitStatus,
  OfflineSigningRouting,
  SignedMessage,
  SigningRequest,
  ProposalCreator,
} from "../types/bridge";
import type { BridgeConfig, TimeoutConfig } from "../types/config";
import type { DiscoveryResult, OrdererInfo, PeerInfo } from "../types/discovery";
import {
  ConfigurationError,
  DiscoveryError,
  EndorsementError,
  EvaluationError,
  OfflineSigningError,
  PeerNotFoundError,
  SinglePeerExecutionError,
  SubmitError,
  TimeoutError,
} from "../errors/index";
import { DEFAULT_TIMEOUTS } from "../types/config";
import { PeerDiscoverySession } from "./PeerDiscoverySession";
import { DiscoveryCache } from "../cache/DiscoveryCache";
import { log } from "../utils/logger";
import { selectSinglePeersResult } from "./peerSelection";
import type { FailoverDecision } from "../types/failover";
import { classifyFailover } from "./failoverEligibility";
import { TransactionTargeting } from "../transactionTargeting";
import { dedupePeerEndpointInputsResult } from "./endpointIdentity";
import {
  decodeSignedMessage,
  digestBytes,
  signedMessage,
  signingRequest,
} from "../offlineSigning";
import {
  proposalCreatorCertificate,
  proposalCreatorIdentity,
  proposalCreatorMSPID,
} from "../offlineSigning";
import { buildPeerProposal } from "./PeerProposalBuilder";
import {
  DirectPeerRuntime,
  signDirectTransactionPayload,
} from "./DirectPeerRuntime";
import {
  normalizePeerEndpointIdentity,
  normalizePeerEndpointIdentityResult,
} from "./endpointIdentity";

type NormalizedArg = string | Buffer;
type PeerProposal = InstanceType<typeof fabricProtos.peer.Proposal>;
type DirectProposalResponse = Awaited<
  ReturnType<DirectPeerRuntime["processProposal"]>
>;

interface DirectProposalResponseSet {
  responses: DirectProposalResponse[];
  errors?: Array<{
    message?: string;
    connection?: {
      name?: string;
    };
  }>;
}

type EndorsedDirectProposalResponse = DirectProposalResponse & {
  endorsement: NonNullable<DirectProposalResponse["endorsement"]>;
};

function hasEndorsement(
  response: DirectProposalResponse,
): response is EndorsedDirectProposalResponse {
  return !!response.endorsement;
}

export class PeerNetwork {
  private channelName: string;
  private timeouts: Required<TimeoutConfig>;
  private config: BridgeConfig;
  private peerConnection: PeerDiscoverySession;
  private discoveryCache: DiscoveryCache;

  constructor(
    channelName: string,
    config: BridgeConfig,
    peerConnection: PeerDiscoverySession,
    discoveryCache: DiscoveryCache,
  ) {
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
  }

  async getContract(chaincodeName: string): Promise<BridgeContract> {
    return new PeerContract(
      chaincodeName,
      this.timeouts,
      this.config,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }
}

export async function NewPeerSignedProposal(
  peerConnection: PeerDiscoverySession,
  config: BridgeConfig,
  message: SignedMessage,
): Promise<BridgeResult<BridgeSignedProposal>> {
  const decoded = decodePeerSignedMessage(message);
  if (!decoded.isOk()) {
    return Result.err(decoded.error);
  }
  if (
    !decoded.value.routing ||
    decoded.value.routing.mode === "gateway-default"
  ) {
    return Result.err(
      new OfflineSigningError({
        field: "routing",
        message: "peer signed proposal requires peer routing",
      }),
    );
  }
  const routingPeers = normalizeSnapshotPeerEndpoints(
    decoded.value.routing.peers,
    !!config.discoveryTls?.trustedRoots,
  );
  if (!routingPeers.isOk()) {
    return Result.err(routingPeers.error);
  }
  if (
    decoded.value.routing.mode === "single-peer" &&
    routingPeers.value.length !== 1
  ) {
    return Result.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: "single-peer routing requires exactly one peer endpoint",
      }),
    );
  }
  const routing = { ...decoded.value.routing, peers: routingPeers.value };

  try {
    const proposal = fabricProtos.peer.Proposal.deserializeBinary(
      decoded.value.bytes,
    );
    const header = fabricProtos.common.Header.deserializeBinary(
      proposal.getHeader_asU8(),
    );
    const channelHeader = fabricProtos.common.ChannelHeader.deserializeBinary(
      header.getChannelHeader_asU8(),
    );
    const channelName = channelHeader.getChannelId();
    return Result.ok(
      new PeerSignedProposal(
        peerConnection,
        channelName,
        config,
        decoded.value.bytes,
        decoded.value.signature,
        routing,
      ),
    );
  } catch (error) {
    return Result.err(
      new ConfigurationError({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

class PeerContract implements BridgeContract {
  private chaincodeName: string;
  private timeouts: Required<TimeoutConfig>;
  private config: BridgeConfig;
  private peerConnection: PeerDiscoverySession;
  private discoveryCache: DiscoveryCache;
  private channelName: string;

  constructor(
    chaincodeName: string,
    timeouts: Required<TimeoutConfig>,
    config: BridgeConfig,
    peerConnection: PeerDiscoverySession,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  async Submit(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeCommitResult>> {
    const tx = this.Transaction(name);
    return tx.Submit(...args);
  }

  async SubmitAsync(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeSubmittedTx>> {
    const tx = this.Transaction(name);
    return tx.SubmitAsync(...args);
  }

  async Evaluate(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    const tx = this.Transaction(name);
    return tx.Evaluate(...args);
  }

  Transaction(name: string): BridgeTransaction {
    log().debug("PeerContract.Transaction() - name:", name);
    return new PeerTransaction(
      name,
      this.chaincodeName,
      this.timeouts,
      this.config,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }
}

class PeerTransaction implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private timeouts: Required<TimeoutConfig>;
  private config: BridgeConfig;
  private peerConnection: PeerDiscoverySession;
  private discoveryCache: DiscoveryCache;
  private channelName: string;
  private targeting = TransactionTargeting.gatewayDefault();
  private transientData: Record<string, Buffer> = {};
  private proposalCreator?: ProposalCreator;

  constructor(
    name: string,
    chaincodeName: string,
    timeouts: Required<TimeoutConfig>,
    config: BridgeConfig,
    peerConnection: PeerDiscoverySession,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.config = config;
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

  UseSinglePeer(): BridgeResult<BridgeTransaction> {
    const targeting = TransactionTargeting.singlePeer();
    if (!targeting.isOk()) {
      return Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result.ok(this);
  }

  UseEndorsingPeers(...peerNames: string[]): BridgeResult<BridgeTransaction> {
    const canonicalPeerNames = dedupePeerEndpointInputsResult(
      peerNames,
      this.peerConnection.usesDiscoveryTLS(),
    );
    if (!canonicalPeerNames.isOk()) {
      return Result.err(canonicalPeerNames.error);
    }

    const targeting = TransactionTargeting.endorsingPeers(canonicalPeerNames.value);
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
    const submittedResult = await this.SubmitAsync(...args);
    if (!submittedResult.isOk()) {
      return Result.err(submittedResult.error);
    }

    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result.err(commitStatus.error);
    }

    return Result.ok(
      new PeerCommitResult(submittedResult.value, commitStatus.value),
    );
  }

  async SubmitAsync(
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeSubmittedTx>> {
    log().debug(
      "PeerTransaction.SubmitAsync() - transaction:",
      this.name,
      "chaincode:",
      this.chaincodeName,
    );

    const normalizedArgs = normalizeArgs(args);

    return Result.tryPromise({
      try: async () => {
        const submitted = this.targeting.isSinglePeer()
          ? await this.submitAsyncSinglePeer(normalizedArgs)
          : await this.submitAsyncEndorsingPeers(normalizedArgs);
        return new PeerSubmittedTx(
          submitted.result,
          submitted.transactionId,
          submitted.waitForCommit,
        );
      },
      catch: (error) => this.mapSubmitError(error as Error),
    });
  }

  async Evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const normalizedArgs = normalizeArgs(args);

    try {
      const result = this.targeting.isSinglePeer()
        ? await this.evaluateSinglePeer(normalizedArgs)
        : await this.evaluateEndorsingPeers(normalizedArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      if (
        error instanceof SinglePeerExecutionError ||
        error instanceof PeerNotFoundError ||
        error instanceof DiscoveryError ||
        error instanceof TimeoutError
      ) {
        return Result.err(error);
      }
      return Result.err(
        new EvaluationError({
          message: (error as Error).message,
        }),
      );
    }
  }

  async NewUnsignedProposal(
    ...args: unknown[]
  ): Promise<BridgeResult<BridgeUnsignedProposal>> {
    const normalizedArgs = normalizeArgs(args);

    try {
      if (!this.proposalCreator) {
        return Result.err(
          new ConfigurationError({
            field: "proposalCreator",
            message:
              "proposalCreator is required to build an unsigned proposal for offline signing",
          }),
        );
      }

      if (this.targeting.isSinglePeer()) {
        const selected = (await this.resolveSinglePeerTargets())[0];
        if (!selected) {
          throw new PeerNotFoundError({
            peerName: "<single-peer>",
            availablePeers: [],
          });
        }
        return Result.ok(
          this.buildUnsignedProposal(normalizedArgs, {
            mode: "single-peer",
            peers: [selected.endpoint],
          }),
        );
      }

      const endorsingPeerNames = this.targeting.endorsingPeerNames();
      const peers =
        endorsingPeerNames.length > 0
          ? await this.resolvedEndorsingPeerSnapshot(endorsingPeerNames)
          : [];
      const routing: OfflineSigningRouting =
        peers.length > 0
          ? { mode: "endorsing-peers", peers }
          : { mode: "gateway-default" };
      return Result.ok(this.buildUnsignedProposal(normalizedArgs, routing));
    } catch (error) {
      return Result.err(this.mapSubmitError(error as Error));
    }
  }

  private buildUnsignedProposal(
    stringArgs: NormalizedArg[],
    routing: OfflineSigningRouting,
  ): BridgeUnsignedProposal {
    const proposal = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData(this.transientData),
      proposalCreator: this.proposalCreator!,
    });
    return new PeerUnsignedProposal(
      proposal.bytes,
      proposal.digest,
      proposal.transactionId,
      routing,
    );
  }

  private async resolvedEndorsingPeerSnapshot(
    peerNames: string[],
  ): Promise<string[]> {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }

    const peerInfos = this.resolvePeerInfos(discoveryResult.value, peerNames);
    if (!peerInfos.isOk()) {
      throw peerInfos.error;
    }

    return peerInfos.value.map((peer) => peer.endpoint);
  }

  private async resolveSinglePeerTargets(): Promise<PeerInfo[]> {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }

    const selection = selectSinglePeersResult(
      discoveryResult.value,
      this.discoveryCache,
    );
    if (!selection.isOk()) {
      throw selection.error;
    }

    return selection.value.orderedPeers;
  }

  private async resolveEndorsingPeerTargets(): Promise<PeerInfo[]> {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }

    const peerInfos = this.resolvePeerInfos(
      discoveryResult.value,
      this.targeting.endorsingPeerNames(),
    );
    if (!peerInfos.isOk()) {
      throw peerInfos.error;
    }

    return peerInfos.value;
  }

  private async submitAsyncSinglePeer(stringArgs: NormalizedArg[]): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    return this.executeSinglePeer("submitAsync", async (selected) => {
      return this.submitAsyncToSinglePeer(selected, stringArgs);
    });
  }

  private async submitAsyncEndorsingPeers(
    stringArgs: NormalizedArg[],
  ): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    return this.submitAsyncToEndorsers(
      await this.resolveEndorsingPeerTargets(),
      stringArgs,
    );
  }

  private async evaluateSinglePeer(
    stringArgs: NormalizedArg[],
  ): Promise<Buffer> {
    return this.executeSinglePeer("evaluate", async (selected) => {
      return this.evaluateSinglePeerTarget(selected, stringArgs);
    });
  }

  private async evaluateEndorsingPeers(
    stringArgs: NormalizedArg[],
  ): Promise<Buffer> {
    return this.evaluateEndorsers(
      await this.resolveEndorsingPeerTargets(),
      stringArgs,
    );
  }

  private async executeSinglePeer<T>(
    operation: "submitAsync" | "evaluate",
    execute: (selected: PeerInfo) => Promise<T>,
  ): Promise<T> {
    const peers = await this.resolveSinglePeerTargets();
    const attempts: Array<{
      peer: string;
      cause: string;
      failover: FailoverDecision;
    }> = [];
    const peersToTry = peers;

    for (let index = 0; index < peersToTry.length; index += 1) {
      const selected = peersToTry[index]!;
      try {
        return await execute(selected);
      } catch (error) {
        const decision = classifyFailover(error);
        attempts.push({
          peer: selected.endpoint,
          cause: error instanceof Error ? error.message : String(error),
          failover: decision,
        });
        if (!decision.eligible) {
          throw error;
        }
        if (index === peersToTry.length - 1) {
          throw this.singlePeerExecutionError(operation, peers, attempts);
        }

        const next = peersToTry[index + 1]!;
        log().warn("fabric_bridge.single_peer.failover", {
          event: "fabric_bridge.single_peer.failover",
          operation,
          channel: this.channelName,
          chaincode: this.chaincodeName,
          transaction: this.name,
          failedPeer: selected.endpoint,
          nextPeer: next.endpoint,
          attempt: index + 1,
          maxAttempts: peersToTry.length,
          reason: decision.reason,
          category: decision.category,
        });
      }
    }

    throw this.singlePeerExecutionError(operation, peers, attempts);
  }

  private async submitAsyncToSinglePeer(
    peer: PeerInfo,
    stringArgs: NormalizedArg[],
  ): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    const prepared = await this.sendDirectSinglePeerProposal(peer, stringArgs);
    const result = getPeerProposalPayload({
      responses: [prepared.proposalResponse],
    });
    const transactionPayload = buildPeerTransactionPayload(prepared.proposal, [
      prepared.proposalResponse,
    ]);
    const runtime = new DirectPeerRuntime(this.config);
    await runtime.submitEnvelope(
      transactionPayload,
      await signDirectTransactionPayload(this.config, transactionPayload),
      prepared.transactionId,
      await this.resolveSubmitOrdererEndpoint(),
    );

    return {
      result,
      transactionId: prepared.transactionId,
      waitForCommit: () =>
        runtime.waitForCommit(this.channelName, prepared.transactionId),
    };
  }

  private async evaluateSinglePeerTarget(
    peer: PeerInfo,
    stringArgs: NormalizedArg[],
  ): Promise<Buffer> {
    const prepared = await this.sendDirectSinglePeerProposal(peer, stringArgs);
    return getPeerProposalPayload({ responses: [prepared.proposalResponse] });
  }

  private async sendDirectSinglePeerProposal(
    peer: PeerInfo,
    stringArgs: NormalizedArg[],
  ): Promise<{
    proposal: PeerProposal;
    proposalResponse: DirectProposalResponse;
    transactionId: string;
  }> {
    const built = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData(this.transientData),
      proposalCreator: {
        mspId: this.config.identity.mspId,
        credentials: this.config.identity.credentials,
      },
    });
    const signature = Buffer.from(await this.config.signer(built.digest));
    return {
      proposal: fabricProtos.peer.Proposal.deserializeBinary(built.bytes),
      proposalResponse: await new DirectPeerRuntime(
        this.config,
      ).processProposal(peer.endpoint, built.bytes, signature),
      transactionId: built.transactionId,
    };
  }

  private async submitAsyncToEndorsers(
    peers: PeerInfo[],
    stringArgs: NormalizedArg[],
  ): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    const prepared = await this.sendDirectExplicitProposal(peers, stringArgs);
    const result = getPeerProposalPayload({
      responses: prepared.proposalResponses,
    });
    const transactionPayload = buildPeerTransactionPayload(
      prepared.proposal,
      prepared.proposalResponses,
    );
    const runtime = new DirectPeerRuntime(this.config);
    await runtime.submitEnvelope(
      transactionPayload,
      await signDirectTransactionPayload(this.config, transactionPayload),
      prepared.transactionId,
      await this.resolveSubmitOrdererEndpoint(),
    );

    return {
      result,
      transactionId: prepared.transactionId,
      waitForCommit: () =>
        runtime.waitForCommit(this.channelName, prepared.transactionId),
    };
  }

  private async evaluateEndorsers(
    peers: PeerInfo[],
    stringArgs: NormalizedArg[],
  ): Promise<Buffer> {
    const prepared = await this.sendDirectExplicitProposal(peers, stringArgs);
    return getPeerProposalPayload({ responses: prepared.proposalResponses });
  }

  private async sendDirectExplicitProposal(
    peers: PeerInfo[],
    stringArgs: NormalizedArg[],
  ): Promise<{
    proposal: PeerProposal;
    proposalResponses: DirectProposalResponse[];
    transactionId: string;
  }> {
    const built = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData(this.transientData),
      proposalCreator: {
        mspId: this.config.identity.mspId,
        credentials: this.config.identity.credentials,
      },
    });
    const signature = Buffer.from(await this.config.signer(built.digest));
    const runtime = new DirectPeerRuntime(this.config);
    const settled = await Promise.all(
      peers.map(async (peer) => ({
        peer,
        response: await runtime.processProposal(
          peer.endpoint,
          built.bytes,
          signature,
        ),
      })),
    );
    const proposalResponses = settled.map((item) => item.response);
    validateExplicitProposalResponses(proposalResponses);
    return {
      proposal: fabricProtos.peer.Proposal.deserializeBinary(built.bytes),
      proposalResponses,
      transactionId: built.transactionId,
    };
  }

  private async ensureDiscovery(): Promise<
    Result<DiscoveryResult, DiscoveryError>
  > {
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

  private async resolveSubmitOrdererEndpoint(): Promise<string | undefined> {
    if (this.config.ordererEndpoint) {
      return this.config.ordererEndpoint;
    }

    const discovery = await this.ensureDiscovery();
    if (!discovery.isOk()) {
      throw discovery.error;
    }
    return selectDiscoveredOrdererEndpoint(discovery.value.orderers);
  }

  private resolvePeerInfos(
    discovery: DiscoveryResult,
    peerNames: string[],
  ): Result<PeerInfo[], PeerNotFoundError | ConfigurationError> {
    const peerInfos: PeerInfo[] = [];
    const notFound: string[] = [];
    const seen = new Set<string>();

    for (const peerName of peerNames) {
      const canonicalPeerName =
        this.peerConnection.normalizePeerEndpointIdentity(peerName);
      if (seen.has(canonicalPeerName)) {
        continue;
      }
      seen.add(canonicalPeerName);

      const peerInfo = this.peerConnection.matchPeerByEndpointIdentity(
        discovery,
        canonicalPeerName,
      );
      if (!peerInfo) {
        notFound.push(canonicalPeerName);
        continue;
      }
      peerInfos.push(peerInfo);
    }

    if (notFound.length > 0) {
      return Result.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers: Array.from(discovery.peers.keys()),
        }),
      );
    }

    return Result.ok(peerInfos);
  }

  private singlePeerExecutionError(
    operation: string,
    eligiblePeers: Array<{ endpoint: string }>,
    attempts: Array<{
      peer: string;
      cause: string;
      failover: FailoverDecision;
    }>,
  ): SinglePeerExecutionError {
    return new SinglePeerExecutionError({
      message: `single-peer transaction failed after trying ${attempts.length} eligible peer(s)`,
      operation,
      channel: this.channelName,
      chaincode: this.chaincodeName,
      transaction: this.name,
      eligiblePeers: eligiblePeers.map((peer) => peer.endpoint),
      attempts,
    });
  }

  private mapSubmitError(
    error: Error,
  ):
    | EndorsementError
    | SubmitError
    | TimeoutError
    | SinglePeerExecutionError
    | PeerNotFoundError
    | DiscoveryError
    | ConfigurationError {
    if (
      error instanceof EndorsementError ||
      error instanceof SubmitError ||
      error instanceof TimeoutError ||
      error instanceof SinglePeerExecutionError ||
      error instanceof PeerNotFoundError ||
      error instanceof DiscoveryError ||
      error instanceof ConfigurationError
    ) {
      return error;
    }

    if (
      error.message?.includes("timeout") ||
      error.message?.includes("Timeout") ||
      error.message?.includes("TIMEOUT")
    ) {
      return new TimeoutError({
        message: error.message,
        operation: "submit",
        timeout: this.timeouts.submit,
      });
    }

    return new SubmitError({
      message: error.message,
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
  TransactionID(): string {
    return this.submitted.TransactionID();
  }
  CommitStatus(): CommitStatus {
    return this.commitStatus;
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
  TransactionID(): string {
    return this.transactionId;
  }
  async WaitForCommit(): Promise<BridgeResult<CommitStatus>> {
    return this.waitForCommitFn();
  }
}

class PeerUnsignedProposal implements BridgeUnsignedProposal {
  private bytes: Buffer;
  private digest: Buffer;
  private transactionId: string;
  private routing: OfflineSigningRouting;

  constructor(
    bytes: Buffer,
    digest: Buffer,
    transactionId: string,
    routing: OfflineSigningRouting,
  ) {
    this.bytes = Buffer.from(bytes);
    this.digest = Buffer.from(digest);
    this.transactionId = transactionId;
    this.routing =
      routing.mode === "gateway-default"
        ? { mode: "gateway-default" }
        : { mode: routing.mode, peers: [...routing.peers] };
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
    return proposalCreatorIdentity(this.bytes);
  }
  CreatorMSPID(): BridgeResult<string> {
    return proposalCreatorMSPID(this.bytes);
  }
  CreatorCertificate(): BridgeResult<Buffer> {
    return proposalCreatorCertificate(this.bytes);
  }
  SigningRequest(): SigningRequest {
    return signingRequest(this.bytes, this.digest, this.routing);
  }
  WithSignature(
    signature: Buffer | Uint8Array | string,
  ): BridgeResult<SignedMessage> {
    return signedMessage(this.SigningRequest(), signature);
  }
}

class PeerSignedProposal implements BridgeSignedProposal {
  private peerConnection: PeerDiscoverySession;
  private channelName: string;
  private config: BridgeConfig;
  private bytes: Buffer;
  private signature: Buffer;
  private routing: Exclude<OfflineSigningRouting, { mode: "gateway-default" }>;
  private transactionId: string;
  private proposal: PeerProposal;

  constructor(
    peerConnection: PeerDiscoverySession,
    channelName: string,
    config: BridgeConfig,
    bytes: Buffer,
    signature: Buffer,
    routing: Exclude<OfflineSigningRouting, { mode: "gateway-default" }>,
  ) {
    this.peerConnection = peerConnection;
    this.channelName = channelName;
    this.config = config;
    this.bytes = Buffer.from(bytes);
    this.signature = Buffer.from(signature);
    this.routing = {
      mode: routing.mode,
      peers: uniqueCanonicalPeerEndpoints(
        routing.peers,
        !!config.discoveryTls?.trustedRoots,
      ),
    };
    this.proposal = fabricProtos.peer.Proposal.deserializeBinary(this.bytes);
    const header = fabricProtos.common.Header.deserializeBinary(
      this.proposal.getHeader_asU8(),
    );
    const channelHeader = fabricProtos.common.ChannelHeader.deserializeBinary(
      header.getChannelHeader_asU8(),
    );
    this.transactionId = channelHeader.getTxId();
  }

  TransactionID(): string {
    return this.transactionId;
  }
  async Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>> {
    try {
      const proposalResponse = await this.sendProposal();
      const payload = getPeerProposalPayload(proposalResponse);
      const txPayload = buildPeerTransactionPayload(
        this.proposal,
        proposalResponse.responses,
      );
      return Result.ok(
        new PeerEndorsedTransaction(
          this.config,
          this.peerConnection,
          this.channelName,
          txPayload,
          payload,
          this.transactionId,
        ),
      );
    } catch (error) {
      if (
        error instanceof EndorsementError ||
        error instanceof PeerNotFoundError ||
        error instanceof DiscoveryError ||
        error instanceof ConfigurationError
      ) {
        return Result.err(error);
      }
      return Result.err(
        new EndorsementError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async Evaluate(): Promise<BridgeResult<Buffer>> {
    try {
      const proposalResponse = await this.sendProposal();
      return Result.ok(getPeerProposalPayload(proposalResponse));
    } catch (error) {
      if (
        error instanceof PeerNotFoundError ||
        error instanceof DiscoveryError ||
        error instanceof ConfigurationError
      ) {
        return Result.err(error);
      }
      return Result.err(
        new EvaluationError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async sendProposal(): Promise<DirectProposalResponseSet> {
    const endpoints = await this.resolveSnapshottedPeerEndpoints();
    const runtime = new DirectPeerRuntime(this.config);
    const responses = await Promise.all(
      endpoints.map((endpoint) =>
        runtime.processProposal(endpoint, this.bytes, this.signature),
      ),
    );
    if (this.routing.mode === "endorsing-peers") {
      validateExplicitProposalResponses(responses);
    }
    return { responses, errors: [] };
  }

  private async resolveSnapshottedPeerEndpoints(): Promise<string[]> {
    const discovery = await discoveredPeerEndpoints(
      this.peerConnection,
      this.channelName,
      !!this.config.discoveryTls?.trustedRoots,
    );
    const missingFromDiscovery = this.routing.peers.filter(
      (endpoint) => !discovery.has(endpoint),
    );
    if (missingFromDiscovery.length > 0) {
      throw new PeerNotFoundError({
        peerName: missingFromDiscovery.join(", "),
        availablePeers: Array.from(discovery),
      });
    }
    return [...this.routing.peers];
  }
}

class PeerEndorsedTransaction implements BridgeEndorsedTransaction {
  private config: BridgeConfig;
  private peerConnection: PeerDiscoverySession;
  private channelName: string;
  private bytes: Buffer;
  private result: Buffer;
  private transactionId: string;

  constructor(
    config: BridgeConfig,
    peerConnection: PeerDiscoverySession,
    channelName: string,
    bytes: Buffer,
    result: Buffer,
    transactionId: string,
  ) {
    this.config = config;
    this.peerConnection = peerConnection;
    this.channelName = channelName;
    this.bytes = Buffer.from(bytes);
    this.result = Buffer.from(result);
    this.transactionId = transactionId;
  }

  Bytes(): Buffer {
    return Buffer.from(this.bytes);
  }
  Digest(): Buffer {
    return digestBytes(this.bytes);
  }
  Result(): Buffer {
    return Buffer.from(this.result);
  }
  TransactionID(): string {
    return this.transactionId;
  }

  async SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>> {
    try {
      const runtime = new DirectPeerRuntime(this.config);
      await runtime.submitEnvelope(
        this.bytes,
        await signDirectTransactionPayload(this.config, this.bytes),
        this.transactionId,
        await this.resolveSubmitOrdererEndpoint(),
      );
      return Result.ok(
        new PeerSubmittedTx(this.result, this.transactionId, () =>
          runtime.waitForCommit(this.channelName, this.transactionId),
        ),
      );
    } catch (error) {
      return Result.err(
        error instanceof SubmitError
          ? error
          : new SubmitError({
              message: error instanceof Error ? error.message : String(error),
              transactionId: this.transactionId,
            }),
      );
    }
  }

  private async resolveSubmitOrdererEndpoint(): Promise<string | undefined> {
    if (this.config.ordererEndpoint) {
      return this.config.ordererEndpoint;
    }

    const discovery = await this.peerConnection.discover(this.channelName);
    if (!discovery.isOk()) {
      throw discovery.error;
    }
    return selectDiscoveredOrdererEndpoint(discovery.value.orderers);
  }

  async Submit(): Promise<BridgeResult<BridgeCommitResult>> {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) return Result.err(submitted.error);
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) return Result.err(status.error);
    return Result.ok(new PeerCommitResult(submitted.value, status.value));
  }
}

function decodePeerSignedMessage(message: SignedMessage): BridgeResult<{
  bytes: Buffer;
  digest: Buffer;
  signature: Buffer;
  routing?: OfflineSigningRouting;
}> {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) return Result.err(decoded.error);
  const actualDigest = digestBytes(decoded.value.bytes);
  if (!actualDigest.equals(decoded.value.digest)) {
    return Result.err(
      new OfflineSigningError({
        field: "digest",
        message: "digest does not match proposal bytes",
      }),
    );
  }
  return Result.ok(decoded.value);
}

function getPeerProposalPayload(
  proposalResponse: DirectProposalResponseSet,
): Buffer {
  const valid = proposalResponse.responses?.find(
    (response: { endorsement?: unknown }) => response.endorsement,
  );
  if (!valid) {
    throw new EndorsementError({
      message: noValidPeerResponsesMessage(proposalResponse),
    });
  }
  if (valid.response?.payload) {
    return Buffer.from(valid.response.payload);
  }
  throw new EndorsementError({
    message: "proposal response has no chaincode result payload",
  });
}

export function validateExplicitProposalResponses(
  proposalResponses: DirectProposalResponse[],
): void {
  if (proposalResponses.length === 0) {
    throw new EndorsementError({
      message: "at least one proposal response is required",
    });
  }

  const first = proposalResponses[0]!;
  validateExplicitProposalResponse(first);
  const firstPayload = Buffer.from(first.payload ?? []);

  for (const response of proposalResponses.slice(1)) {
    validateExplicitProposalResponse(response);
    if (!firstPayload.equals(Buffer.from(response.payload ?? []))) {
      throw new EndorsementError({
        message: "proposal response payloads do not match",
      });
    }
  }
}

function validateExplicitProposalResponse(
  response: DirectProposalResponse,
): void {
  if (!response) {
    throw new EndorsementError({ message: "proposal response is empty" });
  }
  const status = response.response?.status ?? 0;
  if (status < 200 || status >= 400) {
    throw new EndorsementError({
      message: `proposal response was not successful, status ${status}: ${response.response?.message ?? ""}`,
    });
  }
  if (!response.endorsement) {
    throw new EndorsementError({
      message: "proposal response has no endorsement",
    });
  }
}

export function buildPeerTransactionPayload(
  proposal: PeerProposal,
  proposalResponses: DirectProposalResponse[],
): Buffer {
  const validResponses = proposalResponses.filter(hasEndorsement);
  if (validResponses.length === 0) {
    throw new EndorsementError({ message: "No valid endorsements found" });
  }

  const header = fabricProtos.common.Header.deserializeBinary(
    proposal.getHeader_asU8(),
  );
  const endorsements = validResponses.map((response) => {
    const endorsement = new fabricProtos.peer.Endorsement();
    endorsement.setEndorser(response.endorsement.endorser);
    endorsement.setSignature(response.endorsement.signature);
    return endorsement;
  });
  const proposalResponse = validResponses[0]!;
  const chaincodeEndorsedAction =
    new fabricProtos.peer.ChaincodeEndorsedAction();
  chaincodeEndorsedAction.setProposalResponsePayload(proposalResponse.payload);
  chaincodeEndorsedAction.setEndorsementsList(endorsements);
  const originalProposalPayload =
    fabricProtos.peer.ChaincodeProposalPayload.deserializeBinary(
      proposal.getPayload_asU8(),
    );
  const proposalPayloadNoTransient =
    new fabricProtos.peer.ChaincodeProposalPayload();
  proposalPayloadNoTransient.setInput(originalProposalPayload.getInput_asU8());

  const actionPayload = new fabricProtos.peer.ChaincodeActionPayload();
  actionPayload.setAction(chaincodeEndorsedAction);
  actionPayload.setChaincodeProposalPayload(
    proposalPayloadNoTransient.serializeBinary(),
  );

  const transactionAction = new fabricProtos.peer.TransactionAction();
  transactionAction.setHeader(header.getSignatureHeader_asU8());
  transactionAction.setPayload(actionPayload.serializeBinary());

  const transaction = new fabricProtos.peer.Transaction();
  transaction.setActionsList([transactionAction]);

  const payload = new fabricProtos.common.Payload();
  payload.setHeader(header);
  payload.setData(transaction.serializeBinary());
  return Buffer.from(payload.serializeBinary());
}

function noValidPeerResponsesMessage(
  proposalResponse: DirectProposalResponseSet,
): string {
  const errorInfos: string[] = [];

  for (const error of proposalResponse.errors ?? []) {
    errorInfos.push(
      `peer=${error?.connection?.name ?? "unknown"}, status=grpc, message=${error?.message ?? "unknown error"}`,
    );
  }

  for (const response of proposalResponse.responses ?? []) {
    errorInfos.push(
      `status=${response.response?.status ?? "unknown"}, message=${response.response?.message ?? "unknown error"}`,
    );
  }

  return errorInfos.length > 0
    ? `No valid responses from any peers. Errors:\n    ${errorInfos.join("\n    ")}`
    : "No valid responses from any peers";
}

function normalizeArgs(args: unknown[]): NormalizedArg[] {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Buffer) return arg;
    if (arg instanceof Uint8Array) {
      return Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength);
    }
    return JSON.stringify(arg);
  });
}

function uniqueCanonicalPeerEndpoints(
  peers: string[],
  tlsEnabled: boolean,
): string[] {
  return uniquePeerEndpoints(peers, (peer) =>
    normalizePeerEndpointIdentity(peer, tlsEnabled),
  );
}

function normalizeSnapshotPeerEndpoints(
  peers: string[],
  tlsEnabled: boolean,
): BridgeResult<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const peer of peers) {
    const normalized = normalizePeerEndpointIdentityResult(peer, tlsEnabled);
    if (!normalized.isOk()) {
      return Result.err(
        new OfflineSigningError({
          field: "routing.peers",
          message: normalized.error.message,
        }),
      );
    }
    if (seen.has(normalized.value)) {
      continue;
    }
    seen.add(normalized.value);
    out.push(normalized.value);
  }
  return Result.ok(out);
}

async function discoveredPeerEndpoints(
  peerConnection: PeerDiscoverySession,
  channelName: string,
  _tlsEnabled: boolean,
): Promise<Set<string>> {
  const discovery = await peerConnection.discover(channelName);
  if (!discovery.isOk()) {
    throw discovery.error;
  }
  return new Set(discovery.value.peers.keys());
}

function selectDiscoveredOrdererEndpoint(
  orderers: OrdererInfo[],
): string | undefined {
  return [...orderers].sort((a, b) =>
    a.endpoint === b.endpoint
      ? a.mspId.localeCompare(b.mspId)
      : a.endpoint.localeCompare(b.endpoint),
  )[0]?.endpoint;
}

function uniquePeerEndpoints(
  peers: string[],
  normalize: (peer: string) => string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const peer of peers) {
    const canonical = normalize(peer);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function copyTransientData(
  input: Record<string, Buffer>,
): Record<string, Buffer> {
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
