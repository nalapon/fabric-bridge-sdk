import { Result } from 'better-result';
import { ConfigurationError } from './errors/index';
import type { BridgeResult, BridgeTransaction, PeerSelectionPolicy, SinglePeerOptions } from './types/bridge';

const VALID_POLICIES = new Set<PeerSelectionPolicy>(['round-robin', 'random']);

type TargetingState =
  | { kind: 'gateway-default' }
  | { kind: 'single-peer'; options: SinglePeerOptions }
  | { kind: 'endorsing-peers'; peerNames: string[] };

export class TransactionTargeting {
  private constructor(private readonly state: TargetingState) {}

  static gatewayDefault(): TransactionTargeting {
    return new TransactionTargeting({ kind: 'gateway-default' });
  }

  static singlePeer(options: SinglePeerOptions = {}): BridgeResult<TransactionTargeting> {
    if (options.policy !== undefined && !VALID_POLICIES.has(options.policy)) {
      return Result.err(new ConfigurationError({
        field: 'singlePeer.policy',
        message: `unsupported peer selection policy: ${String(options.policy)}`,
      }));
    }

    return Result.ok(new TransactionTargeting({
      kind: 'single-peer',
      options: {
        failover: true,
        ...options,
        candidates: options.candidates?.length ? [...options.candidates] : undefined,
      },
    }));
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

  singlePeerOptions(): SinglePeerOptions | null {
    return this.state.kind === 'single-peer' ? this.state.options : null;
  }

  endorsingPeerNames(): string[] {
    return this.state.kind === 'endorsing-peers' ? [...this.state.peerNames] : [];
  }

  applyToPeerTransaction(transaction: BridgeTransaction): BridgeResult<BridgeTransaction> {
    if (this.state.kind === 'single-peer') {
      return transaction.UseSinglePeer(this.state.options);
    }
    if (this.state.kind === 'endorsing-peers') {
      return transaction.UseEndorsingPeers(this.state.peerNames);
    }
    return Result.ok(transaction);
  }
}
