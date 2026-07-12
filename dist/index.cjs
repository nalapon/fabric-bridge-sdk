"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ChaincodeEventError: () => ChaincodeEventError,
  CommitError: () => CommitError,
  ConfigurationError: () => ConfigurationError,
  DEFAULT_TIMEOUTS: () => DEFAULT_TIMEOUTS,
  DiscoveryError: () => DiscoveryError,
  EndorsementError: () => EndorsementError,
  EvaluationError: () => EvaluationError,
  FabricBridge: () => FabricBridge,
  NotConnectedError: () => NotConnectedError,
  OfflineSigningError: () => OfflineSigningError,
  PeerNotFoundError: () => PeerNotFoundError,
  SinglePeerExecutionError: () => SinglePeerExecutionError,
  SubmitError: () => SubmitError,
  TimeoutError: () => TimeoutError,
  createSyncPrivateKeySigner: () => createSyncPrivateKeySigner,
  disableDebugLogging: () => disableDebugLogging,
  enableDebugLogging: () => enableDebugLogging,
  setLogger: () => setLogger
});
module.exports = __toCommonJS(index_exports);

// src/gateway/GatewayConnection.ts
var grpc = __toESM(require("@grpc/grpc-js"), 1);
var fabricGateway = __toESM(require("@hyperledger/fabric-gateway"), 1);
var import_crypto = require("crypto");
var import_gateway_pb = __toESM(require("@hyperledger/fabric-protos/lib/gateway/gateway_pb.js"), 1);
var import_identities_pb = __toESM(require("@hyperledger/fabric-protos/lib/msp/identities_pb.js"), 1);
var import_transaction_pb = __toESM(require("@hyperledger/fabric-protos/lib/peer/transaction_pb.js"), 1);

// src/errors/index.ts
var import_better_result = require("better-result");
var EndorsementError = class extends (0, import_better_result.TaggedError)("EndorsementError")() {
};
var DiscoveryError = class extends (0, import_better_result.TaggedError)("DiscoveryError")() {
};
var PeerNotFoundError = class extends (0, import_better_result.TaggedError)("PeerNotFoundError")() {
};
var SinglePeerExecutionError = class extends (0, import_better_result.TaggedError)("SinglePeerExecutionError")() {
};
var SubmitError = class extends (0, import_better_result.TaggedError)("SubmitError")() {
};
var CommitError = class extends (0, import_better_result.TaggedError)("CommitError")() {
};
var EvaluationError = class extends (0, import_better_result.TaggedError)("EvaluationError")() {
};
var ChaincodeEventError = class extends (0, import_better_result.TaggedError)("ChaincodeEventError")() {
};
var ConfigurationError = class extends (0, import_better_result.TaggedError)("ConfigurationError")() {
};
var TimeoutError = class extends (0, import_better_result.TaggedError)("TimeoutError")() {
};
var NotConnectedError = class extends (0, import_better_result.TaggedError)("NotConnectedError")() {
};
var OfflineSigningError = class extends (0, import_better_result.TaggedError)("OfflineSigningError")() {
};

// src/gateway/GatewayConnection.ts
var import_better_result2 = require("better-result");

// src/utils/logger.ts
var NOOP_LOGGER = {
  debug: () => {
  },
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  }
};
var CONSOLE_LOGGER = {
  debug: (...args) => console.log("[DEBUG]", (/* @__PURE__ */ new Date()).toISOString(), ...args),
  info: (...args) => console.log("[INFO]", (/* @__PURE__ */ new Date()).toISOString(), ...args),
  warn: (...args) => console.warn("[WARN]", (/* @__PURE__ */ new Date()).toISOString(), ...args),
  error: (...args) => console.error("[ERROR]", (/* @__PURE__ */ new Date()).toISOString(), ...args)
};
var logger = NOOP_LOGGER;
function setLogger(newLogger) {
  logger = newLogger;
}
function enableDebugLogging() {
  logger = CONSOLE_LOGGER;
}
function disableDebugLogging() {
  logger = NOOP_LOGGER;
}
function log() {
  return logger;
}

// src/gateway/GatewayConnection.ts
var gatewayProto = import_gateway_pb.default;
var { SerializedIdentity } = import_identities_pb.default;
var peerTransactionProto = import_transaction_pb.default;
var GatewayConnection = class {
  client = null;
  gateway = null;
  config;
  constructor(config) {
    this.config = config;
  }
  async connect() {
    const { gatewayEndpoint, identity, signer, gatewayTls, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5e3;
    log().info("GatewayConnection.connect() - Iniciando conexi\xF3n");
    log().debug("GatewayConnection.connect() - Config:", {
      gatewayEndpoint,
      mspId: identity.mspId,
      hasTrustedRoots: !!gatewayTls?.trustedRoots,
      trustedRootsLength: gatewayTls?.trustedRoots?.length,
      hasClientCert: !!gatewayTls?.clientCert,
      clientCertLength: gatewayTls?.clientCert?.length,
      hasClientKey: !!gatewayTls?.clientKey,
      clientKeyLength: gatewayTls?.clientKey?.length,
      connectTimeout
    });
    return import_better_result2.Result.tryPromise({
      try: async () => {
        log().debug("GatewayConnection.connect() - Creando credenciales TLS");
        let tlsCredentials;
        if (gatewayTls?.trustedRoots) {
          if (gatewayTls?.clientKey && gatewayTls?.clientCert) {
            log().debug("GatewayConnection.connect() - Usando mTLS (certificado cliente)");
            tlsCredentials = grpc.credentials.createSsl(
              gatewayTls.trustedRoots,
              gatewayTls.clientKey,
              gatewayTls.clientCert
            );
          } else {
            log().debug("GatewayConnection.connect() - Usando TLS normal (solo verificar servidor)");
            tlsCredentials = grpc.credentials.createSsl(gatewayTls.trustedRoots);
          }
        } else {
          log().debug("GatewayConnection.connect() - Usando conexi\xF3n insegura (sin TLS)");
          tlsCredentials = grpc.credentials.createInsecure();
        }
        const hostname = gatewayTls?.sslTargetNameOverride ?? this.extractHostname(gatewayEndpoint);
        const clientOptions = {
          "grpc.max_receive_message_length": -1,
          "grpc.max_send_message_length": -1,
          ...hostname ? { "grpc.ssl_target_name_override": hostname } : {}
        };
        log().debug("GatewayConnection.connect() - Creando gRPC Client:", {
          endpoint: gatewayEndpoint,
          hostname,
          hasSslOverride: !!hostname
        });
        this.client = new grpc.Client(gatewayEndpoint, tlsCredentials, clientOptions);
        log().debug("GatewayConnection.connect() - Esperando conexi\xF3n ready (timeout:", connectTimeout, "ms)");
        await Promise.race([
          new Promise((resolve, reject) => {
            this.client.waitForReady(Date.now() + connectTimeout, (error) => {
              if (error) {
                const grpcError = error;
                log().error("GatewayConnection.connect() - Error en waitForReady:", {
                  code: grpcError.code,
                  message: grpcError.message,
                  details: grpcError.details
                });
                reject(error);
              } else resolve();
            });
          }),
          new Promise(
            (_, reject) => setTimeout(() => reject(new Error("Connection timeout")), connectTimeout)
          )
        ]);
        log().debug("GatewayConnection.connect() - gRPC Client conectado, creando Fabric Gateway");
        this.gateway = fabricGateway.connect({
          client: this.client,
          identity: {
            mspId: identity.mspId,
            credentials: identity.credentials
          },
          signer: this.adaptSigner(signer)
        });
        log().info("GatewayConnection.connect() - Conexi\xF3n exitosa");
      },
      catch: (e) => {
        if (e instanceof Error && e.message.includes("timeout")) {
          log().error("GatewayConnection.connect() - Timeout error:", e.message);
          return new TimeoutError({
            message: `Failed to connect to gateway endpoint: ${gatewayEndpoint}`,
            operation: "connect",
            timeout: connectTimeout
          });
        }
        log().error("GatewayConnection.connect() - Configuration error:", e instanceof Error ? e.message : String(e));
        return new ConfigurationError({
          message: `Failed to connect to gateway: ${e instanceof Error ? e.message : String(e)}`,
          field: "gatewayEndpoint"
        });
      }
    });
  }
  getGateway() {
    if (!this.gateway) {
      throw new Error("Gateway not connected. Call connect() first.");
    }
    return this.gateway;
  }
  async getCommitStatus(channelName, transactionId) {
    if (!this.client) {
      return import_better_result2.Result.err(new NotConnectedError({
        component: "GatewayConnection",
        action: "get commit status"
      }));
    }
    const commitTimeout = this.config.timeouts?.commit ?? 6e4;
    const serializedIdentity3 = new SerializedIdentity();
    serializedIdentity3.setMspid(this.config.identity.mspId);
    serializedIdentity3.setIdBytes(this.config.identity.credentials);
    const request = new gatewayProto.CommitStatusRequest();
    request.setChannelId(channelName);
    request.setTransactionId(transactionId);
    request.setIdentity(serializedIdentity3.serializeBinary());
    const requestBytes = request.serializeBinary();
    const signature = await this.config.signer((0, import_crypto.createHash)("sha256").update(requestBytes).digest());
    const signedRequest = new gatewayProto.SignedCommitStatusRequest();
    signedRequest.setRequest(requestBytes);
    signedRequest.setSignature(signature);
    return import_better_result2.Result.tryPromise({
      try: async () => {
        const response = await new Promise((resolve, reject) => {
          this.client.makeUnaryRequest(
            "/gateway.Gateway/CommitStatus",
            (value) => Buffer.from(value.serializeBinary()),
            (bytes) => gatewayProto.CommitStatusResponse.deserializeBinary(new Uint8Array(bytes)),
            signedRequest,
            {
              deadline: Date.now() + commitTimeout
            },
            (error, value) => {
              if (error) {
                reject(error);
                return;
              }
              if (!value) {
                reject(new Error("Empty commit status response"));
                return;
              }
              resolve(value);
            }
          );
        });
        const validationCode = response.getResult();
        const validationStatus = txValidationCodeName(validationCode);
        const status = {
          blockNumber: BigInt(response.getBlockNumber()),
          status: validationStatus,
          transactionId
        };
        if (validationCode !== peerTransactionProto.TxValidationCode.VALID) {
          throw new CommitError({
            message: "transaction committed with invalid validation code",
            transactionId,
            status: status.status
          });
        }
        return status;
      },
      catch: (error) => {
        if (error instanceof CommitError) {
          return error;
        }
        if (error instanceof Error && error.message.toLowerCase().includes("deadline")) {
          return new TimeoutError({
            message: `Failed to get commit status for transaction ${transactionId}`,
            operation: "commit",
            timeout: commitTimeout
          });
        }
        return new CommitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId
        });
      }
    });
  }
  async disconnect() {
    this.gateway?.close();
    this.client?.close();
    this.gateway = null;
    this.client = null;
    await new Promise((resolve) => setImmediate(resolve));
  }
  adaptSigner(signer) {
    return async (digest) => {
      const signature = await signer(digest);
      return Buffer.from(signature);
    };
  }
  extractHostname(endpoint) {
    const parts = endpoint.split(":");
    return parts[0] || void 0;
  }
};
function txValidationCodeName(code) {
  for (const [name, value] of Object.entries(peerTransactionProto.TxValidationCode)) {
    if (value === code) {
      return name;
    }
  }
  return `UNKNOWN_VALIDATION_CODE_${code}`;
}

// src/gateway/GatewayContract.ts
var fabricGateway2 = __toESM(require("@hyperledger/fabric-gateway"), 1);
var fabricProtos = __toESM(require("@hyperledger/fabric-protos"), 1);
var import_better_result4 = require("better-result");
var import_node_crypto = require("crypto");
var import_timestamp_pb = __toESM(require("google-protobuf/google/protobuf/timestamp_pb.js"), 1);

// src/types/config.ts
var DEFAULT_TIMEOUTS = {
  endorse: 3e4,
  submit: 3e4,
  commit: 6e4,
  evaluate: 3e4,
  discovery: 5e3
};

// src/offlineSigning.ts
var import_crypto2 = require("crypto");
var fabricGatewayProtos = __toESM(require("@hyperledger/fabric-protos"), 1);
var import_better_result3 = require("better-result");
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function digestBytes(bytes) {
  return (0, import_crypto2.createHash)("sha256").update(bytes).digest();
}
function normalizeSignature(signature) {
  if (typeof signature === "string") {
    const decoded = decodeBase64(signature, "signature");
    if (!decoded.isOk()) {
      return import_better_result3.Result.err(decoded.error);
    }
    return import_better_result3.Result.ok(toBase64(decoded.value));
  }
  return import_better_result3.Result.ok(toBase64(signature));
}
function signingRequest(bytes, digest, routing) {
  return {
    bytes: toBase64(bytes),
    digest: toBase64(digest),
    ...routing ? { routing } : {}
  };
}
function signedMessage(request, signature) {
  const normalized = normalizeSignature(signature);
  if (!normalized.isOk()) {
    return import_better_result3.Result.err(normalized.error);
  }
  return import_better_result3.Result.ok({
    ...request,
    signature: normalized.value
  });
}
function decodeSignedMessage(message) {
  const bytes = decodeBase64(message.bytes, "bytes");
  if (!bytes.isOk()) {
    return import_better_result3.Result.err(bytes.error);
  }
  const digest = decodeBase64(message.digest, "digest");
  if (!digest.isOk()) {
    return import_better_result3.Result.err(digest.error);
  }
  const signature = decodeBase64(message.signature, "signature");
  if (!signature.isOk()) {
    return import_better_result3.Result.err(signature.error);
  }
  return import_better_result3.Result.ok({
    bytes: bytes.value,
    digest: digest.value,
    signature: signature.value,
    routing: message.routing
  });
}
function validateProposalRouting(routing) {
  if (!routing) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field: "routing",
        message: "proposal signing request requires routing"
      })
    );
  }
  if (routing.mode === "gateway-default") {
    return import_better_result3.Result.ok(routing);
  }
  if (!Array.isArray(routing.peers) || routing.peers.length === 0) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: `${routing.mode} routing requires at least one peer endpoint`
      })
    );
  }
  return import_better_result3.Result.ok({
    mode: routing.mode,
    peers: [...routing.peers]
  });
}
function proposalCreatorIdentity(proposalBytes) {
  try {
    const proposal = fabricGatewayProtos.peer.Proposal.deserializeBinary(
      unwrapProposalBytes(proposalBytes)
    );
    const header = fabricGatewayProtos.common.Header.deserializeBinary(
      proposal.getHeader_asU8()
    );
    const signatureHeader = fabricGatewayProtos.common.SignatureHeader.deserializeBinary(
      header.getSignatureHeader_asU8()
    );
    return import_better_result3.Result.ok(Buffer.from(signatureHeader.getCreator_asU8()));
  } catch (error) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field: "bytes",
        message: `unable to inspect proposal creator identity: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function proposalCreatorMSPID(proposalBytes) {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return import_better_result3.Result.err(creator.error);
  try {
    const identity = fabricGatewayProtos.msp.SerializedIdentity.deserializeBinary(creator.value);
    return import_better_result3.Result.ok(identity.getMspid());
  } catch (error) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator MSPID: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function proposalCreatorCertificate(proposalBytes) {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return import_better_result3.Result.err(creator.error);
  try {
    const identity = fabricGatewayProtos.msp.SerializedIdentity.deserializeBinary(creator.value);
    return import_better_result3.Result.ok(Buffer.from(identity.getIdBytes_asU8()));
  } catch (error) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator certificate: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function unwrapProposalBytes(proposalBytes) {
  const bytes = Buffer.from(proposalBytes);
  if (isFabricProposalBytes(bytes)) {
    return bytes;
  }
  try {
    const proposedTransaction = fabricGatewayProtos.gateway.ProposedTransaction.deserializeBinary(bytes);
    const signedProposal = proposedTransaction.getProposal();
    const rawProposalBytes = signedProposal?.getProposalBytes_asU8();
    if (rawProposalBytes && rawProposalBytes.length > 0) {
      const candidate = Buffer.from(rawProposalBytes);
      if (isFabricProposalBytes(candidate)) {
        return candidate;
      }
    }
  } catch {
  }
  return bytes;
}
function isFabricProposalBytes(bytes) {
  try {
    const proposal = fabricGatewayProtos.peer.Proposal.deserializeBinary(bytes);
    if (proposal.getHeader_asU8().length === 0 || proposal.getPayload_asU8().length === 0) {
      return false;
    }
    const header = fabricGatewayProtos.common.Header.deserializeBinary(proposal.getHeader_asU8());
    return header.getChannelHeader_asU8().length > 0 && header.getSignatureHeader_asU8().length > 0;
  } catch {
    return false;
  }
}
function decodeBase64(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field,
        message: `${field} must be a non-empty base64 string`
      })
    );
  }
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== value.replace(/=+$/, "") + "=".repeat((4 - value.length % 4) % 4)) {
      const normalized = decoded.toString("base64");
      if (normalized !== value) {
        return import_better_result3.Result.err(
          new OfflineSigningError({
            field,
            message: `${field} is not valid canonical base64`
          })
        );
      }
    }
    return import_better_result3.Result.ok(decoded);
  } catch {
    return import_better_result3.Result.err(
      new OfflineSigningError({
        field,
        message: `${field} is not valid base64`
      })
    );
  }
}

// src/gateway/GatewayContract.ts
var { Timestamp } = import_timestamp_pb.default;
var GatewayNetwork = class {
  gatewayConnection;
  channelName;
  timeouts;
  constructor(gatewayConnection, channelName, config) {
    this.gatewayConnection = gatewayConnection;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  }
  async getContract(chaincodeName) {
    const gateway3 = this.gatewayConnection.getGateway();
    const network = gateway3.getNetwork(this.channelName);
    const contract = network.getContract(chaincodeName);
    return new GatewayContract(contract, chaincodeName, this.channelName, this.timeouts);
  }
  async ChaincodeEvents(chaincodeName, options) {
    try {
      const gateway3 = this.gatewayConnection.getGateway();
      const network = gateway3.getNetwork(this.channelName);
      const events = await network.getChaincodeEvents(chaincodeName, options);
      return import_better_result4.Result.ok(new GatewayChaincodeEventStream(chaincodeName, events));
    } catch (error) {
      return import_better_result4.Result.err(new ChaincodeEventError({
        chaincodeName,
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
};
var GatewayChaincodeEventStream = class {
  constructor(chaincodeName, events) {
    this.chaincodeName = chaincodeName;
    this.events = events;
    this.iterator = events[Symbol.asyncIterator]();
  }
  chaincodeName;
  events;
  iterator;
  async Recv() {
    try {
      const next = await this.iterator.next();
      if (next.done) {
        return import_better_result4.Result.ok(null);
      }
      return import_better_result4.Result.ok({
        blockNumber: next.value.blockNumber,
        transactionId: next.value.transactionId,
        chaincodeName: next.value.chaincodeName,
        eventName: next.value.eventName,
        payload: Buffer.from(next.value.payload)
      });
    } catch (error) {
      return import_better_result4.Result.err(new ChaincodeEventError({
        chaincodeName: this.chaincodeName,
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
  Close() {
    this.events.close();
  }
};
var GatewayContract = class {
  contract;
  chaincodeName;
  channelName;
  timeouts;
  constructor(contract, chaincodeName, channelName, timeouts) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.timeouts = timeouts;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  async Submit(name, ...args) {
    const tx = this.Transaction(name);
    return tx.Submit(...args);
  }
  async SubmitAsync(name, ...args) {
    const tx = this.Transaction(name);
    return tx.SubmitAsync(...args);
  }
  async Evaluate(name, ...args) {
    const stringArgs = normalizeArgs(args);
    try {
      const result = await this.contract.evaluate(name, {
        arguments: stringArgs
      });
      return import_better_result4.Result.ok(Buffer.from(result));
    } catch (error) {
      return import_better_result4.Result.err(this.mapError(error, "evaluate"));
    }
  }
  Transaction(name) {
    return new GatewayTransaction(
      name,
      this.chaincodeName,
      this.channelName,
      this.contract,
      this.timeouts
    );
  }
  mapError(error, operation) {
    const errorDetails = error.details || [];
    const detailMessages = errorDetails.map((detail) => `${detail.message ?? "unknown error"} (${detail.endpoint ?? "unknown endpoint"})`).join("; ");
    const fullMessage = detailMessages ? `${error.message}: ${detailMessages}` : error.message;
    if (error.message?.includes("timeout") || error.message?.includes("TIMEOUT")) {
      const timeoutValue = operation === "submit" ? this.timeouts.submit : this.timeouts.evaluate;
      return new TimeoutError({
        message: fullMessage,
        operation,
        timeout: timeoutValue
      });
    }
    if (operation === "evaluate") {
      return new EvaluationError({
        message: fullMessage,
        details: detailMessages
      });
    }
    return new SubmitError({
      message: fullMessage
    });
  }
};
var GatewayTransaction = class {
  name;
  chaincodeName;
  channelName;
  contract;
  timeouts;
  transientData = {};
  proposalCreator;
  constructor(name, chaincodeName, channelName, contract, timeouts) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.contract = contract;
    this.timeouts = timeouts;
  }
  getName() {
    return this.name;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  UseSinglePeer() {
    return import_better_result4.Result.err(new ConfigurationError({
      message: "UseSinglePeer() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions."
    }));
  }
  UseEndorsingPeers(..._peerNames) {
    return import_better_result4.Result.err(new ConfigurationError({
      message: "UseEndorsingPeers() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions."
    }));
  }
  SetTransientData(transientData) {
    this.transientData = { ...transientData };
    return this;
  }
  SetProposalCreator(proposalCreator) {
    this.proposalCreator = copyProposalCreator(proposalCreator);
    return this;
  }
  async Submit(...args) {
    const submittedResult = await this.SubmitAsync(...args);
    if (!submittedResult.isOk()) {
      return import_better_result4.Result.err(submittedResult.error);
    }
    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return import_better_result4.Result.err(commitStatus.error);
    }
    return import_better_result4.Result.ok(new GatewayCommitResult(submittedResult.value, commitStatus.value));
  }
  async SubmitAsync(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      const submitted = await this.contract.submitAsync(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData)
      });
      return import_better_result4.Result.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return import_better_result4.Result.err(this.mapSubmitError(error));
    }
  }
  async Evaluate(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      const result = await this.contract.evaluate(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData)
      });
      return import_better_result4.Result.ok(Buffer.from(result));
    } catch (error) {
      return import_better_result4.Result.err(new EvaluationError({
        message: error.message
      }));
    }
  }
  async NewUnsignedProposal(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      if (!this.proposalCreator) {
        return import_better_result4.Result.err(new ConfigurationError({
          field: "proposalCreator",
          message: "proposalCreator is required to build an unsigned proposal for offline signing"
        }));
      }
      return import_better_result4.Result.ok(new GatewayUnsignedProposal(buildGatewayProposal({
        channelName: this.channelName,
        chaincodeName: this.chaincodeName,
        transactionName: this.name,
        args: normalizedArgs,
        transientData: copyTransientData(this.transientData),
        proposalCreator: this.proposalCreator
      })));
    } catch (error) {
      return import_better_result4.Result.err(this.mapSubmitError(error));
    }
  }
  mapSubmitError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("timeout") || message.includes("TIMEOUT")) {
      return new TimeoutError({
        message,
        operation: "submit",
        timeout: this.timeouts.submit
      });
    }
    if (error instanceof fabricGateway2.EndorseError) {
      return gatewayEndorsementError(error);
    }
    return new SubmitError({
      message
    });
  }
};
function NewGatewaySignedProposal(gateway3, message, timeouts) {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) {
    return import_better_result4.Result.err(decoded.error);
  }
  const routing = validateProposalRouting(decoded.value.routing);
  if (!routing.isOk()) {
    return import_better_result4.Result.err(routing.error);
  }
  if (routing.value.mode !== "gateway-default") {
    return import_better_result4.Result.err(new ConfigurationError({
      field: "routing.mode",
      message: `Gateway signed proposal cannot resume ${routing.value.mode} routing`
    }));
  }
  try {
    const unsignedProposal = gateway3.newProposal(decoded.value.bytes);
    if (!Buffer.from(unsignedProposal.getDigest()).equals(decoded.value.digest)) {
      return import_better_result4.Result.err(new OfflineSigningError({
        field: "digest",
        message: "digest does not match proposal bytes"
      }));
    }
    const proposal = gateway3.newSignedProposal(decoded.value.bytes, decoded.value.signature);
    return import_better_result4.Result.ok(new GatewaySignedProposal(gateway3, proposal, timeouts));
  } catch (error) {
    return import_better_result4.Result.err(new SubmitError({ message: error.message }));
  }
}
var GatewayUnsignedProposal = class {
  bytes;
  digest;
  transactionId;
  constructor(proposal) {
    this.bytes = Buffer.from(proposal.bytes);
    this.digest = Buffer.from(proposal.digest);
    this.transactionId = proposal.transactionId;
  }
  Bytes() {
    return Buffer.from(this.bytes);
  }
  Digest() {
    return Buffer.from(this.digest);
  }
  TransactionID() {
    return this.transactionId;
  }
  CreatorIdentity() {
    return proposalCreatorIdentity(this.Bytes());
  }
  CreatorMSPID() {
    return proposalCreatorMSPID(this.Bytes());
  }
  CreatorCertificate() {
    return proposalCreatorCertificate(this.Bytes());
  }
  SigningRequest() {
    return signingRequest(this.Bytes(), this.Digest(), { mode: "gateway-default" });
  }
  WithSignature(signature) {
    return signedMessage(this.SigningRequest(), signature);
  }
};
var GatewaySignedProposal = class {
  gateway;
  proposal;
  timeouts;
  constructor(gateway3, proposal, timeouts) {
    this.gateway = gateway3;
    this.proposal = proposal;
    this.timeouts = timeouts;
  }
  TransactionID() {
    return this.proposal.getTransactionId();
  }
  async Endorse() {
    try {
      const transaction = await this.proposal.endorse();
      return import_better_result4.Result.ok(new GatewayEndorsedTransaction(this.gateway, transaction, this.timeouts));
    } catch (error) {
      return import_better_result4.Result.err(
        error instanceof fabricGateway2.EndorseError ? gatewayEndorsementError(error) : new EndorsementError({
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  async Evaluate() {
    try {
      const result = await this.proposal.evaluate();
      return import_better_result4.Result.ok(Buffer.from(result));
    } catch (error) {
      return import_better_result4.Result.err(new EvaluationError({ message: error.message }));
    }
  }
};
function gatewayEndorsementError(error) {
  return new EndorsementError({
    message: error.message,
    details: error.details.map((detail) => ({
      message: detail.message,
      endpoint: detail.address,
      mspId: detail.mspId
    }))
  });
}
var GatewayEndorsedTransaction = class {
  gateway;
  transaction;
  timeouts;
  constructor(gateway3, transaction, timeouts) {
    this.gateway = gateway3;
    this.transaction = transaction;
    this.timeouts = timeouts;
  }
  Bytes() {
    return Buffer.from(this.transaction.getBytes());
  }
  Digest() {
    return Buffer.from(this.transaction.getDigest());
  }
  Result() {
    return Buffer.from(this.transaction.getResult());
  }
  TransactionID() {
    return this.transaction.getTransactionId();
  }
  async SubmitAsync() {
    try {
      const submitted = await this.transaction.submit();
      return import_better_result4.Result.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return import_better_result4.Result.err(new SubmitError({ message: error.message, transactionId: this.TransactionID() }));
    }
  }
  async Submit() {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) {
      return import_better_result4.Result.err(submitted.error);
    }
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) {
      return import_better_result4.Result.err(status.error);
    }
    return import_better_result4.Result.ok(new GatewayCommitResult(submitted.value, status.value));
  }
};
var GatewayCommitResult = class {
  submitted;
  commitStatus;
  constructor(submitted, commitStatus) {
    this.submitted = submitted;
    this.commitStatus = commitStatus;
  }
  Result() {
    return this.submitted.Result();
  }
  TransactionID() {
    return this.submitted.TransactionID();
  }
  CommitStatus() {
    return this.commitStatus;
  }
};
var GatewaySubmittedTx = class {
  submitted;
  timeouts;
  constructor(submitted, timeouts) {
    this.submitted = submitted;
    this.timeouts = timeouts;
  }
  Result() {
    return Buffer.from(this.submitted.getResult());
  }
  TransactionID() {
    return this.submitted.getTransactionId();
  }
  async WaitForCommit() {
    try {
      const status = await this.submitted.getStatus({
        deadline: Date.now() + this.timeouts.commit
      });
      if (!status.successful) {
        return import_better_result4.Result.err(new CommitError({
          message: "transaction committed with invalid validation code",
          transactionId: status.transactionId,
          status: "INVALID"
        }));
      }
      return import_better_result4.Result.ok({
        blockNumber: status.blockNumber,
        status: "VALID",
        transactionId: status.transactionId
      });
    } catch (error) {
      return import_better_result4.Result.err(new CommitError({
        message: error.message,
        transactionId: this.submitted.getTransactionId()
      }));
    }
  }
};
function normalizeArgs(args) {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Uint8Array) return arg;
    return JSON.stringify(arg);
  });
}
function copyTransientData(input) {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return void 0;
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [key, Buffer.from(value)])
  );
}
function buildGatewayProposal(options) {
  const creator = serializedIdentity(options.proposalCreator);
  const nonce = (0, import_node_crypto.randomBytes)(24);
  const transactionId = (0, import_node_crypto.createHash)("sha256").update(Buffer.concat([nonce, creator])).digest("hex");
  const signatureHeader = new fabricProtos.common.SignatureHeader();
  signatureHeader.setCreator(creator);
  signatureHeader.setNonce(nonce);
  const chaincodeId = new fabricProtos.peer.ChaincodeID();
  chaincodeId.setName(options.chaincodeName);
  const chaincodeHeaderExtension = new fabricProtos.peer.ChaincodeHeaderExtension();
  chaincodeHeaderExtension.setChaincodeId(chaincodeId);
  const channelHeader = new fabricProtos.common.ChannelHeader();
  channelHeader.setType(fabricProtos.common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setTxId(transactionId);
  channelHeader.setTimestamp(Timestamp.fromDate(/* @__PURE__ */ new Date()));
  channelHeader.setChannelId(options.channelName);
  channelHeader.setExtension$(chaincodeHeaderExtension.serializeBinary());
  channelHeader.setEpoch(0);
  const header = new fabricProtos.common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  header.setSignatureHeader(signatureHeader.serializeBinary());
  const chaincodeInput = new fabricProtos.peer.ChaincodeInput();
  chaincodeInput.setArgsList([options.transactionName, ...options.args].map(asBytes));
  const chaincodeSpec = new fabricProtos.peer.ChaincodeSpec();
  chaincodeSpec.setType(fabricProtos.peer.ChaincodeSpec.Type.NODE);
  chaincodeSpec.setChaincodeId(chaincodeId);
  chaincodeSpec.setInput(chaincodeInput);
  const invocationSpec = new fabricProtos.peer.ChaincodeInvocationSpec();
  invocationSpec.setChaincodeSpec(chaincodeSpec);
  const payload = new fabricProtos.peer.ChaincodeProposalPayload();
  payload.setInput(invocationSpec.serializeBinary());
  const transientMap = payload.getTransientmapMap();
  for (const [key, value] of Object.entries(options.transientData ?? {})) {
    transientMap.set(key, value);
  }
  const proposal = new fabricProtos.peer.Proposal();
  proposal.setHeader(header.serializeBinary());
  proposal.setPayload(payload.serializeBinary());
  const signedProposal = new fabricProtos.peer.SignedProposal();
  signedProposal.setProposalBytes(proposal.serializeBinary());
  const proposedTransaction = new fabricProtos.gateway.ProposedTransaction();
  proposedTransaction.setProposal(signedProposal);
  proposedTransaction.setTransactionId(transactionId);
  const proposalBytes = signedProposal.getProposalBytes_asU8();
  return {
    bytes: Buffer.from(proposedTransaction.serializeBinary()),
    digest: (0, import_node_crypto.createHash)("sha256").update(proposalBytes).digest(),
    transactionId
  };
}
function serializedIdentity(proposalCreator) {
  const identity = new fabricProtos.msp.SerializedIdentity();
  identity.setMspid(proposalCreator.mspId);
  identity.setIdBytes(proposalCreator.credentials);
  return Buffer.from(identity.serializeBinary());
}
function asBytes(value) {
  return typeof value === "string" ? Buffer.from(value) : value;
}
function copyProposalCreator(input) {
  return {
    mspId: input.mspId,
    credentials: Buffer.from(input.credentials)
  };
}

// src/peer/PeerDiscoverySession.ts
var import_better_result7 = require("better-result");

// src/cache/DiscoveryCache.ts
var DiscoveryCache = class _DiscoveryCache {
  static DEFAULT_TTL_MS = 5 * 60 * 1e3;
  // 5 minutes
  cache = /* @__PURE__ */ new Map();
  roundRobinCounters = /* @__PURE__ */ new Map();
  ttl;
  constructor(ttlMs = _DiscoveryCache.DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }
  get(channelName) {
    const entry = this.cache.get(channelName);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      return entry.result;
    }
    return entry.result;
  }
  set(channelName, result) {
    this.cache.set(channelName, {
      result,
      expiresAt: Date.now() + this.ttl
    });
  }
  isStale(channelName) {
    const entry = this.cache.get(channelName);
    if (!entry) return true;
    return Date.now() > entry.expiresAt;
  }
  clear(channelName) {
    if (channelName) {
      this.cache.delete(channelName);
      for (const key of this.roundRobinCounters.keys()) {
        if (key.startsWith(`${channelName}:`)) {
          this.roundRobinCounters.delete(key);
        }
      }
    } else {
      this.cache.clear();
      this.roundRobinCounters.clear();
    }
  }
  nextRoundRobinIndex(key, size) {
    if (size <= 0) {
      return 0;
    }
    const current = this.roundRobinCounters.get(key) ?? 0;
    this.roundRobinCounters.set(key, (current + 1) % size);
    return current % size;
  }
};

// src/peer/DirectDiscoveryClient.ts
var grpc2 = __toESM(require("@grpc/grpc-js"), 1);
var import_crypto3 = require("crypto");
var import_protocol_grpc_pb = __toESM(require("@hyperledger/fabric-protos/lib/discovery/protocol_grpc_pb.js"), 1);
var import_protocol_pb = __toESM(require("@hyperledger/fabric-protos/lib/discovery/protocol_pb.js"), 1);
var import_message_pb = __toESM(require("@hyperledger/fabric-protos/lib/gossip/message_pb.js"), 1);
var import_identities_pb2 = __toESM(require("@hyperledger/fabric-protos/lib/msp/identities_pb.js"), 1);
var import_better_result6 = require("better-result");

// src/peer/endpointIdentity.ts
var import_better_result5 = require("better-result");
function normalizePeerEndpointIdentityResult(raw, tlsEnabled) {
  const value = raw.trim();
  if (!value) {
    return endpointConfigurationError("peer endpoint must be a non-empty host:port value");
  }
  const lower = value.toLowerCase();
  let scheme = tlsEnabled ? "grpcs" : "grpc";
  let hostPort = value;
  if (lower.startsWith("grpc://") || lower.startsWith("grpcs://")) {
    const parsed = new URL(value);
    if (parsed.protocol !== "grpc:" && parsed.protocol !== "grpcs:") {
      return endpointConfigurationError(`peer endpoint scheme must be grpc or grpcs: ${raw}`);
    }
    if (!["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash || !parsed.hostname || !parsed.port) {
      return endpointConfigurationError(`peer endpoint must be grpc(s)://host:port: ${raw}`);
    }
    scheme = parsed.protocol.slice(0, -1);
    hostPort = `${parsed.hostname}:${parsed.port}`;
  } else if (value.includes("://")) {
    return endpointConfigurationError(`peer endpoint scheme must be grpc or grpcs: ${raw}`);
  }
  const separator = hostPort.lastIndexOf(":");
  if (separator <= 0 || separator === hostPort.length - 1) {
    return endpointConfigurationError(`peer endpoint must include host:port: ${raw}`);
  }
  const host = hostPort.slice(0, separator).toLowerCase();
  const port = hostPort.slice(separator + 1);
  if (!/^\d+$/.test(port)) {
    return endpointConfigurationError(`peer endpoint port must be numeric: ${raw}`);
  }
  return import_better_result5.Result.ok(`${scheme}://${host}:${port}`);
}
function normalizePeerEndpointIdentity(raw, tlsEnabled) {
  const normalized = normalizePeerEndpointIdentityResult(raw, tlsEnabled);
  if (!normalized.isOk()) {
    throw normalized.error;
  }
  return normalized.value;
}
function dedupePeerEndpointInputsResult(inputs, tlsEnabled) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const input of inputs) {
    const canonical = normalizePeerEndpointIdentityResult(input, tlsEnabled);
    if (!canonical.isOk()) {
      return import_better_result5.Result.err(canonical.error);
    }
    if (seen.has(canonical.value)) {
      continue;
    }
    out.push(canonical.value);
    seen.add(canonical.value);
  }
  return import_better_result5.Result.ok(out);
}
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(":");
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}
function endpointConfigurationError(message) {
  return import_better_result5.Result.err(
    new ConfigurationError({
      field: "peerEndpoint",
      message
    })
  );
}

// src/peer/DirectDiscoveryClient.ts
var discoveryGrpc = import_protocol_grpc_pb.default;
var discoveryProto = import_protocol_pb.default;
var gossipProto = import_message_pb.default;
var { SerializedIdentity: SerializedIdentity2 } = import_identities_pb2.default;
var DirectDiscoveryClient = class {
  constructor(config) {
    this.config = config;
  }
  config;
  async discover(channelName) {
    const discoverySeed = this.config.discoverySeed || this.config.gatewayEndpoint;
    const discoveryTls = this.config.discoveryTls;
    const timeout = this.config.timeouts?.discovery ?? 5e3;
    const client = new discoveryGrpc.DiscoveryClient(
      discoverySeed,
      createDiscoveryCredentials(discoveryTls),
      channelOptions(discoverySeed, discoveryTls)
    );
    try {
      const request = await newSignedDiscoveryRequest(this.config, channelName);
      const response = await discoverWithDeadline(client, request, timeout);
      const discovery = discoveryResultFromResponseResult(
        response,
        channelName,
        !!discoveryTls?.trustedRoots
      );
      if (!discovery.isOk()) {
        return import_better_result6.Result.err(discovery.error);
      }
      return import_better_result6.Result.ok(discovery.value);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return import_better_result6.Result.err(error);
      }
      if (error instanceof TimeoutError) {
        return import_better_result6.Result.err(error);
      }
      return import_better_result6.Result.err(
        new DiscoveryError({
          message: `Discovery failed from ${discoverySeed}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : void 0
        })
      );
    } finally {
      client.close();
    }
  }
};
async function newSignedDiscoveryRequest(config, channelName) {
  const identity = new SerializedIdentity2();
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
  const signature = await config.signer((0, import_crypto3.createHash)("sha256").update(payload).digest());
  const signed = new discoveryProto.SignedRequest();
  signed.setPayload(payload);
  signed.setSignature(signature);
  return signed;
}
function discoveryResultFromResponseResult(response, channelName, tlsEnabled) {
  if (!response) {
    return import_better_result6.Result.err(new DiscoveryError({ message: "empty discovery response" }));
  }
  const results = response.getResultsList();
  if (results.length === 0) {
    return import_better_result6.Result.err(
      new DiscoveryError({ message: "empty discovery results" })
    );
  }
  const peers = /* @__PURE__ */ new Map();
  const orderers = [];
  for (const result of results) {
    const discoveryError = result.getError();
    if (discoveryError) {
      return import_better_result6.Result.err(
        new DiscoveryError({ message: `discovery service error: ${discoveryError.getContent()}` })
      );
    }
    const members = result.getMembers();
    if (members) {
      const parsedPeers = peersFromMembershipResult(members, tlsEnabled);
      if (!parsedPeers.isOk()) {
        return import_better_result6.Result.err(parsedPeers.error);
      }
      for (const [endpoint, peer5] of parsedPeers.value.entries()) {
        if (peers.has(endpoint)) {
          return import_better_result6.Result.err(
            new DiscoveryError({
              message: `Discovery returned duplicate peer endpoint identity: ${endpoint}`
            })
          );
        }
        peers.set(endpoint, peer5);
      }
      continue;
    }
    const config = result.getConfigResult();
    if (config) {
      orderers.push(...orderersFromConfigResult(config));
    }
  }
  if (peers.size === 0) {
    return import_better_result6.Result.err(new DiscoveryError({ message: "expected peer membership result" }));
  }
  return import_better_result6.Result.ok({
    timestamp: Date.now(),
    channelName,
    peers,
    orderers,
    msps: /* @__PURE__ */ new Map()
  });
}
function peersFromMembershipResult(members, tlsEnabled) {
  const peers = /* @__PURE__ */ new Map();
  const orgEntries = [];
  members.getPeersByOrgMap().forEach((orgPeers, mspId) => {
    orgEntries.push([mspId, orgPeers]);
  });
  orgEntries.sort(([left], [right]) => left.localeCompare(right));
  for (const [mspId, orgPeers] of orgEntries) {
    for (const peer5 of orgPeers.getPeersList()) {
      const rawEndpoint = peerEndpointFromDiscoveryPeerResult(peer5);
      if (!rawEndpoint.isOk()) {
        return import_better_result6.Result.err(rawEndpoint.error);
      }
      const endpoint = normalizePeerEndpointIdentityResult(
        rawEndpoint.value,
        tlsEnabled
      );
      if (!endpoint.isOk()) {
        return import_better_result6.Result.err(endpoint.error);
      }
      if (peers.has(endpoint.value)) {
        return import_better_result6.Result.err(
          new DiscoveryError({
            message: `Discovery returned duplicate peer endpoint identity: ${endpoint.value}`
          })
        );
      }
      const properties = discoveryPeerProperties(peer5);
      peers.set(endpoint.value, {
        name: endpointHost(endpoint.value),
        endpoint: endpoint.value,
        mspId,
        chaincodes: properties.chaincodes,
        ledgerHeight: properties.ledgerHeight
      });
    }
  }
  return import_better_result6.Result.ok(peers);
}
function orderersFromConfigResult(config) {
  const orderers = [];
  config.getOrderersMap().forEach((endpoints, mspId) => {
    for (const endpoint of endpoints.getEndpointList()) {
      const host = endpoint.getHost().trim();
      const port = endpoint.getPort();
      if (!host || port === 0) {
        continue;
      }
      orderers.push({ endpoint: `${host}:${port}`, mspId });
    }
  });
  return orderers.sort(
    (a, b) => a.endpoint === b.endpoint ? a.mspId.localeCompare(b.mspId) : a.endpoint.localeCompare(b.endpoint)
  );
}
function createDiscoveryCredentials(tlsOptions) {
  if (!tlsOptions?.trustedRoots) {
    return grpc2.credentials.createInsecure();
  }
  if (tlsOptions.clientKey && tlsOptions.clientCert) {
    return grpc2.credentials.createSsl(
      tlsOptions.trustedRoots,
      tlsOptions.clientKey,
      tlsOptions.clientCert
    );
  }
  return grpc2.credentials.createSsl(tlsOptions.trustedRoots);
}
function channelOptions(endpoint, tlsOptions) {
  const hostname = tlsOptions?.sslTargetNameOverride ?? endpointHost(endpoint);
  return {
    "grpc.max_receive_message_length": -1,
    "grpc.max_send_message_length": -1,
    ...hostname ? { "grpc.ssl_target_name_override": hostname } : {}
  };
}
function discoverWithDeadline(client, request, timeout) {
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
                timeout
              })
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
      }
    );
  });
}
function discoveryTLSCertHash(tlsOptions) {
  if (!tlsOptions?.clientCert) {
    return (0, import_crypto3.createHash)("sha256").update(Buffer.alloc(0)).digest();
  }
  try {
    return (0, import_crypto3.createHash)("sha256").update(new import_crypto3.X509Certificate(tlsOptions.clientCert).raw).digest();
  } catch {
    return (0, import_crypto3.createHash)("sha256").update(Buffer.alloc(0)).digest();
  }
}
function peerEndpointFromDiscoveryPeerResult(peer5) {
  const membershipInfo = peer5.getMembershipInfo();
  if (!membershipInfo) {
    return import_better_result6.Result.err(new DiscoveryError({ message: "discovered peer has no membership info" }));
  }
  const message = gossipProto.GossipMessage.deserializeBinary(membershipInfo.getPayload_asU8());
  const endpoint = message.getAliveMsg()?.getMembership()?.getEndpoint();
  if (!endpoint) {
    return import_better_result6.Result.err(new DiscoveryError({ message: "discovered peer has no endpoint" }));
  }
  return import_better_result6.Result.ok(endpoint);
}
function discoveryPeerProperties(peer5) {
  const stateInfo = peer5.getStateInfo();
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
      ledgerHeight: BigInt(properties.getLedgerHeight())
    };
  } catch {
    return { chaincodes: [], ledgerHeight: BigInt(0) };
  }
}

// src/peer/PeerDiscoverySession.ts
function endpointUsesTLS(config) {
  return !!config.discoveryTls?.trustedRoots;
}
var PeerDiscoverySession = class {
  constructor(config, discoveryCache) {
    this.config = config;
    this.discoveryCache = discoveryCache;
  }
  config;
  discoveryCache;
  async discover(channelName) {
    log().debug("PeerDiscoverySession.discover() - channel:", channelName);
    const cached = this.discoveryCache.get(channelName);
    if (cached && !this.discoveryCache.isStale(channelName)) {
      return import_better_result7.Result.ok(cached);
    }
    try {
      const discovered = await new DirectDiscoveryClient(this.config).discover(channelName);
      if (!discovered.isOk()) {
        throw discovered.error;
      }
      this.discoveryCache.set(channelName, discovered.value);
      return import_better_result7.Result.ok(discovered.value);
    } catch (error) {
      if (cached) {
        setTimeout(() => this.discover(channelName).catch(() => {
        }), 0);
        return import_better_result7.Result.ok(cached);
      }
      return import_better_result7.Result.err(
        new DiscoveryError({
          message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : void 0
        })
      );
    }
  }
  matchPeerByEndpointIdentity(discoveryResult, endpoint) {
    return discoveryResult.peers.get(this.normalizePeerEndpointIdentity(endpoint)) ?? null;
  }
  normalizePeerEndpointIdentity(endpoint) {
    return normalizePeerEndpointIdentity(endpoint, endpointUsesTLS(this.config));
  }
  usesDiscoveryTLS() {
    return endpointUsesTLS(this.config);
  }
};

// src/peer/PeerContract.ts
var import_better_result11 = require("better-result");
var fabricProtos3 = __toESM(require("@hyperledger/fabric-protos"), 1);

// src/peer/peerSelection.ts
var import_better_result8 = require("better-result");
function selectSinglePeersResult(discovery, discoveryCache) {
  const eligible = Array.from(discovery.peers.values());
  if (eligible.length === 0) {
    return import_better_result8.Result.err(
      new PeerNotFoundError({
        peerName: "<discovered peers>",
        availablePeers: Array.from(discovery.peers.keys())
      })
    );
  }
  const sorted = [...eligible].sort((a, b) => a.name.localeCompare(b.name));
  const orderedPeers = roundRobinOrder(sorted, discoveryCache, discovery.channelName);
  return import_better_result8.Result.ok({
    orderedPeers
  });
}
function roundRobinOrder(peers, discoveryCache, channelName) {
  const key = `${channelName}:${peers.map((peer5) => peer5.endpoint).join("|")}`;
  const start = discoveryCache.nextRoundRobinIndex(key, peers.length);
  return peers.slice(start).concat(peers.slice(0, start));
}

// src/peer/failoverEligibility.ts
function classifyFailover(error) {
  if (isKnownNonRetryable(error)) {
    return {
      eligible: false,
      category: "non-retryable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const grpcCode = getGrpcCode(error);
  if (grpcCode === 4) {
    return { eligible: true, category: "timeout", reason: "gRPC deadline exceeded" };
  }
  if (grpcCode === 14) {
    return { eligible: true, category: "peer-unavailable", reason: "gRPC unavailable" };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("deadline exceeded") || lower.includes("timeout") || lower.includes("timed out")) {
    return { eligible: true, category: "timeout", reason: message };
  }
  if (lower.includes("unavailable") || lower.includes("econnrefused") || lower.includes("econnreset") || lower.includes("enotfound") || lower.includes("no route to host")) {
    return { eligible: true, category: "peer-unavailable", reason: message };
  }
  if (lower.includes("transport") || lower.includes("socket closed") || lower.includes("connection reset") || lower.includes("tls") || lower.includes("http2")) {
    return { eligible: true, category: "transport", reason: message };
  }
  return {
    eligible: false,
    category: "unknown",
    reason: message || "unclassified error"
  };
}
function getGrpcCode(error) {
  if (!error || typeof error !== "object") {
    return void 0;
  }
  const code = error.code;
  return typeof code === "number" ? code : void 0;
}
function isKnownNonRetryable(error) {
  if (error instanceof Error) {
    return error.name === "EndorsementError" || error.name === "SubmitError" || error.name === "CommitError" || error.name === "EvaluationError" || error.name === "PeerNotFoundError" || error.name === "DiscoveryError" || error.name === "SinglePeerExecutionError";
  }
  return false;
}

// src/transactionTargeting.ts
var import_better_result9 = require("better-result");
var TransactionTargeting = class _TransactionTargeting {
  constructor(state) {
    this.state = state;
  }
  state;
  static gatewayDefault() {
    return new _TransactionTargeting({ kind: "gateway-default" });
  }
  static singlePeer() {
    return import_better_result9.Result.ok(new _TransactionTargeting({ kind: "single-peer" }));
  }
  static endorsingPeers(peerNames) {
    if (peerNames.length === 0) {
      return import_better_result9.Result.err(new ConfigurationError({
        field: "endorsingPeers",
        message: "UseEndorsingPeers requires at least one peer"
      }));
    }
    return import_better_result9.Result.ok(new _TransactionTargeting({
      kind: "endorsing-peers",
      peerNames: [...peerNames]
    }));
  }
  requiresPeerMode() {
    return this.state.kind !== "gateway-default";
  }
  isSinglePeer() {
    return this.state.kind === "single-peer";
  }
  endorsingPeerNames() {
    return this.state.kind === "endorsing-peers" ? [...this.state.peerNames] : [];
  }
  applyToPeerTransaction(transaction) {
    if (this.state.kind === "single-peer") {
      return transaction.UseSinglePeer();
    }
    if (this.state.kind === "endorsing-peers") {
      return transaction.UseEndorsingPeers(...this.state.peerNames);
    }
    return import_better_result9.Result.ok(transaction);
  }
};

// src/peer/PeerProposalBuilder.ts
var fabricProtos2 = __toESM(require("@hyperledger/fabric-protos"), 1);
var import_node_crypto2 = require("crypto");
var import_timestamp_pb2 = __toESM(require("google-protobuf/google/protobuf/timestamp_pb.js"), 1);
var { Timestamp: Timestamp2 } = import_timestamp_pb2.default;
function buildPeerProposal(options) {
  const creator = serializedIdentity2(options.proposalCreator);
  const nonce = options.nonce ? Buffer.from(options.nonce) : (0, import_node_crypto2.randomBytes)(24);
  const transactionId = (0, import_node_crypto2.createHash)("sha256").update(Buffer.concat([nonce, creator])).digest("hex");
  const chaincodeId = new fabricProtos2.peer.ChaincodeID();
  chaincodeId.setName(options.chaincodeName);
  const chaincodeInput = new fabricProtos2.peer.ChaincodeInput();
  chaincodeInput.setArgsList([options.transactionName, ...options.args].map(asBytes2));
  const chaincodeSpec = new fabricProtos2.peer.ChaincodeSpec();
  chaincodeSpec.setType(fabricProtos2.peer.ChaincodeSpec.Type.GOLANG);
  chaincodeSpec.setChaincodeId(chaincodeId);
  chaincodeSpec.setInput(chaincodeInput);
  const invocationSpec = new fabricProtos2.peer.ChaincodeInvocationSpec();
  invocationSpec.setChaincodeSpec(chaincodeSpec);
  const payload = new fabricProtos2.peer.ChaincodeProposalPayload();
  payload.setInput(invocationSpec.serializeBinary());
  const transientMap = payload.getTransientmapMap();
  for (const [key, value] of Object.entries(options.transientData ?? {})) {
    transientMap.set(key, value);
  }
  const chaincodeHeaderExtension = new fabricProtos2.peer.ChaincodeHeaderExtension();
  chaincodeHeaderExtension.setChaincodeId(chaincodeId);
  const channelHeader = new fabricProtos2.common.ChannelHeader();
  channelHeader.setType(fabricProtos2.common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(options.channelName);
  channelHeader.setTxId(transactionId);
  channelHeader.setTimestamp(Timestamp2.fromDate(options.timestamp ?? /* @__PURE__ */ new Date()));
  channelHeader.setExtension$(chaincodeHeaderExtension.serializeBinary());
  const signatureHeader = new fabricProtos2.common.SignatureHeader();
  signatureHeader.setCreator(creator);
  signatureHeader.setNonce(nonce);
  const header = new fabricProtos2.common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  header.setSignatureHeader(signatureHeader.serializeBinary());
  const proposal = new fabricProtos2.peer.Proposal();
  proposal.setHeader(header.serializeBinary());
  proposal.setPayload(payload.serializeBinary());
  const bytes = Buffer.from(proposal.serializeBinary());
  return {
    bytes,
    digest: (0, import_node_crypto2.createHash)("sha256").update(bytes).digest(),
    transactionId
  };
}
function serializedIdentity2(proposalCreator) {
  const identity = new fabricProtos2.msp.SerializedIdentity();
  identity.setMspid(proposalCreator.mspId);
  identity.setIdBytes(proposalCreator.credentials);
  return Buffer.from(identity.serializeBinary());
}
function asBytes2(value) {
  return typeof value === "string" ? Buffer.from(value) : value;
}

// src/peer/DirectPeerRuntime.ts
var grpc3 = __toESM(require("@grpc/grpc-js"), 1);
var import_common_pb = __toESM(require("@hyperledger/fabric-protos/lib/common/common_pb.js"), 1);
var import_ab_grpc_pb = __toESM(require("@hyperledger/fabric-protos/lib/orderer/ab_grpc_pb.js"), 1);
var import_peer_grpc_pb = __toESM(require("@hyperledger/fabric-protos/lib/peer/peer_grpc_pb.js"), 1);
var import_proposal_pb = __toESM(require("@hyperledger/fabric-protos/lib/peer/proposal_pb.js"), 1);
var import_better_result10 = require("better-result");
var commonProto = import_common_pb.default;
var ordererGrpc = import_ab_grpc_pb.default;
var peerGrpc = import_peer_grpc_pb.default;
var peerProposal = import_proposal_pb.default;
var DirectPeerRuntime = class {
  constructor(config) {
    this.config = config;
  }
  config;
  async processProposal(peerEndpoint, proposalBytes, signature) {
    const client = new peerGrpc.EndorserClient(
      endpointAddress(peerEndpoint),
      createCredentials(this.config.discoveryTls),
      channelOptions2(peerEndpoint, this.config.discoveryTls)
    );
    try {
      const request = new peerProposal.SignedProposal();
      request.setProposalBytes(proposalBytes);
      request.setSignature(signature);
      const response = await processProposalWithDeadline(
        client,
        request,
        this.config.timeouts?.endorse ?? 3e4
      );
      return adaptProposalResponse(response);
    } finally {
      client.close();
    }
  }
  async submitEnvelope(transactionBytes, signature, transactionId, discoveredOrdererEndpoint) {
    const ordererEndpoint = this.config.ordererEndpoint || discoveredOrdererEndpoint;
    if (!ordererEndpoint) {
      throw new ConfigurationError({
        field: "ordererEndpoint",
        message: "ordererEndpoint is required for direct endorsement submit when discovery returns no orderer endpoints"
      });
    }
    const client = new ordererGrpc.AtomicBroadcastClient(
      ordererEndpoint,
      createCredentials(this.config.ordererTls),
      channelOptions2(ordererEndpoint, this.config.ordererTls)
    );
    try {
      const envelope = new commonProto.Envelope();
      envelope.setPayload(transactionBytes);
      envelope.setSignature(signature);
      await broadcastEnvelopeWithDeadline(
        client,
        envelope,
        transactionId,
        this.config.timeouts?.submit ?? 3e4
      );
    } finally {
      client.close();
    }
  }
  async waitForCommit(channelName, transactionId) {
    const gatewayConnection = new GatewayConnection(this.config);
    const connected = await gatewayConnection.connect();
    if (!connected.isOk()) {
      return import_better_result10.Result.err(connected.error);
    }
    try {
      return await gatewayConnection.getCommitStatus(channelName, transactionId);
    } finally {
      await gatewayConnection.disconnect();
    }
  }
};
async function signDirectTransactionPayload(config, transactionPayload) {
  return Buffer.from(await config.signer(digestBytes(transactionPayload)));
}
function processProposalWithDeadline(client, request, timeout) {
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
      }
    );
  });
}
function adaptProposalResponse(proposalResponse) {
  const response = proposalResponse.getResponse();
  const endorsement = proposalResponse.getEndorsement();
  const status = response?.getStatus() ?? 0;
  if (status < 200 || status >= 400) {
    throw new EndorsementError({
      message: `proposal response was not successful, status ${status}: ${response?.getMessage() ?? ""}`
    });
  }
  if (!endorsement) {
    throw new EndorsementError({ message: "proposal response has no endorsement" });
  }
  return {
    response: response ? {
      status,
      message: response.getMessage(),
      payload: Buffer.from(response.getPayload_asU8())
    } : void 0,
    payload: Buffer.from(proposalResponse.getPayload_asU8()),
    endorsement: {
      endorser: Buffer.from(endorsement.getEndorser_asU8()),
      signature: Buffer.from(endorsement.getSignature_asU8())
    }
  };
}
function broadcastEnvelopeWithDeadline(client, envelope, transactionId, timeout) {
  return new Promise((resolve, reject) => {
    const stream = client.broadcast({ deadline: Date.now() + timeout });
    let settled = false;
    const finish = (error) => {
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
            transactionId
          })
        );
        return;
      }
      finish();
    });
    stream.on("error", (error) => {
      finish(
        new SubmitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId
        })
      );
    });
    stream.on("end", () => {
      finish(
        new SubmitError({
          message: "orderer broadcast ended without response",
          transactionId
        })
      );
    });
    stream.write(envelope);
  });
}
function createCredentials(tlsOptions) {
  if (!tlsOptions?.trustedRoots) {
    return grpc3.credentials.createInsecure();
  }
  if (tlsOptions.clientKey && tlsOptions.clientCert) {
    return grpc3.credentials.createSsl(
      tlsOptions.trustedRoots,
      tlsOptions.clientKey,
      tlsOptions.clientCert
    );
  }
  return grpc3.credentials.createSsl(tlsOptions.trustedRoots);
}
function channelOptions2(endpoint, tlsOptions) {
  const hostname = tlsOptions?.sslTargetNameOverride ?? endpointHost2(endpoint);
  return {
    "grpc.max_receive_message_length": -1,
    "grpc.max_send_message_length": -1,
    ...hostname ? { "grpc.ssl_target_name_override": hostname } : {}
  };
}
function endpointAddress(endpoint) {
  if (endpoint.startsWith("grpc://") || endpoint.startsWith("grpcs://")) {
    const parsed = new URL(endpoint);
    return `${parsed.hostname}:${parsed.port}`;
  }
  return endpoint;
}
function endpointHost2(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(":");
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}

// src/peer/PeerContract.ts
function hasEndorsement(response) {
  return !!response.endorsement;
}
var PeerNetwork = class {
  channelName;
  timeouts;
  config;
  peerConnection;
  discoveryCache;
  constructor(channelName, config, peerConnection, discoveryCache) {
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
  }
  async getContract(chaincodeName) {
    return new PeerContract(
      chaincodeName,
      this.timeouts,
      this.config,
      this.peerConnection,
      this.discoveryCache,
      this.channelName
    );
  }
};
async function NewPeerSignedProposal(peerConnection, config, message) {
  const decoded = decodePeerSignedMessage(message);
  if (!decoded.isOk()) {
    return import_better_result11.Result.err(decoded.error);
  }
  if (!decoded.value.routing || decoded.value.routing.mode === "gateway-default") {
    return import_better_result11.Result.err(
      new OfflineSigningError({
        field: "routing",
        message: "peer signed proposal requires peer routing"
      })
    );
  }
  const routingPeers = normalizeSnapshotPeerEndpoints(
    decoded.value.routing.peers,
    !!config.discoveryTls?.trustedRoots
  );
  if (!routingPeers.isOk()) {
    return import_better_result11.Result.err(routingPeers.error);
  }
  if (decoded.value.routing.mode === "single-peer" && routingPeers.value.length !== 1) {
    return import_better_result11.Result.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: "single-peer routing requires exactly one peer endpoint"
      })
    );
  }
  const routing = { ...decoded.value.routing, peers: routingPeers.value };
  try {
    const proposal = fabricProtos3.peer.Proposal.deserializeBinary(
      decoded.value.bytes
    );
    const header = fabricProtos3.common.Header.deserializeBinary(
      proposal.getHeader_asU8()
    );
    const channelHeader = fabricProtos3.common.ChannelHeader.deserializeBinary(
      header.getChannelHeader_asU8()
    );
    const channelName = channelHeader.getChannelId();
    return import_better_result11.Result.ok(
      new PeerSignedProposal(
        peerConnection,
        channelName,
        config,
        decoded.value.bytes,
        decoded.value.signature,
        routing
      )
    );
  } catch (error) {
    return import_better_result11.Result.err(
      new ConfigurationError({
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
var PeerContract = class {
  chaincodeName;
  timeouts;
  config;
  peerConnection;
  discoveryCache;
  channelName;
  constructor(chaincodeName, timeouts, config, peerConnection, discoveryCache, channelName) {
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  async Submit(name, ...args) {
    const tx = this.Transaction(name);
    return tx.Submit(...args);
  }
  async SubmitAsync(name, ...args) {
    const tx = this.Transaction(name);
    return tx.SubmitAsync(...args);
  }
  async Evaluate(name, ...args) {
    const tx = this.Transaction(name);
    return tx.Evaluate(...args);
  }
  Transaction(name) {
    log().debug("PeerContract.Transaction() - name:", name);
    return new PeerTransaction(
      name,
      this.chaincodeName,
      this.timeouts,
      this.config,
      this.peerConnection,
      this.discoveryCache,
      this.channelName
    );
  }
};
var PeerTransaction = class {
  name;
  chaincodeName;
  timeouts;
  config;
  peerConnection;
  discoveryCache;
  channelName;
  targeting = TransactionTargeting.gatewayDefault();
  transientData = {};
  proposalCreator;
  constructor(name, chaincodeName, timeouts, config, peerConnection, discoveryCache, channelName) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
    this.config = config;
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.channelName = channelName;
  }
  getName() {
    return this.name;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  UseSinglePeer() {
    const targeting = TransactionTargeting.singlePeer();
    if (!targeting.isOk()) {
      return import_better_result11.Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return import_better_result11.Result.ok(this);
  }
  UseEndorsingPeers(...peerNames) {
    const canonicalPeerNames = dedupePeerEndpointInputsResult(
      peerNames,
      this.peerConnection.usesDiscoveryTLS()
    );
    if (!canonicalPeerNames.isOk()) {
      return import_better_result11.Result.err(canonicalPeerNames.error);
    }
    const targeting = TransactionTargeting.endorsingPeers(canonicalPeerNames.value);
    if (!targeting.isOk()) {
      return import_better_result11.Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return import_better_result11.Result.ok(this);
  }
  SetTransientData(transientData) {
    this.transientData = copyTransientData2(transientData);
    return this;
  }
  SetProposalCreator(proposalCreator) {
    this.proposalCreator = copyProposalCreator2(proposalCreator);
    return this;
  }
  async Submit(...args) {
    const submittedResult = await this.SubmitAsync(...args);
    if (!submittedResult.isOk()) {
      return import_better_result11.Result.err(submittedResult.error);
    }
    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return import_better_result11.Result.err(commitStatus.error);
    }
    return import_better_result11.Result.ok(
      new PeerCommitResult(submittedResult.value, commitStatus.value)
    );
  }
  async SubmitAsync(...args) {
    log().debug(
      "PeerTransaction.SubmitAsync() - transaction:",
      this.name,
      "chaincode:",
      this.chaincodeName
    );
    const normalizedArgs = normalizeArgs2(args);
    return import_better_result11.Result.tryPromise({
      try: async () => {
        const submitted = this.targeting.isSinglePeer() ? await this.submitAsyncSinglePeer(normalizedArgs) : await this.submitAsyncEndorsingPeers(normalizedArgs);
        return new PeerSubmittedTx(
          submitted.result,
          submitted.transactionId,
          submitted.waitForCommit
        );
      },
      catch: (error) => this.mapSubmitError(error)
    });
  }
  async Evaluate(...args) {
    const normalizedArgs = normalizeArgs2(args);
    try {
      const result = this.targeting.isSinglePeer() ? await this.evaluateSinglePeer(normalizedArgs) : await this.evaluateEndorsingPeers(normalizedArgs);
      return import_better_result11.Result.ok(Buffer.from(result));
    } catch (error) {
      if (error instanceof SinglePeerExecutionError || error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof TimeoutError) {
        return import_better_result11.Result.err(error);
      }
      return import_better_result11.Result.err(
        new EvaluationError({
          message: error.message
        })
      );
    }
  }
  async NewUnsignedProposal(...args) {
    const normalizedArgs = normalizeArgs2(args);
    try {
      if (!this.proposalCreator) {
        return import_better_result11.Result.err(
          new ConfigurationError({
            field: "proposalCreator",
            message: "proposalCreator is required to build an unsigned proposal for offline signing"
          })
        );
      }
      if (this.targeting.isSinglePeer()) {
        const selected = (await this.resolveSinglePeerTargets())[0];
        if (!selected) {
          throw new PeerNotFoundError({
            peerName: "<single-peer>",
            availablePeers: []
          });
        }
        return import_better_result11.Result.ok(
          this.buildUnsignedProposal(normalizedArgs, {
            mode: "single-peer",
            peers: [selected.endpoint]
          })
        );
      }
      const endorsingPeerNames = this.targeting.endorsingPeerNames();
      const peers = endorsingPeerNames.length > 0 ? await this.resolvedEndorsingPeerSnapshot(endorsingPeerNames) : [];
      const routing = peers.length > 0 ? { mode: "endorsing-peers", peers } : { mode: "gateway-default" };
      return import_better_result11.Result.ok(this.buildUnsignedProposal(normalizedArgs, routing));
    } catch (error) {
      return import_better_result11.Result.err(this.mapSubmitError(error));
    }
  }
  buildUnsignedProposal(stringArgs, routing) {
    const proposal = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData2(this.transientData),
      proposalCreator: this.proposalCreator
    });
    return new PeerUnsignedProposal(
      proposal.bytes,
      proposal.digest,
      proposal.transactionId,
      routing
    );
  }
  async resolvedEndorsingPeerSnapshot(peerNames) {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }
    const peerInfos = this.resolvePeerInfos(discoveryResult.value, peerNames);
    if (!peerInfos.isOk()) {
      throw peerInfos.error;
    }
    return peerInfos.value.map((peer5) => peer5.endpoint);
  }
  async resolveSinglePeerTargets() {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }
    const selection = selectSinglePeersResult(
      discoveryResult.value,
      this.discoveryCache
    );
    if (!selection.isOk()) {
      throw selection.error;
    }
    return selection.value.orderedPeers;
  }
  async resolveEndorsingPeerTargets() {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }
    const peerInfos = this.resolvePeerInfos(
      discoveryResult.value,
      this.targeting.endorsingPeerNames()
    );
    if (!peerInfos.isOk()) {
      throw peerInfos.error;
    }
    return peerInfos.value;
  }
  async submitAsyncSinglePeer(stringArgs) {
    return this.executeSinglePeer("submitAsync", async (selected) => {
      return this.submitAsyncToSinglePeer(selected, stringArgs);
    });
  }
  async submitAsyncEndorsingPeers(stringArgs) {
    return this.submitAsyncToEndorsers(
      await this.resolveEndorsingPeerTargets(),
      stringArgs
    );
  }
  async evaluateSinglePeer(stringArgs) {
    return this.executeSinglePeer("evaluate", async (selected) => {
      return this.evaluateSinglePeerTarget(selected, stringArgs);
    });
  }
  async evaluateEndorsingPeers(stringArgs) {
    return this.evaluateEndorsers(
      await this.resolveEndorsingPeerTargets(),
      stringArgs
    );
  }
  async executeSinglePeer(operation, execute) {
    const peers = await this.resolveSinglePeerTargets();
    const attempts = [];
    const peersToTry = peers;
    for (let index = 0; index < peersToTry.length; index += 1) {
      const selected = peersToTry[index];
      try {
        return await execute(selected);
      } catch (error) {
        const decision = classifyFailover(error);
        attempts.push({
          peer: selected.endpoint,
          cause: error instanceof Error ? error.message : String(error),
          failover: decision
        });
        if (!decision.eligible) {
          throw error;
        }
        if (index === peersToTry.length - 1) {
          throw this.singlePeerExecutionError(operation, peers, attempts);
        }
        const next = peersToTry[index + 1];
        log().warn("fabric_bridge.single_peer.failover", {
          event: "fabric_bridge.single_peer.failover",
          operation,
          channel: this.channelName,
          chaincode: this.chaincodeName,
          transaction: this.name,
          failedPeer: selected.endpoint,
          nextPeer: next.endpoint,
          attempt: index + 1,
          maxAttempts: peersToTry.length,
          reason: decision.reason,
          category: decision.category
        });
      }
    }
    throw this.singlePeerExecutionError(operation, peers, attempts);
  }
  async submitAsyncToSinglePeer(peer5, stringArgs) {
    const prepared = await this.sendDirectSinglePeerProposal(peer5, stringArgs);
    const result = getPeerProposalPayload({
      responses: [prepared.proposalResponse]
    });
    const transactionPayload = buildPeerTransactionPayload(prepared.proposal, [
      prepared.proposalResponse
    ]);
    const runtime = new DirectPeerRuntime(this.config);
    await runtime.submitEnvelope(
      transactionPayload,
      await signDirectTransactionPayload(this.config, transactionPayload),
      prepared.transactionId,
      await this.resolveSubmitOrdererEndpoint()
    );
    return {
      result,
      transactionId: prepared.transactionId,
      waitForCommit: () => runtime.waitForCommit(this.channelName, prepared.transactionId)
    };
  }
  async evaluateSinglePeerTarget(peer5, stringArgs) {
    const prepared = await this.sendDirectSinglePeerProposal(peer5, stringArgs);
    return getPeerProposalPayload({ responses: [prepared.proposalResponse] });
  }
  async sendDirectSinglePeerProposal(peer5, stringArgs) {
    const built = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData2(this.transientData),
      proposalCreator: {
        mspId: this.config.identity.mspId,
        credentials: this.config.identity.credentials
      }
    });
    const signature = Buffer.from(await this.config.signer(built.digest));
    return {
      proposal: fabricProtos3.peer.Proposal.deserializeBinary(built.bytes),
      proposalResponse: await new DirectPeerRuntime(
        this.config
      ).processProposal(peer5.endpoint, built.bytes, signature),
      transactionId: built.transactionId
    };
  }
  async submitAsyncToEndorsers(peers, stringArgs) {
    const prepared = await this.sendDirectExplicitProposal(peers, stringArgs);
    const result = getPeerProposalPayload({
      responses: prepared.proposalResponses
    });
    const transactionPayload = buildPeerTransactionPayload(
      prepared.proposal,
      prepared.proposalResponses
    );
    const runtime = new DirectPeerRuntime(this.config);
    await runtime.submitEnvelope(
      transactionPayload,
      await signDirectTransactionPayload(this.config, transactionPayload),
      prepared.transactionId,
      await this.resolveSubmitOrdererEndpoint()
    );
    return {
      result,
      transactionId: prepared.transactionId,
      waitForCommit: () => runtime.waitForCommit(this.channelName, prepared.transactionId)
    };
  }
  async evaluateEndorsers(peers, stringArgs) {
    const prepared = await this.sendDirectExplicitProposal(peers, stringArgs);
    return getPeerProposalPayload({ responses: prepared.proposalResponses });
  }
  async sendDirectExplicitProposal(peers, stringArgs) {
    const built = buildPeerProposal({
      channelName: this.channelName,
      chaincodeName: this.chaincodeName,
      transactionName: this.name,
      args: stringArgs,
      transientData: copyTransientData2(this.transientData),
      proposalCreator: {
        mspId: this.config.identity.mspId,
        credentials: this.config.identity.credentials
      }
    });
    const signature = Buffer.from(await this.config.signer(built.digest));
    const runtime = new DirectPeerRuntime(this.config);
    const settled = await Promise.all(
      peers.map(async (peer5) => ({
        peer: peer5,
        response: await runtime.processProposal(
          peer5.endpoint,
          built.bytes,
          signature
        )
      }))
    );
    const proposalResponses = settled.map((item) => item.response);
    validateExplicitProposalResponses(proposalResponses);
    return {
      proposal: fabricProtos3.peer.Proposal.deserializeBinary(built.bytes),
      proposalResponses,
      transactionId: built.transactionId
    };
  }
  async ensureDiscovery() {
    const discovery = this.discoveryCache.get(this.channelName);
    if (discovery) {
      return import_better_result11.Result.ok(discovery);
    }
    const result = await this.peerConnection.discover(this.channelName);
    if (!result.isOk()) {
      return import_better_result11.Result.err(result.error);
    }
    return import_better_result11.Result.ok(result.value);
  }
  async resolveSubmitOrdererEndpoint() {
    if (this.config.ordererEndpoint) {
      return this.config.ordererEndpoint;
    }
    const discovery = await this.ensureDiscovery();
    if (!discovery.isOk()) {
      throw discovery.error;
    }
    return selectDiscoveredOrdererEndpoint(discovery.value.orderers);
  }
  resolvePeerInfos(discovery, peerNames) {
    const peerInfos = [];
    const notFound = [];
    const seen = /* @__PURE__ */ new Set();
    for (const peerName of peerNames) {
      const canonicalPeerName = this.peerConnection.normalizePeerEndpointIdentity(peerName);
      if (seen.has(canonicalPeerName)) {
        continue;
      }
      seen.add(canonicalPeerName);
      const peerInfo = this.peerConnection.matchPeerByEndpointIdentity(
        discovery,
        canonicalPeerName
      );
      if (!peerInfo) {
        notFound.push(canonicalPeerName);
        continue;
      }
      peerInfos.push(peerInfo);
    }
    if (notFound.length > 0) {
      return import_better_result11.Result.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers: Array.from(discovery.peers.keys())
        })
      );
    }
    return import_better_result11.Result.ok(peerInfos);
  }
  singlePeerExecutionError(operation, eligiblePeers, attempts) {
    return new SinglePeerExecutionError({
      message: `single-peer transaction failed after trying ${attempts.length} eligible peer(s)`,
      operation,
      channel: this.channelName,
      chaincode: this.chaincodeName,
      transaction: this.name,
      eligiblePeers: eligiblePeers.map((peer5) => peer5.endpoint),
      attempts
    });
  }
  mapSubmitError(error) {
    if (error instanceof EndorsementError || error instanceof SubmitError || error instanceof TimeoutError || error instanceof SinglePeerExecutionError || error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof ConfigurationError) {
      return error;
    }
    if (error.message?.includes("timeout") || error.message?.includes("Timeout") || error.message?.includes("TIMEOUT")) {
      return new TimeoutError({
        message: error.message,
        operation: "submit",
        timeout: this.timeouts.submit
      });
    }
    return new SubmitError({
      message: error.message
    });
  }
};
var PeerCommitResult = class {
  submitted;
  commitStatus;
  constructor(submitted, commitStatus) {
    this.submitted = submitted;
    this.commitStatus = commitStatus;
  }
  Result() {
    return this.submitted.Result();
  }
  TransactionID() {
    return this.submitted.TransactionID();
  }
  CommitStatus() {
    return this.commitStatus;
  }
};
var PeerSubmittedTx = class {
  result;
  transactionId;
  waitForCommitFn;
  constructor(result, transactionId, waitForCommitFn) {
    this.result = result;
    this.transactionId = transactionId;
    this.waitForCommitFn = waitForCommitFn;
  }
  Result() {
    return this.result;
  }
  TransactionID() {
    return this.transactionId;
  }
  async WaitForCommit() {
    return this.waitForCommitFn();
  }
};
var PeerUnsignedProposal = class {
  bytes;
  digest;
  transactionId;
  routing;
  constructor(bytes, digest, transactionId, routing) {
    this.bytes = Buffer.from(bytes);
    this.digest = Buffer.from(digest);
    this.transactionId = transactionId;
    this.routing = routing.mode === "gateway-default" ? { mode: "gateway-default" } : { mode: routing.mode, peers: [...routing.peers] };
  }
  Bytes() {
    return Buffer.from(this.bytes);
  }
  Digest() {
    return Buffer.from(this.digest);
  }
  TransactionID() {
    return this.transactionId;
  }
  CreatorIdentity() {
    return proposalCreatorIdentity(this.bytes);
  }
  CreatorMSPID() {
    return proposalCreatorMSPID(this.bytes);
  }
  CreatorCertificate() {
    return proposalCreatorCertificate(this.bytes);
  }
  SigningRequest() {
    return signingRequest(this.bytes, this.digest, this.routing);
  }
  WithSignature(signature) {
    return signedMessage(this.SigningRequest(), signature);
  }
};
var PeerSignedProposal = class {
  peerConnection;
  channelName;
  config;
  bytes;
  signature;
  routing;
  transactionId;
  proposal;
  constructor(peerConnection, channelName, config, bytes, signature, routing) {
    this.peerConnection = peerConnection;
    this.channelName = channelName;
    this.config = config;
    this.bytes = Buffer.from(bytes);
    this.signature = Buffer.from(signature);
    this.routing = {
      mode: routing.mode,
      peers: uniqueCanonicalPeerEndpoints(
        routing.peers,
        !!config.discoveryTls?.trustedRoots
      )
    };
    this.proposal = fabricProtos3.peer.Proposal.deserializeBinary(this.bytes);
    const header = fabricProtos3.common.Header.deserializeBinary(
      this.proposal.getHeader_asU8()
    );
    const channelHeader = fabricProtos3.common.ChannelHeader.deserializeBinary(
      header.getChannelHeader_asU8()
    );
    this.transactionId = channelHeader.getTxId();
  }
  TransactionID() {
    return this.transactionId;
  }
  async Endorse() {
    try {
      const proposalResponse = await this.sendProposal();
      const payload = getPeerProposalPayload(proposalResponse);
      const txPayload = buildPeerTransactionPayload(
        this.proposal,
        proposalResponse.responses
      );
      return import_better_result11.Result.ok(
        new PeerEndorsedTransaction(
          this.config,
          this.peerConnection,
          this.channelName,
          txPayload,
          payload,
          this.transactionId
        )
      );
    } catch (error) {
      if (error instanceof EndorsementError || error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof ConfigurationError) {
        return import_better_result11.Result.err(error);
      }
      return import_better_result11.Result.err(
        new EndorsementError({
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  async Evaluate() {
    try {
      const proposalResponse = await this.sendProposal();
      return import_better_result11.Result.ok(getPeerProposalPayload(proposalResponse));
    } catch (error) {
      if (error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof ConfigurationError) {
        return import_better_result11.Result.err(error);
      }
      return import_better_result11.Result.err(
        new EvaluationError({
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  async sendProposal() {
    const endpoints = await this.resolveSnapshottedPeerEndpoints();
    const runtime = new DirectPeerRuntime(this.config);
    const responses = await Promise.all(
      endpoints.map(
        (endpoint) => runtime.processProposal(endpoint, this.bytes, this.signature)
      )
    );
    if (this.routing.mode === "endorsing-peers") {
      validateExplicitProposalResponses(responses);
    }
    return { responses, errors: [] };
  }
  async resolveSnapshottedPeerEndpoints() {
    const discovery = await discoveredPeerEndpoints(
      this.peerConnection,
      this.channelName,
      !!this.config.discoveryTls?.trustedRoots
    );
    const missingFromDiscovery = this.routing.peers.filter(
      (endpoint) => !discovery.has(endpoint)
    );
    if (missingFromDiscovery.length > 0) {
      throw new PeerNotFoundError({
        peerName: missingFromDiscovery.join(", "),
        availablePeers: Array.from(discovery)
      });
    }
    return [...this.routing.peers];
  }
};
var PeerEndorsedTransaction = class {
  config;
  peerConnection;
  channelName;
  bytes;
  result;
  transactionId;
  constructor(config, peerConnection, channelName, bytes, result, transactionId) {
    this.config = config;
    this.peerConnection = peerConnection;
    this.channelName = channelName;
    this.bytes = Buffer.from(bytes);
    this.result = Buffer.from(result);
    this.transactionId = transactionId;
  }
  Bytes() {
    return Buffer.from(this.bytes);
  }
  Digest() {
    return digestBytes(this.bytes);
  }
  Result() {
    return Buffer.from(this.result);
  }
  TransactionID() {
    return this.transactionId;
  }
  async SubmitAsync() {
    try {
      const runtime = new DirectPeerRuntime(this.config);
      await runtime.submitEnvelope(
        this.bytes,
        await signDirectTransactionPayload(this.config, this.bytes),
        this.transactionId,
        await this.resolveSubmitOrdererEndpoint()
      );
      return import_better_result11.Result.ok(
        new PeerSubmittedTx(
          this.result,
          this.transactionId,
          () => runtime.waitForCommit(this.channelName, this.transactionId)
        )
      );
    } catch (error) {
      return import_better_result11.Result.err(
        error instanceof SubmitError ? error : new SubmitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId: this.transactionId
        })
      );
    }
  }
  async resolveSubmitOrdererEndpoint() {
    if (this.config.ordererEndpoint) {
      return this.config.ordererEndpoint;
    }
    const discovery = await this.peerConnection.discover(this.channelName);
    if (!discovery.isOk()) {
      throw discovery.error;
    }
    return selectDiscoveredOrdererEndpoint(discovery.value.orderers);
  }
  async Submit() {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) return import_better_result11.Result.err(submitted.error);
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) return import_better_result11.Result.err(status.error);
    return import_better_result11.Result.ok(new PeerCommitResult(submitted.value, status.value));
  }
};
function decodePeerSignedMessage(message) {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) return import_better_result11.Result.err(decoded.error);
  const actualDigest = digestBytes(decoded.value.bytes);
  if (!actualDigest.equals(decoded.value.digest)) {
    return import_better_result11.Result.err(
      new OfflineSigningError({
        field: "digest",
        message: "digest does not match proposal bytes"
      })
    );
  }
  return import_better_result11.Result.ok(decoded.value);
}
function getPeerProposalPayload(proposalResponse) {
  const valid = proposalResponse.responses?.find(
    (response) => response.endorsement
  );
  if (!valid) {
    throw new EndorsementError({
      message: noValidPeerResponsesMessage(proposalResponse)
    });
  }
  if (valid.response?.payload) {
    return Buffer.from(valid.response.payload);
  }
  throw new EndorsementError({
    message: "proposal response has no chaincode result payload"
  });
}
function validateExplicitProposalResponses(proposalResponses) {
  if (proposalResponses.length === 0) {
    throw new EndorsementError({
      message: "at least one proposal response is required"
    });
  }
  const first = proposalResponses[0];
  validateExplicitProposalResponse(first);
  const firstPayload = Buffer.from(first.payload ?? []);
  for (const response of proposalResponses.slice(1)) {
    validateExplicitProposalResponse(response);
    if (!firstPayload.equals(Buffer.from(response.payload ?? []))) {
      throw new EndorsementError({
        message: "proposal response payloads do not match"
      });
    }
  }
}
function validateExplicitProposalResponse(response) {
  if (!response) {
    throw new EndorsementError({ message: "proposal response is empty" });
  }
  const status = response.response?.status ?? 0;
  if (status < 200 || status >= 400) {
    throw new EndorsementError({
      message: `proposal response was not successful, status ${status}: ${response.response?.message ?? ""}`
    });
  }
  if (!response.endorsement) {
    throw new EndorsementError({
      message: "proposal response has no endorsement"
    });
  }
}
function buildPeerTransactionPayload(proposal, proposalResponses) {
  const validResponses = proposalResponses.filter(hasEndorsement);
  if (validResponses.length === 0) {
    throw new EndorsementError({ message: "No valid endorsements found" });
  }
  const header = fabricProtos3.common.Header.deserializeBinary(
    proposal.getHeader_asU8()
  );
  const endorsements = validResponses.map((response) => {
    const endorsement = new fabricProtos3.peer.Endorsement();
    endorsement.setEndorser(response.endorsement.endorser);
    endorsement.setSignature(response.endorsement.signature);
    return endorsement;
  });
  const proposalResponse = validResponses[0];
  const chaincodeEndorsedAction = new fabricProtos3.peer.ChaincodeEndorsedAction();
  chaincodeEndorsedAction.setProposalResponsePayload(proposalResponse.payload);
  chaincodeEndorsedAction.setEndorsementsList(endorsements);
  const originalProposalPayload = fabricProtos3.peer.ChaincodeProposalPayload.deserializeBinary(
    proposal.getPayload_asU8()
  );
  const proposalPayloadNoTransient = new fabricProtos3.peer.ChaincodeProposalPayload();
  proposalPayloadNoTransient.setInput(originalProposalPayload.getInput_asU8());
  const actionPayload = new fabricProtos3.peer.ChaincodeActionPayload();
  actionPayload.setAction(chaincodeEndorsedAction);
  actionPayload.setChaincodeProposalPayload(
    proposalPayloadNoTransient.serializeBinary()
  );
  const transactionAction = new fabricProtos3.peer.TransactionAction();
  transactionAction.setHeader(header.getSignatureHeader_asU8());
  transactionAction.setPayload(actionPayload.serializeBinary());
  const transaction = new fabricProtos3.peer.Transaction();
  transaction.setActionsList([transactionAction]);
  const payload = new fabricProtos3.common.Payload();
  payload.setHeader(header);
  payload.setData(transaction.serializeBinary());
  return Buffer.from(payload.serializeBinary());
}
function noValidPeerResponsesMessage(proposalResponse) {
  const errorInfos = [];
  for (const error of proposalResponse.errors ?? []) {
    errorInfos.push(
      `peer=${error?.connection?.name ?? "unknown"}, status=grpc, message=${error?.message ?? "unknown error"}`
    );
  }
  for (const response of proposalResponse.responses ?? []) {
    errorInfos.push(
      `status=${response.response?.status ?? "unknown"}, message=${response.response?.message ?? "unknown error"}`
    );
  }
  return errorInfos.length > 0 ? `No valid responses from any peers. Errors:
    ${errorInfos.join("\n    ")}` : "No valid responses from any peers";
}
function normalizeArgs2(args) {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Buffer) return arg;
    if (arg instanceof Uint8Array) {
      return Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength);
    }
    return JSON.stringify(arg);
  });
}
function uniqueCanonicalPeerEndpoints(peers, tlsEnabled) {
  return uniquePeerEndpoints(
    peers,
    (peer5) => normalizePeerEndpointIdentity(peer5, tlsEnabled)
  );
}
function normalizeSnapshotPeerEndpoints(peers, tlsEnabled) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const peer5 of peers) {
    const normalized = normalizePeerEndpointIdentityResult(peer5, tlsEnabled);
    if (!normalized.isOk()) {
      return import_better_result11.Result.err(
        new OfflineSigningError({
          field: "routing.peers",
          message: normalized.error.message
        })
      );
    }
    if (seen.has(normalized.value)) {
      continue;
    }
    seen.add(normalized.value);
    out.push(normalized.value);
  }
  return import_better_result11.Result.ok(out);
}
async function discoveredPeerEndpoints(peerConnection, channelName, _tlsEnabled) {
  const discovery = await peerConnection.discover(channelName);
  if (!discovery.isOk()) {
    throw discovery.error;
  }
  return new Set(discovery.value.peers.keys());
}
function selectDiscoveredOrdererEndpoint(orderers) {
  return [...orderers].sort(
    (a, b) => a.endpoint === b.endpoint ? a.mspId.localeCompare(b.mspId) : a.endpoint.localeCompare(b.endpoint)
  )[0]?.endpoint;
}
function uniquePeerEndpoints(peers, normalize) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const peer5 of peers) {
    const canonical = normalize(peer5);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}
function copyTransientData2(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Buffer.from(value)])
  );
}
function copyProposalCreator2(input) {
  return {
    mspId: input.mspId,
    credentials: Buffer.from(input.credentials)
  };
}

// src/FabricBridge.ts
var import_better_result12 = require("better-result");
function normalizeConfig(config) {
  return {
    ...config,
    discoverySeed: config.discoverySeed || config.gatewayEndpoint,
    discoveryTls: config.discoveryTls ?? config.gatewayTls,
    ordererTls: config.ordererTls ?? config.gatewayTls,
    timeouts: {
      ...DEFAULT_TIMEOUTS,
      ...config.timeouts
    }
  };
}
var FabricBridge = class {
  config;
  gatewayConnection = null;
  discoveryCache;
  isConnected = false;
  constructor(config) {
    this.config = normalizeConfig(config);
    this.discoveryCache = new DiscoveryCache();
    log().debug("FabricBridge creado", {
      gatewayEndpoint: this.config.gatewayEndpoint,
      discoverySeed: this.config.discoverySeed,
      ordererEndpoint: this.config.ordererEndpoint,
      mspId: config.identity.mspId,
      hasGatewayTls: !!this.config.gatewayTls,
      hasDiscoveryTls: !!this.config.discoveryTls,
      hasOrdererTls: !!this.config.ordererTls,
      hasTrustedRoots: !!this.config.gatewayTls?.trustedRoots,
      hasClientCert: !!this.config.gatewayTls?.clientCert,
      hasClientKey: !!this.config.gatewayTls?.clientKey,
      discovery: config.discovery
    });
  }
  async connect() {
    log().info("FabricBridge.connect() - Iniciando conexi\xF3n en modo GATEWAY");
    this.gatewayConnection = new GatewayConnection(this.config);
    log().debug(
      "FabricBridge.connect() - Llamando a GatewayConnection.connect()"
    );
    const gatewayResult = await this.gatewayConnection.connect();
    if (!gatewayResult.isOk()) {
      log().error(
        "FabricBridge.connect() - Error en GatewayConnection.connect():",
        gatewayResult.error
      );
      return import_better_result12.Result.err(gatewayResult.error);
    }
    this.isConnected = true;
    log().info("FabricBridge.connect() - Conexi\xF3n GATEWAY exitosa");
    return import_better_result12.Result.ok(void 0);
  }
  async disconnect() {
    log().info("FabricBridge.disconnect() - Desconectando");
    await this.gatewayConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }
  async WaitForCommit(channelName, transactionId) {
    if (!this.gatewayConnection) {
      return import_better_result12.Result.err(
        new NotConnectedError({
          component: "FabricBridge",
          action: "wait for commit"
        })
      );
    }
    return this.gatewayConnection.getCommitStatus(channelName, transactionId);
  }
  async getNetwork(channelName) {
    if (!this.isConnected || !this.config || !this.gatewayConnection) {
      log().error("FabricBridge.getNetwork() - No conectado");
      return import_better_result12.Result.err(
        new NotConnectedError({
          component: "FabricBridge",
          action: "connect"
        })
      );
    }
    log().debug(
      "FabricBridge.getNetwork() - Creando BridgeNetwork para canal:",
      channelName
    );
    return import_better_result12.Result.ok(
      new BridgeNetworkImpl(
        channelName,
        this.config,
        this.gatewayConnection,
        this.discoveryCache
      )
    );
  }
  async NewSignedProposal(message) {
    if (message.routing?.mode === "single-peer" || message.routing?.mode === "endorsing-peers") {
      const peerSession = new PeerDiscoverySession(
        this.config,
        this.discoveryCache
      );
      return NewPeerSignedProposal(peerSession, this.config, message);
    }
    if (!this.gatewayConnection) {
      return import_better_result12.Result.err(
        new NotConnectedError({
          component: "FabricBridge",
          action: "resume signed proposal"
        })
      );
    }
    return NewGatewaySignedProposal(
      this.gatewayConnection.getGateway(),
      message,
      { ...DEFAULT_TIMEOUTS, ...this.config.timeouts }
    );
  }
};
var BridgeNetworkImpl = class {
  channelName;
  config;
  gatewayNetwork;
  discoveryCache;
  constructor(channelName, config, gatewayConnection, discoveryCache) {
    this.channelName = channelName;
    this.config = config;
    this.discoveryCache = discoveryCache;
    this.gatewayNetwork = new GatewayNetwork(
      gatewayConnection,
      channelName,
      config
    );
  }
  async getContract(chaincodeName) {
    return new BridgeContractImpl(
      chaincodeName,
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.discoveryCache
    );
  }
  async ChaincodeEvents(chaincodeName, options) {
    return this.gatewayNetwork.ChaincodeEvents(chaincodeName, options);
  }
};
var BridgeContractImpl = class {
  chaincodeName;
  channelName;
  config;
  gatewayNetwork;
  discoveryCache;
  constructor(chaincodeName, channelName, config, gatewayNetwork, discoveryCache) {
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.discoveryCache = discoveryCache;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  async Submit(name, ...args) {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName
    );
    return gatewayContract.Submit(name, ...args);
  }
  async SubmitAsync(name, ...args) {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName
    );
    return gatewayContract.SubmitAsync(name, ...args);
  }
  async Evaluate(name, ...args) {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName
    );
    return gatewayContract.Evaluate(name, ...args);
  }
  Transaction(name) {
    return new BridgeTransactionImpl(
      name,
      this.chaincodeName,
      this.channelName,
      this.config,
      this.gatewayNetwork,
      this.discoveryCache
    );
  }
};
var BridgeTransactionImpl = class {
  name;
  chaincodeName;
  channelName;
  config;
  gatewayNetwork;
  discoveryCache;
  targeting = TransactionTargeting.gatewayDefault();
  transientData = {};
  proposalCreator;
  constructor(name, chaincodeName, channelName, config, gatewayNetwork, discoveryCache) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.channelName = channelName;
    this.config = config;
    this.gatewayNetwork = gatewayNetwork;
    this.discoveryCache = discoveryCache;
  }
  getName() {
    return this.name;
  }
  getChaincodeName() {
    return this.chaincodeName;
  }
  UseSinglePeer() {
    const targeting = TransactionTargeting.singlePeer();
    if (!targeting.isOk()) {
      return import_better_result12.Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return import_better_result12.Result.ok(this);
  }
  UseEndorsingPeers(...peerNames) {
    const canonicalPeerNames = dedupePeerEndpointInputsResult(
      peerNames,
      !!this.config.discoveryTls?.trustedRoots
    );
    if (!canonicalPeerNames.isOk()) {
      return import_better_result12.Result.err(canonicalPeerNames.error);
    }
    const targeting = TransactionTargeting.endorsingPeers(canonicalPeerNames.value);
    if (!targeting.isOk()) {
      return import_better_result12.Result.err(targeting.error);
    }
    this.targeting = targeting.value;
    return import_better_result12.Result.ok(this);
  }
  SetTransientData(transientData) {
    this.transientData = copyTransientData3(transientData);
    return this;
  }
  SetProposalCreator(proposalCreator) {
    this.proposalCreator = copyProposalCreator3(proposalCreator);
    return this;
  }
  async Submit(...args) {
    const submitted = await this.SubmitAsync(...args);
    if (!submitted.isOk()) {
      return import_better_result12.Result.err(submitted.error);
    }
    const commitStatus = await submitted.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return import_better_result12.Result.err(commitStatus.error);
    }
    return import_better_result12.Result.ok(
      new BridgeCommitResultImpl(submitted.value, commitStatus.value)
    );
  }
  async SubmitAsync(...args) {
    if (this.targeting.requiresPeerMode()) {
      try {
        const prepared = await this.createPeerTargetedTransaction();
        const submittedResult = await prepared.transaction.SubmitAsync(...args);
        if (!submittedResult.isOk()) {
          return import_better_result12.Result.err(submittedResult.error);
        }
        const commitPromise = submittedResult.value.WaitForCommit();
        void commitPromise.catch(() => void 0);
        return import_better_result12.Result.ok(
          new DeferredSubmittedTransaction(
            submittedResult.value.Result(),
            submittedResult.value.TransactionID(),
            () => commitPromise
          )
        );
      } catch (error) {
        if (error instanceof ConfigurationError || error instanceof TimeoutError) {
          return import_better_result12.Result.err(error);
        }
        return import_better_result12.Result.err(
          new SubmitError({
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }
    return (await this.createGatewayTransaction()).SubmitAsync(...args);
  }
  async Evaluate(...args) {
    if (this.targeting.requiresPeerMode()) {
      const prepared = await this.createPeerTargetedTransaction();
      return await prepared.transaction.Evaluate(...args);
    }
    return (await this.createGatewayTransaction()).Evaluate(...args);
  }
  async NewUnsignedProposal(...args) {
    if (!this.proposalCreator) {
      return import_better_result12.Result.err(
        new ConfigurationError({
          field: "proposalCreator",
          message: "proposalCreator is required to build an unsigned proposal for offline signing"
        })
      );
    }
    if (this.targeting.requiresPeerMode()) {
      const prepared = await this.createPeerTargetedTransaction();
      return await prepared.transaction.NewUnsignedProposal(...args);
    }
    return (await this.createGatewayTransaction()).NewUnsignedProposal(...args);
  }
  async createGatewayTransaction() {
    const gatewayContract = await this.gatewayNetwork.getContract(
      this.chaincodeName
    );
    return this.prepareTransaction(gatewayContract.Transaction(this.name));
  }
  async createPeerTargetedTransaction() {
    log().debug(
      "BridgeTransactionImpl - using direct peer discovery for:",
      this.chaincodeName
    );
    const peerSession = new PeerDiscoverySession(
      this.config,
      this.discoveryCache
    );
    const peerNetwork = new PeerNetwork(
      this.channelName,
      this.config,
      peerSession,
      this.discoveryCache
    );
    const peerContract = await peerNetwork.getContract(this.chaincodeName);
    const targetedTx = this.targeting.applyToPeerTransaction(
      this.prepareTransaction(peerContract.Transaction(this.name))
    );
    if (!targetedTx.isOk()) {
      throw targetedTx.error;
    }
    return { transaction: targetedTx.value };
  }
  prepareTransaction(transaction) {
    if (Object.keys(this.transientData).length > 0) {
      transaction.SetTransientData(this.transientData);
    }
    if (this.proposalCreator) {
      transaction.SetProposalCreator(this.proposalCreator);
    }
    return transaction;
  }
};
var BridgeCommitResultImpl = class {
  submitted;
  commitStatus;
  constructor(submitted, commitStatus) {
    this.submitted = submitted;
    this.commitStatus = commitStatus;
  }
  Result() {
    return this.submitted.Result();
  }
  TransactionID() {
    return this.submitted.TransactionID();
  }
  CommitStatus() {
    return this.commitStatus;
  }
};
var DeferredSubmittedTransaction = class {
  result;
  transactionId;
  waitForCommitFn;
  constructor(result, transactionId, waitForCommitFn) {
    this.result = result;
    this.transactionId = transactionId;
    this.waitForCommitFn = waitForCommitFn;
  }
  Result() {
    return this.result;
  }
  TransactionID() {
    return this.transactionId;
  }
  async WaitForCommit() {
    return this.waitForCommitFn();
  }
};
function copyTransientData3(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Buffer.from(value)])
  );
}
function copyProposalCreator3(input) {
  return {
    mspId: input.mspId,
    credentials: Buffer.from(input.credentials)
  };
}

// src/signers.ts
var import_node_crypto3 = require("crypto");
var import_nist = require("@noble/curves/nist");
var namedCurves = {
  "P-256": import_nist.p256,
  "P-384": import_nist.p384
};
function createSyncPrivateKeySigner(key) {
  if (key.type !== "private") {
    throw new Error(`Invalid key type: ${key.type}`);
  }
  switch (key.asymmetricKeyType) {
    case "ec":
      return createSyncECPrivateKeySigner(key);
    case "ed25519":
      return (message) => (0, import_node_crypto3.sign)(null, message, key);
    default:
      throw new Error(`Unsupported private key type: ${String(key.asymmetricKeyType)}`);
  }
}
function createSyncECPrivateKeySigner(key) {
  const { crv, d } = key.export({ format: "jwk" });
  if (!crv) {
    throw new Error("Missing EC curve name");
  }
  if (!d) {
    throw new Error("Missing EC private key value");
  }
  const curve = namedCurves[crv];
  if (!curve) {
    throw new Error(`Unsupported curve: ${crv}`);
  }
  const privateKey = Buffer.from(d, "base64url");
  return (digest) => Buffer.from(curve.sign(digest, privateKey, { lowS: true }).toBytes("der"));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChaincodeEventError,
  CommitError,
  ConfigurationError,
  DEFAULT_TIMEOUTS,
  DiscoveryError,
  EndorsementError,
  EvaluationError,
  FabricBridge,
  NotConnectedError,
  OfflineSigningError,
  PeerNotFoundError,
  SinglePeerExecutionError,
  SubmitError,
  TimeoutError,
  createSyncPrivateKeySigner,
  disableDebugLogging,
  enableDebugLogging,
  setLogger
});
//# sourceMappingURL=index.cjs.map