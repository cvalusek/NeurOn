export class InMemoryProviderCredentials {
  private readonly values = new Map<string, Buffer>();

  put(credentialId: string, value: string): { replaced: boolean } {
    const next = Buffer.from(value, "utf8");
    const previous = this.values.get(credentialId);
    this.values.set(credentialId, next);
    previous?.fill(0);
    return { replaced: Boolean(previous) };
  }

  has(credentialId: string): boolean {
    return this.values.has(credentialId);
  }

  get(credentialId: string): string | undefined {
    return this.values.get(credentialId)?.toString("utf8");
  }

  clear(): void {
    for (const value of this.values.values()) value.fill(0);
    this.values.clear();
  }
}
