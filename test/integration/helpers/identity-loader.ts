/**
 * Helper functions for loading identity crypto materials
 */

import { promises as fs } from 'fs';
import path from 'path';

/**
 * Load a certificate from file
 */
export async function loadCertificate(certPath: string): Promise<Buffer> {
  try {
    return await fs.readFile(certPath);
  } catch (error) {
    throw new Error(`Failed to load certificate from ${certPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load a private key from keystore directory
 * The keystore contains a file with _sk suffix
 */
export async function loadPrivateKey(keyDir: string): Promise<Buffer> {
  try {
    // Find the first file in the keystore directory (should be the private key)
    const files = await fs.readdir(keyDir);
    const keyFiles = files.filter(f => f.endsWith('_sk'));
    
    if (keyFiles.length === 0) {
      throw new Error(`No private key found in ${keyDir}. Expected file ending with '_sk'`);
    }
    
    return await fs.readFile(path.join(keyDir, keyFiles[0]));
  } catch (error) {
    throw new Error(`Failed to load private key from ${keyDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Verify that all required crypto files exist
 */
export async function verifyCryptoFiles(config: {
  certPath: string;
  keyPath: string;
  tlsCertPath: string;
}): Promise<void> {
  const errors: string[] = [];
  
  try {
    await fs.access(config.certPath);
  } catch {
    errors.push(`Certificate not found: ${config.certPath}`);
  }
  
  try {
    await fs.access(config.keyPath);
  } catch {
    errors.push(`Keystore directory not found: ${config.keyPath}`);
  }
  
  try {
    await fs.access(config.tlsCertPath);
  } catch {
    errors.push(`TLS certificate not found: ${config.tlsCertPath}`);
  }
  
  if (errors.length > 0) {
    throw new Error('Crypto file verification failed:\n' + errors.join('\n'));
  }
}
