import { describe, expect, test } from "bun:test";
import { EndorsementError } from "../src/errors/index";
import {
  buildPeerTransactionPayload,
  validateExplicitProposalResponses,
} from "../src/peer/PeerContract";
import { buildPeerProposal } from "../src/peer/PeerProposalBuilder";
import * as fabricProtos from "@hyperledger/fabric-protos";

describe("explicit endorsement validation", () => {
  test("requires byte-identical proposal response payloads", () => {
    expect(() =>
      validateExplicitProposalResponses([
        proposalResponse(Buffer.from("payload-a"), "peer-a"),
        proposalResponse(Buffer.from("payload-b"), "peer-b"),
      ]),
    ).toThrow(EndorsementError);
  });

  test("failure from any selected peer fails validation", () => {
    expect(() =>
      validateExplicitProposalResponses([
        proposalResponse(Buffer.from("payload"), "peer-a"),
        {
          response: { status: 500, message: "selected peer failed", payload: Buffer.alloc(0) },
          payload: Buffer.from("payload"),
          endorsement: { endorser: Buffer.from("peer-b"), signature: Buffer.from("sig-b") },
        },
      ]),
    ).toThrow(EndorsementError);
  });

  test("final transaction payload includes every valid endorsement", () => {
    const proposal = buildPeerProposal({
      channelName: "mychannel",
      chaincodeName: "basic",
      transactionName: "CreateAsset",
      args: ["asset1"],
      proposalCreator: {
        mspId: "Org1MSP",
        credentials: Buffer.from("certificate"),
      },
      nonce: Buffer.alloc(24, 8),
      timestamp: new Date("2026-05-24T00:00:00.000Z"),
    });
    const decodedProposal = fabricProtos.peer.Proposal.deserializeBinary(proposal.bytes);
    const payload = buildPeerTransactionPayload(decodedProposal, [
      proposalResponse(Buffer.from("matching-payload"), "peer-a"),
      proposalResponse(Buffer.from("matching-payload"), "peer-b"),
    ]);

    const decodedPayload = fabricProtos.common.Payload.deserializeBinary(payload);
    const transaction = fabricProtos.peer.Transaction.deserializeBinary(decodedPayload.getData_asU8());
    const actionPayload = fabricProtos.peer.ChaincodeActionPayload.deserializeBinary(
      transaction.getActionsList()[0]!.getPayload_asU8(),
    );

    expect(actionPayload.getAction()?.getEndorsementsList()).toHaveLength(2);
  });
});

function proposalResponse(payload: Buffer, peer: string) {
  return {
    response: {
      status: 200,
      message: "",
      payload: Buffer.from("chaincode-result"),
    },
    payload,
    endorsement: {
      endorser: Buffer.from(peer),
      signature: Buffer.from(`signature-${peer}`),
    },
  };
}
