import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { readFile } from "node:fs/promises";
export async function postgresSourceClient() {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(1082, (value) => value);
  let config = {
    connectionString: process.env.PG_SOURCE_DATABASE_URL,
    connectionTimeoutMillis: 10000,
    application_name: "tripling-read-only-export",
  };
  if (process.env.PG_SOURCE_SECRET_ARN) {
    const secrets = new SecretsManagerClient({});
    try {
      const value = await secrets.send(
        new GetSecretValueCommand({
          SecretId: process.env.PG_SOURCE_SECRET_ARN,
        }),
      );
      let credentials;
      try {
        credentials = JSON.parse(value.SecretString);
      } catch {
        throw new Error("Invalid PostgreSQL source secret.");
      }
      config = {
        ...config,
        connectionString: undefined,
        host: process.env.PG_SOURCE_HOST,
        database: process.env.PG_SOURCE_DATABASE || "tripling",
        user: credentials.username,
        password: credentials.password,
        port: 5432,
      };
    } finally {
      secrets.destroy();
    }
  }
  if (!config.connectionString && !config.host)
    throw new Error("Configure PostgreSQL source credentials privately.");
  if (process.env.NODE_ENV === "production") {
    if (!process.env.PG_SOURCE_SSL_CA)
      throw new Error("Production export requires PG_SOURCE_SSL_CA.");
    if (
      config.connectionString &&
      [...new URL(config.connectionString).searchParams.keys()].some((k) =>
        k.toLowerCase().startsWith("ssl"),
      )
    )
      throw new Error("Do not override source TLS settings in the URI.");
    config.ssl = {
      rejectUnauthorized: true,
      ca: await readFile(process.env.PG_SOURCE_SSL_CA, "utf8"),
    };
  }
  return new pg.Client(config);
}
