package fabricbridge

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
)

type transactionTargetingKind string

const (
	gatewayDefaultTargeting transactionTargetingKind = "gateway-default"
	singlePeerTargeting     transactionTargetingKind = "single-peer"
	endorsingPeersTargeting transactionTargetingKind = "endorsing-peers"
)

type transactionTargeting struct {
	kind           transactionTargetingKind
	endorsingPeers []string
}

func gatewayDefaultTransactionTargeting() transactionTargeting {
	return transactionTargeting{kind: gatewayDefaultTargeting}
}

func newSinglePeerTargeting() transactionTargeting {
	return transactionTargeting{kind: singlePeerTargeting}
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

func (t transactionTargeting) isSinglePeer() bool {
	return t.kind == singlePeerTargeting
}

func (t transactionTargeting) endorsingPeerNames() []string {
	if t.kind != endorsingPeersTargeting {
		return nil
	}
	return append([]string(nil), t.endorsingPeers...)
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

func orderSinglePeers(channelName string, peers []peerTarget, rr *roundRobinState) []peerTarget {
	ordered := append([]peerTarget(nil), peers...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].URL() < ordered[j].URL()
	})

	keyParts := []string{channelName}
	for _, peer := range ordered {
		keyParts = append(keyParts, peer.URL())
	}
	start := rr.next(strings.Join(keyParts, "|"), len(ordered))
	return append(ordered[start:], ordered[:start]...)
}

func resolveDiscoveredSinglePeers(discovered []peerTarget) ([]peerTarget, error) {
	tlsEnabled := discoveredPeersUseTLS(discovered)
	if err := ensureUniqueDiscoveredPeerEndpoints(discovered, tlsEnabled); err != nil {
		return nil, err
	}
	if len(discovered) == 0 {
		return nil, &PeerNotFoundError{PeerName: "<discovered peers>"}
	}
	return discovered, nil
}

func resolveEndorsingPeerTargets(discovered []peerTarget, names []string) ([]peerTarget, error) {
	if len(names) == 0 {
		return nil, &ConfigurationError{
			Field:   "endorsingPeers",
			Message: "UseEndorsingPeers requires at least one peer",
		}
	}

	tlsEnabled := discoveredPeersUseTLS(discovered)
	if err := ensureUniqueDiscoveredPeerEndpoints(discovered, tlsEnabled); err != nil {
		return nil, err
	}
	canonicalNames, err := dedupePeerEndpointInputs(names, tlsEnabled)
	if err != nil {
		return nil, err
	}
	var resolved []peerTarget
	var missing []string
	for _, canonicalName := range canonicalNames {
		peer, ok := matchDiscoveredPeer(discovered, canonicalName)
		if !ok {
			missing = append(missing, canonicalName)
			continue
		}
		resolved = append(resolved, peer)
	}
	if len(missing) > 0 {
		return nil, &PeerNotFoundError{
			PeerName:       strings.Join(missing, ", "),
			AvailablePeers: peerURLs(discovered),
		}
	}
	if len(resolved) == 0 {
		return nil, &PeerNotFoundError{
			PeerName:       strings.Join(names, ", "),
			AvailablePeers: peerURLs(discovered),
		}
	}
	return resolved, nil
}

func executeSinglePeerTargets[T any](
	operation string,
	channelName string,
	chaincodeName string,
	transactionName string,
	eligible []peerTarget,
	ordered []peerTarget,
	execute func(peerTarget) (T, error),
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
		if i == len(ordered)-1 {
			return zero, singlePeerExecutionError(operation, channelName, chaincodeName, transactionName, eligible, attempts)
		}

		next := ordered[i+1]
		log.Printf("fabric_bridge.single_peer.failover event=fabric_bridge.single_peer.failover operation=%s channel=%s chaincode=%s transaction=%s failedPeer=%s nextPeer=%s attempt=%d maxAttempts=%d category=%s reason=%q",
			operation, channelName, chaincodeName, transactionName, peer.URL(), next.URL(), i+1, len(ordered), decision.Category, decision.Reason)
	}

	return zero, singlePeerExecutionError(operation, channelName, chaincodeName, transactionName, eligible, attempts)
}

func singlePeerExecutionError(operation, channelName, chaincodeName, transactionName string, eligible []peerTarget, attempts []SinglePeerAttempt) *SinglePeerExecutionError {
	return &SinglePeerExecutionError{
		Message:         fmt.Sprintf("single-peer transaction failed after trying %d eligible peer(s)", len(attempts)),
		Operation:       operation,
		Channel:         channelName,
		Chaincode:       chaincodeName,
		TransactionName: transactionName,
		EligiblePeers:   peerURLs(eligible),
		Attempts:        append([]SinglePeerAttempt(nil), attempts...),
	}
}
