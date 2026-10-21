export {
  ensureRuntimeRoot,
  gatewaySocketPath,
  omochiRuntimeRoot,
  runtimeRootExists,
} from './runtime-dir.js'
export {
  parseServiceManifest,
  readServiceManifest,
  type ServiceManifest,
} from './app/manifest.js'
export type {
  DiscoveredService,
  DiscoveryProvider,
  DiscoverySink,
  ServiceEndpoint,
} from './app/provider.js'
export {
  createUnixConnector,
  type ServiceConnection,
  type ServiceConnector,
  type ServiceHandlers,
} from './app/unix-connector.js'
export {
  createXdgManifestProvider,
  type XdgManifestProviderOptions,
} from './app/xdg-manifest.js'
export {
  startGateway,
  type GatewayHandle,
  type GatewayOptions,
} from './gateway/server.js'
export {
  GATEWAY_A2UI_PATH,
  GATEWAY_CONTROL_PATH,
  GATEWAY_NODE_PATH,
  GATEWAY_PROTOCOL,
  GATEWAY_SERVICES_PATH,
  gatewayEndpointKey,
  gatewayRequestOptions,
  gatewayWsUrl,
  parseGatewayControlFrame,
  parseGatewayNodeInfo,
  parseHubControlFrame,
  randomNodeId,
  type GatewayControlFrame,
  type GatewayEndpoint,
  type GatewayNodeInfo,
  type GatewayServicesBody,
  type HubControlFrame,
} from './gateway/protocol.js'
export {
  connectGateway,
  probeGateway,
  type GatewayClient,
  type GatewayConnectOptions,
  type GatewayHandlers,
} from './gateway/client.js'
export {
  createLocalLocator,
  createStaticLocator,
  parseGatewayTarget,
  type GatewayCandidate,
  type ParsedGatewayTarget,
  type GatewayLocator,
  type GatewayLocatorSink,
} from './gateway/locator.js'
export {
  ensureConfigRoot,
  omochiConfigRoot,
} from './auth/config-dir.js'
export {
  identityPath,
  loadNodeIdentity,
  type LoadIdentityOptions,
  type NodeIdentity,
} from './auth/identity.js'
export {
  openTrustStore,
  trustStorePath,
  type TrustStore,
  type TrustedPeer,
} from './auth/trust-store.js'
export { TLS_MIN_VERSION, mtlsClientOptions, mtlsServerOptions, authenticatedPeer } from './auth/tls.js'
export { certificateFingerprint, validateCertificate, createDeviceCredentials } from './auth/certificate.js'
export {
  PAIRING_HELLO_PATH, PAIRING_START_PATH, PAIRING_FINISH_PATH,
  formatPairingCode, generatePairingCode, normalizePairingCode, openPairingWindow,
  pairWithGateway, pairingContext, type PairingHello, type PairingStart, type PairingOffer,
  type PairingWindow, type PairingWindowOptions,
} from './auth/pairing.js'
export {
  SPAKE2_M_HEX,
  SPAKE2_N_HEX,
  confirmationMatches,
  spake2,
  spake2Scalar,
  spake2WithEphemeral,
  type Spake2Options,
  type Spake2Result,
  type Spake2Role,
  type Spake2Session,
} from './auth/spake2.js'
export {
  MDNS_SERVICE_TYPE,
  advertiseGateway,
  createMdnsLocator,
  encodeGatewayTxt,
  parseGatewayTxt,
  preferredAddress,
  type GatewayAdvertisement,
  type GatewayTxt,
  type MdnsLocatorOptions,
} from './gateway/mdns.js'
export { withStateLock } from './auth/state-lock.js'
