import { createDatabase } from "../server/db.js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { readFile } from "node:fs/promises";
import {
  exportPostgres,
  writeSnapshot,
  readSnapshot,
  importSnapshot,
  verifyImported,
} from "./mongo-transfer.mjs";
const [mode, path] = process.argv.slice(2);
async function run() {
  if (!["export", "import", "verify"].includes(mode) || !path)
    throw new Error(
      "Usage: node scripts/migrate-postgres-to-mongo.mjs export|import|verify /private/path/snapshot.json",
    );
  if (mode === "export") {
    if (process.env.TRIPLING_WRITES_PAUSED !== "yes")
      throw new Error(
        "Pause all live application writers, then set TRIPLING_WRITES_PAUSED=yes before final export.",
      );
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
    const client = new pg.Client(config);
    try {
      await client.connect();
      const snapshot = await exportPostgres(client);
      await writeSnapshot(path, snapshot);
      console.log(
        "Read-only snapshot exported. Store this sensitive file securely.",
      );
      console.log(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(snapshot.collections).map(([name, rows]) => [
              name,
              rows.length,
            ]),
          ),
        ),
      );
    } finally {
      await client.end();
    }
    return;
  }
  const snapshot = await readSnapshot(path),
    db = await createDatabase();
  try {
    if (mode === "verify") {
      await verifyImported(db, snapshot, { allowNewPolicies: true });
      console.log(
        "Original MongoDB records match the snapshot; additional policy versions are allowed.",
      );
      return;
    }
    if (
      process.env.TRIPLING_DATA_MIGRATION_APPROVED !== "yes" ||
      process.env.TRIPLING_WRITES_PAUSED !== "yes"
    )
      throw new Error(
        "Import requires paused writers and TRIPLING_DATA_MIGRATION_APPROVED=yes.",
      );
    const result = await importSnapshot(db, snapshot);
    console.log(
      result.alreadyImported
        ? "Verified existing import; no records overwritten."
        : "Atomic import completed and verified.",
    );
  } finally {
    await db.close();
  }
}
run().catch((e) => {
  console.error("Data transfer stopped:", e.code || "TRANSFER_FAILED");
  if (
    !e.code &&
    !/password|postgres:\/\/|mongodb(?:\+srv)?:\/\//i.test(e.message)
  )
    console.error(e.message);
  process.exitCode = 1;
});
