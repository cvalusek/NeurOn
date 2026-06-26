export type ReservationStatus = "active" | "done" | "expired" | "failed";
export type RuntimeState = "stopped" | "provisioning" | "healthy" | "stopping" | "failed";
export type DesiredState = "on" | "off";

export interface AuthenticatedUser {
  username: string;
  isAdmin: boolean;
}

export interface Reservation {
  id: string;
  username: string;
  modelIds: string[];
  targetIds: string[];
  createdAt: Date;
  expiresAt: Date;
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

export interface CapacityTarget {
  id: string;
  displayName: string;
  provider: "aws-ecs" | string;
  modelIds: string[];
  models?: ConfiguredModel[];
  modelDiscovery?: RuntimeModelDiscoveryConfig;
  trafficModelPrefixes?: string[];
  modelsMax?: number;
  aws?: AwsTargetConfig;
  docker?: DockerContainerTargetConfig;
  dockerCompose?: DockerComposeTargetConfig;
  runpod?: RunPodTargetConfig;
  healthCheckUrl?: string;
  runtimeApiBaseUrl?: string;
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

export interface TargetStatus {
  targetId: string;
  desired: DesiredState;
  observed: RuntimeState;
  message: string;
  lastCheckedAt?: Date;
  lastHealthyAt?: Date;
  provisioningStartedAt?: Date;
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
  awsRegion: string;
  litellmApiBaseUrl?: string;
  litellmApiKey?: string;
  litellmTrafficPollSeconds: number;
  litellmTrafficLookbackSeconds: number;
  capacityTargets: CapacityTarget[];
  reconcilerIntervalSeconds: number;
  reservationStatusPollSeconds: number;
  adminStatusPollSeconds: number;
  healthCheckTimeoutSeconds: number;
  healthCheckIntervalSeconds: number;
  adminUsers: string[];
}
