import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import commonProtoModule from "@hyperledger/fabric-protos/lib/common/common_pb.js";
import ordererGrpcModule from "@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js";
import ordererProtoModule from "@hyperledger/fabric-protos/lib/orderer/ab_pb.js";
import peerGrpcModule from "@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js";
import peerProposalResponseModule from "@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js";
import type * as CommonProto from "@hyperledger/fabric-protos/lib/common/common_pb.js";
import type * as PeerProposalProto from "@hyperledger/fabric-protos/lib/peer/proposal_pb.js";
import type * as PeerProposalResponseProto from "@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js";
import { PeerNotFoundError } from "../src/errors/index";
import { digestBytes, signedMessage, signingRequest } from "../src/offlineSigning";
import { NewPeerSignedProposal } from "../src/peer/PeerContract";
import { normalizePeerEndpointIdentity } from "../src/peer/endpointIdentity";
import { buildPeerProposal } from "../src/peer/PeerProposalBuilder";
import type { OfflineSigningRouting, SignedMessage } from "../src/types/bridge";
import type { BridgeConfig } from "../src/types/config";
import { Result } from "better-result";

const commonProto = commonProtoModule as typeof import("@hyperledger/fabric-protos/lib/common/common_pb.js");
const ordererGrpc = ordererGrpcModule as typeof import("@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js");
const ordererProto = ordererProtoModule as typeof import("@hyperledger/fabric-protos/lib/orderer/ab_pb.js");
const peerGrpc = peerGrpcModule as typeof import("@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js");
const peerProposalResponse = peerProposalResponseModule as typeof import("@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js");

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("offline direct endorsement resume", () => {
  test("single-peer resume sends only to the snapshotted peer", async () => {
    const firstRequests: PeerProposalProto.SignedProposal[] = [];
    const secondRequests: PeerProposalProto.SignedProposal[] = [];
    const first = await startEndorserServer((request, callback) => {
      firstRequests.push(request);
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });
    const second = await startEndorserServer((request, callback) => {
      secondRequests.push(request);
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });

    const signedProposal = await NewPeerSignedProposal(
      fakePeerDiscoverySession([first, second]),
      bridgeConfig(),
      signedProposalMessage({ mode: "single-peer", peers: [first] }),
    );
    expect(signedProposal.isOk()).toBe(true);
    if (!signedProposal.isOk()) throw signedProposal.error;

    const endorsed = await signedProposal.value.Endorse();

    expect(endorsed.isOk()).toBe(true);
    expect(firstRequests).toHaveLength(1);
    expect(secondRequests).toHaveLength(0);
  });

  test("explicit endorsement resume sends to all snapshotted peers in caller order", async () => {
    const received: string[] = [];
    const first = await startEndorserServer((_request, callback) => {
      received.push("first");
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });
    const second = await startEndorserServer((_request, callback) => {
      received.push("second");
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });

    const signedProposal = await NewPeerSignedProposal(
      fakePeerDiscoverySession([first, second]),
      bridgeConfig(),
      signedProposalMessage({ mode: "endorsing-peers", peers: [first, second, first] }),
    );
    expect(signedProposal.isOk()).toBe(true);
    if (!signedProposal.isOk()) throw signedProposal.error;

    const endorsed = await signedProposal.value.Endorse();

    expect(endorsed.isOk()).toBe(true);
    expect(received).toEqual(["first", "second"]);
  });

  test("resume revalidates snapshotted peers against current discovery", async () => {
    const snapshotted = await startEndorserServer((_request, callback) => {
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });
    const discovered = await startEndorserServer((_request, callback) => {
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });

    const signedProposal = await NewPeerSignedProposal(
      fakePeerDiscoverySession([discovered]),
      bridgeConfig(),
      signedProposalMessage({ mode: "single-peer", peers: [snapshotted] }),
    );
    expect(signedProposal.isOk()).toBe(true);
    if (!signedProposal.isOk()) throw signedProposal.error;

    const endorsed = await signedProposal.value.Endorse();

    expect(endorsed.isOk()).toBe(false);
    if (endorsed.isOk()) throw new Error("expected endorsement error");
    expect(endorsed.error).toBeInstanceOf(PeerNotFoundError);
  });

  test("offline endorsed transactions are submitted with the bridge identity signature", async () => {
    const peer = await startEndorserServer((_request, callback) => {
      callback(null, successfulProposalResponse(Buffer.from("result"), Buffer.from("payload")));
    });
    const envelopes: CommonProto.Envelope[] = [];
    const orderer = await startOrdererServer((envelope) => {
      envelopes.push(envelope);
      return commonProto.Status.SUCCESS;
    });
    const signerDigests: Buffer[] = [];
    const config = bridgeConfig({
      ordererEndpoint: orderer,
      signer: (digest) => {
        signerDigests.push(Buffer.from(digest));
        return Buffer.from("bridge-submit-signature");
      },
    });

    const signedProposal = await NewPeerSignedProposal(
      fakePeerDiscoverySession([peer]),
      config,
      signedProposalMessage({ mode: "single-peer", peers: [peer] }),
    );
    expect(signedProposal.isOk()).toBe(true);
    if (!signedProposal.isOk()) throw signedProposal.error;
    const endorsed = await signedProposal.value.Endorse();
    expect(endorsed.isOk()).toBe(true);
    if (!endorsed.isOk()) throw endorsed.error;

    const submitted = await endorsed.value.SubmitAsync();

    expect(submitted.isOk()).toBe(true);
    expect(envelopes).toHaveLength(1);
    const transactionPayload = Buffer.from(envelopes[0]!.getPayload_asU8());
    expect(Buffer.from(envelopes[0]!.getSignature_asU8())).toEqual(
      Buffer.from("bridge-submit-signature"),
    );
    expect(signerDigests).toContainEqual(digestBytes(transactionPayload));
  });
});

function signedProposalMessage(routing: OfflineSigningRouting): SignedMessage {
  const proposal = buildPeerProposal({
    channelName: "mychannel",
    chaincodeName: "basic",
    transactionName: "CreateAsset",
    args: ["asset1"],
    proposalCreator: {
      mspId: "ExternalMSP",
      credentials: Buffer.from("external certificate"),
    },
    nonce: Buffer.alloc(24, 6),
    timestamp: new Date("2026-05-24T00:00:00.000Z"),
  });
  const message = signedMessage(
    signingRequest(proposal.bytes, proposal.digest, routing),
    Buffer.from("offline-proposal-signature"),
  );
  if (!message.isOk()) throw message.error;
  return message.value;
}

function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    gatewayEndpoint: "gateway.example.com:7051",
    identity: {
      mspId: "Org1MSP",
      credentials: Buffer.from("bridge certificate"),
    },
    signer: (digest) => Buffer.from(digest),
    timeouts: {
      endorse: 3000,
      submit: 3000,
      commit: 3000,
    },
    ...overrides,
  };
}

function fakePeerDiscoverySession(discoveredEndpoints: string[]) {
  return {
    discover: async () => Result.ok({
      channelName: "mychannel",
      peers: new Map(
        discoveredEndpoints.map((endpoint) => [
          normalizePeerEndpointIdentity(endpoint, false),
          {
            name: endpoint,
            endpoint: normalizePeerEndpointIdentity(endpoint, false),
            mspId: "Org1MSP",
            chaincodes: [],
            ledgerHeight: 0n,
          },
        ]),
      ),
      orderers: [],
      msps: new Map(),
    }),
  } as never;
}

async function startEndorserServer(
  processProposal: (
    request: PeerProposalProto.SignedProposal,
    callback: grpc.sendUnaryData<PeerProposalResponseProto.ProposalResponse>,
  ) => void,
): Promise<string> {
  const server = new grpc.Server();
  server.addService(peerGrpc.EndorserService, {
    processProposal: (call, callback) => processProposal(call.request, callback),
  });
  return bindServer(server);
}

async function startOrdererServer(
  onEnvelope: (envelope: CommonProto.Envelope) => number,
): Promise<string> {
  const server = new grpc.Server();
  server.addService(ordererGrpc.AtomicBroadcastService, {
    broadcast: (stream) => {
      stream.on("data", (envelope: CommonProto.Envelope) => {
        const response = new ordererProto.BroadcastResponse();
        response.setStatus(onEnvelope(envelope));
        stream.write(response);
      });
      stream.on("end", () => stream.end());
    },
    deliver: () => undefined,
  });
  return bindServer(server);
}

async function bindServer(server: grpc.Server): Promise<string> {
  const address = await new Promise<string>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else resolve(`127.0.0.1:${port}`);
    });
  });
  cleanup.push(() => server.forceShutdown());
  return address;
}

function successfulProposalResponse(
  result: Buffer,
  payload: Buffer,
): PeerProposalResponseProto.ProposalResponse {
  const response = new peerProposalResponse.ProposalResponse();
  const chaincodeResponse = new peerProposalResponse.Response();
  chaincodeResponse.setStatus(200);
  chaincodeResponse.setPayload(result);
  response.setResponse(chaincodeResponse);
  response.setPayload(payload);
  const endorsement = new peerProposalResponse.Endorsement();
  endorsement.setEndorser(Buffer.from("peer"));
  endorsement.setSignature(Buffer.from("endorsement-signature"));
  response.setEndorsement(endorsement);
  return response;
}
