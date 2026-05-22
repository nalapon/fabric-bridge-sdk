package fabricbridge

// ProposalCreator is the Fabric identity embedded in an offline proposal.
type ProposalCreator struct {
	MSPId       string
	Certificate []byte
}

func cloneProposalCreator(input ProposalCreator) ProposalCreator {
	return ProposalCreator{
		MSPId:       input.MSPId,
		Certificate: append([]byte(nil), input.Certificate...),
	}
}
