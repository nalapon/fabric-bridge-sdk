package fabricbridge

import (
	"context"
	"errors"
	"fmt"

	fabricGateway "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	legacyfab "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
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
// Use UseSinglePeer or UseEndorsingPeers to target peers via the legacy peer path.
type Transaction struct {
	contract        *Contract
	transactionName string
	targeting       transactionTargeting
	transientData   map[string][]byte
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
func (t *Transaction) UseSinglePeer(opts ...SinglePeerOption) error {
	targeting, err := newSinglePeerTargeting(opts)
	if err != nil {
		return err
	}
	t.targeting = targeting
	return nil
}

// SetTransientData sets transient data for the transaction
func (t *Transaction) SetTransientData(data map[string][]byte) *Transaction {
	t.transientData = data
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
	if _, ok := t.targeting.singlePeerOptions(); ok {
		return t.submitAsyncWithSinglePeer(ctx, args)
	}
	if len(t.targeting.endorsingPeerNames()) > 0 {
		return t.submitAsyncWithPeerTargeting(ctx, args)
	}

	return t.contract.submitAsync(ctx, t.transactionName, t.transientData, args...)
}

// submitAsyncWithPeerTargeting executes a peer-targeted submit using the legacy SDK path.
func (t *Transaction) submitAsyncWithPeerTargeting(ctx context.Context, args []string) (*SubmittedTransaction, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for UseEndorsingPeers",
		}
	}
	if bridge.config.OrdererEndpoint == "" {
		return nil, &ConfigurationError{
			Field:   "ordererEndpoint",
			Message: "ordererEndpoint is required for Submit and SubmitAsync when peer targeting is enabled",
		}
	}

	pc, err := NewPeerConnection(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}

	// Convert args to byte arrays
	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	submitted, err := pc.SubmitAsync(
		ctx,
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		byteArgs,
		t.targeting.endorsingPeerNames(),
		t.transientData,
	)
	if err != nil {
		pc.Close()
		return nil, &SubmitError{Message: fmt.Sprintf("peer-targeted submit failed: %v", err)}
	}

	return &SubmittedTransaction{
		transactionID: string(submitted.response.TransactionID),
		result:        submitted.response.Payload,
		waitForCommit: submitted.waitForCommit,
	}, nil
}

// Evaluate executes the transaction as a query with peer targeting if configured
func (t *Transaction) Evaluate(ctx context.Context, args ...string) ([]byte, error) {
	if _, ok := t.targeting.singlePeerOptions(); ok {
		return t.evaluateWithSinglePeer(ctx, args)
	}
	if len(t.targeting.endorsingPeerNames()) > 0 {
		return t.evaluateWithPeerTargeting(ctx, args)
	}

	return t.contract.evaluate(ctx, t.transactionName, t.transientData, args...)
}

func (t *Transaction) submitAsyncWithSinglePeer(ctx context.Context, args []string) (*SubmittedTransaction, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for UseSinglePeer",
		}
	}
	if bridge.config.OrdererEndpoint == "" {
		return nil, &ConfigurationError{
			Field:   "ordererEndpoint",
			Message: "ordererEndpoint is required for Submit and SubmitAsync when UseSinglePeer is enabled",
		}
	}

	pc, err := NewPeerConnection(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer func() {
		// SubmitAsync success transfers ownership to the commit monitor.
	}()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		pc.Close()
		return nil, &DiscoveryError{Message: "discover peers for UseSinglePeer", Cause: err}
	}
	singlePeer, _ := t.targeting.singlePeerOptions()
	eligible, err := resolveSinglePeerCandidates(discovered, singlePeer.candidates)
	if err != nil {
		pc.Close()
		return nil, err
	}
	ordered := orderSinglePeers(t.contract.network.channel, eligible, *singlePeer, bridge.roundRobin)
	if !singlePeer.failover && len(ordered) > 1 {
		ordered = ordered[:1]
	}

	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	submitted, err := executeSinglePeerTargets(
		"submitAsync",
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		singlePeer.candidates,
		eligible,
		ordered,
		singlePeer.failover,
		func(peer legacyfab.Peer) (*peerSubmittedTransaction, error) {
			return pc.SubmitAsyncTargets(
				ctx,
				t.contract.network.channel,
				t.contract.chaincodeName,
				t.transactionName,
				byteArgs,
				[]legacyfab.Peer{peer},
				t.transientData,
			)
		},
	)
	if err != nil {
		pc.Close()
		return nil, err
	}

	return &SubmittedTransaction{
		transactionID: string(submitted.response.TransactionID),
		result:        submitted.response.Payload,
		waitForCommit: submitted.waitForCommit,
	}, nil
}

func (t *Transaction) evaluateWithSinglePeer(ctx context.Context, args []string) ([]byte, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for UseSinglePeer",
		}
	}

	pc, err := NewPeerConnection(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	discovered, err := pc.DiscoverPeers(t.contract.network.channel)
	if err != nil {
		return nil, &DiscoveryError{Message: "discover peers for UseSinglePeer", Cause: err}
	}
	singlePeer, _ := t.targeting.singlePeerOptions()
	eligible, err := resolveSinglePeerCandidates(discovered, singlePeer.candidates)
	if err != nil {
		return nil, err
	}
	ordered := orderSinglePeers(t.contract.network.channel, eligible, *singlePeer, bridge.roundRobin)
	if !singlePeer.failover && len(ordered) > 1 {
		ordered = ordered[:1]
	}

	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	return executeSinglePeerTargets(
		"evaluate",
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		singlePeer.candidates,
		eligible,
		ordered,
		singlePeer.failover,
		func(peer legacyfab.Peer) ([]byte, error) {
			return pc.QueryTargets(
				ctx,
				t.contract.network.channel,
				t.contract.chaincodeName,
				t.transactionName,
				byteArgs,
				[]legacyfab.Peer{peer},
				t.transientData,
			)
		},
	)
}

// evaluateWithPeerTargeting evaluates on specific peers using the legacy SDK path.
func (t *Transaction) evaluateWithPeerTargeting(ctx context.Context, args []string) ([]byte, error) {
	bridge := t.contract.network.bridge

	if !bridge.config.HasPrivateKey() {
		return nil, &ConfigurationError{
			Field:   "identity.privateKey",
			Message: "privateKey is required for UseEndorsingPeers",
		}
	}

	pc, err := NewPeerConnection(bridge.config, t.contract.network.channel)
	if err != nil {
		return nil, &ConnectionError{Message: "failed to connect in peer mode", Cause: err}
	}
	defer pc.Close()

	byteArgs := make([][]byte, len(args))
	for i, arg := range args {
		byteArgs[i] = []byte(arg)
	}

	result, err := pc.Query(
		ctx,
		t.contract.network.channel,
		t.contract.chaincodeName,
		t.transactionName,
		byteArgs,
		t.targeting.endorsingPeerNames(),
		t.transientData,
	)
	if err != nil {
		return nil, &EvaluationError{Message: fmt.Sprintf("peer-targeted query failed: %v", err)}
	}

	return result, nil
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
