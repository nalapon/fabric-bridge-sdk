package fabricbridge

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	gatewayProto "github.com/hyperledger/fabric-protos-go-apiv2/gateway"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Network represents a Fabric channel and provides access to contracts
type Network struct {
	network *fabricGateway.Network
	channel string
	bridge  *Bridge
	config  Config
}

// ChannelName returns the channel name
func (n *Network) ChannelName() string {
	return n.channel
}

// Contract returns a Contract for the specified chaincode
func (n *Network) Contract(chaincodeName string, contractName ...string) *Contract {
	var fc *fabricGateway.Contract
	if len(contractName) > 0 && contractName[0] != "" {
		fc = n.network.GetContractWithName(chaincodeName, contractName[0])
	} else {
		fc = n.network.GetContract(chaincodeName)
	}

	return &Contract{
		contract:      fc,
		chaincodeName: chaincodeName,
		network:       n,
		config:        n.config,
	}
}

// Contract represents a smart contract on the network
type Contract struct {
	contract      *fabricGateway.Contract
	chaincodeName string
	network       *Network
	config        Config
}

// ChaincodeName returns the chaincode name
func (c *Contract) ChaincodeName() string {
	return c.chaincodeName
}

// Evaluate executes a query on the contract (read-only, gateway mode)
func (c *Contract) Evaluate(ctx context.Context, transactionName string, args ...string) ([]byte, error) {
	return c.evaluate(ctx, transactionName, nil, args...)
}

func (c *Contract) evaluate(ctx context.Context, transactionName string, transientData map[string][]byte, args ...string) ([]byte, error) {
	c.network.bridge.modeMu.RLock()
	defer c.network.bridge.modeMu.RUnlock()

	opts := []fabricGateway.ProposalOption{
		fabricGateway.WithArguments(args...),
	}
	if len(transientData) > 0 {
		opts = append(opts, fabricGateway.WithTransient(copyTransientData(transientData)))
	}

	result, err := c.contract.EvaluateWithContext(ctx, transactionName, opts...)
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("evaluate: %v", err)}
	}

	return result, nil
}

// Submit executes a transaction on the contract and waits for commit by default.
func (c *Contract) Submit(ctx context.Context, transactionName string, args ...string) (*CommitResult, error) {
	submitted, err := c.SubmitAsync(ctx, transactionName, args...)
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

// SubmitAsync submits a transaction on the contract without waiting for commit.
func (c *Contract) SubmitAsync(ctx context.Context, transactionName string, args ...string) (*SubmittedTransaction, error) {
	return c.submitAsync(ctx, transactionName, nil, args...)
}

func (c *Contract) submitAsync(ctx context.Context, transactionName string, transientData map[string][]byte, args ...string) (*SubmittedTransaction, error) {
	c.network.bridge.modeMu.RLock()
	defer c.network.bridge.modeMu.RUnlock()

	opts := []fabricGateway.ProposalOption{
		fabricGateway.WithArguments(args...),
	}

	if len(transientData) > 0 {
		opts = append(opts, fabricGateway.WithTransient(copyTransientData(transientData)))
	}

	result, commit, err := c.contract.SubmitAsyncWithContext(ctx, transactionName, opts...)
	if err != nil {
		return nil, wrapSubmitAsyncError(err)
	}

	return &SubmittedTransaction{
		transactionID: commit.TransactionID(),
		result:        result,
		waitForCommit: func(ctx context.Context) (*CommitStatus, error) {
			return waitForGatewayCommit(ctx, commit)
		},
	}, nil
}

// Transaction returns a transaction builder for advanced usage
func (c *Contract) Transaction(transactionName string) *Transaction {
	return &Transaction{
		contract:        c,
		transactionName: transactionName,
		targeting:       gatewayDefaultTransactionTargeting(),
		transientData:   make(map[string][]byte),
	}
}

// CommitResult represents a transaction that has been committed.
type CommitResult struct {
	transactionID string
	result        []byte
	commitStatus  *CommitStatus
}

// Result returns the transaction result.
func (r *CommitResult) Result() []byte {
	return r.result
}

// TransactionID returns the transaction ID.
func (r *CommitResult) TransactionID() string {
	return r.transactionID
}

// CommitStatus returns the commit status captured by Submit().
func (r *CommitResult) CommitStatus() *CommitStatus {
	return r.commitStatus
}

// SubmittedTransaction represents a transaction that has been sent to the orderer
// and can be awaited later.
type SubmittedTransaction struct {
	transactionID string
	result        []byte
	waitForCommit func(ctx context.Context) (*CommitStatus, error)
}

// Result returns the transaction result.
func (r *SubmittedTransaction) Result() []byte {
	return r.result
}

// TransactionID returns the transaction ID.
func (r *SubmittedTransaction) TransactionID() string {
	return r.transactionID
}

// WaitForCommit blocks until the transaction is committed or the context is cancelled.
func (r *SubmittedTransaction) WaitForCommit(ctx context.Context) (*CommitStatus, error) {
	if r.waitForCommit == nil {
		return nil, &CommitError{
			Message:       "commit waiting is not available for this transaction",
			TransactionID: r.transactionID,
		}
	}

	return r.waitForCommit(ctx)
}

// CommitStatus represents the commit status of a transaction
type CommitStatus struct {
	BlockNumber   uint64
	Status        peer.TxValidationCode
	TransactionID string
}

// Transaction represents a prepared transaction with custom options.
// Use UseSinglePeer or UseEndorsingPeers to target peers via the direct endorsement path.
type Transaction struct {
	contract        *Contract
	transactionName string
	targeting       transactionTargeting
	transientData   map[string][]byte
	proposalCreator *ProposalCreator
}

// UseEndorsingPeers sends proposals to every named peer (peer-targeting mode).
func (t *Transaction) UseEndorsingPeers(peers ...string) error {
	targeting, err := newEndorsingPeersTargeting(peers)
	if err != nil {
		return err
	}
	t.targeting = targeting
	return nil
}

// UseSinglePeer chooses one discovered peer per attempt.
func (t *Transaction) UseSinglePeer() error {
	t.targeting = newSinglePeerTargeting()
	return nil
}

// SetTransientData sets transient data for the transaction
func (t *Transaction) SetTransientData(data map[string][]byte) *Transaction {
	t.transientData = data
	return t
}

// SetProposalCreator sets the Fabric identity embedded in offline proposals.
func (t *Transaction) SetProposalCreator(proposalCreator ProposalCreator) *Transaction {
	clone := cloneProposalCreator(proposalCreator)
	t.proposalCreator = &clone
	return t
}

// Submit executes the transaction and waits for commit by default.
func (t *Transaction) Submit(ctx context.Context, args ...string) (*CommitResult, error) {
	submitted, err := t.SubmitAsync(ctx, args...)
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

// SubmitAsync executes the transaction without waiting for commit.
func (t *Transaction) SubmitAsync(ctx context.Context, args ...string) (*SubmittedTransaction, error) {
	if t.targeting.isSinglePeer() {
		return t.submitAsyncWithSinglePeer(ctx, args)
	}
	if len(t.targeting.endorsingPeerNames()) > 0 {
		return t.submitAsyncWithPeerTargeting(ctx, args)
	}

	return t.contract.submitAsync(ctx, t.transactionName, t.transientData, args...)
}

// NewUnsignedProposal creates a signable proposal for offline transaction signing.
func (t *Transaction) NewUnsignedProposal(ctx context.Context, args ...string) (*UnsignedProposal, error) {
	if t.proposalCreator == nil {
		return nil, &ConfigurationError{
			Field:   "proposalCreator",
			Message: "proposalCreator is required to build an unsigned proposal for offline signing",
		}
	}

	if t.targeting.isSinglePeer() {
		return t.newUnsignedPeerProposal(ctx, args)
	}
	if len(t.targeting.endorsingPeerNames()) > 0 {
		return t.newUnsignedPeerProposal(ctx, args)
	}

	proposal, txID, err := t.buildGatewayProposal(args)
	if err != nil {
		return nil, err
	}

	proposalBytes, err := proto.Marshal(proposal)
	if err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("marshal proposal: %v", err)}
	}
	digest := sha256.Sum256(proposalBytes)

	proposedTransactionBytes, err := proto.Marshal(&gatewayProto.ProposedTransaction{
		TransactionId: txID,
		Proposal: &peer.SignedProposal{
			ProposalBytes: proposalBytes,
		},
	})
	if err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("marshal proposed transaction: %v", err)}
	}

	return newUnsignedProposal(proposedTransactionBytes, digest[:], txID, &OfflineSigningRouting{Mode: "gateway-default"}), nil
}

func (t *Transaction) newUnsignedPeerProposal(ctx context.Context, args []string) (*UnsignedProposal, error) {
	bridge := t.contract.network.bridge
	pc, err := newPeerRuntime(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for offline signing", Cause: err}
	}

	var routing *OfflineSigningRouting
	if t.targeting.isSinglePeer() {
		eligible, err := resolveDiscoveredSinglePeers(discovered)
		if err != nil {
			return nil, err
		}
		ordered := orderSinglePeers(t.contract.network.channel, eligible, bridge.roundRobin)
		if len(ordered) == 0 {
			return nil, &PeerNotFoundError{PeerName: "<single-peer>", AvailablePeers: peerURLs(discovered)}
		}
		canonical, err := canonicalDiscoveredPeerEndpoint(ordered[0], discoveredPeersUseTLS(discovered))
		if err != nil {
			return nil, err
		}
		routing = &OfflineSigningRouting{Mode: "single-peer", Peers: []string{canonical}}
	} else {
		targets, err := resolveEndorsingPeerTargets(discovered, t.targeting.endorsingPeerNames())
		if err != nil {
			return nil, err
		}
		var peers []string
		for _, peer := range targets {
			canonical, err := canonicalDiscoveredPeerEndpoint(peer, discoveredPeersUseTLS(discovered))
			if err != nil {
				return nil, err
			}
			peers = append(peers, canonical)
		}
		routing = &OfflineSigningRouting{Mode: "endorsing-peers", Peers: peers}
	}

	proposal, txID, err := t.buildPeerProposal(args)
	if err != nil {
		return nil, err
	}
	proposalBytes, err := proto.Marshal(proposal)
	if err != nil {
		return nil, &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("marshal proposal: %v", err)}
	}
	digest := sha256.Sum256(proposalBytes)
	return newUnsignedProposal(proposalBytes, digest[:], txID, routing), nil
}

func (t *Transaction) buildGatewayProposal(args []string) (*peer.Proposal, string, error) {
	return t.buildProposal(args, 0)
}

func (t *Transaction) buildPeerProposal(args []string) (*peer.Proposal, string, error) {
	return t.buildProposal(args, peer.ChaincodeSpec_GOLANG)
}

func (t *Transaction) buildProposal(args []string, chaincodeType peer.ChaincodeSpec_Type) (*peer.Proposal, string, error) {
	if t.proposalCreator == nil {
		return nil, "", &ConfigurationError{
			Field:   "proposalCreator",
			Message: "proposalCreator is required to build an unsigned proposal for offline signing",
		}
	}
	creator, err := proto.Marshal(&msp.SerializedIdentity{
		Mspid:   t.proposalCreator.MSPId,
		IdBytes: t.proposalCreator.Certificate,
	})
	if err != nil {
		return nil, "", &OfflineSigningError{Field: "proposalCreator", Message: fmt.Sprintf("serialize identity: %v", err)}
	}

	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return nil, "", &OfflineSigningError{Field: "nonce", Message: err.Error()}
	}
	txIDHash := sha256.Sum256(append(append([]byte(nil), nonce...), creator...))
	txID := hex.EncodeToString(txIDHash[:])

	byteArgs := make([][]byte, len(args)+1)
	byteArgs[0] = []byte(t.transactionName)
	for i, arg := range args {
		byteArgs[i+1] = []byte(arg)
	}
	ccis := &peer.ChaincodeInvocationSpec{ChaincodeSpec: &peer.ChaincodeSpec{
		Type: chaincodeType,
		ChaincodeId: &peer.ChaincodeID{
			Name: t.contract.chaincodeName,
		},
		Input: &peer.ChaincodeInput{Args: byteArgs},
	}}
	proposal, err := createLegacyProposal(
		txID,
		t.contract.network.channel,
		t.contract.chaincodeName,
		ccis,
		nonce,
		creator,
		copyTransientData(t.transientData),
	)
	if err != nil {
		return nil, "", &OfflineSigningError{Field: "bytes", Message: fmt.Sprintf("create proposal: %v", err)}
	}
	return proposal, txID, nil
}

func createLegacyProposal(txID string, channelName string, chaincodeName string, ccis *peer.ChaincodeInvocationSpec, nonce []byte, creator []byte, transientData map[string][]byte) (*peer.Proposal, error) {
	invocationBytes, err := proto.Marshal(ccis)
	if err != nil {
		return nil, err
	}
	payloadBytes, err := proto.Marshal(&peer.ChaincodeProposalPayload{
		Input:        invocationBytes,
		TransientMap: transientData,
	})
	if err != nil {
		return nil, err
	}
	headerExtensionBytes, err := proto.Marshal(&peer.ChaincodeHeaderExtension{ChaincodeId: &peer.ChaincodeID{Name: chaincodeName}})
	if err != nil {
		return nil, err
	}
	channelHeaderBytes, err := proto.Marshal(&common.ChannelHeader{
		Type:      int32(common.HeaderType_ENDORSER_TRANSACTION),
		ChannelId: channelName,
		TxId:      txID,
		Timestamp: timestamppb.Now(),
		Extension: headerExtensionBytes,
	})
	if err != nil {
		return nil, err
	}
	signatureHeaderBytes, err := proto.Marshal(&common.SignatureHeader{Creator: creator, Nonce: nonce})
	if err != nil {
		return nil, err
	}
	headerBytes, err := proto.Marshal(&common.Header{ChannelHeader: channelHeaderBytes, SignatureHeader: signatureHeaderBytes})
	if err != nil {
		return nil, err
	}
	return &peer.Proposal{Header: headerBytes, Payload: payloadBytes}, nil
}

// submitAsyncWithPeerTargeting executes explicit endorsement, then submits through the current peer submit path.
func (t *Transaction) submitAsyncWithPeerTargeting(ctx context.Context, args []string) (*SubmittedTransaction, error) {
	bridge := t.contract.network.bridge

	pc, err := newPeerRuntime(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for UseEndorsingPeers", Cause: err}
	}
	targets, err := resolveEndorsingPeerTargets(discovered, t.targeting.endorsingPeerNames())
	if err != nil {
		return nil, err
	}
	proposal, txID, responses, err := t.endorseExplicitPeerTargets(ctx, args, targets)
	if err != nil {
		return nil, err
	}
	payload, err := buildPeerTransactionPayload(proposal, responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	result, err := proposalResultPayload(responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}

	submitted, err := (&EndorsedTransaction{
		bytes:       payload,
		result:      result,
		txID:        txID,
		bridge:      bridge,
		channelName: t.contract.network.channel,
	}).submitPeer(ctx)
	if err != nil {
		return nil, err
	}
	return submitted, nil
}

// Evaluate executes the transaction as a query with peer targeting if configured
func (t *Transaction) Evaluate(ctx context.Context, args ...string) ([]byte, error) {
	if t.targeting.isSinglePeer() {
		return t.evaluateWithSinglePeer(ctx, args)
	}
	if len(t.targeting.endorsingPeerNames()) > 0 {
		return t.evaluateWithPeerTargeting(ctx, args)
	}

	return t.contract.evaluate(ctx, t.transactionName, t.transientData, args...)
}

func (t *Transaction) submitAsyncWithSinglePeer(ctx context.Context, args []string) (*SubmittedTransaction, error) {
	bridge := t.contract.network.bridge

	pc, err := newPeerRuntime(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for UseSinglePeer", Cause: err}
	}
	eligible, err := resolveDiscoveredSinglePeers(discovered)
	if err != nil {
		return nil, err
	}
	ordered := orderSinglePeers(t.contract.network.channel, eligible, bridge.roundRobin)

	proposal, txID, err := t.buildOnlinePeerProposal(args)
	if err != nil {
		return nil, err
	}
	request, err := signedProposalRequest(proposal, bridge.config.Signer)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}

	response, err := executeSinglePeerTargets(
		"submitAsync",
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		eligible,
		ordered,
		func(peer peerTarget) (*proposalResponse, error) {
			return endorsePeerTarget(ctx, request, peer)
		},
	)
	if err != nil {
		return nil, err
	}
	responses := []*proposalResponse{response}
	payload, err := buildPeerTransactionPayload(proposal, responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	result, err := proposalResultPayload(responses)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}

	return (&EndorsedTransaction{
		bytes:       payload,
		result:      result,
		txID:        txID,
		bridge:      bridge,
		channelName: t.contract.network.channel,
	}).submitPeer(ctx)
}

func (t *Transaction) evaluateWithSinglePeer(ctx context.Context, args []string) ([]byte, error) {
	bridge := t.contract.network.bridge

	pc, err := newPeerRuntime(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for UseSinglePeer", Cause: err}
	}
	eligible, err := resolveDiscoveredSinglePeers(discovered)
	if err != nil {
		return nil, err
	}
	ordered := orderSinglePeers(t.contract.network.channel, eligible, bridge.roundRobin)

	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	return executeSinglePeerTargets(
		"evaluate",
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		eligible,
		ordered,
		func(peer peerTarget) ([]byte, error) {
			return pc.QueryTargets(
				ctx,
				t.contract.network.channel,
				t.contract.chaincodeName,
				t.transactionName,
				byteArgs,
				[]peerTarget{peer},
				t.transientData,
			)
		},
	)
}

// evaluateWithPeerTargeting evaluates on every caller-selected discovered peer.
func (t *Transaction) evaluateWithPeerTargeting(ctx context.Context, args []string) ([]byte, error) {
	bridge := t.contract.network.bridge

	pc, err := newPeerRuntime(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for UseEndorsingPeers", Cause: err}
	}
	targets, err := resolveEndorsingPeerTargets(discovered, t.targeting.endorsingPeerNames())
	if err != nil {
		return nil, err
	}

	_, _, responses, err := t.endorseExplicitPeerTargets(ctx, args, targets)
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("peer-targeted query failed: %v", err)}
	}

	return proposalResultPayload(responses)
}

func copyTransientData(input map[string][]byte) map[string][]byte {
	if len(input) == 0 {
		return nil
	}

	out := make(map[string][]byte, len(input))
	for key, value := range input {
		if value == nil {
			out[key] = nil
			continue
		}
		cloned := make([]byte, len(value))
		copy(cloned, value)
		out[key] = cloned
	}

	return out
}

func wrapSubmitAsyncError(err error) error {
	if err == nil {
		return nil
	}

	var endorseErr *fabricGateway.EndorseError
	if errors.As(err, &endorseErr) {
		return &EndorsementError{Message: endorseErr.Error()}
	}

	var submitErr *fabricGateway.SubmitError
	if errors.As(err, &submitErr) {
		return &SubmitError{Message: submitErr.Error(), TransactionID: submitErr.TransactionID}
	}

	return &SubmitError{Message: err.Error()}
}

func waitForGatewayCommit(ctx context.Context, commit *fabricGateway.Commit) (*CommitStatus, error) {
	if commit == nil {
		return nil, &CommitError{Message: "commit status handle is nil"}
	}

	status, err := commit.StatusWithContext(ctx)
	if err != nil {
		return nil, &CommitError{
			Message:       fmt.Sprintf("get status: %v", err),
			TransactionID: commit.TransactionID(),
		}
	}

	commitStatus := &CommitStatus{
		BlockNumber:   status.BlockNumber,
		Status:        status.Code,
		TransactionID: commit.TransactionID(),
	}

	if status.Code != peer.TxValidationCode_VALID {
		return commitStatus, &CommitError{
			Message:       "transaction committed with invalid validation code",
			TransactionID: commit.TransactionID(),
			Status:        status.Code.String(),
		}
	}

	return commitStatus, nil
}
