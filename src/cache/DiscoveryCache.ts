import type { DiscoveryResult, DiscoveryCacheEntry } from "../types/discovery";

export class DiscoveryCache {
  private static readonly DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private cache: Map<string, DiscoveryCacheEntry> = new Map();
  private roundRobinCounters: Map<string, number> = new Map();
  private ttl: number;

  constructor(ttlMs: number = DiscoveryCache.DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }

  get(channelName: string): DiscoveryResult | null {
    const entry = this.cache.get(channelName);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      return entry.result;
    }

    return entry.result;
  }

  set(channelName: string, result: DiscoveryResult): void {
    this.cache.set(channelName, {
      result,
      expiresAt: Date.now() + this.ttl,
    });
  }

  isStale(channelName: string): boolean {
    const entry = this.cache.get(channelName);
    if (!entry) return true;
    return Date.now() > entry.expiresAt;
  }

  clear(channelName?: string): void {
    if (channelName) {
      this.cache.delete(channelName);
      for (const key of this.roundRobinCounters.keys()) {
        if (key.startsWith(`${channelName}:`)) {
          this.roundRobinCounters.delete(key);
        }
      }
    } else {
      this.cache.clear();
      this.roundRobinCounters.clear();
    }
  }

  nextRoundRobinIndex(key: string, size: number): number {
    if (size <= 0) {
      return 0;
    }

    const current = this.roundRobinCounters.get(key) ?? 0;
    this.roundRobinCounters.set(key, (current + 1) % size);
    return current % size;
  }
}
