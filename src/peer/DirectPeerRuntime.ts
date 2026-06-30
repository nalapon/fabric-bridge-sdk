import * as grpc from "@grpc/grpc-js";
import commonProtoModule from "@hyperledger/fabric-protos/lib/common/common_pb.js";
import ordererGrpcModule from "@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js";
import peerGrpcModule from "@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js";
import peerProposalModule from "@hyperledger/fabric-protos/lib/peer/proposal_pb.js";
import type * as PeerProposalResponseProto from "@hyperledger/fabric-protos/lib/peer/proposal_response_pb.js";
import type { BridgeConfig, TlsOptions } from "../types/config";
import type { BridgeResult, CommitStatus } from "../types/bridge";
import { ConfigurationError, EndorsementError, SubmitError } from "../errors/index";
import { Result } from "better-result";
import { GatewayConnection } from "../gateway/GatewayConnection";
import { digestBytes } from "../offlineSigning";

const commonProto = commonProtoModule as typeof import("@hyperledger/fabric-protos/lib/common/common_pb.js");
const ordererGrpc = ordererGrpcModule as typeof import("@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js");
const peerGrpc = peerGrpcModule as typeof import("@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js");
const peerProposal = peerProposalModule as typeof import("@hyperledger/fabric-protos/lib/peer/proposal_pb.js");

interface DirectProposalResponse {
  response?: {
    status: number;
    message: string;
    payload: Buffer;
  };
  payload: Buffer;
  endorsement?: {
    endorser: Buffer;
    signature: Buffer;
  };
}

export class DirectPeerRuntime {
  constructor(private readonly config: BridgeConfig) {}

  async processProposal(
    peerEndpoint: string,
    proposalBytes: Buffer,
    signature: Buffer,
  ): Promise<DirectProposalResponse> {
    const client = new peerGrpc.EndorserClient(
      endpointAddress(peerEndpoint),
      createCredentials(this.config.discoveryTls),
      channelOptions(peerEndpoint, this.config.discoveryTls),
    );

    try {
      const request = new peerProposal.SignedProposal();
      request.setProposalBytes(proposalBytes);
      request.setSignature(signature);
      const response = await processProposalWithDeadline(
        client,
        request,
        this.config.timeouts?.endorse ?? 30000,
      );
      return adaptProposalResponse(response);
    } finally {
      client.close();
    }
  }

  async submitEnvelope(
    transactionBytes: Buffer,
    signature: Buffer,
    transactionId: string,
    discoveredOrdererEndpoint?: string,
  ): Promise<void> {
    const ordererEndpoint = this.config.ordererEndpoint || discoveredOrdererEndpoint;
    if (!ordererEndpoint) {
      throw new ConfigurationError({
        field: "ordererEndpoint",
        message: "ordererEndpoint is required for direct endorsement submit when discovery returns no orderer endpoints",
      });
    }

    const client = new ordererGrpc.AtomicBroadcastClient(
      ordererEndpoint,
      createCredentials(this.config.ordererTls),
      channelOptions(ordererEndpoint, this.config.ordererTls),
    );

    try {
      const envelope = new commonProto.Envelope();
      envelope.setPayload(transactionBytes);
      envelope.setSignature(signature);
      await broadcastEnvelopeWithDeadline(
        client,
        envelope,
        transactionId,
        this.config.timeouts?.submit ?? 30000,
      );
    } finally {
      client.close();
    }
  }

  async waitForCommit(
    channelName: string,
    transactionId: string,
  ): Promise<BridgeResult<CommitStatus>> {
    const gatewayConnection = new GatewayConnection(this.config);
    const connected = await gatewayConnection.connect();
    if (!connected.isOk()) {
      return Result.err(connected.error);
    }
    try {
      return await gatewayConnection.getCommitStatus(channelName, transactionId);
    } finally {
      await gatewayConnection.disconnect();
    }
  }
}

export async function signDirectTransactionPayload(
  config: BridgeConfig,
  transactionPayload: Buffer,
): Promise<Buffer> {
  return Buffer.from(await config.signer(digestBytes(transactionPayload)));
}

function processProposalWithDeadline(
  client: InstanceType<typeof peerGrpc.EndorserClient>,
  request: InstanceType<typeof peerProposal.SignedProposal>,
  timeout: number,
): Promise<PeerProposalResponseProto.ProposalResponse> {
  return new Promise((resolve, reject) => {
    client.processProposal(
      request,
      { deadline: Date.now() + timeout },
      (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        if (!response) {
          reject(new EndorsementError({ message: "empty proposal response" }));
          return;
        }
        resolve(response);
      },
    );
  });
}

function adaptProposalResponse(
  proposalResponse: PeerProposalResponseProto.ProposalResponse,
): DirectProposalResponse {
  const response = proposalResponse.getResponse();
  const endorsement = proposalResponse.getEndorsement();
  const status = response?.getStatus() ?? 0;
  if (status < 200 || status >= 400) {
    throw new EndorsementError({
      message: `proposal response was not successful, status ${status}: ${response?.getMessage() ?? ""}`,
    });
  }
  if (!endorsement) {
    throw new EndorsementError({ message: "proposal response has no endorsement" });
  }
  return {
    response: response
      ? {
          status,
          message: response.getMessage(),
          payload: Buffer.from(response.getPayload_asU8()),
        }
      : undefined,
    payload: Buffer.from(proposalResponse.getPayload_asU8()),
    endorsement: {
      endorser: Buffer.from(endorsement.getEndorser_asU8()),
      signature: Buffer.from(endorsement.getSignature_asU8()),
    },
  };
}

function broadcastEnvelopeWithDeadline(
  client: InstanceType<typeof ordererGrpc.AtomicBroadcastClient>,
  envelope: InstanceType<typeof commonProto.Envelope>,
  transactionId: string,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = client.broadcast({ deadline: Date.now() + timeout });
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.end();
      if (error) reject(error);
      else resolve();
    };

    stream.on("data", (response) => {
      const status = response.getStatus();
      if (status !== commonProto.Status.SUCCESS) {
        finish(
          new SubmitError({
            message: `orderer rejected transaction: status=${status} info=${response.getInfo()}`,
            transactionId,
          }),
        );
        return;
      }
      finish();
    });
    stream.on("error", (error) => {
      finish(
        new SubmitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId,
        }),
      );
    });
    stream.on("end", () => {
      finish(
        new SubmitError({
          message: "orderer broadcast ended without response",
          transactionId,
        }),
      );
    });
    stream.write(envelope);
  });
}

function createCredentials(tlsOptions: TlsOptions | undefined): grpc.ChannelCredentials {
  if (!tlsOptions?.trustedRoots) {
    return grpc.credentials.createInsecure();
  }
  if (tlsOptions.clientKey && tlsOptions.clientCert) {
    return grpc.credentials.createSsl(
      tlsOptions.trustedRoots,
      tlsOptions.clientKey,
      tlsOptions.clientCert,
    );
  }
  return grpc.credentials.createSsl(tlsOptions.trustedRoots);
}

function channelOptions(endpoint: string, tlsOptions: TlsOptions | undefined): grpc.ChannelOptions {
  const hostname = tlsOptions?.sslTargetNameOverride ?? endpointHost(endpoint);
  return {
    "grpc.max_receive_message_length": -1,
    "grpc.max_send_message_length": -1,
    ...(hostname ? { "grpc.ssl_target_name_override": hostname } : {}),
  };
}

function endpointAddress(endpoint: string): string {
  if (endpoint.startsWith("grpc://") || endpoint.startsWith("grpcs://")) {
    const parsed = new URL(endpoint);
    return `${parsed.hostname}:${parsed.port}`;
  }
  return endpoint;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(":");
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}
