/**
 * Test configuration for fabric-bridge-sdk integration tests
 * Assumes fabric-samples test-network is running with asset-transfer-basic deployed
 */

// Base path for fabric-samples (can be overridden via environment variable)
const FABRIC_SAMPLES_PATH = process.env.FABRIC_SAMPLES_PATH || '/Users/naderaladelponce/Proyectos/fabric-samples';
const TEST_NETWORK_PATH = `${FABRIC_SAMPLES_PATH}/test-network`;

export const TEST_CONFIG = {
  // Network settings
  channelName: 'mychannel',
  chaincodeName: 'basic',
  
  // Test timeout (ms)
  timeout: 60000,
  
  // Org1 settings
  org1: {
    mspId: 'Org1MSP',
    peerName: 'peer0.org1.example.com',
    gatewayPeer: 'localhost:7051',  // Org1's peer endpoint
    certPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/signcerts/cert.pem`,
    keyPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/keystore/`,
    tlsCertPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt`,
  },
  
  // Org2 settings
  org2: {
    mspId: 'Org2MSP',
    peerName: 'peer0.org2.example.com',
    gatewayPeer: 'localhost:9051',  // Org2's peer endpoint
    certPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/signcerts/cert.pem`,
    keyPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/keystore/`,
    tlsCertPath: `${TEST_NETWORK_PATH}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt`,
  },
};
