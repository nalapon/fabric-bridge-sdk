package fabricbridge

import (
	"crypto/sha256"

	pbMsp "github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/core"
	legacyMsp "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/msp"
	"google.golang.org/protobuf/proto"
)

// ProposalCreator is the Fabric identity embedded in an offline proposal.
type ProposalCreator struct {
	MSPId       string
	Certificate []byte
}

type bridgeSigningIdentity struct {
	id          string
	mspID       string
	certificate []byte
	signer      Signer
}

func newBridgeSigningIdentity(cfg Config) *bridgeSigningIdentity {
	return &bridgeSigningIdentity{
		id:          "BridgeUser",
		mspID:       cfg.Identity.MSPId,
		certificate: append([]byte(nil), cfg.Identity.Certificate...),
		signer:      cfg.Signer,
	}
}

func (i *bridgeSigningIdentity) Identifier() *legacyMsp.IdentityIdentifier {
	return &legacyMsp.IdentityIdentifier{MSPID: i.mspID, ID: i.id}
}

func (i *bridgeSigningIdentity) Verify(_ []byte, _ []byte) error {
	return nil
}

func (i *bridgeSigningIdentity) Serialize() ([]byte, error) {
	return proto.Marshal(&pbMsp.SerializedIdentity{
		Mspid:   i.mspID,
		IdBytes: i.certificate,
	})
}

func (i *bridgeSigningIdentity) EnrollmentCertificate() []byte {
	return append([]byte(nil), i.certificate...)
}

func (i *bridgeSigningIdentity) Sign(message []byte) ([]byte, error) {
	digest := sha256.Sum256(message)
	return i.signer.Sign(digest[:])
}

func (i *bridgeSigningIdentity) PublicVersion() legacyMsp.Identity {
	return i
}

func (i *bridgeSigningIdentity) PrivateKey() core.Key {
	return signerKey{signer: i.signer}
}

type signerKey struct {
	signer Signer
}

func (k signerKey) Bytes() ([]byte, error) {
	return nil, nil
}

func (k signerKey) SKI() []byte {
	return nil
}

func (k signerKey) Symmetric() bool {
	return false
}

func (k signerKey) Private() bool {
	return true
}

func (k signerKey) PublicKey() (core.Key, error) {
	return nil, nil
}

func (k signerKey) SignDigest(digest []byte) ([]byte, error) {
	return k.signer.Sign(digest)
}

func cloneProposalCreator(input ProposalCreator) ProposalCreator {
	return ProposalCreator{
		MSPId:       input.MSPId,
		Certificate: append([]byte(nil), input.Certificate...),
	}
}
