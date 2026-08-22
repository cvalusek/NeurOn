import type { AuthMethodRepository, IdentityRepository } from "../domain/interfaces.js";
import type { AuthMethod, AuthMethodType } from "../domain/types.js";

export interface AuthMethodView extends AuthMethod {
  source: "config" | "persisted";
  editable: boolean;
}

export class AuthMethodService {
  constructor(
    private readonly configuredMethods: AuthMethod[],
    private readonly repository: AuthMethodRepository,
    private readonly identities?: IdentityRepository
  ) {}

  async initialize(): Promise<void> {
    if (this.configuredMethods.some((method) => method.type === "local") || (await this.repository.list()).some((method) => method.type === "local")) return;
    await this.repository.create({
      id: "local",
      displayName: "Username and password",
      type: "local",
      enabled: true,
      config: { local: { registrationEnabled: true } }
    });
  }

  async list(): Promise<AuthMethodView[]> {
    const persistedMethods = await this.repository.list();
    const persistedIds = new Set(persistedMethods.map((method) => method.id));
    const configured = this.configuredMethods
      .filter((method) => !persistedIds.has(method.id))
      .map((method) => ({ ...cloneAuthMethod(method), source: "config" as const, editable: false }));
    const persisted = persistedMethods.map((method) => ({ ...method, source: "persisted" as const, editable: true }));
    return [...configured, ...persisted].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async listEnabled(type?: AuthMethodType): Promise<AuthMethod[]> {
    return (await this.list()).filter((method) => method.enabled && (!type || method.type === type)).map(stripView);
  }

  async get(id: string): Promise<AuthMethodView | undefined> {
    return (await this.list()).find((method) => method.id === id);
  }

  async create(input: AuthMethod): Promise<AuthMethod> {
    if (await this.isConfigOnly(input.id)) throw new Error(`Auth method is configured from environment: ${input.id}`);
    if (input.type === "local" && (await this.list()).some((method) => method.type === "local")) throw new Error("The local authentication method already exists");
    await this.validateOidcRules(input);
    return this.repository.create(input);
  }

  async update(id: string, input: AuthMethod): Promise<AuthMethod> {
    if (await this.isConfigOnly(id)) throw new Error(`Auth method is configured from environment: ${id}`);
    if (id !== input.id && await this.isConfigOnly(input.id)) throw new Error(`Auth method is configured from environment: ${input.id}`);
    const current = await this.get(id);
    if (current?.type === "local" && (input.type !== "local" || input.id !== id)) throw new Error("The local authentication method cannot be renamed or changed to another type");
    await this.validateOidcRules(input);
    if (current?.type === "oidc" && (!input.enabled || input.type !== "oidc" || input.id !== id)) await this.clearOidcMemberships(id);
    return this.repository.update(id, input);
  }

  async delete(id: string): Promise<boolean> {
    if (await this.isConfigOnly(id)) throw new Error(`Auth method is configured from environment: ${id}`);
    const method = await this.get(id);
    if (method?.type === "local") throw new Error("The local authentication method can be disabled but not deleted");
    if (method?.type === "oidc") await this.clearOidcMemberships(id);
    return this.repository.delete(id);
  }

  async localEnabled(): Promise<boolean> {
    return (await this.listEnabled("local")).length > 0;
  }

  async localRegistrationEnabled(): Promise<boolean> {
    const method = (await this.listEnabled("local"))[0];
    return Boolean(method && method.config.local?.registrationEnabled !== false);
  }

  async copyConfiguredToPersistence(id: string): Promise<AuthMethod> {
    const method = this.configuredMethods.find((candidate) => candidate.id === id);
    if (!method) throw new Error(`Configured auth method not found: ${id}`);
    await this.validateOidcRules(method);
    return this.repository.create(cloneAuthMethod(method));
  }

  private async validateOidcRules(method: AuthMethod): Promise<void> {
    const rules = method.config.oidc?.teamMembershipRules ?? [];
    const ids = new Set<string>();
    for (const rule of rules) {
      if (!rule.id.trim() || ids.has(rule.id)) throw new Error(`OIDC membership rule IDs must be nonempty and unique: ${rule.id || "(empty)"}`);
      ids.add(rule.id);
      if (!rule.claim.trim() || !rule.value) throw new Error(`OIDC membership rule ${rule.id} needs a claim and value`);
      if (rule.value.length > 300) throw new Error(`OIDC membership rule ${rule.id} pattern is too long`);
      if (rule.match === "regex") { try { new RegExp(rule.value, "u"); } catch { throw new Error(`OIDC membership rule ${rule.id} has an invalid regular expression`); } }
      if (this.identities) {
        const [team, role] = await Promise.all([this.identities.getTeam(rule.teamId), this.identities.getRole(rule.roleId)]);
        if (!team) throw new Error(`OIDC membership rule ${rule.id} references an unknown team`);
        if (!role || role.scope !== "team") throw new Error(`OIDC membership rule ${rule.id} references an unknown team role`);
      }
    }
  }

  private async clearOidcMemberships(providerId: string): Promise<void> {
    if (!this.identities) return;
    for (const user of await this.identities.listUsers()) await this.identities.reconcileOidcTeamMemberships(user.id, providerId, []);
  }

  private async isConfigOnly(id: string): Promise<boolean> {
    return this.configuredMethods.some((method) => method.id === id) && !(await this.repository.get(id));
  }
}

function stripView(method: AuthMethodView): AuthMethod {
  return {
    id: method.id,
    displayName: method.displayName,
    type: method.type,
    enabled: method.enabled,
    config: cloneAuthMethod(method).config
  };
}

function cloneAuthMethod(method: AuthMethod): AuthMethod {
  return JSON.parse(JSON.stringify(method)) as AuthMethod;
}
