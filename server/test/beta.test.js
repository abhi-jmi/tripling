import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../db.js";
import { migrate, COLLECTIONS } from "../migrate.js";
import { publishLegalDocuments } from "../legal.js";
import { createApp } from "../app.js";
import { organizerVerificationEnabled } from "../roles.js";

test("organizer approval configuration is explicit and rejects mistyped values", () => {
  assert.equal(organizerVerificationEnabled("false"), false);
  assert.equal(organizerVerificationEnabled("true"), true);
  for (const value of ["", "yes", "TRUE", "0"])
    assert.throws(
      () => organizerVerificationEnabled(value),
      /must be true or false/,
    );
});

test("beta organizing bypasses approval only; enforced mode and private roles remain intact", async () => {
  const pool = await createDatabase({
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DATABASE: "tripling_beta_test",
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
  const servers = [];
  async function start(required) {
    const app = createApp(pool, {
      production: false,
      organizerVerificationRequired: required,
      placesAdapter: null,
      cityResolver: async (name, placeId) => ({
        latitude: 32.2432,
        longitude: 77.1892,
        label: name,
        city: name,
        state: "Himachal Pradesh",
        placeId,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const beta = await start(false),
    strict = await start(true);
  function client() {
    return {
      cookie: "",
      async request(base, path, body, method = body ? "POST" : "GET") {
        const r = await fetch(base + "/api" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: base,
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (r.headers.get("set-cookie"))
          this.cookie = r.headers.get("set-cookie").split(";")[0];
        return { status: r.status, body: await r.json() };
      },
      async signup(name) {
        const docs = (await this.request(beta, "/legal")).body.documents;
        const r = await this.request(beta, "/auth/signup", {
          email: name + "@example.test",
          firstName: name,
          lastName: "Traveler",
          password: "A secure beta test passphrase!",
          confirmPassword: "A secure beta test passphrase!",
          age: true,
          acceptedLegal: true,
          termsVersion: docs.terms.version,
          privacyVersion: docs.privacy.version,
        });
        assert.equal(r.status, 201);
        return r.body.user;
      },
    };
  }
  const owner = client(),
    member = client(),
    guest = client();
  const trip = {
    title: "Beta mountain adventure",
    fromPlaceId: "test-city-id",
    from: "Delhi",
    destination: "Manali",
    start: "2099-11-20",
    end: "2099-11-23",
    departureUtc: "2099-11-20T12:00:00Z",
    timeZone: "UTC",
    min: 100,
    max: 500,
    going: 1,
    seats: 2,
    category: "Adventure",
    mode: "Bus",
    description: "A responsible shared travel plan with public meeting points.",
    women: false,
    age: true,
  };
  try {
    const user = await owner.signup("Beta"),
      traveler = await member.signup("Member");
    assert.equal((await guest.request(beta, "/trips", trip)).status, 401);
    assert.equal(
      (await owner.request(beta, "/bootstrap")).body.features
        .organizerVerificationRequired,
      false,
    );
    assert.equal(
      (await owner.request(strict, "/bootstrap")).body.features
        .organizerVerificationRequired,
      true,
    );
    assert.equal(
      (
        await owner.request(beta, "/organizer/verification", {
          name: "Reference",
        })
      ).status,
      409,
    );
    assert.equal(
      (await owner.request(beta, "/admin/verifications")).status,
      403,
    );
    let id;
    for (const status of ["not_submitted", "pending", "rejected"]) {
      await pool.update(
        "users",
        { id: user.id },
        { $set: { organizer_verification: status } },
      );
      assert.equal((await owner.request(strict, "/trips", trip)).status, 403);
      const created = await owner.request(beta, "/trips", trip);
      assert.equal(created.status, 201);
      id = created.body.id;
      assert.equal(
        (await pool.one("users", { id: user.id })).organizer_verification,
        status,
      );
      const publicTrip = (
        await guest.request(beta, "/bootstrap")
      ).body.trips.find((t) => t.id === id);
      assert.equal(publicTrip.verifiedOrganizer, false);
    }
    assert.equal(
      (
        await member.request(beta, `/trips/${id}/requests`, {
          note: "Happy to join this responsible group adventure.",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await owner.request(
          strict,
          `/trips/${id}/requests/${traveler.id}`,
          { status: "accepted" },
          "PUT",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.request(
          beta,
          `/trips/${id}/requests/${traveler.id}`,
          { status: "accepted" },
          "PUT",
        )
      ).status,
      200,
    );
    const edit = {
      title: "Edited beta adventure",
      description: trip.description,
      plan: "",
      rules: "",
      category: "Camping",
      departureUtc: trip.departureUtc,
      timeZone: "UTC",
    };
    assert.equal(
      (await member.request(beta, `/organizer/trips/${id}`, edit, "PATCH"))
        .status,
      403,
    );
    assert.equal(
      (await owner.request(strict, `/organizer/trips/${id}`, edit, "PATCH"))
        .status,
      403,
    );
    assert.equal(
      (await owner.request(beta, `/organizer/trips/${id}`, edit, "PATCH"))
        .status,
      200,
    );
    assert.equal(
      (
        await owner.request(
          beta,
          `/organizer/trips/${id}/members/${traveler.id}`,
          { reason: "Requested by the traveler before departure." },
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await owner.request(beta, `/organizer/trips/${id}/cancel`, {
          reason: "Organizer cannot run this beta test trip.",
        })
      ).status,
      200,
    );
    assert.equal(
      (await owner.request(beta, `/trips/${id}`, {}, "DELETE")).status,
      405,
    );
    await pool.update(
      "users",
      { id: user.id },
      { $set: { adult_confirmed: false } },
    );
    assert.equal((await owner.request(beta, "/trips", trip)).status, 403);
    await pool.update(
      "users",
      { id: user.id },
      { $set: { adult_confirmed: true, first_name: "" } },
    );
    assert.equal((await owner.request(beta, "/trips", trip)).status, 409);
    await pool.update(
      "users",
      { id: user.id },
      { $set: { first_name: "Beta", organizer_verification: "approved" } },
    );
    assert.equal((await owner.request(strict, "/trips", trip)).status, 201);
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((r) => server.close(r))),
    );
    await pool.close();
  }
});
