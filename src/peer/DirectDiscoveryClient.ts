import * as grpc from "@grpc/grpc-js";
import { createHash, X509Certificate } from "crypto";
import discoveryGrpcModule from "@hyperledger/fabric-protos/lib/discovery/protocol_grpc_pb.js";
import discoveryProtoModule from "@hyperledger/fabric-protos/lib/discovery/protocol_pb.js";
import gossipProtoModule from "@hyperledger/fabric-protos/lib/gossip/message_pb.js";
import identitiesProtoModule from "@hyperledger/fabric-protos/lib/msp/identities_pb.js";
import type * as DiscoveryProto from "@hyperledger/fabric-protos/lib/discovery/protocol_pb.js";
import type { BridgeConfig, TlsOptions } from "../types/config";
import type { DiscoveryResult, MSPInfo, OrdererInfo, PeerInfo } from "../types/discovery";
import { ConfigurationError, DiscoveryError, TimeoutError } from "../errors/index";
import { Result } from "better-result";
import {
  endpointHost,
  normalizePeerEndpointIdentityResult,
} from "./endpointIdentity";

const discoveryGrpc = discoveryGrpcModule as typeof import("@hyperledger/fabric-protos/lib/discovery/protocol_grpc_pb.js");
const discoveryProto = discoveryProtoModule as typeof import("@hyperledger/fabric-protos/lib/discovery/protocol_pb.js");
const gossipProto = gossipProtoModule as typeof import("@hyperledger/fabric-protos/lib/gossip/message_pb.js");
const { SerializedIdentity } = identitiesProtoModule as typeof import("@hyperledger/fabric-protos/lib/msp/identities_pb.js");

export class DirectDiscoveryClient {
  constructor(private readonly config: BridgeConfig) {}

  async discover(
    channelName: string,
  ): Promise<Result<DiscoveryResult, DiscoveryError | ConfigurationError | TimeoutError>> {
    const discoverySeed = this.config.discoverySeed || this.config.gatewayEndpoint;
    const discoveryTls = this.config.discoveryTls;
    const timeout = this.config.timeouts?.discovery ?? 5000;
    const client = new discoveryGrpc.DiscoveryClient(
      discoverySeed,
      createDiscoveryCredentials(discoveryTls),
      channelOptions(discoverySeed, discoveryTls),
    );

    try {
      const request = await newSignedDiscoveryRequest(this.config, channelName);
      const response = await discoverWithDeadline(client, request, timeout);
      const discovery = discoveryResultFromResponseResult(
        response,
        channelName,
        !!discoveryTls?.trustedRoots,
      );
      if (!discovery.isOk()) {
        return Result.err(discovery.error);
      }
      return Result.ok(discovery.value);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return Result.err(error);
      }
      if (error instanceof TimeoutError) {
        return Result.err(error);
      }
      return Result.err(
        new DiscoveryError({
          message: `Discovery failed from ${discoverySeed}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    } finally {
      client.close();
    }
  }
}

export async function newSignedDiscoveryRequest(
  config: BridgeConfig,
  channelName: string,
): Promise<DiscoveryProto.SignedRequest> {
  const identity = new SerializedIdentity();
  identity.setMspid(config.identity.mspId);
  identity.setIdBytes(config.identity.credentials);

  const auth = new discoveryProto.AuthInfo();
  auth.setClientIdentity(identity.serializeBinary());
  auth.setClientTlsCertHash(discoveryTLSCertHash(config.discoveryTls));

  const peerQuery = new discoveryProto.Query();
  peerQuery.setChannel(channelName);
  peerQuery.setPeerQuery(new discoveryProto.PeerMembershipQuery());

  const configQuery = new discoveryProto.Query();
  configQuery.setChannel(channelName);
  configQuery.setConfigQuery(new discoveryProto.ConfigQuery());

  const request = new discoveryProto.Request();
  request.setAuthentication(auth);
  request.setQueriesList([peerQuery, configQuery]);

  const payload = request.serializeBinary();
  const signature = await config.signer(createHash("sha256").update(payload).digest());

  const signed = new discoveryProto.SignedRequest();
  signed.setPayload(payload);
  signed.setSignature(signature);
  return signed;
}

export function discoveryResultFromResponse(
  response: DiscoveryProto.Response | undefined,
  channelName: string,
  tlsEnabled: boolean,
): DiscoveryResult {
  const parsed = discoveryResultFromResponseResult(response, channelName, tlsEnabled);
  if (!parsed.isOk()) {
    throw parsed.error;
  }
  return parsed.value;
}

export function discoveryResultFromResponseResult(
  response: DiscoveryProto.Response | undefined,
  channelName: string,
  tlsEnabled: boolean,
): Result<DiscoveryResult, DiscoveryError | ConfigurationError> {
  if (!response) {
    return Result.err(new DiscoveryError({ message: "empty discovery response" }));
  }

  const results = response.getResultsList();
  if (results.length === 0) {
    return Result.err(
      new DiscoveryError({ message: "empty discovery results" }),
    );
  }

  const peers = new Map<string, PeerInfo>();
  const orderers: OrdererInfo[] = [];

  for (const result of results) {
    const discoveryError = result.getError();
    if (discoveryError) {
      return Result.err(
        new DiscoveryError({ message: `discovery service error: ${discoveryError.getContent()}` }),
      );
    }

    const members = result.getMembers();
    if (members) {
      const parsedPeers = peersFromMembershipResult(members, tlsEnabled);
      if (!parsedPeers.isOk()) {
        return Result.err(parsedPeers.error);
      }
      for (const [endpoint, peer] of parsedPeers.value.entries()) {
        if (peers.has(endpoint)) {
          return Result.err(
            new DiscoveryError({
              message: `Discovery returned duplicate peer endpoint identity: ${endpoint}`,
            }),
          );
        }
        peers.set(endpoint, peer);
      }
      continue;
    }

    const config = result.getConfigResult();
    if (config) {
      orderers.push(...orderersFromConfigResult(config));
    }
  }

  if (peers.size === 0) {
    return Result.err(new DiscoveryError({ message: "expected peer membership result" }));
  }

  return Result.ok({
    timestamp: Date.now(),
    channelName,
    peers,
    orderers,
    msps: new Map<string, MSPInfo>(),
  });
}

function peersFromMembershipResult(
  members: DiscoveryProto.PeerMembershipResult,
  tlsEnabled: boolean,
): Result<Map<string, PeerInfo>, DiscoveryError | ConfigurationError> {
  const peers = new Map<string, PeerInfo>();
  const orgEntries: Array<[string, DiscoveryProto.Peers]> = [];
  members.getPeersByOrgMap().forEach((orgPeers: DiscoveryProto.Peers, mspId: string) => {
    orgEntries.push([mspId, orgPeers]);
  });
  orgEntries.sort(([left], [right]) => left.localeCompare(right));
  for (const [mspId, orgPeers] of orgEntries) {
    for (const peer of orgPeers.getPeersList()) {
      const rawEndpoint = peerEndpointFromDiscoveryPeerResult(peer);
      if (!rawEndpoint.isOk()) {
        return Result.err(rawEndpoint.error);
      }
      const endpoint = normalizePeerEndpointIdentityResult(
        rawEndpoint.value,
        tlsEnabled,
      );
      if (!endpoint.isOk()) {
        return Result.err(endpoint.error);
      }
      if (peers.has(endpoint.value)) {
        return Result.err(
          new DiscoveryError({
            message: `Discovery returned duplicate peer endpoint identity: ${endpoint.value}`,
          }),
        );
      }

      const properties = discoveryPeerProperties(peer);
      peers.set(endpoint.value, {
        name: endpointHost(endpoint.value),
        endpoint: endpoint.value,
        mspId,
        chaincodes: properties.chaincodes,
        ledgerHeight: properties.ledgerHeight,
      });
    }
  }
  return Result.ok(peers);
}

function orderersFromConfigResult(config: DiscoveryProto.ConfigResult): OrdererInfo[] {
  const orderers: OrdererInfo[] = [];
  config.getOrderersMap().forEach((endpoints: DiscoveryProto.Endpoints, mspId: string) => {
    for (const endpoint of endpoints.getEndpointList()) {
      const host = endpoint.getHost().trim();
      const port = endpoint.getPort();
      if (!host || port === 0) {
        continue;
      }
      orderers.push({ endpoint: `${host}:${port}`, mspId });
    }
  });
  return orderers.sort((a, b) =>
    a.endpoint === b.endpoint
      ? a.mspId.localeCompare(b.mspId)
      : a.endpoint.localeCompare(b.endpoint),
  );
}

function createDiscoveryCredentials(tlsOptions: TlsOptions | undefined): grpc.ChannelCredentials {
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

function discoverWithDeadline(
  client: InstanceType<typeof discoveryGrpc.DiscoveryClient>,
  request: DiscoveryProto.SignedRequest,
  timeout: number,
): Promise<DiscoveryProto.Response> {
  return new Promise((resolve, reject) => {
    client.discover(
      request,
      { deadline: Date.now() + timeout },
      (error, response) => {
        if (error) {
          if (error.message.toLowerCase().includes("deadline")) {
            reject(
              new TimeoutError({
                message: error.message,
                operation: "discovery",
                timeout,
              }),
            );
            return;
          }
          reject(error);
          return;
        }
        if (!response) {
          reject(new Error("empty discovery response"));
          return;
        }
        resolve(response);
      },
    );
  });
}

function discoveryTLSCertHash(tlsOptions: TlsOptions | undefined): Buffer {
  if (!tlsOptions?.clientCert) {
    return createHash("sha256").update(Buffer.alloc(0)).digest();
  }

  try {
    return createHash("sha256").update(new X509Certificate(tlsOptions.clientCert).raw).digest();
  } catch {
    return createHash("sha256").update(Buffer.alloc(0)).digest();
  }
}

function peerEndpointFromDiscoveryPeer(peer: DiscoveryProto.Peer): string {
  const endpoint = peerEndpointFromDiscoveryPeerResult(peer);
  if (!endpoint.isOk()) {
    throw endpoint.error;
  }
  return endpoint.value;
}

function peerEndpointFromDiscoveryPeerResult(
  peer: DiscoveryProto.Peer,
): Result<string, DiscoveryError> {
  const membershipInfo = peer.getMembershipInfo();
  if (!membershipInfo) {
    return Result.err(new DiscoveryError({ message: "discovered peer has no membership info" }));
  }

  const message = gossipProto.GossipMessage.deserializeBinary(membershipInfo.getPayload_asU8());
  const endpoint = message.getAliveMsg()?.getMembership()?.getEndpoint();
  if (!endpoint) {
    return Result.err(new DiscoveryError({ message: "discovered peer has no endpoint" }));
  }
  return Result.ok(endpoint);
}

function discoveryPeerProperties(peer: DiscoveryProto.Peer): {
  chaincodes: string[];
  ledgerHeight: bigint;
} {
  const stateInfo = peer.getStateInfo();
  if (!stateInfo) {
    return { chaincodes: [], ledgerHeight: BigInt(0) };
  }

  try {
    const message = gossipProto.GossipMessage.deserializeBinary(stateInfo.getPayload_asU8());
    const properties = message.getStateInfo()?.getProperties();
    if (!properties) {
      return { chaincodes: [], ledgerHeight: BigInt(0) };
    }
    return {
      chaincodes: properties.getChaincodesList().map((chaincode) => chaincode.getName()),
      ledgerHeight: BigInt(properties.getLedgerHeight()),
    };
  } catch {
    return { chaincodes: [], ledgerHeight: BigInt(0) };
  }
}
