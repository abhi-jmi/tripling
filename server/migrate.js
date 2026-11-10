import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { transaction } from "./db.js";
export async function migrate(pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(89432017)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("./migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(file, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await db.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [file],
      );
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== checksum)
          throw new Error(`Migration changed after applying: ${file}`);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations(name, checksum) VALUES($1,$2)",
        [file, checksum],
      );
    }
    await db.query("DELETE FROM sessions WHERE expires_at < now()");
    await db.query("DELETE FROM auth_rate_limits WHERE window_start < $1", [
      Math.floor(Date.now() / 900000) - 2,
    ]);
  });
}
