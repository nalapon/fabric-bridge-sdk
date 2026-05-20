import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  external: [
    '@grpc/grpc-js',
    '@hyperledger/fabric-gateway',
    '@hyperledger/fabric-protos',
    'better-result',
    'fabric-common',
    'fabric-network',
    'fabric-protos',
    'google-protobuf',
    'long',
    'protobufjs',
  ],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  platform: 'node',
});
