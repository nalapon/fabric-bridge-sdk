/**
 * Helper function to create a signer from a private key
 * Uses fabric-gateway's official newPrivateKeySigner for compatibility
 */

import { createPrivateKey } from 'crypto';
import { signers } from '@hyperledger/fabric-gateway';

/**
 * Create a signer function from a PEM-encoded private key
 * Uses fabric-gateway's official implementation for proper signature format
 */
export function createSigner(privateKeyPem: Buffer): (digest: Uint8Array) => Promise<Uint8Array> {
  const privateKey = createPrivateKey(privateKeyPem);
  return signers.newPrivateKeySigner(privateKey);
}
