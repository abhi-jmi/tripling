import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../db.js";
import { migrate, COLLECTIONS } from "../migrate.js";
import { publishLegalDocuments } from "../legal.js";
import { createApp } from "../app.js";
import { departureFromLocalTime } from "../trip-time.js";

test("trip wall-clock departure uses its zone and rejects DST gaps/folds", () => {
  assert.equal(
    departureFromLocalTime("2030-06-02", "09:45", "Asia/Kolkata").toISOString(),
    "2030-06-02T04:15:00.000Z",
  );
  assert.equal(
    departureFromLocalTime(
      "2030-06-02",
      "00:15",
      "Pacific/Kiritimati",
    ).toISOString(),
    "2030-06-01T10:15:00.000Z",
  );
  assert.throws(
    () => departureFromLocalTime("2026-03-08", "02:30", "America/New_York"),
    /daylight-saving/,
  );
  assert.throws(
    () => departureFromLocalTime("2026-11-01", "01:30", "America/New_York"),
    /daylight-saving/,
  );
  assert.throws(
    () => departureFromLocalTime("2030-06-02", "09:45", "Invalid/Zone"),
    /time zone/,
  );
});

test("complete trip editing preserves bookings, validates changes, refreshes geography and suppresses beta badges", async () => {
  const pool = await createDatabase({
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DATABASE: "tripling_edit_test",
    NODE_ENV: "test",
  });
  await migrate(pool);
  for (const name of COLLECTIONS)
    if (name !== "location_catalog") await pool.removeMany(name, {});
  await publishLegalDocuments(pool, {
    NODE_ENV: "test",
    LEGAL_OPERATOR_NAME: "Tripling Test",
    LEGAL_CONTACT_EMAIL: "test@example.test",
    LEGAL_JURISDICTION: "India",
  });
  let resolutions = 0,
    intercept = null;
  const servers = [];
  async function start(required) {
    const server = createApp(pool, {
      production: false,
      organizerVerificationRequired: required,
      placesAdapter: null,
      cityResolver: async (name, placeId) => {
        resolutions++;
        if (intercept) await intercept();
        if (["Bad origin", "Unknown destination"].includes(name))
          throw Error("UNRESOLVED");
        return {
          city: name,
          state: "Test State",
          label: name + ", India",
          placeId,
          latitude: name === "Goa" ? 15.49 : 30.73,
          longitude: name === "Goa" ? 73.82 : 76.77,
        };
      },
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const beta = await start(false),
    strict = await start(true);
  function client() {
    return {
      cookie: "",
      async request(path, body, method = body ? "POST" : "GET", origin = beta) {
        const r = await fetch(origin + "/api" + path, {
          method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        return { status: r.status, body: await r.json() };
      },
      async signup(name, gender) {
        const legal = (await this.request("/legal")).body.documents;
        const r = await this.request("/auth/signup", {
          email: name + "@example.test",
          firstName: name,
          lastName: "Traveler",
          password: "A secure edit test passphrase!",
          confirmPassword: "A secure edit test passphrase!",
          age: true,
          acceptedLegal: true,
          termsVersion: legal.terms.version,
          privacyVersion: legal.privacy.version,
        });
        assert.equal(r.status, 201);
        await this.request(
          "/profile",
          {
            firstName: name,
            lastName: "Traveler",
            city: "Delhi",
            gender,
            bio: "",
            age: true,
          },
          "PUT",
        );
        return r.body.user;
      },
    };
  }
  const owner = client(),
    member = client(),
    applicant = client(),
    guest = client();
  try {
    const a = await owner.signup("Owner", "woman"),
      b = await member.signup("Member", "woman"),
      pending = await applicant.signup("Applicant", "man");
    await pool.update(
      "users",
      { id: a.id },
      { $set: { organizer_verification: "approved" } },
    );
    const trip = {
      title: "Original mountain adventure",
      from: "Delhi",
      fromPlaceId: "delhi-id",
      destination: "Manali",
      destinationPlaceId: "manali-id",
      start: "2099-11-20",
      end: "2099-11-23",
      departureUtc: "2099-11-20T12:00:00Z",
      timeZone: "UTC",
      min: 100,
      max: 500,
      going: 1,
      seats: 3,
      category: "Adventure",
      mode: "Bus",
      description:
        "A shared trip with responsible plans and public meeting points.",
      plan: "",
      rules: "",
      groupEligibility: "mixed",
      age: true,
    };
    const created = await owner.request("/trips", trip);
    assert.equal(created.status, 201);
    const id = created.body.id,
      path = `/organizer/trips/${id}`;
    await member.request(`/trips/${id}/requests`, {
      note: "I would enjoy joining this responsible group trip.",
    });
    assert.equal(
      (
        await owner.request(
          `/trips/${id}/requests/${b.id}`,
          { status: "accepted" },
          "PUT",
        )
      ).status,
      200,
    );
    await applicant.request(`/trips/${id}/requests`, {
      note: "Please consider my pending request for this trip.",
    });
    assert.equal(
      (await guest.request("/bootstrap")).body.trips.find((t) => t.id === id)
        .verifiedOrganizer,
      false,
    );
    assert.equal(
      (await guest.request(`/organizers/${a.id}`)).body.verified,
      false,
    );
    assert.equal(
      (
        await guest.request("/bootstrap", undefined, "GET", strict)
      ).body.trips.find((t) => t.id === id).verifiedOrganizer,
      true,
    );
    assert.equal(
      (await guest.request(`/organizers/${a.id}`, undefined, "GET", strict))
        .body.verified,
      true,
    );
    const edit = {
      ...trip,
      title: "A redesigned coastal adventure",
      from: "Chandigarh",
      fromPlaceId: "chandigarh-id",
      destination: "Goa",
      destinationPlaceId: "goa-id",
      start: "2099-12-15",
      end: "2099-12-20",
      departureTime: "09:45",
      timeZone: "Asia/Kolkata",
      min: 6000,
      max: 9000,
      going: 3,
      seats: 2,
      category: "Camping",
      mode: "Train",
      groupEligibility: "women",
      women: true,
      plan: "A new flexible coastal itinerary.",
      rules: "Meet in public and respect every participant.",
      revision: 0,
    };
    delete edit.departureUtc;
    assert.equal((await guest.request(path, edit, "PATCH")).status, 401);
    assert.equal((await member.request(path, edit, "PATCH")).status, 403);
    const save = await owner.request(path, edit, "PATCH");
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const t = await pool.one("trips", { id });
    assert.equal(t.title, edit.title);
    assert.equal(t.from_city, edit.from);
    assert.equal(t.destination, edit.destination);
    assert.equal(t.starts_on, edit.start);
    assert.equal(t.ends_on, edit.end);
    assert.equal(t.departure_utc.toISOString(), "2099-12-15T04:15:00.000Z");
    assert.equal(t.budget_min, 6000);
    assert.equal(t.budget_max, 9000);
    assert.equal(t.capacity, 5);
    assert.equal(t.existing_travelers, 2);
    assert.equal(t.mode, "Train");
    assert.equal(t.category, "Camping");
    assert.equal(t.group_eligibility, "women");
    assert.equal(t.women_only, true);
    assert.equal(t.owner_id, a.id);
    assert.equal(t.organizer_id, a.id);
    assert.equal(t.revision, 1);
    assert.equal((await pool.all("trip_members", { trip_id: id })).length, 2);
    assert.equal(
      (await pool.one("join_requests", { trip_id: id, user_id: b.id })).status,
      "accepted",
    );
    assert.equal(
      (await pool.one("join_requests", { trip_id: id, user_id: pending.id }))
        .status,
      "pending",
    );
    assert.equal(
      (await pool.one("trip_participants", { trip_id: id, user_id: b.id }))
        .left_at,
      null,
    );
    assert(
      (await pool.all("notifications", { user_id: pending.id })).some((n) =>
        /organizer updated/.test(n.body),
      ),
    );
    const audit = await pool.one("admin_audit", {
      action: "trip_edited",
      subject: id,
    });
    assert.equal(audit.changes.from_city.before, "Delhi");
    assert.equal(audit.changes.from_city.after, "Chandigarh");
    const location = await pool.one("trip_locations", { trip_id: id });
    assert.deepEqual(location.destination.coordinates, [73.82, 15.49]);
    assert.equal(t.starting_location.placeId, "chandigarh-id");
    assert.equal((await owner.request(path, edit, "PATCH")).status, 409);
    assert.equal(
      (await owner.request(path, { going: 1, seats: 1 }, "PATCH")).status,
      409,
    );
    assert.equal(
      (await owner.request(path, { groupEligibility: "men" }, "PATCH")).status,
      409,
    );
    assert.equal(
      (await owner.request(path, { min: 1000, max: 10 }, "PATCH")).status,
      400,
    );
    assert.equal(
      (await owner.request(path, { end: "2099-01-01" }, "PATCH")).status,
      400,
    );
    assert.equal(
      (
        await owner.request(
          path,
          {
            start: "2020-01-01",
            departureUtc: "2020-01-01T12:00:00Z",
            timeZone: "UTC",
          },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await owner.request(
          path,
          { from: "Bad origin", fromPlaceId: "bad-id" },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal((await pool.one("trips", { id })).from_city, "Chandigarh");
    // A later profile change does not block an unrelated edit to an unchanged group.
    await member.request(
      "/profile",
      {
        firstName: "Member",
        lastName: "Traveler",
        city: "Delhi",
        gender: "man",
        bio: "",
        age: true,
      },
      "PUT",
    );
    assert.equal(
      (
        await owner.request(
          path,
          { title: "An unrelated notes update" },
          "PATCH",
        )
      ).status,
      200,
    );
    assert(await pool.one("trip_members", { trip_id: id, user_id: b.id }));
    await member.request(
      "/profile",
      {
        firstName: "Member",
        lastName: "Traveler",
        city: "Delhi",
        gender: "woman",
        bio: "",
        age: true,
      },
      "PUT",
    );
    const before = resolutions;
    assert.equal(
      (await owner.request(path, { going: 2, seats: 0 }, "PATCH")).status,
      200,
    );
    assert.equal(resolutions, before);
    const full = await pool.one("trips", { id });
    assert.equal(full.capacity, 2);
    assert.equal(full.existing_travelers, 1);
    assert.equal(
      (
        await owner.request(
          path,
          { destination: "Unknown destination" },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (await pool.one("trips", { id })).destination_place_id,
      undefined,
    );
    assert.equal(
      (await pool.one("trip_locations", { trip_id: id })).destination,
      undefined,
    );
    // A slow location lookup cannot overwrite a later committed edit.
    let release, seen;
    const gate = new Promise((r) => {
        release = r;
      }),
      started = new Promise((r) => {
        seen = r;
      });
    intercept = async () => {
      seen();
      await gate;
    };
    const slow = owner.request(
      path,
      { from: "Mumbai", fromPlaceId: "mumbai-id" },
      "PATCH",
    );
    await started;
    assert.equal(
      (await owner.request(path, { title: "A later committed title" }, "PATCH"))
        .status,
      200,
    );
    release();
    const conflict = await slow;
    intercept = null;
    assert.equal(conflict.status, 409);
    assert.equal(
      (await pool.one("trips", { id })).title,
      "A later committed title",
    );
    assert.equal((await pool.one("trips", { id })).from_city, "Chandigarh");
    // A participant accepted during lookup also invalidates the stale editor.
    assert.equal(
      (await owner.request(path, { seats: 2 }, "PATCH")).status,
      200,
    );
    const late = client(),
      lateUser = await late.signup("Late", "woman");
    assert.equal(
      (
        await late.request(`/trips/${id}/requests`, {
          note: "I would like to join the updated group trip.",
        })
      ).status,
      201,
    );
    let releaseMember, seenMember;
    const memberGate = new Promise((r) => {
        releaseMember = r;
      }),
      memberStarted = new Promise((r) => {
        seenMember = r;
      });
    intercept = async () => {
      seenMember();
      await memberGate;
    };
    const staleCrew = owner.request(
      path,
      { from: "Mumbai", fromPlaceId: "mumbai-id" },
      "PATCH",
    );
    await memberStarted;
    assert.equal(
      (
        await owner.request(
          `/trips/${id}/requests/${lateUser.id}`,
          { status: "accepted" },
          "PUT",
        )
      ).status,
      200,
    );
    releaseMember();
    assert.equal((await staleCrew).status, 409);
    intercept = null;
    assert.equal((await pool.all("trip_members", { trip_id: id })).length, 3);
    assert.equal((await pool.one("trips", { id })).from_city, "Chandigarh");
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await pool.close();
  }
});
