// +build testing

/*
Copyright SecureKey Technologies Inc. All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/

package dynamicdiscovery

import (
	contextAPI "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/context"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fab/discovery"
)

// SetClientProvider overrides the discovery client provider for unit tests
func SetClientProvider(provider func(ctx contextAPI.Client) (discovery.Client, error)) {
	clientProvider = provider
}
