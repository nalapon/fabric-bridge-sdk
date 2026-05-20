import * as fabricNetwork from "fabric-network";
import { Result } from "better-result";
import {
  asBuffer,
  getTransactionResponse,
} from "fabric-network/lib/impl/gatewayutils.js";
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
  OfflineSigningRouting,
  SignedMessage,
  SigningRequest,
  SinglePeerOptions,
  ProposalCreator,
} from "../types/bridge";
import type { BridgeConfig, TimeoutConfig } from "../types/config";
import type { DiscoveryResult, PeerInfo } from "../types/discovery";
import {
  CommitError,
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
import {
  normalizePeerEndpointIdentity,
  PeerConnection,
} from "./PeerConnection";
import { DiscoveryCache } from "../cache/DiscoveryCache";
import { log } from "../utils/logger";
import { selectSinglePeers } from "./peerSelection";
import type { FailoverDecision } from "../types/failover";
import { classifyFailover } from "./failoverEligibility";
import { TransactionTargeting } from "../transactionTargeting";
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
import { createProposalIdentityContext } from "../fabricIdentity";

import fabproto6 from "fabric-protos";

type NormalizedArg = string | Buffer;

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

export async function NewPeerSignedProposal(
  gateway: fabricNetwork.Gateway,
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
    !!config.tlsOptions?.trustedRoots,
  );
  if (!routingPeers.isOk()) {
    return Result.err(routingPeers.error);
  }
  const routing = { ...decoded.value.routing, peers: routingPeers.value };

  try {
    const proposal = fabproto6.protos.Proposal.decode(decoded.value.bytes);
    const header = fabproto6.common.Header.decode(proposal.header);
    const channelHeader = fabproto6.common.ChannelHeader.decode(
      header.channel_header,
    );
    const channelName = channelHeader.channel_id;
    const network = await gateway.getNetwork(channelName);
    return Result.ok(
      new PeerSignedProposal(
        network,
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
      this.contract,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
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
  private targeting = TransactionTargeting.gatewayDefault();
  private transientData: Record<string, Buffer> = {};
  private proposalCreator?: ProposalCreator;

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

  UseSinglePeer(
    options: SinglePeerOptions = {},
  ): BridgeResult<BridgeTransaction> {
    const targeting = TransactionTargeting.singlePeer(options);
    if (!targeting.isOk()) {
      return Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result.ok(this);
  }

  UseEndorsingPeers(peerNames: string[]): BridgeResult<BridgeTransaction> {
    const targeting = TransactionTargeting.endorsingPeers(peerNames);
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
          : await this.submitAsyncInternal(
              await this.createPreparedTransaction(),
              normalizedArgs,
            );
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
        : await (
            await this.createPreparedTransaction()
          ).evaluate(...(normalizedArgs as string[]));
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
        const selected = (await this.resolveSinglePeerEndorsers())[0];
        if (!selected) {
          throw new PeerNotFoundError({
            peerName: "<single-peer>",
            availablePeers: [],
          });
        }
        const transaction = await this.createPreparedTransactionForPeers([
          selected.endorser,
        ]);
        return Result.ok(
          this.buildUnsignedProposal(transaction, normalizedArgs, {
            mode: "single-peer",
            peers: [selected.peerName],
          }),
        );
      }

      const endorsingPeerNames = this.targeting.endorsingPeerNames();
      const transaction = await this.createPreparedTransaction();
      const peers =
        endorsingPeerNames.length > 0
          ? await this.resolvedEndorsingPeerSnapshot(endorsingPeerNames)
          : [];
      const routing: OfflineSigningRouting =
        peers.length > 0
          ? { mode: "endorsing-peers", peers }
          : { mode: "gateway-default" };
      return Result.ok(
        this.buildUnsignedProposal(transaction, normalizedArgs, routing),
      );
    } catch (error) {
      return Result.err(this.mapSubmitError(error as Error));
    }
  }

  private buildUnsignedProposal(
    transaction: fabricNetwork.Transaction,
    stringArgs: NormalizedArg[],
    routing: OfflineSigningRouting,
  ): BridgeUnsignedProposal {
    const tx = transaction as any;
    const network = tx.contract.network;
    const channel = network.getChannel();
    const endorsement = channel.newEndorsement(this.chaincodeName);
    const proposalBuildRequest = tx.newBuildProposalRequest(stringArgs);
    const identityContext = createProposalIdentityContext(
      tx.identityContext,
      this.proposalCreator!,
    );
    const bytes = Buffer.from(
      endorsement.build(identityContext, proposalBuildRequest),
    );
    return new PeerUnsignedProposal(
      bytes,
      digestBytes(bytes),
      endorsement.getTransactionId(),
      routing,
    );
  }

  private async createPreparedTransaction(): Promise<fabricNetwork.Transaction> {
    const transaction = this.contract.createTransaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      transaction.setTransient(copyTransientData(this.transientData));
    }

    const endorsingPeerNames = this.targeting.endorsingPeerNames();
    if (endorsingPeerNames.length > 0) {
      const discoveryResult = await this.ensureDiscovery();
      if (!discoveryResult.isOk()) {
        throw discoveryResult.error;
      }

      const endorsingPeers = this.matchPeersToEndorsers(
        discoveryResult.value,
        endorsingPeerNames,
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

  private async createPreparedTransactionForPeers(
    peers: any[],
  ): Promise<fabricNetwork.Transaction> {
    const transaction = this.contract.createTransaction(this.name);

    if (Object.keys(this.transientData).length > 0) {
      transaction.setTransient(copyTransientData(this.transientData));
    }

    if (peers.length > 0) {
      transaction.setEndorsingPeers(peers);
    }

    return transaction;
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

  private async resolveSinglePeerEndorsers(): Promise<
    Array<{ peerName: string; endorser: any }>
  > {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }

    const selection = selectSinglePeers(
      discoveryResult.value,
      this.peerConnection,
      this.discoveryCache,
      this.targeting.singlePeerOptions() ?? undefined,
    );

    const endorsers = this.matchPeerInfosToEndorsers(
      discoveryResult.value,
      selection.orderedPeers,
    );
    if (!endorsers.isOk()) {
      throw endorsers.error;
    }

    return endorsers.value;
  }

  private async submitAsyncSinglePeer(stringArgs: NormalizedArg[]): Promise<{
    result: Buffer;
    transactionId: string;
    waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
  }> {
    return this.executeSinglePeer("submitAsync", async (selected) => {
      const transaction = await this.createPreparedTransactionForPeers([
        selected.endorser,
      ]);
      return this.submitAsyncInternal(transaction, stringArgs);
    });
  }

  private async evaluateSinglePeer(
    stringArgs: NormalizedArg[],
  ): Promise<Buffer> {
    return this.executeSinglePeer("evaluate", async (selected) => {
      const transaction = await this.createPreparedTransactionForPeers([
        selected.endorser,
      ]);
      return Buffer.from(
        await transaction.evaluate(...(stringArgs as string[])),
      );
    });
  }

  private async executeSinglePeer<T>(
    operation: "submitAsync" | "evaluate",
    execute: (selected: { peerName: string; endorser: any }) => Promise<T>,
  ): Promise<T> {
    const peers = await this.resolveSinglePeerEndorsers();
    const attempts: Array<{
      peer: string;
      cause: string;
      failover: FailoverDecision;
    }> = [];
    const failover = this.targeting.singlePeerOptions()?.failover ?? true;
    const peersToTry = failover ? peers : peers.slice(0, 1);

    for (let index = 0; index < peersToTry.length; index += 1) {
      const selected = peersToTry[index]!;
      try {
        return await execute(selected);
      } catch (error) {
        const decision = classifyFailover(error);
        attempts.push({
          peer: selected.peerName,
          cause: error instanceof Error ? error.message : String(error),
          failover: decision,
        });
        if (!decision.eligible) {
          throw error;
        }
        if (!failover || index === peersToTry.length - 1) {
          throw this.singlePeerExecutionError(operation, peers, attempts);
        }

        const next = peersToTry[index + 1]!;
        log().warn("fabric_bridge.single_peer.failover", {
          event: "fabric_bridge.single_peer.failover",
          operation,
          channel: this.channelName,
          chaincode: this.chaincodeName,
          transaction: this.name,
          failedPeer: selected.peerName,
          nextPeer: next.peerName,
          attempt: index + 1,
          maxAttempts: peersToTry.length,
          reason: decision.reason,
          category: decision.category,
        });
      }
    }

    throw this.singlePeerExecutionError(operation, peers, attempts);
  }

  private async submitAsyncInternal(
    transaction: fabricNetwork.Transaction,
    stringArgs: NormalizedArg[],
  ): Promise<{
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
      proposalSendRequest.requestTimeout =
        (transactionOptions.endorseTimeout as number) * 1000;
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
    const commitWaiter = await this.createCommitWaiter(
      network,
      peers,
      transactionId,
    );

    try {
      const commit = endorsement.newCommit();
      commit.build(tx.identityContext);
      commit.sign(tx.identityContext);

      const commitSendRequest: Record<string, unknown> = {};
      if (Number.isInteger(transactionOptions.commitTimeout)) {
        commitSendRequest.requestTimeout =
          (transactionOptions.commitTimeout as number) * 1000;
      }

      if (proposalSendRequest.handler) {
        commitSendRequest.handler = proposalSendRequest.handler;
      } else {
        commitSendRequest.targets = channel.getCommitters();
      }

      const commitResponse = await commit.send(commitSendRequest);
      if (commitResponse.status !== "SUCCESS") {
        const message = `Failed to commit transaction ${transactionId}, orderer response status: ${commitResponse.status}`;
        commitWaiter.fail(
          new SubmitError({
            message,
            transactionId,
          }),
        );
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
        rejectPromise?.(
          new CommitError({
            message: error.message,
            transactionId,
          }),
        );
        return;
      }

      if (!event) {
        rejectPromise?.(
          new CommitError({
            message: "Missing commit event",
            transactionId,
          }),
        );
        return;
      }

      const blockEvent = event.getBlockEvent();
      const status: CommitStatus = {
        blockNumber: BigInt(blockEvent.blockNumber.toString()),
        status: event.isValid ? "VALID" : "INVALID",
        transactionId,
      };

      if (!event.isValid) {
        rejectPromise?.(
          new CommitError({
            message: "transaction committed with invalid validation code",
            transactionId,
            status: "INVALID",
          }),
        );
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
      rejectPromise?.(
        new TimeoutError({
          message: `Commit event listener timeout for transaction ${transactionId}`,
          operation: "commit",
          timeout: this.timeouts.commit,
        }),
      );
    }, this.timeouts.commit);

    return {
      waitForCommit: async () =>
        Result.tryPromise({
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

  private matchPeersToEndorsers(
    discovery: DiscoveryResult,
    peerNames: string[],
  ): Result<any[], PeerNotFoundError | ConfigurationError> {
    const endorsers: any[] = [];
    const availablePeers = Array.from(discovery.peers.keys());
    const network = (this.contract as any).network;
    const channel = network?.getChannel?.() || (network as any)?.channel;

    if (!channel) {
      return Result.err(
        new PeerNotFoundError({
          peerName: peerNames.join(", "),
          availablePeers,
        }),
      );
    }

    const peerInfos = this.resolvePeerInfos(discovery, peerNames);
    if (!peerInfos.isOk()) {
      return Result.err(peerInfos.error);
    }
    const notFound: string[] = [];
    for (const peerInfo of peerInfos.value) {
      const endorser = channel.getEndorser?.(peerInfo.endpoint);
      if (endorser) {
        endorsers.push(endorser);
        continue;
      }

      const allEndorsers = channel.getEndorsers?.() || [];
      const matched = allEndorsers.find(
        (candidate: { name?: string }) => candidate.name === peerInfo.endpoint,
      );
      if (matched) {
        endorsers.push(matched);
      } else {
        notFound.push(peerInfo.endpoint);
      }
    }

    if (notFound.length > 0) {
      return Result.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers,
        }),
      );
    }

    return Result.ok(endorsers);
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

  private matchPeerInfosToEndorsers(
    discovery: DiscoveryResult,
    peers: Array<{ name: string; endpoint: string }>,
  ): Result<Array<{ peerName: string; endorser: any }>, PeerNotFoundError> {
    const endorsers: Array<{ peerName: string; endorser: any }> = [];
    const notFound: string[] = [];
    const availablePeers = Array.from(discovery.peers.keys());
    const network = (this.contract as any).network;
    const channel = network?.getChannel?.() || (network as any)?.channel;

    if (!channel) {
      return Result.err(
        new PeerNotFoundError({
          peerName: peers.map((peer) => peer.name).join(", "),
          availablePeers,
        }),
      );
    }

    const allEndorsers = channel.getEndorsers?.() || [];
    for (const peer of peers) {
      const endpointWithoutScheme = stripGrpcScheme(peer.endpoint);
      const endorser =
        channel.getEndorser?.(peer.endpoint) ??
        channel.getEndorser?.(endpointWithoutScheme) ??
        allEndorsers.find(
          (candidate: { name?: string; endpoint?: string }) =>
            candidate.name === peer.endpoint ||
            candidate.name === endpointWithoutScheme ||
            candidate.endpoint === peer.endpoint ||
            candidate.endpoint === endpointWithoutScheme,
        );
      if (endorser) {
        endorsers.push({ peerName: peer.endpoint, endorser });
      } else {
        notFound.push(peer.endpoint);
      }
    }

    if (notFound.length > 0) {
      return Result.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers,
        }),
      );
    }

    return Result.ok(endorsers);
  }

  private singlePeerExecutionError(
    operation: string,
    eligiblePeers: Array<{ peerName: string }>,
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
      candidates: this.targeting.singlePeerOptions()?.candidates,
      eligiblePeers: eligiblePeers.map((peer) => peer.peerName),
      attempts,
    });
  }

  private getResponsePayload(proposalResponse: any): Buffer {
    const validEndorsementResponse = proposalResponse.responses.find(
      (endorsementResponse: { endorsement?: unknown }) =>
        endorsementResponse.endorsement,
    );

    if (!validEndorsementResponse) {
      const errorInfos: string[] = [];

      for (const error of proposalResponse.errors ?? []) {
        errorInfos.push(
          `peer=${error?.connection?.name ?? "unknown"}, status=grpc, message=${error?.message ?? "unknown error"}`,
        );
      }

      for (const response of proposalResponse.responses ?? []) {
        errorInfos.push(
          `peer=${response?.connection?.name ?? "unknown"}, status=${response?.response?.status ?? "unknown"}, message=${response?.response?.message ?? "unknown error"}`,
        );
      }

      throw new EndorsementError({
        message:
          errorInfos.length > 0
            ? `No valid responses from any peers. Errors:\n    ${errorInfos.join("\n    ")}`
            : "No valid responses from any peers",
      });
    }

    const payload = getTransactionResponse(validEndorsementResponse).payload;
    return asBuffer(payload);
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

  private mapCommitError(
    error: Error,
    transactionId: string,
  ): CommitError | TimeoutError {
    if (error instanceof CommitError || error instanceof TimeoutError) {
      return error;
    }

    if (
      error.message?.includes("timeout") ||
      error.message?.includes("Timeout") ||
      error.message?.includes("TIMEOUT")
    ) {
      return new TimeoutError({
        message: error.message,
        operation: "commit",
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
  private network: any;
  private channelName: string;
  private config: BridgeConfig;
  private timeouts: Required<TimeoutConfig>;
  private bytes: Buffer;
  private signature: Buffer;
  private routing: Exclude<OfflineSigningRouting, { mode: "gateway-default" }>;
  private transactionId: string;
  private chaincodeName: string;
  private proposal: any;
  private header: any;

  constructor(
    network: fabricNetwork.Network,
    channelName: string,
    config: BridgeConfig,
    bytes: Buffer,
    signature: Buffer,
    routing: Exclude<OfflineSigningRouting, { mode: "gateway-default" }>,
  ) {
    this.network = network as any;
    this.channelName = channelName;
    this.config = config;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.bytes = Buffer.from(bytes);
    this.signature = Buffer.from(signature);
    this.routing = {
      mode: routing.mode,
      peers: uniqueCanonicalPeerEndpoints(
        routing.peers,
        !!config.tlsOptions?.trustedRoots,
      ),
    };
    this.proposal = fabproto6.protos.Proposal.decode(this.bytes);
    this.header = fabproto6.common.Header.decode(this.proposal.header);
    const channelHeader = fabproto6.common.ChannelHeader.decode(
      this.header.channel_header,
    );
    const extension = fabproto6.protos.ChaincodeHeaderExtension.decode(
      channelHeader.extension,
    );
    this.transactionId = channelHeader.tx_id;
    this.chaincodeName = extension.chaincode_id?.name ?? "";
  }

  TransactionID(): string {
    return this.transactionId;
  }
  async Endorse(): Promise<BridgeResult<BridgeEndorsedTransaction>> {
    try {
      const proposalResponse = await this.sendProposal();
      const payload = getPeerProposalPayload(proposalResponse);
      const txPayload = this.buildTransactionPayload(
        proposalResponse.responses,
      );
      return Result.ok(
        new PeerEndorsedTransaction(
          this.network,
          this.config,
          this.timeouts,
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

  private async sendProposal(): Promise<any> {
    const channel = this.network.getChannel();
    const endorsement = channel.newEndorsement(this.chaincodeName);
    endorsement._reset();
    endorsement._payload = this.bytes;
    endorsement._signature = this.signature;
    endorsement._action.proposal = this.proposal;
    endorsement._action.header = this.header;
    endorsement._action.transactionId = this.transactionId;

    const targets = await this.resolveEndorsers(channel);
    const proposalResponse = await endorsement.send({ targets });
    endorsement._proposalResponses = proposalResponse.responses;
    endorsement._proposalErrors = proposalResponse.errors;
    return proposalResponse;
  }

  private async resolveEndorsers(channel: any): Promise<any[]> {
    const discovery = await discoveredPeerEndpoints(
      this.network,
      this.channelName,
      !!this.config.tlsOptions?.trustedRoots,
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

    const allEndorsers = channel.getEndorsers?.() ?? [];
    const targets = this.routing.peers
      .map((endpoint) => {
        const endorserName = stripGrpcScheme(endpoint);
        return (
          channel.getEndorser?.(endpoint) ??
          channel.getEndorser?.(endorserName) ??
          allEndorsers.find(
            (candidate: { name?: string }) =>
              candidate.name === endpoint || candidate.name === endorserName,
          )
        );
      })
      .filter(Boolean);

    if (targets.length !== this.routing.peers.length) {
      throw new PeerNotFoundError({
        peerName: this.routing.peers.join(", "),
        availablePeers: allEndorsers.map(
          (endorser: { name?: string }) => endorser.name ?? "<unknown>",
        ),
      });
    }
    return targets;
  }

  private buildTransactionPayload(proposalResponses: any[]): Buffer {
    const validResponses = proposalResponses.filter(
      (response) => response?.endorsement,
    );
    if (validResponses.length === 0) {
      throw new EndorsementError({ message: "No valid endorsements found" });
    }

    const endorsements = validResponses.map((response) => response.endorsement);
    const proposalResponse = validResponses[0];
    const chaincodeEndorsedAction =
      fabproto6.protos.ChaincodeEndorsedAction.create({
        proposal_response_payload: proposalResponse.payload,
        endorsements,
      });
    const originalProposalPayload =
      fabproto6.protos.ChaincodeProposalPayload.decode(this.proposal.payload);
    const proposalPayloadNoTransient =
      fabproto6.protos.ChaincodeProposalPayload.create({
        input: originalProposalPayload.input,
      });
    const proposalPayloadNoTransientBytes =
      fabproto6.protos.ChaincodeProposalPayload.encode(
        proposalPayloadNoTransient,
      ).finish();
    const actionPayload = fabproto6.protos.ChaincodeActionPayload.create({
      action: chaincodeEndorsedAction,
      chaincode_proposal_payload: proposalPayloadNoTransientBytes,
    });
    const actionPayloadBytes =
      fabproto6.protos.ChaincodeActionPayload.encode(actionPayload).finish();
    const transactionAction = fabproto6.protos.TransactionAction.create({
      header: this.header.signature_header,
      payload: actionPayloadBytes,
    });
    const transaction = fabproto6.protos.Transaction.create({
      actions: [transactionAction],
    });
    const transactionBytes =
      fabproto6.protos.Transaction.encode(transaction).finish();
    const payload = fabproto6.common.Payload.create({
      header: this.header,
      data: transactionBytes,
    });
    return Buffer.from(fabproto6.common.Payload.encode(payload).finish());
  }
}

class PeerEndorsedTransaction implements BridgeEndorsedTransaction {
  private network: any;
  private config: BridgeConfig;
  private timeouts: Required<TimeoutConfig>;
  private bytes: Buffer;
  private result: Buffer;
  private transactionId: string;

  constructor(
    network: fabricNetwork.Network,
    config: BridgeConfig,
    timeouts: Required<TimeoutConfig>,
    bytes: Buffer,
    result: Buffer,
    transactionId: string,
  ) {
    this.network = network as any;
    this.config = config;
    this.timeouts = timeouts;
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

  SigningRequest(): SigningRequest {
    return signingRequest(this.bytes, this.Digest());
  }

  WithSignature(
    signature: Buffer | Uint8Array | string,
  ): BridgeResult<SignedMessage> {
    return signedMessage(this.SigningRequest(), signature);
  }

  async SubmitAsync(): Promise<BridgeResult<BridgeSubmittedTx>> {
    return this.submitAsyncWithSignature(await this.config.signer(digestBytes(this.bytes)));
  }

  private async submitAsyncWithSignature(
    signature: Buffer | Uint8Array,
  ): Promise<BridgeResult<BridgeSubmittedTx>> {
    try {
      const channel = this.network.getChannel();
      const peers = channel.getEndorsers?.() ?? [];
      const commitWaiter = await createPeerCommitWaiter(
        this.network,
        peers,
        this.transactionId,
        this.timeouts.commit,
      );
      const commit = channel.newCommit("_offline");
      commit._reset();
      commit._payload = this.bytes;
      commit._signature = Buffer.from(signature);
      const response = await commit.send({ targets: channel.getCommitters() });
      if (response.status !== "SUCCESS") {
        throw new SubmitError({
          message: `Failed to commit transaction ${this.transactionId}, orderer response status: ${response.status}`,
          transactionId: this.transactionId,
        });
      }
      return Result.ok(
        new PeerSubmittedTx(
          this.result,
          this.transactionId,
          commitWaiter.waitForCommit,
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

  async Submit(): Promise<BridgeResult<BridgeCommitResult>> {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) return Result.err(submitted.error);
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) return Result.err(status.error);
    return Result.ok(new PeerCommitResult(submitted.value, status.value));
  }

  async SubmitWithSignature(
    signature: Buffer | Uint8Array | string,
  ): Promise<BridgeResult<BridgeCommitResult>> {
    const signed = this.WithSignature(signature);
    if (!signed.isOk()) return Result.err(signed.error);

    const decoded = decodeSignedMessage(signed.value);
    if (!decoded.isOk()) return Result.err(decoded.error);

    if (!decoded.value.digest.equals(this.Digest())) {
      return Result.err(
        new OfflineSigningError({
          field: "digest",
          message: "digest does not match transaction bytes",
        }),
      );
    }

    const submitted = await this.submitAsyncWithSignature(decoded.value.signature);
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

function getPeerProposalPayload(proposalResponse: any): Buffer {
  const valid = proposalResponse.responses?.find(
    (response: { endorsement?: unknown }) => response.endorsement,
  );
  if (!valid) {
    throw new EndorsementError({
      message: noValidPeerResponsesMessage(proposalResponse),
    });
  }
  return asBuffer(getTransactionResponse(valid).payload);
}

function noValidPeerResponsesMessage(proposalResponse: any): string {
  const errorInfos: string[] = [];

  for (const error of proposalResponse.errors ?? []) {
    errorInfos.push(
      `peer=${error?.connection?.name ?? "unknown"}, status=grpc, message=${error?.message ?? "unknown error"}`,
    );
  }

  for (const response of proposalResponse.responses ?? []) {
    errorInfos.push(
      `peer=${response?.connection?.name ?? "unknown"}, status=${response?.response?.status ?? "unknown"}, message=${response?.response?.message ?? "unknown error"}`,
    );
  }

  return errorInfos.length > 0
    ? `No valid responses from any peers. Errors:\n    ${errorInfos.join("\n    ")}`
    : "No valid responses from any peers";
}

async function createPeerCommitWaiter(
  network: any,
  peers: any[],
  transactionId: string,
  timeout: number,
): Promise<{
  waitForCommit: () => Promise<BridgeResult<CommitStatus>>;
}> {
  let settled = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let resolvePromise: ((status: CommitStatus) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const commitPromise = new Promise<CommitStatus>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = (listener: fabricNetwork.CommitListener) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      network.removeCommitListener(listener);
    } catch {}
  };
  const listener: fabricNetwork.CommitListener = (error, event) => {
    if (settled) return;
    settled = true;
    cleanup(listener);
    if (error) {
      rejectPromise?.(
        new CommitError({ message: error.message, transactionId }),
      );
      return;
    }
    if (!event) {
      rejectPromise?.(
        new CommitError({ message: "Missing commit event", transactionId }),
      );
      return;
    }
    const blockEvent = event.getBlockEvent();
    const status: CommitStatus = {
      blockNumber: BigInt(blockEvent.blockNumber.toString()),
      status: event.isValid ? "VALID" : "INVALID",
      transactionId,
    };
    if (!event.isValid) {
      rejectPromise?.(
        new CommitError({
          message: "transaction committed with invalid validation code",
          transactionId,
          status: "INVALID",
        }),
      );
      return;
    }
    resolvePromise?.(status);
  };
  await network.addCommitListener(listener, peers, transactionId);
  timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup(listener);
    rejectPromise?.(
      new TimeoutError({
        message: `Commit event listener timeout for transaction ${transactionId}`,
        operation: "commit",
        timeout,
      }),
    );
  }, timeout);
  return {
    waitForCommit: async () =>
      Result.tryPromise({
        try: async () => commitPromise,
        catch: (error) => error as CommitError | TimeoutError,
      }),
  };
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
  try {
    return Result.ok(uniqueCanonicalPeerEndpoints(peers, tlsEnabled));
  } catch (error) {
    return Result.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function discoveredPeerEndpoints(
  network: any,
  channelName: string,
  tlsEnabled: boolean,
): Promise<Set<string>> {
  const service = network.discoveryService;
  if (service?.getDiscoveryResults) {
    await service.getDiscoveryResults(true);
  }

  const results = service?.discoveryResults ?? {};
  const out = new Set<string>();
  for (const orgInfo of Object.values(results.peers_by_org ?? {})) {
    for (const peer of (orgInfo as { peers?: Array<{ endpoint?: string }> })
      .peers ?? []) {
      if (!peer.endpoint) {
        continue;
      }
      const endpoint = normalizePeerEndpointIdentity(peer.endpoint, tlsEnabled);
      if (out.has(endpoint)) {
        throw new DiscoveryError({
          message: `Discovery returned duplicate peer endpoint identity for channel ${channelName}: ${endpoint}`,
        });
      }
      out.add(endpoint);
    }
  }
  return out;
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

function stripGrpcScheme(endpoint: string): string {
  const lower = endpoint.toLowerCase();
  if (lower.startsWith("grpc://") || lower.startsWith("grpcs://")) {
    return endpoint.slice(endpoint.indexOf("://") + 3);
  }

  return endpoint;
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
