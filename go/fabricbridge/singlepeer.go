package fabricbridge

import (
	"fmt"
	"log"
	"math/rand"
	"sort"
	"strings"
	"sync"

	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
)

// PeerSelectionPolicy controls how UseSinglePeer chooses the first peer to try.
type PeerSelectionPolicy string

const (
	// RoundRobinSelection chooses the next peer in a stable rotation.
	RoundRobinSelection PeerSelectionPolicy = "round-robin"
	// RandomSelection shuffles eligible peers for each operation.
	RandomSelection PeerSelectionPolicy = "random"
)

type singlePeerOptions struct {
	candidates []string
	policy     PeerSelectionPolicy
	failover   bool
}

type transactionTargetingKind string

const (
	gatewayDefaultTargeting transactionTargetingKind = "gateway-default"
	singlePeerTargeting     transactionTargetingKind = "single-peer"
	endorsingPeersTargeting transactionTargetingKind = "endorsing-peers"
)

type transactionTargeting struct {
	kind           transactionTargetingKind
	singlePeer     singlePeerOptions
	endorsingPeers []string
}

func gatewayDefaultTransactionTargeting() transactionTargeting {
	return transactionTargeting{kind: gatewayDefaultTargeting}
}

func newSinglePeerTargeting(opts []SinglePeerOption) (transactionTargeting, error) {
	options := defaultSinglePeerOptions(opts)
	if !isSupportedPeerSelectionPolicy(options.policy) {
		return gatewayDefaultTransactionTargeting(), &ConfigurationError{
			Field:   "singlePeer.policy",
			Message: fmt.Sprintf("unsupported peer selection policy: %s", options.policy),
		}
	}
	return transactionTargeting{kind: singlePeerTargeting, singlePeer: options}, nil
}

func newEndorsingPeersTargeting(peers []string) (transactionTargeting, error) {
	if len(peers) == 0 {
		return gatewayDefaultTransactionTargeting(), &ConfigurationError{
			Field:   "endorsingPeers",
			Message: "UseEndorsingPeers requires at least one peer",
		}
	}
	return transactionTargeting{kind: endorsingPeersTargeting, endorsingPeers: append([]string(nil), peers...)}, nil
}

func (t transactionTargeting) singlePeerOptions() (*singlePeerOptions, bool) {
	if t.kind != singlePeerTargeting {
		return nil, false
	}
	options := t.singlePeer
	return &options, true
}

func (t transactionTargeting) endorsingPeerNames() []string {
	if t.kind != endorsingPeersTargeting {
		return nil
	}
	return append([]string(nil), t.endorsingPeers...)
}

// SinglePeerOption configures UseSinglePeer.
type SinglePeerOption func(*singlePeerOptions)

// WithCandidatePeers restricts UseSinglePeer to the provided discovered peers.
func WithCandidatePeers(peers ...string) SinglePeerOption {
	return func(o *singlePeerOptions) {
		o.candidates = append([]string(nil), peers...)
	}
}

// WithPeerSelectionPolicy sets the policy used to choose a single peer.
func WithPeerSelectionPolicy(policy PeerSelectionPolicy) SinglePeerOption {
	return func(o *singlePeerOptions) {
		o.policy = policy
	}
}

// WithSinglePeerFailover enables or disables retrying the next eligible peer.
func WithSinglePeerFailover(enabled bool) SinglePeerOption {
	return func(o *singlePeerOptions) {
		o.failover = enabled
	}
}

type roundRobinState struct {
	mu       sync.Mutex
	counters map[string]int
}

func newRoundRobinState() *roundRobinState {
	return &roundRobinState{counters: make(map[string]int)}
}

func (s *roundRobinState) next(key string, size int) int {
	if size <= 0 {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.counters[key]
	s.counters[key] = (current + 1) % size
	return current % size
}

func defaultSinglePeerOptions(opts []SinglePeerOption) singlePeerOptions {
	out := singlePeerOptions{
		policy:   RoundRobinSelection,
		failover: true,
	}
	for _, opt := range opts {
		opt(&out)
	}
	return out
}

func isSupportedPeerSelectionPolicy(policy PeerSelectionPolicy) bool {
	return policy == RoundRobinSelection || policy == RandomSelection
}

func orderSinglePeers(channelName string, peers []fab.Peer, opts singlePeerOptions, rr *roundRobinState) []fab.Peer {
	ordered := append([]fab.Peer(nil), peers...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].URL() < ordered[j].URL()
	})

	if opts.policy == RandomSelection {
		rand.Shuffle(len(ordered), func(i, j int) {
			ordered[i], ordered[j] = ordered[j], ordered[i]
		})
		return ordered
	}

	keyParts := []string{channelName}
	for _, peer := range ordered {
		keyParts = append(keyParts, peer.URL())
	}
	start := rr.next(strings.Join(keyParts, "|"), len(ordered))
	return append(ordered[start:], ordered[:start]...)
}

func resolveSinglePeerCandidates(discovered []fab.Peer, candidates []string) ([]fab.Peer, error) {
	if len(candidates) == 0 {
		if len(discovered) == 0 {
			return nil, &PeerNotFoundError{PeerName: "<discovered peers>"}
		}
		return discovered, nil
	}

	var resolved []fab.Peer
	var missing []string
	seen := make(map[string]bool)
	for _, candidate := range candidates {
		peer, ok := matchDiscoveredPeer(discovered, candidate)
		if !ok {
			missing = append(missing, candidate)
			continue
		}
		if !seen[peer.URL()] {
			resolved = append(resolved, peer)
			seen[peer.URL()] = true
		}
	}
	if len(missing) > 0 {
		return nil, &PeerNotFoundError{
			PeerName:       strings.Join(missing, ", "),
			AvailablePeers: peerURLs(discovered),
		}
	}
	if len(resolved) == 0 {
		return nil, &PeerNotFoundError{
			PeerName:       strings.Join(candidates, ", "),
			AvailablePeers: peerURLs(discovered),
		}
	}
	return resolved, nil
}

func matchDiscoveredPeer(peers []fab.Peer, name string) (fab.Peer, bool) {
	for _, peer := range peers {
		url := peer.URL()
		host := extractHost(url)
		if name == url || name == host || strings.Contains(host, name) || strings.Contains(name, host) {
			return peer, true
		}
	}
	return nil, false
}

func peerURLs(peers []fab.Peer) []string {
	out := make([]string, 0, len(peers))
	for _, peer := range peers {
		out = append(out, peer.URL())
	}
	return out
}

func executeSinglePeerTargets[T any](
	operation string,
	channelName string,
	chaincodeName string,
	transactionName string,
	candidates []string,
	eligible []fab.Peer,
	ordered []fab.Peer,
	failover bool,
	execute func(fab.Peer) (T, error),
) (T, error) {
	var zero T
	var attempts []SinglePeerAttempt

	for i, peer := range ordered {
		result, err := execute(peer)
		if err == nil {
			return result, nil
		}

		decision := classifyFailover(err)
		attempts = append(attempts, SinglePeerAttempt{Peer: peer.URL(), Cause: err.Error(), Failover: decision})
		if !decision.Eligible {
			return zero, err
		}
		if !failover || i == len(ordered)-1 {
			return zero, singlePeerExecutionError(operation, channelName, chaincodeName, transactionName, candidates, eligible, attempts)
		}

		next := ordered[i+1]
		log.Printf("fabric_bridge.single_peer.failover event=fabric_bridge.single_peer.failover operation=%s channel=%s chaincode=%s transaction=%s failedPeer=%s nextPeer=%s attempt=%d maxAttempts=%d category=%s reason=%q",
			operation, channelName, chaincodeName, transactionName, peer.URL(), next.URL(), i+1, len(ordered), decision.Category, decision.Reason)
	}

	return zero, singlePeerExecutionError(operation, channelName, chaincodeName, transactionName, candidates, eligible, attempts)
}

func singlePeerExecutionError(operation, channelName, chaincodeName, transactionName string, candidates []string, eligible []fab.Peer, attempts []SinglePeerAttempt) *SinglePeerExecutionError {
	return &SinglePeerExecutionError{
		Message:         fmt.Sprintf("single-peer transaction failed after trying %d eligible peer(s)", len(attempts)),
		Operation:       operation,
		Channel:         channelName,
		Chaincode:       chaincodeName,
		TransactionName: transactionName,
		Candidates:      append([]string(nil), candidates...),
		EligiblePeers:   peerURLs(eligible),
		Attempts:        append([]SinglePeerAttempt(nil), attempts...),
	}
}
