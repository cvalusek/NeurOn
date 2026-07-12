import type { ApiKeyRepository, AuthMethodRepository, CapacityProviderRepository, CapacityTargetRepository, ReservationProfileRepository, ReservationRepository, TargetModelDiscoveryRepository, TargetProvisioningJobRepository, TargetActivationRepository } from "../domain/interfaces.js";
import type { StorageConfig } from "../domain/types.js";
import { InMemoryApiKeyRepository } from "./InMemoryApiKeyRepository.js";
import { InMemoryAuthMethodRepository } from "./InMemoryAuthMethodRepository.js";
import { InMemoryCapacityProviderRepository } from "./InMemoryCapacityProviderRepository.js";
import { InMemoryCapacityTargetRepository } from "./InMemoryCapacityTargetRepository.js";
import { InMemoryReservationRepository } from "./InMemoryReservationRepository.js";
import { InMemoryTargetModelDiscoveryRepository } from "./InMemoryTargetModelDiscoveryRepository.js";
import { InMemoryTargetProvisioningJobRepository } from "./InMemoryTargetProvisioningJobRepository.js";
import { InMemoryTargetActivationRepository } from "./InMemoryTargetActivationRepository.js";

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
    const repository = new SqliteReservationRepository(config.path);
    const reservationProfiles = new SqliteReservationProfileRepository(config.path);
    const apiKeys = new SqliteApiKeyRepository(config.path);
    const authMethods = new SqliteAuthMethodRepository(config.path);
    const capacityProviders = new SqliteCapacityProviderRepository(config.path);
    const capacityTargets = new SqliteCapacityTargetRepository(config.path);
    const targetProvisioningJobs = new SqliteTargetProvisioningJobRepository(config.path);
    const targetModelDiscoveries = new SqliteTargetModelDiscoveryRepository(config.path);
    const targetActivations = new SqliteTargetActivationRepository(config.path);
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
    const repository = new PostgresReservationRepository(config.connectionString);
    const reservationProfiles = new PostgresReservationProfileRepository(config.connectionString);
    const apiKeys = new PostgresApiKeyRepository(config.connectionString);
    const authMethods = new PostgresAuthMethodRepository(config.connectionString);
    const capacityProviders = new PostgresCapacityProviderRepository(config.connectionString);
    const capacityTargets = new PostgresCapacityTargetRepository(config.connectionString);
    const targetProvisioningJobs = new PostgresTargetProvisioningJobRepository(config.connectionString);
    const targetModelDiscoveries = new PostgresTargetModelDiscoveryRepository(config.connectionString);
    const targetActivations = new PostgresTargetActivationRepository(config.connectionString);
    await repository.initialize();
    await reservationProfiles.initialize();
    await apiKeys.initialize();
    await authMethods.initialize();
    await capacityProviders.initialize();
    await capacityTargets.initialize();
    await targetProvisioningJobs.initialize();
    await targetModelDiscoveries.initialize();
    await targetActivations.initialize();
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
      close: async () => {
        await repository.close();
        await reservationProfiles.close();
        await apiKeys.close();
        await authMethods.close();
        await capacityProviders.close();
        await capacityTargets.close();
        await targetProvisioningJobs.close();
        await targetModelDiscoveries.close();
        await targetActivations.close();
      }
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
  return { repository, reservationProfiles, apiKeys, authMethods, capacityProviders, capacityTargets, targetProvisioningJobs, targetModelDiscoveries, targetActivations, close: async () => undefined };
}
