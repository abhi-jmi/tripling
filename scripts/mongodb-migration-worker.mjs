import { ECSClient, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { createDatabase } from "../server/db.js";
import { mongoFailureDetails } from "../server/mongo-diagnostics.js";
import { postgresSourceClient } from "./postgres-source.mjs";
import { runPreflight } from "./mongo-preflight.mjs";
import {
  exportPostgres,
  importSnapshot,
  verifyImported,
  TRANSFER_COLLECTIONS,
} from "./mongo-transfer.mjs";
export function requirePaused(result) {
  const s = result.services?.[0];
  if (
    result.failures?.length ||
    !s ||
    s.desiredCount !== 0 ||
    s.runningCount !== 0 ||
    s.pendingCount !== 0
  )
    throw Object.assign(new Error("All application writers must be stopped."), {
      code: "WRITERS_NOT_PAUSED",
    });
}
export async function performMigration(
  source,
  target,
  {
    mode,
    assertPaused,
    exportSource = exportPostgres,
    importData = importSnapshot,
    verifyData = verifyImported,
  },
) {
  if (!["transfer", "verify"].includes(mode))
    throw Object.assign(new Error("Invalid worker mode."), {
      code: "INVALID_MODE",
    });
  if (mode === "transfer") await assertPaused();
  const snapshot = await exportSource(source);
  if (mode === "transfer") {
    await assertPaused();
    await importData(target, snapshot);
  }
  await verifyData(target, snapshot, { allowNewPolicies: mode === "verify" });
  if (mode === "transfer") await assertPaused();
  return {
    checksum: snapshot.checksum,
    sourceCounts: Object.fromEntries(
      TRANSFER_COLLECTIONS.map((name) => [
        name,
        snapshot.collections[name].length,
      ]),
    ),
  };
}
async function run() {
  const mode = process.argv[2];
  let source, target, ecs;
  try {
    ecs = new ECSClient({});
    if (mode === "preflight") {
      const current = await ecs.send(
        new DescribeServicesCommand({
          cluster: process.env.SOURCE_CLUSTER_ARN,
          services: [process.env.SOURCE_SERVICE_ARN],
        }),
      );
      if (current.failures?.length || !current.services?.length)
        throw Object.assign(new Error("Source service is unavailable."), {
          code: "SOURCE_SERVICE_UNAVAILABLE",
        });
      await runPreflight();
      return;
    }
    if (
      mode === "transfer" &&
      (process.env.TRIPLING_DATA_MIGRATION_APPROVED !== "yes" ||
        process.env.TRIPLING_WRITES_PAUSED !== "yes")
    )
      throw Object.assign(
        new Error(
          "Explicit paused-write and migration acknowledgement required.",
        ),
        { code: "MIGRATION_NOT_APPROVED" },
      );
    if (!["transfer", "verify"].includes(mode))
      throw Object.assign(new Error("Unknown worker mode."), {
        code: "INVALID_MODE",
      });
    target = await createDatabase();
    source = await postgresSourceClient();
    await source.connect();
    const assertPaused = async () =>
      requirePaused(
        await ecs.send(
          new DescribeServicesCommand({
            cluster: process.env.SOURCE_CLUSTER_ARN,
            services: [process.env.SOURCE_SERVICE_ARN],
          }),
        ),
      );
    const result = await performMigration(source, target, {
      mode,
      assertPaused,
    });
    console.log("SOURCE_COUNTS:", JSON.stringify(result.sourceCounts));
    console.log("SOURCE_SNAPSHOT_CHECKSUM:", result.checksum);
    console.log(
      mode === "transfer"
        ? "MONGODB_TRANSFER_VERIFIED: Original IDs, password hashes, records and consent history match. PostgreSQL is retained unchanged."
        : "MONGODB_FINAL_VERIFICATION_OK: Original source records match MongoDB; additional policy versions are allowed.",
    );
  } catch (e) {
    console.error("MONGODB_MIGRATION_FAILED:", e.code || "TRANSFER_FAILED");
    console.error(
      "MIGRATION_DIAGNOSTIC:",
      JSON.stringify(e.diagnostic || mongoFailureDetails(e)),
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([source?.end(), target?.close()]);
    ecs?.destroy();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await run();
