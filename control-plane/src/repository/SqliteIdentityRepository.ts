import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { IdentityRepository } from "../domain/interfaces.js";
import type { ExternalUserLink, RegistrationInvitation, Role, Team, TeamMembership, UserAccount, UserIdentity, UserMergePreview } from "../domain/types.js";

export class SqliteIdentityRepository implements IdentityRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  async initializeLegacyUsers(adminUsernames: string[]): Promise<void> {
    this.db.transaction(() => {
      for (const username of adminUsernames) {
        const normalized = normalizeUsername(username);
        if (!normalized) continue;
        let user = this.userByNormalized(normalized);
        if (!user) {
          const now = new Date().toISOString();
          const id = userId();
          this.db.prepare("insert into users (id,username,normalized_username,status,session_version,created_at,updated_at) values (?,?,?,'active',1,?,?)").run(id, username.trim(), normalized, now, now);
          user = this.userRow(id);
        }
        this.db.prepare("insert or ignore into user_role_assignments (user_id,role_id,created_at) values (?,'role_owner',?)").run(user!.id, new Date().toISOString());
      }
      const users = this.db.prepare("select id from users").all() as Array<{ id: string }>;
      const insert = this.db.prepare("insert or ignore into user_role_assignments (user_id,role_id,created_at) values (?,'role_member',?)");
      const now = new Date().toISOString();
      for (const user of users) insert.run(user.id, now);
    })();
  }

  async createUser(input: Omit<UserAccount, "id" | "normalizedUsername" | "sessionVersion" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<UserAccount> {
    const username = input.username.trim();
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("Username is required");
    const id = input.id ?? userId();
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db.transaction(() => {
      this.db.prepare(`insert into users (id,username,normalized_username,display_name,status,session_version,created_at,updated_at,last_login_at) values (?,?,?,?,?,1,?,?,?)`)
        .run(id, username, normalized, input.displayName ?? null, input.status, createdAt.toISOString(), updatedAt.toISOString(), input.lastLoginAt?.toISOString() ?? null);
      this.db.prepare("insert into user_role_assignments (user_id,role_id,created_at) values (?,'role_member',?)").run(id, createdAt.toISOString());
    })();
    return userFromRow(this.userRow(id)!);
  }

  async getUser(id: string): Promise<UserAccount | undefined> { const row = this.userRow(id); return row ? userFromRow(row) : undefined; }
  async getUserByUsername(username: string): Promise<UserAccount | undefined> { const row = this.userByNormalized(normalizeUsername(username)); return row ? userFromRow(row) : undefined; }
  async listUsers(): Promise<UserAccount[]> { return (this.db.prepare("select * from users order by normalized_username,id").all() as Row[]).map(userFromRow); }

  async updateUser(id: string, patch: Partial<Pick<UserAccount, "displayName" | "status" | "lastLoginAt">>): Promise<UserAccount> {
    const row = this.db.transaction(() => {
      const currentRow = this.userRow(id);
      if (!currentRow) throw new Error("User not found");
      const current = userFromRow(currentRow);
      if (patch.status === "disabled" && current.status === "active") {
        const owner = this.db.prepare(`select 1 from user_role_assignments a join roles r on r.id=a.role_id join json_each(r.permissions) p where a.user_id=? and p.value='*' limit 1`).get(id);
        const ownerCount = this.db.prepare(`select count(distinct u.id) count from users u join user_role_assignments a on a.user_id=u.id join roles r on r.id=a.role_id join json_each(r.permissions) p where u.status='active' and p.value='*'`).get() as { count: number };
        if (owner && Number(ownerCount.count) <= 1) throw new Error("The final enabled Owner cannot be disabled");
      }
      this.db.prepare("update users set display_name=?,status=?,last_login_at=?,updated_at=? where id=?")
        .run(patch.displayName ?? current.displayName ?? null, patch.status ?? current.status, (patch.lastLoginAt ?? current.lastLoginAt)?.toISOString() ?? null, new Date().toISOString(), id);
      if (patch.status === "disabled") this.db.prepare("update registration_invitations set revoked_at=coalesce(revoked_at,?) where user_id=? and revoked_at is null").run(new Date().toISOString(), id);
      return this.userRow(id)!;
    })();
    return userFromRow(row);
  }

  async renameUser(id: string, input: Pick<UserAccount, "username" | "displayName">, renamedAt: Date, actorUserId?: string): Promise<UserAccount> {
    const username = input.username.trim();
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("Username is required");
    const row = this.db.transaction(() => {
      const currentRow = this.userRow(id);
      if (!currentRow) throw new Error("User not found");
      const current = userFromRow(currentRow);
      if (current.status !== "active" || current.mergedIntoUserId) throw new Error("Only an active, unmerged account can be renamed");

      const conflict = this.userByNormalized(normalized);
      if (conflict && conflict.id !== id && !(conflict.status === "disabled" && conflict.merged_into_user_id === id)) throw new Error("Username is already registered");
      const localConflict = this.db.prepare("select user_id from user_identities where provider_type='local' and provider_id='local' and subject=?").get(normalized) as { user_id: string } | undefined;
      if (localConflict && localConflict.user_id !== id) throw new Error("This local identity belongs to another account");

      let archivedAliasId: string | undefined;
      if (conflict && conflict.id !== id) {
        archivedAliasId = String(conflict.id);
        const archivedUsername = archivedMergeUsername({ id: archivedAliasId, username: String(conflict.username) });
        this.db.prepare("update users set username=?,normalized_username=?,updated_at=? where id=?").run(archivedUsername, normalizeUsername(archivedUsername), renamedAt.toISOString(), archivedAliasId);
      }

      for (const table of ["reservations", "reservation_profiles", "api_keys", "model_favorites"]) {
        this.db.prepare(`update ${table} set username=? where user_id=?`).run(username, id);
      }
      this.db.prepare("update registration_invitations set intended_username=? where user_id=? and revoked_at is null and use_count<max_uses and expires_at>?").run(username, id, renamedAt.toISOString());

      if (current.normalizedUsername !== normalized) {
        const prior = this.db.prepare("select * from user_identities where user_id=? and provider_type='local' and provider_id='local' order by created_at,id limit 1").get(id) as Row | undefined;
        this.db.prepare("delete from user_identities where user_id=? and provider_type='local' and provider_id='local'").run(id);
        if (this.db.prepare("select 1 from local_credentials where user_id=?").get(id)) {
          this.db.prepare("insert into user_identities (id,user_id,provider_type,provider_id,subject,username,created_at,last_seen_at) values (?,?,'local','local',?,?,?,?)")
            .run(prior?.id ?? `uid_${nanoid(18)}`, id, normalized, username, prior?.created_at ?? renamedAt.toISOString(), renamedAt.toISOString());
        }
      }

      this.db.prepare("update users set username=?,normalized_username=?,display_name=?,session_version=session_version+1,updated_at=? where id=?")
        .run(username, normalized, input.displayName?.trim() || null, renamedAt.toISOString(), id);
      this.db.prepare("insert into identity_audit_events (id,actor_user_id,action,subject_type,subject_id,details,created_at) values (?,?, 'users.rename','user',?,?,?)")
        .run(`audit_${nanoid(18)}`, actorUserId ?? null, id, JSON.stringify({ previousUsername: current.username, username, archivedAliasId }), renamedAt.toISOString());
      return this.userRow(id)!;
    })();
    return userFromRow(row);
  }

  async incrementSessionVersion(id: string): Promise<UserAccount> {
    if (!this.db.prepare("update users set session_version=session_version+1,updated_at=? where id=?").run(new Date().toISOString(), id).changes) throw new Error("User not found");
    return (await this.getUser(id))!;
  }

  async getLocalPasswordHash(userIdValue: string): Promise<string | undefined> {
    return (this.db.prepare("select password_hash from local_credentials where user_id=?").get(userIdValue) as { password_hash: string } | undefined)?.password_hash;
  }

  async setLocalPasswordHash(userIdValue: string, passwordHash: string): Promise<void> {
    this.db.prepare("insert into local_credentials (user_id,password_hash,updated_at) values (?,?,?) on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at")
      .run(userIdValue, passwordHash, new Date().toISOString());
  }

  async findIdentity(providerType: UserIdentity["providerType"], providerId: string, subject: string): Promise<UserIdentity | undefined> {
    const row = this.db.prepare("select * from user_identities where provider_type=? and provider_id=? and subject=?").get(providerType, providerId, subject) as Row | undefined;
    return row ? identityFromRow(row) : undefined;
  }

  async listIdentities(userIdValue: string): Promise<UserIdentity[]> {
    return (this.db.prepare("select * from user_identities where user_id=? order by provider_type,provider_id,subject").all(userIdValue) as Row[]).map(identityFromRow);
  }
  async findUsersByIdentityHint(value: string): Promise<UserAccount[]> {
    const normalized = normalizeUsername(value);
    if (!normalized) return [];
    return (this.db.prepare(`select distinct u.* from users u left join user_identities i on i.user_id=u.id
      where u.normalized_username=? or lower(trim(coalesce(i.subject,'')))=? or lower(trim(coalesce(i.username,'')))=? or lower(trim(coalesce(i.email,'')))=?
      order by u.normalized_username,u.id`).all(normalized, normalized, normalized, normalized) as Row[]).map(userFromRow);
  }

  async saveIdentity(input: Omit<UserIdentity, "id" | "createdAt" | "lastSeenAt"> & { id?: string; createdAt?: Date; lastSeenAt?: Date }): Promise<UserIdentity> {
    const existing = await this.findIdentity(input.providerType, input.providerId, input.subject);
    if (existing && existing.userId !== input.userId) throw new Error("This external identity is already linked to another NeurOn user");
    const now = input.lastSeenAt ?? new Date();
    this.db.prepare(`insert into user_identities (id,user_id,provider_type,provider_id,subject,username,email,created_at,last_seen_at) values (?,?,?,?,?,?,?,?,?)
      on conflict(provider_type,provider_id,subject) do update set username=excluded.username,email=excluded.email,last_seen_at=excluded.last_seen_at`)
      .run(input.id ?? `uid_${nanoid(18)}`, input.userId, input.providerType, input.providerId, input.subject, input.username ?? null, input.email ?? null, (input.createdAt ?? now).toISOString(), now.toISOString());
    return (await this.findIdentity(input.providerType, input.providerId, input.subject))!;
  }

  async listRoles(scope?: Role["scope"]): Promise<Role[]> {
    const rows = scope ? this.db.prepare("select * from roles where scope=? order by name,id").all(scope) : this.db.prepare("select * from roles order by scope,name,id").all();
    return (rows as Row[]).map(roleFromRow);
  }
  async getRole(id: string): Promise<Role | undefined> { const row = this.db.prepare("select * from roles where id=?").get(id) as Row | undefined; return row ? roleFromRow(row) : undefined; }

  async createRole(input: Omit<Role, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Role> {
    const now = input.createdAt ?? new Date(); const id = input.id ?? `role_${nanoid(16)}`;
    this.db.prepare("insert into roles (id,name,description,scope,permissions,system_key,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(id, input.name.trim(), input.description ?? null, input.scope, JSON.stringify(unique(input.permissions)), input.systemKey ?? null, now.toISOString(), (input.updatedAt ?? now).toISOString());
    return (await this.getRole(id))!;
  }

  async updateRole(id: string, input: Pick<Role, "name" | "description" | "permissions">): Promise<Role> {
    const role = await this.getRole(id); if (!role) throw new Error("Role not found");
    if (role.systemKey) throw new Error("Built-in roles cannot be modified");
    this.db.prepare("update roles set name=?,description=?,permissions=?,updated_at=? where id=?").run(input.name.trim(), input.description ?? null, JSON.stringify(unique(input.permissions)), new Date().toISOString(), id);
    return (await this.getRole(id))!;
  }

  async deleteRole(id: string): Promise<boolean> { const role = await this.getRole(id); if (!role) return false; if (role.systemKey) throw new Error("Built-in roles cannot be deleted"); return this.db.prepare("delete from roles where id=?").run(id).changes > 0; }
  async assignGlobalRole(userIdValue: string, roleId: string): Promise<void> { const role = await this.getRole(roleId); if (!role || role.scope !== "global") throw new Error("Global role not found"); this.db.prepare("insert or ignore into user_role_assignments (user_id,role_id,created_at) values (?,?,?)").run(userIdValue, roleId, new Date().toISOString()); }
  async revokeGlobalRole(userIdValue: string, roleId: string): Promise<boolean> {
    return this.db.transaction(() => {
      const roleRow = this.db.prepare("select * from roles where id=?").get(roleId) as Row | undefined;
      if (!roleRow) return false;
      const assignment = this.db.prepare("select 1 from user_role_assignments where user_id=? and role_id=?").get(userIdValue, roleId);
      if (!assignment) return false;
      const role = roleFromRow(roleRow);
      if (role.systemKey === "owner") {
        const ownerCount = this.db.prepare(`select count(distinct u.id) count from users u join user_role_assignments a on a.user_id=u.id join roles r on r.id=a.role_id join json_each(r.permissions) p where u.status='active' and p.value='*'`).get() as { count: number };
        if (Number(ownerCount.count) <= 1) throw new Error("The final enabled Owner cannot be removed");
      }
      return this.db.prepare("delete from user_role_assignments where user_id=? and role_id=?").run(userIdValue, roleId).changes > 0;
    })();
  }
  async listGlobalRolesForUser(userIdValue: string): Promise<Role[]> { return (this.db.prepare("select r.* from roles r join user_role_assignments a on a.role_id=r.id where a.user_id=? and r.scope='global' order by r.name,r.id").all(userIdValue) as Row[]).map(roleFromRow); }
  async countEnabledUsersWithPermission(permission: string): Promise<number> { const users = await this.listUsers(); let count = 0; for (const user of users) if (user.status === "active" && await this.hasPermission(user.id, permission)) count += 1; return count; }

  async createTeam(input: Omit<Team, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Team> {
    const id = input.id ?? `team_${nanoid(16)}`; const now = input.createdAt ?? new Date();
    this.db.transaction(() => { this.db.prepare("insert into teams (id,name,description,parent_team_id,created_at,updated_at) values (?,?,?,?,?,?)").run(id, input.name.trim(), input.description ?? null, input.parentTeamId ?? null, now.toISOString(), (input.updatedAt ?? now).toISOString()); this.rebuildTeamHierarchy(); })();
    return (await this.getTeam(id))!;
  }
  async getTeam(id: string): Promise<Team | undefined> { const row = this.db.prepare("select * from teams where id=?").get(id) as Row | undefined; return row ? teamFromRow(row) : undefined; }
  async listTeams(): Promise<Team[]> { return (this.db.prepare("select * from teams order by name,id").all() as Row[]).map(teamFromRow); }
  async updateTeam(id: string, input: Pick<Team, "name" | "description" | "parentTeamId">): Promise<Team> {
    this.db.transaction(() => {
      if (input.parentTeamId && (input.parentTeamId === id || this.db.prepare("select 1 from team_hierarchy where ancestor_team_id=? and descendant_team_id=?").get(id, input.parentTeamId))) throw new Error("Team hierarchy cannot contain a cycle");
      if (!this.db.prepare("update teams set name=?,description=?,parent_team_id=?,updated_at=? where id=?").run(input.name.trim(), input.description ?? null, input.parentTeamId ?? null, new Date().toISOString(), id).changes) throw new Error("Team not found");
      this.rebuildTeamHierarchy();
    })(); return (await this.getTeam(id))!;
  }
  async deleteTeam(id: string): Promise<boolean> {
    if (this.hasColumn("reservation_profiles", "team_id") && this.db.prepare("select 1 from reservation_profiles where team_id=? limit 1").get(id)) throw new Error("Move or delete this team's shared profiles before deleting the team");
    return this.db.prepare("delete from teams where id=?").run(id).changes > 0;
  }

  async setTeamMembership(input: Omit<TeamMembership, "createdAt"> & { createdAt?: Date }): Promise<TeamMembership> {
    const role = await this.getRole(input.roleId); if (!role || role.scope !== "team") throw new Error("Team role not found"); const reference = input.sourceReference ?? "";
    this.db.prepare(`insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) values (?,?,?,?,?,?)
      on conflict(team_id,user_id,source,source_reference) do update set role_id=excluded.role_id`)
      .run(input.teamId, input.userId, input.roleId, input.source, reference, (input.createdAt ?? new Date()).toISOString());
    return membershipFromRow(this.db.prepare("select * from team_memberships where team_id=? and user_id=? and source=? and source_reference=?").get(input.teamId, input.userId, input.source, reference) as Row);
  }
  async removeTeamMembership(teamId: string, userIdValue: string, source?: TeamMembership["source"], sourceReference?: string): Promise<boolean> {
    if (source && sourceReference !== undefined) return this.db.prepare("delete from team_memberships where team_id=? and user_id=? and source=? and source_reference=?").run(teamId, userIdValue, source, sourceReference).changes > 0;
    if (source) return this.db.prepare("delete from team_memberships where team_id=? and user_id=? and source=?").run(teamId, userIdValue, source).changes > 0;
    return this.db.prepare("delete from team_memberships where team_id=? and user_id=?").run(teamId, userIdValue).changes > 0;
  }
  async reconcileOidcTeamMemberships(userIdValue: string, providerId: string, memberships: Array<Pick<TeamMembership, "teamId" | "roleId" | "sourceReference">>): Promise<void> {
    const prefix = `${providerId}:`;
    this.db.transaction(() => {
      for (const membership of memberships) {
        if (!membership.sourceReference?.startsWith(prefix)) throw new Error("OIDC membership source does not match its provider");
        const valid = this.db.prepare("select 1 from teams t join roles r on r.id=? and r.scope='team' where t.id=?").get(membership.roleId, membership.teamId);
        if (!valid) throw new Error("OIDC membership references an unknown team or team role");
      }
      this.db.prepare("delete from team_memberships where user_id=? and source='oidc' and substr(source_reference,1,length(?))=?").run(userIdValue, prefix, prefix);
      const insert = this.db.prepare("insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) values (?,?,?,'oidc',?,?)");
      for (const membership of memberships) insert.run(membership.teamId, userIdValue, membership.roleId, membership.sourceReference, new Date().toISOString());
    })();
  }
  async listTeamMembershipsForUser(userIdValue: string): Promise<TeamMembership[]> { return (this.db.prepare("select * from team_memberships where user_id=? order by team_id,source,source_reference").all(userIdValue) as Row[]).map(membershipFromRow); }
  async listTeamMemberships(teamId: string): Promise<TeamMembership[]> { return (this.db.prepare("select * from team_memberships where team_id=? order by user_id,source,source_reference").all(teamId) as Row[]).map(membershipFromRow); }
  async isUserInAnyTeam(userIdValue: string, teamIds: string[]): Promise<boolean> { if (!teamIds.length) return false; const placeholders = teamIds.map(() => "?").join(","); return Boolean(this.db.prepare(`select 1 from team_memberships m join team_hierarchy h on h.descendant_team_id=m.team_id where m.user_id=? and h.ancestor_team_id in (${placeholders}) limit 1`).get(userIdValue, ...teamIds)); }
  async matchesUserAudience(userIdValue: string, audienceUserIds: string[]): Promise<boolean> { if (!audienceUserIds.length) return false; const placeholders=audienceUserIds.map(()=>"?").join(","); return Boolean(this.db.prepare(`select 1 from users where id in (${placeholders}) and (id=? or merged_into_user_id=?) limit 1`).get(...audienceUserIds,userIdValue,userIdValue)); }

  async createInvitation(input: Omit<RegistrationInvitation, "id" | "useCount" | "createdAt"> & { id?: string; useCount?: number; createdAt?: Date }): Promise<RegistrationInvitation> {
    const id = input.id ?? `invite_${nanoid(18)}`; this.db.prepare(`insert into registration_invitations (id,token_hash,user_id,intended_username,initial_role_id,created_by_user_id,expires_at,max_uses,use_count,revoked_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.tokenHash, input.userId ?? null, input.intendedUsername ?? null, input.initialRoleId ?? null, input.createdByUserId ?? null, input.expiresAt.toISOString(), input.maxUses, input.useCount ?? 0, input.revokedAt?.toISOString() ?? null, (input.createdAt ?? new Date()).toISOString()); return invitationFromRow(this.invitationRow(id)!);
  }
  async getInvitationByTokenHash(tokenHash: string): Promise<RegistrationInvitation | undefined> { const row = this.db.prepare("select * from registration_invitations where token_hash=?").get(tokenHash) as Row | undefined; return row ? invitationFromRow(row) : undefined; }
  async consumeInvitation(id: string, now: Date): Promise<RegistrationInvitation> { const result = this.db.prepare("update registration_invitations set use_count=use_count+1 where id=? and revoked_at is null and expires_at>? and use_count<max_uses").run(id, now.toISOString()); if (!result.changes) throw new Error("Registration link is expired, revoked, or already used"); return invitationFromRow(this.invitationRow(id)!); }
  async redeemInvitation(input: { tokenHash: string; username: string; displayName?: string; passwordHash: string; consumedAt: Date }): Promise<UserAccount> {
    const completed = this.db.transaction(() => {
      const now = input.consumedAt.toISOString();
      const invitationRow = this.db.prepare(`select * from registration_invitations where token_hash=? and revoked_at is null and expires_at>? and use_count<max_uses`).get(input.tokenHash, now) as Row | undefined;
      if (!invitationRow) throw new Error("Registration link is expired, revoked, or already used");
      const invitation = invitationFromRow(invitationRow);
      const normalized = normalizeUsername(input.username);
      if (!normalized) throw new Error("Username is required");
      if (invitation.intendedUsername && normalizeUsername(invitation.intendedUsername) !== normalized) throw new Error("This registration link is for a different username");

      let userRow: Row;
      if (invitation.userId) {
        const existing = this.userRow(invitation.userId);
        if (!existing) throw new Error("Invitation user not found");
        if (String(existing.normalized_username) !== normalized) throw new Error("This claim link belongs to a different username");
        if (existing.merged_into_user_id) throw new Error("This account has been merged into another user");
        if (existing.status !== "active") throw new Error("This account is disabled; ask an Owner to reactivate it before using a claim link");
        this.db.prepare("update users set display_name=coalesce(?,display_name),updated_at=? where id=?").run(input.displayName ?? null, now, invitation.userId);
        userRow = this.userRow(invitation.userId)!;
      } else {
        if (this.userByNormalized(normalized)) throw new Error("Username is already registered; ask an administrator for an account claim link");
        const id = userId();
        this.db.prepare(`insert into users (id,username,normalized_username,display_name,status,session_version,created_at,updated_at) values (?,?,?,?,'active',1,?,?)`)
          .run(id, input.username.trim(), normalized, input.displayName ?? null, now, now);
        this.db.prepare("insert into user_role_assignments (user_id,role_id,created_at) values (?,'role_member',?)").run(id, now);
        userRow = this.userRow(id)!;
      }

      const userIdValue = String(userRow.id);
      const conflictingIdentity = this.db.prepare("select user_id from user_identities where provider_type='local' and provider_id='local' and subject=?").get(normalized) as { user_id: string } | undefined;
      if (conflictingIdentity && conflictingIdentity.user_id !== userIdValue) throw new Error("This local identity belongs to another account");
      this.db.prepare(`insert into local_credentials (user_id,password_hash,updated_at) values (?,?,?) on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at`)
        .run(userIdValue, input.passwordHash, now);
      this.db.prepare(`insert into user_identities (id,user_id,provider_type,provider_id,subject,username,created_at,last_seen_at) values (?,?,'local','local',?,?,?,?)
        on conflict(provider_type,provider_id,subject) do update set username=excluded.username,last_seen_at=excluded.last_seen_at`)
        .run(`uid_${nanoid(18)}`, userIdValue, normalized, String(userRow.username), now, now);
      if (invitation.initialRoleId) {
        const role = this.db.prepare("select scope from roles where id=?").get(invitation.initialRoleId) as { scope: string } | undefined;
        if (role?.scope !== "global") throw new Error("Invitation role not found");
        this.db.prepare("insert or ignore into user_role_assignments (user_id,role_id,created_at) values (?,?,?)").run(userIdValue, invitation.initialRoleId, now);
      }
      this.db.prepare("update registration_invitations set use_count=use_count+1 where id=?").run(invitation.id);
      this.db.prepare("update users set session_version=session_version+1,updated_at=? where id=?").run(now, userIdValue);
      return this.userRow(userIdValue)!;
    })();
    return userFromRow(completed);
  }
  async revokeInvitation(id: string, revokedAt: Date): Promise<boolean> { return this.db.prepare("update registration_invitations set revoked_at=? where id=? and revoked_at is null").run(revokedAt.toISOString(), id).changes > 0; }
  async listInvitations(): Promise<RegistrationInvitation[]> { return (this.db.prepare("select * from registration_invitations order by created_at desc,id").all() as Row[]).map(invitationFromRow); }

  async getExternalUserLink(integration: string, externalSubject: string): Promise<ExternalUserLink | undefined> { const row = this.db.prepare("select * from external_user_links where integration=? and external_subject=?").get(integration, externalSubject) as Row | undefined; return row ? externalLinkFromRow(row) : undefined; }
  async saveExternalUserLink(input: Omit<ExternalUserLink, "createdAt" | "lastSeenAt"> & { createdAt?: Date; lastSeenAt?: Date }): Promise<ExternalUserLink> { const existing = await this.getExternalUserLink(input.integration,input.externalSubject); if (existing && existing.userId !== input.userId) throw new Error("External user is already linked to another NeurOn account"); const now=input.lastSeenAt??new Date(); this.db.prepare(`insert into external_user_links (integration,external_subject,user_id,source,created_at,last_seen_at) values (?,?,?,?,?,?) on conflict(integration,external_subject) do update set source=excluded.source,last_seen_at=excluded.last_seen_at`).run(input.integration,input.externalSubject,input.userId,input.source,(input.createdAt??now).toISOString(),now.toISOString()); return (await this.getExternalUserLink(input.integration,input.externalSubject))!; }
  async listExternalUserLinks(integration?: string): Promise<ExternalUserLink[]> { const rows=integration?this.db.prepare("select * from external_user_links where integration=? order by external_subject").all(integration):this.db.prepare("select * from external_user_links order by integration,external_subject").all(); return (rows as Row[]).map(externalLinkFromRow); }
  async deleteExternalUserLink(integration:string,externalSubject:string):Promise<boolean>{return this.db.prepare("delete from external_user_links where integration=? and external_subject=?").run(integration,externalSubject).changes>0}
  async previewUserMerge(sourceUserId:string,targetUserId:string):Promise<UserMergePreview>{if(sourceUserId===targetUserId)throw new Error("Source and target users must be different");const source=await this.getUser(sourceUserId),target=await this.getUser(targetUserId);if(!source||!target)throw new Error("Source or target user not found");const count=(table:string)=>Number((this.db.prepare(`select count(*) count from ${table} where user_id=?`).get(sourceUserId) as {count:number}).count);return{sourceUser:{id:source.id,username:source.username,status:source.status},targetUser:{id:target.id,username:target.username,status:target.status},counts:{reservations:count("reservations"),profiles:count("reservation_profiles"),apiKeys:count("api_keys"),favorites:count("model_favorites"),identities:count("user_identities"),teamMemberships:count("team_memberships"),externalUserLinks:count("external_user_links")}}}

  async mergeUsers(sourceUserId: string, targetUserId: string, mergedAt: Date, actorUserId?: string): Promise<void> {
    if(sourceUserId===targetUserId) throw new Error("Source and target users must be different");
    this.db.transaction(() => {
      const source=this.userRow(sourceUserId); const target=this.userRow(targetUserId); if(!source||!target) throw new Error("Source or target user not found"); if(source.merged_into_user_id) throw new Error("Source user has already been merged"); if(target.status!=="active"||target.merged_into_user_id) throw new Error("Merge destination must be an active user");
      this.db.prepare("update reservations set user_id=?,username=? where user_id=?").run(targetUserId,target.username,sourceUserId);
      this.db.prepare("update reservation_profiles set user_id=?,username=? where user_id=?").run(targetUserId,target.username,sourceUserId);
      this.db.prepare("update api_keys set user_id=?,username=? where user_id=?").run(targetUserId,target.username,sourceUserId);
      this.db.prepare("delete from model_favorites where user_id=? and exists (select 1 from model_favorites t where t.user_id=? and t.target_id=model_favorites.target_id and t.model_id=model_favorites.model_id)").run(sourceUserId,targetUserId);
      this.db.prepare("update model_favorites set user_id=?,username=? where user_id=?").run(targetUserId,target.username,sourceUserId);
      this.db.prepare("update user_identities set user_id=? where user_id=?").run(targetUserId,sourceUserId);
      this.db.prepare("insert or ignore into user_role_assignments (user_id,role_id,created_at) select ?,role_id,created_at from user_role_assignments where user_id=?").run(targetUserId,sourceUserId);
      this.db.prepare("delete from user_role_assignments where user_id=?").run(sourceUserId);
      this.db.prepare(`update team_memberships as target_membership set role_id=(select source_membership.role_id from team_memberships source_membership where source_membership.user_id=? and source_membership.team_id=target_membership.team_id and source_membership.source=target_membership.source and source_membership.source_reference=target_membership.source_reference)
        where target_membership.user_id=? and exists (select 1 from team_memberships source_membership join roles source_role on source_role.id=source_membership.role_id join roles target_role on target_role.id=target_membership.role_id where source_membership.user_id=? and source_membership.team_id=target_membership.team_id and source_membership.source=target_membership.source and source_membership.source_reference=target_membership.source_reference and json_array_length(source_role.permissions)>json_array_length(target_role.permissions))`).run(sourceUserId,targetUserId,sourceUserId);
      this.db.prepare("insert or ignore into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) select team_id,?,role_id,source,source_reference,created_at from team_memberships where user_id=?").run(targetUserId,sourceUserId);
      this.db.prepare("delete from team_memberships where user_id=?").run(sourceUserId);
      this.db.prepare("update registration_invitations set user_id=? where user_id=?").run(targetUserId,sourceUserId);
      this.db.prepare("update external_user_links set user_id=? where user_id=?").run(targetUserId,sourceUserId);
      this.db.prepare("update users set merged_into_user_id=?,updated_at=? where merged_into_user_id=?").run(targetUserId,mergedAt.toISOString(),sourceUserId);
      const targetRows=this.db.prepare("select id,target_json from capacity_targets").all() as Array<{id:string;target_json:string}>;
      for(const row of targetRows){const target=JSON.parse(row.target_json) as {audience?:{scope?:string;userIds?:string[]}};if(target.audience?.scope!=="users"||!target.audience.userIds?.includes(sourceUserId))continue;target.audience.userIds=Array.from(new Set(target.audience.userIds.map(id=>id===sourceUserId?targetUserId:id)));this.db.prepare("update capacity_targets set target_json=? where id=?").run(JSON.stringify(target),row.id);}
      if(!this.db.prepare("select 1 from local_credentials where user_id=?").get(targetUserId)) this.db.prepare("update local_credentials set user_id=? where user_id=?").run(targetUserId,sourceUserId); else this.db.prepare("delete from local_credentials where user_id=?").run(sourceUserId);
      this.db.prepare("update users set status='disabled',merged_into_user_id=?,session_version=session_version+1,updated_at=? where id=?").run(targetUserId,mergedAt.toISOString(),sourceUserId);
      this.db.prepare("update users set session_version=session_version+1,updated_at=? where id=?").run(mergedAt.toISOString(),targetUserId);
      this.db.prepare("insert into identity_audit_events (id,actor_user_id,action,subject_type,subject_id,details,created_at) values (?,?, 'users.merge','user',?,?,?)").run(`audit_${nanoid(18)}`,actorUserId??null,targetUserId,JSON.stringify({sourceUserId,targetUserId}),mergedAt.toISOString());
    })();
  }

  private userRow(id: string): Row | undefined { return this.db.prepare("select * from users where id=?").get(id) as Row | undefined; }
  private userByNormalized(value: string): Row | undefined { return this.db.prepare("select * from users where normalized_username=?").get(value) as Row | undefined; }
  private invitationRow(id: string): Row | undefined { return this.db.prepare("select * from registration_invitations where id=?").get(id) as Row | undefined; }
  private async hasPermission(userIdValue:string, permission:string):Promise<boolean>{ const roles=await this.listGlobalRolesForUser(userIdValue); return roles.some(role=>role.permissions.includes("*")||role.permissions.includes(permission)); }

  private rebuildTeamHierarchy(): void {
    const teams=this.db.prepare("select id,parent_team_id from teams").all() as Array<{id:string;parent_team_id:string|null}>; const parents=new Map(teams.map(team=>[team.id,team.parent_team_id])); const insert=this.db.prepare("insert into team_hierarchy (ancestor_team_id,descendant_team_id,depth) values (?,?,?)"); this.db.prepare("delete from team_hierarchy").run();
    for(const team of teams){ const seen=new Set<string>(); let current:string|null=team.id; let depth=0; while(current){ if(seen.has(current)) throw new Error("Team hierarchy contains a cycle"); seen.add(current); insert.run(current,team.id,depth); current=parents.get(current)??null; depth+=1; } }
  }

  private migrate(): void {
    this.db.transaction(() => {
    this.db.exec(`
      create table if not exists users (id text primary key,username text not null,normalized_username text not null unique,display_name text,status text not null check(status in ('active','disabled')),session_version integer not null default 1,merged_into_user_id text references users(id),created_at text not null,updated_at text not null,last_login_at text);
      create table if not exists user_identities (id text primary key,user_id text not null references users(id) on delete cascade,provider_type text not null check(provider_type in ('local','github','oidc')),provider_id text not null,subject text not null,username text,email text,created_at text not null,last_seen_at text not null,unique(provider_type,provider_id,subject));
      create index if not exists idx_user_identities_user on user_identities(user_id);
      create table if not exists local_credentials (user_id text primary key references users(id) on delete cascade,password_hash text not null,updated_at text not null);
      create table if not exists roles (id text primary key,name text not null unique,description text,scope text not null check(scope in ('global','team')),permissions text not null,system_key text unique,created_at text not null,updated_at text not null);
      create table if not exists user_role_assignments (user_id text not null references users(id) on delete cascade,role_id text not null references roles(id) on delete restrict,created_at text not null,primary key(user_id,role_id));
      create table if not exists teams (id text primary key,name text not null unique,description text,parent_team_id text references teams(id) on delete restrict,created_at text not null,updated_at text not null);
      create table if not exists team_hierarchy (ancestor_team_id text not null references teams(id) on delete cascade,descendant_team_id text not null references teams(id) on delete cascade,depth integer not null check(depth>=0),primary key(ancestor_team_id,descendant_team_id));
      create index if not exists idx_team_hierarchy_descendant on team_hierarchy(descendant_team_id,ancestor_team_id);
      create table if not exists team_memberships (team_id text not null references teams(id) on delete cascade,user_id text not null references users(id) on delete cascade,role_id text not null references roles(id) on delete restrict,source text not null check(source in ('manual','oidc')),source_reference text not null default '',created_at text not null,primary key(team_id,user_id,source,source_reference));
      create index if not exists idx_team_memberships_user on team_memberships(user_id,team_id);
      create table if not exists registration_invitations (id text primary key,token_hash text not null unique,user_id text references users(id) on delete cascade,intended_username text,initial_role_id text references roles(id),created_by_user_id text references users(id) on delete set null,expires_at text not null,max_uses integer not null check(max_uses>0),use_count integer not null default 0,revoked_at text,created_at text not null);
      create table if not exists external_user_links (integration text not null,external_subject text not null,user_id text not null references users(id) on delete cascade,source text not null check(source in ('metadata','rule','admin')),created_at text not null,last_seen_at text not null,primary key(integration,external_subject));
      create table if not exists identity_audit_events (id text primary key,actor_user_id text references users(id) on delete set null,action text not null,subject_type text not null,subject_id text not null,details text not null default '{}',created_at text not null);
    `);
    for(const table of ["reservations","reservation_profiles","api_keys","model_favorites"]) if(!this.hasColumn(table,"user_id")) this.db.exec(`alter table ${table} add column user_id text`);
    const ownerRows=this.db.prepare(`select username,created_at from reservations where synthetic=0 and username not in ('traffic','profile-advisor') union all select username,created_at from reservation_profiles union all select username,created_at from api_keys union all select username,created_at from model_favorites`).all() as Array<{username:string;created_at:string}>;
    const ownersByNormalized=new Map<string,{username:string;created_at:string}>();
    for(const owner of ownerRows){const normalized=normalizeUsername(owner.username);const current=ownersByNormalized.get(normalized);if(normalized&&(!current||owner.created_at<current.created_at))ownersByNormalized.set(normalized,owner);}
    const insertUser=this.db.prepare("insert or ignore into users (id,username,normalized_username,status,session_version,created_at,updated_at) values (?,?,?,'active',1,?,?)");
    for(const [normalized,owner] of ownersByNormalized){insertUser.run(legacyUserId(normalized),owner.username,normalized,owner.created_at,new Date().toISOString());}
    for(const table of ["reservations","reservation_profiles","api_keys","model_favorites"]){const unowned=this.db.prepare(`select rowid,username from ${table} where user_id is null`).all() as Array<{rowid:number;username:string}>;const assign=this.db.prepare(`update ${table} set user_id=? where rowid=?`);for(const row of unowned){const user=this.userByNormalized(normalizeUsername(row.username));if(user)assign.run(user.id,row.rowid);}}
    const orphanedOwners = Number((this.db.prepare(`select
      (select count(*) from reservations where synthetic=0 and user_id is null) +
      (select count(*) from reservation_profiles where user_id is null) +
      (select count(*) from api_keys where user_id is null) +
      (select count(*) from model_favorites where user_id is null) as count`).get() as { count: number }).count);
    if (orphanedOwners > 0) throw new Error(`SQLite user migration found ${orphanedOwners} durable record(s) without an owner`);
    this.db.exec(`
      delete from model_favorites where rowid not in (select min(rowid) from model_favorites group by user_id,target_id,model_id);
      create unique index if not exists idx_model_favorites_user_deployment on model_favorites(user_id,target_id,model_id);
      create index if not exists idx_reservations_user on reservations(user_id,created_at);
      create index if not exists idx_reservation_profiles_user on reservation_profiles(user_id,name);
      create index if not exists idx_api_keys_user on api_keys(user_id,created_at);
      create trigger if not exists reservations_user_insert before insert on reservations
        when new.synthetic=0 and (new.user_id is null or not exists(select 1 from users where id=new.user_id)) begin select raise(abort,'real reservation requires a valid user'); end;
      create trigger if not exists reservations_user_update before update of user_id,synthetic on reservations
        when new.synthetic=0 and (new.user_id is null or not exists(select 1 from users where id=new.user_id)) begin select raise(abort,'real reservation requires a valid user'); end;
      create trigger if not exists reservation_profiles_user_insert before insert on reservation_profiles
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'profile requires a valid user'); end;
      create trigger if not exists reservation_profiles_user_update before update of user_id on reservation_profiles
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'profile requires a valid user'); end;
      create trigger if not exists api_keys_user_insert before insert on api_keys
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'API key requires a valid user'); end;
      create trigger if not exists api_keys_user_update before update of user_id on api_keys
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'API key requires a valid user'); end;
      create trigger if not exists model_favorites_user_insert before insert on model_favorites
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'favorite requires a valid user'); end;
      create trigger if not exists model_favorites_user_update before update of user_id on model_favorites
        when new.user_id is null or not exists(select 1 from users where id=new.user_id) begin select raise(abort,'favorite requires a valid user'); end;
    `);
    this.seedRoles(); this.rebuildTeamHierarchy();
    })();
  }
  private hasColumn(table:string,column:string):boolean{return (this.db.prepare(`pragma table_info(${table})`).all() as Array<{name:string}>).some(value=>value.name===column);}
  private seedRoles():void{const now=new Date().toISOString(); const roles:Array<[string,string,string,string[],string]>=[
    ["role_owner","Owner","global",["*"],"owner"],["role_admin","Administrator","global",["users.manage","users.merge","roles.manage","teams.manage","targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all","assistant.configure","auth.manage","system.manage"],"administrator"],["role_operator","Operator","global",["targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all"],"operator"],["role_member","Member","global",["targets.read","targets.use","reservations.create","reservations.manage_own","profiles.manage_own","api_keys.manage_own","favorites.manage_own","reports.read_own"],"member"],["role_viewer","Viewer","global",["targets.read","reports.read_own"],"viewer"],["role_team_owner","Team Owner","team",["team.manage","team.members.manage","team.profiles.manage","team.reports.read"],"team-owner"],["role_team_manager","Team Manager","team",["team.members.manage","team.profiles.manage","team.reports.read"],"team-manager"],["role_team_member","Team Member","team",["team.profiles.use","team.reports.read"],"team-member"],["role_team_viewer","Team Viewer","team",["team.reports.read"],"team-viewer"]]; const insert=this.db.prepare("insert or ignore into roles (id,name,scope,permissions,system_key,created_at,updated_at) values (?,?,?,?,?,?,?)"); for(const role of roles) insert.run(role[0],role[1],role[2],JSON.stringify(role[3]),role[4],now,now);}
}

type Row=Record<string,unknown>;
function userFromRow(row:Row):UserAccount{return{id:String(row.id),username:String(row.username),normalizedUsername:String(row.normalized_username),displayName:nullable(row.display_name),status:row.status as UserAccount["status"],sessionVersion:Number(row.session_version),mergedIntoUserId:nullable(row.merged_into_user_id),createdAt:new Date(String(row.created_at)),updatedAt:new Date(String(row.updated_at)),lastLoginAt:date(row.last_login_at)}}
function identityFromRow(row:Row):UserIdentity{return{id:String(row.id),userId:String(row.user_id),providerType:row.provider_type as UserIdentity["providerType"],providerId:String(row.provider_id),subject:String(row.subject),username:nullable(row.username),email:nullable(row.email),createdAt:new Date(String(row.created_at)),lastSeenAt:new Date(String(row.last_seen_at))}}
function roleFromRow(row:Row):Role{return{id:String(row.id),name:String(row.name),description:nullable(row.description),scope:row.scope as Role["scope"],permissions:JSON.parse(String(row.permissions)) as string[],systemKey:nullable(row.system_key),createdAt:new Date(String(row.created_at)),updatedAt:new Date(String(row.updated_at))}}
function teamFromRow(row:Row):Team{return{id:String(row.id),name:String(row.name),description:nullable(row.description),parentTeamId:nullable(row.parent_team_id),createdAt:new Date(String(row.created_at)),updatedAt:new Date(String(row.updated_at))}}
function membershipFromRow(row:Row):TeamMembership{return{teamId:String(row.team_id),userId:String(row.user_id),roleId:String(row.role_id),source:row.source as TeamMembership["source"],sourceReference:nullable(row.source_reference)||undefined,createdAt:new Date(String(row.created_at))}}
function invitationFromRow(row:Row):RegistrationInvitation{return{id:String(row.id),tokenHash:String(row.token_hash),userId:nullable(row.user_id),intendedUsername:nullable(row.intended_username),initialRoleId:nullable(row.initial_role_id),createdByUserId:nullable(row.created_by_user_id),expiresAt:new Date(String(row.expires_at)),maxUses:Number(row.max_uses),useCount:Number(row.use_count),revokedAt:date(row.revoked_at),createdAt:new Date(String(row.created_at))}}
function externalLinkFromRow(row:Row):ExternalUserLink{return{integration:String(row.integration),externalSubject:String(row.external_subject),userId:String(row.user_id),source:row.source as ExternalUserLink["source"],createdAt:new Date(String(row.created_at)),lastSeenAt:new Date(String(row.last_seen_at))}}
function normalizeUsername(value:string):string{return value.trim().toLocaleLowerCase("en-US")}
function archivedMergeUsername(user:{id:string;username:string}):string{return`${user.username} [merged ${user.id}]`}
function legacyUserId(value:string):string{return`usr_${crypto.createHash("sha256").update(value).digest("hex").slice(0,24)}`}
function userId():string{return`usr_${nanoid(20)}`}
function unique(values:string[]):string[]{return Array.from(new Set(values.map(v=>v.trim()).filter(Boolean))).sort()}
function nullable(value:unknown):string|undefined{return value==null?undefined:String(value)}
function date(value:unknown):Date|undefined{return value==null?undefined:new Date(String(value))}
