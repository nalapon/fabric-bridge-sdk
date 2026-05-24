import * as fabricProtos from "@hyperledger/fabric-protos";
import { createHash, randomBytes } from "node:crypto";
import timestampModule from "google-protobuf/google/protobuf/timestamp_pb.js";
import type { ProposalCreator } from "../types/bridge";

const { Timestamp } = timestampModule as typeof import("google-protobuf/google/protobuf/timestamp_pb.js");

export interface BuiltPeerProposal {
  bytes: Buffer;
  digest: Buffer;
  transactionId: string;
}

export function buildPeerProposal(options: {
  channelName: string;
  chaincodeName: string;
  transactionName: string;
  args: Array<string | Uint8Array>;
  transientData?: Record<string, Buffer>;
  proposalCreator: ProposalCreator;
  nonce?: Buffer;
  timestamp?: Date;
}): BuiltPeerProposal {
  const creator = serializedIdentity(options.proposalCreator);
  const nonce = options.nonce ? Buffer.from(options.nonce) : randomBytes(24);
  const transactionId = createHash("sha256").update(Buffer.concat([nonce, creator])).digest("hex");

  const chaincodeId = new fabricProtos.peer.ChaincodeID();
  chaincodeId.setName(options.chaincodeName);

  const chaincodeInput = new fabricProtos.peer.ChaincodeInput();
  chaincodeInput.setArgsList([options.transactionName, ...options.args].map(asBytes));

  const chaincodeSpec = new fabricProtos.peer.ChaincodeSpec();
  chaincodeSpec.setType(fabricProtos.peer.ChaincodeSpec.Type.GOLANG);
  chaincodeSpec.setChaincodeId(chaincodeId);
  chaincodeSpec.setInput(chaincodeInput);

  const invocationSpec = new fabricProtos.peer.ChaincodeInvocationSpec();
  invocationSpec.setChaincodeSpec(chaincodeSpec);

  const payload = new fabricProtos.peer.ChaincodeProposalPayload();
  payload.setInput(invocationSpec.serializeBinary());
  const transientMap = payload.getTransientmapMap();
  for (const [key, value] of Object.entries(options.transientData ?? {})) {
    transientMap.set(key, value);
  }

  const chaincodeHeaderExtension = new fabricProtos.peer.ChaincodeHeaderExtension();
  chaincodeHeaderExtension.setChaincodeId(chaincodeId);

  const channelHeader = new fabricProtos.common.ChannelHeader();
  channelHeader.setType(fabricProtos.common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(options.channelName);
  channelHeader.setTxId(transactionId);
  channelHeader.setTimestamp(Timestamp.fromDate(options.timestamp ?? new Date()));
  channelHeader.setExtension$(chaincodeHeaderExtension.serializeBinary());

  const signatureHeader = new fabricProtos.common.SignatureHeader();
  signatureHeader.setCreator(creator);
  signatureHeader.setNonce(nonce);

  const header = new fabricProtos.common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  header.setSignatureHeader(signatureHeader.serializeBinary());

  const proposal = new fabricProtos.peer.Proposal();
  proposal.setHeader(header.serializeBinary());
  proposal.setPayload(payload.serializeBinary());

  const bytes = Buffer.from(proposal.serializeBinary());
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest(),
    transactionId,
  };
}

function serializedIdentity(proposalCreator: ProposalCreator): Buffer {
  const identity = new fabricProtos.msp.SerializedIdentity();
  identity.setMspid(proposalCreator.mspId);
  identity.setIdBytes(proposalCreator.credentials);
  return Buffer.from(identity.serializeBinary());
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value) : value;
}
