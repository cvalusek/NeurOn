import type { ApiKeyRepository, AssistantConfigRepository, AuthMethodRepository, CapacityProviderRepository, CapacityTargetRepository, ModelFavoriteRepository, ModelMetadataRepository, ReservationProfileRepository, ReservationRepository, TargetModelDiscoveryRepository, TargetProvisioningJobRepository, TargetActivationRepository } from "../domain/interfaces.js";
import type { StorageConfig } from "../domain/types.js";
import pg from "pg";
import { InMemoryApiKeyRepository } from "./InMemoryApiKeyRepository.js";
import { InMemoryAuthMethodRepository } from "./InMemoryAuthMethodRepository.js";
import { InMemoryCapacityProviderRepository } from "./InMemoryCapacityProviderRepository.js";
import { InMemoryCapacityTargetRepository } from "./InMemoryCapacityTargetRepository.js";
import { InMemoryReservationRepository } from "./InMemoryReservationRepository.js";
import { InMemoryTargetModelDiscoveryRepository } from "./InMemoryTargetModelDiscoveryRepository.js";
import { InMemoryTargetProvisioningJobRepository } from "./InMemoryTargetProvisioningJobRepository.js";
import { InMemoryTargetActivationRepository } from "./InMemoryTargetActivationRepository.js";
import { InMemoryModelMetadataRepository } from "./InMemoryModelMetadataRepository.js";
import { InMemoryModelFavoriteRepository } from "./InMemoryModelFavoriteRepository.js";
import { InMemoryAssistantConfigRepository } from "./InMemoryAssistantConfigRepository.js";
import { migratePostgresSchema } from "./postgresSchema.js";

export interface ReservationRepositoryHandle {
  repository: ReservationRepository;
  reservationProfiles: ReservationProfileRepository;
  apiKeys: ApiKeyRepository;
  authMethods: AuthMethodRepository;
  capacityProviders: CapacityProviderRepository;
  capacityTargets: CapacityTargetRepository;
  targetProvisioningJobs: TargetProvisioningJobRepository;
  targetModelDiscoveries: TargetModelDiscoveryRepository;
  targetActivations: TargetActivationRepository;
  modelMetadata: ModelMetadataRepository;
  modelFavorites: ModelFavoriteRepository;
  assistantConfig: AssistantConfigRepository;
  close(): Promise<void>;
}

export async function createReservationRepository(config: StorageConfig): Promise<ReservationRepositoryHandle> {
  if (config.driver === "sqlite") {
    const { SqliteReservationRepository } = await import("./SqliteReservationRepository.js");
    const { SqliteApiKeyRepository } = await import("./SqliteApiKeyRepository.js");
    const { SqliteReservationProfileRepository } = await import("./SqliteReservationProfileRepository.js");
    const { SqliteAuthMethodRepository } = await import("./SqliteAuthMethodRepository.js");
    const { SqliteCapacityProviderRepository } = await import("./SqliteCapacityProviderRepository.js");
    const { SqliteCapacityTargetRepository } = await import("./SqliteCapacityTargetRepository.js");
    const { SqliteTargetModelDiscoveryRepository } = await import("./SqliteTargetModelDiscoveryRepository.js");
    const { SqliteTargetProvisioningJobRepository } = await import("./SqliteTargetProvisioningJobRepository.js");
    const { SqliteTargetActivationRepository } = await import("./SqliteTargetActivationRepository.js");
    const { SqliteModelMetadataRepository } = await import("./SqliteModelMetadataRepository.js");
    const { SqliteModelFavoriteRepository } = await import("./SqliteModelFavoriteRepository.js");
    const { SqliteAssistantConfigRepository } = await import("./SqliteAssistantConfigRepository.js");
    const repository = new SqliteReservationRepository(config.path);
    const reservationProfiles = new SqliteReservationProfileRepository(config.path);
    const apiKeys = new SqliteApiKeyRepository(config.path);
    const authMethods = new SqliteAuthMethodRepository(config.path);
    const capacityProviders = new SqliteCapacityProviderRepository(config.path);
    const capacityTargets = new SqliteCapacityTargetRepository(config.path);
    const targetProvisioningJobs = new SqliteTargetProvisioningJobRepository(config.path);
    const targetModelDiscoveries = new SqliteTargetModelDiscoveryRepository(config.path);
    const targetActivations = new SqliteTargetActivationRepository(config.path);
    const modelMetadata = new SqliteModelMetadataRepository(config.path);
    const modelFavorites = new SqliteModelFavoriteRepository(config.path);
    const assistantConfig = new SqliteAssistantConfigRepository(config.path);
    return {
      repository,
      reservationProfiles,
      apiKeys,
      authMethods,
      capacityProviders,
      capacityTargets,
      targetProvisioningJobs,
      targetModelDiscoveries,
      targetActivations,
      modelMetadata,
      modelFavorites,
      assistantConfig,
      close: async () => {
        repository.close();
        reservationProfiles.close();
        apiKeys.close();
        authMethods.close();
        capacityProviders.close();
        capacityTargets.close();
        targetProvisioningJobs.close();
        targetModelDiscoveries.close();
        targetActivations.close();
        modelMetadata.close();
        modelFavorites.close();
        assistantConfig.close();
      }
    };
  }
  if (config.driver === "postgres") {
    const { PostgresReservationRepository } = await import("./PostgresReservationRepository.js");
    const { PostgresApiKeyRepository } = await import("./PostgresApiKeyRepository.js");
    const { PostgresReservationProfileRepository } = await import("./PostgresReservationProfileRepository.js");
    const { PostgresAuthMethodRepository } = await import("./PostgresAuthMethodRepository.js");
    const { PostgresCapacityProviderRepository } = await import("./PostgresCapacityProviderRepository.js");
    const { PostgresCapacityTargetRepository } = await import("./PostgresCapacityTargetRepository.js");
    const { PostgresTargetModelDiscoveryRepository } = await import("./PostgresTargetModelDiscoveryRepository.js");
    const { PostgresTargetProvisioningJobRepository } = await import("./PostgresTargetProvisioningJobRepository.js");
    const { PostgresTargetActivationRepository } = await import("./PostgresTargetActivationRepository.js");
    const { PostgresModelMetadataRepository } = await import("./PostgresModelMetadataRepository.js");
    const { PostgresModelFavoriteRepository } = await import("./PostgresModelFavoriteRepository.js");
    const { PostgresAssistantConfigRepository } = await import("./PostgresAssistantConfigRepository.js");
    const pool = new pg.Pool({ connectionString: config.connectionString, max: config.maxConnections });
    try {
      await migratePostgresSchema(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    const repository = new PostgresReservationRepository(pool);
    const reservationProfiles = new PostgresReservationProfileRepository(pool);
    const apiKeys = new PostgresApiKeyRepository(pool);
    const authMethods = new PostgresAuthMethodRepository(pool);
    const capacityProviders = new PostgresCapacityProviderRepository(pool);
    const capacityTargets = new PostgresCapacityTargetRepository(pool);
    const targetProvisioningJobs = new PostgresTargetProvisioningJobRepository(pool);
    const targetModelDiscoveries = new PostgresTargetModelDiscoveryRepository(pool);
    const targetActivations = new PostgresTargetActivationRepository(pool);
    const modelMetadata = new PostgresModelMetadataRepository(pool);
    const modelFavorites = new PostgresModelFavoriteRepository(pool);
    const assistantConfig = new PostgresAssistantConfigRepository(pool);
    return {
      repository,
      reservationProfiles,
      apiKeys,
      authMethods,
      capacityProviders,
      capacityTargets,
      targetProvisioningJobs,
      targetModelDiscoveries,
      targetActivations,
      modelMetadata,
      modelFavorites,
      assistantConfig,
      close: async () => pool.end()
    };
  }

  const repository = new InMemoryReservationRepository();
  const { InMemoryReservationProfileRepository } = await import("./InMemoryReservationProfileRepository.js");
  const reservationProfiles = new InMemoryReservationProfileRepository();
  const apiKeys = new InMemoryApiKeyRepository();
  const authMethods = new InMemoryAuthMethodRepository();
  const capacityProviders = new InMemoryCapacityProviderRepository();
  const capacityTargets = new InMemoryCapacityTargetRepository();
  const targetProvisioningJobs = new InMemoryTargetProvisioningJobRepository();
  const targetModelDiscoveries = new InMemoryTargetModelDiscoveryRepository();
  const targetActivations = new InMemoryTargetActivationRepository();
  const modelMetadata = new InMemoryModelMetadataRepository();
  const modelFavorites = new InMemoryModelFavoriteRepository();
  const assistantConfig = new InMemoryAssistantConfigRepository();
  return { repository, reservationProfiles, apiKeys, authMethods, capacityProviders, capacityTargets, targetProvisioningJobs, targetModelDiscoveries, targetActivations, modelMetadata, modelFavorites, assistantConfig, close: async () => undefined };
}
