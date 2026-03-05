import * as fabricGateway from '@hyperledger/fabric-gateway';
import { Result } from 'better-result';
import type {
  BridgeContract,
  BridgeNetwork,
  BridgeTransaction,
  BridgeResult,
  BridgeSubmittedTx,
  CommitStatus,
} from '../types/bridge';
import type { BridgeConfig, TimeoutConfig } from '../types/config';
import {
  EndorsementError,
  SubmitError,
  CommitError,
  EvaluationError,
  TimeoutError,
} from '../errors/index';
import { DEFAULT_TIMEOUTS } from '../types/config';

export class GatewayNetwork implements BridgeNetwork {
  private gateway: fabricGateway.Gateway;
  private channelName: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(gateway: fabricGateway.Gateway, channelName: string, config: BridgeConfig) {
    this.gateway = gateway;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  }

  getContract(chaincodeName: string, contractName?: string): BridgeContract {
    const network = this.gateway.getNetwork(this.channelName);
    const contract = network.getContract(chaincodeName, contractName);
    return new GatewayContract(contract, chaincodeName, contractName ?? '', this.timeouts);
  }
}

class GatewayContract implements BridgeContract {
  private contract: fabricGateway.Contract;
  private chaincodeName: string;
  private contractName: string;
  private timeouts: Required<TimeoutConfig>;

  constructor(
    contract: fabricGateway.Contract,
    chaincodeName: string,
    contractName: string,
    timeouts: Required<TimeoutConfig>
  ) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.timeouts = timeouts;
  }

  getChaincodeName(): string {
    return this.chaincodeName;
  }

  getContractName(): string {
    return this.contractName;
  }

  async submitTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = args.map((arg) => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    );

    try {
      const result = await this.contract.submitTransaction(name, ...stringArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(this.mapError(error as Error, 'submit'));
    }
  }

  async evaluateTransaction(name: string, ...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = args.map((arg) => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    );

    try {
      const result = await this.contract.evaluateTransaction(name, ...stringArgs);
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(this.mapError(error as Error, 'evaluate'));
    }
  }

  createTransaction(name: string): BridgeTransaction {
    return new GatewayTransaction(
      name,
      this.chaincodeName,
      this.contractName,
      this.contract,
      this.timeouts
    );
  }

  private mapError(error: Error, operation: 'submit' | 'evaluate'): EndorsementError | SubmitError | EvaluationError | TimeoutError {
    // Extract detailed error information if available
    const errorDetails = (error as any).details || [];
    const detailMessages = errorDetails.map((d: any) => `${d.message} (${d.endpoint || 'unknown endpoint'})`).join('; ');
    const fullMessage = detailMessages ? `${error.message}: ${detailMessages}` : error.message;
    
    if (error.message?.includes('timeout') || error.message?.includes('TIMEOUT')) {
      const timeoutValue = operation === 'submit' ? this.timeouts.endorse : this.timeouts[operation];
      return new TimeoutError({
        message: fullMessage,
        operation,
        timeout: timeoutValue,
      });
    }
    
    if (operation === 'submit') {
      return new EndorsementError({
        message: fullMessage,
        details: errorDetails,
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
  private contractName: string;
  private contract: fabricGateway.Contract;
  private timeouts: Required<TimeoutConfig>;
  private transientData: Record<string, Buffer> = {};

  constructor(
    name: string,
    chaincodeName: string,
    contractName: string,
    contract: fabricGateway.Contract,
    timeouts: Required<TimeoutConfig>
  ) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contractName = contractName;
    this.contract = contract;
    this.timeouts = timeouts;
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

  setEndorsingPeers(_peerNames: string[]): BridgeTransaction {
    throw new Error(
      'setEndorsingPeers() is not supported in gateway mode. ' +
      'Use FabricBridge with discovery enabled for peer-targeted transactions.'
    );
  }

  setTransientData(transientData: Record<string, Buffer>): BridgeTransaction {
    this.transientData = transientData;
    return this;
  }

  async submit(...args: unknown[]): Promise<BridgeResult<BridgeSubmittedTx>> {
    const stringArgs = args.map((arg) => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    );

    try {
      const proposal = this.contract.newProposal(this.name, {
        arguments: stringArgs,
        transientData: this.transientData,
      });

      const transaction = await proposal.endorse();
      const submitted = await transaction.submit();

      return Result.ok(new GatewaySubmittedTx(transaction, submitted, this.timeouts));
    } catch (error) {
      return Result.err(new EndorsementError({
        message: (error as Error).message,
      }));
    }
  }

  async evaluate(...args: unknown[]): Promise<BridgeResult<Buffer>> {
    const stringArgs = args.map((arg) => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    );

    try {
      const proposal = this.contract.newProposal(this.name, {
        arguments: stringArgs,
        transientData: this.transientData,
      });

      const result = await proposal.evaluate();
      return Result.ok(Buffer.from(result));
    } catch (error) {
      return Result.err(new EvaluationError({
        message: (error as Error).message,
      }));
    }
  }
}

class GatewaySubmittedTx implements BridgeSubmittedTx {
  private transaction: fabricGateway.Transaction;
  private submitted: fabricGateway.SubmittedTransaction;
  private timeouts: Required<TimeoutConfig>;

  constructor(
    transaction: fabricGateway.Transaction,
    submitted: fabricGateway.SubmittedTransaction,
    timeouts: Required<TimeoutConfig>
  ) {
    this.transaction = transaction;
    this.submitted = submitted;
    this.timeouts = timeouts;
  }

  getResult(): Buffer {
    return Buffer.from(this.transaction.getResult());
  }

  async getStatus(): Promise<BridgeResult<CommitStatus>> {
    try {
      const status = await this.submitted.getStatus();

      return Result.ok({
        blockNumber: status.blockNumber,
        status: status.code === 0 ? 'VALID' : 'INVALID',
        transactionId: '',
      });
    } catch (error) {
      return Result.err(new CommitError({
        message: (error as Error).message,
        transactionId: '',
      }));
    }
  }
}
