import test from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../../scripts/mongo-preflight.mjs";
import { TRANSFER_COLLECTIONS } from "../../scripts/mongo-transfer.mjs";
await test("migration preflight only reads source and counts target records", async () => {
  const called = [],
    snapshot = {
      collections: Object.fromEntries(
        TRANSFER_COLLECTIONS.map((name) => [name, []]),
      ),
    };
  snapshot.collections.users = [
    { id: "private-user", password_hash: "private-hash" },
  ];
  const result = await preflight(
    "source",
    {
      count: async (name) => {
        called.push(name);
        return 0;
      },
    },
    async (source) => {
      assert.equal(source, "source");
      return snapshot;
    },
  );
  assert.equal(result.sourceCounts.users, 1);
  assert.deepEqual(called, TRANSFER_COLLECTIONS);
  assert(!JSON.stringify(result).includes("private"));
});
await test("migration preflight refuses an occupied destination without writes", async () => {
  const snapshot = {
    collections: Object.fromEntries(
      TRANSFER_COLLECTIONS.map((name) => [name, []]),
    ),
  };
  await assert.rejects(
    () =>
      preflight(
        null,
        { count: async (name) => (name === "trips" ? 1 : 0) },
        async () => snapshot,
      ),
    { code: "DESTINATION_NOT_EMPTY" },
  );
});
