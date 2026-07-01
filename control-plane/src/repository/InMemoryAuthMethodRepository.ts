import type { AuthMethodRepository } from "../domain/interfaces.js";
import type { AuthMethod } from "../domain/types.js";

export class InMemoryAuthMethodRepository implements AuthMethodRepository {
  private readonly methods = new Map<string, AuthMethod>();

  async create(input: AuthMethod): Promise<AuthMethod> {
    if (this.methods.has(input.id)) throw new Error(`Auth method already exists: ${input.id}`);
    this.methods.set(input.id, cloneAuthMethod(input));
    return cloneAuthMethod(input);
  }

  async get(id: string): Promise<AuthMethod | undefined> {
    const method = this.methods.get(id);
    return method ? cloneAuthMethod(method) : undefined;
  }

  async list(): Promise<AuthMethod[]> {
    return Array.from(this.methods.values())
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
      .map(cloneAuthMethod);
  }

  async update(id: string, input: AuthMethod): Promise<AuthMethod> {
    if (!this.methods.has(id)) throw new Error(`Auth method not found: ${id}`);
    this.methods.delete(id);
    this.methods.set(input.id, cloneAuthMethod(input));
    return cloneAuthMethod(input);
  }

  async delete(id: string): Promise<boolean> {
    return this.methods.delete(id);
  }
}

function cloneAuthMethod(method: AuthMethod): AuthMethod {
  return JSON.parse(JSON.stringify(method)) as AuthMethod;
}
