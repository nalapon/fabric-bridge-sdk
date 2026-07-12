import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import * as fabricGateway from "@hyperledger/fabric-gateway";
import { EndorsementError } from "../src/errors/index";
import { GatewayNetwork } from "../src/gateway/GatewayContract";
import type { BridgeConfig } from "../src/types/config";

describe("Gateway endorsement details", () => {
  test("SubmitAsync preserves bounded chaincode details from EndorseError", async () => {
    const contract = await gatewayContractThatRejectsEndorsement();

    const result = await contract.SubmitAsync("RegisterController", "input");

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected endorsement failure");
    expect(result.error).toBeInstanceOf(EndorsementError);
    expect(result.error.details).toEqual([
      {
        message: "chaincode response 500, UNAUTHORIZED: a Fabric admin identity is required",
        endpoint: "peer0-org1:7051",
        mspId: "Org1MSP",
      },
    ]);
  });

  test("Submit preserves bounded chaincode details from EndorseError", async () => {
    const contract = await gatewayContractThatRejectsEndorsement();

    const result = await contract.Submit("RegisterController", "input");

    expect(result.isOk()).toBe(false);
    if (result.isOk()) throw new Error("expected endorsement failure");
    expect(result.error).toBeInstanceOf(EndorsementError);
    expect(result.error.details?.[0]?.message).toContain("UNAUTHORIZED");
  });
});

async function gatewayContractThatRejectsEndorsement() {
  const message = "10 ABORTED: failed to endorse transaction, see attached details for more info";
  const cause: grpc.ServiceError = Object.assign(new Error(message), {
    code: grpc.status.ABORTED,
    details: message,
    metadata: new grpc.Metadata(),
  });
  const error = new fabricGateway.EndorseError({
    code: grpc.status.ABORTED,
    cause,
    transactionId: "tx-register-controller",
    message,
    details: [
      {
        address: "peer0-org1:7051",
        message: "chaincode response 500, UNAUTHORIZED: a Fabric admin identity is required",
        mspId: "Org1MSP",
      },
    ],
  });
  const gatewayConnection = {
    getGateway: () => ({
      getNetwork: () => ({
        getContract: () => ({
          submitAsync: async () => {
            throw error;
          },
        }),
      }),
    }),
  };
  // SAFETY: the test double implements the only GatewayConnection capability
  // consumed by GatewayNetwork.getContract().
  const network = new GatewayNetwork(
    gatewayConnection as never,
    "artifactblock",
    bridgeConfig(),
  );
  return network.getContract("artifactblock");
}

function bridgeConfig(): BridgeConfig {
  return {
    gatewayEndpoint: "peer0-org1:7051",
    identity: {
      mspId: "Org1MSP",
      credentials: Buffer.from("certificate"),
    },
    signer: (digest) => Buffer.from(digest),
  };
}
