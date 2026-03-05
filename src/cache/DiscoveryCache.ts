import type { DiscoveryResult, DiscoveryCacheEntry } from "../types/discovery";

export class DiscoveryCache {
  private static readonly DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private cache: Map<string, DiscoveryCacheEntry> = new Map();
  private ttl: number;

  constructor(ttlMs: number = DiscoveryCache.DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }

  get(channelName: string): DiscoveryResult | null {
    const entry = this.cache.get(channelName);

    if (!entry) {
      return null;
    }

    // Check if entry is expired
    if (Date.now() > entry.expiresAt) {
      // Silently trigger background refresh (don't block)
      this.triggerBackgroundRefresh(channelName);
      // Return stale data while refreshing
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
    } else {
      this.cache.clear();
    }
  }

  private triggerBackgroundRefresh(channelName: string): void {
    // This will be implemented by the caller (PeerConnection)
    // We just mark it as needing refresh
  }

  getLastRefreshTime(channelName: string): number | null {
    const entry = this.cache.get(channelName);
    if (!entry) return null;
    return entry.expiresAt - this.ttl;
  }
}
