import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./launch-helpers.js";
import { refreshLocationBatch } from "../location-maintenance.js";
import { tripNotices } from "../blocks.js";
const tripData = (owner, n = 0) => ({
  owner_id: owner,
  organizer_id: owner,
  title: "Mountain journey " + n,
  from_city: "Delhi",
  destination: "Manali",
  starts_on: "2099-01-01",
  ends_on: "2099-01-03",
  departure_utc: "2099-01-01T08:00:00Z",
  departure_timezone: "Asia/Kolkata",
  budget_min: 1000 + n,
  budget_max: 4000,
  capacity: 6,
  existing_travelers: 1,
  category: "Adventure",
  women_only: false,
  mode: "Train",
  description: "A mountain journey",
  image: "manali",
});
test("admin report queues include historical reports, audit decisions and preserve personal blocks", async (t) => {
  const { db, client } = await fixture(t, "tripling_report_queue_test");
  const admin = client(),
    visitor = client(),
    member = client();
  const a = await admin.signup("Admin"),
    u = await member.signup("Member");
  const previous = process.env.TRIPLING_ADMIN_USER_IDS;
  process.env.TRIPLING_ADMIN_USER_IDS = a.id;
  t.after(() => {
    if (previous === undefined) delete process.env.TRIPLING_ADMIN_USER_IDS;
    else process.env.TRIPLING_ADMIN_USER_IDS = previous;
  });
  const trip = await db.insert("trips", tripData(a.id));
  await db.insert("trip_members", { trip_id: trip.id, user_id: u.id });
  await db.insert("trip_participants", { trip_id: trip.id, user_id: u.id });
  const report = await db.insert("reports", {
    reporter_id: u.id,
    trip_id: trip.id,
    reason: "Misleading trip information",
    note: "Please investigate this plan.",
  });
  const block = await db.insert("user_blocks", {
    blocker_id: a.id,
    blocked_id: u.id,
    context_trip_id: trip.id,
    reason: "A statement to review privately",
    category: "Other",
  });
  const br = await db.insert("block_reason_reports", {
    block_id: block.id,
    reporter_id: u.id,
    reason: "This statement needs moderation.",
  });
  assert.equal((await visitor.request("/admin/reports")).status, 401);
  assert.equal((await member.request("/admin/reports")).status, 403);
  const queue = await admin.request(
    "/admin/reports?kind=block&reportStatus=new",
  );
  assert.equal(queue.body.total, 1);
  assert.equal(queue.body.reports[0].status, "new");
  const decision = {
    status: "resolved",
    action: "hide",
    reason: "This report has been reviewed carefully.",
    revision: 0,
  };
  assert.equal(
    (await admin.request("/admin/reports/block/" + br.id, decision, "PUT"))
      .status,
    200,
  );
  assert.equal((await db.one("user_blocks", { id: block.id })).ended_at, null);
  assert.equal((await tripNotices(db, [trip.id])).length, 0);
  assert.equal(
    (await admin.request("/admin/reports/block/" + br.id, decision, "PUT"))
      .status,
    409,
  );
  assert.equal(
    (await admin.request("/admin/reports/trip/" + report.id, decision, "PUT"))
      .status,
    200,
  );
  assert.equal((await visitor.request("/trips")).body.total, 0);
  assert.equal((await visitor.request("/trips/" + trip.id)).status, 404);
  assert.equal((await member.request("/trips/" + trip.id)).status, 200);
  assert.equal((await member.request("/trips?view=my-trips")).body.total, 1);
  assert.equal((await visitor.request("/bootstrap")).body.trips.length, 0);
  assert.equal(
    (
      await admin.request(
        "/admin/reports/trip/" + report.id,
        { ...decision, action: "restore", revision: 1 },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal((await visitor.request("/trips")).body.total, 1);
  assert.equal(
    await db.count("admin_audit", { subject: { $in: [report.id, br.id] } }),
    3,
  );
});
test("feeds paginate and filter in MongoDB before hydrating members and reviews", async (t) => {
  const { db, client } = await fixture(t, "tripling_paginated_feed_test");
  const user = client(),
    owner = await user.signup("Owner"),
    guest = client();
  const records = [];
  for (let i = 0; i < 33; i++)
    records.push(
      await db.insert("trips", {
        ...tripData(owner.id, i),
        category: i % 2 ? "Adventure" : "Camping",
      }),
    );
  const boot = (await guest.request("/bootstrap")).body;
  assert.equal(boot.trips.length, 24);
  assert.equal(boot.feed.total, 33);
  const seen = [],
    first = (await guest.request("/trips?limit=7&sort=budget")).body;
  assert.equal(first.nextOffset, 7);
  seen.push(...first.trips.map((t) => t.id));
  for (let offset = first.nextOffset; offset !== null; ) {
    const page = (
      await guest.request("/trips?limit=7&sort=budget&offset=" + offset)
    ).body;
    seen.push(...page.trips.map((t) => t.id));
    offset = page.nextOffset;
  }
  assert.equal(new Set(seen).size, 33);
  assert.equal(seen.length, 33);
  const filtered = (
    await guest.request(
      "/trips?style=Adventure&budget=1010&origin=delhi&when=2099-01-02",
    )
  ).body;
  assert.equal(filtered.total, 5);
  assert.equal(filtered.trips.length, 5);
  assert.equal(
    (await guest.request("/trips?style=Adventure&category=Camping")).body.total,
    0,
  );
  assert.equal((await guest.request("/trips?view=my-trips")).status, 401);
  await db.insert("saved_trips", {
    user_id: owner.id,
    trip_id: records[32].id,
  });
  assert.equal(
    (await user.request("/trips?view=saved")).body.trips[0].id,
    records[32].id,
  );
  assert.equal(
    (await user.request("/trips?view=my-trips&limit=6")).body.total,
    33,
  );
  assert.equal((await guest.request("/trips?limit=101")).status, 400);
  assert.equal(
    (await guest.request("/trips?ids=" + records[32].id + "&view=all")).body
      .trips.length,
    1,
  );
  assert.equal(
    (await guest.request("/trips/" + records[32].id)).body.trip.id,
    records[32].id,
  );
  assert.equal((await guest.request("/trips/" + randomUUID())).status, 404);
  // Testimonial choices must find older eligible trips outside bootstrap's first page.
  for (let i = 0; i < 27; i++) {
    const past = await db.insert("trips", {
      ...tripData(owner.id, i),
      starts_on: "2020-01-01",
      ends_on: "2020-01-03",
    });
    await db.insert("trip_participants", {
      trip_id: past.id,
      user_id: owner.id,
      first_joined_at: new Date("2019-12-01"),
      left_at: i === 26 ? new Date("2019-12-15") : null,
    });
  }
  const reviewable = (await user.request("/trips?view=reviewable&limit=7"))
    .body;
  assert.equal(reviewable.total, 26);
  assert.equal(reviewable.trips.length, 7);
  assert.equal(reviewable.nextOffset, 7);
  assert(
    reviewable.trips.every(
      (t) => t.participated && t.lifecycle === "completed",
    ),
  );
});
test("automatic location maintenance refreshes early, coordinates replicas and retries unresolved cities later", async (t) => {
  const { db } = await fixture(t, "tripling_location_refresh_test");
  const owner = randomUUID(),
    now = new Date();
  const pending = await db.insert("trips", tripData(owner));
  const fresh = await db.insert("trips", tripData(owner, 1));
  const expiring = await db.insert("trips", tripData(owner, 2));
  await db.insert("trip_locations", {
    trip_id: fresh.id,
    expires_at: new Date(+now + 20 * 86400000),
  });
  await db.insert("trip_locations", {
    trip_id: expiring.id,
    expires_at: new Date(+now + 86400000),
  });
  await db.insert("trips", { ...tripData(owner, 3), status: "canceled" });
  let calls = 0,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  const resolver = async (name) => {
    calls++;
    await gate;
    return { latitude: 30, longitude: 77, label: name };
  };
  const work = refreshLocationBatch(db, { resolver, now });
  for (let i = 0; i < 100 && calls === 0; i++)
    await new Promise((r) => setTimeout(r, 5));
  const second = await refreshLocationBatch(db, { resolver, now });
  assert.equal(second.skipped, "already_running");
  release();
  const result = await work;
  assert.equal(result.processed, 2);
  assert.equal(calls, 4);
  assert.equal(
    (await refreshLocationBatch(db, { resolver, now })).processed,
    0,
  );
  await db.remove("trip_locations", { trip_id: pending.id });
  await db.update(
    "trips",
    { id: pending.id },
    { $unset: { location_refresh_after: "" } },
  );
  const failure = await refreshLocationBatch(db, {
    resolver: async () => {
      throw Error("unavailable");
    },
    now,
  });
  assert.equal(failure.unresolved, 1);
  await db.remove("trip_locations", { trip_id: pending.id });
  assert.equal(
    (await refreshLocationBatch(db, { resolver, now })).processed,
    0,
  );
  assert.equal(
    (
      await refreshLocationBatch(db, {
        resolver,
        now: new Date(+now + 7 * 3600000),
      })
    ).processed,
    1,
  );
});

test("location refresh discards results if the trip is edited during lookup", async (t) => {
  const { db } = await fixture(t, "tripling_location_edit_race_test");
  const trip = await db.insert("trips", tripData(randomUUID()));
  let changed = false;
  const result = await refreshLocationBatch(db, {
    resolver: async (name) => {
      if (!changed) {
        changed = true;
        await db.update(
          "trips",
          { id: trip.id },
          { $set: { from_city: "Mumbai" } },
        );
      }
      return { latitude: 30, longitude: 77, label: name };
    },
  });
  assert.equal(result.processed, 0);
  assert.equal(await db.one("trip_locations", { trip_id: trip.id }), null);
});

test("fresh partial location indexes retry missing fields without waiting for expiry", async (t) => {
  const { db } = await fixture(t, "tripling_location_partial_test");
  const trip = await db.insert("trips", tripData(randomUUID()));
  await db.insert("trip_locations", {
    trip_id: trip.id,
    expires_at: new Date(Date.now() + 29 * 86400000),
    origin: { type: "Point", coordinates: [77, 30] },
    unresolved_fields: ["destination"],
  });
  const result = await refreshLocationBatch(db, {
    resolver: async (name) => ({ latitude: 30, longitude: 77, label: name }),
  });
  assert.equal(result.processed, 1);
  assert.deepEqual(
    (await db.one("trip_locations", { trip_id: trip.id })).unresolved_fields,
    [],
  );
});
