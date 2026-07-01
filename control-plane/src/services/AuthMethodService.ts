import type { AuthMethodRepository } from "../domain/interfaces.js";
import type { AuthMethod, AuthMethodType } from "../domain/types.js";

export interface AuthMethodView extends AuthMethod {
  source: "config" | "persisted";
  editable: boolean;
}

export class AuthMethodService {
  constructor(
    private readonly configuredMethods: AuthMethod[],
    private readonly repository: AuthMethodRepository
  ) {}

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
    return this.repository.create(input);
  }

  async update(id: string, input: AuthMethod): Promise<AuthMethod> {
    if (await this.isConfigOnly(id)) throw new Error(`Auth method is configured from environment: ${id}`);
    if (id !== input.id && await this.isConfigOnly(input.id)) throw new Error(`Auth method is configured from environment: ${input.id}`);
    return this.repository.update(id, input);
  }

  async delete(id: string): Promise<boolean> {
    if (await this.isConfigOnly(id)) throw new Error(`Auth method is configured from environment: ${id}`);
    return this.repository.delete(id);
  }

  async copyConfiguredToPersistence(id: string): Promise<AuthMethod> {
    const method = this.configuredMethods.find((candidate) => candidate.id === id);
    if (!method) throw new Error(`Configured auth method not found: ${id}`);
    return this.repository.create(cloneAuthMethod(method));
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
