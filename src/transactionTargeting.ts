import { Result } from 'better-result';
import { ConfigurationError } from './errors/index';
import type { BridgeResult, BridgeTransaction } from './types/bridge';

type TargetingState =
  | { kind: 'gateway-default' }
  | { kind: 'single-peer' }
  | { kind: 'endorsing-peers'; peerNames: string[] };

export class TransactionTargeting {
  private constructor(private readonly state: TargetingState) {}

  static gatewayDefault(): TransactionTargeting {
    return new TransactionTargeting({ kind: 'gateway-default' });
  }

  static singlePeer(): BridgeResult<TransactionTargeting> {
    return Result.ok(new TransactionTargeting({ kind: 'single-peer' }));
  }

  static endorsingPeers(peerNames: string[]): BridgeResult<TransactionTargeting> {
    if (peerNames.length === 0) {
      return Result.err(new ConfigurationError({
        field: 'endorsingPeers',
        message: 'UseEndorsingPeers requires at least one peer',
      }));
    }

    return Result.ok(new TransactionTargeting({
      kind: 'endorsing-peers',
      peerNames: [...peerNames],
    }));
  }

  requiresPeerMode(): boolean {
    return this.state.kind !== 'gateway-default';
  }

  isSinglePeer(): boolean {
    return this.state.kind === 'single-peer';
  }

  endorsingPeerNames(): string[] {
    return this.state.kind === 'endorsing-peers' ? [...this.state.peerNames] : [];
  }

  applyToPeerTransaction(transaction: BridgeTransaction): BridgeResult<BridgeTransaction> {
    if (this.state.kind === 'single-peer') {
      return transaction.UseSinglePeer();
    }
    if (this.state.kind === 'endorsing-peers') {
      return transaction.UseEndorsingPeers(...this.state.peerNames);
    }
    return Result.ok(transaction);
  }
}
