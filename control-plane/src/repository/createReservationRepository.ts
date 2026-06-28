import type { ApiKeyRepository, ReservationRepository } from "../domain/interfaces.js";
import type { StorageConfig } from "../domain/types.js";
import { InMemoryApiKeyRepository } from "./InMemoryApiKeyRepository.js";
import { InMemoryReservationRepository } from "./InMemoryReservationRepository.js";

export interface ReservationRepositoryHandle {
  repository: ReservationRepository;
  apiKeys: ApiKeyRepository;
  close(): Promise<void>;
}

export async function createReservationRepository(config: StorageConfig): Promise<ReservationRepositoryHandle> {
  if (config.driver === "sqlite") {
    const { SqliteReservationRepository } = await import("./SqliteReservationRepository.js");
    const { SqliteApiKeyRepository } = await import("./SqliteApiKeyRepository.js");
    const repository = new SqliteReservationRepository(config.path);
    const apiKeys = new SqliteApiKeyRepository(config.path);
    return {
      repository,
      apiKeys,
      close: async () => {
        repository.close();
        apiKeys.close();
      }
    };
  }
  if (config.driver === "postgres") {
    const { PostgresReservationRepository } = await import("./PostgresReservationRepository.js");
    const { PostgresApiKeyRepository } = await import("./PostgresApiKeyRepository.js");
    const repository = new PostgresReservationRepository(config.connectionString);
    const apiKeys = new PostgresApiKeyRepository(config.connectionString);
    await repository.initialize();
    await apiKeys.initialize();
    return {
      repository,
      apiKeys,
      close: async () => {
        await repository.close();
        await apiKeys.close();
      }
    };
  }

  const repository = new InMemoryReservationRepository();
  const apiKeys = new InMemoryApiKeyRepository();
  return { repository, apiKeys, close: async () => undefined };
}
