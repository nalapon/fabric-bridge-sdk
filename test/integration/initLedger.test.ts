/**
 * Integration tests for GetAllAssets with fabric-bridge-sdk
 * 
 * Prerequisites:
 * - fabric-samples test-network must be running
 * - asset-transfer-basic chaincode must be deployed
 * 
 * To setup:
 * cd /Users/naderaladelponce/Proyectos/fabric-samples/test-network
 * ./network.sh up createChannel
 * ./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-typescript -ccl typescript
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { FabricBridge } from '../../src/FabricBridge';
import { loadCertificate, loadPrivateKey, verifyCryptoFiles } from './helpers/identity-loader';
import { createSigner } from './helpers/signer';
import { TEST_CONFIG } from './config';
import type { BridgeContract } from '../../src/types/bridge';

// Helper to resolve contract (handles both sync and async getContract)
async function resolveContract(contractOrPromise: BridgeContract | Promise<BridgeContract>): Promise<BridgeContract> {
  return Promise.resolve(contractOrPromise);
}

describe('Integration: GetAllAssets with fabric-bridge-sdk', () => {
  let bridgeOrg1: FabricBridge;
  let bridgeOrg2: FabricBridge;
  let isSetupComplete = false;
  
  beforeAll(async () => {
    console.log('Setting up test connections...');
    
    // Verify crypto files exist before attempting connections
    try {
      await verifyCryptoFiles(TEST_CONFIG.org1);
      console.log('✓ Org1 crypto files verified');
    } catch (error) {
      console.error('Org1 crypto files verification failed:', error);
      console.error('Make sure fabric-samples test-network is running and chaincode is deployed');
      throw error;
    }
    
    try {
      await verifyCryptoFiles(TEST_CONFIG.org2);
      console.log('✓ Org2 crypto files verified');
    } catch (error) {
      console.error('Org2 crypto files verification failed:', error);
      throw error;
    }
    
    // Setup Org1 connection
    const certOrg1 = await loadCertificate(TEST_CONFIG.org1.certPath);
    const keyOrg1 = await loadPrivateKey(TEST_CONFIG.org1.keyPath);
    const tlsCertOrg1 = await loadCertificate(TEST_CONFIG.org1.tlsCertPath);
    const signerOrg1 = createSigner(keyOrg1);
    
    bridgeOrg1 = new FabricBridge({
      gatewayPeer: TEST_CONFIG.org1.gatewayPeer,
      identity: {
        mspId: TEST_CONFIG.org1.mspId,
        credentials: certOrg1,
        privateKey: keyOrg1, // Required for peer-targeted mode
      },
      signer: signerOrg1,
      tlsOptions: {
        trustedRoots: tlsCertOrg1,
        verify: false,
      },
      discovery: true,
      timeouts: {
        endorse: TEST_CONFIG.timeout,
        submit: TEST_CONFIG.timeout,
        commit: TEST_CONFIG.timeout * 2,
        evaluate: TEST_CONFIG.timeout,
        discovery: 10000,
      },
    });
    
    const connectResult1 = await bridgeOrg1.connect();
    if (!connectResult1.isOk()) {
      throw new Error(`Failed to connect as Org1: ${connectResult1.error.message}`);
    }
    console.log('✓ Org1 connected successfully');
    
    // Setup Org2 connection
    const certOrg2 = await loadCertificate(TEST_CONFIG.org2.certPath);
    const keyOrg2 = await loadPrivateKey(TEST_CONFIG.org2.keyPath);
    const tlsCertOrg2 = await loadCertificate(TEST_CONFIG.org2.tlsCertPath);
    const signerOrg2 = createSigner(keyOrg2);
    
    bridgeOrg2 = new FabricBridge({
      gatewayPeer: TEST_CONFIG.org2.gatewayPeer,
      identity: {
        mspId: TEST_CONFIG.org2.mspId,
        credentials: certOrg2,
        privateKey: keyOrg2, // Required for peer-targeted mode
      },
      signer: signerOrg2,
      tlsOptions: {
        trustedRoots: tlsCertOrg2,
        verify: false,
      },
      discovery: true,
      timeouts: {
        endorse: TEST_CONFIG.timeout,
        submit: TEST_CONFIG.timeout,
        commit: TEST_CONFIG.timeout * 2,
        evaluate: TEST_CONFIG.timeout,
        discovery: 10000,
      },
    });
    
    const connectResult2 = await bridgeOrg2.connect();
    if (!connectResult2.isOk()) {
      throw new Error(`Failed to connect as Org2: ${connectResult2.error.message}`);
    }
    console.log('✓ Org2 connected successfully');
    
    isSetupComplete = true;
    console.log('✓ Test setup complete');
  });
  
  afterAll(() => {
    console.log('Cleaning up test connections...');
    bridgeOrg1?.disconnect();
    bridgeOrg2?.disconnect();
    console.log('✓ Cleanup complete');
  });

  test('should verify test setup completed', () => {
    expect(isSetupComplete).toBe(true);
  });

  test('should call GetAllAssets successfully with gateway mode (default)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    console.log('Calling GetAllAssets with gateway mode...');
    const result = await contract.evaluateTransaction('GetAllAssets');
    
    if (!result.isOk()) {
      console.error('✗ GetAllAssets failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log('✓ GetAllAssets succeeded with gateway mode');
      expect(result.value).toBeDefined();
      expect(Buffer.isBuffer(result.value)).toBe(true);
    }
  });

  test('should call GetAllAssets successfully with peer-targeted mode to peer0.org1', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const tx = contract.createTransaction('GetAllAssets');
    tx.setEndorsingPeers([TEST_CONFIG.org1.peerName]);
    
    console.log(`Calling GetAllAssets with peer-targeted mode to ${TEST_CONFIG.org1.peerName}...`);
    const result = await tx.submit();
    
    if (!result.isOk()) {
      console.error('✗ GetAllAssets failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ GetAllAssets succeeded with peer-targeted mode to ${TEST_CONFIG.org1.peerName}`);
      expect(result.value).toBeDefined();
      expect(result.value.getResult).toBeDefined();
      
      const txResult = result.value.getResult();
      expect(txResult).toBeDefined();
      expect(Buffer.isBuffer(txResult)).toBe(true);
    }
  });

  test('should call GetAllAssets successfully with peer-targeted mode to peer0.org2', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg2.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const tx = contract.createTransaction('GetAllAssets');
    tx.setEndorsingPeers([TEST_CONFIG.org2.peerName]);
    
    console.log(`Calling GetAllAssets with peer-targeted mode to ${TEST_CONFIG.org2.peerName}...`);
    const result = await tx.submit();
    
    if (!result.isOk()) {
      console.error('✗ GetAllAssets failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ GetAllAssets succeeded with peer-targeted mode to ${TEST_CONFIG.org2.peerName}`);
      expect(result.value).toBeDefined();
      expect(result.value.getResult).toBeDefined();
      
      const txResult = result.value.getResult();
      expect(txResult).toBeDefined();
      expect(Buffer.isBuffer(txResult)).toBe(true);
    }
  });

  // SUBMIT TRANSACTION TESTS (Invokes that modify ledger)

  test('should create asset with gateway mode (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_org1_gateway`;
    const color = 'blue';
    const size = '5';
    const owner = 'Org1Gateway';
    const value = '1000';
    
    console.log(`Creating asset ${assetId} with gateway mode...`);
    const result = await contract.submitTransaction('CreateAsset', assetId, color, size, owner, value);
    
    if (!result.isOk()) {
      console.error('✗ CreateAsset failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ Asset ${assetId} created successfully with gateway mode`);
      expect(result.value).toBeDefined();
      expect(Buffer.isBuffer(result.value)).toBe(true);
      
      // VERIFICATION: Read the asset to confirm it really exists
      console.log(`Verifying asset ${assetId} exists on ledger...`);
      const readResult = await contract.evaluateTransaction('ReadAsset', assetId);
      expect(readResult.isOk()).toBe(true);
      
      if (readResult.isOk()) {
        const assetData = JSON.parse(readResult.value.toString());
        console.log(`✓ Asset verified on ledger:`, assetData);
        expect(assetData.ID).toBe(assetId);
        expect(assetData.Color).toBe(color);
        expect(assetData.Size).toBe(parseInt(size));
        expect(assetData.Owner).toBe(owner);
        expect(assetData.AppraisedValue).toBe(parseInt(value));
      }
    }
  });

  test('should create asset with peer-targeted mode to peer0.org1 (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_org1_peer`;
    const color = 'red';
    const size = '10';
    const owner = 'Org1Peer';
    const value = '2000';
    
    const tx = contract.createTransaction('CreateAsset');
    tx.setEndorsingPeers([TEST_CONFIG.org1.peerName]);
    
    console.log(`Creating asset ${assetId} with peer-targeted mode to ${TEST_CONFIG.org1.peerName}...`);
    const result = await tx.submit(assetId, color, size, owner, value);
    
    if (!result.isOk()) {
      console.error('✗ CreateAsset failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ Asset ${assetId} created successfully with peer-targeted mode to ${TEST_CONFIG.org1.peerName}`);
      expect(result.value).toBeDefined();
      expect(result.value.getResult).toBeDefined();
      
      const txResult = result.value.getResult();
      expect(txResult).toBeDefined();
      
      // VERIFICATION: Read the asset to confirm it really exists with correct values
      console.log(`Verifying asset ${assetId} exists on ledger with peer-targeted values...`);
      const readResult = await contract.evaluateTransaction('ReadAsset', assetId);
      expect(readResult.isOk()).toBe(true);
      
      if (readResult.isOk()) {
        const assetData = JSON.parse(readResult.value.toString());
        console.log(`✓ Asset verified on ledger:`, assetData);
        expect(assetData.ID).toBe(assetId);
        expect(assetData.Color).toBe(color);
        expect(assetData.Size).toBe(parseInt(size));
        expect(assetData.Owner).toBe(owner);
        expect(assetData.AppraisedValue).toBe(parseInt(value));
      }
    }
  });

  test('should create asset with peer-targeted mode to peer0.org2 (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg2.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_org2_peer`;
    const color = 'green';
    const size = '15';
    const owner = 'Org2Peer';
    const value = '3000';
    
    const tx = contract.createTransaction('CreateAsset');
    tx.setEndorsingPeers([TEST_CONFIG.org2.peerName]);
    
    console.log(`Creating asset ${assetId} with peer-targeted mode to ${TEST_CONFIG.org2.peerName}...`);
    const result = await tx.submit(assetId, color, size, owner, value);
    
    if (!result.isOk()) {
      console.error('✗ CreateAsset failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ Asset ${assetId} created successfully with peer-targeted mode to ${TEST_CONFIG.org2.peerName}`);
      expect(result.value).toBeDefined();
      expect(result.value.getResult).toBeDefined();
      
      const txResult = result.value.getResult();
      expect(txResult).toBeDefined();
      
      // VERIFICATION: Read the asset from Org1's connection to verify it's visible network-wide
      console.log(`Verifying asset ${assetId} is queryable from Org1's connection...`);
      const networkOrg1 = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
      const contractOrg1 = await resolveContract(networkOrg1.getContract(TEST_CONFIG.chaincodeName));
      const readResult = await contractOrg1.evaluateTransaction('ReadAsset', assetId);
      expect(readResult.isOk()).toBe(true);
      
      if (readResult.isOk()) {
        const assetData = JSON.parse(readResult.value.toString());
        console.log(`✓ Asset visible from Org1:`, assetData);
        expect(assetData.ID).toBe(assetId);
        expect(assetData.Owner).toBe(owner);
        console.log(`✓ Asset created by Org2 is visible to Org1 - network-wide consensus verified`);
      }
    }
  });

  test('should create asset with multiple endorsing peers (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_multi_peer`;
    const color = 'yellow';
    const size = '20';
    const owner = 'MultiPeer';
    const value = '4000';
    
    const tx = contract.createTransaction('CreateAsset');
    // Set both peers as endorsers - should collect endorsements from both
    tx.setEndorsingPeers([TEST_CONFIG.org1.peerName, TEST_CONFIG.org2.peerName]);
    
    console.log(`Creating asset ${assetId} with multiple endorsing peers (${TEST_CONFIG.org1.peerName} + ${TEST_CONFIG.org2.peerName})...`);
    const result = await tx.submit(assetId, color, size, owner, value);
    
    if (!result.isOk()) {
      console.error('✗ CreateAsset failed:', result.error);
      console.error('Error details:', JSON.stringify(result.error, null, 2));
    }
    
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      console.log(`✓ Asset ${assetId} created successfully with multiple endorsing peers`);
      expect(result.value).toBeDefined();
      expect(result.value.getResult).toBeDefined();
      
      const txResult = result.value.getResult();
      expect(txResult).toBeDefined();
      
      // VERIFICATION 1: Asset exists and has correct values
      console.log(`Verifying asset ${assetId} exists with correct values...`);
      const readResult = await contract.evaluateTransaction('ReadAsset', assetId);
      expect(readResult.isOk()).toBe(true);
      
      if (readResult.isOk()) {
        const assetData = JSON.parse(readResult.value.toString());
        console.log(`✓ Asset data:`, assetData);
        expect(assetData.ID).toBe(assetId);
        expect(assetData.Color).toBe(color);
        expect(assetData.Owner).toBe(owner);
      }
      
      // VERIFICATION 2: Query from Org2 to verify multi-peer endorsement worked
      console.log(`Querying asset ${assetId} from Org2 connection to verify consensus...`);
      const networkOrg2 = bridgeOrg2.getNetwork(TEST_CONFIG.channelName);
      const contractOrg2 = await resolveContract(networkOrg2.getContract(TEST_CONFIG.chaincodeName));
      const readFromOrg2 = await contractOrg2.evaluateTransaction('ReadAsset', assetId);
      expect(readFromOrg2.isOk()).toBe(true);
      
      if (readFromOrg2.isOk()) {
        const assetDataOrg2 = JSON.parse(readFromOrg2.value.toString());
        console.log(`✓ Asset visible from Org2:`, assetDataOrg2);
        expect(assetDataOrg2.ID).toBe(assetId);
        expect(assetDataOrg2.Owner).toBe(owner);
        console.log(`✓ Multi-peer endorsement verified - asset committed and visible to both organizations`);
      }
    }
  });

  test('should transfer asset ownership with gateway mode (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_transfer`;
    const originalOwner = 'OriginalOwner';
    const newOwner = 'NewOwner';
    
    // First create an asset
    console.log(`Creating asset ${assetId} for transfer test...`);
    const createResult = await contract.submitTransaction('CreateAsset', assetId, 'orange', '30', originalOwner, '6000');
    expect(createResult.isOk()).toBe(true);
    
    // VERIFICATION: Read asset before transfer
    console.log(`Reading asset ${assetId} before transfer...`);
    const beforeResult = await contract.evaluateTransaction('ReadAsset', assetId);
    expect(beforeResult.isOk()).toBe(true);
    
    let ownerBefore = '';
    if (beforeResult.isOk()) {
      const assetData = JSON.parse(beforeResult.value.toString());
      ownerBefore = assetData.Owner;
      console.log(`✓ Owner before transfer: ${ownerBefore}`);
      expect(ownerBefore).toBe(originalOwner);
    }
    
    // Now transfer ownership
    console.log(`Transferring asset ${assetId} from ${originalOwner} to ${newOwner}...`);
    const transferResult = await contract.submitTransaction('TransferAsset', assetId, newOwner);
    
    if (!transferResult.isOk()) {
      console.error('✗ TransferAsset failed:', transferResult.error);
      console.error('Error details:', JSON.stringify(transferResult.error, null, 2));
    }
    
    expect(transferResult.isOk()).toBe(true);
    if (transferResult.isOk()) {
      console.log(`✓ Asset ${assetId} transferred successfully`);
      expect(transferResult.value).toBeDefined();
      
      // VERIFICATION: Read asset after transfer to confirm owner changed
      console.log(`Reading asset ${assetId} after transfer...`);
      const afterResult = await contract.evaluateTransaction('ReadAsset', assetId);
      expect(afterResult.isOk()).toBe(true);
      
      if (afterResult.isOk()) {
        const assetData = JSON.parse(afterResult.value.toString());
        const ownerAfter = assetData.Owner;
        console.log(`✓ Owner after transfer: ${ownerAfter}`);
        expect(ownerAfter).toBe(newOwner);
        expect(ownerAfter).not.toBe(ownerBefore);
        console.log(`✓ Ownership transfer verified: ${ownerBefore} → ${ownerAfter}`);
      }
    }
  });

  test('should handle error for non-existent asset (error handling)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const nonExistentAssetId = `nonexistent_${Date.now()}`;
    
    console.log(`Attempting to read non-existent asset ${nonExistentAssetId}...`);
    const result = await contract.evaluateTransaction('ReadAsset', nonExistentAssetId);
    
    // This should fail - asset doesn't exist
    expect(result.isOk()).toBe(false);
    if (!result.isOk()) {
      console.log(`✓ Correctly received error for non-existent asset: ${result.error.message}`);
      expect(result.error).toBeDefined();
      expect(result.error._tag).toBe('EvaluationError');
    }
  });

  test('should update existing asset with gateway mode (submit transaction)', async () => {
    expect(isSetupComplete).toBe(true);
    
    const network = bridgeOrg1.getNetwork(TEST_CONFIG.channelName);
    const contract = await resolveContract(network.getContract(TEST_CONFIG.chaincodeName));
    
    const assetId = `asset_${Date.now()}_update`;
    
    // First create an asset
    console.log(`Creating asset ${assetId} for update test...`);
    const createResult = await contract.submitTransaction('CreateAsset', assetId, 'pink', '35', 'UpdateOwner', '7000');
    expect(createResult.isOk()).toBe(true);
    
    // VERIFICATION: Read asset before update
    console.log(`Reading asset ${assetId} before update...`);
    const beforeResult = await contract.evaluateTransaction('ReadAsset', assetId);
    expect(beforeResult.isOk()).toBe(true);
    
    let valuesBefore: any;
    if (beforeResult.isOk()) {
      valuesBefore = JSON.parse(beforeResult.value.toString());
      console.log(`✓ Values before update:`, valuesBefore);
      expect(valuesBefore.Color).toBe('pink');
      expect(valuesBefore.Size).toBe(35);
      expect(valuesBefore.Owner).toBe('UpdateOwner');
      expect(valuesBefore.AppraisedValue).toBe(7000);
    }
    
    // Now update the asset with NEW values
    const newColor = 'cyan';
    const newSize = '40';
    const newOwner = 'UpdatedOwner';
    const newValue = '8000';
    
    console.log(`Updating asset ${assetId} with new values...`);
    const updateResult = await contract.submitTransaction('UpdateAsset', assetId, newColor, newSize, newOwner, newValue);
    
    if (!updateResult.isOk()) {
      console.error('✗ UpdateAsset failed:', updateResult.error);
      console.error('Error details:', JSON.stringify(updateResult.error, null, 2));
    }
    
    expect(updateResult.isOk()).toBe(true);
    if (updateResult.isOk()) {
      console.log(`✓ Asset ${assetId} updated successfully`);
      expect(updateResult.value).toBeDefined();
      
      // VERIFICATION: Read asset after update to confirm values changed
      console.log(`Reading asset ${assetId} after update...`);
      const afterResult = await contract.evaluateTransaction('ReadAsset', assetId);
      expect(afterResult.isOk()).toBe(true);
      
      if (afterResult.isOk()) {
        const valuesAfter = JSON.parse(afterResult.value.toString());
        console.log(`✓ Values after update:`, valuesAfter);
        
        // Verify all fields were updated
        expect(valuesAfter.Color).toBe(newColor);
        expect(valuesAfter.Color).not.toBe(valuesBefore.Color);
        
        expect(valuesAfter.Size).toBe(parseInt(newSize));
        expect(valuesAfter.Size).not.toBe(valuesBefore.Size);
        
        expect(valuesAfter.Owner).toBe(newOwner);
        expect(valuesAfter.Owner).not.toBe(valuesBefore.Owner);
        
        expect(valuesAfter.AppraisedValue).toBe(parseInt(newValue));
        expect(valuesAfter.AppraisedValue).not.toBe(valuesBefore.AppraisedValue);
        
        console.log(`✓ All fields updated verified:`);
        console.log(`  Color: ${valuesBefore.Color} → ${valuesAfter.Color}`);
        console.log(`  Size: ${valuesBefore.Size} → ${valuesAfter.Size}`);
        console.log(`  Owner: ${valuesBefore.Owner} → ${valuesAfter.Owner}`);
        console.log(`  Value: ${valuesBefore.AppraisedValue} → ${valuesAfter.AppraisedValue}`);
      }
    }
  });
});
