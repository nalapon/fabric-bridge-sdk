import { FabricBridge } from "../src/FabricBridge";
import { promises as fs } from "fs";
import path from "path";
import { createPrivateKey } from "crypto";
import { signers } from "@hyperledger/fabric-gateway";

const PATH = "/Users/naderaladelponce/Proyectos/fabric-samples/test-network";
const CHAINCODE = "basic";
const CHANNEL = "mychannel";

const ORG1 = {
  mspId: "Org1MSP",
  peer: "peer0.org1.example.com",
  gateway: "localhost:7051",
  cert: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/signcerts/cert.pem",
  ),
  keyDir: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/keystore/",
  ),
  tls: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt",
  ),
};

const ORG2 = {
  mspId: "Org2MSP",
  peer: "peer0.org2.example.com",
  gateway: "localhost:9051",
  cert: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/signcerts/cert.pem",
  ),
  keyDir: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/keystore/",
  ),
  tls: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt",
  ),
};

async function loadIdentity(org: typeof ORG1) {
  const cert = await fs.readFile(org.cert);
  const keys = await fs.readdir(org.keyDir);
  const key = await fs.readFile(
    path.join(org.keyDir, keys.find((f) => f.endsWith("_sk"))!),
  );
  const tls = await fs.readFile(org.tls);
  const signer = signers.newPrivateKeySigner(createPrivateKey(key));
  return {
    cert,
    key,
    tls,
    signer,
    mspId: org.mspId,
    peer: org.peer,
    gateway: org.gateway,
  };
}

function createBridge(config: any) {
  return new FabricBridge({
    gatewayPeer: config.gateway,
    identity: {
      mspId: config.mspId,
      credentials: config.cert,
      privateKey: config.key,
    },
    signer: config.signer,
    tlsOptions: { trustedRoots: config.tls, verify: false },
    discovery: true,
  });
}

async function usingOrg1Gateway() {
  console.log("\n[ORG1 - GATEWAY MODE]");
  const identity = await loadIdentity(ORG1);
  const bridge = createBridge(identity);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error("Org1 connection failed");

  const network = bridge.getNetwork(CHANNEL);
  const contract = await Promise.resolve(network.getContract(CHAINCODE));

  const id = `org1_gw_${Date.now()}`;
  const result = await contract.submitTransaction(
    "CreateAsset",
    id,
    "blue",
    "5",
    "Org1Gateway",
    "1000",
  );

  if (result.isOk()) {
    console.log(`Created: ${id}`);
    const read = await contract.evaluateTransaction("ReadAsset", id);
    if (read.isOk()) {
      console.log("Verified:", JSON.parse(read.value.toString()));
    }
  } else {
    console.error("Failed:", result.error.message);
  }

  bridge.disconnect();
}

async function usingOrg2Gateway() {
  console.log("\n[ORG2 - GATEWAY MODE]");
  const identity = await loadIdentity(ORG2);
  const bridge = createBridge(identity);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error("Org2 connection failed");

  const network = bridge.getNetwork(CHANNEL);
  const contract = await Promise.resolve(network.getContract(CHAINCODE));

  const id = `org2_gw_${Date.now()}`;
  const result = await contract.submitTransaction(
    "CreateAsset",
    id,
    "green",
    "10",
    "Org2Gateway",
    "2000",
  );

  if (result.isOk()) {
    console.log(`Created: ${id}`);
    const read = await contract.evaluateTransaction("ReadAsset", id);
    if (read.isOk()) {
      console.log("Verified:", JSON.parse(read.value.toString()));
    }
  } else {
    console.error("Failed:", result.error.message);
  }

  bridge.disconnect();
}

async function usingOrg1Peer() {
  console.log("\n[ORG1 - PEER-TARGETED MODE]");
  const identity = await loadIdentity(ORG1);
  const bridge = createBridge(identity);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error("Org1 connection failed");

  const network = bridge.getNetwork(CHANNEL);
  const contract = await Promise.resolve(network.getContract(CHAINCODE));

  const id = `org1_pt_${Date.now()}`;
  const tx = contract.createTransaction("CreateAsset");
  tx.setEndorsingPeers([ORG1.peer]);

  const result = await tx.submit(id, "red", "15", "Org1Peer", "3000");

  if (result.isOk()) {
    console.log(`Created: ${id}`);
    const read = await contract.evaluateTransaction("ReadAsset", id);
    if (read.isOk()) {
      console.log("Verified:", JSON.parse(read.value.toString()));
    }
  } else {
    console.error("Failed:", result.error.message);
  }

  bridge.disconnect();
}

async function usingOrg2Peer() {
  console.log("\n[ORG2 - PEER-TARGETED MODE]");
  const identity = await loadIdentity(ORG2);
  const bridge = createBridge(identity);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error("Org2 connection failed");

  const network = bridge.getNetwork(CHANNEL);
  const contract = await Promise.resolve(network.getContract(CHAINCODE));

  const id = `org2_pt_${Date.now()}`;
  const tx = contract.createTransaction("CreateAsset");
  tx.setEndorsingPeers([ORG2.peer]);

  const result = await tx.submit(id, "yellow", "20", "Org2Peer", "4000");

  if (result.isOk()) {
    console.log(`Created: ${id}`);
    const read = await contract.evaluateTransaction("ReadAsset", id);
    if (read.isOk()) {
      console.log("Verified:", JSON.parse(read.value.toString()));
    }
  } else {
    console.error("Failed:", result.error.message);
  }

  bridge.disconnect();
}

async function main() {
  console.log("Fabric Bridge SDK - Multi-Org Example\n");

  await usingOrg1Gateway();
  await usingOrg2Gateway();
  await usingOrg1Peer();
  await usingOrg2Peer();

  console.log("\nDone");
}

main().catch(console.error);
