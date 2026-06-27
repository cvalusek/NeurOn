import type { ReservationRepository } from "../domain/interfaces.js";
import type { StorageConfig } from "../domain/types.js";
import { InMemoryReservationRepository } from "./InMemoryReservationRepository.js";

export interface ReservationRepositoryHandle {
  repository: ReservationRepository;
  close(): Promise<void>;
}

export async function createReservationRepository(config: StorageConfig): Promise<ReservationRepositoryHandle> {
  if (config.driver === "sqlite") {
    const { SqliteReservationRepository } = await import("./SqliteReservationRepository.js");
    const repository = new SqliteReservationRepository(config.path);
    return { repository, close: async () => repository.close() };
  }
  if (config.driver === "postgres") {
    const { PostgresReservationRepository } = await import("./PostgresReservationRepository.js");
    const repository = new PostgresReservationRepository(config.connectionString);
    await repository.initialize();
    return { repository, close: async () => repository.close() };
  }

  const repository = new InMemoryReservationRepository();
  return { repository, close: async () => undefined };
}
