import { afterEach, describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createHash } from "node:crypto";
import gatewayGrpcModule from "@hyperledger/fabric-protos/lib/gateway/gateway_grpc_pb.js";
import gatewayProtoModule from "@hyperledger/fabric-protos/lib/gateway/gateway_pb.js";
import identitiesProtoModule from "@hyperledger/fabric-protos/lib/msp/identities_pb.js";
import peerTransactionProtoModule from "@hyperledger/fabric-protos/lib/peer/transaction_pb.js";
import type * as GatewayProto from "@hyperledger/fabric-protos/lib/gateway/gateway_pb.js";
import { CommitError } from "../src/errors/index";
import { GatewayConnection } from "../src/gateway/GatewayConnection";
import { DirectPeerRuntime } from "../src/peer/DirectPeerRuntime";
import type { BridgeConfig } from "../src/types/config";

const gatewayGrpc = gatewayGrpcModule as typeof import("@hyperledger/fabric-protos/lib/gateway/gateway_grpc_pb.js");
const gatewayProto = gatewayProtoModule as typeof import("@hyperledger/fabric-protos/lib/gateway/gateway_pb.js");
const { SerializedIdentity } = identitiesProtoModule as typeof import("@hyperledger/fabric-protos/lib/msp/identities_pb.js");
const peerTransactionProto = peerTransactionProtoModule as typeof import("@hyperledger/fabric-protos/lib/peer/transaction_pb.js");

const cleanup: Array<() => void> = [];

afterEach(async () => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("Gateway commit status for direct endorsement", () => {
  test("DirectPeerRuntime waitForCommit calls Gateway CommitStatus", async () => {
    const transactions: string[] = [];
    const gatewayAddress = await startGatewayServer((request, callback) => {
      const innerRequest = gatewayProto.CommitStatusRequest.deserializeBinary(
        request.getRequest_asU8(),
      );
      transactions.push(innerRequest.getTransactionId());
      const response = new gatewayProto.CommitStatusResponse();
      response.setResult(peerTransactionProto.TxValidationCode.VALID);
      response.setBlockNumber(12);
      callback(null, response);
    });

    const status = await new DirectPeerRuntime(
      bridgeConfig({ gatewayEndpoint: gatewayAddress }),
    ).waitForCommit("mychannel", "tx-direct");

    expect(status.isOk()).toBe(true);
    if (!status.isOk()) throw status.error;
    expect(status.value).toEqual({
      blockNumber: 12n,
      status: "VALID",
      transactionId: "tx-direct",
    });
    expect(transactions).toEqual(["tx-direct"]);
  });

  test("getCommitStatus signs CommitStatus requests with the bridge identity", async () => {
    const signedRequests: GatewayProto.SignedCommitStatusRequest[] = [];
    const gatewayAddress = await startGatewayServer((request, callback) => {
      signedRequests.push(request);
      const response = new gatewayProto.CommitStatusResponse();
      response.setResult(peerTransactionProto.TxValidationCode.VALID);
      response.setBlockNumber(7);
      callback(null, response);
    });
    const signerDigests: Buffer[] = [];
    const connection = new GatewayConnection(
      bridgeConfig({
        gatewayEndpoint: gatewayAddress,
        signer: (digest) => {
          signerDigests.push(Buffer.from(digest));
          return Buffer.from("commit-status-signature");
        },
      }),
    );

    const connected = await connection.connect();
    expect(connected.isOk()).toBe(true);
    cleanup.push(() => void connection.disconnect());

    const status = await connection.getCommitStatus("mychannel", "tx-commit");

    expect(status.isOk()).toBe(true);
    if (!status.isOk()) throw status.error;
    expect(status.value).toEqual({
      blockNumber: 7n,
      status: "VALID",
      transactionId: "tx-commit",
    });

    expect(signedRequests).toHaveLength(1);
    const signedRequest = signedRequests[0]!;
    const requestBytes = Buffer.from(signedRequest.getRequest_asU8());
    expect(Buffer.from(signedRequest.getSignature_asU8())).toEqual(
      Buffer.from("commit-status-signature"),
    );
    expect(signerDigests).toEqual([createHash("sha256").update(requestBytes).digest()]);

    const request = gatewayProto.CommitStatusRequest.deserializeBinary(requestBytes);
    expect(request.getChannelId()).toBe("mychannel");
    expect(request.getTransactionId()).toBe("tx-commit");
    const identity = SerializedIdentity.deserializeBinary(request.getIdentity_asU8());
    expect(identity.getMspid()).toBe("Org1MSP");
    expect(Buffer.from(identity.getIdBytes_asU8())).toEqual(Buffer.from("bridge certificate"));
  });

  test("invalid validation codes return CommitError preserving the returned status", async () => {
    const gatewayAddress = await startGatewayServer((_request, callback) => {
      const response = new gatewayProto.CommitStatusResponse();
      response.setResult(peerTransactionProto.TxValidationCode.MVCC_READ_CONFLICT);
      response.setBlockNumber(9);
      callback(null, response);
    });
    const connection = new GatewayConnection(bridgeConfig({ gatewayEndpoint: gatewayAddress }));

    const connected = await connection.connect();
    expect(connected.isOk()).toBe(true);
    cleanup.push(() => void connection.disconnect());

    const status = await connection.getCommitStatus("mychannel", "tx-conflict");

    expect(status.isOk()).toBe(false);
    if (status.isOk()) throw new Error("expected commit error");
    expect(status.error).toBeInstanceOf(CommitError);
    expect(status.error.transactionId).toBe("tx-conflict");
    expect(status.error.status).toBe("MVCC_READ_CONFLICT");
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
      discovery: 3000,
      commit: 3000,
    },
    ...overrides,
  };
}

async function startGatewayServer(
  commitStatus: (
    request: GatewayProto.SignedCommitStatusRequest,
    callback: grpc.sendUnaryData<GatewayProto.CommitStatusResponse>,
  ) => void,
): Promise<string> {
  const server = new grpc.Server();
  server.addService(gatewayGrpc.GatewayService, {
    endorse: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      callback(new Error("not implemented")),
    submit: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      callback(new Error("not implemented")),
    commitStatus: (
      call: grpc.ServerUnaryCall<
        GatewayProto.SignedCommitStatusRequest,
        GatewayProto.CommitStatusResponse
      >,
      callback: grpc.sendUnaryData<GatewayProto.CommitStatusResponse>,
    ) => commitStatus(call.request, callback),
    evaluate: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      callback(new Error("not implemented")),
    chaincodeEvents: () => undefined,
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
