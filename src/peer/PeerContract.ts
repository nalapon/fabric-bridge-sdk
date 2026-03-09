import * as fabricNetwork from "fabric-network";
import { Result } from "better-result";
import type {
  BridgeContract,
  BridgeNetwork,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
  CommitStatus,
} from "../types/bridge";
import type { BridgeConfig, TimeoutConfig } from "../types/config";
import type { DiscoveryResult } from "../types/discovery";
import {
  EndorsementError,
  PeerNotFoundError,
  SubmitError,
  EvaluationError,
  TimeoutError,
  DiscoveryError,
} from "../errors/index";
import { DEFAULT_TIMEOUTS } from "../types/config";
import { PeerConnection } from "./PeerConnection";
import { DiscoveryCache } from "../cache/DiscoveryCache";

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

  async getContract(
    chaincodeName: string,
    contractName?: string,
  ): Promise<BridgeContract> {
    const network = await this.networkPromise!;
    const contract = network.getContract(chaincodeName, contractName);
    return new PeerContract(
      contract as any,
      chaincodeName,
      contractName ?? "",
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }
}

class PeerContract implements BridgeContract {
  private contract: fabricNetwork.Contract;
  private chaincodeName: string;
  private contractName: string;
  private timeouts: Required<TimeoutConfig>;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private channelName: string;

  constructor(
    contract: fabricNetwork.Contract,
    chaincodeName: string,
    contractName: string,
    timeouts: Required<TimeoutConfig>,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.timeouts = timeouts;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  getContractName(): string {
    return this.contractName;
  }

  async submitTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    // Uses fabric-network's default behavior (discovery or channel peers)
    const stringArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg),
    );

    try {
      const result = await this.contract.submitTransaction(name, ...stringArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(this.mapError(error as Error, "submit"));
    }
  }

  async evaluateTransaction(
    name: string,
    ...args: unknown[]
  ): Promise<BridgeResult<Buffer>> {
    const stringArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg),
    );

    try {
      const result = await this.contract.evaluateTransaction(
        name,
        ...stringArgs,
      );
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(this.mapError(error as Error, "evaluate"));
    }
  }

  createTransaction(name: string): BridgeTransaction {
    return new PeerTransaction(
      name,
      this.chaincodeName,
      this.contractName,
      this.contract,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName,
    );
  }

  private mapError(
    error: Error,
    operation: "submit" | "evaluate",
  ): EndorsementError | SubmitError | EvaluationError | TimeoutError {
    if (
      error.message?.includes("timeout") ||
      error.message?.includes("TIMEOUT")
    ) {
      const timeoutValue =
        operation === "submit"
          ? this.timeouts.endorse
          : this.timeouts[operation];
      return new TimeoutError({
        message: error.message,
        operation,
        timeout: timeoutValue,
      });
    }

    if (operation === "submit") {
      return new EndorsementError({
        message: error.message,
      });
    }

    if (operation === "evaluate") {
      return new EvaluationError({
        message: error.message,
      });
    }

    return new SubmitError({
      message: error.message,
    });
  }
}

class PeerTransaction implements BridgeTransaction {
  private name: string;
  private chaincodeName: string;
  private contractName: string;
  private contract: fabricNetwork.Contract;
  private timeouts: Required<TimeoutConfig>;
  private peerConnection: PeerConnection;
  private discoveryCache: DiscoveryCache;
  private channelName: string;
  private endorsingPeerNames: string[] = [];
  private transientData: Record<string, Buffer> = {};

  constructor(
    name: string,
    chaincodeName: string,
    contractName: string,
    contract: fabricNetwork.Contract,
    timeouts: Required<TimeoutConfig>,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
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

  getContractName(): string {
    return this.contractName;
  }

  setEndorsingPeers(peerNames: string[]): BridgeTransaction {
    this.endorsingPeerNames = peerNames;
    return this;
  }

  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = transientData;
    return this;
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    const stringArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg),
    );

    try {
      // Create transaction
      const transaction = this.contract.createTransaction(this.name);

      // Set transient data if provided
      if (Object.keys(this.transientData).length > 0) {
        transaction.setTransient(this.transientData);
      }

      // If specific endorsing peers are set, use peer-targeted mode
      if (this.endorsingPeerNames.length > 0) {
        // Ensure discovery is up to date
        const discoveryResult = await this.ensureDiscovery();
        if (!discoveryResult.isOk()) {
          return Result.err(discoveryResult.error);
        }

        const discovery = discoveryResult.value;

        // Match peer names to actual peer objects
        const endorsingPeers = this.matchPeersToEndorsers(
          discovery,
          this.endorsingPeerNames,
        );
        if (!endorsingPeers.isOk()) {
          return Result.err(endorsingPeers.error);
        }

        // Set endorsing peers on transaction
        if (endorsingPeers.value.length > 0) {
          transaction.setEndorsingPeers(endorsingPeers.value);
        }
      }

      // Submit transaction
      const result = await transaction.submit(...stringArgs);

      return Result.ok(
        new PeerSubmittedTx(
          result,
          transaction.getTransactionId(),
          this.timeouts,
        ),
      );
    } catch (error) {
      return Result.err(
        new EndorsementError({
          message: (error as Error).message,
        }),
      );
    }
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg),
    );

    try {
      // Create transaction
      const transaction = this.contract.createTransaction(this.name);

      // Set transient data if provided
      if (Object.keys(this.transientData).length > 0) {
        transaction.setTransient(this.transientData);
      }

      // Evaluate (query) - fabric-network handles peer selection for queries
      const result = await transaction.evaluate(...stringArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(
        new EvaluationError({
          message: (error as Error).message,
        }),
      );
    }
  }

  private async ensureDiscovery(): Promise<
    Result<DiscoveryResult, DiscoveryError>
  > {
    // Try to get from cache first
    let discovery = this.discoveryCache.get(this.channelName);

    if (discovery) {
      return Result.ok(discovery);
    }

    // Perform discovery
    const result = await this.peerConnection.discover(this.channelName);

    if (!result.isOk()) {
      return Result.err(result.error);
    }

    return Result.ok(result.value);
  }

  private matchPeersToEndorsers(
    discovery: DiscoveryResult,
    peerNames: string[],
  ): Result<any[], PeerNotFoundError> {
    const endorsers: any[] = [];
    const notFound: string[] = [];
    const availablePeers = Array.from(discovery.peers.keys());

    for (const peerName of peerNames) {
      const peerInfo = this.peerConnection.matchPeerByPartialName(
        discovery,
        peerName,
      );

      if (!peerInfo) {
        notFound.push(peerName);
        continue;
      }

      // Get endorser from fabric-network
      const network = (this.contract as any).network;
      const channel = network?.getChannel?.() || (network as any)?.channel;

      if (channel) {
        const endorser = channel.getEndorser?.(peerInfo.endpoint);
        if (endorser) {
          endorsers.push(endorser);
        } else {
          // Try to find by name
          const allEndorsers = channel.getEndorsers?.() || [];
          const matched = allEndorsers.find(
            (e: any) =>
              e.name?.includes(peerName) || peerName.includes(e.name || ""),
          );
          if (matched) {
            endorsers.push(matched);
          } else {
            notFound.push(peerName);
          }
        }
      } else {
        notFound.push(peerName);
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
}

class PeerSubmittedTx implements BridgeSubmittedTx {
  private result: Buffer;
  private transactionId: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(
    result: Buffer,
    transactionId: string,
    timeouts: Required<TimeoutConfig>,
  ) {
    this.result = result;
    this.transactionId = transactionId;
    this.timeouts = timeouts;
  }

  getResult(): Buffer {
    return this.result;
  }

  async getStatus(): Promise<BridgeResult<CommitStatus>> {
    // In fabric-network mode, we don't get a handle to check commit status
    // Return a mock status indicating the transaction was submitted
    return Result.ok({
      blockNumber: BigInt(0),
      status: "VALID",
      transactionId: this.transactionId,
    });
  }
}
