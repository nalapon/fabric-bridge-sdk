/*
Copyright SecureKey Technologies Inc. All Rights Reserved.

SPDX-License-Identifier: Apache-2.0
*/

package defcore

import (
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/logging"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/core"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/common/providers/fab"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/core/logging/api"

	cryptosuiteimpl "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/core/cryptosuite/bccsp/sw"
	signingMgr "github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fab/signingmgr"
	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/fabsdk/provider/fabpvdr"

	"github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/pkg/core/logging/modlog"
)

var logger = logging.NewLogger("fabsdk")

// ProviderFactory represents the default SDK provider factory.
type ProviderFactory struct {
}

// NewProviderFactory returns the default SDK provider factory.
func NewProviderFactory() *ProviderFactory {
	f := ProviderFactory{}
	return &f
}

// CreateCryptoSuiteProvider returns a new default implementation of BCCSP
func (f *ProviderFactory) CreateCryptoSuiteProvider(config core.CryptoSuiteConfig) (core.CryptoSuite, error) {
	if config.SecurityProvider() != "sw" {
		logger.Warnf("default provider factory doesn't support '%s' crypto provider", config.SecurityProvider())
	}
	cryptoSuiteProvider, err := cryptosuiteimpl.GetSuiteByConfig(config)
	return cryptoSuiteProvider, err
}

// CreateSigningManager returns a new default implementation of signing manager
func (f *ProviderFactory) CreateSigningManager(cryptoProvider core.CryptoSuite) (core.SigningManager, error) {
	return signingMgr.New(cryptoProvider)
}

// CreateInfraProvider returns a new default implementation of fabric primitives
func (f *ProviderFactory) CreateInfraProvider(config fab.EndpointConfig) (fab.InfraProvider, error) {
	return fabpvdr.New(config), nil
}

// NewLoggerProvider returns a new default implementation of a logger backend
// This function is separated from the factory to allow logger creation first.
func NewLoggerProvider() api.LoggerProvider {
	return modlog.LoggerProvider()
}
