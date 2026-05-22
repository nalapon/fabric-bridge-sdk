package fabricbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"sync"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	legacyfab "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"google.golang.org/protobuf/proto"
)

func (t *Transaction) endorseExplicitPeerTargets(ctx context.Context, args []string, targets []legacyfab.Peer) (*peerProto.Proposal, []*legacyfab.TransactionProposalResponse, error) {
	proposal, err := t.buildOnlinePeerProposal(args)
	if err != nil {
		return nil, nil, err
	}
	responses, err := endorseExplicitPeerTargets(ctx, proposal, t.contract.network.bridge.config.Signer, targets)
	if err != nil {
		return nil, nil, err
	}
	return proposal, responses, nil
}

func (t *Transaction) buildOnlinePeerProposal(args []string) (*peerProto.Proposal, error) {
	cfg := t.contract.network.bridge.config
	previous := t.proposalCreator
	t.proposalCreator = &ProposalCreator{
		MSPId:       cfg.Identity.MSPId,
		Certificate: append([]byte(nil), cfg.Identity.Certificate...),
	}
	defer func() {
		t.proposalCreator = previous
	}()
	proposal, _, err := t.buildPeerProposal(args)
	return proposal, err
}

func endorseExplicitPeerTargets(ctx context.Context, proposal *peerProto.Proposal, signer Signer, targets []legacyfab.Peer) ([]*legacyfab.TransactionProposalResponse, error) {
	if len(targets) == 0 {
		return nil, &EndorsementError{Message: "explicit endorsement requires at least one peer"}
	}

	proposalBytes, err := proto.Marshal(proposal)
	if err != nil {
		return nil, &EndorsementError{Message: fmt.Sprintf("marshal proposal: %v", err)}
	}
	digest := sha256.Sum256(proposalBytes)
	signature, err := signer.Sign(digest[:])
	if err != nil {
		return nil, &EndorsementError{Message: fmt.Sprintf("sign proposal: %v", err)}
	}
	request := legacyfab.ProcessProposalRequest{
		SignedProposal: &peerProto.SignedProposal{
			ProposalBytes: proposalBytes,
			Signature:     signature,
		},
	}

	responses := make([]*legacyfab.TransactionProposalResponse, len(targets))
	errs := make([]error, len(targets))
	var wg sync.WaitGroup
	wg.Add(len(targets))
	for i, target := range targets {
		i, target := i, target
		go func() {
			defer wg.Done()
			response, err := target.ProcessTransactionProposal(ctx, request)
			if err != nil {
				errs[i] = fmt.Errorf("%s: %w", target.URL(), err)
				return
			}
			responses[i] = response
		}()
	}
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			return nil, &EndorsementError{Message: err.Error()}
		}
	}
	if err := validatePeerProposalResponses(responses); err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	return responses, nil
}

func validatePeerProposalResponses(responses []*legacyfab.TransactionProposalResponse) error {
	if len(responses) == 0 {
		return fmt.Errorf("at least one proposal response is required")
	}
	first := responses[0]
	if err := validatePeerProposalResponse(first); err != nil {
		return err
	}
	firstPayload := first.ProposalResponse.GetPayload()
	for _, response := range responses[1:] {
		if err := validatePeerProposalResponse(response); err != nil {
			return err
		}
		if !bytes.Equal(firstPayload, response.ProposalResponse.GetPayload()) {
			return fmt.Errorf("proposal response payloads do not match")
		}
	}
	return nil
}

func validatePeerProposalResponse(response *legacyfab.TransactionProposalResponse) error {
	if response == nil || response.ProposalResponse == nil {
		return fmt.Errorf("proposal response is empty")
	}
	status := response.ProposalResponse.GetResponse().GetStatus()
	if status < int32(common.Status_SUCCESS) || status >= int32(common.Status_BAD_REQUEST) {
		return fmt.Errorf("proposal response was not successful, status %d: %s", status, response.ProposalResponse.GetResponse().GetMessage())
	}
	if response.ProposalResponse.GetEndorsement() == nil {
		return fmt.Errorf("proposal response from %s has no endorsement", response.Endorser)
	}
	return nil
}
