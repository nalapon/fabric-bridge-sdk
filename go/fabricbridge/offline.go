package fabricbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	legacyfab "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"google.golang.org/protobuf/proto"
)

// OfflineSigningRouting captures endorsement routing needed to resume a signed proposal.
type OfflineSigningRouting struct {
	Mode  string   `json:"mode"`
	Peers []string `json:"peers,omitempty"`
}

// SigningRequest is the portable JSON DTO sent to an external signer.
type SigningRequest struct {
	Bytes   string                 `json:"bytes"`
	Digest  string                 `json:"digest"`
	Routing *OfflineSigningRouting `json:"routing,omitempty"`
}

// SignedMessage is a SigningRequest plus an external signature.
type SignedMessage struct {
	Bytes     string                 `json:"bytes"`
	Digest    string                 `json:"digest"`
	Signature string                 `json:"signature"`
	Routing   *OfflineSigningRouting `json:"routing,omitempty"`
}

// UnsignedProposal is a proposal that can be signed externally.
type UnsignedProposal struct {
	bytes         []byte
	digest        []byte
	transactionID string
	routing       *OfflineSigningRouting
}

func newUnsignedProposal(bytes []byte, digest []byte, transactionID string, routing *OfflineSigningRouting) *UnsignedProposal {
	return &UnsignedProposal{
		bytes:         append([]byte(nil), bytes...),
		digest:        append([]byte(nil), digest...),
		transactionID: transactionID,
		routing:       cloneRouting(routing),
	}
}

// Bytes returns canonical Fabric bytes for this proposal.
func (p *UnsignedProposal) Bytes() []byte {
	return append([]byte(nil), p.bytes...)
}

// Digest returns the digest external signers should sign.
func (p *UnsignedProposal) Digest() []byte {
	return append([]byte(nil), p.digest...)
}

// TransactionID returns the Fabric transaction ID.
func (p *UnsignedProposal) TransactionID() string {
	return p.transactionID
}

// CreatorIdentity returns the serialized Fabric identity embedded in this proposal.
func (p *UnsignedProposal) CreatorIdentity() ([]byte, error) {
	return proposalCreatorIdentity(p.bytes)
}

// CreatorMSPID returns the MSP ID embedded in this proposal's creator identity.
func (p *UnsignedProposal) CreatorMSPID() (string, error) {
	creator, err := p.CreatorIdentity()
	if err != nil {
		return "", err
	}
	identity := &msp.SerializedIdentity{}
	if err := proto.Unmarshal(creator, identity); err != nil {
		return "", &OfflineSigningError{Field: "creator", Message: fmt.Sprintf("unmarshal creator identity: %v", err)}
	}
	return identity.GetMspid(), nil
}

// CreatorCertificate returns the certificate bytes embedded in this proposal's creator identity.
func (p *UnsignedProposal) CreatorCertificate() ([]byte, error) {
	creator, err := p.CreatorIdentity()
	if err != nil {
		return nil, err
	}
	identity := &msp.SerializedIdentity{}
	if err := proto.Unmarshal(creator, identity); err != nil {
		return nil, &OfflineSigningError{Field: "creator", Message: fmt.Sprintf("unmarshal creator identity: %v", err)}
	}
	return append([]byte(nil), identity.GetIdBytes()...), nil
}

// SigningRequest returns the portable signing DTO.
func (p *UnsignedProposal) SigningRequest() SigningRequest {
	return signingRequest(p.bytes, p.digest, p.routing)
}

// WithSignature returns a signed-message DTO using the supplied external signature.
func (p *UnsignedProposal) WithSignature(signature []byte) SignedMessage {
	req := p.SigningRequest()
	return SignedMessage{
		Bytes:     req.Bytes,
		Digest:    req.Digest,
		Signature: base64.StdEncoding.EncodeToString(signature),
		Routing:   cloneRouting(req.Routing),
	}
}

// SignedProposal is a signed proposal that can be endorsed or evaluated.
type SignedProposal struct {
	proposal      *fabricGateway.Proposal
	bridge        *Bridge
	proposalBytes []byte
	signature     []byte
	routing       *OfflineSigningRouting
	transactionID string
	channelName   string
	chaincodeName string
}

// TransactionID returns the Fabric transaction ID.
func (p *SignedProposal) TransactionID() string {
	if p.proposal == nil {
		return p.transactionID
	}
	return p.proposal.TransactionID()
}

// Endorse obtains endorsement and returns an endorsed transaction ready for SDK-managed submit.
func (p *SignedProposal) Endorse(ctx context.Context) (*EndorsedTransaction, error) {
	if p.proposal == nil {
		return p.endorsePeer(ctx)
	}
	tx, err := p.proposal.EndorseWithContext(ctx)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	return &EndorsedTransaction{transaction: tx}, nil
}

// Evaluate evaluates the signed proposal as a query.
func (p *SignedProposal) Evaluate(ctx context.Context) ([]byte, error) {
	if p.proposal == nil {
		responses, _, err := p.sendPeerProposal(ctx)
		if err != nil {
			return nil, &EvaluationError{Message: err.Error()}
		}
		return proposalResultPayload(responses)
	}
	result, err := p.proposal.EvaluateWithContext(ctx)
	if err != nil {
		return nil, &EvaluationError{Message: err.Error()}
	}
	return result, nil
}

// EndorsedTransaction is an endorsed transaction ready for SDK-managed transaction signing and submit.
type EndorsedTransaction struct {
	transaction *fabricGateway.Transaction
	bytes       []byte
	result      []byte
	txID        string
	bridge      *Bridge
	channelName string
}

// Bytes returns canonical Fabric bytes for this endorsed transaction.
func (t *EndorsedTransaction) Bytes() ([]byte, error) {
	if t.transaction == nil {
		return append([]byte(nil), t.bytes...), nil
	}
	return t.transaction.Bytes()
}

// Result returns the endorsed transaction result.
func (t *EndorsedTransaction) Result() []byte {
	if t.transaction == nil {
		return append([]byte(nil), t.result...)
	}
	return t.transaction.Result()
}

// TransactionID returns the Fabric transaction ID.
func (t *EndorsedTransaction) TransactionID() string {
	if t.transaction == nil {
		return t.txID
	}
	return t.transaction.TransactionID()
}

// SubmitAsync signs the endorsed transaction with the bridge identity and submits it without waiting for commit.
func (t *EndorsedTransaction) SubmitAsync(ctx context.Context) (*SubmittedTransaction, error) {
	if t.transaction == nil {
		return t.submitPeer(ctx)
	}
	commit, err := t.transaction.SubmitWithContext(ctx)
	if err != nil {
		return nil, &SubmitError{Message: err.Error(), TransactionID: t.TransactionID()}
	}
	return &SubmittedTransaction{
		transactionID: commit.TransactionID(),
		result:        t.Result(),
		waitForCommit: func(ctx context.Context) (*CommitStatus, error) {
			return waitForGatewayCommit(ctx, commit)
		},
	}, nil
}

func (p *SignedProposal) endorsePeer(ctx context.Context) (*EndorsedTransaction, error) {
	responses, proposal, err := p.sendPeerProposal(ctx)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	payload, err := buildPeerTransactionPayload(proposal, responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	result, err := proposalResultPayload(responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	return &EndorsedTransaction{
		bytes:       payload,
		result:      result,
		txID:        p.transactionID,
		bridge:      p.bridge,
		channelName: p.channelName,
	}, nil
}

func (p *SignedProposal) sendPeerProposal(ctx context.Context) ([]*legacyfab.TransactionProposalResponse, *peerProto.Proposal, error) {
	if p.routing == nil || (p.routing.Mode != "single-peer" && p.routing.Mode != "endorsing-peers") {
		return nil, nil, &OfflineSigningError{Field: "routing", Message: "peer signed proposal requires peer routing"}
	}
	pc, err := NewPeerConnection(p.bridge.config, p.channelName)
	if err != nil {
		return nil, nil, err
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(p.channelName)
	if err != nil {
		return nil, nil, err
	}
	tlsEnabled := discoveredPeersUseTLS(discovered)
	if err := ensureUniqueDiscoveredPeerEndpoints(discovered, tlsEnabled); err != nil {
		return nil, nil, err
	}
	var targets []legacyfab.Peer
	for _, endpoint := range p.routing.Peers {
		canonicalEndpoint, err := normalizeSnapshotPeerEndpoint(endpoint, tlsEnabled)
		if err != nil {
			return nil, nil, err
		}
		peer, ok := matchDiscoveredPeer(discovered, canonicalEndpoint)
		if !ok {
			return nil, nil, &PeerNotFoundError{PeerName: canonicalEndpoint, AvailablePeers: peerURLs(discovered)}
		}
		targets = append(targets, peer)
	}
	if len(targets) == 0 {
		return nil, nil, &PeerNotFoundError{PeerName: "<routing.peers>", AvailablePeers: peerURLs(discovered)}
	}

	proposal := &peerProto.Proposal{}
	if err := proto.Unmarshal(p.proposalBytes, proposal); err != nil {
		return nil, nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal proposal: %v", err)}
	}
	request := legacyfab.ProcessProposalRequest{
		SignedProposal: &peerProto.SignedProposal{
			ProposalBytes: p.proposalBytes,
			Signature:     p.signature,
		},
	}
	responses := make([]*legacyfab.TransactionProposalResponse, 0, len(targets))
	for _, target := range targets {
		response, err := target.ProcessTransactionProposal(ctx, request)
		if err != nil {
			return nil, nil, err
		}
		responses = append(responses, response)
	}
	return responses, proposal, nil
}

func normalizeSnapshotPeerEndpoint(endpoint string, tlsEnabled bool) (string, error) {
	canonical, err := normalizePeerEndpointIdentity(endpoint, tlsEnabled)
	if err != nil {
		return "", &OfflineSigningError{Field: "routing.peers", Message: err.Error()}
	}
	return canonical, nil
}

func (t *EndorsedTransaction) submitPeer(ctx context.Context) (*SubmittedTransaction, error) {
	digest := sha256.Sum256(t.bytes)
	signature, err := t.bridge.config.Signer.Sign(digest[:])
	if err != nil {
		return nil, &SubmitError{Message: fmt.Sprintf("sign transaction payload: %v", err), TransactionID: t.txID}
	}

	envelope := &common.Envelope{Payload: append([]byte(nil), t.bytes...), Signature: signature}
	client := gatewayProto.NewGatewayClient(t.bridge.grpcConnection)
	_, err = client.Submit(ctx, &gatewayProto.SubmitRequest{
		TransactionId:       t.txID,
		ChannelId:           t.channelName,
		PreparedTransaction: envelope,
	})
	if err != nil {
		return nil, &SubmitError{Message: err.Error(), TransactionID: t.txID}
	}
	return &SubmittedTransaction{
		transactionID: t.txID,
		result:        t.result,
		waitForCommit: func(ctx context.Context) (*CommitStatus, error) {
			return t.bridge.commitStatus(ctx, t.channelName, t.txID)
		},
	}, nil
}

// Submit signs the endorsed transaction with the bridge identity, submits it, and waits for commit.
func (t *EndorsedTransaction) Submit(ctx context.Context) (*CommitResult, error) {
	submitted, err := t.SubmitAsync(ctx)
	if err != nil {
		return nil, err
	}
	status, err := submitted.WaitForCommit(ctx)
	if err != nil {
		return nil, err
	}
	return &CommitResult{
		transactionID: submitted.TransactionID(),
		result:        submitted.Result(),
		commitStatus:  status,
	}, nil
}

func signingRequest(bytes []byte, digest []byte, routing *OfflineSigningRouting) SigningRequest {
	return SigningRequest{
		Bytes:   base64.StdEncoding.EncodeToString(bytes),
		Digest:  base64.StdEncoding.EncodeToString(digest),
		Routing: cloneRouting(routing),
	}
}

func decodeSignedMessage(message SignedMessage) ([]byte, []byte, []byte, *OfflineSigningRouting, error) {
	messageBytes, err := decodeBase64Field("bytes", message.Bytes)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	digest, err := decodeBase64Field("digest", message.Digest)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	signature, err := decodeBase64Field("signature", message.Signature)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return messageBytes, digest, signature, cloneRouting(message.Routing), nil
}

func decodeBase64Field(field string, value string) ([]byte, error) {
	if value == "" {
		return nil, &OfflineSigningError{Field: field, Message: "must be a non-empty base64 string"}
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, &OfflineSigningError{Field: field, Message: "must be valid base64"}
	}
	if len(decoded) == 0 {
		return nil, &OfflineSigningError{Field: field, Message: "must decode to non-empty bytes"}
	}
	return decoded, nil
}

func validateGatewayRouting(routing *OfflineSigningRouting) error {
	if routing == nil {
		return &OfflineSigningError{Field: "routing", Message: "proposal signing request requires routing"}
	}
	if routing.Mode != "gateway-default" {
		return &ConfigurationError{Field: "routing.mode", Message: fmt.Sprintf("gateway signed proposal cannot resume %s routing", routing.Mode)}
	}
	return nil
}

func cloneRouting(routing *OfflineSigningRouting) *OfflineSigningRouting {
	if routing == nil {
		return nil
	}
	return &OfflineSigningRouting{
		Mode:  routing.Mode,
		Peers: append([]string(nil), routing.Peers...),
	}
}

func digestMismatch(field string) error {
	return &OfflineSigningError{Field: field, Message: "digest does not match message bytes"}
}

func equalDigest(a []byte, b []byte) bool {
	return bytes.Equal(a, b)
}

func parsePeerProposal(proposalBytes []byte) (*peerProto.Proposal, string, string, string, error) {
	proposal := &peerProto.Proposal{}
	if err := proto.Unmarshal(proposalBytes, proposal); err != nil {
		return nil, "", "", "", &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal proposal: %v", err)}
	}
	header := &common.Header{}
	if err := proto.Unmarshal(proposal.GetHeader(), header); err != nil {
		return nil, "", "", "", &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal proposal header: %v", err)}
	}
	channelHeader := &common.ChannelHeader{}
	if err := proto.Unmarshal(header.GetChannelHeader(), channelHeader); err != nil {
		return nil, "", "", "", &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal channel header: %v", err)}
	}
	extension := &peerProto.ChaincodeHeaderExtension{}
	if err := proto.Unmarshal(channelHeader.GetExtension(), extension); err != nil {
		return nil, "", "", "", &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal chaincode header extension: %v", err)}
	}
	return proposal, channelHeader.GetChannelId(), extension.GetChaincodeId().GetName(), channelHeader.GetTxId(), nil
}

func proposalCreatorIdentity(proposalBytes []byte) ([]byte, error) {
	proposalBytes = unwrapProposalBytes(proposalBytes)
	proposal := &peerProto.Proposal{}
	if err := proto.Unmarshal(proposalBytes, proposal); err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal proposal: %v", err)}
	}
	header := &common.Header{}
	if err := proto.Unmarshal(proposal.GetHeader(), header); err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal proposal header: %v", err)}
	}
	signatureHeader := &common.SignatureHeader{}
	if err := proto.Unmarshal(header.GetSignatureHeader(), signatureHeader); err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("unmarshal signature header: %v", err)}
	}
	return append([]byte(nil), signatureHeader.GetCreator()...), nil
}

func unwrapProposalBytes(proposalBytes []byte) []byte {
	proposedTransaction := &gatewayProto.ProposedTransaction{}
	if err := proto.Unmarshal(proposalBytes, proposedTransaction); err == nil {
		rawProposal := proposedTransaction.GetProposal().GetProposalBytes()
		if len(rawProposal) > 0 {
			return rawProposal
		}
	}
	return proposalBytes
}

func buildPeerTransactionPayload(proposal *peerProto.Proposal, responses []*legacyfab.TransactionProposalResponse) ([]byte, error) {
	if len(responses) == 0 {
		return nil, fmt.Errorf("at least one proposal response is required")
	}
	header := &common.Header{}
	if err := proto.Unmarshal(proposal.GetHeader(), header); err != nil {
		return nil, err
	}
	proposalPayload := &peerProto.ChaincodeProposalPayload{}
	if err := proto.Unmarshal(proposal.GetPayload(), proposalPayload); err != nil {
		return nil, err
	}

	first := responses[0].ProposalResponse
	endorsements := make([]*peerProto.Endorsement, 0, len(responses))
	for _, response := range responses {
		if response.ProposalResponse.GetResponse().GetStatus() < int32(common.Status_SUCCESS) ||
			response.ProposalResponse.GetResponse().GetStatus() >= int32(common.Status_BAD_REQUEST) {
			return nil, fmt.Errorf("proposal response was not successful, status %d: %s", response.ProposalResponse.GetResponse().GetStatus(), response.ProposalResponse.GetResponse().GetMessage())
		}
		if !bytes.Equal(first.GetPayload(), response.ProposalResponse.GetPayload()) {
			return nil, fmt.Errorf("proposal response payloads do not match")
		}
		endorsements = append(endorsements, response.ProposalResponse.GetEndorsement())
	}

	payloadNoTransient, err := proto.Marshal(&peerProto.ChaincodeProposalPayload{Input: proposalPayload.GetInput()})
	if err != nil {
		return nil, err
	}
	actionPayload, err := proto.Marshal(&peerProto.ChaincodeActionPayload{
		ChaincodeProposalPayload: payloadNoTransient,
		Action: &peerProto.ChaincodeEndorsedAction{
			ProposalResponsePayload: first.GetPayload(),
			Endorsements:            endorsements,
		},
	})
	if err != nil {
		return nil, err
	}
	transactionBytes, err := proto.Marshal(&peerProto.Transaction{
		Actions: []*peerProto.TransactionAction{{
			Header:  header.GetSignatureHeader(),
			Payload: actionPayload,
		}},
	})
	if err != nil {
		return nil, err
	}
	return proto.Marshal(&common.Payload{Header: header, Data: transactionBytes})
}

func proposalResultPayload(responses []*legacyfab.TransactionProposalResponse) ([]byte, error) {
	if len(responses) == 0 {
		return nil, fmt.Errorf("at least one proposal response is required")
	}
	responsePayload := &peerProto.ProposalResponsePayload{}
	if err := proto.Unmarshal(responses[0].ProposalResponse.GetPayload(), responsePayload); err != nil {
		return nil, err
	}
	chaincodeAction := &peerProto.ChaincodeAction{}
	if err := proto.Unmarshal(responsePayload.GetExtension(), chaincodeAction); err != nil {
		return nil, err
	}
	return chaincodeAction.GetResponse().GetPayload(), nil
}

func parsePeerPayload(payloadBytes []byte) (string, string, []byte, error) {
	payload := &common.Payload{}
	if err := proto.Unmarshal(payloadBytes, payload); err != nil {
		return "", "", nil, err
	}
	header := payload.GetHeader()
	channelHeader := &common.ChannelHeader{}
	if err := proto.Unmarshal(header.GetChannelHeader(), channelHeader); err != nil {
		return "", "", nil, err
	}
	result, err := payloadResult(payload)
	return channelHeader.GetChannelId(), channelHeader.GetTxId(), result, err
}

func payloadResult(payload *common.Payload) ([]byte, error) {
	tx := &peerProto.Transaction{}
	if err := proto.Unmarshal(payload.GetData(), tx); err != nil {
		return nil, err
	}
	if len(tx.GetActions()) == 0 {
		return nil, fmt.Errorf("transaction has no actions")
	}
	actionPayload := &peerProto.ChaincodeActionPayload{}
	if err := proto.Unmarshal(tx.GetActions()[0].GetPayload(), actionPayload); err != nil {
		return nil, err
	}
	responsePayload := &peerProto.ProposalResponsePayload{}
	if err := proto.Unmarshal(actionPayload.GetAction().GetProposalResponsePayload(), responsePayload); err != nil {
		return nil, err
	}
	chaincodeAction := &peerProto.ChaincodeAction{}
	if err := proto.Unmarshal(responsePayload.GetExtension(), chaincodeAction); err != nil {
		return nil, err
	}
	return chaincodeAction.GetResponse().GetPayload(), nil
}
