import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AuthSecretReference } from "../domain/types.js";

interface SecretsManagerReader {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}

export class AuthSecretResolver {
  private readonly secretsManager: SecretsManagerReader;

  constructor(region: string, secretsManager?: SecretsManagerReader) {
    this.secretsManager = secretsManager ?? new SecretsManagerClient({ region });
  }

  async resolve(reference: AuthSecretReference): Promise<string> {
    if (reference.source === "stored") {
      if (!reference.value) throw new Error("The stored client secret is empty");
      return reference.value;
    }
    if (reference.source === "environment") {
      const value = process.env[reference.environmentVariable];
      if (!value) throw new Error(`Client secret environment variable is not set: ${reference.environmentVariable}`);
      return value;
    }
    const response = await this.secretsManager.send(new GetSecretValueCommand({ SecretId: reference.secretId }));
    const secret = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);
    if (!secret) throw new Error(`AWS Secrets Manager returned an empty value for ${reference.secretId}`);
    if (!reference.jsonKey) return secret;
    let parsed: unknown;
    try {
      parsed = JSON.parse(secret) as unknown;
    } catch {
      throw new Error(`AWS secret ${reference.secretId} is not valid JSON`);
    }
    const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[reference.jsonKey] : undefined;
    if (typeof value !== "string" || !value) throw new Error(`AWS secret ${reference.secretId} does not contain string key ${reference.jsonKey}`);
    return value;
  }
}
