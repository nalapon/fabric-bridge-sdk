import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createHash } from "node:crypto";
import commonProtoModule from "@hyperledger/fabric-protos/lib/common/common_pb.js";
import ordererGrpcModule from "@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js";
import ordererProtoModule from "@hyperledger/fabric-protos/lib/orderer/ab_pb.js";
import peerGrpcModule from "@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js";
import peerProposalResponseModule from "@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js";
import type * as CommonProto from "@hyperledger/fabric-protos/lib/common/common_pb.js";
import type * as PeerProposalProto from "@hyperledger/fabric-protos/lib/peer/proposal_pb.js";
import type * as PeerProposalResponseProto from "@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js";
import { ConfigurationError, EndorsementError, SubmitError } from "../src/errors/index";
import { classifyFailover } from "../src/peer/failoverEligibility";
import {
  DirectPeerRuntime,
  signDirectTransactionPayload,
} from "../src/peer/DirectPeerRuntime";
import type { BridgeConfig } from "../src/types/config";

const commonProto = commonProtoModule as typeof import("@hyperledger/fabric-protos/lib/common/common_pb.js");
const ordererGrpc = ordererGrpcModule as typeof import("@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js");
const ordererProto = ordererProtoModule as typeof import("@hyperledger/fabric-protos/lib/orderer/ab_pb.js");
const peerGrpc = peerGrpcModule as typeof import("@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js");
const peerProposalResponse = peerProposalResponseModule as typeof import("@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js");

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("DirectPeerRuntime", () => {
  test("processProposal sends exactly one signed proposal to one peer", async () => {
    const requests: PeerProposalProto.SignedProposal[] = [];
    const peerAddress = await startEndorserServer((request, callback) => {
      requests.push(request);
      callback(null, successfulProposalResponse(Buffer.from("result")));
    });

    const response = await new DirectPeerRuntime(bridgeConfig()).processProposal(
      `grpc://${peerAddress}`,
      Buffer.from("proposal-bytes"),
      Buffer.from("proposal-signature"),
    );

    expect(requests).toHaveLength(1);
    expect(Buffer.from(requests[0]!.getProposalBytes_asU8())).toEqual(Buffer.from("proposal-bytes"));
    expect(Buffer.from(requests[0]!.getSignature_asU8())).toEqual(Buffer.from("proposal-signature"));
    expect(response.response?.payload).toEqual(Buffer.from("result"));
    expect(response.endorsement?.signature).toEqual(Buffer.from("endorsement-signature"));
  });

  test("submitEnvelope sends signed transaction bytes to the configured orderer", async () => {
    const envelopes: CommonProto.Envelope[] = [];
    const ordererAddress = await startOrdererServer((envelope) => {
      envelopes.push(envelope);
      return commonProto.Status.SUCCESS;
    });

    await new DirectPeerRuntime(bridgeConfig({ ordererEndpoint: ordererAddress })).submitEnvelope(
      Buffer.from("transaction-payload"),
      Buffer.from("transaction-signature"),
      "tx1",
    );

    expect(envelopes).toHaveLength(1);
    expect(Buffer.from(envelopes[0]!.getPayload_asU8())).toEqual(Buffer.from("transaction-payload"));
    expect(Buffer.from(envelopes[0]!.getSignature_asU8())).toEqual(Buffer.from("transaction-signature"));
  });

  test("submitEnvelope sends signed transaction bytes to a discovered orderer when unconfigured", async () => {
    const envelopes: CommonProto.Envelope[] = [];
    const ordererAddress = await startOrdererServer((envelope) => {
      envelopes.push(envelope);
      return commonProto.Status.SUCCESS;
    });

    await new DirectPeerRuntime(bridgeConfig()).submitEnvelope(
      Buffer.from("transaction-payload"),
      Buffer.from("transaction-signature"),
      "tx1",
      ordererAddress,
    );

    expect(envelopes).toHaveLength(1);
    expect(Buffer.from(envelopes[0]!.getPayload_asU8())).toEqual(Buffer.from("transaction-payload"));
  });

  test("submitEnvelope fails locally when ordererEndpoint and discovered orderers are absent", async () => {
    try {
      await new DirectPeerRuntime(bridgeConfig()).submitEnvelope(
        Buffer.from("transaction-payload"),
        Buffer.from("transaction-signature"),
        "tx-missing-orderer",
      );
      throw new Error("expected configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).field).toBe("ordererEndpoint");
    }
  });

  test("signDirectTransactionPayload signs the endorsed transaction digest with the bridge signer", async () => {
    const digests: Buffer[] = [];
    const payload = Buffer.from("endorsed-transaction-payload");
    const signature = await signDirectTransactionPayload(
      bridgeConfig({
        signer: (digest) => {
          digests.push(Buffer.from(digest));
          return Buffer.from("bridge-signature");
        },
      }),
      payload,
    );

    expect(signature).toEqual(Buffer.from("bridge-signature"));
    expect(digests).toEqual([createHash("sha256").update(payload).digest()]);
  });

  test("orderer rejection is mapped to SubmitError with transaction ID", async () => {
    const ordererAddress = await startOrdererServer(() => commonProto.Status.BAD_REQUEST);

    try {
      await new DirectPeerRuntime(bridgeConfig({ ordererEndpoint: ordererAddress })).submitEnvelope(
        Buffer.from("transaction-payload"),
        Buffer.from("transaction-signature"),
        "tx-rejected",
      );
      throw new Error("expected submit error");
    } catch (error) {
      expect(error).toBeInstanceOf(SubmitError);
      expect((error as SubmitError).transactionId).toBe("tx-rejected");
      expect((error as SubmitError).message).toContain("status=");
    }
  });

  test("orderer stream ending without a response is mapped to SubmitError with transaction ID", async () => {
    const ordererAddress = await startOrdererServer(() => undefined);

    try {
      await new DirectPeerRuntime(bridgeConfig({ ordererEndpoint: ordererAddress })).submitEnvelope(
        Buffer.from("transaction-payload"),
        Buffer.from("transaction-signature"),
        "tx-empty-orderer",
      );
      throw new Error("expected submit error");
    } catch (error) {
      expect(error).toBeInstanceOf(SubmitError);
      expect((error as SubmitError).transactionId).toBe("tx-empty-orderer");
      expect((error as SubmitError).message).toContain("ended without response");
    }
  });

  test("non-success proposal response is a non-failover endorsement error", async () => {
    const peerAddress = await startEndorserServer((_request, callback) => {
      const response = new peerProposalResponse.ProposalResponse();
      const chaincodeResponse = new peerProposalResponse.Response();
      chaincodeResponse.setStatus(500);
      chaincodeResponse.setMessage("chaincode rejected");
      response.setResponse(chaincodeResponse);
      response.setPayload(Buffer.from("payload"));
      callback(null, response);
    });

    try {
      await new DirectPeerRuntime(bridgeConfig()).processProposal(
        peerAddress,
        Buffer.from("proposal"),
        Buffer.from("signature"),
      );
      throw new Error("expected endorsement error");
    } catch (error) {
      expect(error).toBeInstanceOf(EndorsementError);
      expect(classifyFailover(error).eligible).toBe(false);
    }
  });

  test("unavailable peers remain failover-eligible", async () => {
    const decision = classifyFailover(Object.assign(new Error("unavailable"), { code: 14 }));
    expect(decision.eligible).toBe(true);
    expect(decision.category).toBe("peer-unavailable");
  });

  test("multiple selected peers can receive endorsement concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const first = await startEndorserServer(async (_request, callback) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active -= 1;
      callback(null, successfulProposalResponse(Buffer.from("result")));
    });
    const second = await startEndorserServer(async (_request, callback) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active -= 1;
      callback(null, successfulProposalResponse(Buffer.from("result")));
    });
    const runtime = new DirectPeerRuntime(bridgeConfig());

    await Promise.all([
      runtime.processProposal(first, Buffer.from("proposal"), Buffer.from("signature")),
      runtime.processProposal(second, Buffer.from("proposal"), Buffer.from("signature")),
    ]);

    expect(maxActive).toBe(2);
  });
});

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
  onEnvelope: (envelope: CommonProto.Envelope) => number | undefined,
): Promise<string> {
  const server = new grpc.Server();
  server.addService(ordererGrpc.AtomicBroadcastService, {
    broadcast: (stream) => {
      stream.on("data", (envelope: CommonProto.Envelope) => {
        const status = onEnvelope(envelope);
        if (status === undefined) {
          stream.end();
          return;
        }
        const response = new ordererProto.BroadcastResponse();
        response.setStatus(status);
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

function successfulProposalResponse(result: Buffer): PeerProposalResponseProto.ProposalResponse {
  const response = new peerProposalResponse.ProposalResponse();
  const chaincodeResponse = new peerProposalResponse.Response();
  chaincodeResponse.setStatus(200);
  chaincodeResponse.setPayload(result);
  response.setResponse(chaincodeResponse);
  response.setPayload(Buffer.from("proposal-response-payload"));
  const endorsement = new peerProposalResponse.Endorsement();
  endorsement.setEndorser(Buffer.from("peer"));
  endorsement.setSignature(Buffer.from("endorsement-signature"));
  response.setEndorsement(endorsement);
  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
