/*
Copyright SecureKey Technologies Inc. All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/

package discovery

import (
	discclient "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/internal/github.com/hyperledger/fabric/discovery/client"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
)

// GetProperties extracts the properties from the discovered peer.
func GetProperties(endpoint *discclient.Peer) fab.Properties {
	if endpoint.StateInfoMessage == nil {
		return nil
	}

	stateInfo := endpoint.StateInfoMessage.GetStateInfo()
	if stateInfo == nil || stateInfo.Properties == nil {
		return nil
	}

	properties := make(fab.Properties, 3)
	properties[fab.PropertyLedgerHeight] = stateInfo.Properties.LedgerHeight
	properties[fab.PropertyChaincodes] = stateInfo.Properties.Chaincodes
	properties[fab.PropertyLeftChannel] = stateInfo.Properties.LeftChannel

	return properties
}
