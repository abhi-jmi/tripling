import test from "node:test";
import assert from "node:assert/strict";
import {
  performMigration,
  requirePaused,
} from "../../scripts/mongodb-migration-worker.mjs";
import { TRANSFER_COLLECTIONS } from "../../scripts/mongo-transfer.mjs";
const snapshot = {
  checksum: "fixture-checksum",
  collections: Object.fromEntries(
    TRANSFER_COLLECTIONS.map((name) => [name, []]),
  ),
};
await test("migration refuses a running, pending or missing application service", () => {
  for (const service of [
    { desiredCount: 1, runningCount: 1, pendingCount: 0 },
    { desiredCount: 0, runningCount: 1, pendingCount: 0 },
    { desiredCount: 0, runningCount: 0, pendingCount: 1 },
  ])
    assert.throws(() => requirePaused({ services: [service] }), {
      code: "WRITERS_NOT_PAUSED",
    });
  assert.throws(() => requirePaused({ services: [] }), {
    code: "WRITERS_NOT_PAUSED",
  });
  assert.doesNotThrow(() =>
    requirePaused({
      services: [{ desiredCount: 0, runningCount: 0, pendingCount: 0 }],
    }),
  );
});
await test("migration checks paused writers before export, before import and after verification", async () => {
  const steps = [];
  const result = await performMigration("source", "target", {
    mode: "transfer",
    assertPaused: async () => steps.push("paused"),
    exportSource: async () => {
      steps.push("export");
      return snapshot;
    },
    importData: async () => steps.push("import"),
    verifyData: async (target, data, options) => {
      steps.push("verify");
      assert.equal(options.allowNewPolicies, false);
    },
  });
  assert.deepEqual(steps, [
    "paused",
    "export",
    "paused",
    "import",
    "verify",
    "paused",
  ]);
  assert.equal(result.sourceCounts.users, 0);
});
await test("writers resuming during export prevent any import", async () => {
  let checks = 0;
  let imported = false;
  await assert.rejects(
    () =>
      performMigration(null, null, {
        mode: "transfer",
        assertPaused: async () => {
          if (++checks === 2)
            throw Object.assign(new Error(), { code: "WRITERS_NOT_PAUSED" });
        },
        exportSource: async () => snapshot,
        importData: async () => {
          imported = true;
        },
        verifyData: async () => {},
      }),
    { code: "WRITERS_NOT_PAUSED" },
  );
  assert.equal(imported, false);
});
await test("final verification never imports or demands all MongoDB application tasks stop", async () => {
  let verified = false;
  await performMigration(null, null, {
    mode: "verify",
    assertPaused: async () => assert.fail("not called"),
    exportSource: async () => snapshot,
    importData: async () => assert.fail("not called"),
    verifyData: async (target, data, options) => {
      verified = true;
      assert.equal(options.allowNewPolicies, true);
    },
  });
  assert.equal(verified, true);
});
