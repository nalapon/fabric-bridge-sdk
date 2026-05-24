import { describe, expect, test } from "bun:test";
import { ConfigurationError, PeerNotFoundError } from "../src/errors/index";
import { DiscoveryCache } from "../src/cache/DiscoveryCache";
import {
  dedupePeerEndpointInputs,
  normalizePeerEndpointIdentityResult,
  normalizePeerEndpointIdentity,
} from "../src/peer/endpointIdentity";
import { selectSinglePeers, selectSinglePeersResult } from "../src/peer/peerSelection";
import type { DiscoveryResult, PeerInfo } from "../src/types/discovery";

describe("peer endpoint identity", () => {
  test("accepts host:port and grpc(s) URLs", () => {
    expect(normalizePeerEndpointIdentity("Peer0.Org1.Example.com:7051", false)).toBe(
      "grpc://peer0.org1.example.com:7051",
    );
    expect(normalizePeerEndpointIdentity("Peer0.Org1.Example.com:7051", true)).toBe(
      "grpcs://peer0.org1.example.com:7051",
    );
    expect(normalizePeerEndpointIdentity("grpc://Peer0.Org1.Example.com:7051", true)).toBe(
      "grpc://peer0.org1.example.com:7051",
    );
    expect(normalizePeerEndpointIdentity("grpcs://Peer0.Org1.Example.com:7051", false)).toBe(
      "grpcs://peer0.org1.example.com:7051",
    );
  });

  test("deduplicates canonical endpoint inputs while preserving first order", () => {
    expect(
      dedupePeerEndpointInputs(
        [
          "Peer1.Org1.Example.com:8051",
          "peer0.org1.example.com:7051",
          "grpcs://peer1.org1.example.com:8051",
          "grpcs://peer0.org1.example.com:7051",
        ],
        true,
      ),
    ).toEqual([
      "grpcs://peer1.org1.example.com:8051",
      "grpcs://peer0.org1.example.com:7051",
    ]);
  });

  test("reports invalid endpoint format as configuration errors", () => {
    for (const raw of ["peer0.org1.example.com", "https://peer0.org1.example.com:7051", ""]) {
      expect(() => normalizePeerEndpointIdentity(raw, true)).toThrow(ConfigurationError);
    }
  });

  test("returns configuration errors for invalid endpoint Results", () => {
    const result = normalizePeerEndpointIdentityResult("https://peer0.org1.example.com:7051", true);

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected endpoint normalization failure");
    expect(result.error).toBeInstanceOf(ConfigurationError);
  });
});

describe("single-peer selection", () => {
  test("selects all discovered peers using SDK-instance round-robin", () => {
    const cache = new DiscoveryCache();
    const discovery = discoveryResult([
      peer("peer-b", "grpcs://peer-b.example.com:8051"),
      peer("peer-a", "grpcs://peer-a.example.com:7051"),
      peer("peer-c", "grpcs://peer-c.example.com:9051"),
    ]);

    expect(selectSinglePeers(discovery, cache).orderedPeers.map((item) => item.endpoint)).toEqual([
      "grpcs://peer-a.example.com:7051",
      "grpcs://peer-b.example.com:8051",
      "grpcs://peer-c.example.com:9051",
    ]);
    expect(selectSinglePeers(discovery, cache).orderedPeers.map((item) => item.endpoint)).toEqual([
      "grpcs://peer-b.example.com:8051",
      "grpcs://peer-c.example.com:9051",
      "grpcs://peer-a.example.com:7051",
    ]);

    const otherSdkInstance = new DiscoveryCache();
    expect(selectSinglePeers(discovery, otherSdkInstance).orderedPeers.map((item) => item.endpoint)).toEqual([
      "grpcs://peer-a.example.com:7051",
      "grpcs://peer-b.example.com:8051",
      "grpcs://peer-c.example.com:9051",
    ]);
  });

  test("reports empty discovered peer sets as peer-not-found", () => {
    expect(() => selectSinglePeers(discoveryResult([]), new DiscoveryCache())).toThrow(PeerNotFoundError);
  });

  test("returns peer-not-found Results for empty discovered peer sets", () => {
    const result = selectSinglePeersResult(discoveryResult([]), new DiscoveryCache());

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected peer selection failure");
    expect(result.error).toBeInstanceOf(PeerNotFoundError);
  });
});

function discoveryResult(peers: PeerInfo[]): DiscoveryResult {
  return {
    timestamp: Date.now(),
    channelName: "mychannel",
    peers: new Map(peers.map((item) => [item.endpoint, item])),
    orderers: [],
    msps: new Map(),
  };
}

function peer(name: string, endpoint: string): PeerInfo {
  return {
    name,
    endpoint,
    mspId: "Org1MSP",
    chaincodes: [],
    ledgerHeight: BigInt(0),
  };
}
