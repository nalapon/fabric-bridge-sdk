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
import { log } from "../utils/logger";

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
    log().debug('PeerNetwork constructor - Received:');
    log().debug('  - gateway type:', typeof gateway, 'constructor:', gateway?.constructor?.name);
    log().debug('  - gateway methods:', Object.keys(gateway || {}));
    log().debug('  - channelName:', channelName);
    log().debug('  - config.gatewayPeer:', config.gatewayPeer);
    log().debug('  - config.identity.mspId:', config.identity.mspId);
    log().debug('  - timeouts:', { ...DEFAULT_TIMEOUTS, ...config.timeouts });
    
    this.gateway = gateway;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    
    log().debug('PeerNetwork constructor - Calling gateway.getNetwork():');
    this.networkPromise = this.gateway.getNetwork(channelName);
    log().debug('  - networkPromise created:', typeof this.networkPromise);
  }

  async getContract(
    chaincodeName: string,
  ): Promise<BridgeContract> {
    log().debug('PeerNetwork.getContract() - Input:');
    log().debug('  - chaincodeName:', chaincodeName);
    log().debug('  - chaincodeName type:', typeof chaincodeName);
    log().debug('  - chaincodeName length:', chaincodeName?.length);
    log().debug('  - Awaiting networkPromise...');
    
    const network = await this.networkPromise!;
    log().debug('  - network received:', typeof network, 'constructor:', network?.constructor?.name);
    log().debug('  - network methods:', Object.keys(network || {}));
    
    log().debug('  - Calling network.getContract() with:', chaincodeName);
    const contract = network.getContract(chaincodeName);
    log().debug('  - contract received:', typeof contract, 'constructor:', contract?.constructor?.name);
    log().debug('  - contract methods:', Object.keys(contract || {}));
    
    // Inspect ContractImpl properties - cast to any to access internal properties
    const contractAny = contract as any;
    log().debug('=== ContractImpl INSPECTION ===');
    log().debug('ContractImpl.chaincodeId:', contractAny.chaincodeId);
    log().debug('ContractImpl.namespace:', contractAny.namespace);
    log().debug('ContractImpl.discoveryInterests:', JSON.stringify(contractAny.discoveryInterests));
    log().debug('ContractImpl.gateway:', typeof contractAny.gateway, contractAny.gateway?.constructor?.name);
    log().debug('ContractImpl.network:', typeof contractAny.network, contractAny.network?.constructor?.name);
    log().debug('ContractImpl.contractListeners:', contractAny.contractListeners);
    
    // Try to get all properties
    const contractProps = Object.getOwnPropertyNames(contractAny);
    log().debug('ContractImpl all properties:', contractProps);
    
    // Check if it has _chaincodeId or private properties
    const allProps = Object.keys(contractAny);
    log().debug('ContractImpl Object.keys:', allProps);
    
    // Inspect prototype
    const proto = Object.getPrototypeOf(contractAny);
    log().debug('ContractImpl prototype:', proto?.constructor?.name);
    log().debug('ContractImpl prototype methods:', Object.getOwnPropertyNames(proto || {}));
    log().debug('=== ContractImpl INSPECTION END ===');
    
    return new PeerContract(
      contract as any,
      chaincodeName,
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
    log().debug('PeerContract constructor - Received:');
    log().debug('  - contract type:', typeof contract, 'constructor:', contract?.constructor?.name);
    log().debug('  - contract methods:', Object.keys(contract || {}));
    log().debug('  - chaincodeName:', chaincodeName);
    log().debug('  - chaincodeName type:', typeof chaincodeName);
    log().debug('  - chaincodeName length:', chaincodeName?.length);
    log().debug('  - chaincodeName empty:', chaincodeName === '');
    log().debug('  - timeouts:', timeouts);
    log().debug('  - channelName:', channelName);
    
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
    
    log().debug('PeerContract constructor - Instance created successfully');
  }

  getChaincodeName(): string {
    return this.chaincodeName;
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
    log().debug('PeerContract.createTransaction() - Called with:');
    log().debug('  - name:', name);
    log().debug('  - this.chaincodeName:', this.chaincodeName);
    log().debug('  - this.contract type:', typeof this.contract, 'constructor:', this.contract?.constructor?.name);
    log().debug('  - this.contract methods:', Object.keys(this.contract || {}));
    
    log().debug('PeerContract.createTransaction() - Creating PeerTransaction with:');
    log().debug('  - name:', name);
    log().debug('  - chaincodeName:', this.chaincodeName);
    log().debug('  - contract:', typeof this.contract);
    
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
    contract: fabricNetwork.Contract,
    timeouts: Required<TimeoutConfig>,
    peerConnection: PeerConnection,
    discoveryCache: DiscoveryCache,
    channelName: string,
  ) {
    log().debug('PeerTransaction constructor - Received:');
    log().debug('  - name:', name);
    log().debug('  - name type:', typeof name);
    log().debug('  - name length:', name?.length);
    log().debug('  - chaincodeName:', chaincodeName);
    log().debug('  - chaincodeName type:', typeof chaincodeName);
    log().debug('  - chaincodeName length:', chaincodeName?.length);
    log().debug('  - contract type:', typeof contract, 'constructor:', contract?.constructor?.name);
    log().debug('  - contract methods:', Object.keys(contract || {}));
    log().debug('  - channelName:', channelName);
    
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contract = contract;
    this.timeouts = timeouts;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
    
    log().debug('PeerTransaction constructor - Instance created');
  }

  getName(): string {
    return this.name;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
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
    log().debug('=== PeerTransaction.submit() START ===');
    log().debug('PeerTransaction.submit() - Instance data:');
    log().debug('  - this.name:', this.name);
    log().debug('  - this.name type:', typeof this.name);
    log().debug('  - this.chaincodeName:', this.chaincodeName);
    log().debug('  - this.chaincodeName type:', typeof this.chaincodeName);
    log().debug('  - this.contract:', typeof this.contract, 'constructor:', this.contract?.constructor?.name);
    log().debug('  - this.contract methods:', Object.keys(this.contract || {}));
    log().debug('  - args:', args);
    
    const stringArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg),
    );

    try {
      // Create transaction
      log().debug('PeerTransaction.submit() - About to call contract.createTransaction():');
      log().debug('  - Calling object:', typeof this.contract);
      log().debug('  - Calling method: createTransaction');
      log().debug('  - With argument:', this.name);
      log().debug('  - Argument type:', typeof this.name);
      
      // Inspect this.contract in detail
      const contractAny = this.contract as any;
      log().debug('=== this.contract INSPECTION ===');
      log().debug('  - chaincodeId:', contractAny.chaincodeId);
      log().debug('  - namespace:', contractAny.namespace);
      log().debug('  - discoveryInterests:', JSON.stringify(contractAny.discoveryInterests));
      log().debug('  - gateway:', typeof contractAny.gateway);
      log().debug('  - network:', typeof contractAny.network);
      log().debug('  - contractListeners:', contractAny.contractListeners);
      log().debug('=== this.contract INSPECTION END ===');
      
      const transaction = this.contract.createTransaction(this.name);
      
      log().debug('  - transaction returned:', typeof transaction, 'constructor:', transaction?.constructor?.name);
      log().debug('  - transaction methods:', Object.keys(transaction || {}));
      
      // Inspect Transaction object
      const txAny = transaction as any;
      log().debug('=== Transaction INSPECTION ===');
      log().debug('  - transaction.name:', txAny.name);
      log().debug('  - transaction.contract:', typeof txAny.contract, txAny.contract?.constructor?.name);
      log().debug('  - transaction.gatewayOptions:', JSON.stringify(txAny.gatewayOptions));
      log().debug('  - transaction.identityContext:', typeof txAny.identityContext);
      log().debug('=== Transaction INSPECTION END ===');

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
      log().debug('PeerTransaction.submit() - About to call transaction.submit():');
      log().debug('  - stringArgs:', stringArgs);
      
      const result = await transaction.submit(...stringArgs);
      
      log().debug('PeerTransaction.submit() - transaction.submit() returned:', typeof result);
      log().debug('  - result length:', result?.length);
      log().debug('=== PeerTransaction.submit() END ===');

      return Result.ok(
        new PeerSubmittedTx(
          result,
          transaction.getTransactionId(),
          this.timeouts,
        ),
      );
    } catch (error) {
      log().debug('PeerTransaction.submit() - ERROR:', (error as Error).message);
      log().debug('=== PeerTransaction.submit() END WITH ERROR ===');
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
