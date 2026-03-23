package fabricbridge

import (
	"context"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"github.com/hyperledger/fabric-sdk-go/pkg/client/channel"
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
		transientData: make(map[string][]byte),
	}
}

// Contract represents a smart contract on the network
type Contract struct {
	contract      *fabricGateway.Contract
	chaincodeName string
	network       *Network
	config        Config
	transientData map[string][]byte
}

// ChaincodeName returns the chaincode name
func (c *Contract) ChaincodeName() string {
	return c.chaincodeName
}

// Evaluate executes a query on the contract (read-only, gateway mode)
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

// Submit executes a transaction on the contract (write, gateway mode)
func (c *Contract) Submit(ctx context.Context, transactionName string, args ...string) (*TransactionResult, error) {
	opts := []fabricGateway.ProposalOption{
		fabricGateway.WithArguments(args...),
	}

	if len(c.transientData) > 0 {
		opts = append(opts, fabricGateway.WithTransient(c.transientData))
	}

	proposal, err := c.contract.NewProposal(transactionName, opts...)
	if err != nil {
		return nil, &EndorsementError{Message: fmt.Sprintf("create proposal: %v", err)}
	}

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

// Status returns the commit status of the transaction.
// Returns an error if the transaction was executed in peer mode (no commit tracking).
func (r *TransactionResult) Status(ctx context.Context) (*CommitStatus, error) {
	if r.commit == nil {
		return nil, &CommitError{
			Message:       "commit status not available in peer mode",
			TransactionID: r.transactionID,
		}
	}

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

// Transaction represents a prepared transaction with custom options.
// Use SetEndorsingPeers to target specific peers (triggers sequential gateway→peer→gateway mode).
type Transaction struct {
	contract        *Contract
	transactionName string
	endorsingPeers  []string
	transientData   map[string][]byte
}

// SetEndorsingPeers sets specific peers for endorsement (peer-targeting mode).
// When set, the bridge will disconnect from the Gateway service, connect directly
// to the specified peers via fabric-sdk-go, execute the transaction, and then
// reconnect to the Gateway service.
func (t *Transaction) SetEndorsingPeers(peers ...string) *Transaction {
	t.endorsingPeers = peers
	return t
}

// SetTransientData sets transient data for the transaction
func (t *Transaction) SetTransientData(data map[string][]byte) *Transaction {
	t.transientData = data
	return t
}

// Submit executes the transaction with the configured options.
// If endorsing peers are set, it uses the sequential connection pattern:
//  1. Disconnect from Gateway service
//  2. Connect to peers via fabric-sdk-go (Endorser gRPC)
//  3. Execute/endorse the transaction on specified peers
//  4. Disconnect from peers
//  5. Reconnect to Gateway service
func (t *Transaction) Submit(ctx context.Context, args ...string) (*TransactionResult, error) {
	if len(t.endorsingPeers) > 0 {
		return t.submitWithPeerTargeting(ctx, args)
	}

	t.contract.transientData = t.transientData
	return t.contract.Submit(ctx, t.transactionName, args...)
}

// submitWithPeerTargeting executes the sequential connection pattern for peer-targeted transactions
func (t *Transaction) submitWithPeerTargeting(ctx context.Context, args []string) (*TransactionResult, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for peer-targeted transactions (setEndorsingPeers)",
		}
	}

	// Step 1-2: Disconnect gateway, connect peer
	if err := bridge.switchToPeerMode(t.contract.network.channel); err != nil {
		return nil, err
	}

	// Step 4-5: Always restore gateway, even on error
	defer bridge.restoreGatewayMode()

	// Convert args to byte arrays
	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	var resp *channel.Response
	var err error

	// Step 3: Execute on peers
	if bridge.config.OrdererEndpoint != "" {
		// Full flow: endorse + commit via orderer
		resp, err = bridge.peerConnection.Execute(
			ctx,
			t.contract.network.channel,
			t.contract.chaincodeName,
			t.transactionName,
			byteArgs,
			t.endorsingPeers,
			t.transientData,
		)
	} else {
		// Endorsement only: no orderer available
		resp, err = bridge.peerConnection.Endorse(
			ctx,
			t.contract.network.channel,
			t.contract.chaincodeName,
			t.transactionName,
			byteArgs,
			t.endorsingPeers,
			t.transientData,
		)
	}

	if err != nil {
		return nil, &SubmitError{Message: fmt.Sprintf("peer-targeted submit failed: %v", err)}
	}

	return &TransactionResult{
		transactionID: string(resp.TransactionID),
		result:        resp.Payload,
		commit:        nil, // No commit tracking in peer mode
		config:        t.contract.config,
	}, nil
}

// Evaluate executes the transaction as a query with peer targeting if configured
func (t *Transaction) Evaluate(ctx context.Context, args ...string) ([]byte, error) {
	if len(t.endorsingPeers) > 0 {
		return t.evaluateWithPeerTargeting(ctx, args)
	}

	t.contract.transientData = t.transientData
	return t.contract.Evaluate(ctx, t.transactionName, args...)
}

// evaluateWithPeerTargeting evaluates on specific peers using the sequential pattern
func (t *Transaction) evaluateWithPeerTargeting(ctx context.Context, args []string) ([]byte, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for peer-targeted evaluations (setEndorsingPeers)",
		}
	}

	if err := bridge.switchToPeerMode(t.contract.network.channel); err != nil {
		return nil, err
	}

	defer bridge.restoreGatewayMode()

	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	result, err := bridge.peerConnection.Query(
		ctx,
		t.contract.network.channel,
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
