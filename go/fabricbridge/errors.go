package fabricbridge

import (
	"errors"
	"fmt"
)

// Sentinel errors
var (
	ErrNotConnected    = errors.New("bridge not connected")
	ErrPeerNotFound    = errors.New("peer not found in discovery")
	ErrDiscoveryFailed = errors.New("discovery failed")
	ErrTimeout         = errors.New("operation timeout")
)

// ConfigurationError is returned when config is invalid
type ConfigurationError struct {
	Field   string
	Message string
}

func (e *ConfigurationError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("configuration error in %s: %s", e.Field, e.Message)
	}
	return fmt.Sprintf("configuration error: %s", e.Message)
}

// ConnectionError is returned when connection fails
type ConnectionError struct {
	Message string
	Cause   error
}

func (e *ConnectionError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("connection error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("connection error: %s", e.Message)
}

func (e *ConnectionError) Unwrap() error {
	return e.Cause
}

// EndorsementError is returned when transaction endorsement fails
type EndorsementError struct {
	Message string
	Details []error
}

func (e *EndorsementError) Error() string {
	if len(e.Details) > 0 {
		return fmt.Sprintf("endorsement failed: %s (details: %v)", e.Message, e.Details)
	}
	return fmt.Sprintf("endorsement failed: %s", e.Message)
}

// SubmitError is returned when transaction submission fails
type SubmitError struct {
	Message       string
	TransactionID string
}

func (e *SubmitError) Error() string {
	if e.TransactionID != "" {
		return fmt.Sprintf("submit failed (tx %s): %s", e.TransactionID, e.Message)
	}
	return fmt.Sprintf("submit failed: %s", e.Message)
}

// CommitError is returned when commit status retrieval fails
type CommitError struct {
	Message       string
	TransactionID string
	Status        string
}

func (e *CommitError) Error() string {
	if e.TransactionID != "" {
		return fmt.Sprintf("commit status failed (tx %s): %s (status: %s)", e.TransactionID, e.Message, e.Status)
	}
	return fmt.Sprintf("commit status failed: %s", e.Message)
}

// EvaluationError is returned when query evaluation fails
type EvaluationError struct {
	Message string
}

func (e *EvaluationError) Error() string {
	return fmt.Sprintf("evaluation failed: %s", e.Message)
}

// DiscoveryError is returned when discovery fails
type DiscoveryError struct {
	Message string
	Cause   error
}

func (e *DiscoveryError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("discovery failed: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("discovery failed: %s", e.Message)
}

func (e *DiscoveryError) Unwrap() error {
	return e.Cause
}

// PeerNotFoundError is returned when a specific peer cannot be found
type PeerNotFoundError struct {
	PeerName       string
	AvailablePeers []string
}

func (e *PeerNotFoundError) Error() string {
	if len(e.AvailablePeers) > 0 {
		return fmt.Sprintf("peer %s not found, available peers: %v", e.PeerName, e.AvailablePeers)
	}
	return fmt.Sprintf("peer %s not found", e.PeerName)
}

// TimeoutError is returned when an operation times out
type TimeoutError struct {
	Operation string
	Timeout   string
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("%s timeout after %s", e.Operation, e.Timeout)
}

// NotConnectedError is returned when trying to use a disconnected bridge
type NotConnectedError struct {
	Component string
	Action    string
}

func (e *NotConnectedError) Error() string {
	return fmt.Sprintf("%s not connected: cannot %s", e.Component, e.Action)
}
