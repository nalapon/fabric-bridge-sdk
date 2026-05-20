import { sign as nodeSign, type KeyObject } from "node:crypto";
import { p256, p384 } from "@noble/curves/nist";
import type { Signer } from "./types/config";

const namedCurves = {
  "P-256": p256,
  "P-384": p384,
} as const;

/**
 * Creates a private-key signer that returns the signature synchronously.
 *
 * Use this signer when peer targeting is enabled through fabric-network. The
 * legacy fabric-network signing path cannot await Promise-returning signers.
 */
export function createSyncPrivateKeySigner(key: KeyObject): Signer {
  if (key.type !== "private") {
    throw new Error(`Invalid key type: ${key.type}`);
  }

  switch (key.asymmetricKeyType) {
    case "ec":
      return createSyncECPrivateKeySigner(key);
    case "ed25519":
      return (message) => nodeSign(null, message, key);
    default:
      throw new Error(`Unsupported private key type: ${String(key.asymmetricKeyType)}`);
  }
}

function createSyncECPrivateKeySigner(key: KeyObject): Signer {
  const { crv, d } = key.export({ format: "jwk" });
  if (!crv) {
    throw new Error("Missing EC curve name");
  }
  if (!d) {
    throw new Error("Missing EC private key value");
  }

  const curve = namedCurves[crv as keyof typeof namedCurves];
  if (!curve) {
    throw new Error(`Unsupported curve: ${crv}`);
  }

  const privateKey = Buffer.from(d, "base64url");
  return (digest) => Buffer.from(curve.sign(digest, privateKey, { lowS: true }).toBytes("der"));
}
