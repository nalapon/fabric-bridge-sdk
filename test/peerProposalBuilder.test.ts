import { describe, expect, test } from "bun:test";
import * as fabricProtos from "@hyperledger/fabric-protos";
import { createHash } from "crypto";
import { buildPeerTransactionPayload, NewPeerSignedProposal } from "../src/peer/PeerContract";
import { buildPeerProposal } from "../src/peer/PeerProposalBuilder";
import {
  proposalCreatorCertificate,
  proposalCreatorMSPID,
} from "../src/offlineSigning";
import type { BridgeConfig } from "../src/types/config";

const creator = {
  mspId: "ExternalMSP",
  credentials: Buffer.from("external certificate"),
};

describe("buildPeerProposal", () => {
  test("embeds explicit proposal creator and derives transaction ID from nonce and creator", () => {
    const nonce = Buffer.alloc(24, 7);
    const proposal = buildPeerProposal({
      channelName: "mychannel",
      chaincodeName: "basic",
      transactionName: "CreateAsset",
      args: ["asset1", "blue"],
      proposalCreator: creator,
      nonce,
      timestamp: new Date("2026-05-24T00:00:00.000Z"),
    });

    const serializedCreator = serializedIdentity(creator);
    const expectedTxId = createHash("sha256")
      .update(Buffer.concat([nonce, serializedCreator]))
      .digest("hex");

    expect(proposal.transactionId).toBe(expectedTxId);
    expect(proposal.digest).toEqual(createHash("sha256").update(proposal.bytes).digest());

    const mspId = proposalCreatorMSPID(proposal.bytes);
    expect(mspId.isOk()).toBe(true);
    if (!mspId.isOk()) throw mspId.error;
    expect(mspId.value).toBe("ExternalMSP");

    const certificate = proposalCreatorCertificate(proposal.bytes);
    expect(certificate.isOk()).toBe(true);
    if (!certificate.isOk()) throw certificate.error;
    expect(certificate.value).toEqual(Buffer.from("external certificate"));
  });

  test("includes transient data in proposal payload", () => {
    const proposal = buildPeerProposal({
      channelName: "mychannel",
      chaincodeName: "basic",
      transactionName: "PrivateWrite",
      args: ["asset1"],
      transientData: {
        secret: Buffer.from("hidden-value"),
      },
      proposalCreator: creator,
      nonce: Buffer.alloc(24, 3),
      timestamp: new Date("2026-05-24T00:00:00.000Z"),
    });

    const decoded = fabricProtos.peer.Proposal.deserializeBinary(proposal.bytes);
    const payload = fabricProtos.peer.ChaincodeProposalPayload.deserializeBinary(
      decoded.getPayload_asU8(),
    );

    expect(Buffer.from(payload.getTransientmapMap().get("secret")!)).toEqual(
      Buffer.from("hidden-value"),
    );
  });

  test("strips transient data from final transaction payload", () => {
    const proposal = buildPeerProposal({
      channelName: "mychannel",
      chaincodeName: "basic",
      transactionName: "PrivateWrite",
      args: ["asset1"],
      transientData: {
        secret: Buffer.from("hidden-value"),
      },
      proposalCreator: creator,
      nonce: Buffer.alloc(24, 4),
      timestamp: new Date("2026-05-24T00:00:00.000Z"),
    });
    const decodedProposal = fabricProtos.peer.Proposal.deserializeBinary(proposal.bytes);

    const transactionPayload = buildPeerTransactionPayload(decodedProposal, [
      {
        payload: Buffer.from("proposal-response-payload"),
        endorsement: {
          endorser: Buffer.from("peer"),
          signature: Buffer.from("signature"),
        },
      },
    ]);

    const payload = fabricProtos.common.Payload.deserializeBinary(transactionPayload);
    const transaction = fabricProtos.peer.Transaction.deserializeBinary(payload.getData_asU8());
    const action = transaction.getActionsList()[0]!;
    const actionPayload = fabricProtos.peer.ChaincodeActionPayload.deserializeBinary(
      action.getPayload_asU8(),
    );
    const proposalPayload = fabricProtos.peer.ChaincodeProposalPayload.deserializeBinary(
      actionPayload.getChaincodeProposalPayload_asU8(),
    );

    expect(proposalPayload.getInput_asU8().length).toBeGreaterThan(0);
    expect(proposalPayload.getTransientmapMap().getLength()).toBe(0);
  });

  test("rejects signed proposal messages whose digest does not match proposal bytes", async () => {
    const proposal = buildPeerProposal({
      channelName: "mychannel",
      chaincodeName: "basic",
      transactionName: "CreateAsset",
      args: ["asset1"],
      proposalCreator: creator,
      nonce: Buffer.alloc(24, 9),
      timestamp: new Date("2026-05-24T00:00:00.000Z"),
    });

    const result = await NewPeerSignedProposal({} as never, bridgeConfig(), {
      bytes: proposal.bytes.toString("base64"),
      digest: Buffer.alloc(32, 1).toString("base64"),
      signature: Buffer.from("signature").toString("base64"),
      routing: {
        mode: "single-peer",
        peers: ["grpc://peer0.org1.example.com:7051"],
      },
    });

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected digest mismatch");
    expect(result.error.name).toBe("OfflineSigningError");
    expect(result.error.message).toContain("digest does not match proposal bytes");
  });
});

function serializedIdentity(input: typeof creator): Buffer {
  const identity = new fabricProtos.msp.SerializedIdentity();
  identity.setMspid(input.mspId);
  identity.setIdBytes(input.credentials);
  return Buffer.from(identity.serializeBinary());
}

function bridgeConfig(): BridgeConfig {
  return {
    gatewayEndpoint: "gateway.example.com:7051",
    identity: {
      mspId: "Org1MSP",
      credentials: Buffer.from("bridge certificate"),
    },
    signer: (digest) => Buffer.from(digest),
  };
}
