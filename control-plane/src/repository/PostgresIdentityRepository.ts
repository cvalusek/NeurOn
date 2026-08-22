import { nanoid } from "nanoid";
import type pg from "pg";
import type { IdentityRepository } from "../domain/interfaces.js";
import type { ExternalUserLink, RegistrationInvitation, Role, Team, TeamMembership, UserAccount, UserIdentity, UserMergePreview } from "../domain/types.js";

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async initializeLegacyUsers(adminUsernames: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const username of adminUsernames) {
        const normalized = normalizeUsername(username);
        if (!normalized) continue;
        const existing = await client.query<{ id: string }>("select id from users where normalized_username=$1", [normalized]);
        let userIdValue = existing.rows[0]?.id;
        if (!userIdValue) {
          userIdValue = userId();
          await client.query(
            "insert into users (id,username,normalized_username,status,session_version,created_at,updated_at) values ($1,$2,$3,'active',1,now(),now())",
            [userIdValue, username.trim(), normalized]
          );
        }
        await client.query("insert into user_role_assignments (user_id,role_id,created_at) values ($1,'role_owner',now()) on conflict do nothing", [userIdValue]);
      }
      const users = await client.query<{ id: string }>("select id from users");
      for (const user of users.rows) {
        await client.query("insert into user_role_assignments (user_id,role_id,created_at) values ($1,'role_member',now()) on conflict do nothing", [user.id]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createUser(input: Omit<UserAccount, "id" | "normalizedUsername" | "sessionVersion" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<UserAccount> {
    const username = input.username.trim();
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("Username is required");
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const result = await this.pool.query(
      `insert into users (id,username,normalized_username,display_name,status,session_version,created_at,updated_at,last_login_at)
       values ($1,$2,$3,$4,$5,1,$6,$7,$8) returning *`,
      [input.id ?? userId(), username, normalized, input.displayName ?? null, input.status, createdAt, updatedAt, input.lastLoginAt ?? null]
    );
    const user = userFromRow(result.rows[0]);
    await this.assignGlobalRole(user.id, "role_member");
    return user;
  }

  async getUser(id: string): Promise<UserAccount | undefined> {
    const result = await this.pool.query("select * from users where id=$1", [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async getUserByUsername(username: string): Promise<UserAccount | undefined> {
    const result = await this.pool.query("select * from users where normalized_username=$1", [normalizeUsername(username)]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async listUsers(): Promise<UserAccount[]> {
    const result = await this.pool.query("select * from users order by normalized_username,id");
    return result.rows.map(userFromRow);
  }

  async updateUser(id: string, patch: Partial<Pick<UserAccount, "displayName" | "status" | "lastLoginAt">>): Promise<UserAccount> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('neuron:identity-owner'))");
      const currentResult = await client.query("select * from users where id=$1 for update", [id]);
      if (!currentResult.rows[0]) throw new Error("User not found");
      const current = userFromRow(currentResult.rows[0]);
      if (patch.status === "disabled" && current.status === "active") {
        const owner = await client.query("select 1 from user_role_assignments a join roles r on r.id=a.role_id where a.user_id=$1 and r.permissions ? '*'", [id]);
        if (owner.rows[0] && await countEnabledUsersWithPermission(client, "*") <= 1) throw new Error("The final enabled Owner cannot be disabled");
      }
      const result = await client.query(
        "update users set display_name=$2,status=$3,last_login_at=$4,updated_at=now() where id=$1 returning *",
        [id, patch.displayName ?? current.displayName ?? null, patch.status ?? current.status, patch.lastLoginAt ?? current.lastLoginAt ?? null]
      );
      if (patch.status === "disabled") await client.query("update registration_invitations set revoked_at=coalesce(revoked_at,now()) where user_id=$1 and revoked_at is null", [id]);
      await client.query("commit");
      return userFromRow(result.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async incrementSessionVersion(id: string): Promise<UserAccount> {
    const result = await this.pool.query("update users set session_version=session_version+1,updated_at=now() where id=$1 returning *", [id]);
    if (!result.rows[0]) throw new Error("User not found");
    return userFromRow(result.rows[0]);
  }

  async getLocalPasswordHash(userIdValue: string): Promise<string | undefined> {
    const result = await this.pool.query<{ password_hash: string }>("select password_hash from local_credentials where user_id=$1", [userIdValue]);
    return result.rows[0]?.password_hash;
  }

  async setLocalPasswordHash(userIdValue: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      "insert into local_credentials (user_id,password_hash,updated_at) values ($1,$2,now()) on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at",
      [userIdValue, passwordHash]
    );
  }

  async findIdentity(providerType: UserIdentity["providerType"], providerId: string, subject: string): Promise<UserIdentity | undefined> {
    const result = await this.pool.query("select * from user_identities where provider_type=$1 and provider_id=$2 and subject=$3", [providerType, providerId, subject]);
    return result.rows[0] ? identityFromRow(result.rows[0]) : undefined;
  }

  async listIdentities(userIdValue: string): Promise<UserIdentity[]> {
    const result = await this.pool.query("select * from user_identities where user_id=$1 order by provider_type,provider_id,subject", [userIdValue]);
    return result.rows.map(identityFromRow);
  }

  async findUsersByIdentityHint(value: string): Promise<UserAccount[]> {
    const normalized = normalizeUsername(value);
    if (!normalized) return [];
    const result = await this.pool.query(
      `select distinct u.* from users u
       left join user_identities i on i.user_id=u.id
       where u.normalized_username=$1
          or lower(btrim(coalesce(i.subject,'')))=$1
          or lower(btrim(coalesce(i.username,'')))=$1
          or lower(btrim(coalesce(i.email,'')))=$1
       order by u.normalized_username,u.id`,
      [normalized]
    );
    return result.rows.map(userFromRow);
  }

  async saveIdentity(input: Omit<UserIdentity, "id" | "createdAt" | "lastSeenAt"> & { id?: string; createdAt?: Date; lastSeenAt?: Date }): Promise<UserIdentity> {
    const existing = await this.findIdentity(input.providerType, input.providerId, input.subject);
    if (existing && existing.userId !== input.userId) throw new Error("This external identity is already linked to another NeurOn user");
    const now = input.lastSeenAt ?? new Date();
    const result = await this.pool.query(
      `insert into user_identities (id,user_id,provider_type,provider_id,subject,username,email,created_at,last_seen_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(provider_type,provider_id,subject) do update set username=excluded.username,email=excluded.email,last_seen_at=excluded.last_seen_at
       returning *`,
      [input.id ?? `uid_${nanoid(18)}`, input.userId, input.providerType, input.providerId, input.subject, input.username ?? null, input.email ?? null, input.createdAt ?? now, now]
    );
    return identityFromRow(result.rows[0]);
  }

  async listRoles(scope?: Role["scope"]): Promise<Role[]> {
    const result = scope
      ? await this.pool.query("select * from roles where scope=$1 order by name,id", [scope])
      : await this.pool.query("select * from roles order by scope,name,id");
    return result.rows.map(roleFromRow);
  }

  async getRole(id: string): Promise<Role | undefined> {
    const result = await this.pool.query("select * from roles where id=$1", [id]);
    return result.rows[0] ? roleFromRow(result.rows[0]) : undefined;
  }

  async createRole(input: Omit<Role, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Role> {
    const now = input.createdAt ?? new Date();
    const result = await this.pool.query(
      "insert into roles (id,name,description,scope,permissions,system_key,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
      [input.id ?? `role_${nanoid(16)}`, input.name.trim(), input.description ?? null, input.scope, JSON.stringify(unique(input.permissions)), input.systemKey ?? null, now, input.updatedAt ?? now]
    );
    return roleFromRow(result.rows[0]);
  }

  async updateRole(id: string, input: Pick<Role, "name" | "description" | "permissions">): Promise<Role> {
    const current = await this.getRole(id);
    if (!current) throw new Error("Role not found");
    if (current.systemKey) throw new Error("Built-in roles cannot be modified");
    const result = await this.pool.query("update roles set name=$2,description=$3,permissions=$4,updated_at=now() where id=$1 returning *", [id, input.name.trim(), input.description ?? null, JSON.stringify(unique(input.permissions))]);
    return roleFromRow(result.rows[0]);
  }

  async deleteRole(id: string): Promise<boolean> {
    const role = await this.getRole(id);
    if (!role) return false;
    if (role.systemKey) throw new Error("Built-in roles cannot be deleted");
    const result = await this.pool.query("delete from roles where id=$1", [id]);
    return Boolean(result.rowCount);
  }

  async assignGlobalRole(userIdValue: string, roleId: string): Promise<void> {
    const role = await this.getRole(roleId);
    if (!role || role.scope !== "global") throw new Error("Global role not found");
    await this.pool.query("insert into user_role_assignments (user_id,role_id,created_at) values ($1,$2,now()) on conflict do nothing", [userIdValue, roleId]);
  }

  async revokeGlobalRole(userIdValue: string, roleId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('neuron:identity-owner'))");
      const roleResult = await client.query("select * from roles where id=$1", [roleId]);
      if (!roleResult.rows[0]) { await client.query("commit"); return false; }
      const role = roleFromRow(roleResult.rows[0]);
      const assignment = await client.query("select 1 from user_role_assignments where user_id=$1 and role_id=$2 for update", [userIdValue, roleId]);
      if (!assignment.rows[0]) { await client.query("commit"); return false; }
      if (role.systemKey === "owner" && await countEnabledUsersWithPermission(client, "*") <= 1) throw new Error("The final enabled Owner cannot be removed");
      const result = await client.query("delete from user_role_assignments where user_id=$1 and role_id=$2", [userIdValue, roleId]);
      await client.query("commit");
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async listGlobalRolesForUser(userIdValue: string): Promise<Role[]> {
    const result = await this.pool.query("select r.* from roles r join user_role_assignments a on a.role_id=r.id where a.user_id=$1 and r.scope='global' order by r.name,r.id", [userIdValue]);
    return result.rows.map(roleFromRow);
  }

  async countEnabledUsersWithPermission(permission: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `select count(distinct u.id)::text as count from users u
       join user_role_assignments a on a.user_id=u.id join roles r on r.id=a.role_id
       where u.status='active' and (r.permissions ? '*' or r.permissions ? $1)`,
      [permission]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async createTeam(input: Omit<Team, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<Team> {
    const client = await this.pool.connect();
    const now = input.createdAt ?? new Date();
    const id = input.id ?? `team_${nanoid(16)}`;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('neuron:team-hierarchy'))");
      await client.query("select id from teams for update");
      await client.query("insert into teams (id,name,description,parent_team_id,created_at,updated_at) values ($1,$2,$3,$4,$5,$6)", [id, input.name.trim(), input.description ?? null, input.parentTeamId ?? null, now, input.updatedAt ?? now]);
      await rebuildTeamHierarchy(client);
      await client.query("commit");
      return (await this.getTeam(id))!;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async getTeam(id: string): Promise<Team | undefined> {
    const result = await this.pool.query("select * from teams where id=$1", [id]);
    return result.rows[0] ? teamFromRow(result.rows[0]) : undefined;
  }

  async listTeams(): Promise<Team[]> {
    const result = await this.pool.query("select * from teams order by name,id");
    return result.rows.map(teamFromRow);
  }

  async updateTeam(id: string, input: Pick<Team, "name" | "description" | "parentTeamId">): Promise<Team> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('neuron:team-hierarchy'))");
      await client.query("select id from teams for update");
      if (input.parentTeamId) {
        const cycle = await client.query("select 1 from team_hierarchy where ancestor_team_id=$1 and descendant_team_id=$2", [id, input.parentTeamId]);
        if (cycle.rows[0] || input.parentTeamId === id) throw new Error("Team hierarchy cannot contain a cycle");
      }
      const result = await client.query("update teams set name=$2,description=$3,parent_team_id=$4,updated_at=now() where id=$1 returning *", [id, input.name.trim(), input.description ?? null, input.parentTeamId ?? null]);
      if (!result.rows[0]) throw new Error("Team not found");
      await rebuildTeamHierarchy(client);
      await client.query("commit");
      return teamFromRow(result.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async deleteTeam(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from teams where id=$1", [id]);
    return Boolean(result.rowCount);
  }

  async setTeamMembership(input: Omit<TeamMembership, "createdAt"> & { createdAt?: Date }): Promise<TeamMembership> {
    const role = await this.getRole(input.roleId);
    if (!role || role.scope !== "team") throw new Error("Team role not found");
    const sourceReference = input.sourceReference ?? "";
    const result = await this.pool.query(
      `insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) values ($1,$2,$3,$4,$5,$6)
       on conflict(team_id,user_id,source,source_reference) do update set role_id=excluded.role_id returning *`,
      [input.teamId, input.userId, input.roleId, input.source, sourceReference, input.createdAt ?? new Date()]
    );
    return membershipFromRow(result.rows[0]);
  }

  async removeTeamMembership(teamId: string, userIdValue: string, source?: TeamMembership["source"], sourceReference?: string): Promise<boolean> {
    const conditions = ["team_id=$1", "user_id=$2"];
    const values: unknown[] = [teamId, userIdValue];
    if (source) { values.push(source); conditions.push(`source=$${values.length}`); }
    if (sourceReference !== undefined) { values.push(sourceReference); conditions.push(`source_reference=$${values.length}`); }
    const result = await this.pool.query(`delete from team_memberships where ${conditions.join(" and ")}`, values);
    return Boolean(result.rowCount);
  }

  async reconcileOidcTeamMemberships(userIdValue: string, providerId: string, memberships: Array<Pick<TeamMembership, "teamId" | "roleId" | "sourceReference">>): Promise<void> {
    const client = await this.pool.connect();
    const prefix = `${providerId}:`;
    try {
      await client.query("begin");
      for (const membership of memberships) {
        if (!membership.sourceReference?.startsWith(prefix)) throw new Error("OIDC membership source does not match its provider");
        const valid = await client.query("select 1 from teams t join roles r on r.id=$2 and r.scope='team' where t.id=$1", [membership.teamId, membership.roleId]);
        if (!valid.rows[0]) throw new Error("OIDC membership references an unknown team or team role");
      }
      await client.query("delete from team_memberships where user_id=$1 and source='oidc' and left(source_reference,length($2))=$2", [userIdValue, prefix]);
      for (const membership of memberships) await client.query(
        `insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at) values ($1,$2,$3,'oidc',$4,now())`,
        [membership.teamId, userIdValue, membership.roleId, membership.sourceReference]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async listTeamMembershipsForUser(userIdValue: string): Promise<TeamMembership[]> {
    const result = await this.pool.query("select * from team_memberships where user_id=$1 order by team_id,source,source_reference", [userIdValue]);
    return result.rows.map(membershipFromRow);
  }

  async listTeamMemberships(teamId: string): Promise<TeamMembership[]> {
    const result = await this.pool.query("select * from team_memberships where team_id=$1 order by user_id,source,source_reference", [teamId]);
    return result.rows.map(membershipFromRow);
  }

  async isUserInAnyTeam(userIdValue: string, teamIds: string[]): Promise<boolean> {
    if (teamIds.length === 0) return false;
    const result = await this.pool.query(
      `select 1 from team_memberships m join team_hierarchy h on h.descendant_team_id=m.team_id
       where m.user_id=$1 and h.ancestor_team_id=any($2::text[]) limit 1`, [userIdValue, teamIds]
    );
    return Boolean(result.rows[0]);
  }

  async matchesUserAudience(userIdValue: string, audienceUserIds: string[]): Promise<boolean> {
    if (audienceUserIds.length === 0) return false;
    const result = await this.pool.query(
      `select 1 from users
       where id=any($2::text[]) and (id=$1 or merged_into_user_id=$1)
       limit 1`,
      [userIdValue, audienceUserIds]
    );
    return Boolean(result.rows[0]);
  }

  async createInvitation(input: Omit<RegistrationInvitation, "id" | "useCount" | "createdAt"> & { id?: string; useCount?: number; createdAt?: Date }): Promise<RegistrationInvitation> {
    const result = await this.pool.query(
      `insert into registration_invitations (id,token_hash,user_id,intended_username,initial_role_id,created_by_user_id,expires_at,max_uses,use_count,revoked_at,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [input.id ?? `invite_${nanoid(18)}`, input.tokenHash, input.userId ?? null, input.intendedUsername ?? null, input.initialRoleId ?? null, input.createdByUserId ?? null, input.expiresAt, input.maxUses, input.useCount ?? 0, input.revokedAt ?? null, input.createdAt ?? new Date()]
    );
    return invitationFromRow(result.rows[0]);
  }

  async getInvitationByTokenHash(tokenHash: string): Promise<RegistrationInvitation | undefined> {
    const result = await this.pool.query("select * from registration_invitations where token_hash=$1", [tokenHash]);
    return result.rows[0] ? invitationFromRow(result.rows[0]) : undefined;
  }

  async consumeInvitation(id: string, now: Date): Promise<RegistrationInvitation> {
    const result = await this.pool.query(
      `update registration_invitations set use_count=use_count+1 where id=$1 and revoked_at is null and expires_at>$2 and use_count<max_uses returning *`, [id, now]
    );
    if (!result.rows[0]) throw new Error("Registration link is expired, revoked, or already used");
    return invitationFromRow(result.rows[0]);
  }

  async redeemInvitation(input: { tokenHash: string; username: string; displayName?: string; passwordHash: string; consumedAt: Date }): Promise<UserAccount> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const invitationResult = await client.query(
        `select * from registration_invitations
         where token_hash=$1 and revoked_at is null and expires_at>$2 and use_count<max_uses
         for update`,
        [input.tokenHash, input.consumedAt]
      );
      const invitationRow = invitationResult.rows[0];
      if (!invitationRow) throw new Error("Registration link is expired, revoked, or already used");
      const invitation = invitationFromRow(invitationRow);
      const normalized = normalizeUsername(input.username);
      if (!normalized) throw new Error("Username is required");
      if (invitation.intendedUsername && normalizeUsername(invitation.intendedUsername) !== normalized) {
        throw new Error("This registration link is for a different username");
      }

      let userRow: Record<string, unknown> | undefined;
      if (invitation.userId) {
        userRow = (await client.query("select * from users where id=$1 for update", [invitation.userId])).rows[0];
        if (!userRow) throw new Error("Invitation user not found");
        if (String(userRow.normalized_username) !== normalized) throw new Error("This claim link belongs to a different username");
        if (userRow.merged_into_user_id) throw new Error("This account has been merged into another user");
        if (userRow.status !== "active") throw new Error("This account is disabled; ask an Owner to reactivate it before using a claim link");
        await client.query(
          "update users set display_name=coalesce($2,display_name),updated_at=$3 where id=$1",
          [invitation.userId, input.displayName ?? null, input.consumedAt]
        );
      } else {
        if ((await client.query("select 1 from users where normalized_username=$1", [normalized])).rows[0]) {
          throw new Error("Username is already registered; ask an administrator for an account claim link");
        }
        const id = userId();
        userRow = (await client.query(
          `insert into users (id,username,normalized_username,display_name,status,session_version,created_at,updated_at)
           values ($1,$2,$3,$4,'active',1,$5,$5) returning *`,
          [id, input.username.trim(), normalized, input.displayName ?? null, input.consumedAt]
        )).rows[0];
        await client.query(
          "insert into user_role_assignments (user_id,role_id,created_at) values ($1,'role_member',$2)",
          [id, input.consumedAt]
        );
      }

      const userIdValue = String(userRow!.id);
      const conflictingIdentity = await client.query<{ user_id: string }>(
        "select user_id from user_identities where provider_type='local' and provider_id='local' and subject=$1",
        [normalized]
      );
      if (conflictingIdentity.rows[0] && conflictingIdentity.rows[0].user_id !== userIdValue) {
        throw new Error("This local identity belongs to another account");
      }
      await client.query(
        `insert into local_credentials (user_id,password_hash,updated_at) values ($1,$2,$3)
         on conflict(user_id) do update set password_hash=excluded.password_hash,updated_at=excluded.updated_at`,
        [userIdValue, input.passwordHash, input.consumedAt]
      );
      await client.query(
        `insert into user_identities (id,user_id,provider_type,provider_id,subject,username,created_at,last_seen_at)
         values ($1,$2,'local','local',$3,$4,$5,$5)
         on conflict(provider_type,provider_id,subject) do update set username=excluded.username,last_seen_at=excluded.last_seen_at`,
        [`uid_${nanoid(18)}`, userIdValue, normalized, String(userRow!.username), input.consumedAt]
      );
      if (invitation.initialRoleId) {
        const role = await client.query<{ scope: string }>("select scope from roles where id=$1", [invitation.initialRoleId]);
        if (role.rows[0]?.scope !== "global") throw new Error("Invitation role not found");
        await client.query(
          "insert into user_role_assignments (user_id,role_id,created_at) values ($1,$2,$3) on conflict do nothing",
          [userIdValue, invitation.initialRoleId, input.consumedAt]
        );
      }
      await client.query(
        "update registration_invitations set use_count=use_count+1 where id=$1",
        [invitation.id]
      );
      await client.query(
        "update users set session_version=session_version+1,updated_at=$2 where id=$1",
        [userIdValue, input.consumedAt]
      );
      const completed = await client.query("select * from users where id=$1", [userIdValue]);
      await client.query("commit");
      return userFromRow(completed.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeInvitation(id: string, revokedAt: Date): Promise<boolean> {
    const result = await this.pool.query("update registration_invitations set revoked_at=$2 where id=$1 and revoked_at is null", [id, revokedAt]);
    return Boolean(result.rowCount);
  }

  async listInvitations(): Promise<RegistrationInvitation[]> {
    const result = await this.pool.query("select * from registration_invitations order by created_at desc,id");
    return result.rows.map(invitationFromRow);
  }

  async getExternalUserLink(integration: string, externalSubject: string): Promise<ExternalUserLink | undefined> {
    const result = await this.pool.query("select * from external_user_links where integration=$1 and external_subject=$2", [integration, externalSubject]);
    return result.rows[0] ? externalLinkFromRow(result.rows[0]) : undefined;
  }

  async saveExternalUserLink(input: Omit<ExternalUserLink, "createdAt" | "lastSeenAt"> & { createdAt?: Date; lastSeenAt?: Date }): Promise<ExternalUserLink> {
    const existing = await this.getExternalUserLink(input.integration, input.externalSubject);
    if (existing && existing.userId !== input.userId) throw new Error("External user is already linked to another NeurOn account");
    const now = input.lastSeenAt ?? new Date();
    const result = await this.pool.query(
      `insert into external_user_links (integration,external_subject,user_id,source,created_at,last_seen_at) values ($1,$2,$3,$4,$5,$6)
       on conflict(integration,external_subject) do update set source=excluded.source,last_seen_at=excluded.last_seen_at returning *`,
      [input.integration, input.externalSubject, input.userId, input.source, input.createdAt ?? now, now]
    );
    return externalLinkFromRow(result.rows[0]);
  }

  async listExternalUserLinks(integration?: string): Promise<ExternalUserLink[]> {
    const result = integration
      ? await this.pool.query("select * from external_user_links where integration=$1 order by external_subject", [integration])
      : await this.pool.query("select * from external_user_links order by integration,external_subject");
    return result.rows.map(externalLinkFromRow);
  }

  async deleteExternalUserLink(integration: string, externalSubject: string): Promise<boolean> {
    return Boolean((await this.pool.query("delete from external_user_links where integration=$1 and external_subject=$2", [integration, externalSubject])).rowCount);
  }

  async previewUserMerge(sourceUserId: string, targetUserId: string): Promise<UserMergePreview> {
    if (sourceUserId === targetUserId) throw new Error("Source and target users must be different");
    const [sourceUser, targetUser] = await Promise.all([this.getUser(sourceUserId), this.getUser(targetUserId)]);
    if (!sourceUser || !targetUser) throw new Error("Source or target user not found");
    const tables = ["reservations", "reservation_profiles", "api_keys", "model_favorites", "user_identities", "team_memberships", "external_user_links"] as const;
    const counts = await Promise.all(tables.map(async (table) => Number((await this.pool.query<{ count: string }>(`select count(*)::text as count from ${table} where user_id=$1`, [sourceUserId])).rows[0]?.count ?? 0)));
    return {
      sourceUser: { id: sourceUser.id, username: sourceUser.username, status: sourceUser.status }, targetUser: { id: targetUser.id, username: targetUser.username, status: targetUser.status },
      counts: { reservations: counts[0], profiles: counts[1], apiKeys: counts[2], favorites: counts[3], identities: counts[4], teamMemberships: counts[5], externalUserLinks: counts[6] }
    };
  }

  async mergeUsers(sourceUserId: string, targetUserId: string, mergedAt: Date, actorUserId?: string): Promise<void> {
    if (sourceUserId === targetUserId) throw new Error("Source and target users must be different");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const users = await client.query("select * from users where id=any($1::text[]) for update", [[sourceUserId, targetUserId]]);
      const source = users.rows.find((row) => row.id === sourceUserId);
      const target = users.rows.find((row) => row.id === targetUserId);
      if (!source || !target) throw new Error("Source or target user not found");
      if (source.merged_into_user_id) throw new Error("Source user has already been merged");
      if (target.status !== "active" || target.merged_into_user_id) throw new Error("Merge destination must be an active user");

      await client.query("update reservations set user_id=$2,username=$3 where user_id=$1", [sourceUserId, targetUserId, target.username]);
      await client.query("update reservation_profiles set user_id=$2,username=$3 where user_id=$1", [sourceUserId, targetUserId, target.username]);
      await client.query("update api_keys set user_id=$2,username=$3 where user_id=$1", [sourceUserId, targetUserId, target.username]);
      await client.query(`delete from model_favorites s where s.user_id=$1 and exists (select 1 from model_favorites t where t.user_id=$2 and t.target_id=s.target_id and t.model_id=s.model_id)`, [sourceUserId, targetUserId]);
      await client.query("update model_favorites set user_id=$2,username=$3 where user_id=$1", [sourceUserId, targetUserId, target.username]);
      await client.query("update user_identities set user_id=$2 where user_id=$1", [sourceUserId, targetUserId]);
      await client.query("insert into user_role_assignments (user_id,role_id,created_at) select $2,role_id,created_at from user_role_assignments where user_id=$1 on conflict do nothing", [sourceUserId, targetUserId]);
      await client.query("delete from user_role_assignments where user_id=$1", [sourceUserId]);
      await client.query(`with stronger_memberships as (
          select source_membership.team_id,source_membership.source,source_membership.source_reference,source_membership.role_id
          from team_memberships source_membership
          join roles source_role on source_role.id=source_membership.role_id
          join team_memberships target_membership on target_membership.user_id=$2 and target_membership.team_id=source_membership.team_id and target_membership.source=source_membership.source and target_membership.source_reference=source_membership.source_reference
          join roles target_role on target_role.id=target_membership.role_id
          where source_membership.user_id=$1 and jsonb_array_length(source_role.permissions)>jsonb_array_length(target_role.permissions)
        ) update team_memberships target_membership set role_id=stronger.role_id from stronger_memberships stronger
          where target_membership.user_id=$2 and target_membership.team_id=stronger.team_id and target_membership.source=stronger.source and target_membership.source_reference=stronger.source_reference`, [sourceUserId, targetUserId]);
      await client.query(`insert into team_memberships (team_id,user_id,role_id,source,source_reference,created_at)
        select team_id,$2,role_id,source,source_reference,created_at from team_memberships where user_id=$1 on conflict do nothing`, [sourceUserId, targetUserId]);
      await client.query("delete from team_memberships where user_id=$1", [sourceUserId]);
      await client.query("update registration_invitations set user_id=$2 where user_id=$1", [sourceUserId, targetUserId]);
      await client.query("update external_user_links set user_id=$2 where user_id=$1", [sourceUserId, targetUserId]);
      await client.query("update users set merged_into_user_id=$2,updated_at=$3 where merged_into_user_id=$1", [sourceUserId, targetUserId, mergedAt]);
      await client.query(
        `update capacity_targets
         set target_json=jsonb_set(target_json,'{audience,userIds}',(
           select jsonb_agg(mapped order by first_position)
           from (
             select case when value=$1 then $2 else value end as mapped,min(position) as first_position
             from jsonb_array_elements_text(target_json #> '{audience,userIds}') with ordinality as entries(value,position)
             group by case when value=$1 then $2 else value end
           ) replacements
         ))
         where target_json #>> '{audience,scope}'='users' and (target_json #> '{audience,userIds}') ? $1`,
        [sourceUserId, targetUserId]
      );
      const targetCredential = await client.query("select 1 from local_credentials where user_id=$1", [targetUserId]);
      if (!targetCredential.rows[0]) await client.query("update local_credentials set user_id=$2 where user_id=$1", [sourceUserId, targetUserId]);
      else await client.query("delete from local_credentials where user_id=$1", [sourceUserId]);
      await client.query("update users set status='disabled',merged_into_user_id=$2,session_version=session_version+1,updated_at=$3 where id=$1", [sourceUserId, targetUserId, mergedAt]);
      await client.query("update users set session_version=session_version+1,updated_at=$2 where id=$1", [targetUserId, mergedAt]);
      await client.query("insert into identity_audit_events (id,actor_user_id,action,subject_type,subject_id,details,created_at) values ($1,$2,'users.merge','user',$3,$4::jsonb,$5)", [`audit_${nanoid(18)}`, actorUserId ?? null, targetUserId, JSON.stringify({ sourceUserId, targetUserId }), mergedAt]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function rebuildTeamHierarchy(client: pg.PoolClient): Promise<void> {
  await client.query("delete from team_hierarchy");
  await client.query(`
    with recursive hierarchy(ancestor_team_id,descendant_team_id,depth,path) as (
      select id,id,0,array[id] from teams
      union all
      select h.ancestor_team_id,t.id,h.depth+1,h.path || t.id
      from hierarchy h join teams t on t.parent_team_id=h.descendant_team_id
      where not t.id=any(h.path)
    )
    insert into team_hierarchy (ancestor_team_id,descendant_team_id,depth)
    select ancestor_team_id,descendant_team_id,min(depth) from hierarchy group by ancestor_team_id,descendant_team_id
  `);
  const disconnected = await client.query<{ count: string }>("select count(*)::text as count from teams t left join team_hierarchy h on h.ancestor_team_id=t.id and h.descendant_team_id=t.id where h.ancestor_team_id is null");
  if (Number(disconnected.rows[0]?.count ?? 0) > 0) throw new Error("Team hierarchy contains a cycle");
}

async function countEnabledUsersWithPermission(client: pg.PoolClient, permission: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(distinct u.id)::text as count from users u
     join user_role_assignments a on a.user_id=u.id join roles r on r.id=a.role_id
     where u.status='active' and (r.permissions ? '*' or r.permissions ? $1)`,
    [permission]
  );
  return Number(result.rows[0]?.count ?? 0);
}

function userFromRow(row: Record<string, unknown>): UserAccount {
  return {
    id: String(row.id), username: String(row.username), normalizedUsername: String(row.normalized_username),
    displayName: row.display_name == null ? undefined : String(row.display_name), status: row.status as UserAccount["status"],
    sessionVersion: Number(row.session_version), mergedIntoUserId: row.merged_into_user_id == null ? undefined : String(row.merged_into_user_id),
    createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)), lastLoginAt: row.last_login_at == null ? undefined : new Date(String(row.last_login_at))
  };
}

function identityFromRow(row: Record<string, unknown>): UserIdentity {
  return { id: String(row.id), userId: String(row.user_id), providerType: row.provider_type as UserIdentity["providerType"], providerId: String(row.provider_id), subject: String(row.subject), username: row.username == null ? undefined : String(row.username), email: row.email == null ? undefined : String(row.email), createdAt: new Date(String(row.created_at)), lastSeenAt: new Date(String(row.last_seen_at)) };
}

function roleFromRow(row: Record<string, unknown>): Role {
  return { id: String(row.id), name: String(row.name), description: row.description == null ? undefined : String(row.description), scope: row.scope as Role["scope"], permissions: stringArray(row.permissions), systemKey: row.system_key == null ? undefined : String(row.system_key), createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)) };
}

function teamFromRow(row: Record<string, unknown>): Team {
  return { id: String(row.id), name: String(row.name), description: row.description == null ? undefined : String(row.description), parentTeamId: row.parent_team_id == null ? undefined : String(row.parent_team_id), createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)) };
}

function membershipFromRow(row: Record<string, unknown>): TeamMembership {
  return { teamId: String(row.team_id), userId: String(row.user_id), roleId: String(row.role_id), source: row.source as TeamMembership["source"], sourceReference: row.source_reference ? String(row.source_reference) : undefined, createdAt: new Date(String(row.created_at)) };
}

function invitationFromRow(row: Record<string, unknown>): RegistrationInvitation {
  return { id: String(row.id), tokenHash: String(row.token_hash), userId: row.user_id == null ? undefined : String(row.user_id), intendedUsername: row.intended_username == null ? undefined : String(row.intended_username), initialRoleId: row.initial_role_id == null ? undefined : String(row.initial_role_id), createdByUserId: row.created_by_user_id == null ? undefined : String(row.created_by_user_id), expiresAt: new Date(String(row.expires_at)), maxUses: Number(row.max_uses), useCount: Number(row.use_count), revokedAt: row.revoked_at == null ? undefined : new Date(String(row.revoked_at)), createdAt: new Date(String(row.created_at)) };
}

function externalLinkFromRow(row: Record<string, unknown>): ExternalUserLink {
  return { integration: String(row.integration), externalSubject: String(row.external_subject), userId: String(row.user_id), source: row.source as ExternalUserLink["source"], createdAt: new Date(String(row.created_at)), lastSeenAt: new Date(String(row.last_seen_at)) };
}

function normalizeUsername(value: string): string { return value.trim().toLocaleLowerCase("en-US"); }
function userId(): string { return `usr_${nanoid(20)}`; }
function unique(values: string[]): string[] { return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
