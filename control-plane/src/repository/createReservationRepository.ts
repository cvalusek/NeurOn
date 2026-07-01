import type { ApiKeyRepository, AuthMethodRepository, CapacityProviderRepository, CapacityTargetRepository, ReservationRepository, TargetModelDiscoveryRepository, TargetProvisioningJobRepository } from "../domain/interfaces.js";
import type { StorageConfig } from "../domain/types.js";
import { InMemoryApiKeyRepository } from "./InMemoryApiKeyRepository.js";
import { InMemoryAuthMethodRepository } from "./InMemoryAuthMethodRepository.js";
import { InMemoryCapacityProviderRepository } from "./InMemoryCapacityProviderRepository.js";
import { InMemoryCapacityTargetRepository } from "./InMemoryCapacityTargetRepository.js";
import { InMemoryReservationRepository } from "./InMemoryReservationRepository.js";
import { InMemoryTargetModelDiscoveryRepository } from "./InMemoryTargetModelDiscoveryRepository.js";
import { InMemoryTargetProvisioningJobRepository } from "./InMemoryTargetProvisioningJobRepository.js";

export interface ReservationRepositoryHandle {
  repository: ReservationRepository;
  apiKeys: ApiKeyRepository;
  authMethods: AuthMethodRepository;
  capacityProviders: CapacityProviderRepository;
  capacityTargets: CapacityTargetRepository;
  targetProvisioningJobs: TargetProvisioningJobRepository;
  targetModelDiscoveries: TargetModelDiscoveryRepository;
  close(): Promise<void>;
}

export async function createReservationRepository(config: StorageConfig): Promise<ReservationRepositoryHandle> {
  if (config.driver === "sqlite") {
    const { SqliteReservationRepository } = await import("./SqliteReservationRepository.js");
    const { SqliteApiKeyRepository } = await import("./SqliteApiKeyRepository.js");
    const { SqliteAuthMethodRepository } = await import("./SqliteAuthMethodRepository.js");
    const { SqliteCapacityProviderRepository } = await import("./SqliteCapacityProviderRepository.js");
    const { SqliteCapacityTargetRepository } = await import("./SqliteCapacityTargetRepository.js");
    const { SqliteTargetModelDiscoveryRepository } = await import("./SqliteTargetModelDiscoveryRepository.js");
    const { SqliteTargetProvisioningJobRepository } = await import("./SqliteTargetProvisioningJobRepository.js");
    const repository = new SqliteReservationRepository(config.path);
    const apiKeys = new SqliteApiKeyRepository(config.path);
    const authMethods = new SqliteAuthMethodRepository(config.path);
    const capacityProviders = new SqliteCapacityProviderRepository(config.path);
    const capacityTargets = new SqliteCapacityTargetRepository(config.path);
    const targetProvisioningJobs = new SqliteTargetProvisioningJobRepository(config.path);
    const targetModelDiscoveries = new SqliteTargetModelDiscoveryRepository(config.path);
    return {
      repository,
      apiKeys,
      authMethods,
      capacityProviders,
      capacityTargets,
      targetProvisioningJobs,
      targetModelDiscoveries,
      close: async () => {
        repository.close();
        apiKeys.close();
        authMethods.close();
        capacityProviders.close();
        capacityTargets.close();
        targetProvisioningJobs.close();
        targetModelDiscoveries.close();
      }
    };
  }
  if (config.driver === "postgres") {
    const { PostgresReservationRepository } = await import("./PostgresReservationRepository.js");
    const { PostgresApiKeyRepository } = await import("./PostgresApiKeyRepository.js");
    const { PostgresAuthMethodRepository } = await import("./PostgresAuthMethodRepository.js");
    const { PostgresCapacityProviderRepository } = await import("./PostgresCapacityProviderRepository.js");
    const { PostgresCapacityTargetRepository } = await import("./PostgresCapacityTargetRepository.js");
    const { PostgresTargetModelDiscoveryRepository } = await import("./PostgresTargetModelDiscoveryRepository.js");
    const { PostgresTargetProvisioningJobRepository } = await import("./PostgresTargetProvisioningJobRepository.js");
    const repository = new PostgresReservationRepository(config.connectionString);
    const apiKeys = new PostgresApiKeyRepository(config.connectionString);
    const authMethods = new PostgresAuthMethodRepository(config.connectionString);
    const capacityProviders = new PostgresCapacityProviderRepository(config.connectionString);
    const capacityTargets = new PostgresCapacityTargetRepository(config.connectionString);
    const targetProvisioningJobs = new PostgresTargetProvisioningJobRepository(config.connectionString);
    const targetModelDiscoveries = new PostgresTargetModelDiscoveryRepository(config.connectionString);
    await repository.initialize();
    await apiKeys.initialize();
    await authMethods.initialize();
    await capacityProviders.initialize();
    await capacityTargets.initialize();
    await targetProvisioningJobs.initialize();
    await targetModelDiscoveries.initialize();
    return {
      repository,
      apiKeys,
      authMethods,
      capacityProviders,
      capacityTargets,
      targetProvisioningJobs,
      targetModelDiscoveries,
      close: async () => {
        await repository.close();
        await apiKeys.close();
        await authMethods.close();
        await capacityProviders.close();
        await capacityTargets.close();
        await targetProvisioningJobs.close();
        await targetModelDiscoveries.close();
      }
    };
  }

  const repository = new InMemoryReservationRepository();
  const apiKeys = new InMemoryApiKeyRepository();
  const authMethods = new InMemoryAuthMethodRepository();
  const capacityProviders = new InMemoryCapacityProviderRepository();
  const capacityTargets = new InMemoryCapacityTargetRepository();
  const targetProvisioningJobs = new InMemoryTargetProvisioningJobRepository();
  const targetModelDiscoveries = new InMemoryTargetModelDiscoveryRepository();
  return { repository, apiKeys, authMethods, capacityProviders, capacityTargets, targetProvisioningJobs, targetModelDiscoveries, close: async () => undefined };
}
