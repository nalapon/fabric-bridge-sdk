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
  certPath: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/signcerts/cert.pem",
  ),
  keyPath: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/keystore/",
  ),
  tlsPath: path.join(
    PATH,
    "organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt",
  ),
};

const ORG2 = {
  mspId: "Org2MSP",
  peer: "peer0.org2.example.com",
  gateway: "localhost:9051",
  certPath: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/signcerts/cert.pem",
  ),
  keyPath: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/keystore/",
  ),
  tlsPath: path.join(
    PATH,
    "organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt",
  ),
};

async function loadCredentials(org: typeof ORG1) {
  const [certificate, privateKey, tlsCert] = await Promise.all([
    fs.readFile(org.certPath),
    (async () => {
      const keys = await fs.readdir(org.keyPath);
      const keyFile = keys.find((f) => f.endsWith("_sk"))!;
      return fs.readFile(path.join(org.keyPath, keyFile));
    })(),
    fs.readFile(org.tlsPath),
  ]);
  return { certificate, privateKey, tlsCert };
}

async function createSigner(privateKey: Buffer) {
  return signers.newPrivateKeySigner(createPrivateKey(privateKey));
}

async function createBridge(org: typeof ORG1, signer: any, cert: Buffer, key: Buffer, tls: Buffer) {
  return new FabricBridge({
    gatewayPeer: org.gateway,
    identity: {
      mspId: org.mspId,
      credentials: cert,
      privateKey: key,
    },
    signer,
    tlsOptions: { trustedRoots: tls, verify: false },
    discovery: true,
  });
}

async function usingOrg1Gateway() {
  console.log("\n[ORG1 - GATEWAY MODE]");
  const { certificate, privateKey, tlsCert } = await loadCredentials(ORG1);
  const signer = await createSigner(privateKey);
  const bridge = await createBridge(ORG1, signer, certificate, privateKey, tlsCert);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error(conn.error.message);

  const networkResult = await bridge.getNetwork(CHANNEL);
  if (!networkResult.isOk()) throw new Error(networkResult.error.message);
  const network = networkResult.value;
  const contract = await network.getContract(CHAINCODE);

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

  await bridge.disconnect();
}

async function usingOrg2Gateway() {
  console.log("\n[ORG2 - GATEWAY MODE]");
  const { certificate, privateKey, tlsCert } = await loadCredentials(ORG2);
  const signer = await createSigner(privateKey);
  const bridge = await createBridge(ORG2, signer, certificate, privateKey, tlsCert);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error(conn.error.message);

  const networkResult = await bridge.getNetwork(CHANNEL);
  if (!networkResult.isOk()) throw new Error(networkResult.error.message);
  const network = networkResult.value;
  const contract = await network.getContract(CHAINCODE);

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

  await bridge.disconnect();
}

async function usingOrg1Peer() {
  console.log("\n[ORG1 - PEER-TARGETED MODE]");
  const { certificate, privateKey, tlsCert } = await loadCredentials(ORG1);
  const signer = await createSigner(privateKey);
  const bridge = await createBridge(ORG1, signer, certificate, privateKey, tlsCert);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error(conn.error.message);

  const networkResult = await bridge.getNetwork(CHANNEL);
  if (!networkResult.isOk()) throw new Error(networkResult.error.message);
  const network = networkResult.value;
  const contract = await network.getContract(CHAINCODE);

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

  await bridge.disconnect();
}

async function usingOrg2Peer() {
  console.log("\n[ORG2 - PEER-TARGETED MODE]");
  const { certificate, privateKey, tlsCert } = await loadCredentials(ORG2);
  const signer = await createSigner(privateKey);
  const bridge = await createBridge(ORG2, signer, certificate, privateKey, tlsCert);

  const conn = await bridge.connect();
  if (!conn.isOk()) throw new Error(conn.error.message);

  const networkResult = await bridge.getNetwork(CHANNEL);
  if (!networkResult.isOk()) throw new Error(networkResult.error.message);
  const network = networkResult.value;
  const contract = await network.getContract(CHAINCODE);

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

  await bridge.disconnect();
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
