export type ReservationStatus = "active" | "done" | "expired" | "failed";
export type RuntimeState = "stopped" | "starting" | "healthy" | "stopping" | "failed";
export type DesiredState = "on" | "off";

export interface AuthenticatedUser {
  username: string;
  isAdmin: boolean;
  apiKeyName?: string;
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
  modelIds: string[];
  targetIds: string[];
  createdAt: Date;
  expiresAt: Date;
  keepaliveMinutes?: number;
  endedAt?: Date;
  status: ReservationStatus;
  failureMessage?: string;
  synthetic?: boolean;
}

export interface AwsTargetConfig {
  cluster?: string;
  service?: string;
  clusterName?: string;
  serviceName?: string;
  autoScalingGroupName: string;
}

export interface LiteLlmTargetConfig {
  backendName: string;
  apiBaseUrl: string;
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
  modelsMax?: number;
  aws?: AwsTargetConfig;
  docker?: DockerContainerTargetConfig;
  dockerCompose?: DockerComposeTargetConfig;
  runpod?: RunPodTargetConfig;
  neuron?: NeuronTargetConfig;
  neuronProvider?: NeuronProviderConfig;
  healthUrl?: string;
  apiUrl?: string;
  litellm?: LiteLlmTargetConfig;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  modelFamily?: string;
  aliases: string[];
  tags?: ModelTag[];
  targetIds: string[];
  description?: string;
  backendModelIds?: string[];
  runtimeModelIds?: string[];
  runtimeMeta?: RuntimeModelMeta;
  contextWindowTokens?: number;
  contextLabel?: string;
}

export interface ModelTag {
  label: string;
  title?: string;
}

export interface RuntimeModelMeta {
  vocab_type?: number;
  n_vocab?: number;
  n_ctx?: number;
  n_ctx_train?: number;
  n_embd?: number;
  n_params?: number;
  size?: number;
}

export interface RuntimeDiscoveredModel {
  id?: string;
  aliases?: string[];
  tags?: Array<string | { label?: string; title?: string }>;
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
}

export interface AppConfig {
  port: number;
  sharedPassword: string;
  cookieSecret?: string;
  storage: StorageConfig;
  awsRegion: string;
  litellmApiBaseUrl?: string;
  litellmApiKey?: string;
  litellmTrafficPollSeconds: number;
  litellmTrafficLookbackSeconds: number;
  runtimeProfiles: RuntimeProfile[];
  capacityProviders: CapacityProviderDefinition[];
  capacityTargets: CapacityTarget[];
  reconcilerIntervalSeconds: number;
  reservationStatusPollSeconds: number;
  adminStatusPollSeconds: number;
  healthCheckTimeoutSeconds: number;
  healthCheckIntervalSeconds: number;
  adminUsers: string[];
}

export type StorageConfig =
  | { driver: "memory" }
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; connectionString: string };
