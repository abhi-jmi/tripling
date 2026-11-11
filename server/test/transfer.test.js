import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createDatabase, transaction } from "../db.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { createApp } from "../app.js";
import {
  makeSnapshot,
  verifySnapshot,
  exportPostgres,
  importSnapshot,
  verifyImported,
  writeSnapshot,
  readSnapshot,
} from "../../scripts/mongo-transfer.mjs";

const mongoUri = process.env.TEST_MONGODB_URI;
if (!mongoUri) throw new Error("Set TEST_MONGODB_URI for MongoDB tests.");
await test("MongoDB transactions, uniqueness and migration integrity", async (t) => {
  const db = await createDatabase({
    MONGODB_URI: mongoUri,
    MONGODB_DATABASE: "tripling_transfer_test",
    NODE_ENV: "test",
  });
  try {
    const { migrate, COLLECTIONS } = await import("../migrate.js");
    await migrate(db);
    for (const name of COLLECTIONS)
      if (name !== "location_catalog") await db.removeMany(name, {});
    await t.test("transaction failure rolls back all writes", async () => {
      await assert.rejects(
        () =>
          transaction(db, async (target) => {
            await target.insert("users", { email: "rollback@example.com" });
            await target.insert("trips", { title: "Must not remain" });
            throw new Error("rollback-check");
          }),
        /rollback-check/,
      );
      assert.equal(await db.count("users"), 0);
      assert.equal(await db.count("trips"), 0);
    });
    await t.test(
      "duplicate accounts and composite memberships are rejected by indexes",
      async () => {
        const u = await db.insert("users", { email: "unique@example.com" });
        await assert.rejects(() => db.insert("users", { email: u.email }), {
          code: 11000,
        });
        await db.insert("trip_members", { trip_id: "fixture", user_id: u.id });
        await assert.rejects(
          () =>
            db.insert("trip_members", { trip_id: "fixture", user_id: u.id }),
          { code: 11000 },
        );
        await db.removeMany("users", {});
        await db.removeMany("trip_members", {});
      },
    );
    const empty = Object.fromEntries(
      (
        await import("../../scripts/mongo-transfer.mjs")
      ).TRANSFER_COLLECTIONS.map((name) => [name, []]),
    );
    const sample = makeSnapshot({
      ...empty,
      users: [{ id: randomUUID(), email: "safe@example.com" }],
    });
    await t.test("tampered snapshots fail before touching target", async () => {
      const broken = structuredClone(sample);
      broken.collections.users[0].email = "changed@example.com";
      assert.throws(() => verifySnapshot(broken), /checksum/);
      await assert.rejects(() => importSnapshot(db, broken), /checksum/);
      assert.equal(await db.count("users"), 0);
    });
    await t.test(
      "snapshot files are private and never silently overwritten",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "tripling-transfer-"));
        try {
          const path = join(dir, "snapshot.json");
          await writeSnapshot(path, sample);
          assert.equal((await stat(path)).mode & 0o777, 0o600);
          assert.equal((await readSnapshot(path)).checksum, sample.checksum);
          await assert.rejects(() => writeSnapshot(path, sample), {
            code: "EEXIST",
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "import preserves IDs and refuses to overwrite existing data",
      async () => {
        await importSnapshot(db, sample);
        assert.equal(
          (await db.one("users", { email: "safe@example.com" })).id,
          sample.collections.users[0].id,
        );
        assert.equal((await importSnapshot(db, sample)).alreadyImported, true);
        await assert.rejects(
          () =>
            importSnapshot(
              db,
              makeSnapshot({
                ...empty,
                users: [{ id: randomUUID(), email: "other@example.com" }],
              }),
            ),
          /must be empty/,
        );
        await db.update(
          "users",
          { id: sample.collections.users[0].id },
          { $set: { email: "modified@example.com" } },
        );
        await assert.rejects(() => verifyImported(db, sample), /differs/);
        for (const name of COLLECTIONS)
          if (name !== "location_catalog") await db.removeMany(name, {});
      },
    );
    await t.test(
      "read-only PostgreSQL snapshot imports with account hashes and history intact",
      { skip: !process.env.PG_SOURCE_TEST_URI },
      async () => {
        const uri = process.env.PG_SOURCE_TEST_URI;
        if (!new URL(uri).pathname.endsWith("_test"))
          throw new Error(
            "PostgreSQL fixture requires an isolated _test database.",
          );
        const { default: pg } = await import("pg");
        pg.types.setTypeParser(1082, (value) => value);
        const source = new pg.Client({ connectionString: uri });
        await source.connect();
        try {
          await source.query(
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public",
          );
          await source.query(
            "CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text,applied_at timestamptz DEFAULT now())",
          );
          for (const file of ["001_initial.sql", "002_legal_documents.sql"]) {
            const sql = await readFile(
              new URL(
                "../../scripts/legacy/postgres-migrations/" + file,
                import.meta.url,
              ),
              "utf8",
            );
            await source.query(sql);
            await source.query(
              "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
              [file, createHash("sha256").update(sql).digest("hex")],
            );
          }
          const password = "Existing account passphrase!",
            hash = await hashPassword(password),
            owner = randomUUID(),
            member = randomUUID(),
            trip = randomUUID();
          await source.query(
            "INSERT INTO users(id,email,password_hash,display_name,adult_confirmed) VALUES($1,$2,$3,$4,true),($5,$6,$3,$7,true)",
            [
              owner,
              "legacy@example.com",
              hash,
              "Legacy Organizer",
              member,
              "member@example.com",
              "Legacy Member",
            ],
          );
          await source.query(
            "INSERT INTO trips(id,owner_id,title,destination,from_city,starts_on,ends_on,budget_min,budget_max,existing_travelers,capacity,category,mode,description) VALUES($1,$2,'Imported mountain journey','Manali','Delhi','2020-01-01','2020-01-03',1000,2000,1,3,'Mountains','Bus','A fully preserved travel plan for this database transfer.')",
            [trip, owner],
          );
          await source.query(
            "INSERT INTO trip_members(trip_id,user_id,joined_at) VALUES($1,$2,'2019-12-31'),($1,$3,'2019-12-31')",
            [trip, owner, member],
          );
          await source.query(
            "INSERT INTO messages(id,trip_id,user_id,body) OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1,$2,'The original planning message')",
            [trip, member],
          );
          await source.query(
            "INSERT INTO reviews(trip_id,author_id,traveler_id,rating,body) VALUES($1,$2,$3,5,'Respectful and reliable travel companion')",
            [trip, member, owner],
          );
          for (const slug of ["terms", "privacy"]) {
            await source.query(
              "INSERT INTO legal_documents(slug,version,title,content,operator_name,contact_email,jurisdiction,effective_on,published) VALUES($1,$2,$1,$3,$4,$5,$6,$7,true)",
              [
                slug,
                "legacy-version",
                JSON.stringify({
                  introduction: "Original policy",
                  sections: [],
                }),
                "Tripling",
                "abhishek@tripling.in",
                "India",
                "2026-11-10",
              ],
            );
            await source.query(
              "INSERT INTO legal_acceptances(user_id,slug,version) VALUES($1,$2,$3)",
              [owner, slug, "legacy-version"],
            );
          }
          await source.query(
            "INSERT INTO saved_trips(user_id,trip_id) VALUES($1,$2)",
            [member, trip],
          );
          await source.query(
            "INSERT INTO hidden_trips(user_id,trip_id) VALUES($1,$2)",
            [member, trip],
          );
          await source.query(
            "INSERT INTO join_requests(trip_id,user_id,note,status) VALUES($1,$2,'The original accepted introduction','accepted')",
            [trip, member],
          );
          await source.query(
            "INSERT INTO reports(reporter_id,trip_id,reason) VALUES($1,$2,'Original concern')",
            [member, trip],
          );
          await source.query(
            "INSERT INTO notifications(user_id,trip_id,body) VALUES($1,$2,'Original trip notification')",
            [member, trip],
          );
          const before = (await source.query("SELECT count(*) FROM users"))
            .rows[0].count;
          const snapshot = await exportPostgres(source);
          assert.equal(snapshot.collections.trip_participants.length, 2);
          assert.equal(snapshot.collections.trips[0].organizer_id, owner);
          await importSnapshot(db, JSON.parse(JSON.stringify(snapshot)));
          assert.equal(await verifyImported(db, snapshot), true);
          const imported = await db.one("users", { id: owner });
          assert.equal(imported.password_hash, hash);
          assert.equal(
            await verifyPassword(password, imported.password_hash),
            true,
          );
          assert.equal(
            (await db.one("messages", { trip_id: trip })).id,
            "9007199254740993",
          );
          assert.equal(
            (await source.query("SELECT count(*) FROM users")).rows[0].count,
            before,
          );
          const server = createApp(db, { production: false }).listen(
            0,
            "127.0.0.1",
          );
          await new Promise((resolve) => server.once("listening", resolve));
          try {
            const origin = `http://127.0.0.1:${server.address().port}`;
            const login = await fetch(origin + "/api/auth/login", {
              method: "POST",
              headers: { Origin: origin, "Content-Type": "application/json" },
              body: JSON.stringify({ email: "legacy@example.com", password }),
            });
            assert.equal(login.status, 200);
            assert.equal((await login.json()).user.id, owner);
            const bootstrap = await (
              await fetch(origin + "/api/bootstrap")
            ).json();
            assert.equal(bootstrap.trips[0].reviewCount, 1);
            assert.equal(bootstrap.trips[0].lifecycle, "completed");
            assert(!JSON.stringify(bootstrap).includes(hash));
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
          // Repeat with the post-feature schema: preserve private notices and identities too.
          const featureSql = await readFile(
            new URL(
              "../../scripts/legacy/postgres-migrations/003_travelers_and_history.sql",
              import.meta.url,
            ),
            "utf8",
          );
          await source.query(featureSql);
          await source.query(
            "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
            [
              "003_travelers_and_history.sql",
              createHash("sha256").update(featureSql).digest("hex"),
            ],
          );
          const blockId = randomUUID();
          await source.query(
            "INSERT INTO user_blocks(id,blocker_id,blocked_id,context_trip_id,category,reason) VALUES($1,$2,$3,$4,'Safety concern','The original participant-only block statement.')",
            [blockId, owner, member, trip],
          );
          await source.query(
            "INSERT INTO block_reason_reports(block_id,reporter_id,reason) VALUES($1,$2,'Please consider the full context of this statement.')",
            [blockId, member],
          );
          await source.query(
            "INSERT INTO oauth_identities(provider,subject,user_id) VALUES('google','preserved-google-subject',$1)",
            [owner],
          );
          const full = await exportPostgres(source),
            fullDb = await createDatabase({
              MONGODB_URI: mongoUri,
              MONGODB_DATABASE: "tripling_transfer_full_test",
              NODE_ENV: "test",
            });
          try {
            await migrate(fullDb);
            for (const name of COLLECTIONS)
              if (name !== "location_catalog")
                await fullDb.removeMany(name, {});
            await importSnapshot(fullDb, JSON.parse(JSON.stringify(full)));
            assert.equal(await verifyImported(fullDb, full), true);
            assert.equal(
              (await fullDb.one("user_blocks", { id: blockId })).reason,
              "The original participant-only block statement.",
            );
            assert.equal(
              (
                await fullDb.one("oauth_identities", {
                  subject: "preserved-google-subject",
                })
              ).user_id,
              owner,
            );
            assert.equal(await fullDb.count("block_reason_reports"), 1);
          } finally {
            await fullDb.close();
          }
        } finally {
          await source.end();
        }
      },
    );
  } finally {
    await db.close();
  }
});
