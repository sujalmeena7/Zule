/**
 * Stage C IPC Module — Public exports
 *
 * Authenticated local IPC between App Core and the Stage C sidecar.
 * Requirements: 6.1–6.27
 */

export {
  // Types
  type CreateEndpointResult,
  type BootstrapRecord,
  type LaunchEndpoint,
  type AuthNonces,
  EndpointFailureReason,

  // Constants
  LAUNCH_CREDENTIAL_BYTES,
  NONCE_BYTES,
  MAX_BOOTSTRAP_RECORD_BYTES,
  PIPE_PREFIX,
  REQUIRED_DACL_POLICY,

  // Functions
  createLaunchEndpoint,
  generateLaunchCredential,
  generateNonces,
  generateLaunchId,
  createBootstrapRecord,
  serializeBootstrapRecord,
  deliverBootstrap,
  destroyEndpoint,
} from './namedPipe';

export {
  // Authenticator class
  StageCAuthenticator,

  // Auth message types and interfaces
  AuthMessageType,
  type AuthChallengeMessage,
  type ClientHelloMessage,
  type AuthAcceptedMessage,
  type AuthMessage,

  // Auth result types
  AuthResult,
  type AuthSuccess,
  type AuthFailure,
  type AuthOutcome,

  // Bootstrap info (adapter for BootstrapRecord → auth protocol)
  type BootstrapInfo,
  bootstrapInfoFromRecord,

  // Connection abstraction
  type AuthConnection,
  type ThresholdEventEmitter,

  // HMAC computation (exposed for client-side use)
  computeClientProof,
  computeServerProof,

  // Validation helpers
  isValidHex,
  validateClientHello,
  isAuthenticationMessage,
  shouldAcceptMessage,

  // Constants
  CLIENT_PROOF_PREFIX,
  SERVER_PROOF_PREFIX,
  AUTH_THRESHOLD_MS,
  AUTH_DEADLINE_MS,
  CHALLENGE_BYTES,
  CLIENT_NONCE_BYTES,
} from './authenticator';

export {
  // Dispatcher class
  StageCDispatcher,

  // Dispatcher types
  RejectionCategory,
  type RejectionMetadata,
  type DispatchResult,
  type CachedOutcome,
  type FallbackCallback,
  type RejectionRecorder,
  type DispatcherConfig,
} from './dispatcher';
