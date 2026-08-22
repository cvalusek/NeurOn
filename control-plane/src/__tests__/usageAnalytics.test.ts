import { describe, expect, it } from "vitest";
import { InMemoryReservationProfileRepository } from "../repository/InMemoryReservationProfileRepository.js";
import { InMemoryReservationRepository } from "../repository/InMemoryReservationRepository.js";
import { InMemoryTargetActivationRepository } from "../repository/InMemoryTargetActivationRepository.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { UsageAnalyticsService } from "../services/UsageAnalyticsService.js";

describe("UsageAnalyticsService", () => {
  it("splits allocations across UTC days and reports exact target/model popularity", async () => {
    const reservations = new InMemoryReservationRepository();
    const profiles = new InMemoryReservationProfileRepository();
    const activations = new InMemoryTargetActivationRepository();
    const catalog = new ModelCatalog(
      [{ id: "model-1", displayName: "Model 1", aliases: ["coding"], targetIds: ["target-1"] }],
      [{ id: "target-1", displayName: "Target 1", provider: "aws-ec2", providerId: "aws", modelIds: ["model-1"] }]
    );
    const startedAt = new Date("2026-08-12T23:00:00.000Z");
    const endedAt = new Date("2026-08-14T01:00:00.000Z");
    const reservation = await reservations.create({
      id: "reservation-1", userId: "usr-clint", username: "clint", modelIds: ["model-1"], targetIds: ["target-1"],
      targetSelections: [{ targetId: "target-1", modelIds: ["model-1"] }], createdAt: startedAt, expiresAt: endedAt, endedAt, status: "done"
    });
    await profiles.create({ id: "profile-1", userId: "usr-clint", username: "clint", name: "Coding", selections: [{ targetId: "target-1", modelIds: ["model-1"] }], createdAt: startedAt, updatedAt: startedAt });
    const activation = await activations.createActivation({ id: "activation-1", targetId: "target-1", startedAt, endedAt, status: "closed", estimatedHourlyCostUsd: 1, estimatedCostUsd: 26, lastCostedAt: endedAt });
    await activations.addReservationCost({ targetActivationId: activation.id, reservationId: reservation.id, at: startedAt, estimatedCostUsd: 26 });
    await activations.closeReservationsForActivation(activation.id, endedAt);

    const service = new UsageAnalyticsService(reservations, profiles, activations, catalog);
    expect(await service.deploymentUsage(30, new Date("2026-08-14T02:00:00.000Z"))).toMatchObject([{
      targetId: "target-1", modelId: "model-1", profileCount: 1, reservationCount: 1, distinctUserCount: 1
    }]);
    const report = await service.report(3, new Date("2026-08-14T02:00:00.000Z"));
    expect(report.daily).toEqual([
      expect.objectContaining({ label: "2026-08-14", activatedMinutes: 60, estimatedCostUsd: 1 }),
      expect.objectContaining({ label: "2026-08-13", activatedMinutes: 1440, estimatedCostUsd: 24 }),
      expect.objectContaining({ label: "2026-08-12", activatedMinutes: 60, estimatedCostUsd: 1 })
    ]);
    expect(report.users).toEqual([expect.objectContaining({ label: "clint", activatedMinutes: 1560, estimatedCostUsd: 26 })]);
    expect(report.providers).toEqual([expect.objectContaining({ label: "aws" })]);
    expect(report.targets).toEqual([expect.objectContaining({ label: "Target 1" })]);
    expect(report.models).toEqual([expect.objectContaining({ label: "Model 1" })]);
  });
});
