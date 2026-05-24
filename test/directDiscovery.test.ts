import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import discoveryGrpcModule from "@hyperledger/fabric-protos/lib/discovery/protocol_grpc_pb.js";
import discoveryProtoModule from "@hyperledger/fabric-protos/lib/discovery/protocol_pb.js";
import gossipProtoModule from "@hyperledger/fabric-protos/lib/gossip/message_pb.js";
import identitiesProtoModule from "@hyperledger/fabric-protos/lib/msp/identities_pb.js";
import type * as DiscoveryProto from "@hyperledger/fabric-protos/lib/discovery/protocol_pb.js";
import { createHash } from "crypto";
import { DirectDiscoveryClient } from "../src/peer/DirectDiscoveryClient";
import { normalizePeerEndpointIdentity } from "../src/peer/endpointIdentity";
import type { BridgeConfig } from "../src/types/config";

const discoveryGrpc = discoveryGrpcModule as typeof import("@hyperledger/fabric-protos/lib/discovery/protocol_grpc_pb.js");
const discoveryProto = discoveryProtoModule as typeof import("@hyperledger/fabric-protos/lib/discovery/protocol_pb.js");
const gossipProto = gossipProtoModule as typeof import("@hyperledger/fabric-protos/lib/gossip/message_pb.js");
const { SerializedIdentity } = identitiesProtoModule as typeof import("@hyperledger/fabric-protos/lib/msp/identities_pb.js");

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("DirectDiscoveryClient", () => {
  test("contacts discoverySeed and signs discovery requests", async () => {
    const captured: DiscoveryProto.SignedRequest[] = [];
    const address = await startDiscoveryServer((request, callback) => {
      captured.push(request);
      callback(null, membershipResponse({ Org1MSP: ["Peer0.Org1.Example.com:7051"] }));
    });
    const config = bridgeConfig({ discoverySeed: address });

    const result = await new DirectDiscoveryClient(config).discover("mychannel");

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(Array.from(result.value.peers.keys())).toEqual(["grpc://peer0.org1.example.com:7051"]);
    expect(captured).toHaveLength(1);

    const request = captured[0]!;
    const requestPayload = bytesOf(request.getPayload());
    const digest = createHash("sha256").update(requestPayload).digest();
    expect(bytesOf(request.getSignature())).toEqual(digest);

    const payload = discoveryProto.Request.deserializeBinary(requestPayload);
    const identity = SerializedIdentity.deserializeBinary(
      bytesOf(payload.getAuthentication()!.getClientIdentity()),
    );
    expect(identity.getMspid()).toBe("Org1MSP");
    expect(bytesOf(identity.getIdBytes())).toEqual(Buffer.from("certificate"));
    expect(payload.getQueriesList()[0]?.getChannel()).toBe("mychannel");
    expect(payload.getQueriesList()[0]?.getPeerQuery()).toBeDefined();
  });

  test("canonicalizes discovered peer endpoints for TLS and no-TLS modes", () => {
    expect(normalizePeerEndpointIdentity("Peer0.Org1.Example.com:7051", false)).toBe(
      "grpc://peer0.org1.example.com:7051",
    );
    expect(normalizePeerEndpointIdentity("Peer0.Org1.Example.com:7051", true)).toBe(
      "grpcs://peer0.org1.example.com:7051",
    );
    expect(normalizePeerEndpointIdentity("grpc://Peer0.Org1.Example.com:7051", true)).toBe(
      "grpc://peer0.org1.example.com:7051",
    );
  });

  test("fails locally for duplicate canonical peer endpoint identities", async () => {
    const address = await startDiscoveryServer((_request, callback) => {
      callback(null, membershipResponse({
        Org1MSP: ["Peer0.Org1.Example.com:7051", "grpc://peer0.org1.example.com:7051"],
      }));
    });

    const result = await new DirectDiscoveryClient(bridgeConfig({ discoverySeed: address })).discover("mychannel");

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected discovery failure");
    expect(result.error.message).toContain("duplicate peer endpoint identity");
  });

  test("fails locally for discovered peers without membership endpoints", async () => {
    const address = await startDiscoveryServer((_request, callback) => {
      const peers = new discoveryProto.Peers();
      peers.addPeers(new discoveryProto.Peer());
      const members = new discoveryProto.PeerMembershipResult();
      members.getPeersByOrgMap().set("Org1MSP", peers);
      const result = new discoveryProto.QueryResult();
      result.setMembers(members);
      const response = new discoveryProto.Response();
      response.setResultsList([result]);
      callback(null, response);
    });

    const result = await new DirectDiscoveryClient(bridgeConfig({ discoverySeed: address })).discover("mychannel");

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected discovery failure");
    expect(result.error.message).toContain("no membership info");
  });
});

function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    gatewayEndpoint: "gateway.example.com:7051",
    identity: {
      mspId: "Org1MSP",
      credentials: Buffer.from("certificate"),
    },
    signer: (digest) => Buffer.from(digest),
    timeouts: {
      discovery: 3000,
    },
    ...overrides,
  };
}

async function startDiscoveryServer(
  discover: (
    request: DiscoveryProto.SignedRequest,
    callback: grpc.sendUnaryData<DiscoveryProto.Response>,
  ) => void,
): Promise<string> {
  const server = new grpc.Server();
  server.addService(discoveryGrpc.DiscoveryService, {
    discover: (call, callback) => discover(call.request, callback),
  });
  const address = await new Promise<string>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`127.0.0.1:${port}`);
    });
  });
  cleanup.push(() => server.forceShutdown());
  return address;
}

function membershipResponse(peersByOrg: Record<string, string[]>): DiscoveryProto.Response {
  const members = new discoveryProto.PeerMembershipResult();
  for (const [mspId, endpoints] of Object.entries(peersByOrg)) {
    const peers = new discoveryProto.Peers();
    for (const endpoint of endpoints) {
      const peer = new discoveryProto.Peer();
      peer.setMembershipInfo(membershipEnvelope(endpoint));
      peers.addPeers(peer);
    }
    members.getPeersByOrgMap().set(mspId, peers);
  }

  const result = new discoveryProto.QueryResult();
  result.setMembers(members);
  const response = new discoveryProto.Response();
  response.setResultsList([result]);
  return response;
}

function membershipEnvelope(endpoint: string) {
  const member = new gossipProto.Member();
  member.setEndpoint(endpoint);
  const alive = new gossipProto.AliveMessage();
  alive.setMembership(member);
  const message = new gossipProto.GossipMessage();
  message.setAliveMsg(alive);
  const envelope = new gossipProto.Envelope();
  envelope.setPayload(message.serializeBinary());
  return envelope;
}

function bytesOf(value: Uint8Array | string): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value, "binary")
      : Buffer.from(value);
}
