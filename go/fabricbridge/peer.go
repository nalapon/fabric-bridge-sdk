package fabricbridge

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	peerProto "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	peerPropertyLedgerHeight = "ledgerheight"
	peerPropertyLeftChannel  = "leftchannel"
	peerPropertyChaincodes   = "chaincodes"
)

type peerProperties map[string]interface{}

type peerTarget interface {
	MSPID() string
	URL() string
	Properties() peerProperties
	ProcessTransactionProposal(context.Context, processProposalRequest) (*proposalResponse, error)
}

type processProposalRequest struct {
	SignedProposal *peerProto.SignedProposal
}

type proposalResponse struct {
	Endorser         string
	Status           int32
	ChaincodeStatus  int32
	ProposalResponse *peerProto.ProposalResponse
}

type peerRuntime interface {
	Close()
	DiscoverPeers(channelName string) ([]peerTarget, error)
	QueryTargets(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peers []peerTarget, transientData map[string][]byte) ([]byte, error)
}

var newPeerRuntime = func(cfg Config, channelName string) (peerRuntime, error) {
	return newDirectPeerRuntime(cfg, channelName), nil
}

type directPeerRuntime struct {
	config Config
}

func newDirectPeerRuntime(cfg Config, _ string) *directPeerRuntime {
	return &directPeerRuntime{config: cfg.normalized()}
}

func (p *directPeerRuntime) Close() {}

func (p *directPeerRuntime) DiscoverPeers(channelName string) ([]peerTarget, error) {
	return newDirectDiscoveryClient(p.config).DiscoverPeers(context.Background(), channelName)
}

func (p *directPeerRuntime) QueryTargets(ctx context.Context, channelName string, chaincodeID string, fn string, args [][]byte, peers []peerTarget, transientData map[string][]byte) ([]byte, error) {
	if len(peers) == 0 {
		return nil, fmt.Errorf("query requires at least one peer")
	}
	proposal, err := newBridgePeerProposal(p.config, channelName, chaincodeID, fn, args, transientData)
	if err != nil {
		return nil, err
	}
	request, err := signedProposalRequest(proposal, p.config.Signer)
	if err != nil {
		return nil, err
	}
	response, err := endorsePeerTarget(ctx, request, peers[0])
	if err != nil {
		return nil, err
	}
	if err := validatePeerProposalResponses([]*proposalResponse{response}); err != nil {
		return nil, err
	}
	return proposalResultPayload([]*proposalResponse{response})
}

func newBridgePeerProposal(cfg Config, channelName string, chaincodeID string, fn string, args [][]byte, transientData map[string][]byte) (*peerProto.Proposal, error) {
	cfg = cfg.normalized()
	creator, err := proto.Marshal(&msp.SerializedIdentity{
		Mspid:   cfg.Identity.MSPId,
		IdBytes: cfg.Identity.Certificate,
	})
	if err != nil {
		return nil, fmt.Errorf("serialize identity: %w", err)
	}

	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("create nonce: %w", err)
	}
	txIDHash := sha256.Sum256(append(append([]byte(nil), nonce...), creator...))
	txID := hex.EncodeToString(txIDHash[:])

	byteArgs := make([][]byte, 0, len(args)+1)
	byteArgs = append(byteArgs, []byte(fn))
	byteArgs = append(byteArgs, args...)
	ccis := &peerProto.ChaincodeInvocationSpec{ChaincodeSpec: &peerProto.ChaincodeSpec{
		Type: peerProto.ChaincodeSpec_GOLANG,
		ChaincodeId: &peerProto.ChaincodeID{
			Name: chaincodeID,
		},
		Input: &peerProto.ChaincodeInput{Args: byteArgs},
	}}
	return createDirectProposal(txID, channelName, chaincodeID, ccis, nonce, creator, copyTransientData(transientData))
}

func createDirectProposal(txID string, channelName string, chaincodeName string, ccis *peerProto.ChaincodeInvocationSpec, nonce []byte, creator []byte, transientData map[string][]byte) (*peerProto.Proposal, error) {
	invocationBytes, err := proto.Marshal(ccis)
	if err != nil {
		return nil, err
	}
	payloadBytes, err := proto.Marshal(&peerProto.ChaincodeProposalPayload{
		Input:        invocationBytes,
		TransientMap: transientData,
	})
	if err != nil {
		return nil, err
	}
	headerExtensionBytes, err := proto.Marshal(&peerProto.ChaincodeHeaderExtension{ChaincodeId: &peerProto.ChaincodeID{Name: chaincodeName}})
	if err != nil {
		return nil, err
	}
	channelHeaderBytes, err := proto.Marshal(&common.ChannelHeader{
		Type:      int32(common.HeaderType_ENDORSER_TRANSACTION),
		ChannelId: channelName,
		TxId:      txID,
		Timestamp: timestamppb.Now(),
		Extension: headerExtensionBytes,
	})
	if err != nil {
		return nil, err
	}
	signatureHeaderBytes, err := proto.Marshal(&common.SignatureHeader{Creator: creator, Nonce: nonce})
	if err != nil {
		return nil, err
	}
	headerBytes, err := proto.Marshal(&common.Header{ChannelHeader: channelHeaderBytes, SignatureHeader: signatureHeaderBytes})
	if err != nil {
		return nil, err
	}
	return &peerProto.Proposal{Header: headerBytes, Payload: payloadBytes}, nil
}
