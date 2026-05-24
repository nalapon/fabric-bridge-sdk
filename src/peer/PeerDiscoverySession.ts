import { Result } from "better-result";
import { DiscoveryCache } from "../cache/DiscoveryCache";
import { DiscoveryError } from "../errors/index";
import type { BridgeConfig } from "../types/config";
import type { DiscoveryResult, PeerInfo } from "../types/discovery";
import { log } from "../utils/logger";
import { DirectDiscoveryClient } from "./DirectDiscoveryClient";
import { normalizePeerEndpointIdentity as normalizeEndpointIdentity } from "./endpointIdentity";

function endpointUsesTLS(config: BridgeConfig): boolean {
  return !!config.discoveryTls?.trustedRoots;
}

export class PeerDiscoverySession {
  constructor(
    private readonly config: BridgeConfig,
    private readonly discoveryCache: DiscoveryCache,
  ) {}

  async discover(
    channelName: string,
  ): Promise<Result<DiscoveryResult, DiscoveryError>> {
    log().debug("PeerDiscoverySession.discover() - channel:", channelName);

    const cached = this.discoveryCache.get(channelName);
    if (cached && !this.discoveryCache.isStale(channelName)) {
      return Result.ok(cached);
    }

    try {
      const discovered = await new DirectDiscoveryClient(this.config).discover(channelName);
      if (!discovered.isOk()) {
        throw discovered.error;
      }
      this.discoveryCache.set(channelName, discovered.value);
      return Result.ok(discovered.value);
    } catch (error) {
      if (cached) {
        setTimeout(() => this.discover(channelName).catch(() => {}), 0);
        return Result.ok(cached);
      }

      return Result.err(
        new DiscoveryError({
          message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }
  }

  matchPeerByEndpointIdentity(
    discoveryResult: DiscoveryResult,
    endpoint: string,
  ): PeerInfo | null {
    return discoveryResult.peers.get(this.normalizePeerEndpointIdentity(endpoint)) ?? null;
  }

  normalizePeerEndpointIdentity(endpoint: string): string {
    return normalizeEndpointIdentity(endpoint, endpointUsesTLS(this.config));
  }

  usesDiscoveryTLS(): boolean {
    return endpointUsesTLS(this.config);
  }
}
