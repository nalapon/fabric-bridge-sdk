import type { DiscoveryResult, PeerInfo } from '../types/discovery';
import { PeerNotFoundError } from '../errors/index';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { Result } from 'better-result';

export interface SinglePeerSelection {
  orderedPeers: PeerInfo[];
}

export function selectSinglePeers(
  discovery: DiscoveryResult,
  discoveryCache: DiscoveryCache,
): SinglePeerSelection {
  const selected = selectSinglePeersResult(discovery, discoveryCache);
  if (!selected.isOk()) {
    throw selected.error;
  }
  return selected.value;
}

export function selectSinglePeersResult(
  discovery: DiscoveryResult,
  discoveryCache: DiscoveryCache,
): Result<SinglePeerSelection, PeerNotFoundError> {
  const eligible = Array.from(discovery.peers.values());

  if (eligible.length === 0) {
    return Result.err(
      new PeerNotFoundError({
        peerName: '<discovered peers>',
        availablePeers: Array.from(discovery.peers.keys()),
      }),
    );
  }

  const sorted = [...eligible].sort((a, b) => a.name.localeCompare(b.name));
  const orderedPeers = roundRobinOrder(sorted, discoveryCache, discovery.channelName);

  return Result.ok({
    orderedPeers,
  });
}

function roundRobinOrder(
  peers: PeerInfo[],
  discoveryCache: DiscoveryCache,
  channelName: string,
): PeerInfo[] {
  const key = `${channelName}:${peers.map((peer) => peer.endpoint).join('|')}`;
  const start = discoveryCache.nextRoundRobinIndex(key, peers.length);
  return peers.slice(start).concat(peers.slice(0, start));
}
