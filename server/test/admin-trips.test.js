import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./launch-helpers.js";
import { MongoStore } from "../db.js";
import { tripCollections } from "../admin-trips.js";
async function setup(t, name) {
  const f = await fixture(t, name),
    admin = f.client(),
    owner = f.client(),
    member = f.client(),
    guest = f.client();
  const a = await admin.signup("Admin"),
    o = await owner.signup("Owner"),
    m = await member.signup("Member");
  const before = process.env.TRIPLING_ADMIN_USER_IDS;
  process.env.TRIPLING_ADMIN_USER_IDS = a.id;
  t.after(() => {
    if (before === undefined) delete process.env.TRIPLING_ADMIN_USER_IDS;
    else process.env.TRIPLING_ADMIN_USER_IDS = before;
  });
  const trip = await f.db.insert("trips", {
    owner_id: o.id,
    organizer_id: o.id,
    title: "A mountain journey",
    from_city: "Delhi",
    destination: "Manali",
    starts_on: "2099-01-01",
    ends_on: "2099-01-03",
    budget_min: 1000,
    budget_max: 4000,
    capacity: 6,
    existing_travelers: 1,
    category: "Adventure",
    mode: "Train",
    women_only: false,
    revision: 2,
  });
  return {
    ...f,
    admin,
    owner,
    member,
    guest,
    a,
    o,
    m,
    trip,
    body: {
      confirmationTripId: trip.id,
      reason: "Removed after an administrator review.",
      revision: 2,
    },
  };
}
test("only admins can delete; confirmation, edit revision, pagination and origin are enforced", async (t) => {
  const { admin, owner, guest, trip, body, db, base } = await setup(
    t,
    "tripling_admin_delete_access_test",
  );
  for (const client of [guest, owner]) {
    const expected = client === guest ? 401 : 403;
    for (const path of ["/admin/trips", "/admin/trips/" + trip.id])
      assert.equal((await client.request(path)).status, expected);
    assert.equal(
      (await client.request("/admin/trips/" + trip.id, body, "DELETE")).status,
      expected,
    );
  }
  assert.equal(
    (await owner.request("/trips/" + trip.id, body, "DELETE")).status,
    405,
  );
  const crossOrigin = await fetch(base + "/api/admin/trips/" + trip.id, {
    method: "DELETE",
    headers: {
      Cookie: admin.cookie,
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(crossOrigin.status, 403);

  assert.equal(
    (
      await admin.request(
        "/admin/trips/" + trip.id,
        { ...body, reason: "" },
        "DELETE",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.request(
        "/admin/trips/" + trip.id,
        { ...body, confirmationTripId: "11111111-1111-4111-8111-111111111111" },
        "DELETE",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await admin.request(
        "/admin/trips/" + trip.id,
        { ...body, revision: 1 },
        "DELETE",
      )
    ).status,
    409,
  );
  assert.equal(
    (await admin.request("/admin/trips/" + trip.id)).body.trip.revision,
    2,
  );
  for (let i = 0; i < 27; i++)
    await db.insert("trips", {
      title: "Other journey " + i,
      destination: "Goa",
    });
  const page = (await admin.request("/admin/trips")).body;
  assert.equal(page.trips.length, 25);
  assert.equal(page.total, 28);
  assert.equal(page.nextOffset, 25);
  assert.equal(
    (await admin.request("/admin/trips?tripOffset=25")).body.trips.length,
    3,
  );
  assert.equal(
    (await admin.request("/admin/trips?tripQuery=" + trip.id)).body.total,
    1,
  );
  assert.equal(
    (await admin.request("/admin/trips?tripQuery=mountain")).body.total,
    1,
  );
  await db.update(
    "trips",
    { id: trip.id },
    { $set: { moderation_hidden: true } },
  );
  assert.equal((await guest.request("/trips/" + trip.id)).status, 404);
  assert.equal((await admin.request("/trips/" + trip.id)).status, 200);
  assert(await db.one("trips", { id: trip.id }));
});
test("deletion atomically removes related content, preserves safety records and notifies members", async (t) => {
  const { db, admin, owner, member, guest, a, o, m, trip, body } = await setup(
    t,
    "tripling_admin_delete_cascade_test",
  );
  const other = await db.insert("trips", {
    ...trip,
    id: "11111111-1111-4111-8111-111111111111",
    _id: "11111111-1111-4111-8111-111111111111",
    title: "Unrelated trip",
  });
  for (const collection of tripCollections) {
    const fields = {
      trip_id: trip.id,
      user_id: m.id,
      author_id: m.id,
      traveler_id: o.id,
      organizer_id: o.id,
      status: "pending",
      rating: 5,
      body: "Trip content",
      consent: true,
      featured: true,
      message: "A shared memory",
      token_hash: "unused",
      expires_at: new Date(Date.now() + 86400000),
    };
    await db.insert(collection, fields);
    await db.insert(collection, { ...fields, trip_id: other.id });
  }
  await db.insert("trip_members", { trip_id: trip.id, user_id: o.id });
  const block = await db.insert("user_blocks", {
    blocker_id: o.id,
    blocked_id: m.id,
    context_trip_id: trip.id,
    reason: "A personal boundary that remains in effect",
    category: "Other",
  });
  await db.insert("reports", {
    trip_id: trip.id,
    reporter_id: m.id,
    reason: "A safety report",
  });
  await db.insert("block_reason_reports", {
    block_id: block.id,
    reporter_id: m.id,
    reason: "A statement report",
  });
  await db.insert("cancellation_audit", {
    trip_id: trip.id,
    user_id: m.id,
    actor_id: a.id,
    reason: "Earlier cancellation",
  });
  const deleted = await admin.request(
    "/admin/trips/" + trip.id,
    body,
    "DELETE",
  );
  assert.equal(deleted.status, 200);
  assert.equal(await db.one("trips", { id: trip.id }), null);
  for (const collection of tripCollections) {
    assert.equal(
      await db.count(collection, { trip_id: trip.id }),
      0,
      collection,
    );
    assert.equal(
      await db.count(collection, { trip_id: other.id }),
      1,
      collection,
    );
  }
  const audit = await db.one("admin_audit", {
    action: "trip_deleted",
    subject: trip.id,
  });
  assert.equal(audit.actor_id, a.id);
  assert.equal(audit.reason, body.reason);
  assert.equal(audit.deleted_counts.messages, 1);
  const preserved = await db.one("user_blocks", { id: block.id });
  assert.equal(preserved.ended_at, null);
  assert.equal(preserved.context_trip_id, null);
  assert.equal(preserved.notice_hidden, true);
  assert.equal(await db.count("reports", { trip_id: trip.id }), 1);
  assert.equal(
    await db.count("block_reason_reports", { block_id: block.id }),
    1,
  );
  assert.equal(await db.count("cancellation_audit", { trip_id: trip.id }), 1);
  assert(await db.one("users", { id: o.id }));
  assert(await db.one("users", { id: m.id }));
  const notices = await db.all("notifications", { type: "trip_deleted" });
  assert.equal(notices.length, 2);
  assert(
    notices.every((n) => n.trip_id === null && !n.body.includes(body.reason)),
  );
  assert.equal((await guest.request("/trips/" + trip.id)).status, 404);
  assert.equal(
    (await guest.request("/trips/" + trip.id + "/reviews")).status,
    404,
  );
  assert.equal(
    (await member.request("/trips/" + trip.id + "/messages")).status,
    403,
  );
  assert.equal(
    (await owner.request("/organizer/dashboard")).body.trips.some(
      (t) => t.id === trip.id,
    ),
    false,
  );
  assert.equal(
    (await member.request("/trips?view=my-trips")).body.trips.some(
      (t) => t.id === trip.id,
    ),
    false,
  );
  assert.equal(
    (
      await member.request(
        "/trips/" + trip.id + "/save",
        { saved: true },
        "PUT",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await member.request("/reports", {
        tripId: trip.id,
        reason: "A new report",
        note: "No orphan records",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await member.request("/testimonials", {
        tripId: trip.id,
        message: "A completed trip experience to submit.",
        consent: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await member.request("/blocks", {
        userId: o.id,
        tripId: trip.id,
        category: "Other",
        reason: "A reason for this personal boundary",
      })
    ).status,
    404,
  );
  assert.equal(
    (await admin.request("/admin/trips/" + trip.id, body, "DELETE")).status,
    404,
  );
  assert.equal(
    await db.count("admin_audit", { action: "trip_deleted", subject: trip.id }),
    1,
  );
});
test("a failed audit rolls the entire deletion back", async (t) => {
  const { db, admin, m, trip, body } = await setup(
    t,
    "tripling_admin_delete_rollback_test",
  );
  await db.insert("saved_trips", { trip_id: trip.id, user_id: m.id });
  const insert = MongoStore.prototype.insert;
  try {
    MongoStore.prototype.insert = async function (name, data) {
      if (name === "admin_audit" && data.action === "trip_deleted")
        throw Error("Simulated audit failure");
      return insert.call(this, name, data);
    };
    assert.equal(
      (await admin.request("/admin/trips/" + trip.id, body, "DELETE")).status,
      500,
    );
  } finally {
    MongoStore.prototype.insert = insert;
  }
  assert(await db.one("trips", { id: trip.id }));
  assert.equal(await db.count("saved_trips", { trip_id: trip.id }), 1);
  assert.equal(await db.count("notifications", { type: "trip_deleted" }), 0);
});
test("concurrent saves cannot recreate deleted trip records", async (t) => {
  const { db, admin, member, trip, body } = await setup(
    t,
    "tripling_admin_delete_race_test",
  );
  const results = await Promise.all([
    admin.request("/admin/trips/" + trip.id, body, "DELETE"),
    member.request("/trips/" + trip.id + "/save", { saved: true }, "PUT"),
  ]);
  assert.equal(results[0].status, 200);
  assert([200, 404].includes(results[1].status));
  assert.equal(await db.count("trips", { id: trip.id }), 0);
  assert.equal(await db.count("saved_trips", { trip_id: trip.id }), 0);
});
