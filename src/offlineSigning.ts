import { createHash } from "crypto";
import * as fabricGatewayProtos from "@hyperledger/fabric-protos";
import { Result } from "better-result";
import { OfflineSigningError } from "./errors/index";
import type {
  OfflineSigningRouting,
  SignedMessage,
  SigningRequest,
} from "./types/bridge";

import fabproto6 from "fabric-protos";

export function toBase64(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function digestBytes(bytes: Buffer | Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function normalizeSignature(
  signature: Buffer | Uint8Array | string,
): Result<string, OfflineSigningError> {
  if (typeof signature === "string") {
    const decoded = decodeBase64(signature, "signature");
    if (!decoded.isOk()) {
      return Result.err(decoded.error);
    }
    return Result.ok(toBase64(decoded.value));
  }
  return Result.ok(toBase64(signature));
}

export function signingRequest(
  bytes: Buffer | Uint8Array,
  digest: Buffer | Uint8Array,
  routing?: OfflineSigningRouting,
): SigningRequest {
  return {
    bytes: toBase64(bytes),
    digest: toBase64(digest),
    ...(routing ? { routing } : {}),
  };
}

export function signedMessage(
  request: SigningRequest,
  signature: Buffer | Uint8Array | string,
): Result<SignedMessage, OfflineSigningError> {
  const normalized = normalizeSignature(signature);
  if (!normalized.isOk()) {
    return Result.err(normalized.error);
  }

  return Result.ok({
    ...request,
    signature: normalized.value,
  });
}

export function decodeSignedMessage(message: SignedMessage): Result<
  {
    bytes: Buffer;
    digest: Buffer;
    signature: Buffer;
    routing?: OfflineSigningRouting;
  },
  OfflineSigningError
> {
  const bytes = decodeBase64(message.bytes, "bytes");
  if (!bytes.isOk()) {
    return Result.err(bytes.error);
  }
  const digest = decodeBase64(message.digest, "digest");
  if (!digest.isOk()) {
    return Result.err(digest.error);
  }
  const signature = decodeBase64(message.signature, "signature");
  if (!signature.isOk()) {
    return Result.err(signature.error);
  }

  return Result.ok({
    bytes: bytes.value,
    digest: digest.value,
    signature: signature.value,
    routing: message.routing,
  });
}

export function validateProposalRouting(
  routing: OfflineSigningRouting | undefined,
): Result<OfflineSigningRouting, OfflineSigningError> {
  if (!routing) {
    return Result.err(
      new OfflineSigningError({
        field: "routing",
        message: "proposal signing request requires routing",
      }),
    );
  }

  if (routing.mode === "gateway-default") {
    return Result.ok(routing);
  }

  if (!Array.isArray(routing.peers) || routing.peers.length === 0) {
    return Result.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: `${routing.mode} routing requires at least one peer endpoint`,
      }),
    );
  }

  return Result.ok({
    mode: routing.mode,
    peers: [...routing.peers],
  });
}

export function proposalCreatorIdentity(
  proposalBytes: Buffer | Uint8Array,
): Result<Buffer, OfflineSigningError> {
  try {
    const proposal = fabproto6.protos.Proposal.decode(
      unwrapProposalBytes(proposalBytes),
    );
    const header = fabproto6.common.Header.decode(proposal.header);
    const signatureHeader = fabproto6.common.SignatureHeader.decode(
      header.signature_header,
    );
    return Result.ok(Buffer.from(signatureHeader.creator));
  } catch (error) {
    return Result.err(
      new OfflineSigningError({
        field: "bytes",
        message: `unable to inspect proposal creator identity: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
}

export function proposalCreatorMSPID(
  proposalBytes: Buffer | Uint8Array,
): Result<string, OfflineSigningError> {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return Result.err(creator.error);
  try {
    const identity = fabproto6.msp.SerializedIdentity.decode(creator.value);
    return Result.ok(identity.mspid);
  } catch (error) {
    return Result.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator MSPID: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
}

export function proposalCreatorCertificate(
  proposalBytes: Buffer | Uint8Array,
): Result<Buffer, OfflineSigningError> {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return Result.err(creator.error);
  try {
    const identity = fabproto6.msp.SerializedIdentity.decode(creator.value);
    return Result.ok(Buffer.from(identity.id_bytes));
  } catch (error) {
    return Result.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator certificate: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
}

function unwrapProposalBytes(proposalBytes: Buffer | Uint8Array): Buffer {
  const bytes = Buffer.from(proposalBytes);
  try {
    const proposedTransaction =
      fabricGatewayProtos.gateway.ProposedTransaction.deserializeBinary(bytes);
    const signedProposal = proposedTransaction.getProposal();
    const rawProposalBytes = signedProposal?.getProposalBytes_asU8();
    if (rawProposalBytes && rawProposalBytes.length > 0) {
      return Buffer.from(rawProposalBytes);
    }
  } catch {
    // Peer-targeted proposal signing uses raw Fabric proposal bytes.
  }
  return bytes;
}

function decodeBase64(
  value: string,
  field: string,
): Result<Buffer, OfflineSigningError> {
  if (typeof value !== "string" || value.length === 0) {
    return Result.err(
      new OfflineSigningError({
        field,
        message: `${field} must be a non-empty base64 string`,
      }),
    );
  }

  try {
    const decoded = Buffer.from(value, "base64");
    if (
      decoded.length === 0 ||
      decoded.toString("base64") !==
        value.replace(/=+$/, "") + "=".repeat((4 - (value.length % 4)) % 4)
    ) {
      // Fall back to a round-trip check that tolerates valid padding only.
      const normalized = decoded.toString("base64");
      if (normalized !== value) {
        return Result.err(
          new OfflineSigningError({
            field,
            message: `${field} is not valid canonical base64`,
          }),
        );
      }
    }
    return Result.ok(decoded);
  } catch {
    return Result.err(
      new OfflineSigningError({
        field,
        message: `${field} is not valid base64`,
      }),
    );
  }
}
