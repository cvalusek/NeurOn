import crypto from "node:crypto";
import type { IdentityRepository, ReservationProfileRepository } from "../domain/interfaces.js";
import type { AuthenticatedUser, CapacityTarget, OidcTeamMembershipRule, RegistrationInvitation, Role, Team, UserAccount, UserIdentity } from "../domain/types.js";

const PASSWORD_MIN_LENGTH = 10;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_COST = 16_384;

export interface ExternalIdentityClaims {
  subject: string;
  username: string;
  email?: string;
  claims?: Record<string, unknown>;
}

export interface CreatedInvitation {
  invitation: RegistrationInvitation;
  token: string;
}

export class IdentityService {
  private userMergeListener?: (sourceUserId: string, targetUserId: string) => void | Promise<void>;
  constructor(private readonly repository: IdentityRepository, private readonly profiles?: ReservationProfileRepository) {}

  onUsersMerged(listener: (sourceUserId: string, targetUserId: string) => void | Promise<void>): void { this.userMergeListener = listener; }

  async initialize(adminUsernames: string[]): Promise<void> {
    await this.repository.initializeLegacyUsers(adminUsernames);
  }

  async authenticatedUser(userId: string): Promise<AuthenticatedUser | undefined> {
    const user = await this.repository.getUser(userId);
    if (!user || user.status !== "active" || user.mergedIntoUserId) return undefined;
    const roles = await this.repository.listGlobalRolesForUser(user.id);
    const permissions = unique(roles.flatMap((role) => role.permissions));
    const administrative = ["users.manage", "roles.manage", "teams.manage", "targets.manage", "reports.read_all", "assistant.configure", "auth.manage", "system.manage"];
    return { id: user.id, username: user.username, permissions, sessionVersion: user.sessionVersion, isAdmin: permissions.includes("*") || administrative.some((permission) => permissions.includes(permission)) };
  }

  async authenticateLocal(username: string, password: string): Promise<AuthenticatedUser | undefined> {
    const user = await this.repository.getUserByUsername(username);
    if (!user || user.status !== "active" || user.mergedIntoUserId) return undefined;
    const passwordHash = await this.repository.getLocalPasswordHash(user.id);
    if (!passwordHash || !await verifyPassword(password, passwordHash)) return undefined;
    await this.repository.updateUser(user.id, { lastLoginAt: new Date() });
    return this.authenticatedUser(user.id);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    validatePassword(password);
    const user = await this.repository.getUser(userId);
    if (!user || user.mergedIntoUserId) throw new Error("User not found");
    await this.repository.setLocalPasswordHash(user.id, await hashPassword(password));
    await this.repository.saveIdentity({ userId: user.id, providerType: "local", providerId: "local", subject: user.normalizedUsername, username: user.username });
    await this.repository.incrementSessionVersion(user.id);
  }

  async signInExternal(providerType: "github" | "oidc", providerId: string, principal: ExternalIdentityClaims, rules: OidcTeamMembershipRule[] = []): Promise<AuthenticatedUser> {
    const existingIdentity = await this.repository.findIdentity(providerType, providerId, principal.subject);
    let account = existingIdentity ? await this.repository.getUser(existingIdentity.userId) : undefined;
    if (!account) account = await this.repository.getUserByUsername(principal.username);
    if (!account) {
      account = await this.repository.createUser({ username: principal.username, displayName: principal.username, status: "active" });
    }
    if (account.status !== "active" || account.mergedIntoUserId) throw new Error("This NeurOn account is disabled");
    await this.repository.saveIdentity({ userId: account.id, providerType, providerId, subject: principal.subject, username: principal.username, email: principal.email });
    await this.repository.updateUser(account.id, { lastLoginAt: new Date() });
    if (providerType === "oidc") await this.reconcileOidcMemberships(account.id, providerId, rules, principal.claims ?? {});
    const authenticated = await this.authenticatedUser(account.id);
    if (!authenticated) throw new Error("This NeurOn account is disabled");
    return authenticated;
  }

  async createInvitation(actor: AuthenticatedUser | undefined, input: { userId?: string; intendedUsername?: string; initialRoleId?: string; expiresInMinutes?: number; maxUses?: number }): Promise<CreatedInvitation> {
    if (actor && !this.hasPermission(actor, "users.manage")) throw new Error("User management permission is required");
    if (input.userId && !await this.repository.getUser(input.userId)) throw new Error("Invitation user not found");
    if (actor && input.userId && await this.userHasWildcard(input.userId)) this.requireOwner(actor, "Only an Owner can create a claim or reset link for an Owner");
    if (input.initialRoleId) {
      const role = await this.repository.getRole(input.initialRoleId);
      if (!role || role.scope !== "global") throw new Error("Invitation role not found");
      if (actor && role.permissions.includes("*")) this.requireOwner(actor, "Only an Owner can invite another Owner");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const invitation = await this.repository.createInvitation({
      tokenHash: hashToken(token), userId: input.userId, intendedUsername: input.intendedUsername?.trim() || undefined,
      initialRoleId: input.initialRoleId, createdByUserId: actor?.id,
      expiresAt: new Date(Date.now() + (input.expiresInMinutes ?? 1_440) * 60_000), maxUses: input.maxUses ?? 1
    });
    return { invitation, token };
  }

  async register(token: string, input: { username: string; password: string; displayName?: string }): Promise<AuthenticatedUser> {
    validatePassword(input.password);
    const user = await this.repository.redeemInvitation({
      tokenHash: hashToken(token),
      username: input.username,
      displayName: input.displayName?.trim() || undefined,
      passwordHash: await hashPassword(input.password),
      consumedAt: new Date()
    });
    const authenticated = await this.authenticatedUser(user.id);
    if (!authenticated) throw new Error("Registered account is disabled");
    return authenticated;
  }

  async isOwnerRecoveryInvitation(token: string, now = new Date()): Promise<boolean> {
    const invitation = await this.repository.getInvitationByTokenHash(hashToken(token));
    if (!invitation || invitation.revokedAt || invitation.expiresAt <= now || invitation.useCount >= invitation.maxUses || !invitation.initialRoleId) return false;
    const role = await this.repository.getRole(invitation.initialRoleId);
    return Boolean(role?.scope === "global" && role.permissions.includes("*"));
  }

  async listUsers(): Promise<Array<UserAccount & { roles: Role[]; identities: UserIdentity[] }>> {
    const users = await this.repository.listUsers();
    return Promise.all(users.map(async (user) => ({ ...user, roles: await this.repository.listGlobalRolesForUser(user.id), identities: await this.repository.listIdentities(user.id) })));
  }

  listRoles(scope?: Role["scope"]): Promise<Role[]> { return this.repository.listRoles(scope); }
  listTeams() { return this.repository.listTeams(); }
  listInvitations() { return this.repository.listInvitations(); }
  async createRole(actor: AuthenticatedUser, input: Parameters<IdentityRepository["createRole"]>[0]) { this.requirePermission(actor, "roles.manage"); if(input.permissions.includes("*"))this.requireOwner(actor,"Only an Owner can create a wildcard role"); return this.repository.createRole(input); }
  async updateRole(actor: AuthenticatedUser, id: string, input: Parameters<IdentityRepository["updateRole"]>[1]) { this.requirePermission(actor, "roles.manage"); const role=await this.repository.getRole(id); if(!role)throw new Error("Role not found"); if(role.systemKey)throw new Error("Built-in roles cannot be modified"); if(input.permissions.includes("*"))this.requireOwner(actor,"Only an Owner can grant wildcard permissions"); return this.repository.updateRole(id, input); }
  async deleteRole(actor:AuthenticatedUser,id:string){this.requirePermission(actor,"roles.manage");return this.repository.deleteRole(id)}
  async assignRole(actor: AuthenticatedUser, userId: string, roleId: string) { this.requirePermission(actor, "users.manage"); const role=await this.repository.getRole(roleId); if(role?.permissions.includes("*"))this.requireOwner(actor,"Only an Owner can assign the Owner role"); return this.repository.assignGlobalRole(userId, roleId); }
  async revokeRole(actor: AuthenticatedUser, userId: string, roleId: string) { this.requirePermission(actor, "users.manage"); const role=await this.repository.getRole(roleId); if(role?.permissions.includes("*"))this.requireOwner(actor,"Only an Owner can remove the Owner role"); return this.repository.revokeGlobalRole(userId, roleId); }
  async setUserStatus(actor: AuthenticatedUser, userId: string, status: UserAccount["status"]) { this.requirePermission(actor, "users.manage"); if(status==="disabled"&&await this.userHasWildcard(userId))this.requireOwner(actor,"Only an Owner can disable an Owner"); const updated=await this.repository.updateUser(userId,{status}); if(status==="disabled")await this.repository.incrementSessionVersion(userId); return updated; }
  async previewMerge(actor: AuthenticatedUser, sourceUserId: string, targetUserId: string) { this.requirePermission(actor,"users.merge"); return this.repository.previewUserMerge(sourceUserId,targetUserId); }
  async mergeUsers(actor: AuthenticatedUser, sourceUserId: string, targetUserId: string): Promise<void> { this.requirePermission(actor,"users.merge"); if(await this.userHasWildcard(sourceUserId))this.requireOwner(actor,"Only an Owner can merge an Owner account"); await this.repository.mergeUsers(sourceUserId,targetUserId,new Date(),actor.id); await this.userMergeListener?.(sourceUserId,targetUserId); }
  async revokeSessions(actor: AuthenticatedUser,userId:string){this.requirePermission(actor,"users.manage");return this.repository.incrementSessionVersion(userId)}
  async createTeam(actor: AuthenticatedUser,input:Parameters<IdentityRepository["createTeam"]>[0]){this.requirePermission(actor,"teams.manage");return this.repository.createTeam(input)}
  async updateTeam(actor: AuthenticatedUser,id:string,input:Parameters<IdentityRepository["updateTeam"]>[1]){this.requirePermission(actor,"teams.manage");return this.repository.updateTeam(id,input)}
  async deleteTeam(actor:AuthenticatedUser,id:string){this.requirePermission(actor,"teams.manage");if(this.profiles&&(await this.profiles.list()).some((profile)=>profile.teamId===id))throw new Error("Move or delete this team's shared profiles before deleting the team");return this.repository.deleteTeam(id)}
  async setTeamMembership(actor:AuthenticatedUser,input:Parameters<IdentityRepository["setTeamMembership"]>[0]){this.requirePermission(actor,"teams.manage");return this.repository.setTeamMembership(input)}
  async removeTeamMembership(actor:AuthenticatedUser,teamId:string,userId:string,source?:"manual"|"oidc",sourceReference?:string){this.requirePermission(actor,"teams.manage");return this.repository.removeTeamMembership(teamId,userId,source,sourceReference)}
  async revokeInvitation(actor:AuthenticatedUser,id:string){this.requirePermission(actor,"users.manage");return this.repository.revokeInvitation(id,new Date())}
  async linkExternalUser(actor:AuthenticatedUser,integration:string,externalSubject:string,userId:string){this.requirePermission(actor,"users.manage");return this.repository.saveExternalUserLink({integration,externalSubject,userId,source:"admin"})}
  async unlinkExternalUser(actor:AuthenticatedUser,integration:string,externalSubject:string){this.requirePermission(actor,"users.manage");return this.repository.deleteExternalUserLink(integration,externalSubject)}
  listExternalUserLinks(integration?:string){return this.repository.listExternalUserLinks(integration)}
  listTeamMemberships(teamId:string){return this.repository.listTeamMemberships(teamId)}

  async listProfileTeams(user: AuthenticatedUser, access: "use" | "manage"): Promise<Team[]> {
    const teams = await this.repository.listTeams();
    if (this.hasPermission(user, "teams.manage")) return teams;
    const memberships = await this.repository.listTeamMembershipsForUser(user.id);
    const roles = new Map((await Promise.all(Array.from(new Set(memberships.map((membership) => membership.roleId))).map((id) => this.repository.getRole(id)))).filter((role): role is Role => Boolean(role)).map((role) => [role.id, role]));
    const teamById = new Map(teams.map((team) => [team.id, team]));
    const allowed = new Set<string>();
    for (const membership of memberships) {
      const permissions = roles.get(membership.roleId)?.permissions ?? [];
      const canManage = permissions.includes("team.profiles.manage");
      const canUse = canManage || permissions.includes("team.profiles.use");
      for (const team of teams) {
        if (access === "manage" && canManage && isTeamAncestor(membership.teamId, team.id, teamById)) allowed.add(team.id);
        if (access === "use" && canUse && isTeamAncestor(team.id, membership.teamId, teamById)) allowed.add(team.id);
        if (access === "use" && canManage && isTeamAncestor(membership.teamId, team.id, teamById)) allowed.add(team.id);
      }
    }
    return teams.filter((team) => allowed.has(team.id));
  }

  async canUseTeamProfile(user: AuthenticatedUser, teamId: string): Promise<boolean> {
    return (await this.listProfileTeams(user, "use")).some((team) => team.id === teamId);
  }

  async canManageTeamProfile(user: AuthenticatedUser, teamId: string): Promise<boolean> {
    return (await this.listProfileTeams(user, "manage")).some((team) => team.id === teamId);
  }

  async canTeamAccessTarget(teamId: string, target: CapacityTarget): Promise<boolean> {
    const teams = await this.repository.listTeams();
    const teamById = new Map(teams.map((team) => [team.id, team]));
    if (!teamById.has(teamId)) return false;
    const audience = target.audience ?? { scope: "global" as const };
    if (audience.scope === "global") return true;
    if (audience.scope === "users") return false;
    return audience.teamIds.some((audienceTeamId) => isTeamAncestor(audienceTeamId, teamId, teamById));
  }

  async resolveLiteLlmUser(externalSubject: string): Promise<AuthenticatedUser | undefined> {
    const existing = await this.repository.getExternalUserLink("litellm", externalSubject);
    if (existing) {
      await this.repository.saveExternalUserLink({ integration: "litellm", externalSubject, userId: existing.userId, source: existing.source });
      return this.authenticatedUser(existing.userId);
    }
    const direct = externalSubject.startsWith("usr_") ? await this.repository.getUser(externalSubject) : undefined;
    const candidates = direct ? [direct] : await this.repository.findUsersByIdentityHint(externalSubject);
    const activeCandidates = candidates.filter((candidate) => candidate.status === "active" && !candidate.mergedIntoUserId);
    if (activeCandidates.length !== 1) return undefined;
    const matched = activeCandidates[0];
    await this.repository.saveExternalUserLink({ integration: "litellm", externalSubject, userId: matched.id, source: direct ? "metadata" : "rule" });
    return this.authenticatedUser(matched.id);
  }

  async canAccessTarget(user: AuthenticatedUser, target: CapacityTarget, access: "read" | "use" = "read"): Promise<boolean> {
    if (this.hasPermission(user, access === "use" ? "targets.use_all" : "targets.read_all")) return true;
    if (!this.hasPermission(user, access === "use" ? "targets.use" : "targets.read")) return false;
    const audience = target.audience ?? { scope: "global" as const };
    if (audience.scope === "global") return true;
    if (audience.scope === "users") return this.repository.matchesUserAudience(user.id, audience.userIds);
    return this.repository.isUserInAnyTeam(user.id, audience.teamIds);
  }

  hasPermission(user: AuthenticatedUser, permission: string): boolean { return user.permissions.includes("*") || user.permissions.includes(permission); }
  requirePermission(user: AuthenticatedUser, permission: string): void { if (!this.hasPermission(user,permission)) throw new Error(`Permission required: ${permission}`); }

  private requireOwner(user: AuthenticatedUser, message: string): void { if(!user.permissions.includes("*"))throw new Error(message); }
  private async userHasWildcard(userId: string): Promise<boolean> { return (await this.repository.listGlobalRolesForUser(userId)).some((role)=>role.permissions.includes("*")); }

  private async reconcileOidcMemberships(userId: string, providerId: string, rules: OidcTeamMembershipRule[], claims: Record<string, unknown>): Promise<void> {
    const managedPrefix = `${providerId}:`;
    const desired = new Map<string, OidcTeamMembershipRule>();
    for (const rule of rules.filter((candidate) => candidate.enabled !== false)) if (claimMatches(claims[rule.claim], rule)) desired.set(`${managedPrefix}${rule.id}`, rule);
    await this.repository.reconcileOidcTeamMemberships(userId, providerId, Array.from(desired, ([sourceReference, rule]) => ({ teamId: rule.teamId, roleId: rule.roleId, sourceReference })));
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const result = await derivePassword(password, salt, SCRYPT_KEY_LENGTH, { N: SCRYPT_COST, r: 8, p: 1 });
  return `scrypt$${SCRYPT_COST}$8$1$${salt.toString("base64url")}$${result.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !cost || !r || !p || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, "base64url");
  const result = await derivePassword(password, Buffer.from(salt, "base64url"), expectedBuffer.length, { N: Number(cost), r: Number(r), p: Number(p) });
  return result.length === expectedBuffer.length && crypto.timingSafeEqual(result, expectedBuffer);
}

function validatePassword(password: string): void { if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`); if (password.length > 1_024) throw new Error("Password is too long"); }
function hashToken(value: string): string { return crypto.createHash("sha256").update(value).digest("base64url"); }
function unique(values: string[]): string[] { return Array.from(new Set(values)).sort(); }
function isTeamAncestor(ancestorTeamId: string, descendantTeamId: string, teams: Map<string, Team>): boolean {
  const seen = new Set<string>();
  let current = teams.get(descendantTeamId);
  while (current) {
    if (current.id === ancestorTeamId) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parentTeamId ? teams.get(current.parentTeamId) : undefined;
  }
  return false;
}
function claimMatches(value: unknown, rule: OidcTeamMembershipRule): boolean {
  const values = Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === "string") : typeof value === "string" ? [value] : [];
  if (rule.match === "exact") return values.includes(rule.value);
  if (rule.value.length > 300) throw new Error(`OIDC membership rule ${rule.id} pattern is too long`);
  const expression = new RegExp(rule.value, "u");
  return values.some((candidate) => candidate.length <= 2_000 && expression.test(candidate));
}

function derivePassword(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}
