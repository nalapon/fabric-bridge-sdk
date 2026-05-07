package fabricbridge

import (
	"context"
	"errors"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// FailoverCategory describes why a failed single-peer attempt may or may not fail over.
type FailoverCategory string

const (
	FailoverTimeout         FailoverCategory = "timeout"
	FailoverPeerUnavailable FailoverCategory = "peer-unavailable"
	FailoverTransport       FailoverCategory = "transport"
	FailoverNonRetryable    FailoverCategory = "non-retryable"
	FailoverUnknown         FailoverCategory = "unknown"
)

// FailoverDecision is the classification result used by single-peer failover.
type FailoverDecision struct {
	Eligible bool
	Category FailoverCategory
	Reason   string
}

func classifyFailover(err error) FailoverDecision {
	if err == nil {
		return FailoverDecision{Eligible: false, Category: FailoverUnknown, Reason: "nil error"}
	}

	if isKnownNonRetryable(err) {
		return FailoverDecision{Eligible: false, Category: FailoverNonRetryable, Reason: err.Error()}
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return FailoverDecision{Eligible: true, Category: FailoverTimeout, Reason: "context deadline exceeded"}
	}

	if st, ok := status.FromError(err); ok {
		switch st.Code() {
		case codes.DeadlineExceeded:
			return FailoverDecision{Eligible: true, Category: FailoverTimeout, Reason: "gRPC deadline exceeded"}
		case codes.Unavailable:
			return FailoverDecision{Eligible: true, Category: FailoverPeerUnavailable, Reason: "gRPC unavailable"}
		}
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "deadline exceeded") ||
		strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "timed out"):
		return FailoverDecision{Eligible: true, Category: FailoverTimeout, Reason: err.Error()}
	case strings.Contains(msg, "unavailable") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "no route to host"):
		return FailoverDecision{Eligible: true, Category: FailoverPeerUnavailable, Reason: err.Error()}
	case strings.Contains(msg, "transport") ||
		strings.Contains(msg, "socket closed") ||
		strings.Contains(msg, "tls") ||
		strings.Contains(msg, "http2"):
		return FailoverDecision{Eligible: true, Category: FailoverTransport, Reason: err.Error()}
	default:
		return FailoverDecision{Eligible: false, Category: FailoverUnknown, Reason: err.Error()}
	}
}

func isKnownNonRetryable(err error) bool {
	var endorsementErr *EndorsementError
	var submitErr *SubmitError
	var commitErr *CommitError
	var evaluationErr *EvaluationError
	var peerNotFoundErr *PeerNotFoundError
	var discoveryErr *DiscoveryError
	var singlePeerExecutionErr *SinglePeerExecutionError

	return errors.As(err, &endorsementErr) ||
		errors.As(err, &submitErr) ||
		errors.As(err, &commitErr) ||
		errors.As(err, &evaluationErr) ||
		errors.As(err, &peerNotFoundErr) ||
		errors.As(err, &discoveryErr) ||
		errors.As(err, &singlePeerExecutionErr)
}
