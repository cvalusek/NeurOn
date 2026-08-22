import { nanoid } from "nanoid";
import type { IdentityRepository } from "../domain/interfaces.js";
import type { ExternalUserLink, RegistrationInvitation, Role, Team, TeamMembership, UserAccount, UserIdentity, UserMergePreview } from "../domain/types.js";

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, UserAccount>();
  private readonly credentials = new Map<string, string>();
  private readonly identities = new Map<string, UserIdentity>();
  private readonly roles = new Map<string, Role>();
  private readonly globalRoles = new Map<string, Set<string>>();
  private readonly teams = new Map<string, Team>();
  private readonly memberships = new Map<string, TeamMembership>();
  private readonly invitations = new Map<string, RegistrationInvitation>();
  private readonly externalLinks = new Map<string, ExternalUserLink>();

  constructor(private readonly ownership?: {
    counts(userId: string): Pick<UserMergePreview["counts"], "reservations" | "profiles" | "apiKeys" | "favorites">;
    reassign(sourceUserId: string, targetUserId: string, username: string): void;
  }) { this.seedRoles(); }

  async initializeLegacyUsers(adminUsernames: string[]): Promise<void> {
    for (const username of adminUsernames) {
      let user = await this.getUserByUsername(username);
      if (!user) user = await this.createUser({ username, status: "active" });
      await this.assignGlobalRole(user.id, "role_owner");
    }
  }

  async createUser(input: Omit<UserAccount, "id" | "normalizedUsername" | "sessionVersion" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date; updatedAt?: Date }): Promise<UserAccount> {
    const normalizedUsername = normalizeUsername(input.username);
    if (!normalizedUsername) throw new Error("Username is required");
    if (await this.getUserByUsername(normalizedUsername)) throw new Error("Username is already registered");
    const createdAt = input.createdAt ?? new Date();
    const user: UserAccount = { id: input.id ?? `usr_${nanoid(20)}`, username: input.username.trim(), normalizedUsername, displayName: input.displayName, status: input.status, sessionVersion: 1, createdAt, updatedAt: input.updatedAt ?? createdAt, lastLoginAt: input.lastLoginAt };
    this.users.set(user.id, cloneUser(user));
    await this.assignGlobalRole(user.id, "role_member");
    return cloneUser(user);
  }
  async getUser(id: string): Promise<UserAccount | undefined> { const user=this.users.get(id); return user?cloneUser(user):undefined; }
  async getUserByUsername(username: string): Promise<UserAccount | undefined> { const normalized=normalizeUsername(username); const user=Array.from(this.users.values()).find(value=>value.normalizedUsername===normalized); return user?cloneUser(user):undefined; }
  async listUsers(): Promise<UserAccount[]> { return Array.from(this.users.values()).map(cloneUser).sort((a,b)=>a.normalizedUsername.localeCompare(b.normalizedUsername)); }
  async updateUser(id:string,patch:Partial<Pick<UserAccount,"displayName"|"status"|"lastLoginAt">>):Promise<UserAccount>{const user=this.users.get(id);if(!user)throw new Error("User not found");if(patch.status==="disabled"&&user.status==="active"&&this.hasWildcard(id)&&this.enabledOwnerCount()<=1)throw new Error("The final enabled Owner cannot be disabled");const updated={...user,...patch,updatedAt:new Date()};this.users.set(id,updated);if(patch.status==="disabled")for(const invitation of this.invitations.values())if(invitation.userId===id&&!invitation.revokedAt)invitation.revokedAt=new Date();return cloneUser(updated)}
  async incrementSessionVersion(id:string):Promise<UserAccount>{const user=this.users.get(id);if(!user)throw new Error("User not found");user.sessionVersion+=1;user.updatedAt=new Date();return cloneUser(user)}
  async getLocalPasswordHash(userId:string):Promise<string|undefined>{return this.credentials.get(userId)}
  async setLocalPasswordHash(userId:string,passwordHash:string):Promise<void>{if(!this.users.has(userId))throw new Error("User not found");this.credentials.set(userId,passwordHash)}
  async findIdentity(providerType:UserIdentity["providerType"],providerId:string,subject:string):Promise<UserIdentity|undefined>{const identity=this.identities.get(identityKey(providerType,providerId,subject));return identity?cloneIdentity(identity):undefined}
  async listIdentities(userId:string):Promise<UserIdentity[]>{return Array.from(this.identities.values()).filter(value=>value.userId===userId).map(cloneIdentity)}
  async findUsersByIdentityHint(value:string):Promise<UserAccount[]>{const normalized=normalizeUsername(value);if(!normalized)return[];const ids=new Set<string>();for(const user of this.users.values())if(user.normalizedUsername===normalized)ids.add(user.id);for(const identity of this.identities.values())if([identity.subject,identity.username,identity.email].some(candidate=>candidate&&normalizeUsername(candidate)===normalized))ids.add(identity.userId);return Array.from(ids).map(id=>this.users.get(id)).filter((user):user is UserAccount=>Boolean(user)).map(cloneUser)}
  async saveIdentity(input:Omit<UserIdentity,"id"|"createdAt"|"lastSeenAt">&{id?:string;createdAt?:Date;lastSeenAt?:Date}):Promise<UserIdentity>{const key=identityKey(input.providerType,input.providerId,input.subject);const existing=this.identities.get(key);if(existing&&existing.userId!==input.userId)throw new Error("This external identity is already linked to another NeurOn user");const now=input.lastSeenAt??new Date();const value:UserIdentity={...input,id:existing?.id??input.id??`uid_${nanoid(18)}`,createdAt:existing?.createdAt??input.createdAt??now,lastSeenAt:now};this.identities.set(key,value);return cloneIdentity(value)}
  async listRoles(scope?:Role["scope"]):Promise<Role[]>{return Array.from(this.roles.values()).filter(role=>!scope||role.scope===scope).map(cloneRole).sort((a,b)=>a.name.localeCompare(b.name))}
  async getRole(id:string):Promise<Role|undefined>{const role=this.roles.get(id);return role?cloneRole(role):undefined}
  async createRole(input:Omit<Role,"id"|"createdAt"|"updatedAt">&{id?:string;createdAt?:Date;updatedAt?:Date}):Promise<Role>{const now=input.createdAt??new Date();const role:Role={...input,id:input.id??`role_${nanoid(16)}`,permissions:unique(input.permissions),createdAt:now,updatedAt:input.updatedAt??now};this.roles.set(role.id,role);return cloneRole(role)}
  async updateRole(id:string,input:Pick<Role,"name"|"description"|"permissions">):Promise<Role>{const role=this.roles.get(id);if(!role)throw new Error("Role not found");if(role.systemKey)throw new Error("Built-in roles cannot be modified");Object.assign(role,input,{permissions:unique(input.permissions),updatedAt:new Date()});return cloneRole(role)}
  async deleteRole(id:string):Promise<boolean>{const role=this.roles.get(id);if(!role)return false;if(role.systemKey)throw new Error("Built-in roles cannot be deleted");return this.roles.delete(id)}
  async assignGlobalRole(userId:string,roleId:string):Promise<void>{const role=this.roles.get(roleId);if(!role||role.scope!=="global")throw new Error("Global role not found");const assignments=this.globalRoles.get(userId)??new Set<string>();assignments.add(roleId);this.globalRoles.set(userId,assignments)}
  async revokeGlobalRole(userId:string,roleId:string):Promise<boolean>{const role=this.roles.get(roleId);if(!role||!this.globalRoles.get(userId)?.has(roleId))return false;if(role.systemKey==="owner"&&this.enabledOwnerCount()<=1)throw new Error("The final enabled Owner cannot be removed");return this.globalRoles.get(userId)?.delete(roleId)??false}
  async listGlobalRolesForUser(userId:string):Promise<Role[]>{return Array.from(this.globalRoles.get(userId)??[]).map(id=>this.roles.get(id)).filter((role):role is Role=>Boolean(role)).map(cloneRole)}
  async countEnabledUsersWithPermission(permission:string):Promise<number>{let count=0;for(const user of this.users.values())if(user.status==="active"&&await this.hasPermission(user.id,permission))count+=1;return count}
  async createTeam(input:Omit<Team,"id"|"createdAt"|"updatedAt">&{id?:string;createdAt?:Date;updatedAt?:Date}):Promise<Team>{const now=input.createdAt??new Date();if(input.parentTeamId&&!this.teams.has(input.parentTeamId))throw new Error("Parent team not found");const team:Team={...input,id:input.id??`team_${nanoid(16)}`,createdAt:now,updatedAt:input.updatedAt??now};this.teams.set(team.id,team);return cloneTeam(team)}
  async getTeam(id:string):Promise<Team|undefined>{const team=this.teams.get(id);return team?cloneTeam(team):undefined}
  async listTeams():Promise<Team[]>{return Array.from(this.teams.values()).map(cloneTeam).sort((a,b)=>a.name.localeCompare(b.name))}
  async updateTeam(id:string,input:Pick<Team,"name"|"description"|"parentTeamId">):Promise<Team>{const team=this.teams.get(id);if(!team)throw new Error("Team not found");if(input.parentTeamId&&this.teamAncestors(input.parentTeamId).has(id))throw new Error("Team hierarchy cannot contain a cycle");Object.assign(team,input,{updatedAt:new Date()});return cloneTeam(team)}
  async deleteTeam(id:string):Promise<boolean>{if(Array.from(this.teams.values()).some(team=>team.parentTeamId===id))throw new Error("Team has child teams");for(const key of Array.from(this.memberships.keys()))if(key.startsWith(`${id}\0`))this.memberships.delete(key);return this.teams.delete(id)}
  async setTeamMembership(input:Omit<TeamMembership,"createdAt">&{createdAt?:Date}):Promise<TeamMembership>{const role=this.roles.get(input.roleId);if(!role||role.scope!=="team")throw new Error("Team role not found");if(!this.teams.has(input.teamId)||!this.users.has(input.userId))throw new Error("Team or user not found");const value:TeamMembership={...input,createdAt:input.createdAt??new Date()};this.memberships.set(membershipKey(value),value);return cloneMembership(value)}
  async removeTeamMembership(teamId:string,userId:string,source?:TeamMembership["source"],sourceReference?:string):Promise<boolean>{let removed=false;for(const [key,value]of this.memberships)if(value.teamId===teamId&&value.userId===userId&&(!source||value.source===source)&&(sourceReference===undefined||value.sourceReference===sourceReference)){this.memberships.delete(key);removed=true}return removed}
  async reconcileOidcTeamMemberships(userId:string,providerId:string,memberships:Array<Pick<TeamMembership,"teamId"|"roleId"|"sourceReference">>):Promise<void>{const prefix=`${providerId}:`;for(const value of memberships){if(!value.sourceReference?.startsWith(prefix))throw new Error("OIDC membership source does not match its provider");const role=this.roles.get(value.roleId);if(!this.teams.has(value.teamId)||!role||role.scope!=="team")throw new Error("OIDC membership references an unknown team or team role")}for(const [key,value]of this.memberships)if(value.userId===userId&&value.source==="oidc"&&value.sourceReference?.startsWith(prefix))this.memberships.delete(key);for(const value of memberships){const membership:TeamMembership={...value,userId,source:"oidc",createdAt:new Date()};this.memberships.set(membershipKey(membership),membership)}}
  async listTeamMembershipsForUser(userId:string):Promise<TeamMembership[]>{return Array.from(this.memberships.values()).filter(value=>value.userId===userId).map(cloneMembership)}
  async listTeamMemberships(teamId:string):Promise<TeamMembership[]>{return Array.from(this.memberships.values()).filter(value=>value.teamId===teamId).map(cloneMembership)}
  async isUserInAnyTeam(userId:string,teamIds:string[]):Promise<boolean>{const memberships=await this.listTeamMembershipsForUser(userId);return memberships.some(membership=>{const ancestors=this.teamAncestors(membership.teamId);return teamIds.some(id=>ancestors.has(id))})}
  async matchesUserAudience(userId:string,audienceUserIds:string[]):Promise<boolean>{return audienceUserIds.some(id=>id===userId||this.users.get(id)?.mergedIntoUserId===userId)}
  async createInvitation(input:Omit<RegistrationInvitation,"id"|"useCount"|"createdAt">&{id?:string;useCount?:number;createdAt?:Date}):Promise<RegistrationInvitation>{const invitation:RegistrationInvitation={...input,id:input.id??`invite_${nanoid(18)}`,useCount:input.useCount??0,createdAt:input.createdAt??new Date()};this.invitations.set(invitation.id,invitation);return cloneInvitation(invitation)}
  async getInvitationByTokenHash(hash:string):Promise<RegistrationInvitation|undefined>{const invitation=Array.from(this.invitations.values()).find(value=>value.tokenHash===hash);return invitation?cloneInvitation(invitation):undefined}
  async consumeInvitation(id:string,now:Date):Promise<RegistrationInvitation>{const invitation=this.invitations.get(id);if(!invitation||invitation.revokedAt||invitation.expiresAt<=now||invitation.useCount>=invitation.maxUses)throw new Error("Registration link is expired, revoked, or already used");invitation.useCount+=1;return cloneInvitation(invitation)}
  async redeemInvitation(input:{tokenHash:string;username:string;displayName?:string;passwordHash:string;consumedAt:Date}):Promise<UserAccount>{
    const invitation=Array.from(this.invitations.values()).find(value=>value.tokenHash===input.tokenHash);
    if(!invitation||invitation.revokedAt||invitation.expiresAt<=input.consumedAt||invitation.useCount>=invitation.maxUses)throw new Error("Registration link is expired, revoked, or already used");
    const normalized=normalizeUsername(input.username);
    if(!normalized)throw new Error("Username is required");
    if(invitation.intendedUsername&&normalizeUsername(invitation.intendedUsername)!==normalized)throw new Error("This registration link is for a different username");
    let user=invitation.userId?this.users.get(invitation.userId):undefined;
    if(invitation.userId&&!user)throw new Error("Invitation user not found");
    if(user&&user.normalizedUsername!==normalized)throw new Error("This claim link belongs to a different username");
    if(user?.mergedIntoUserId)throw new Error("This account has been merged into another user");
    if(!user&&await this.getUserByUsername(normalized))throw new Error("Username is already registered; ask an administrator for an account claim link");
    const identity=this.identities.get(identityKey("local","local",normalized));
    if(identity&&identity.userId!==user?.id)throw new Error("This local identity belongs to another account");
    const initialRole=invitation.initialRoleId?this.roles.get(invitation.initialRoleId):undefined;
    if(invitation.initialRoleId&&initialRole?.scope!=="global")throw new Error("Invitation role not found");
    if(!user){
      user=await this.createUser({username:input.username,displayName:input.displayName,status:"active"});
    }else{
      user.displayName=input.displayName??user.displayName;
      if(user.status!=="active")throw new Error("This account is disabled; ask an Owner to reactivate it before using a claim link");
      user.updatedAt=input.consumedAt;
    }
    this.credentials.set(user.id,input.passwordHash);
    await this.saveIdentity({userId:user.id,providerType:"local",providerId:"local",subject:normalized,username:user.username,createdAt:input.consumedAt,lastSeenAt:input.consumedAt});
    if(initialRole)await this.assignGlobalRole(user.id,initialRole.id);
    invitation.useCount+=1;
    user.sessionVersion+=1;
    user.updatedAt=input.consumedAt;
    this.users.set(user.id,user);
    return cloneUser(user);
  }
  async revokeInvitation(id:string,revokedAt:Date):Promise<boolean>{const invitation=this.invitations.get(id);if(!invitation||invitation.revokedAt)return false;invitation.revokedAt=revokedAt;return true}
  async listInvitations():Promise<RegistrationInvitation[]>{return Array.from(this.invitations.values()).map(cloneInvitation).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime())}
  async getExternalUserLink(integration:string,subject:string):Promise<ExternalUserLink|undefined>{const link=this.externalLinks.get(`${integration}\0${subject}`);return link?cloneExternalLink(link):undefined}
  async saveExternalUserLink(input:Omit<ExternalUserLink,"createdAt"|"lastSeenAt">&{createdAt?:Date;lastSeenAt?:Date}):Promise<ExternalUserLink>{const key=`${input.integration}\0${input.externalSubject}`;const existing=this.externalLinks.get(key);if(existing&&existing.userId!==input.userId)throw new Error("External user is already linked to another NeurOn account");const now=input.lastSeenAt??new Date();const link:ExternalUserLink={...input,createdAt:existing?.createdAt??input.createdAt??now,lastSeenAt:now};this.externalLinks.set(key,link);return cloneExternalLink(link)}
  async listExternalUserLinks(integration?:string):Promise<ExternalUserLink[]>{return Array.from(this.externalLinks.values()).filter(value=>!integration||value.integration===integration).map(cloneExternalLink)}
  async deleteExternalUserLink(integration:string,externalSubject:string):Promise<boolean>{return this.externalLinks.delete(`${integration}\0${externalSubject}`)}
  async previewUserMerge(sourceUserId:string,targetUserId:string):Promise<UserMergePreview>{if(sourceUserId===targetUserId)throw new Error("Source and target users must be different");const source=await this.getUser(sourceUserId),target=await this.getUser(targetUserId);if(!source||!target)throw new Error("Source or target user not found");const ownership=this.ownership?.counts(sourceUserId)??{reservations:0,profiles:0,apiKeys:0,favorites:0};return{sourceUser:{id:source.id,username:source.username,status:source.status},targetUser:{id:target.id,username:target.username,status:target.status},counts:{...ownership,identities:(await this.listIdentities(sourceUserId)).length,teamMemberships:(await this.listTeamMembershipsForUser(sourceUserId)).length,externalUserLinks:(await this.listExternalUserLinks()).filter(link=>link.userId===sourceUserId).length}}}
  async mergeUsers(sourceUserId:string,targetUserId:string,mergedAt:Date,_actorUserId?:string):Promise<void>{if(sourceUserId===targetUserId)throw new Error("Source and target users must be different");const source=this.users.get(sourceUserId);const target=this.users.get(targetUserId);if(!source||!target)throw new Error("Source or target user not found");if(source.mergedIntoUserId)throw new Error("Source user has already been merged");if(target.status!=="active"||target.mergedIntoUserId)throw new Error("Merge destination must be an active user");this.ownership?.reassign(sourceUserId,targetUserId,target.username);for(const identity of this.identities.values())if(identity.userId===sourceUserId)identity.userId=targetUserId;for(const link of this.externalLinks.values())if(link.userId===sourceUserId)link.userId=targetUserId;for(const role of this.globalRoles.get(sourceUserId)??[])await this.assignGlobalRole(targetUserId,role);this.globalRoles.delete(sourceUserId);for(const membership of Array.from(this.memberships.values()))if(membership.userId===sourceUserId){this.memberships.delete(membershipKey(membership));membership.userId=targetUserId;const newKey=membershipKey(membership);const existing=this.memberships.get(newKey);if(!existing||(this.roles.get(membership.roleId)?.permissions.length??0)>(this.roles.get(existing.roleId)?.permissions.length??0))this.memberships.set(newKey,membership)}if(!this.credentials.has(targetUserId)&&this.credentials.has(sourceUserId))this.credentials.set(targetUserId,this.credentials.get(sourceUserId)!);this.credentials.delete(sourceUserId);for(const user of this.users.values())if(user.mergedIntoUserId===sourceUserId){user.mergedIntoUserId=targetUserId;user.updatedAt=mergedAt}source.status="disabled";source.mergedIntoUserId=targetUserId;source.sessionVersion+=1;source.updatedAt=mergedAt;target.sessionVersion+=1;target.updatedAt=mergedAt}

  private async hasPermission(userId:string,permission:string):Promise<boolean>{return(await this.listGlobalRolesForUser(userId)).some(role=>role.permissions.includes("*")||role.permissions.includes(permission))}
  private hasWildcard(userId:string):boolean{return Array.from(this.globalRoles.get(userId)??[]).some(id=>this.roles.get(id)?.permissions.includes("*"))}
  private enabledOwnerCount():number{return Array.from(this.users.values()).filter(user=>user.status==="active"&&this.hasWildcard(user.id)).length}
  private teamAncestors(teamId:string):Set<string>{const result=new Set<string>();let current=this.teams.get(teamId);while(current){if(result.has(current.id))throw new Error("Team hierarchy contains a cycle");result.add(current.id);current=current.parentTeamId?this.teams.get(current.parentTeamId):undefined}return result}
  private seedRoles():void{const now=new Date();for(const [id,name,scope,permissions,systemKey] of BUILTIN_ROLES)this.roles.set(id,{id,name,scope,permissions:[...permissions],systemKey,createdAt:now,updatedAt:now})}
}

const BUILTIN_ROLES:Array<[string,string,Role["scope"],string[],string]>=[["role_owner","Owner","global",["*"],"owner"],["role_admin","Administrator","global",["users.manage","users.merge","roles.manage","teams.manage","targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all","assistant.configure","auth.manage","system.manage"],"administrator"],["role_operator","Operator","global",["targets.read_all","targets.use_all","targets.manage","reservations.manage_any","discovery.run","reports.read_all"],"operator"],["role_member","Member","global",["targets.read","targets.use","reservations.create","reservations.manage_own","profiles.manage_own","api_keys.manage_own","favorites.manage_own","reports.read_own"],"member"],["role_viewer","Viewer","global",["targets.read","reports.read_own"],"viewer"],["role_team_owner","Team Owner","team",["team.manage","team.members.manage","team.profiles.manage","team.reports.read"],"team-owner"],["role_team_manager","Team Manager","team",["team.members.manage","team.profiles.manage","team.reports.read"],"team-manager"],["role_team_member","Team Member","team",["team.profiles.use","team.reports.read"],"team-member"],["role_team_viewer","Team Viewer","team",["team.reports.read"],"team-viewer"]];
function normalizeUsername(value:string):string{return value.trim().toLocaleLowerCase("en-US")}
function identityKey(type:string,id:string,subject:string):string{return`${type}\0${id}\0${subject}`}
function membershipKey(value:Pick<TeamMembership,"teamId"|"userId"|"source"|"sourceReference">):string{return`${value.teamId}\0${value.userId}\0${value.source}\0${value.sourceReference??""}`}
function unique(values:string[]):string[]{return Array.from(new Set(values.map(value=>value.trim()).filter(Boolean))).sort()}
function cloneUser(value:UserAccount):UserAccount{return{...value,createdAt:new Date(value.createdAt),updatedAt:new Date(value.updatedAt),lastLoginAt:value.lastLoginAt?new Date(value.lastLoginAt):undefined}}
function cloneIdentity(value:UserIdentity):UserIdentity{return{...value,createdAt:new Date(value.createdAt),lastSeenAt:new Date(value.lastSeenAt)}}
function cloneRole(value:Role):Role{return{...value,permissions:[...value.permissions],createdAt:new Date(value.createdAt),updatedAt:new Date(value.updatedAt)}}
function cloneTeam(value:Team):Team{return{...value,createdAt:new Date(value.createdAt),updatedAt:new Date(value.updatedAt)}}
function cloneMembership(value:TeamMembership):TeamMembership{return{...value,createdAt:new Date(value.createdAt)}}
function cloneInvitation(value:RegistrationInvitation):RegistrationInvitation{return{...value,expiresAt:new Date(value.expiresAt),revokedAt:value.revokedAt?new Date(value.revokedAt):undefined,createdAt:new Date(value.createdAt)}}
function cloneExternalLink(value:ExternalUserLink):ExternalUserLink{return{...value,createdAt:new Date(value.createdAt),lastSeenAt:new Date(value.lastSeenAt)}}
