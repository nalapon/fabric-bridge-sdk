import * as fabricCommon from 'fabric-common';
import type { BridgeConfig } from './types/config';
import type { ProposalCreator } from './types/bridge';

const fabricCommonRuntime = fabricCommon as any;

type FabricUser = any;
type FabricIdentityContext = any;

export function createProposalIdentityContext(
  baseIdentityContext: FabricIdentityContext,
  proposalCreator: ProposalCreator,
): FabricIdentityContext {
  const user = createIdentityOnlyUser('proposal creator', proposalCreator.mspId, proposalCreator.credentials);
  return baseIdentityContext.client.newIdentityContext(user).calculateTransactionId();
}

export function createBridgeIdentityProvider(config: BridgeConfig): any {
  return {
    type: 'bridge-x509',
    getCryptoSuite() {
      return fabricCommonRuntime.User.newCryptoSuite();
    },
    fromJson(data: unknown) {
      return data;
    },
    toJson(identity: unknown) {
      return identity;
    },
    async getUserContext(_identity: unknown, name: string): Promise<FabricUser> {
      return createSigningUser(name, config.identity.mspId, config.identity.credentials, config);
    },
  };
}

function createIdentityOnlyUser(name: string, mspId: string, certificate: Buffer): FabricUser {
  const cryptoSuite = fabricCommonRuntime.User.newCryptoSuite();
  const user = new fabricCommonRuntime.User(name);
  user.setCryptoSuite(cryptoSuite);
  user._mspId = mspId;
  user._identity = new fabricCommonRuntime.Identity(certificate.toString(), undefined, mspId, cryptoSuite);
  user._signingIdentity = undefined;
  return user;
}

async function createSigningUser(
  name: string,
  mspId: string,
  certificate: Buffer,
  config: BridgeConfig,
): Promise<FabricUser> {
  const cryptoSuite = fabricCommonRuntime.User.newCryptoSuite();
  const user = new fabricCommonRuntime.User(name);
  user.setCryptoSuite(cryptoSuite);

  const publicKey = await cryptoSuite.createKeyFromRaw(certificate.toString());
  const signer = {
    sign: (digest: Uint8Array) => {
      const signature = config.signer(digest);
      if (signature instanceof Promise) {
        throw new Error(
          'BridgeConfig.signer must return synchronously when used with fabric-network peer mode. ' +
          'Use createSyncPrivateKeySigner() for private-key bridge identities.',
        );
      }
      return Buffer.from(signature);
    },
  };

  user._mspId = mspId;
  user.setSigningIdentity(new fabricCommonRuntime.SigningIdentity(
    certificate.toString(),
    publicKey,
    mspId,
    cryptoSuite,
    signer,
  ));
  return user;
}
