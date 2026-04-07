/*
Copyright SecureKey Technologies Inc. All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/

package fabsdk

import (
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/core/logging/api"
	sdkApi "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fabsdk/api"
)

// pkgSuite provides the package factories that create clients and providers
type pkgSuite interface {
	Core() (sdkApi.CoreProviderFactory, error)
	MSP() (sdkApi.MSPProviderFactory, error)
	Service() (sdkApi.ServiceProviderFactory, error)
	Logger() (api.LoggerProvider, error)
}
