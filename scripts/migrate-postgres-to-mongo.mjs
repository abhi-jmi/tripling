import { createDatabase } from "../server/db.js";
import { postgresSourceClient } from "./postgres-source.mjs";
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
    const client = await postgresSourceClient();
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
