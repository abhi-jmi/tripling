import { createDatabase } from "../server/db.js";
import { mongoFailureDetails } from "../server/mongo-diagnostics.js";
import { postgresSourceClient } from "./postgres-source.mjs";
import { exportPostgres, TRANSFER_COLLECTIONS } from "./mongo-transfer.mjs";
export async function preflight(source, target, exportSource = exportPostgres) {
  const snapshot = await exportSource(source),
    sourceCounts = Object.fromEntries(
      TRANSFER_COLLECTIONS.map((name) => [
        name,
        snapshot.collections[name].length,
      ]),
    );
  const targetCounts = {};
  for (const name of TRANSFER_COLLECTIONS)
    targetCounts[name] = await target.count(name);
  if (Object.values(targetCounts).some((n) => n > 0))
    throw Object.assign(
      new Error(
        "Target contains application records; no transfer was performed.",
      ),
      { code: "DESTINATION_NOT_EMPTY", sourceCounts, targetCounts },
    );
  return { sourceCounts, targetCounts };
}
export async function runPreflight() {
  let source, target;
  try {
    target = await createDatabase();
    source = await postgresSourceClient();
    await source.connect();
    const result = await preflight(source, target);
    console.log("SOURCE_COUNTS:", JSON.stringify(result.sourceCounts));
    console.log("TARGET_COUNTS:", JSON.stringify(result.targetCounts));
    console.log(
      "MIGRATION_PREFLIGHT_OK: PostgreSQL snapshot is valid and the MongoDB target is empty. No records were changed or transferred.",
    );
  } catch (e) {
    console.error("MIGRATION_PREFLIGHT_FAILED:", e.code || "PREFLIGHT_FAILED");
    if (e.sourceCounts)
      console.error("SOURCE_COUNTS:", JSON.stringify(e.sourceCounts));
    if (e.targetCounts)
      console.error("TARGET_COUNTS:", JSON.stringify(e.targetCounts));
    console.error(
      "MIGRATION_DIAGNOSTIC:",
      JSON.stringify(e.diagnostic || mongoFailureDetails(e)),
    );
    process.exitCode = 1;
  } finally {
    await source?.end();
    await target?.close();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await runPreflight();
