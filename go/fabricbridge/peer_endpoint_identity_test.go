package fabricbridge

import (
	"errors"
	"testing"
)

func TestNormalizePeerEndpointIdentityAcceptsHostPortAndSchemes(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		tlsEnabled bool
		want       string
	}{
		{
			name:       "plain endpoint infers grpc without TLS",
			raw:        "Peer0.Org1.Example.com:7051",
			tlsEnabled: false,
			want:       "grpc://peer0.org1.example.com:7051",
		},
		{
			name:       "plain endpoint infers grpcs with TLS",
			raw:        "Peer0.Org1.Example.com:7051",
			tlsEnabled: true,
			want:       "grpcs://peer0.org1.example.com:7051",
		},
		{
			name:       "explicit grpc is preserved under TLS",
			raw:        "grpc://Peer0.Org1.Example.com:7051",
			tlsEnabled: true,
			want:       "grpc://peer0.org1.example.com:7051",
		},
		{
			name:       "explicit grpcs is preserved without TLS",
			raw:        "grpcs://Peer0.Org1.Example.com:7051",
			tlsEnabled: false,
			want:       "grpcs://peer0.org1.example.com:7051",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizePeerEndpointIdentity(tt.raw, tt.tlsEnabled)
			if err != nil {
				t.Fatalf("expected canonical endpoint, got %v", err)
			}
			if got != tt.want {
				t.Fatalf("canonical endpoint mismatch: got %q want %q", got, tt.want)
			}
		})
	}
}

func TestNormalizePeerEndpointIdentityRequiresHostPort(t *testing.T) {
	tests := []string{"peer0.org1.example.com", "https://peer0.org1.example.com:7051", ""}
	for _, raw := range tests {
		t.Run(raw, func(t *testing.T) {
			_, err := normalizePeerEndpointIdentity(raw, true)
			var configErr *ConfigurationError
			if !errors.As(err, &configErr) {
				t.Fatalf("expected ConfigurationError, got %T: %v", err, err)
			}
			if configErr.Field != "peerEndpoint" {
				t.Fatalf("expected peerEndpoint field, got %q", configErr.Field)
			}
		})
	}
}

func TestDedupePeerEndpointInputsPreservesFirstOrder(t *testing.T) {
	got, err := dedupePeerEndpointInputs([]string{
		"Peer1.Org1.Example.com:8051",
		"peer0.org1.example.com:7051",
		"grpcs://peer1.org1.example.com:8051",
		"grpcs://peer0.org1.example.com:7051",
	}, true)
	if err != nil {
		t.Fatalf("expected canonical endpoints, got %v", err)
	}
	want := []string{
		"grpcs://peer1.org1.example.com:8051",
		"grpcs://peer0.org1.example.com:7051",
	}
	if !equalStrings(got, want) {
		t.Fatalf("canonical endpoints mismatch: got %v want %v", got, want)
	}
}

func TestEnsureUniqueDiscoveredPeerEndpointsRejectsDuplicates(t *testing.T) {
	peers := []peerTarget{
		fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"},
		fakeSinglePeer{url: "peer0.org1.example.com:7051"},
	}

	err := ensureUniqueDiscoveredPeerEndpoints(peers, true)
	var discoveryErr *DiscoveryError
	if !errors.As(err, &discoveryErr) {
		t.Fatalf("expected DiscoveryError, got %T: %v", err, err)
	}
}

func TestNormalizeSnapshotPeerEndpointWrapsMalformedEndpoint(t *testing.T) {
	_, err := normalizeSnapshotPeerEndpoint("peer0.org1.example.com", true)
	var offlineErr *OfflineSigningError
	if !errors.As(err, &offlineErr) {
		t.Fatalf("expected OfflineSigningError, got %T: %v", err, err)
	}
	if offlineErr.Field != "routing.peers" {
		t.Fatalf("expected routing.peers field, got %q", offlineErr.Field)
	}
}

func TestResolveEndorsingPeerTargetsReportsMissingAsPeerNotFound(t *testing.T) {
	peers := []peerTarget{fakeSinglePeer{url: "grpcs://peer0.org1.example.com:7051"}}

	_, err := resolveEndorsingPeerTargets(peers, []string{"peer1.org1.example.com:8051"})
	var notFound *PeerNotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected PeerNotFoundError, got %T: %v", err, err)
	}
	if notFound.PeerName != "grpcs://peer1.org1.example.com:8051" {
		t.Fatalf("missing peer mismatch: got %q", notFound.PeerName)
	}
}
