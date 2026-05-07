import type { SinglePeerOptions } from '../types/bridge';
import type { DiscoveryResult, PeerInfo } from '../types/discovery';
import { PeerNotFoundError } from '../errors/index';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { PeerConnection } from './PeerConnection';

export interface SinglePeerSelection {
  orderedPeers: PeerInfo[];
  candidates?: string[];
}

export function selectSinglePeers(
  discovery: DiscoveryResult,
  peerConnection: PeerConnection,
  discoveryCache: DiscoveryCache,
  options: SinglePeerOptions | undefined,
): SinglePeerSelection {
  const candidates = options?.candidates?.filter((candidate) => candidate.trim() !== '');
  const eligible = candidates && candidates.length > 0
    ? resolveCandidatePeers(discovery, peerConnection, candidates)
    : Array.from(discovery.peers.values());

  if (eligible.length === 0) {
    throw new PeerNotFoundError({
      peerName: candidates && candidates.length > 0 ? candidates.join(', ') : '<discovered peers>',
      availablePeers: Array.from(discovery.peers.keys()),
    });
  }

  const policy = options?.policy ?? 'round-robin';
  const sorted = [...eligible].sort((a, b) => a.name.localeCompare(b.name));
  const orderedPeers = policy === 'random'
    ? randomOrder(sorted)
    : roundRobinOrder(sorted, discoveryCache, discovery.channelName, candidates);

  return {
    orderedPeers,
    candidates,
  };
}

function resolveCandidatePeers(
  discovery: DiscoveryResult,
  peerConnection: PeerConnection,
  candidates: string[],
): PeerInfo[] {
  const resolved: PeerInfo[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const peer = peerConnection.matchPeerByPartialName(discovery, candidate);
    if (!peer) {
      missing.push(candidate);
      continue;
    }
    if (!seen.has(peer.endpoint)) {
      resolved.push(peer);
      seen.add(peer.endpoint);
    }
  }

  if (missing.length > 0) {
    throw new PeerNotFoundError({
      peerName: missing.join(', '),
      availablePeers: Array.from(discovery.peers.keys()),
    });
  }

  return resolved;
}

function roundRobinOrder(
  peers: PeerInfo[],
  discoveryCache: DiscoveryCache,
  channelName: string,
  candidates?: string[],
): PeerInfo[] {
  const key = `${channelName}:${peers.map((peer) => peer.endpoint).join('|')}:${candidates?.join('|') ?? '*'}`;
  const start = discoveryCache.nextRoundRobinIndex(key, peers.length);
  return peers.slice(start).concat(peers.slice(0, start));
}

function randomOrder(peers: PeerInfo[]): PeerInfo[] {
  const out = [...peers];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function isFailoverEligibleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes('timeout') ||
    lower.includes('deadline') ||
    lower.includes('unavailable') ||
    lower.includes('connection') ||
    lower.includes('connect') ||
    lower.includes('econn') ||
    lower.includes('grpc') ||
    lower.includes('14 unavailable') ||
    lower.includes('4 deadline_exceeded');
}
