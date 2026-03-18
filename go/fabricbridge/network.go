package fabricbridge

import (
	"context"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

// Network represents a Fabric channel and provides access to contracts
type Network struct {
	network        *fabricGateway.Network
	channel        string
	bridge         *Bridge
	config         Config
	peerConnection *PeerConnection
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
		contract:       fc,
		chaincodeName:  chaincodeName,
		network:        n,
		config:         n.config,
		transientData:  make(map[string][]byte),
		peerConnection: n.peerConnection,
	}
}

// Contract represents a smart contract on the network
type Contract struct {
	contract       *fabricGateway.Contract
	chaincodeName  string
	network        *Network
	config         Config
	peerConnection *PeerConnection

	// For peer-targeted transactions
	transientData map[string][]byte
}

// ChaincodeName returns the chaincode name
func (c *Contract) ChaincodeName() string {
	return c.chaincodeName
}

// Evaluate executes a query on the contract (read-only)
func (c *Contract) Evaluate(ctx context.Context, transactionName string, args ...string) ([]byte, error) {
	proposal, err := c.contract.NewProposal(transactionName, fabricGateway.WithArguments(args...))
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("create proposal: %v", err)}
	}

	result, err := proposal.Evaluate()
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("evaluate: %v", err)}
	}

	return result, nil
}

// Submit executes a transaction on the contract (write)
func (c *Contract) Submit(ctx context.Context, transactionName string, args ...string) (*TransactionResult, error) {
	// Build proposal options
	opts := []fabricGateway.ProposalOption{
		fabricGateway.WithArguments(args...),
	}

	// Add transient data if present
	if len(c.transientData) > 0 {
		opts = append(opts, fabricGateway.WithTransient(c.transientData))
	}

	proposal, err := c.contract.NewProposal(transactionName, opts...)
	if err != nil {
		return nil, &EndorsementError{Message: fmt.Sprintf("create proposal: %v", err)}
	}

	// In gateway mode, fabric-gateway handles endorsement and submit
	transaction, err := proposal.Endorse()
	if err != nil {
		return nil, &EndorsementError{Message: fmt.Sprintf("endorse: %v", err)}
	}

	submitted, err := transaction.Submit()
	if err != nil {
		return nil, &SubmitError{Message: fmt.Sprintf("submit: %v", err)}
	}

	return &TransactionResult{
		transactionID: submitted.TransactionID(),
		result:        transaction.Result(),
		commit:        submitted,
		config:        c.config,
	}, nil
}

// Transaction returns a transaction builder for advanced usage
func (c *Contract) Transaction(transactionName string) *Transaction {
	return &Transaction{
		contract:        c,
		transactionName: transactionName,
		endorsingPeers:  []string{},
		transientData:   make(map[string][]byte),
	}
}

// TransactionResult represents the result of a submitted transaction
type TransactionResult struct {
	transactionID string
	result        []byte
	commit        *fabricGateway.Commit
	config        Config
}

// Result returns the transaction result
func (r *TransactionResult) Result() []byte {
	return r.result
}

// TransactionID returns the transaction ID
func (r *TransactionResult) TransactionID() string {
	return r.transactionID
}

// Status returns the commit status of the transaction
func (r *TransactionResult) Status(ctx context.Context) (*CommitStatus, error) {
	status, err := r.commit.StatusWithContext(ctx)
	if err != nil {
		return nil, &CommitError{Message: fmt.Sprintf("get status: %v", err), TransactionID: r.transactionID}
	}

	return &CommitStatus{
		BlockNumber:   status.BlockNumber,
		Status:        status.Code,
		TransactionID: r.transactionID,
	}, nil
}

// CommitStatus represents the commit status of a transaction
type CommitStatus struct {
	BlockNumber   uint64
	Status        peer.TxValidationCode
	TransactionID string
}

// Transaction represents a prepared transaction with custom options
type Transaction struct {
	contract        *Contract
	transactionName string
	endorsingPeers  []string
	transientData   map[string][]byte
}

// SetEndorsingPeers sets specific peers for endorsement (peer-targeting mode)
func (t *Transaction) SetEndorsingPeers(peers ...string) *Transaction {
	t.endorsingPeers = peers
	return t
}

// SetTransientData sets transient data for the transaction
func (t *Transaction) SetTransientData(data map[string][]byte) *Transaction {
	t.transientData = data
	return t
}

// Submit executes the transaction with the configured options
func (t *Transaction) Submit(ctx context.Context, args ...string) (*TransactionResult, error) {
	// If endorsing peers are specified, use peer-targeting mode
	if len(t.endorsingPeers) > 0 && t.contract.peerConnection != nil {
		return t.submitWithPeerTargeting(ctx, args)
	}

	// Otherwise, use gateway mode
	t.contract.transientData = t.transientData
	return t.contract.Submit(ctx, t.transactionName, args...)
}

// submitWithPeerTargeting submits transaction to specific peers using fabric-sdk-go
func (t *Transaction) submitWithPeerTargeting(ctx context.Context, args []string) (*TransactionResult, error) {
	// Convert args to byte arrays
	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	// Execute using peer connection
	resp, err := t.contract.peerConnection.Execute(
		ctx,
		t.contract.chaincodeName,
		t.transactionName,
		byteArgs,
		t.endorsingPeers,
		t.transientData,
	)
	if err != nil {
		return nil, &SubmitError{Message: fmt.Sprintf("peer-targeted submit failed: %v", err)}
	}

	// For peer-targeted transactions, we don't get a commit object from fabric-sdk-go
	// Return a simplified result
	return &TransactionResult{
		transactionID: string(resp.TransactionID),
		result:        resp.Payload,
		commit:        nil, // No commit tracking in peer mode
		config:        t.contract.config,
	}, nil
}

// Evaluate executes the transaction as a query
func (t *Transaction) Evaluate(ctx context.Context, args ...string) ([]byte, error) {
	// If endorsing peers are specified, use peer-targeting mode for evaluation too
	if len(t.endorsingPeers) > 0 && t.contract.peerConnection != nil {
		return t.evaluateWithPeerTargeting(ctx, args)
	}

	t.contract.transientData = t.transientData
	return t.contract.Evaluate(ctx, t.transactionName, args...)
}

// evaluateWithPeerTargeting queries specific peers using fabric-sdk-go
func (t *Transaction) evaluateWithPeerTargeting(ctx context.Context, args []string) ([]byte, error) {
	// Convert args to byte arrays
	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	// Query using peer connection
	result, err := t.contract.peerConnection.Query(
		ctx,
		t.contract.chaincodeName,
		t.transactionName,
		byteArgs,
		t.endorsingPeers,
	)
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("peer-targeted query failed: %v", err)}
	}

	return result, nil
}
