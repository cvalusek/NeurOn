import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedUser, CapacityTarget, ModelDefinition } from "../domain/types.js";
import { SqliteApiKeyRepository } from "../repository/SqliteApiKeyRepository.js";
import { SqliteModelFavoriteRepository } from "../repository/SqliteModelFavoriteRepository.js";
import { SqliteIdentityRepository } from "../repository/SqliteIdentityRepository.js";
import { SqliteReservationProfileRepository } from "../repository/SqliteReservationProfileRepository.js";
import { SqliteReservationRepository } from "../repository/SqliteReservationRepository.js";
import { createReservationRepository } from "../repository/createReservationRepository.js";
import { IdentityService } from "../services/IdentityService.js";
import { AuthMethodService } from "../services/AuthMethodService.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationProfileService } from "../services/ReservationProfileService.js";
import { ReservationService } from "../services/ReservationService.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable user identity", () => {
  it("registers one local account from a one-time invitation", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    const owner = await createOwner(handle.identities, identities);

    const created = await identities.createInvitation(owner, {
      intendedUsername: "Alice",
      initialRoleId: "role_member",
      expiresInMinutes: 30,
      maxUses: 1
    });
    const registered = await identities.register(created.token, { username: "alice", password: "alice-password" });

    expect(registered).toMatchObject({ username: "alice", isAdmin: false });
    await expect(identities.authenticateLocal("ALICE", "alice-password")).resolves.toMatchObject({ id: registered.id });
    await expect(identities.register(created.token, { username: "alice", password: "different-password" })).rejects.toThrow("expired, revoked, or already used");
    expect((await handle.identities.listInvitations())[0]).toMatchObject({ useCount: 1, tokenHash: expect.not.stringContaining(created.token) });
    await handle.close();
  });

  it("attaches stable GitHub and OIDC identities to the existing username account", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    await createOwner(handle.identities, identities);
    const legacy = await handle.identities.createUser({ id: "usr_alice", username: "Alice", status: "active" });

    const github = await identities.signInExternal("github", "github-work", {
      subject: "github-user-42",
      username: "alice",
      email: "alice@example.test"
    });
    const renamed = await identities.signInExternal("github", "github-work", {
      subject: "github-user-42",
      username: "alice-renamed",
      email: "alice@example.test"
    });

    expect(github.id).toBe(legacy.id);
    expect(renamed.id).toBe(legacy.id);
    expect(await handle.identities.findIdentity("github", "github-work", "github-user-42")).toMatchObject({ userId: legacy.id, username: "alice-renamed" });
    await handle.close();
  });

  it("reconciles OIDC team membership and honors nested target visibility", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    const owner = await createOwner(handle.identities, identities);
    const parent = await identities.createTeam(owner, { name: "Engineering" });
    const child = await identities.createTeam(owner, { name: "Platform", parentTeamId: parent.id });
    const research = await identities.createTeam(owner, { name: "Research" });
    const rule = { id: "platform-claim", claim: "groups", match: "exact" as const, value: "platform", teamId: child.id, roleId: "role_team_member" };

    const member = await identities.signInExternal("oidc", "work-oidc", {
      subject: "work-user-7",
      username: "developer",
      claims: { groups: ["platform"] }
    }, [rule]);
    const parentTarget: CapacityTarget = { id: "team-target", displayName: "Team target", provider: "fake", modelIds: [], audience: { scope: "teams", teamIds: [parent.id] } };
    expect(await identities.canAccessTarget(member, parentTarget, "use")).toBe(true);

    await identities.signInExternal("oidc", "work-oidc", {
      subject: "work-user-7",
      username: "developer",
      claims: { groups: ["platform"] }
    }, [{ ...rule, teamId: research.id }]);
    expect(await identities.canAccessTarget(member, parentTarget, "use")).toBe(false);
    expect(await identities.canAccessTarget(member, { ...parentTarget, audience: { scope: "teams", teamIds: [research.id] } }, "use")).toBe(true);

    await identities.signInExternal("oidc", "work-oidc", {
      subject: "work-user-7",
      username: "developer",
      claims: { groups: [] }
    }, [rule]);
    expect(await identities.canAccessTarget(member, parentTarget, "use")).toBe(false);
    await handle.close();
  });

  it("shares team profiles through nested membership while keeping management scoped", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities, handle.reservationProfiles);
    const owner = await createOwner(handle.identities, identities);
    const parent = await identities.createTeam(owner, { name: "Engineering" });
    const child = await identities.createTeam(owner, { name: "Platform", parentTeamId: parent.id });
    const managerAccount = await handle.identities.createUser({ id: "usr_manager", username: "manager", status: "active" });
    const memberAccount = await handle.identities.createUser({ id: "usr_member", username: "member", status: "active" });
    const outsiderAccount = await handle.identities.createUser({ id: "usr_outsider", username: "outsider", status: "active" });
    for (const account of [managerAccount, memberAccount, outsiderAccount]) await handle.identities.assignGlobalRole(account.id, "role_member");
    await identities.setTeamMembership(owner, { teamId: parent.id, userId: managerAccount.id, roleId: "role_team_manager", source: "manual" });
    await identities.setTeamMembership(owner, { teamId: child.id, userId: memberAccount.id, roleId: "role_team_member", source: "manual" });
    const manager = (await identities.authenticatedUser(managerAccount.id))!;
    const member = (await identities.authenticatedUser(memberAccount.id))!;
    const outsider = (await identities.authenticatedUser(outsiderAccount.id))!;
    const teamTarget: CapacityTarget = { id: "team-target", displayName: "Team target", provider: "fake", modelIds: ["team-model"], audience: { scope: "teams", teamIds: [parent.id] } };
    const privateTarget: CapacityTarget = { id: "private-target", displayName: "Private target", provider: "fake", modelIds: ["private-model"], audience: { scope: "users", userIds: [manager.id] } };
    const models: ModelDefinition[] = [
      { id: "team-model", displayName: "Team model", aliases: [], targetIds: [teamTarget.id] },
      { id: "private-model", displayName: "Private model", aliases: [], targetIds: [privateTarget.id] }
    ];
    const catalog = new ModelCatalog(models, [teamTarget, privateTarget]);
    const profiles = new ReservationProfileService(handle.reservationProfiles, catalog, identities);
    const reservations = new ReservationService(handle.repository, catalog, handle.reservationProfiles, undefined, undefined, identities);

    expect(await profiles.listAssignableTeams(manager)).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent.id }), expect.objectContaining({ id: child.id })]));
    const profile = await profiles.createForUser(manager, { teamId: child.id, name: "Platform coding", selections: [{ targetId: teamTarget.id, modelIds: ["team-model"] }] });
    expect(await profiles.listForUser(member)).toMatchObject([{ id: profile.id, teamId: child.id }]);
    expect(await profiles.listForUser(outsider)).toEqual([]);
    await expect(reservations.createForUser(member, { profileId: profile.id, durationMinutes: 5 })).resolves.toMatchObject({ profileId: profile.id, userId: member.id });
    await expect(reservations.createForUser(outsider, { profileId: profile.id, durationMinutes: 5 })).rejects.toThrow("Reservation profile not found");
    await expect(profiles.updateForUser(profile.id, member, { teamId: child.id, name: "Changed", selections: profile.selections })).rejects.toThrow("Reservation profile not found");
    await expect(profiles.createForUser(manager, { teamId: child.id, name: "Invalid sharing", selections: [{ targetId: privateTarget.id, modelIds: ["private-model"] }] })).rejects.toThrow("whole team");
    await expect(identities.deleteTeam(owner, child.id)).rejects.toThrow("shared profiles");
    await handle.close();
  });

  it("maps LiteLLM users automatically only when the identity match is unambiguous", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    await createOwner(handle.identities, identities);
    const alice = await handle.identities.createUser({ id: "usr_alice", username: "alice", status: "active" });
    const bob = await handle.identities.createUser({ id: "usr_bob", username: "bob", status: "active" });
    await handle.identities.saveIdentity({ userId: alice.id, providerType: "oidc", providerId: "work", subject: "oidc-a", email: "shared@example.test" });
    await handle.identities.saveIdentity({ userId: bob.id, providerType: "github", providerId: "github", subject: "github-b", email: "shared@example.test" });

    await expect(identities.resolveLiteLlmUser("alice")).resolves.toMatchObject({ id: alice.id });
    expect(await handle.identities.getExternalUserLink("litellm", "alice")).toMatchObject({ userId: alice.id, source: "rule" });
    await expect(identities.resolveLiteLlmUser("usr_bob")).resolves.toMatchObject({ id: bob.id });
    await expect(identities.resolveLiteLlmUser("shared@example.test")).resolves.toBeUndefined();
    expect(await handle.identities.getExternalUserLink("litellm", "shared@example.test")).toBeUndefined();
    await handle.close();
  });

  it("keeps wildcard Owner authority out of delegated administrator operations", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    const owner = await createOwner(handle.identities, identities);
    const adminAccount = await handle.identities.createUser({ id: "usr_admin", username: "admin", status: "active" });
    await handle.identities.assignGlobalRole(adminAccount.id, "role_admin");
    const admin = (await identities.authenticatedUser(adminAccount.id))!;
    const member = await handle.identities.createUser({ id: "usr_member", username: "member", status: "active" });

    await expect(identities.assignRole(admin, member.id, "role_owner")).rejects.toThrow("Only an Owner");
    await expect(identities.createRole(admin, { name: "Root clone", scope: "global", permissions: ["*"] })).rejects.toThrow("Only an Owner");
    await expect(identities.createInvitation(admin, { userId: owner.id })).rejects.toThrow("Only an Owner");
    await expect(identities.mergeUsers(admin, owner.id, member.id)).rejects.toThrow("Only an Owner");
    await expect(identities.assignRole(owner, member.id, "role_owner")).resolves.toBeUndefined();
    await handle.close();
  });

  it("does not let an outstanding claim link reactivate a disabled account", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    const owner = await createOwner(handle.identities, identities);
    const member = await handle.identities.createUser({ id: "usr_disabled", username: "disabled", status: "active" });
    const claim = await identities.createInvitation(owner, { userId: member.id });

    await identities.setUserStatus(owner, member.id, "disabled");

    await expect(identities.register(claim.token, { username: member.username, password: "disabled-password" })).rejects.toThrow("expired, revoked, or already used");
    expect(await handle.identities.getUser(member.id)).toMatchObject({ status: "disabled" });
    await handle.close();
  });

  it("validates OIDC membership rules before saving authentication configuration", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const methods = new AuthMethodService([], handle.authMethods, handle.identities);
    await methods.initialize();

    await expect(methods.create({
      id: "work",
      displayName: "Work",
      type: "oidc",
      enabled: true,
      config: { oidc: { issuer: "https://identity.example.test", clientId: "client", clientSecret: { source: "stored", value: "test-only" }, teamMembershipRules: [{ id: "broken", claim: "groups", match: "regex", value: "[", teamId: "missing", roleId: "role_team_member" }] } }
    })).rejects.toThrow("invalid regular expression");
    expect(await handle.authMethods.get("work")).toBeUndefined();
    await handle.close();
  });

  it("merges duplicate users without losing owned records, identities, membership, or target access", async () => {
    const handle = await createReservationRepository({ driver: "memory" });
    const identities = new IdentityService(handle.identities);
    const owner = await createOwner(handle.identities, identities);
    const source = await handle.identities.createUser({ id: "usr_source", username: "github-alice", status: "active" });
    const target = await handle.identities.createUser({ id: "usr_target", username: "alice", status: "active" });
    const team = await identities.createTeam(owner, { name: "Users" });
    const now = new Date("2026-08-21T12:00:00.000Z");

    await handle.repository.create({ id: "reservation-source", userId: source.id, username: source.username, modelIds: ["model"], targetIds: ["target"], createdAt: now, expiresAt: new Date(now.getTime() + 60_000), status: "done" });
    await handle.reservationProfiles.create({ id: "profile-source", userId: source.id, username: source.username, name: "Coding", selections: [{ targetId: "target", modelIds: ["model"] }], createdAt: now, updatedAt: now });
    await handle.apiKeys.create({ id: "key-source", userId: source.id, username: source.username, name: "Plugin", prefix: "sk-neuron-test", keyHash: "opaque-hash", createdAt: now });
    await handle.modelFavorites.add({ userId: source.id, username: source.username, targetId: "target", modelId: "model", createdAt: now });
    await handle.modelFavorites.add({ userId: target.id, username: target.username, targetId: "target", modelId: "model", createdAt: now });
    await handle.identities.saveIdentity({ userId: source.id, providerType: "github", providerId: "github", subject: "github-42", username: source.username });
    await handle.identities.setTeamMembership({ teamId: team.id, userId: source.id, roleId: "role_team_member", source: "manual" });
    await handle.identities.saveExternalUserLink({ integration: "litellm", externalSubject: "external-alice", userId: source.id, source: "admin" });
    await handle.capacityTargets.create({ id: "private-target", displayName: "Private", provider: "fake", modelIds: [], audience: { scope: "users", userIds: [source.id] } });
    const configuredPrivateTarget: CapacityTarget = { id: "configured-private", displayName: "Configured private", provider: "fake", modelIds: [], audience: { scope: "users", userIds: [source.id] } };

    await expect(identities.previewMerge(owner, source.id, target.id)).resolves.toMatchObject({ counts: { reservations: 1, profiles: 1, apiKeys: 1, favorites: 1, identities: 1, teamMemberships: 1, externalUserLinks: 1 } });
    await identities.mergeUsers(owner, source.id, target.id);

    expect(await handle.identities.getUser(source.id)).toMatchObject({ status: "disabled", mergedIntoUserId: target.id });
    expect(await handle.repository.get("reservation-source")).toMatchObject({ userId: target.id, username: target.username });
    expect(await handle.reservationProfiles.get("profile-source")).toMatchObject({ userId: target.id, username: target.username });
    expect(await handle.apiKeys.get("key-source")).toMatchObject({ userId: target.id, username: target.username });
    expect(await handle.modelFavorites.listForUser(target.id)).toHaveLength(1);
    expect(await handle.identities.findIdentity("github", "github", "github-42")).toMatchObject({ userId: target.id });
    expect(await handle.identities.getExternalUserLink("litellm", "external-alice")).toMatchObject({ userId: target.id });
    expect(await handle.identities.isUserInAnyTeam(target.id, [team.id])).toBe(true);
    expect(await handle.capacityTargets.get("private-target")).toMatchObject({ audience: { scope: "users", userIds: [target.id] } });
    expect(await identities.canAccessTarget((await identities.authenticatedUser(target.id))!, configuredPrivateTarget)).toBe(true);
    await handle.close();
  });

  it("backfills legacy SQLite ownership case-insensitively without changing user data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-identity-upgrade-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "legacy.db");
    const now = new Date("2026-08-01T12:00:00.000Z");
    const placeholder = "pre-user-schema";
    const reservations = new SqliteReservationRepository(databasePath);
    const profiles = new SqliteReservationProfileRepository(databasePath);
    const keys = new SqliteApiKeyRepository(databasePath);
    const favorites = new SqliteModelFavoriteRepository(databasePath);
    await reservations.create({ id: "legacy-reservation", username: "Clint", modelIds: [], targetIds: ["target"], createdAt: now, expiresAt: now, status: "done" });
    await profiles.create({ id: "legacy-profile", userId: placeholder, username: "clint", name: "Legacy", selections: [{ targetId: "target", modelIds: [] }], createdAt: now, updatedAt: now });
    await keys.create({ id: "legacy-key", userId: placeholder, username: "CLINT", name: "Legacy", prefix: "sk-neuron-old", keyHash: "legacy-hash", createdAt: now });
    await favorites.add({ userId: placeholder, username: "Clint", targetId: "target", modelId: "model", createdAt: now });
    reservations.close(); profiles.close(); keys.close(); favorites.close();
    const database = new Database(databasePath);
    for (const table of ["reservation_profiles", "api_keys", "model_favorites"]) database.prepare(`update ${table} set user_id=null`).run();
    database.close();

    const upgraded = await createReservationRepository({ driver: "sqlite", path: databasePath });
    const identities = new IdentityService(upgraded.identities);
    await identities.initialize(["clint"]);
    const user = await upgraded.identities.getUserByUsername("CLINT");

    expect(user).toBeDefined();
    expect(await upgraded.repository.get("legacy-reservation")).toMatchObject({ userId: user!.id, username: "Clint" });
    expect(await upgraded.reservationProfiles.get("legacy-profile")).toMatchObject({ userId: user!.id, username: "clint" });
    expect(await upgraded.apiKeys.get("legacy-key")).toMatchObject({ userId: user!.id, username: "CLINT", keyHash: "legacy-hash" });
    expect(await upgraded.modelFavorites.listForUser(user!.id)).toMatchObject([{ username: "Clint", targetId: "target", modelId: "model" }]);
    expect(await identities.authenticatedUser(user!.id)).toMatchObject({ isAdmin: true });
    await upgraded.close();
  });

  it("rolls back an incompatible SQLite identity upgrade instead of leaving partial schema", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuron-identity-rollback-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "legacy.db");
    const reservations = new SqliteReservationRepository(databasePath);
    const profiles = new SqliteReservationProfileRepository(databasePath);
    const keys = new SqliteApiKeyRepository(databasePath);
    const favorites = new SqliteModelFavoriteRepository(databasePath);
    await reservations.create({
      id: "ownerless-real-reservation",
      username: "   ",
      modelIds: [],
      targetIds: ["target"],
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      expiresAt: new Date("2026-08-01T12:15:00.000Z"),
      status: "done"
    });
    reservations.close();
    profiles.close();
    keys.close();
    favorites.close();

    expect(() => new SqliteIdentityRepository(databasePath)).toThrow("durable record(s) without an owner");

    const database = new Database(databasePath);
    expect(database.prepare("select name from sqlite_master where type='table' and name='users'").get()).toBeUndefined();
    expect(database.prepare("select name from sqlite_master where type='trigger' and name='reservations_user_insert'").get()).toBeUndefined();
    database.close();
  });
});

async function createOwner(
  repository: Awaited<ReturnType<typeof createReservationRepository>>["identities"],
  service: IdentityService
): Promise<AuthenticatedUser> {
  const account = await repository.createUser({ id: "usr_owner", username: "owner", status: "active" });
  await repository.assignGlobalRole(account.id, "role_owner");
  return (await service.authenticatedUser(account.id))!;
}
