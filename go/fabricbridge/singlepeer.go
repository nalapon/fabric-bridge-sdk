package fabricbridge

import (
	"fmt"
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

func isFailoverEligibleError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "deadline") ||
		strings.Contains(msg, "unavailable") ||
		strings.Contains(msg, "connection") ||
		strings.Contains(msg, "connect") ||
		strings.Contains(msg, "grpc") ||
		strings.Contains(msg, "transport")
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
