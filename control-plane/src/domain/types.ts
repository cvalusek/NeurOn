export type ReservationStatus = "active" | "done" | "expired" | "failed";
export type RuntimeState = "stopped" | "starting" | "healthy" | "stopping" | "failed";
export type DesiredState = "on" | "off";

export interface AuthenticatedUser {
  username: string;
  isAdmin: boolean;
  apiKeyName?: string;
}

export type AuthMethodType = "github" | "oidc";

export interface GitHubAuthMethodConfig {
  clientId: string;
  clientSecret: string;
  allowedUsers?: string[];
  allowedOrganizations?: string[];
}

export type AuthSecretReference =
  | { source: "environment"; environmentVariable: string }
  | { source: "aws-secrets-manager"; secretId: string; jsonKey?: string }
  | { source: "stored"; value: string };

export interface OidcAuthMethodConfig {
  issuer: string;
  clientId: string;
  clientSecret: AuthSecretReference;
  scopes?: string[];
  usernameClaim?: string;
  groupsClaim?: string;
  allowedUsers?: string[];
  allowedGroups?: string[];
}

export interface AuthMethod {
  id: string;
  displayName: string;
  type: AuthMethodType;
  enabled: boolean;
  config: {
    github?: GitHubAuthMethodConfig;
    oidc?: OidcAuthMethodConfig;
    [key: string]: unknown;
  };
}

export interface ApiKey {
  id: string;
  username: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface Reservation {
  id: string;
  username: string;
  apiKeyName?: string;
  profileId?: string;
  profileName?: string;
  modelIds: string[];
  targetIds: string[];
  /** Exact target/model snapshot used by profiles and multi-target requests. Absent on legacy reservations. */
  targetSelections?: ReservationProfileSelection[];
  createdAt: Date;
  expiresAt: Date;
  keepaliveMinutes?: number;
  endedAt?: Date;
  status: ReservationStatus;
  failureMessage?: string;
  synthetic?: boolean;
}

export interface ReservationProfileSelection {
  targetId: string;
  modelIds: string[];
}

export interface ReservationProfile {
  id: string;
  username: string;
  name: string;
  description?: string;
  selections: ReservationProfileSelection[];
  defaultDurationMinutes?: number;
  defaultKeepaliveMinutes?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AwsTargetConfig {
  cluster?: string;
  service?: string;
  clusterName?: string;
  serviceName?: string;
  autoScalingGroupName?: string;
  instanceId?: string;
  runtimePort?: number;
  runtimeProtocol?: "http" | "https";
  healthPath?: string;
  apiPath?: string;
}

export interface LiteLlmTargetConfig {
  /** @deprecated Use credentialName for discovered-model synchronization. */
  backendName?: string;
  apiBaseUrl?: string;
  credentialName?: string;
  apiKeyEnv?: string;
  syncDiscoveredModels?: boolean;
}

export interface DockerComposeTargetConfig {
  projectDirectory: string;
  projectName?: string;
  composeFile?: string;
  composeFiles?: string[];
  profiles?: string[];
  serviceName: string;
}

export interface DockerContainerTargetConfig {
  containerName: string;
  image?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  gpus?: string;
  restart?: string;
  network?: string;
  command?: string[];
  extraArgs?: string[];
}

export interface RunPodTargetConfig {
  podId?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiBaseUrl?: string;
  runtimePort?: number;
  create?: Record<string, unknown>;
}

export interface HassleOffTargetPolicy {
  protected: boolean;
  leaseDurationSeconds?: number;
  staleTripTestShutdown?: {
    enabled?: boolean;
    maxAgeSeconds?: number;
  };
}

export interface TargetActivationPolicy {
  reprovisionOnRecoverableUnavailable?: boolean;
}

export interface HassleOffClientConfig {
  baseUrl: string;
  controllerToken: string;
  controllerId: string;
  requestTimeoutSeconds: number;
  failSafeTestTargetId: string;
}

export interface NeuronTargetConfig {
  targetId: string;
}

export interface NeuronProviderConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  reservationMinutes?: number;
  syncTargets?: boolean;
  targetIdPrefix?: string;
}

export interface RuntimeProfile {
  id: string;
  name: string;
  type: "docker" | string;
  image?: string;
  port?: number;
  health?: string;
  api?: string;
  volumes?: Record<string, string>;
  env?: Record<string, string>;
  discovery?: boolean;
  variants?: RuntimeProfileVariant[];
}

export interface RuntimeProfileVariant {
  id: string;
  name: string;
  description?: string;
  image?: string;
  port?: number;
  health?: string;
  api?: string;
  volumes?: Record<string, string>;
  env?: Record<string, string>;
  discovery?: boolean;
}

export type TargetProvisioningJobStatus = "draft" | "running" | "completed" | "failed" | "aborting" | "aborted";

export interface TargetProvisioningResource {
  providerType: string;
  resourceType: string;
  resourceId: string;
  cleanupState: "pending" | "deleted" | "unknown";
}

export interface TargetProvisioningJob {
  id: string;
  status: TargetProvisioningJobStatus;
  providerId: string;
  providerType: string;
  runtimeProfileId?: string;
  targetId: string;
  targetDraft: CapacityTarget;
  createdResources: TargetProvisioningResource[];
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CapacityProviderDefinition {
  id: string;
  displayName: string;
  type: "aws-ecs" | "aws-ecs-asg" | string;
  provisioning?: {
    enabled?: boolean;
  };
  config?: {
    awsEc2?: {
      instanceNamePattern?: string;
    };
    runpod?: Pick<RunPodTargetConfig, "apiKey" | "apiKeyEnv" | "apiBaseUrl">;
    neuron?: NeuronProviderConfig;
    [key: string]: unknown;
  };
  credentialId?: string;
}

export interface ConfiguredModel {
  id: string;
  displayName?: string;
  modelFamily?: string;
  aliases?: string[];
  tags?: ModelTag[];
  /** Binary, technically advertised features such as vision or tool use. */
  technicalCapabilities?: ModelTag[];
  description?: string;
  backendModelIds?: string[];
  contextWindowTokens?: number;
  contextLabel?: string;
}

export interface RuntimeModelDiscoveryConfig {
  bootstrapOnStartup?: boolean;
  bootstrapTimeoutSeconds?: number;
}

export interface ModelWarmupConfig {
  enabled?: boolean;
  apiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutSeconds?: number;
}

export interface CapacityTarget {
  id: string;
  displayName: string;
  provider: "aws-ecs" | string;
  providerId?: string;
  modelIds: string[];
  models?: ConfiguredModel[];
  modelDiscovery?: RuntimeModelDiscoveryConfig;
  modelWarmup?: ModelWarmupConfig;
  trafficModelPrefixes?: string[];
  litellmDisplayPrefix?: string;
  /** Lower values are preferred by LiteLLM's ordered deployment fallback. */
  aliasPriority?: number;
  modelsMax?: number;
  /** Operator-owned scheduling shape. modelsMax remains display/debug metadata. */
  hostingMode?: "dedicated" | "multi-model";
  aws?: AwsTargetConfig;
  docker?: DockerContainerTargetConfig;
  dockerCompose?: DockerComposeTargetConfig;
  runpod?: RunPodTargetConfig;
  neuron?: NeuronTargetConfig;
  neuronProvider?: NeuronProviderConfig;
  healthUrl?: string;
  apiUrl?: string;
  litellm?: LiteLlmTargetConfig;
  costEstimate?: TargetCostEstimateConfig;
  hassleOff?: HassleOffTargetPolicy;
  activationPolicy?: TargetActivationPolicy;
}

/** Singleton durable configuration for NeurOn's in-application assistant. */
export interface AssistantConfig {
  id: "default";
  targetId: string;
  modelId: string;
  reservationMinutes: number;
  keepaliveMinutes: number;
  requestTimeoutSeconds: number;
  updatedAt: Date;
}

export interface TargetCostEstimateConfig {
  hourlyUsd?: number;
}

export type TargetActivationStatus = "open" | "closed";

export interface TargetActivation {
  id: string;
  targetId: string;
  startedAt: Date;
  endedAt?: Date;
  status: TargetActivationStatus;
  estimatedHourlyCostUsd?: number;
  estimatedCostUsd: number;
  lastCostedAt: Date;
}

export interface TargetActivationReservation {
  id: string;
  targetActivationId: string;
  reservationId: string;
  startedAt: Date;
  endedAt?: Date;
  estimatedCostUsd: number;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  modelFamily?: string;
  aliases: string[];
  tags?: ModelTag[];
  /** Binary, technically advertised features such as vision or tool use. */
  technicalCapabilities?: ModelTag[];
  targetIds: string[];
  description?: string;
  backendModelIds?: string[];
  runtimeModelIds?: string[];
  runtimeMeta?: RuntimeModelMeta;
  contextWindowTokens?: number;
  contextLabel?: string;
}

export interface ModelMetricProvenance {
  source: string;
  sourceUrl?: string;
  sourceModelId?: string;
  retrievedAt?: string;
  version?: string;
  notes?: string;
}

export interface ModelCapabilityMetadata {
  modelId: string;
  intelligence?: number;
  /** Scored subject-matter strengths used to refine intelligence ranking. */
  domains?: Record<string, number>;
  /** Artifact-level quantization facts. */
  quantization?: {
    format: string;
    qualityRetentionPercent?: number;
    reference?: string;
  };
  provenance?: ModelMetricProvenance;
}

export interface ModelDeploymentPerformance {
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  measuredAt?: string;
  sampleCount?: number;
  provenance?: ModelMetricProvenance;
}

export interface ModelDeploymentMetadata {
  targetId: string;
  modelId: string;
  /** @deprecated Context is owned by target/model configuration or discovery. */
  contextWindowTokens?: number;
  /** @deprecated Quantization is model/artifact metadata; retained for read compatibility. */
  quantization?: {
    format: string;
    qualityRetentionPercent?: number;
    reference?: string;
  };
  performance?: ModelDeploymentPerformance;
  provenance?: ModelMetricProvenance;
}

export interface ModelSelectionCatalogConfig {
  schemaVersion: 1;
  models: ModelCapabilityMetadata[];
  deployments: ModelDeploymentMetadata[];
}

export interface StoredModelCapabilityMetadata extends ModelCapabilityMetadata {
  updatedAt: Date;
}

export interface StoredModelDeploymentMetadata extends ModelDeploymentMetadata {
  updatedAt: Date;
}

export interface ModelFavorite {
  username: string;
  targetId: string;
  modelId: string;
  createdAt: Date;
}

export interface ModelTag {
  label: string;
  title?: string;
}

export interface RuntimeModelMeta {
  vocab_type?: number;
  n_vocab?: number;
  n_ctx?: number;
  /** Explicit effective context per concurrent sequence when the runtime reports it. */
  n_ctx_per_sequence?: number;
  /** Concurrent sequences sharing n_ctx. */
  n_parallel?: number;
  n_ctx_train?: number;
  n_embd?: number;
  n_params?: number;
  size?: number;
}

export interface RuntimeDiscoveredModel {
  id?: string;
  aliases?: string[];
  tags?: Array<string | { label?: string; title?: string }>;
  capabilities?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  modalities?: unknown;
  supports_vision?: unknown;
  supports_tools?: unknown;
  supports_tool_calls?: unknown;
  meta?: RuntimeModelMeta | null;
}

export interface TargetModelDiscoveryRecord {
  targetId: string;
  models: RuntimeDiscoveredModel[];
  discoveredAt: Date;
}

export interface TargetStatus {
  targetId: string;
  desired: DesiredState;
  observed: RuntimeState;
  message: string;
  lastCheckedAt?: Date;
  lastHealthyAt?: Date;
  startingStartedAt?: Date;
  startupDurationsSeconds?: number[];
  startupEstimate?: {
    minSeconds: number;
    maxSeconds: number;
    avgSeconds: number;
    sampleCount: number;
  };
}

export interface CapacityProviderStatus {
  observed: RuntimeState;
  message: string;
  details?: Record<string, unknown>;
  runtime?: {
    apiUrl?: string;
    healthUrl?: string;
  };
}

export interface CapacityProviderResource {
  id: string;
  displayName: string;
  state?: string;
  details?: Record<string, unknown>;
}

export interface AppConfig {
  port: number;
  publicBaseUrl?: string;
  sharedPassword?: string;
  sharedPasswordEnabled?: boolean;
  cookieSecret?: string;
  storage: StorageConfig;
  awsRegion: string;
  litellmApiBaseUrl?: string;
  litellmApiKey?: string;
  litellmTrafficPollSeconds: number;
  litellmTrafficLookbackSeconds: number;
  modelSelectionCatalog?: ModelSelectionCatalogConfig;
  runtimeProfiles: RuntimeProfile[];
  capacityProviders: CapacityProviderDefinition[];
  capacityTargets: CapacityTarget[];
  reconcilerIntervalSeconds: number;
  reservationStatusPollSeconds: number;
  adminStatusPollSeconds: number;
  healthCheckTimeoutSeconds: number;
  healthCheckIntervalSeconds: number;
  adminUsers: string[];
  authMethods: AuthMethod[];
  updates?: UpdateCheckConfig;
  hassleOff?: HassleOffClientConfig;
  maintenanceMode?: boolean;
  storageOperationLockPath?: string;
}

export interface UpdateCheckConfig {
  enabled: boolean;
  repository: string;
  currentRevision?: string;
  checkIntervalSeconds: number;
  githubToken?: string;
}

export type StorageConfig =
  | { driver: "memory" }
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; connectionString: string; maxConnections: number };
