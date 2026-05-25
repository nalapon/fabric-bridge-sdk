import { createPrivateKey } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { FabricBridge } from "../src/FabricBridge";
import { createSyncPrivateKeySigner } from "../src/signers";
import type { BridgeContract, BridgeTransaction } from "../src/types/bridge";
import type { Signer } from "../src/types/config";

const TEST_NETWORK_DIR =
  process.env.FABRIC_TEST_NETWORK_DIR ?? path.resolve("fabric-samples/test-network");
const CHAINCODE = process.env.FABRIC_CHAINCODE ?? "basic";
const CHANNEL = process.env.FABRIC_CHANNEL ?? "mychannel";
const ORDERER_ENDPOINT = process.env.FABRIC_ORDERER_ENDPOINT;
const ORDERER_TLS_PATH =
  process.env.FABRIC_ORDERER_TLS_CERT ??
  path.join(
    TEST_NETWORK_DIR,
    "organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt",
  );

interface OrgRole {
  mspId: string;
  gatewayEndpoint: string;
  discoverySeed: string;
  ordererEndpoint?: string;
  explicitEndorsementPeers: string[];
  certPath: string;
  keyDirectory: string;
  gatewayTlsPath: string;
  discoveryTlsPath: string;
}

const ORG1: OrgRole = orgRole({
  mspId: "Org1MSP",
  gatewayEndpoint: process.env.FABRIC_ORG1_GATEWAY_ENDPOINT ?? "localhost:7051",
  discoverySeed: process.env.FABRIC_ORG1_DISCOVERY_SEED ?? "localhost:7051",
  explicitEndorsementPeers: [
    process.env.FABRIC_ORG1_EXPLICIT_PEER ?? "peer0.org1.example.com:7051",
    process.env.FABRIC_ORG2_EXPLICIT_PEER ?? "peer0.org2.example.com:9051",
  ],
  peerDomain: "org1.example.com",
  user: "User1@org1.example.com",
  peerName: "peer0.org1.example.com",
});

const ORG2: OrgRole = orgRole({
  mspId: "Org2MSP",
  gatewayEndpoint: process.env.FABRIC_ORG2_GATEWAY_ENDPOINT ?? "localhost:9051",
  discoverySeed: process.env.FABRIC_ORG2_DISCOVERY_SEED ?? "localhost:9051",
  explicitEndorsementPeers: [
    process.env.FABRIC_ORG1_EXPLICIT_PEER ?? "peer0.org1.example.com:7051",
    process.env.FABRIC_ORG2_EXPLICIT_PEER ?? "peer0.org2.example.com:9051",
  ],
  peerDomain: "org2.example.com",
  user: "User1@org2.example.com",
  peerName: "peer0.org2.example.com",
});

async function usingGateway() {
  console.log("\n[GATEWAY]");
  await withContract(ORG1, async ({ contract }) => {
    const id = `js_gateway_${Date.now()}`;
    const result = await contract.Submit(
      "CreateAsset",
      id,
      "blue",
      "5",
      "Gateway",
      "1000",
    );
    await reportSubmit(contract, id, result);
  });
}

async function usingSinglePeer() {
  console.log("\n[SINGLE PEER]");
  await withContract(ORG1, async ({ contract }) => {
    const id = `js_single_peer_${Date.now()}`;
    const tx = requireOk(contract.Transaction("CreateAsset").UseSinglePeer());
    const result = await tx.Submit(id, "red", "15", "SinglePeer", "3000");
    await reportSubmit(contract, id, result);
  });
}

async function usingExplicitEndorsement() {
  console.log("\n[EXPLICIT ENDORSEMENT]");
  await withContract(ORG1, async ({ contract }) => {
    const id = `js_explicit_${Date.now()}`;
    const tx = requireOk(
      contract
        .Transaction("CreateAsset")
        .UseEndorsingPeers(...ORG1.explicitEndorsementPeers),
    );
    const result = await tx.Submit(id, "green", "20", "Explicit", "4000");
    await reportSubmit(contract, id, result);
  });
}

async function usingOfflineGatewayProposal() {
  console.log("\n[OFFLINE PROPOSAL - GATEWAY]");
  await withContract(ORG1, async ({ bridge, contract, certificate, signer }) => {
    const id = `js_offline_gateway_${Date.now()}`;
    const tx = contract.Transaction("CreateAsset").SetProposalCreator({
      mspId: ORG1.mspId,
      credentials: certificate,
    });
    await signEndorseAndSubmitProposal(bridge, contract, tx, signer, id, [
      "purple",
      "25",
      "OfflineGateway",
      "5000",
    ]);
  });
}

async function usingOfflineSinglePeerProposal() {
  console.log("\n[OFFLINE PROPOSAL - SINGLE PEER]");
  await withContract(ORG1, async ({ bridge, contract, certificate, signer }) => {
    const id = `js_offline_single_${Date.now()}`;
    const tx = requireOk(
      contract
        .Transaction("CreateAsset")
        .SetProposalCreator({
          mspId: ORG1.mspId,
          credentials: certificate,
        })
        .UseSinglePeer(),
    );
    await signEndorseAndSubmitProposal(bridge, contract, tx, signer, id, [
      "orange",
      "30",
      "OfflineSinglePeer",
      "6000",
    ]);
  });
}

async function usingOfflineExplicitProposal() {
  console.log("\n[OFFLINE PROPOSAL - EXPLICIT ENDORSEMENT]");
  await withContract(ORG1, async ({ bridge, contract, certificate, signer }) => {
    const id = `js_offline_explicit_${Date.now()}`;
    const tx = requireOk(
      contract
        .Transaction("CreateAsset")
        .SetProposalCreator({
          mspId: ORG1.mspId,
          credentials: certificate,
        })
        .UseEndorsingPeers(...ORG1.explicitEndorsementPeers),
    );
    await signEndorseAndSubmitProposal(bridge, contract, tx, signer, id, [
      "yellow",
      "35",
      "OfflineExplicit",
      "7000",
    ]);
  });
}

async function signEndorseAndSubmitProposal(
  bridge: FabricBridge,
  contract: BridgeContract,
  tx: BridgeTransaction,
  signer: Signer,
  id: string,
  assetArgs: string[],
) {
  const unsignedProposal = requireOk(
    await tx.NewUnsignedProposal(id, ...assetArgs),
  );
  const request = unsignedProposal.SigningRequest();
  console.log("Proposal routing:", request.routing);

  const signedMessage = requireOk(
    unsignedProposal.WithSignature(await signDigest(signer, unsignedProposal.Digest())),
  );
  const signedProposal = requireOk(await bridge.NewSignedProposal(signedMessage));
  const endorsed = requireOk(await signedProposal.Endorse());
  const result = await endorsed.Submit();
  await reportSubmit(contract, id, result);
}

async function withContract(
  org: OrgRole,
  run: (context: {
    bridge: FabricBridge;
    contract: BridgeContract;
    certificate: Buffer;
    signer: Signer;
  }) => Promise<void>,
) {
  const { certificate, privateKey, gatewayTls, discoveryTls, ordererTls } =
    await loadCredentials(org);
  const signer = createSyncPrivateKeySigner(createPrivateKey(privateKey));
  const bridge = new FabricBridge({
    gatewayEndpoint: org.gatewayEndpoint,
    discoverySeed: org.discoverySeed,
    ...(org.ordererEndpoint ? { ordererEndpoint: org.ordererEndpoint } : {}),
    identity: {
      mspId: org.mspId,
      credentials: certificate,
    },
    signer,
    gatewayTls: { trustedRoots: gatewayTls },
    discoveryTls: { trustedRoots: discoveryTls },
    ordererTls: { trustedRoots: ordererTls },
  });

  const connected = await bridge.connect();
  if (!connected.isOk()) throw connected.error;

  try {
    const network = requireOk(await bridge.getNetwork(CHANNEL));
    const contract = await network.getContract(CHAINCODE);
    await run({ bridge, contract, certificate, signer });
  } finally {
    await bridge.disconnect();
  }
}

async function loadCredentials(org: OrgRole) {
  const [certificate, privateKey, gatewayTls, discoveryTls, ordererTls] =
    await Promise.all([
      fs.readFile(org.certPath),
      readFirstPrivateKey(org.keyDirectory),
      fs.readFile(org.gatewayTlsPath),
      fs.readFile(org.discoveryTlsPath),
      fs.readFile(ORDERER_TLS_PATH),
    ]);
  return { certificate, privateKey, gatewayTls, discoveryTls, ordererTls };
}

async function readFirstPrivateKey(directory: string): Promise<Buffer> {
  const files = await fs.readdir(directory);
  const keyFile = files.find((file) => file.endsWith("_sk") || file.endsWith(".pem"));
  if (!keyFile) {
    throw new Error(`No private key found in ${directory}`);
  }
  return fs.readFile(path.join(directory, keyFile));
}

async function signDigest(signer: Signer, digest: Buffer): Promise<Buffer> {
  return Buffer.from(await signer(digest));
}

async function reportSubmit(
  contract: BridgeContract,
  id: string,
  result: Awaited<ReturnType<BridgeTransaction["Submit"]>>,
) {
  if (!result.isOk()) {
    console.error("Failed:", result.error.message);
    return;
  }

  console.log(`Created: ${result.value.TransactionID()}`);
  console.log(`Block: ${result.value.CommitStatus().blockNumber.toString()}`);
  const read = await contract.Evaluate("ReadAsset", id);
  if (read.isOk()) {
    console.log("Verified:", JSON.parse(read.value.toString()));
  }
}

function orgRole(input: {
  mspId: string;
  gatewayEndpoint: string;
  discoverySeed: string;
  explicitEndorsementPeers: string[];
  peerDomain: string;
  user: string;
  peerName: string;
}): OrgRole {
  const peerOrgDir = path.join(
    TEST_NETWORK_DIR,
    "organizations/peerOrganizations",
    input.peerDomain,
  );
  return {
    mspId: input.mspId,
    gatewayEndpoint: input.gatewayEndpoint,
    discoverySeed: input.discoverySeed,
    ordererEndpoint: ORDERER_ENDPOINT,
    explicitEndorsementPeers: input.explicitEndorsementPeers,
    certPath: path.join(
      peerOrgDir,
      "users",
      input.user,
      "msp/signcerts/cert.pem",
    ),
    keyDirectory: path.join(peerOrgDir, "users", input.user, "msp/keystore"),
    gatewayTlsPath: path.join(peerOrgDir, "peers", input.peerName, "tls/ca.crt"),
    discoveryTlsPath: path.join(peerOrgDir, "peers", input.peerName, "tls/ca.crt"),
  };
}

function requireOk<T>(result: { isOk(): true; value: T } | { isOk(): false; error: Error }): T {
  if (!result.isOk()) throw result.error;
  return result.value;
}

async function main() {
  console.log("Fabric Bridge SDK example");
  console.log("Test network:", TEST_NETWORK_DIR);

  await usingGateway();
  await usingSinglePeer();
  await usingExplicitEndorsement();
  await usingOfflineGatewayProposal();
  await usingOfflineSinglePeerProposal();
  await usingOfflineExplicitProposal();

  console.log("\nDone");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
