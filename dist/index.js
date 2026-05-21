// src/gateway/GatewayConnection.ts
import * as grpc from "@grpc/grpc-js";
import * as fabricGateway from "@hyperledger/fabric-gateway";
import { createHash } from "crypto";
import gatewayProtoModule from "@hyperledger/fabric-protos/lib/gateway/gateway_pb.js";
import identitiesProtoModule from "@hyperledger/fabric-protos/lib/msp/identities_pb.js";

// src/errors/index.ts
import { TaggedError } from "better-result";
var EndorsementError = class extends TaggedError("EndorsementError")() {
};
var DiscoveryError = class extends TaggedError("DiscoveryError")() {
};
var PeerNotFoundError = class extends TaggedError("PeerNotFoundError")() {
};
var SinglePeerExecutionError = class extends TaggedError("SinglePeerExecutionError")() {
};
var SubmitError = class extends TaggedError("SubmitError")() {
};
var CommitError = class extends TaggedError("CommitError")() {
};
var EvaluationError = class extends TaggedError("EvaluationError")() {
};
var ConfigurationError = class extends TaggedError("ConfigurationError")() {
};
var TimeoutError = class extends TaggedError("TimeoutError")() {
};
var NotConnectedError = class extends TaggedError("NotConnectedError")() {
};
var OfflineSigningError = class extends TaggedError("OfflineSigningError")() {
};

// src/gateway/GatewayConnection.ts
import { Result } from "better-result";

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
var gatewayProto = gatewayProtoModule;
var { SerializedIdentity } = identitiesProtoModule;
var GatewayConnection = class {
  client = null;
  gateway = null;
  config;
  constructor(config) {
    this.config = config;
  }
  async connect() {
    const { gatewayPeer, identity, signer, tlsOptions, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5e3;
    log().info("GatewayConnection.connect() - Iniciando conexi\xF3n");
    log().debug("GatewayConnection.connect() - Config:", {
      gatewayPeer,
      mspId: identity.mspId,
      hasTrustedRoots: !!tlsOptions?.trustedRoots,
      trustedRootsLength: tlsOptions?.trustedRoots?.length,
      hasClientCert: !!tlsOptions?.clientCert,
      clientCertLength: tlsOptions?.clientCert?.length,
      hasClientKey: !!tlsOptions?.clientKey,
      clientKeyLength: tlsOptions?.clientKey?.length,
      connectTimeout
    });
    return Result.tryPromise({
      try: async () => {
        log().debug("GatewayConnection.connect() - Creando credenciales TLS");
        let tlsCredentials;
        if (tlsOptions?.trustedRoots) {
          if (tlsOptions?.clientKey && tlsOptions?.clientCert) {
            log().debug("GatewayConnection.connect() - Usando mTLS (certificado cliente)");
            tlsCredentials = grpc.credentials.createSsl(
              tlsOptions.trustedRoots,
              tlsOptions.clientKey,
              tlsOptions.clientCert
            );
          } else {
            log().debug("GatewayConnection.connect() - Usando TLS normal (solo verificar servidor)");
            tlsCredentials = grpc.credentials.createSsl(tlsOptions.trustedRoots);
          }
        } else {
          log().debug("GatewayConnection.connect() - Usando conexi\xF3n insegura (sin TLS)");
          tlsCredentials = grpc.credentials.createInsecure();
        }
        const hostname = tlsOptions?.sslTargetNameOverride ?? this.extractHostname(gatewayPeer);
        const clientOptions = hostname ? {
          "grpc.ssl_target_name_override": hostname
        } : {};
        log().debug("GatewayConnection.connect() - Creando gRPC Client:", {
          endpoint: gatewayPeer,
          hostname,
          hasSslOverride: !!hostname
        });
        this.client = new grpc.Client(gatewayPeer, tlsCredentials, clientOptions);
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
            message: `Failed to connect to gateway peer: ${gatewayPeer}`,
            operation: "connect",
            timeout: connectTimeout
          });
        }
        log().error("GatewayConnection.connect() - Configuration error:", e instanceof Error ? e.message : String(e));
        return new ConfigurationError({
          message: `Failed to connect to gateway: ${e instanceof Error ? e.message : String(e)}`,
          field: "gatewayPeer"
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
      return Result.err(new NotConnectedError({
        component: "GatewayConnection",
        action: "get commit status"
      }));
    }
    const commitTimeout = this.config.timeouts?.commit ?? 6e4;
    const serializedIdentity2 = new SerializedIdentity();
    serializedIdentity2.setMspid(this.config.identity.mspId);
    serializedIdentity2.setIdBytes(this.config.identity.credentials);
    const request = new gatewayProto.CommitStatusRequest();
    request.setChannelId(channelName);
    request.setTransactionId(transactionId);
    request.setIdentity(serializedIdentity2.serializeBinary());
    const requestBytes = request.serializeBinary();
    const signature = await this.config.signer(createHash("sha256").update(requestBytes).digest());
    const signedRequest = new gatewayProto.SignedCommitStatusRequest();
    signedRequest.setRequest(requestBytes);
    signedRequest.setSignature(signature);
    return Result.tryPromise({
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
        const status = {
          blockNumber: BigInt(response.getBlockNumber()),
          status: response.getResult() === 0 ? "VALID" : "INVALID",
          transactionId
        };
        if (status.status !== "VALID") {
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

// src/gateway/GatewayContract.ts
import "@hyperledger/fabric-gateway";
import * as fabricProtos from "@hyperledger/fabric-protos";
import { Result as Result3 } from "better-result";
import { createHash as createHash3, randomBytes } from "crypto";
import timestampModule from "google-protobuf/google/protobuf/timestamp_pb.js";

// src/types/config.ts
var DEFAULT_TIMEOUTS = {
  endorse: 3e4,
  submit: 3e4,
  commit: 6e4,
  evaluate: 3e4,
  discovery: 5e3
};

// src/offlineSigning.ts
import { createHash as createHash2 } from "crypto";
import * as fabricGatewayProtos from "@hyperledger/fabric-protos";
import { Result as Result2 } from "better-result";
import fabproto6 from "fabric-protos";
function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function digestBytes(bytes) {
  return createHash2("sha256").update(bytes).digest();
}
function normalizeSignature(signature) {
  if (typeof signature === "string") {
    const decoded = decodeBase64(signature, "signature");
    if (!decoded.isOk()) {
      return Result2.err(decoded.error);
    }
    return Result2.ok(toBase64(decoded.value));
  }
  return Result2.ok(toBase64(signature));
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
    return Result2.err(normalized.error);
  }
  return Result2.ok({
    ...request,
    signature: normalized.value
  });
}
function decodeSignedMessage(message) {
  const bytes = decodeBase64(message.bytes, "bytes");
  if (!bytes.isOk()) {
    return Result2.err(bytes.error);
  }
  const digest = decodeBase64(message.digest, "digest");
  if (!digest.isOk()) {
    return Result2.err(digest.error);
  }
  const signature = decodeBase64(message.signature, "signature");
  if (!signature.isOk()) {
    return Result2.err(signature.error);
  }
  return Result2.ok({
    bytes: bytes.value,
    digest: digest.value,
    signature: signature.value,
    routing: message.routing
  });
}
function validateProposalRouting(routing) {
  if (!routing) {
    return Result2.err(
      new OfflineSigningError({
        field: "routing",
        message: "proposal signing request requires routing"
      })
    );
  }
  if (routing.mode === "gateway-default") {
    return Result2.ok(routing);
  }
  if (!Array.isArray(routing.peers) || routing.peers.length === 0) {
    return Result2.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: `${routing.mode} routing requires at least one peer endpoint`
      })
    );
  }
  return Result2.ok({
    mode: routing.mode,
    peers: [...routing.peers]
  });
}
function proposalCreatorIdentity(proposalBytes) {
  try {
    const proposal = fabproto6.protos.Proposal.decode(
      unwrapProposalBytes(proposalBytes)
    );
    const header = fabproto6.common.Header.decode(proposal.header);
    const signatureHeader = fabproto6.common.SignatureHeader.decode(
      header.signature_header
    );
    return Result2.ok(Buffer.from(signatureHeader.creator));
  } catch (error) {
    return Result2.err(
      new OfflineSigningError({
        field: "bytes",
        message: `unable to inspect proposal creator identity: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function proposalCreatorMSPID(proposalBytes) {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return Result2.err(creator.error);
  try {
    const identity = fabproto6.msp.SerializedIdentity.decode(creator.value);
    return Result2.ok(identity.mspid);
  } catch (error) {
    return Result2.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator MSPID: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function proposalCreatorCertificate(proposalBytes) {
  const creator = proposalCreatorIdentity(proposalBytes);
  if (!creator.isOk()) return Result2.err(creator.error);
  try {
    const identity = fabproto6.msp.SerializedIdentity.decode(creator.value);
    return Result2.ok(Buffer.from(identity.id_bytes));
  } catch (error) {
    return Result2.err(
      new OfflineSigningError({
        field: "creator",
        message: `unable to inspect proposal creator certificate: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }
}
function unwrapProposalBytes(proposalBytes) {
  const bytes = Buffer.from(proposalBytes);
  try {
    const proposedTransaction = fabricGatewayProtos.gateway.ProposedTransaction.deserializeBinary(bytes);
    const signedProposal = proposedTransaction.getProposal();
    const rawProposalBytes = signedProposal?.getProposalBytes_asU8();
    if (rawProposalBytes && rawProposalBytes.length > 0) {
      return Buffer.from(rawProposalBytes);
    }
  } catch {
  }
  return bytes;
}
function decodeBase64(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    return Result2.err(
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
        return Result2.err(
          new OfflineSigningError({
            field,
            message: `${field} is not valid canonical base64`
          })
        );
      }
    }
    return Result2.ok(decoded);
  } catch {
    return Result2.err(
      new OfflineSigningError({
        field,
        message: `${field} is not valid base64`
      })
    );
  }
}

// src/gateway/GatewayContract.ts
var { Timestamp } = timestampModule;
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
      return Result3.ok(Buffer.from(result));
    } catch (error) {
      return Result3.err(this.mapError(error, "evaluate"));
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
  UseSinglePeer(_options = {}) {
    return Result3.err(new ConfigurationError({
      message: "UseSinglePeer() is not supported in gateway mode. Use FabricBridge with discovery enabled for peer-targeted transactions."
    }));
  }
  UseEndorsingPeers(_peerNames) {
    return Result3.err(new ConfigurationError({
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
      return Result3.err(submittedResult.error);
    }
    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result3.err(commitStatus.error);
    }
    return Result3.ok(new GatewayCommitResult(submittedResult.value, commitStatus.value));
  }
  async SubmitAsync(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      const submitted = await this.contract.submitAsync(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData)
      });
      return Result3.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return Result3.err(this.mapSubmitError(error));
    }
  }
  async Evaluate(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      const result = await this.contract.evaluate(this.name, {
        arguments: normalizedArgs,
        transientData: copyTransientData(this.transientData)
      });
      return Result3.ok(Buffer.from(result));
    } catch (error) {
      return Result3.err(new EvaluationError({
        message: error.message
      }));
    }
  }
  async NewUnsignedProposal(...args) {
    const normalizedArgs = normalizeArgs(args);
    try {
      if (!this.proposalCreator) {
        return Result3.err(new ConfigurationError({
          field: "proposalCreator",
          message: "proposalCreator is required to build an unsigned proposal for offline signing"
        }));
      }
      return Result3.ok(new GatewayUnsignedProposal(buildGatewayProposal({
        channelName: this.channelName,
        chaincodeName: this.chaincodeName,
        transactionName: this.name,
        args: normalizedArgs,
        transientData: copyTransientData(this.transientData),
        proposalCreator: this.proposalCreator
      })));
    } catch (error) {
      return Result3.err(this.mapSubmitError(error));
    }
  }
  mapSubmitError(error) {
    if (error.message?.includes("timeout") || error.message?.includes("TIMEOUT")) {
      return new TimeoutError({
        message: error.message,
        operation: "submit",
        timeout: this.timeouts.submit
      });
    }
    if (error.name === "EndorseError") {
      return new EndorsementError({
        message: error.message
      });
    }
    return new SubmitError({
      message: error.message
    });
  }
};
function NewGatewaySignedProposal(gateway3, message, timeouts) {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) {
    return Result3.err(decoded.error);
  }
  const routing = validateProposalRouting(decoded.value.routing);
  if (!routing.isOk()) {
    return Result3.err(routing.error);
  }
  if (routing.value.mode !== "gateway-default") {
    return Result3.err(new ConfigurationError({
      field: "routing.mode",
      message: `Gateway signed proposal cannot resume ${routing.value.mode} routing`
    }));
  }
  try {
    const unsignedProposal = gateway3.newProposal(decoded.value.bytes);
    if (!Buffer.from(unsignedProposal.getDigest()).equals(decoded.value.digest)) {
      return Result3.err(new OfflineSigningError({
        field: "digest",
        message: "digest does not match proposal bytes"
      }));
    }
    const proposal = gateway3.newSignedProposal(decoded.value.bytes, decoded.value.signature);
    return Result3.ok(new GatewaySignedProposal(gateway3, proposal, timeouts));
  } catch (error) {
    return Result3.err(new SubmitError({ message: error.message }));
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
      return Result3.ok(new GatewayEndorsedTransaction(this.gateway, transaction, this.timeouts));
    } catch (error) {
      return Result3.err(new EndorsementError({ message: error.message }));
    }
  }
  async Evaluate() {
    try {
      const result = await this.proposal.evaluate();
      return Result3.ok(Buffer.from(result));
    } catch (error) {
      return Result3.err(new EvaluationError({ message: error.message }));
    }
  }
};
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
      return Result3.ok(new GatewaySubmittedTx(submitted, this.timeouts));
    } catch (error) {
      return Result3.err(new SubmitError({ message: error.message, transactionId: this.TransactionID() }));
    }
  }
  async Submit() {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) {
      return Result3.err(submitted.error);
    }
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) {
      return Result3.err(status.error);
    }
    return Result3.ok(new GatewayCommitResult(submitted.value, status.value));
  }
  SigningRequest() {
    return signingRequest(this.Bytes(), this.Digest());
  }
  WithSignature(signature) {
    return signedMessage(this.SigningRequest(), signature);
  }
  async SubmitWithSignature(signature) {
    const signed = this.WithSignature(signature);
    if (!signed.isOk()) return Result3.err(signed.error);
    const decoded = decodeSignedMessage(signed.value);
    if (!decoded.isOk()) return Result3.err(decoded.error);
    try {
      const transaction = this.gateway.newTransaction(decoded.value.bytes);
      if (!Buffer.from(transaction.getDigest()).equals(decoded.value.digest)) {
        return Result3.err(new OfflineSigningError({
          field: "digest",
          message: "digest does not match transaction bytes"
        }));
      }
      const signedTransaction = this.gateway.newSignedTransaction(decoded.value.bytes, decoded.value.signature);
      const submitted = await signedTransaction.submit();
      const submittedTx = new GatewaySubmittedTx(submitted, this.timeouts);
      const status = await submittedTx.WaitForCommit();
      if (!status.isOk()) return Result3.err(status.error);
      return Result3.ok(new GatewayCommitResult(submittedTx, status.value));
    } catch (error) {
      return Result3.err(new SubmitError({ message: error.message, transactionId: this.TransactionID() }));
    }
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
        return Result3.err(new CommitError({
          message: "transaction committed with invalid validation code",
          transactionId: status.transactionId,
          status: "INVALID"
        }));
      }
      return Result3.ok({
        blockNumber: status.blockNumber,
        status: "VALID",
        transactionId: status.transactionId
      });
    } catch (error) {
      return Result3.err(new CommitError({
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
  const nonce = randomBytes(24);
  const transactionId = createHash3("sha256").update(Buffer.concat([nonce, creator])).digest("hex");
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
    digest: createHash3("sha256").update(proposalBytes).digest(),
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

// src/peer/PeerConnection.ts
import * as fabricNetwork from "fabric-network";
import { Result as Result4 } from "better-result";

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
      this.triggerBackgroundRefresh(channelName);
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
  triggerBackgroundRefresh(channelName) {
  }
  getLastRefreshTime(channelName) {
    const entry = this.cache.get(channelName);
    if (!entry) return null;
    return entry.expiresAt - this.ttl;
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

// src/fabricIdentity.ts
import * as fabricCommon from "fabric-common";
var fabricCommonRuntime = fabricCommon;
function createProposalIdentityContext(baseIdentityContext, proposalCreator) {
  const user = createIdentityOnlyUser("proposal creator", proposalCreator.mspId, proposalCreator.credentials);
  return baseIdentityContext.client.newIdentityContext(user).calculateTransactionId();
}
function createBridgeIdentityProvider(config) {
  return {
    type: "bridge-x509",
    getCryptoSuite() {
      return fabricCommonRuntime.User.newCryptoSuite();
    },
    fromJson(data) {
      return data;
    },
    toJson(identity) {
      return identity;
    },
    async getUserContext(_identity, name) {
      return createSigningUser(name, config.identity.mspId, config.identity.credentials, config);
    }
  };
}
function createIdentityOnlyUser(name, mspId, certificate) {
  const cryptoSuite = fabricCommonRuntime.User.newCryptoSuite();
  const user = new fabricCommonRuntime.User(name);
  user.setCryptoSuite(cryptoSuite);
  user._mspId = mspId;
  user._identity = new fabricCommonRuntime.Identity(certificate.toString(), void 0, mspId, cryptoSuite);
  user._signingIdentity = void 0;
  return user;
}
async function createSigningUser(name, mspId, certificate, config) {
  const cryptoSuite = fabricCommonRuntime.User.newCryptoSuite();
  const user = new fabricCommonRuntime.User(name);
  user.setCryptoSuite(cryptoSuite);
  const publicKey = await cryptoSuite.createKeyFromRaw(certificate.toString());
  const signer = {
    sign: (digest) => {
      const signature = config.signer(digest);
      if (signature instanceof Promise) {
        throw new Error(
          "BridgeConfig.signer must return synchronously when used with fabric-network peer mode. Use createSyncPrivateKeySigner() for private-key bridge identities."
        );
      }
      return Buffer.from(signature);
    }
  };
  user._mspId = mspId;
  user.setSigningIdentity(new fabricCommonRuntime.SigningIdentity(
    certificate.toString(),
    publicKey,
    mspId,
    cryptoSuite,
    signer
  ));
  return user;
}

// src/peer/PeerConnection.ts
function isLocalhostEndpoint(endpoint) {
  const [host] = endpoint.split(":");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || !!host && host.startsWith("127.");
}
function sanitizeEndpoint(endpoint) {
  if (!endpoint) {
    return "";
  }
  return endpoint.trim().replace(/^"+|"+$/g, "");
}
function endpointUsesTLS(config) {
  return !!config.tlsOptions?.trustedRoots;
}
var PeerConnection = class {
  gateway = null;
  config;
  discoveryCache;
  constructor(config, discoveryCache) {
    this.config = config;
    this.discoveryCache = discoveryCache;
  }
  async connect() {
    const { identity, tlsOptions, timeouts } = this.config;
    const connectTimeout = timeouts?.discovery ?? 5e3;
    log().info("PeerConnection.connect() - Iniciando conexi\xF3n");
    log().debug("PeerConnection.connect() - Config:", {
      gatewayPeer: this.config.gatewayPeer,
      mspId: identity.mspId,
      hasTrustedRoots: !!tlsOptions?.trustedRoots,
      trustedRootsLength: tlsOptions?.trustedRoots?.length,
      hasClientCert: !!tlsOptions?.clientCert,
      clientCertLength: tlsOptions?.clientCert?.length,
      hasClientKey: !!tlsOptions?.clientKey,
      clientKeyLength: tlsOptions?.clientKey?.length,
      discovery: this.config.discovery,
      connectTimeout
    });
    return Result4.tryPromise({
      try: async () => {
        const bridgeIdentity = {
          type: "bridge-x509",
          mspId: identity.mspId,
          credentials: {
            certificate: identity.credentials.toString()
          }
        };
        const asLocalhost = isLocalhostEndpoint(this.config.gatewayPeer);
        log().debug(`PeerConnection.connect() - Auto-detected asLocalhost: ${asLocalhost} (from ${this.config.gatewayPeer})`);
        const gatewayOptions = {
          identity: bridgeIdentity,
          identityProvider: createBridgeIdentityProvider(this.config),
          discovery: {
            enabled: this.config.discovery ?? true,
            asLocalhost
          },
          eventHandlerOptions: {
            commitTimeout: Math.round(
              Math.min(this.config.timeouts?.commit ?? 5e3, 5e3) / 1e3
            )
          },
          tlsInfo: tlsOptions?.clientCert && tlsOptions?.clientKey ? {
            certificate: tlsOptions.clientCert.toString(),
            key: tlsOptions.clientKey.toString()
          } : void 0
        };
        log().debug("PeerConnection.connect() - GatewayOptions:", {
          identity: identity.mspId,
          discoveryEnabled: gatewayOptions.discovery?.enabled,
          discoveryAsLocalhost: gatewayOptions.discovery?.asLocalhost,
          hasTlsInfo: !!gatewayOptions.tlsInfo
        });
        this.gateway = new fabricNetwork.Gateway();
        log().debug("PeerConnection.connect() - Creando connection profile");
        const connectionProfile = this.createMinimalConnectionProfile();
        log().debug("PeerConnection.connect() - Connection profile:", JSON.stringify({
          name: connectionProfile.name,
          version: connectionProfile.version,
          organization: connectionProfile.client?.organization,
          peerCount: connectionProfile.peers ? Object.keys(connectionProfile.peers).length : 0
        }, null, 2));
        log().debug("PeerConnection.connect() - Llamando a gateway.connect()");
        await this.gateway.connect(connectionProfile, gatewayOptions);
        log().info("PeerConnection.connect() - Conexi\xF3n exitosa");
      },
      catch: (e) => {
        log().error("PeerConnection.connect() - Error:", e instanceof Error ? e.message : String(e));
        if (e instanceof Error && e.message.includes("timeout")) {
          return new TimeoutError({
            message: `Failed to connect to peer network: ${e.message}`,
            operation: "connect",
            timeout: connectTimeout
          });
        }
        return new ConfigurationError({
          message: `Failed to connect to peer network: ${e instanceof Error ? e.message : String(e)}`
        });
      }
    });
  }
  getGateway() {
    if (!this.gateway) {
      throw new Error("Peer gateway not connected. Call connect() first.");
    }
    return this.gateway;
  }
  async disconnect() {
    log().info("PeerConnection.disconnect() - Desconectando");
    this.gateway?.disconnect();
    this.gateway = null;
    await new Promise((resolve) => setImmediate(resolve));
  }
  async discover(channelName) {
    log().debug("PeerConnection.discover() - Iniciando discovery para canal:", channelName);
    const cached = this.discoveryCache.get(channelName);
    if (cached && !this.discoveryCache.isStale(channelName)) {
      log().debug("PeerConnection.discover() - Usando cache para canal:", channelName);
      return Result4.ok(cached);
    }
    try {
      if (!this.gateway) {
        log().error("PeerConnection.discover() - Gateway no conectado");
        throw new Error("Not connected");
      }
      log().debug("PeerConnection.discover() - Obteniendo network para canal:", channelName);
      const network = await this.gateway.getNetwork(channelName);
      const discoveryService = network.discoveryService;
      if (!discoveryService) {
        log().error("PeerConnection.discover() - Discovery service no disponible");
        throw new Error("Discovery service not available");
      }
      log().debug("PeerConnection.discover() - Parseando resultados de discovery");
      const result = this.parseDiscoveryResults(discoveryService, channelName);
      log().info("PeerConnection.discover() - Discovery exitoso:", {
        channelName,
        peerCount: result.peers.size,
        ordererCount: result.orderers.length,
        mspCount: result.msps.size
      });
      this.discoveryCache.set(channelName, result);
      return Result4.ok(result);
    } catch (error) {
      log().error("PeerConnection.discover() - Error:", error instanceof Error ? error.message : String(error));
      if (cached) {
        log().debug("PeerConnection.discover() - Usando cache stale como fallback");
        setTimeout(() => this.discover(channelName).catch(() => {
        }), 0);
        return Result4.ok(cached);
      }
      return Result4.err(
        new DiscoveryError({
          message: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          cause: error instanceof Error ? error : void 0
        })
      );
    }
  }
  createMinimalConnectionProfile() {
    const { gatewayPeer, tlsOptions, identity } = this.config;
    const [hostPart] = gatewayPeer.split(":");
    const host = hostPart || "localhost";
    const mspId = identity.mspId;
    const peerName = tlsOptions?.sslTargetNameOverride ?? host;
    const profile = {
      name: "bridge-network",
      version: "1.0",
      client: {
        organization: mspId,
        connection: {
          timeout: {
            peer: {
              endorser: this.config.timeouts?.endorse || 3e4
            }
          }
        }
      },
      organizations: {},
      peers: {}
    };
    profile.organizations[mspId] = {
      mspid: mspId,
      peers: [peerName]
    };
    profile.peers[peerName] = {
      url: `${tlsOptions ? "grpcs" : "grpc"}://${gatewayPeer}`,
      tlsCACerts: tlsOptions?.trustedRoots ? {
        pem: tlsOptions.trustedRoots.toString()
      } : void 0,
      grpcOptions: {
        "ssl-target-name-override": peerName
      }
    };
    return profile;
  }
  parseDiscoveryResults(discoveryService, channelName) {
    const results = discoveryService.discoveryResults || {};
    const peers = /* @__PURE__ */ new Map();
    const orderers = [];
    const msps = /* @__PURE__ */ new Map();
    const discoveredPeers = results.peers_by_org || {};
    for (const [mspId, orgInfo] of Object.entries(discoveredPeers)) {
      const peersList = orgInfo.peers || [];
      for (const peer2 of peersList) {
        const endpoint = this.normalizePeerEndpointIdentity(sanitizeEndpoint(peer2.endpoint));
        if (peers.has(endpoint)) {
          throw new Error(`Discovery returned duplicate peer endpoint identity: ${endpoint}`);
        }
        const peerName = endpointHost(endpoint) || "unknown";
        peers.set(endpoint, {
          name: peerName,
          endpoint,
          mspId,
          chaincodes: peer2.chaincodes?.map((cc) => cc.name) || [],
          ledgerHeight: BigInt(peer2.ledger_height?.high || 0) << BigInt(32) | BigInt(peer2.ledger_height?.low || 0)
        });
      }
    }
    const discoveredOrderers = results.orderers || {};
    for (const [mspId, ordererInfo] of Object.entries(discoveredOrderers)) {
      const endpoints = ordererInfo.endpoints || [];
      for (const endpoint of endpoints) {
        orderers.push({
          endpoint: `${endpoint.host}:${endpoint.port}`,
          mspId
        });
      }
    }
    const discoveredMsps = results.msps || {};
    for (const [mspId, mspInfo] of Object.entries(discoveredMsps)) {
      msps.set(mspId, {
        id: mspId,
        tlsRootCerts: mspInfo.tls_root_certs?.map(
          (cert) => Buffer.from(cert)
        ) || []
      });
    }
    return {
      timestamp: Date.now(),
      channelName,
      peers,
      orderers,
      msps
    };
  }
  matchPeerByEndpointIdentity(discoveryResult, endpoint) {
    const canonicalEndpoint = this.normalizePeerEndpointIdentity(endpoint);
    return discoveryResult.peers.get(canonicalEndpoint) ?? null;
  }
  normalizePeerEndpointIdentity(endpoint) {
    return normalizePeerEndpointIdentity(endpoint, endpointUsesTLS(this.config));
  }
};
function normalizePeerEndpointIdentity(raw, tlsEnabled) {
  const value = raw.trim();
  if (!value) {
    throw new ConfigurationError({
      field: "peerEndpoint",
      message: "peer endpoint must be a non-empty host:port value"
    });
  }
  const lower = value.toLowerCase();
  let scheme = tlsEnabled ? "grpcs" : "grpc";
  let hostPort = value;
  if (lower.startsWith("grpc://") || lower.startsWith("grpcs://")) {
    const parsed = new URL(value);
    if (parsed.protocol !== "grpc:" && parsed.protocol !== "grpcs:") {
      throw new ConfigurationError({
        field: "peerEndpoint",
        message: `peer endpoint scheme must be grpc or grpcs: ${raw}`
      });
    }
    if (!["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash || !parsed.hostname || !parsed.port) {
      throw new ConfigurationError({
        field: "peerEndpoint",
        message: `peer endpoint must be grpc(s)://host:port: ${raw}`
      });
    }
    scheme = parsed.protocol.slice(0, -1);
    hostPort = `${parsed.hostname}:${parsed.port}`;
  } else if (value.includes("://")) {
    throw new ConfigurationError({
      field: "peerEndpoint",
      message: `peer endpoint scheme must be grpc or grpcs: ${raw}`
    });
  }
  const separator = hostPort.lastIndexOf(":");
  if (separator <= 0 || separator === hostPort.length - 1) {
    throw new ConfigurationError({
      field: "peerEndpoint",
      message: `peer endpoint must include host:port: ${raw}`
    });
  }
  const host = hostPort.slice(0, separator).toLowerCase();
  const port = hostPort.slice(separator + 1);
  if (!/^\d+$/.test(port)) {
    throw new ConfigurationError({
      field: "peerEndpoint",
      message: `peer endpoint port must be numeric: ${raw}`
    });
  }
  return `${scheme}://${host}:${port}`;
}
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(":");
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}

// src/peer/PeerContract.ts
import "fabric-network";
import { Result as Result6 } from "better-result";
import {
  asBuffer,
  getTransactionResponse
} from "fabric-network/lib/impl/gatewayutils.js";

// src/peer/peerSelection.ts
function selectSinglePeers(discovery, peerConnection, discoveryCache, options) {
  const candidates = options?.candidates?.filter((candidate) => candidate.trim() !== "");
  const eligible = candidates && candidates.length > 0 ? resolveCandidatePeers(discovery, peerConnection, candidates) : Array.from(discovery.peers.values());
  if (eligible.length === 0) {
    throw new PeerNotFoundError({
      peerName: candidates && candidates.length > 0 ? candidates.join(", ") : "<discovered peers>",
      availablePeers: Array.from(discovery.peers.keys())
    });
  }
  const policy = options?.policy ?? "round-robin";
  const sorted = [...eligible].sort((a, b) => a.name.localeCompare(b.name));
  const orderedPeers = policy === "random" ? randomOrder(sorted) : roundRobinOrder(sorted, discoveryCache, discovery.channelName, candidates);
  return {
    orderedPeers,
    candidates
  };
}
function resolveCandidatePeers(discovery, peerConnection, candidates) {
  const resolved = [];
  const missing = [];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const canonicalCandidate = peerConnection.normalizePeerEndpointIdentity(candidate);
    if (seen.has(canonicalCandidate)) {
      continue;
    }
    const peer2 = peerConnection.matchPeerByEndpointIdentity(discovery, canonicalCandidate);
    if (!peer2) {
      missing.push(canonicalCandidate);
      continue;
    }
    resolved.push(peer2);
    seen.add(peer2.endpoint);
  }
  if (missing.length > 0) {
    throw new PeerNotFoundError({
      peerName: missing.join(", "),
      availablePeers: Array.from(discovery.peers.keys())
    });
  }
  return resolved;
}
function roundRobinOrder(peers, discoveryCache, channelName, candidates) {
  const key = `${channelName}:${peers.map((peer2) => peer2.endpoint).join("|")}:${candidates?.join("|") ?? "*"}`;
  const start = discoveryCache.nextRoundRobinIndex(key, peers.length);
  return peers.slice(start).concat(peers.slice(0, start));
}
function randomOrder(peers) {
  const out = [...peers];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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
import { Result as Result5 } from "better-result";
var VALID_POLICIES = /* @__PURE__ */ new Set(["round-robin", "random"]);
var TransactionTargeting = class _TransactionTargeting {
  constructor(state) {
    this.state = state;
  }
  state;
  static gatewayDefault() {
    return new _TransactionTargeting({ kind: "gateway-default" });
  }
  static singlePeer(options = {}) {
    if (options.policy !== void 0 && !VALID_POLICIES.has(options.policy)) {
      return Result5.err(new ConfigurationError({
        field: "singlePeer.policy",
        message: `unsupported peer selection policy: ${String(options.policy)}`
      }));
    }
    return Result5.ok(new _TransactionTargeting({
      kind: "single-peer",
      options: {
        failover: true,
        ...options,
        candidates: options.candidates?.length ? [...options.candidates] : void 0
      }
    }));
  }
  static endorsingPeers(peerNames) {
    if (peerNames.length === 0) {
      return Result5.err(new ConfigurationError({
        field: "endorsingPeers",
        message: "UseEndorsingPeers requires at least one peer"
      }));
    }
    return Result5.ok(new _TransactionTargeting({
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
  singlePeerOptions() {
    return this.state.kind === "single-peer" ? this.state.options : null;
  }
  endorsingPeerNames() {
    return this.state.kind === "endorsing-peers" ? [...this.state.peerNames] : [];
  }
  applyToPeerTransaction(transaction) {
    if (this.state.kind === "single-peer") {
      return transaction.UseSinglePeer(this.state.options);
    }
    if (this.state.kind === "endorsing-peers") {
      return transaction.UseEndorsingPeers(this.state.peerNames);
    }
    return Result5.ok(transaction);
  }
};

// src/peer/PeerContract.ts
import fabproto62 from "fabric-protos";
var PeerNetwork = class {
  gateway;
  channelName;
  timeouts;
  peerConnection;
  discoveryCache;
  networkPromise = null;
  constructor(gateway3, channelName, config, peerConnection, discoveryCache) {
    this.gateway = gateway3;
    this.channelName = channelName;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.peerConnection = peerConnection;
    this.discoveryCache = discoveryCache;
    this.networkPromise = this.gateway.getNetwork(channelName);
  }
  async getContract(chaincodeName) {
    const network = await this.networkPromise;
    const contract = network.getContract(chaincodeName);
    return new PeerContract(
      contract,
      chaincodeName,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName
    );
  }
};
async function NewPeerSignedProposal(gateway3, config, message) {
  const decoded = decodePeerSignedMessage(message);
  if (!decoded.isOk()) {
    return Result6.err(decoded.error);
  }
  if (!decoded.value.routing || decoded.value.routing.mode === "gateway-default") {
    return Result6.err(
      new OfflineSigningError({
        field: "routing",
        message: "peer signed proposal requires peer routing"
      })
    );
  }
  const routingPeers = normalizeSnapshotPeerEndpoints(
    decoded.value.routing.peers,
    !!config.tlsOptions?.trustedRoots
  );
  if (!routingPeers.isOk()) {
    return Result6.err(routingPeers.error);
  }
  const routing = { ...decoded.value.routing, peers: routingPeers.value };
  try {
    const proposal = fabproto62.protos.Proposal.decode(decoded.value.bytes);
    const header = fabproto62.common.Header.decode(proposal.header);
    const channelHeader = fabproto62.common.ChannelHeader.decode(
      header.channel_header
    );
    const channelName = channelHeader.channel_id;
    const network = await gateway3.getNetwork(channelName);
    return Result6.ok(
      new PeerSignedProposal(
        network,
        channelName,
        config,
        decoded.value.bytes,
        decoded.value.signature,
        routing
      )
    );
  } catch (error) {
    return Result6.err(
      new ConfigurationError({
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
var PeerContract = class {
  contract;
  chaincodeName;
  timeouts;
  peerConnection;
  discoveryCache;
  channelName;
  constructor(contract, chaincodeName, timeouts, peerConnection, discoveryCache, channelName) {
    this.contract = contract;
    this.chaincodeName = chaincodeName;
    this.timeouts = timeouts;
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
      this.contract,
      this.timeouts,
      this.peerConnection,
      this.discoveryCache,
      this.channelName
    );
  }
};
var PeerTransaction = class {
  name;
  chaincodeName;
  contract;
  timeouts;
  peerConnection;
  discoveryCache;
  channelName;
  targeting = TransactionTargeting.gatewayDefault();
  transientData = {};
  proposalCreator;
  constructor(name, chaincodeName, contract, timeouts, peerConnection, discoveryCache, channelName) {
    this.name = name;
    this.chaincodeName = chaincodeName;
    this.contract = contract;
    this.timeouts = timeouts;
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
  UseSinglePeer(options = {}) {
    const targeting = TransactionTargeting.singlePeer(options);
    if (!targeting.isOk()) {
      return Result6.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result6.ok(this);
  }
  UseEndorsingPeers(peerNames) {
    const targeting = TransactionTargeting.endorsingPeers(peerNames);
    if (!targeting.isOk()) {
      return Result6.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result6.ok(this);
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
      return Result6.err(submittedResult.error);
    }
    const commitStatus = await submittedResult.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result6.err(commitStatus.error);
    }
    return Result6.ok(
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
    return Result6.tryPromise({
      try: async () => {
        const submitted = this.targeting.isSinglePeer() ? await this.submitAsyncSinglePeer(normalizedArgs) : await this.submitAsyncInternal(
          await this.createPreparedTransaction(),
          normalizedArgs
        );
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
      const result = this.targeting.isSinglePeer() ? await this.evaluateSinglePeer(normalizedArgs) : await (await this.createPreparedTransaction()).evaluate(...normalizedArgs);
      return Result6.ok(Buffer.from(result));
    } catch (error) {
      if (error instanceof SinglePeerExecutionError || error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof TimeoutError) {
        return Result6.err(error);
      }
      return Result6.err(
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
        return Result6.err(
          new ConfigurationError({
            field: "proposalCreator",
            message: "proposalCreator is required to build an unsigned proposal for offline signing"
          })
        );
      }
      if (this.targeting.isSinglePeer()) {
        const selected = (await this.resolveSinglePeerEndorsers())[0];
        if (!selected) {
          throw new PeerNotFoundError({
            peerName: "<single-peer>",
            availablePeers: []
          });
        }
        const transaction2 = await this.createPreparedTransactionForPeers([
          selected.endorser
        ]);
        return Result6.ok(
          this.buildUnsignedProposal(transaction2, normalizedArgs, {
            mode: "single-peer",
            peers: [selected.peerName]
          })
        );
      }
      const endorsingPeerNames = this.targeting.endorsingPeerNames();
      const transaction = await this.createPreparedTransaction();
      const peers = endorsingPeerNames.length > 0 ? await this.resolvedEndorsingPeerSnapshot(endorsingPeerNames) : [];
      const routing = peers.length > 0 ? { mode: "endorsing-peers", peers } : { mode: "gateway-default" };
      return Result6.ok(
        this.buildUnsignedProposal(transaction, normalizedArgs, routing)
      );
    } catch (error) {
      return Result6.err(this.mapSubmitError(error));
    }
  }
  buildUnsignedProposal(transaction, stringArgs, routing) {
    const tx = transaction;
    const network = tx.contract.network;
    const channel = network.getChannel();
    const endorsement = channel.newEndorsement(this.chaincodeName);
    const proposalBuildRequest = tx.newBuildProposalRequest(stringArgs);
    const identityContext = createProposalIdentityContext(
      tx.identityContext,
      this.proposalCreator
    );
    const bytes = Buffer.from(
      endorsement.build(identityContext, proposalBuildRequest)
    );
    return new PeerUnsignedProposal(
      bytes,
      digestBytes(bytes),
      endorsement.getTransactionId(),
      routing
    );
  }
  async createPreparedTransaction() {
    const transaction = this.contract.createTransaction(this.name);
    if (Object.keys(this.transientData).length > 0) {
      transaction.setTransient(copyTransientData2(this.transientData));
    }
    const endorsingPeerNames = this.targeting.endorsingPeerNames();
    if (endorsingPeerNames.length > 0) {
      const discoveryResult = await this.ensureDiscovery();
      if (!discoveryResult.isOk()) {
        throw discoveryResult.error;
      }
      const endorsingPeers = this.matchPeersToEndorsers(
        discoveryResult.value,
        endorsingPeerNames
      );
      if (!endorsingPeers.isOk()) {
        throw endorsingPeers.error;
      }
      if (endorsingPeers.value.length > 0) {
        transaction.setEndorsingPeers(endorsingPeers.value);
      }
    }
    return transaction;
  }
  async createPreparedTransactionForPeers(peers) {
    const transaction = this.contract.createTransaction(this.name);
    if (Object.keys(this.transientData).length > 0) {
      transaction.setTransient(copyTransientData2(this.transientData));
    }
    if (peers.length > 0) {
      transaction.setEndorsingPeers(peers);
    }
    return transaction;
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
    return peerInfos.value.map((peer2) => peer2.endpoint);
  }
  async resolveSinglePeerEndorsers() {
    const discoveryResult = await this.ensureDiscovery();
    if (!discoveryResult.isOk()) {
      throw discoveryResult.error;
    }
    const selection = selectSinglePeers(
      discoveryResult.value,
      this.peerConnection,
      this.discoveryCache,
      this.targeting.singlePeerOptions() ?? void 0
    );
    const endorsers = this.matchPeerInfosToEndorsers(
      discoveryResult.value,
      selection.orderedPeers
    );
    if (!endorsers.isOk()) {
      throw endorsers.error;
    }
    return endorsers.value;
  }
  async submitAsyncSinglePeer(stringArgs) {
    return this.executeSinglePeer("submitAsync", async (selected) => {
      const transaction = await this.createPreparedTransactionForPeers([
        selected.endorser
      ]);
      return this.submitAsyncInternal(transaction, stringArgs);
    });
  }
  async evaluateSinglePeer(stringArgs) {
    return this.executeSinglePeer("evaluate", async (selected) => {
      const transaction = await this.createPreparedTransactionForPeers([
        selected.endorser
      ]);
      return Buffer.from(
        await transaction.evaluate(...stringArgs)
      );
    });
  }
  async executeSinglePeer(operation, execute) {
    const peers = await this.resolveSinglePeerEndorsers();
    const attempts = [];
    const failover = this.targeting.singlePeerOptions()?.failover ?? true;
    const peersToTry = failover ? peers : peers.slice(0, 1);
    for (let index = 0; index < peersToTry.length; index += 1) {
      const selected = peersToTry[index];
      try {
        return await execute(selected);
      } catch (error) {
        const decision = classifyFailover(error);
        attempts.push({
          peer: selected.peerName,
          cause: error instanceof Error ? error.message : String(error),
          failover: decision
        });
        if (!decision.eligible) {
          throw error;
        }
        if (!failover || index === peersToTry.length - 1) {
          throw this.singlePeerExecutionError(operation, peers, attempts);
        }
        const next = peersToTry[index + 1];
        log().warn("fabric_bridge.single_peer.failover", {
          event: "fabric_bridge.single_peer.failover",
          operation,
          channel: this.channelName,
          chaincode: this.chaincodeName,
          transaction: this.name,
          failedPeer: selected.peerName,
          nextPeer: next.peerName,
          attempt: index + 1,
          maxAttempts: peersToTry.length,
          reason: decision.reason,
          category: decision.category
        });
      }
    }
    throw this.singlePeerExecutionError(operation, peers, attempts);
  }
  async submitAsyncInternal(transaction, stringArgs) {
    const tx = transaction;
    const network = tx.contract.network;
    const channel = network.getChannel();
    const transactionOptions = tx.gatewayOptions.eventHandlerOptions ?? {};
    const endorsement = channel.newEndorsement(this.chaincodeName);
    const proposalBuildRequest = tx.newBuildProposalRequest(stringArgs);
    endorsement.build(tx.identityContext, proposalBuildRequest);
    endorsement.sign(tx.identityContext);
    const proposalSendRequest = {};
    if (Number.isInteger(transactionOptions.endorseTimeout)) {
      proposalSendRequest.requestTimeout = transactionOptions.endorseTimeout * 1e3;
    }
    if (tx.endorsingPeers) {
      proposalSendRequest.targets = tx.endorsingPeers;
    } else if (tx.contract.network.discoveryService) {
      proposalSendRequest.handler = await tx.contract.getDiscoveryHandler();
      if (tx.endorsingOrgs) {
        proposalSendRequest.requiredOrgs = tx.endorsingOrgs;
      }
    } else if (tx.endorsingOrgs) {
      const targets = tx.endorsingOrgs.map((mspid) => channel.getEndorsers(mspid)).flat();
      proposalSendRequest.targets = targets;
    } else {
      proposalSendRequest.targets = channel.getEndorsers();
    }
    const proposalResponse = await endorsement.send(proposalSendRequest);
    const result = this.getResponsePayload(proposalResponse);
    const transactionId = endorsement.getTransactionId();
    const peers = tx.endorsingPeers ?? channel.getEndorsers();
    const commitWaiter = await this.createCommitWaiter(
      network,
      peers,
      transactionId
    );
    try {
      const commit = endorsement.newCommit();
      commit.build(tx.identityContext);
      commit.sign(tx.identityContext);
      const commitSendRequest = {};
      if (Number.isInteger(transactionOptions.commitTimeout)) {
        commitSendRequest.requestTimeout = transactionOptions.commitTimeout * 1e3;
      }
      if (proposalSendRequest.handler) {
        commitSendRequest.handler = proposalSendRequest.handler;
      } else {
        commitSendRequest.targets = channel.getCommitters();
      }
      const commitResponse = await commit.send(commitSendRequest);
      if (commitResponse.status !== "SUCCESS") {
        const message = `Failed to commit transaction ${transactionId}, orderer response status: ${commitResponse.status}`;
        commitWaiter.fail(
          new SubmitError({
            message,
            transactionId
          })
        );
        throw new SubmitError({
          message,
          transactionId
        });
      }
    } catch (error) {
      commitWaiter.fail(error);
      throw error;
    }
    return {
      result,
      transactionId,
      waitForCommit: commitWaiter.waitForCommit
    };
  }
  async createCommitWaiter(network, peers, transactionId) {
    let settled = false;
    let timeoutHandle;
    let resolvePromise;
    let rejectPromise;
    const cleanup = (listener2) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      try {
        network.removeCommitListener(listener2);
      } catch {
      }
    };
    const commitPromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const listener = (error, event) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(listener);
      if (error) {
        rejectPromise?.(
          new CommitError({
            message: error.message,
            transactionId
          })
        );
        return;
      }
      if (!event) {
        rejectPromise?.(
          new CommitError({
            message: "Missing commit event",
            transactionId
          })
        );
        return;
      }
      const blockEvent = event.getBlockEvent();
      const status = {
        blockNumber: BigInt(blockEvent.blockNumber.toString()),
        status: event.isValid ? "VALID" : "INVALID",
        transactionId
      };
      if (!event.isValid) {
        rejectPromise?.(
          new CommitError({
            message: "transaction committed with invalid validation code",
            transactionId,
            status: "INVALID"
          })
        );
        return;
      }
      resolvePromise?.(status);
    };
    await network.addCommitListener(listener, peers, transactionId);
    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(listener);
      rejectPromise?.(
        new TimeoutError({
          message: `Commit event listener timeout for transaction ${transactionId}`,
          operation: "commit",
          timeout: this.timeouts.commit
        })
      );
    }, this.timeouts.commit);
    return {
      waitForCommit: async () => Result6.tryPromise({
        try: async () => commitPromise,
        catch: (error) => this.mapCommitError(error, transactionId)
      }),
      fail: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(listener);
        rejectPromise?.(error);
      }
    };
  }
  async ensureDiscovery() {
    const discovery = this.discoveryCache.get(this.channelName);
    if (discovery) {
      return Result6.ok(discovery);
    }
    const result = await this.peerConnection.discover(this.channelName);
    if (!result.isOk()) {
      return Result6.err(result.error);
    }
    return Result6.ok(result.value);
  }
  matchPeersToEndorsers(discovery, peerNames) {
    const endorsers = [];
    const availablePeers = Array.from(discovery.peers.keys());
    const network = this.contract.network;
    const channel = network?.getChannel?.() || network?.channel;
    if (!channel) {
      return Result6.err(
        new PeerNotFoundError({
          peerName: peerNames.join(", "),
          availablePeers
        })
      );
    }
    const peerInfos = this.resolvePeerInfos(discovery, peerNames);
    if (!peerInfos.isOk()) {
      return Result6.err(peerInfos.error);
    }
    const notFound = [];
    for (const peerInfo of peerInfos.value) {
      const endorser = channel.getEndorser?.(peerInfo.endpoint);
      if (endorser) {
        endorsers.push(endorser);
        continue;
      }
      const allEndorsers = channel.getEndorsers?.() || [];
      const matched = allEndorsers.find(
        (candidate) => candidate.name === peerInfo.endpoint
      );
      if (matched) {
        endorsers.push(matched);
      } else {
        notFound.push(peerInfo.endpoint);
      }
    }
    if (notFound.length > 0) {
      return Result6.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers
        })
      );
    }
    return Result6.ok(endorsers);
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
      return Result6.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers: Array.from(discovery.peers.keys())
        })
      );
    }
    return Result6.ok(peerInfos);
  }
  matchPeerInfosToEndorsers(discovery, peers) {
    const endorsers = [];
    const notFound = [];
    const availablePeers = Array.from(discovery.peers.keys());
    const network = this.contract.network;
    const channel = network?.getChannel?.() || network?.channel;
    if (!channel) {
      return Result6.err(
        new PeerNotFoundError({
          peerName: peers.map((peer2) => peer2.name).join(", "),
          availablePeers
        })
      );
    }
    const allEndorsers = channel.getEndorsers?.() || [];
    for (const peer2 of peers) {
      const endpointWithoutScheme = stripGrpcScheme(peer2.endpoint);
      const endorser = channel.getEndorser?.(peer2.endpoint) ?? channel.getEndorser?.(endpointWithoutScheme) ?? allEndorsers.find(
        (candidate) => candidate.name === peer2.endpoint || candidate.name === endpointWithoutScheme || candidate.endpoint === peer2.endpoint || candidate.endpoint === endpointWithoutScheme
      );
      if (endorser) {
        endorsers.push({ peerName: peer2.endpoint, endorser });
      } else {
        notFound.push(peer2.endpoint);
      }
    }
    if (notFound.length > 0) {
      return Result6.err(
        new PeerNotFoundError({
          peerName: notFound.join(", "),
          availablePeers
        })
      );
    }
    return Result6.ok(endorsers);
  }
  singlePeerExecutionError(operation, eligiblePeers, attempts) {
    return new SinglePeerExecutionError({
      message: `single-peer transaction failed after trying ${attempts.length} eligible peer(s)`,
      operation,
      channel: this.channelName,
      chaincode: this.chaincodeName,
      transaction: this.name,
      candidates: this.targeting.singlePeerOptions()?.candidates,
      eligiblePeers: eligiblePeers.map((peer2) => peer2.peerName),
      attempts
    });
  }
  getResponsePayload(proposalResponse) {
    const validEndorsementResponse = proposalResponse.responses.find(
      (endorsementResponse) => endorsementResponse.endorsement
    );
    if (!validEndorsementResponse) {
      const errorInfos = [];
      for (const error of proposalResponse.errors ?? []) {
        errorInfos.push(
          `peer=${error?.connection?.name ?? "unknown"}, status=grpc, message=${error?.message ?? "unknown error"}`
        );
      }
      for (const response of proposalResponse.responses ?? []) {
        errorInfos.push(
          `peer=${response?.connection?.name ?? "unknown"}, status=${response?.response?.status ?? "unknown"}, message=${response?.response?.message ?? "unknown error"}`
        );
      }
      throw new EndorsementError({
        message: errorInfos.length > 0 ? `No valid responses from any peers. Errors:
    ${errorInfos.join("\n    ")}` : "No valid responses from any peers"
      });
    }
    const payload = getTransactionResponse(validEndorsementResponse).payload;
    return asBuffer(payload);
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
  mapCommitError(error, transactionId) {
    if (error instanceof CommitError || error instanceof TimeoutError) {
      return error;
    }
    if (error.message?.includes("timeout") || error.message?.includes("Timeout") || error.message?.includes("TIMEOUT")) {
      return new TimeoutError({
        message: error.message,
        operation: "commit",
        timeout: this.timeouts.commit
      });
    }
    return new CommitError({
      message: error.message,
      transactionId
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
  network;
  channelName;
  config;
  timeouts;
  bytes;
  signature;
  routing;
  transactionId;
  chaincodeName;
  proposal;
  header;
  constructor(network, channelName, config, bytes, signature, routing) {
    this.network = network;
    this.channelName = channelName;
    this.config = config;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.bytes = Buffer.from(bytes);
    this.signature = Buffer.from(signature);
    this.routing = {
      mode: routing.mode,
      peers: uniqueCanonicalPeerEndpoints(
        routing.peers,
        !!config.tlsOptions?.trustedRoots
      )
    };
    this.proposal = fabproto62.protos.Proposal.decode(this.bytes);
    this.header = fabproto62.common.Header.decode(this.proposal.header);
    const channelHeader = fabproto62.common.ChannelHeader.decode(
      this.header.channel_header
    );
    const extension = fabproto62.protos.ChaincodeHeaderExtension.decode(
      channelHeader.extension
    );
    this.transactionId = channelHeader.tx_id;
    this.chaincodeName = extension.chaincode_id?.name ?? "";
  }
  TransactionID() {
    return this.transactionId;
  }
  async Endorse() {
    try {
      const proposalResponse = await this.sendProposal();
      const payload = getPeerProposalPayload(proposalResponse);
      const txPayload = this.buildTransactionPayload(
        proposalResponse.responses
      );
      return Result6.ok(
        new PeerEndorsedTransaction(
          this.network,
          this.config,
          this.timeouts,
          txPayload,
          payload,
          this.transactionId
        )
      );
    } catch (error) {
      if (error instanceof EndorsementError || error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof ConfigurationError) {
        return Result6.err(error);
      }
      return Result6.err(
        new EndorsementError({
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  async Evaluate() {
    try {
      const proposalResponse = await this.sendProposal();
      return Result6.ok(getPeerProposalPayload(proposalResponse));
    } catch (error) {
      if (error instanceof PeerNotFoundError || error instanceof DiscoveryError || error instanceof ConfigurationError) {
        return Result6.err(error);
      }
      return Result6.err(
        new EvaluationError({
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  async sendProposal() {
    const channel = this.network.getChannel();
    const endorsement = channel.newEndorsement(this.chaincodeName);
    endorsement._reset();
    endorsement._payload = this.bytes;
    endorsement._signature = this.signature;
    endorsement._action.proposal = this.proposal;
    endorsement._action.header = this.header;
    endorsement._action.transactionId = this.transactionId;
    const targets = await this.resolveEndorsers(channel);
    const proposalResponse = await endorsement.send({ targets });
    endorsement._proposalResponses = proposalResponse.responses;
    endorsement._proposalErrors = proposalResponse.errors;
    return proposalResponse;
  }
  async resolveEndorsers(channel) {
    const discovery = await discoveredPeerEndpoints(
      this.network,
      this.channelName,
      !!this.config.tlsOptions?.trustedRoots
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
    const allEndorsers = channel.getEndorsers?.() ?? [];
    const targets = this.routing.peers.map((endpoint) => {
      const endorserName = stripGrpcScheme(endpoint);
      return channel.getEndorser?.(endpoint) ?? channel.getEndorser?.(endorserName) ?? allEndorsers.find(
        (candidate) => candidate.name === endpoint || candidate.name === endorserName
      );
    }).filter(Boolean);
    if (targets.length !== this.routing.peers.length) {
      throw new PeerNotFoundError({
        peerName: this.routing.peers.join(", "),
        availablePeers: allEndorsers.map(
          (endorser) => endorser.name ?? "<unknown>"
        )
      });
    }
    return targets;
  }
  buildTransactionPayload(proposalResponses) {
    const validResponses = proposalResponses.filter(
      (response) => response?.endorsement
    );
    if (validResponses.length === 0) {
      throw new EndorsementError({ message: "No valid endorsements found" });
    }
    const endorsements = validResponses.map((response) => response.endorsement);
    const proposalResponse = validResponses[0];
    const chaincodeEndorsedAction = fabproto62.protos.ChaincodeEndorsedAction.create({
      proposal_response_payload: proposalResponse.payload,
      endorsements
    });
    const originalProposalPayload = fabproto62.protos.ChaincodeProposalPayload.decode(this.proposal.payload);
    const proposalPayloadNoTransient = fabproto62.protos.ChaincodeProposalPayload.create({
      input: originalProposalPayload.input
    });
    const proposalPayloadNoTransientBytes = fabproto62.protos.ChaincodeProposalPayload.encode(
      proposalPayloadNoTransient
    ).finish();
    const actionPayload = fabproto62.protos.ChaincodeActionPayload.create({
      action: chaincodeEndorsedAction,
      chaincode_proposal_payload: proposalPayloadNoTransientBytes
    });
    const actionPayloadBytes = fabproto62.protos.ChaincodeActionPayload.encode(actionPayload).finish();
    const transactionAction = fabproto62.protos.TransactionAction.create({
      header: this.header.signature_header,
      payload: actionPayloadBytes
    });
    const transaction = fabproto62.protos.Transaction.create({
      actions: [transactionAction]
    });
    const transactionBytes = fabproto62.protos.Transaction.encode(transaction).finish();
    const payload = fabproto62.common.Payload.create({
      header: this.header,
      data: transactionBytes
    });
    return Buffer.from(fabproto62.common.Payload.encode(payload).finish());
  }
};
var PeerEndorsedTransaction = class {
  network;
  config;
  timeouts;
  bytes;
  result;
  transactionId;
  constructor(network, config, timeouts, bytes, result, transactionId) {
    this.network = network;
    this.config = config;
    this.timeouts = timeouts;
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
  SigningRequest() {
    return signingRequest(this.bytes, this.Digest());
  }
  WithSignature(signature) {
    return signedMessage(this.SigningRequest(), signature);
  }
  async SubmitAsync() {
    return this.submitAsyncWithSignature(await this.config.signer(digestBytes(this.bytes)));
  }
  async submitAsyncWithSignature(signature) {
    try {
      const channel = this.network.getChannel();
      const peers = channel.getEndorsers?.() ?? [];
      const commitWaiter = await createPeerCommitWaiter(
        this.network,
        peers,
        this.transactionId,
        this.timeouts.commit
      );
      const commit = channel.newCommit("_offline");
      commit._reset();
      commit._payload = this.bytes;
      commit._signature = Buffer.from(signature);
      const response = await commit.send({ targets: channel.getCommitters() });
      if (response.status !== "SUCCESS") {
        throw new SubmitError({
          message: `Failed to commit transaction ${this.transactionId}, orderer response status: ${response.status}`,
          transactionId: this.transactionId
        });
      }
      return Result6.ok(
        new PeerSubmittedTx(
          this.result,
          this.transactionId,
          commitWaiter.waitForCommit
        )
      );
    } catch (error) {
      return Result6.err(
        error instanceof SubmitError ? error : new SubmitError({
          message: error instanceof Error ? error.message : String(error),
          transactionId: this.transactionId
        })
      );
    }
  }
  async Submit() {
    const submitted = await this.SubmitAsync();
    if (!submitted.isOk()) return Result6.err(submitted.error);
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) return Result6.err(status.error);
    return Result6.ok(new PeerCommitResult(submitted.value, status.value));
  }
  async SubmitWithSignature(signature) {
    const signed = this.WithSignature(signature);
    if (!signed.isOk()) return Result6.err(signed.error);
    const decoded = decodeSignedMessage(signed.value);
    if (!decoded.isOk()) return Result6.err(decoded.error);
    if (!decoded.value.digest.equals(this.Digest())) {
      return Result6.err(
        new OfflineSigningError({
          field: "digest",
          message: "digest does not match transaction bytes"
        })
      );
    }
    const submitted = await this.submitAsyncWithSignature(decoded.value.signature);
    if (!submitted.isOk()) return Result6.err(submitted.error);
    const status = await submitted.value.WaitForCommit();
    if (!status.isOk()) return Result6.err(status.error);
    return Result6.ok(new PeerCommitResult(submitted.value, status.value));
  }
};
function decodePeerSignedMessage(message) {
  const decoded = decodeSignedMessage(message);
  if (!decoded.isOk()) return Result6.err(decoded.error);
  const actualDigest = digestBytes(decoded.value.bytes);
  if (!actualDigest.equals(decoded.value.digest)) {
    return Result6.err(
      new OfflineSigningError({
        field: "digest",
        message: "digest does not match proposal bytes"
      })
    );
  }
  return Result6.ok(decoded.value);
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
  return asBuffer(getTransactionResponse(valid).payload);
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
      `peer=${response?.connection?.name ?? "unknown"}, status=${response?.response?.status ?? "unknown"}, message=${response?.response?.message ?? "unknown error"}`
    );
  }
  return errorInfos.length > 0 ? `No valid responses from any peers. Errors:
    ${errorInfos.join("\n    ")}` : "No valid responses from any peers";
}
async function createPeerCommitWaiter(network, peers, transactionId, timeout) {
  let settled = false;
  let timeoutHandle;
  let resolvePromise;
  let rejectPromise;
  const commitPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = (listener2) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      network.removeCommitListener(listener2);
    } catch {
    }
  };
  const listener = (error, event) => {
    if (settled) return;
    settled = true;
    cleanup(listener);
    if (error) {
      rejectPromise?.(
        new CommitError({ message: error.message, transactionId })
      );
      return;
    }
    if (!event) {
      rejectPromise?.(
        new CommitError({ message: "Missing commit event", transactionId })
      );
      return;
    }
    const blockEvent = event.getBlockEvent();
    const status = {
      blockNumber: BigInt(blockEvent.blockNumber.toString()),
      status: event.isValid ? "VALID" : "INVALID",
      transactionId
    };
    if (!event.isValid) {
      rejectPromise?.(
        new CommitError({
          message: "transaction committed with invalid validation code",
          transactionId,
          status: "INVALID"
        })
      );
      return;
    }
    resolvePromise?.(status);
  };
  await network.addCommitListener(listener, peers, transactionId);
  timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup(listener);
    rejectPromise?.(
      new TimeoutError({
        message: `Commit event listener timeout for transaction ${transactionId}`,
        operation: "commit",
        timeout
      })
    );
  }, timeout);
  return {
    waitForCommit: async () => Result6.tryPromise({
      try: async () => commitPromise,
      catch: (error) => error
    })
  };
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
    (peer2) => normalizePeerEndpointIdentity(peer2, tlsEnabled)
  );
}
function normalizeSnapshotPeerEndpoints(peers, tlsEnabled) {
  try {
    return Result6.ok(uniqueCanonicalPeerEndpoints(peers, tlsEnabled));
  } catch (error) {
    return Result6.err(
      new OfflineSigningError({
        field: "routing.peers",
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
}
async function discoveredPeerEndpoints(network, channelName, tlsEnabled) {
  const service = network.discoveryService;
  if (service?.getDiscoveryResults) {
    await service.getDiscoveryResults(true);
  }
  const results = service?.discoveryResults ?? {};
  const out = /* @__PURE__ */ new Set();
  for (const orgInfo of Object.values(results.peers_by_org ?? {})) {
    for (const peer2 of orgInfo.peers ?? []) {
      if (!peer2.endpoint) {
        continue;
      }
      const endpoint = normalizePeerEndpointIdentity(peer2.endpoint, tlsEnabled);
      if (out.has(endpoint)) {
        throw new DiscoveryError({
          message: `Discovery returned duplicate peer endpoint identity for channel ${channelName}: ${endpoint}`
        });
      }
      out.add(endpoint);
    }
  }
  return out;
}
function uniquePeerEndpoints(peers, normalize) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const peer2 of peers) {
    const canonical = normalize(peer2);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}
function stripGrpcScheme(endpoint) {
  const lower = endpoint.toLowerCase();
  if (lower.startsWith("grpc://") || lower.startsWith("grpcs://")) {
    return endpoint.slice(endpoint.indexOf("://") + 3);
  }
  return endpoint;
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
import { Result as Result7 } from "better-result";
function applyDefaultTimeouts(config) {
  if (!config.timeouts) {
    return { ...config, timeouts: { ...DEFAULT_TIMEOUTS } };
  }
  return {
    ...config,
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
    this.config = applyDefaultTimeouts(config);
    this.discoveryCache = new DiscoveryCache();
    log().debug("FabricBridge creado", {
      gatewayPeer: config.gatewayPeer,
      mspId: config.identity.mspId,
      hasTlsOptions: !!config.tlsOptions,
      hasTrustedRoots: !!config.tlsOptions?.trustedRoots,
      hasClientCert: !!config.tlsOptions?.clientCert,
      hasClientKey: !!config.tlsOptions?.clientKey,
      discovery: config.discovery
    });
  }
  async connect() {
    log().info("FabricBridge.connect() - Iniciando conexi\xF3n en modo GATEWAY");
    this.gatewayConnection = new GatewayConnection(this.config);
    log().debug("FabricBridge.connect() - Llamando a GatewayConnection.connect()");
    const gatewayResult = await this.gatewayConnection.connect();
    if (!gatewayResult.isOk()) {
      log().error("FabricBridge.connect() - Error en GatewayConnection.connect():", gatewayResult.error);
      return Result7.err(gatewayResult.error);
    }
    this.isConnected = true;
    log().info("FabricBridge.connect() - Conexi\xF3n GATEWAY exitosa");
    return Result7.ok(void 0);
  }
  async disconnect() {
    log().info("FabricBridge.disconnect() - Desconectando");
    await this.gatewayConnection?.disconnect();
    this.discoveryCache.clear();
    this.isConnected = false;
  }
  async WaitForCommit(channelName, transactionId) {
    if (!this.gatewayConnection) {
      return Result7.err(new NotConnectedError({
        component: "FabricBridge",
        action: "wait for commit"
      }));
    }
    return this.gatewayConnection.getCommitStatus(channelName, transactionId);
  }
  async getNetwork(channelName) {
    if (!this.isConnected || !this.config || !this.gatewayConnection) {
      log().error("FabricBridge.getNetwork() - No conectado");
      return Result7.err(new NotConnectedError({
        component: "FabricBridge",
        action: "connect"
      }));
    }
    log().debug("FabricBridge.getNetwork() - Creando BridgeNetwork para canal:", channelName);
    return Result7.ok(new BridgeNetworkImpl(
      channelName,
      this.config,
      this.gatewayConnection,
      this.discoveryCache
    ));
  }
  async NewSignedProposal(message) {
    if (message.routing?.mode === "single-peer" || message.routing?.mode === "endorsing-peers") {
      const peerConnection = new PeerConnection(this.config, this.discoveryCache);
      const connectResult = await peerConnection.connect();
      if (!connectResult.isOk()) {
        return Result7.err(connectResult.error);
      }
      return NewPeerSignedProposal(peerConnection.getGateway(), this.config, message);
    }
    if (!this.gatewayConnection) {
      return Result7.err(new NotConnectedError({
        component: "FabricBridge",
        action: "resume signed proposal"
      }));
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
  UseSinglePeer(options = {}) {
    const targeting = TransactionTargeting.singlePeer(options);
    if (!targeting.isOk()) {
      return Result7.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result7.ok(this);
  }
  UseEndorsingPeers(peerNames) {
    const targeting = TransactionTargeting.endorsingPeers(peerNames);
    if (!targeting.isOk()) {
      return Result7.err(targeting.error);
    }
    this.targeting = targeting.value;
    return Result7.ok(this);
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
      return Result7.err(submitted.error);
    }
    const commitStatus = await submitted.value.WaitForCommit();
    if (!commitStatus.isOk()) {
      return Result7.err(commitStatus.error);
    }
    return Result7.ok(new BridgeCommitResultImpl(submitted.value, commitStatus.value));
  }
  async SubmitAsync(...args) {
    if (this.targeting.requiresPeerMode()) {
      let connection;
      try {
        const prepared = await this.createPeerTargetedTransaction("peer-targeted transactions");
        connection = prepared.connection;
        const peerConnection = prepared.connection;
        const transaction = prepared.transaction;
        const submittedResult = await transaction.SubmitAsync(...args);
        if (!submittedResult.isOk()) {
          await peerConnection.disconnect();
          return Result7.err(submittedResult.error);
        }
        const commitPromise = submittedResult.value.WaitForCommit().finally(async () => {
          await peerConnection.disconnect();
        });
        void commitPromise.catch(() => void 0);
        return Result7.ok(new DeferredSubmittedTransaction(
          submittedResult.value.Result(),
          submittedResult.value.TransactionID(),
          () => commitPromise
        ));
      } catch (error) {
        await connection?.disconnect();
        if (error instanceof ConfigurationError || error instanceof TimeoutError) {
          return Result7.err(error);
        }
        return Result7.err(new SubmitError({
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return (await this.createGatewayTransaction()).SubmitAsync(...args);
  }
  async Evaluate(...args) {
    if (this.targeting.requiresPeerMode()) {
      let connection;
      try {
        const prepared = await this.createPeerTargetedTransaction("peer-targeted transactions");
        connection = prepared.connection;
        return await prepared.transaction.Evaluate(...args);
      } finally {
        await connection?.disconnect();
      }
    }
    return (await this.createGatewayTransaction()).Evaluate(...args);
  }
  async NewUnsignedProposal(...args) {
    if (!this.proposalCreator) {
      return Result7.err(new ConfigurationError({
        field: "proposalCreator",
        message: "proposalCreator is required to build an unsigned proposal for offline signing"
      }));
    }
    if (this.targeting.requiresPeerMode()) {
      let connection;
      try {
        const prepared = await this.createPeerTargetedTransaction("build peer-targeted proposals");
        connection = prepared.connection;
        return await prepared.transaction.NewUnsignedProposal(...args);
      } finally {
        await connection?.disconnect();
      }
    }
    return (await this.createGatewayTransaction()).NewUnsignedProposal(...args);
  }
  async createGatewayTransaction() {
    const gatewayContract = await this.gatewayNetwork.getContract(this.chaincodeName);
    return this.prepareTransaction(gatewayContract.Transaction(this.name));
  }
  async createPeerTargetedTransaction(reason) {
    const connection = new PeerConnection(this.config, this.discoveryCache);
    const connectResult = await connection.connect();
    if (!connectResult.isOk()) {
      throw connectResult.error;
    }
    try {
      log().debug("BridgeTransactionImpl - using dedicated peer connection for:", this.chaincodeName);
      const peerNetwork = new PeerNetwork(
        connection.getGateway(),
        this.channelName,
        this.config,
        connection,
        this.discoveryCache
      );
      const peerContract = await peerNetwork.getContract(this.chaincodeName);
      const targetedTx = this.targeting.applyToPeerTransaction(
        this.prepareTransaction(peerContract.Transaction(this.name))
      );
      if (!targetedTx.isOk()) {
        throw targetedTx.error;
      }
      return { connection, transaction: targetedTx.value };
    } catch (error) {
      await connection.disconnect();
      throw error;
    }
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
import { sign as nodeSign } from "crypto";
import { p256, p384 } from "@noble/curves/nist";
var namedCurves = {
  "P-256": p256,
  "P-384": p384
};
function createSyncPrivateKeySigner(key) {
  if (key.type !== "private") {
    throw new Error(`Invalid key type: ${key.type}`);
  }
  switch (key.asymmetricKeyType) {
    case "ec":
      return createSyncECPrivateKeySigner(key);
    case "ed25519":
      return (message) => nodeSign(null, message, key);
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
export {
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
};
//# sourceMappingURL=index.js.map