package fabricbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"sync"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

func (t *Transaction) endorseExplicitPeerTargets(ctx context.Context, args []string, targets []peerTarget) (*peerProto.Proposal, string, []*proposalResponse, error) {
	proposal, txID, err := t.buildOnlinePeerProposal(args)
	if err != nil {
		return nil, "", nil, err
	}
	responses, err := endorseExplicitPeerTargets(ctx, proposal, t.contract.network.bridge.config.Signer, targets)
	if err != nil {
		return nil, "", nil, err
	}
	return proposal, txID, responses, nil
}

func (t *Transaction) buildOnlinePeerProposal(args []string) (*peerProto.Proposal, string, error) {
	cfg := t.contract.network.bridge.config
	previous := t.proposalCreator
	t.proposalCreator = &ProposalCreator{
		MSPId:       cfg.Identity.MSPId,
		Certificate: append([]byte(nil), cfg.Identity.Certificate...),
	}
	defer func() {
		t.proposalCreator = previous
	}()
	return t.buildPeerProposal(args)
}

func endorseExplicitPeerTargets(ctx context.Context, proposal *peerProto.Proposal, signer Signer, targets []peerTarget) ([]*proposalResponse, error) {
	if len(targets) == 0 {
		return nil, &EndorsementError{Message: "explicit endorsement requires at least one peer"}
	}

	request, err := signedProposalRequest(proposal, signer)
	if err != nil {
		return nil, &EndorsementError{Message: err.Error()}
	}
	return endorseExplicitPeerRequest(ctx, request, targets)
}

func endorseExplicitPeerRequest(ctx context.Context, request processProposalRequest, targets []peerTarget) ([]*proposalResponse, error) {
	responses := make([]*proposalResponse, len(targets))
	errs := make([]error, len(targets))
	var wg sync.WaitGroup
	wg.Add(len(targets))
	for i, target := range targets {
		i, target := i, target
		go func() {
			defer wg.Done()
			response, err := endorsePeerTarget(ctx, request, target)
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

func signedProposalRequest(proposal *peerProto.Proposal, signer Signer) (processProposalRequest, error) {
	proposalBytes, err := proto.Marshal(proposal)
	if err != nil {
		return processProposalRequest{}, fmt.Errorf("marshal proposal: %v", err)
	}
	digest := sha256.Sum256(proposalBytes)
	signature, err := signer.Sign(digest[:])
	if err != nil {
		return processProposalRequest{}, fmt.Errorf("sign proposal: %v", err)
	}
	return processProposalRequest{
		SignedProposal: &peerProto.SignedProposal{
			ProposalBytes: proposalBytes,
			Signature:     signature,
		},
	}, nil
}

func endorsePeerTarget(ctx context.Context, request processProposalRequest, target peerTarget) (*proposalResponse, error) {
	return target.ProcessTransactionProposal(ctx, request)
}

func validatePeerProposalResponses(responses []*proposalResponse) error {
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

func validatePeerProposalResponse(response *proposalResponse) error {
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
