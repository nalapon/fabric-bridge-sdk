package fabricbridge

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
)

func dedupePeerEndpointInputs(inputs []string, tlsEnabled bool) ([]string, error) {
	out := make([]string, 0, len(inputs))
	seen := make(map[string]bool, len(inputs))
	for _, input := range inputs {
		canonical, err := normalizePeerEndpointIdentity(input, tlsEnabled)
		if err != nil {
			return nil, err
		}
		if seen[canonical] {
			continue
		}
		out = append(out, canonical)
		seen[canonical] = true
	}
	return out, nil
}

func matchDiscoveredPeer(peers []fab.Peer, canonicalEndpoint string) (fab.Peer, bool) {
	tlsEnabled := discoveredPeersUseTLS(peers)
	for _, peer := range peers {
		canonicalPeer, err := canonicalDiscoveredPeerEndpoint(peer, tlsEnabled)
		if err != nil {
			continue
		}
		if canonicalEndpoint == canonicalPeer {
			return peer, true
		}
	}
	return nil, false
}

func peerURLs(peers []fab.Peer) []string {
	tlsEnabled := discoveredPeersUseTLS(peers)
	out := make([]string, 0, len(peers))
	for _, peer := range peers {
		if canonical, err := canonicalDiscoveredPeerEndpoint(peer, tlsEnabled); err == nil {
			out = append(out, canonical)
			continue
		}
		out = append(out, peer.URL())
	}
	return out
}

func discoveredPeersUseTLS(peers []fab.Peer) bool {
	for _, peer := range peers {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(peer.URL())), "grpcs://") {
			return true
		}
	}
	return false
}

func canonicalDiscoveredPeerEndpoint(peer fab.Peer, tlsEnabled bool) (string, error) {
	return normalizePeerEndpointIdentity(peer.URL(), tlsEnabled)
}

func ensureUniqueDiscoveredPeerEndpoints(peers []fab.Peer, tlsEnabled bool) error {
	seen := make(map[string]bool, len(peers))
	for _, peer := range peers {
		canonical, err := canonicalDiscoveredPeerEndpoint(peer, tlsEnabled)
		if err != nil {
			return err
		}
		if seen[canonical] {
			return &DiscoveryError{Message: fmt.Sprintf("duplicate discovered peer endpoint identity: %s", canonical)}
		}
		seen[canonical] = true
	}
	return nil
}

func normalizeSnapshotPeerEndpoint(endpoint string, tlsEnabled bool) (string, error) {
	canonical, err := normalizePeerEndpointIdentity(endpoint, tlsEnabled)
	if err != nil {
		return "", &OfflineSigningError{Field: "routing.peers", Message: err.Error()}
	}
	return canonical, nil
}

func normalizePeerEndpointIdentity(raw string, tlsEnabled bool) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", &ConfigurationError{Field: "peerEndpoint", Message: "peer endpoint must be a non-empty host:port value"}
	}

	scheme := ""
	hostPort := value
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "grpc://") || strings.HasPrefix(lower, "grpcs://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || parsed.Path != "" {
			return "", &ConfigurationError{Field: "peerEndpoint", Message: fmt.Sprintf("peer endpoint must be grpc(s)://host:port: %s", raw)}
		}
		scheme = strings.ToLower(parsed.Scheme)
		hostPort = parsed.Host
	} else {
		if strings.Contains(value, "://") {
			return "", &ConfigurationError{Field: "peerEndpoint", Message: fmt.Sprintf("peer endpoint scheme must be grpc or grpcs: %s", raw)}
		}
		if tlsEnabled {
			scheme = "grpcs"
		} else {
			scheme = "grpc"
		}
	}

	host, port, err := net.SplitHostPort(hostPort)
	if err != nil || host == "" || port == "" {
		return "", &ConfigurationError{Field: "peerEndpoint", Message: fmt.Sprintf("peer endpoint must include host:port: %s", raw)}
	}

	return fmt.Sprintf("%s://%s:%s", scheme, strings.ToLower(host), port), nil
}
