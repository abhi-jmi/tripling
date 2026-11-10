import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
pg.types.setTypeParser(1082, (value) => value);

export async function createPool(env = process.env) {
  const config = {
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  };
  if (env.DATABASE_URL) {
    if (env.NODE_ENV === "production") {
      const url = new URL(env.DATABASE_URL);
      if (
        [...url.searchParams.keys()].some((key) =>
          key.toLowerCase().startsWith("ssl"),
        )
      )
        throw new Error(
          "Production DATABASE_URL must not override DB_SSL_CA TLS settings.",
        );
    }
    config.connectionString = env.DATABASE_URL;
  } else {
    if (!env.DB_SECRET_ARN || !env.DB_HOST)
      throw new Error("Configure DATABASE_URL or DB_SECRET_ARN and DB_HOST.");
    const secrets = new SecretsManagerClient({ region: env.AWS_REGION });
    const result = await secrets.send(
      new GetSecretValueCommand({ SecretId: env.DB_SECRET_ARN }),
    );
    const credentials = JSON.parse(result.SecretString);
    Object.assign(config, {
      host: env.DB_HOST,
      port: 5432,
      database: env.DB_NAME || "tripling",
      user: credentials.username,
      password: credentials.password,
    });
  }
  if (env.NODE_ENV === "production") {
    if (!env.DB_SSL_CA)
      throw new Error(
        "Production requires DB_SSL_CA for verified database TLS.",
      );
    config.ssl = {
      rejectUnauthorized: true,
      ca: await readFile(env.DB_SSL_CA, "utf8"),
    };
  }
  const pool = new pg.Pool(config);
  pool.on("error", (err) =>
    console.error("Database connection error:", err.code || "unknown"),
  );
  return pool;
}
export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
