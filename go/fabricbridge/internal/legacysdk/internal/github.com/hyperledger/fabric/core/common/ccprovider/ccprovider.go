/*
Copyright IBM Corp. All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/
/*
Notice: This file has been modified for Hyperledger Fabric SDK Go usage.
Please review third_party pinning scripts and patches for more details.
*/

package ccprovider

import (
	"fmt"

	pb "github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// CCPackage encapsulates a chaincode package which can be
//
//	raw ChaincodeDeploymentSpec
//	SignedChaincodeDeploymentSpec
//
// Attempt to keep the interface at a level with minimal
// interface for possible generalization.
type CCPackage interface {
	//InitFromBuffer initialize the package from bytes
	InitFromBuffer(buf []byte) (*ChaincodeData, error)

	// PutChaincodeToFS writes the chaincode to the filesystem
	PutChaincodeToFS() error

	// GetDepSpec gets the ChaincodeDeploymentSpec from the package
	GetDepSpec() *pb.ChaincodeDeploymentSpec

	// GetDepSpecBytes gets the serialized ChaincodeDeploymentSpec from the package
	GetDepSpecBytes() []byte

	// ValidateCC validates and returns the chaincode deployment spec corresponding to
	// ChaincodeData. The validation is based on the metadata from ChaincodeData
	// One use of this method is to validate the chaincode before launching
	ValidateCC(ccdata *ChaincodeData) error

	// GetPackageObject gets the object as a proto.Message
	GetPackageObject() proto.Message

	// GetChaincodeData gets the ChaincodeData
	GetChaincodeData() *ChaincodeData

	// GetId gets the fingerprint of the chaincode based on package computation
	GetId() []byte
}

//-------- ChaincodeData is stored on the LSCC -------

// ChaincodeData defines the datastructure for chaincodes to be serialized by proto
// Type provides an additional check by directing to use a specific package after instantiation
// Data is Type specific (see CDSPackage and SignedCDSPackage)
type ChaincodeData struct {
	// Name of the chaincode
	Name string `protobuf:"bytes,1,opt,name=name"`

	// Version of the chaincode
	Version string `protobuf:"bytes,2,opt,name=version"`

	// Escc for the chaincode instance
	Escc string `protobuf:"bytes,3,opt,name=escc"`

	// Vscc for the chaincode instance
	Vscc string `protobuf:"bytes,4,opt,name=vscc"`

	// Policy endorsement policy for the chaincode instance
	Policy []byte `protobuf:"bytes,5,opt,name=policy,proto3"`

	// Data data specific to the package
	Data []byte `protobuf:"bytes,6,opt,name=data,proto3"`

	// Id of the chaincode that's the unique fingerprint for the CC This is not
	// currently used anywhere but serves as a good eyecatcher
	Id []byte `protobuf:"bytes,7,opt,name=id,proto3"`

	// InstantiationPolicy for the chaincode
	InstantiationPolicy []byte `protobuf:"bytes,8,opt,name=instantiation_policy,proto3"`
}

// implement functions needed from proto.Message for proto's mar/unmarshal functions

// Reset resets
func (cd *ChaincodeData) Reset() { *cd = ChaincodeData{} }

// String converts to string
func (cd *ChaincodeData) String() string {
	return fmt.Sprintf("%+v", *cd)
}

// ProtoMessage just exists to make proto happy
func (*ChaincodeData) ProtoMessage() {}

// ProtoReflect is a no-op to satisfy google.golang.org/protobuf/proto.Message.
// ChaincodeData uses manual proto parsing via UnmarshalChaincodeData.
func (*ChaincodeData) ProtoReflect() protoreflect.Message { return nil }

// UnmarshalChaincodeData parses proto-encoded bytes into a ChaincodeData.
// Field numbers: 1=name, 2=version, 3=escc, 4=vscc,
// 5=policy, 6=data, 7=id, 8=instantiation_policy (all bytes/string).
func UnmarshalChaincodeData(b []byte) (*ChaincodeData, error) {
	cd := &ChaincodeData{}
	for len(b) > 0 {
		num, wtyp, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, fmt.Errorf("invalid proto tag")
		}
		b = b[n:]
		if wtyp != protowire.BytesType {
			_, n = protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, fmt.Errorf("invalid varint")
			}
			b = b[n:]
			continue
		}
		val, n := protowire.ConsumeBytes(b)
		if n < 0 {
			return nil, fmt.Errorf("invalid length-delimited field")
		}
		b = b[n:]
		switch num {
		case 1:
			cd.Name = string(val)
		case 2:
			cd.Version = string(val)
		case 3:
			cd.Escc = string(val)
		case 4:
			cd.Vscc = string(val)
		case 5:
			cd.Policy = val
		case 6:
			cd.Data = val
		case 7:
			cd.Id = val
		case 8:
			cd.InstantiationPolicy = val
		}
	}
	return cd, nil
}
