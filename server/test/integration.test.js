import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, validateMongoConfiguration } from "../db.js";
import { migrate, COLLECTIONS } from "../migrate.js";
import { createApp } from "../app.js";
import { publishLegalDocuments, legalConfiguration } from "../legal.js";
import { cookieOptions } from "../auth.js";

const connectionString = process.env.TEST_MONGODB_URI;
const databaseName = process.env.TEST_MONGODB_DATABASE || "tripling_test";
if (!connectionString || !databaseName.endsWith("_test"))
  throw new Error(
    "Set TEST_MONGODB_URI and a dedicated TEST_MONGODB_DATABASE ending in _test.",
  );
const pool = await createDatabase({
  MONGODB_URI: connectionString,
  MONGODB_DATABASE: databaseName,
  NODE_ENV: "test",
});
await migrate(pool);
for (const name of COLLECTIONS)
  if (name !== "location_catalog") await pool.removeMany(name, {});
async function records(name, filter) {
  const rows = await pool.all(name, filter);
  return { rows, rowCount: rows.length };
}
await publishLegalDocuments(pool, {
  NODE_ENV: "test",
  LEGAL_OPERATOR_NAME: " ",
});
let googleClaims = {
  sub: "google-new-user",
  email: "google@example.com",
  email_verified: true,
  given_name: "Google",
  family_name: "Traveler",
};
const googleAdapter = {
  authorize: async (args) =>
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      state: args.state,
      redirect_uri: args.redirectUri,
      nonce: args.nonce,
      code_challenge: args.verifier,
    }),
  exchange: async () => googleClaims,
};
const app = createApp(pool, { production: false, googleAdapter });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
class Client {
  cookie = "";
  ip = null;
  async request(path, { method = "GET", body, origin = base } = {}) {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.ip ? {"X-Forwarded-For":this.ip} : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get("set-cookie"))
      this.cookie = response.headers.get("set-cookie").split(";")[0];
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  }
  async signup(email) {
    const docs = (await this.request("/legal")).body.documents;
    const r = await this.request("/auth/signup", {
      method: "POST",
      body: {
        email,
        firstName: "Test",
        lastName: "Traveler",
        password: "A long test passphrase!",
        confirmPassword: "A long test passphrase!",
        age: true,
        acceptedLegal: true,
        termsVersion: docs.terms.version,
        privacyVersion: docs.privacy.version,
      },
    });
    assert.equal(r.status, 201);
    return r.body.user;
  }
  async profile(name, gender = "other") {
    const r = await this.request("/profile", {
      method: "PUT",
      body: {
        firstName: name,
        lastName: "Traveler",
        city: "Delhi",
        gender,
        bio: "Easygoing traveler",
        age: true,
      },
    });
    assert.equal(r.status, 200);
    return r.body.user;
  }
}
const anonymous = new Client(),
  owner = new Client(),
  alice = new Client(),
  bob = new Client(),
  outsider = new Client();
let ownerUser,
  aliceUser,
  bobUser,
  outsiderUser,
  tripId,
  womenTripId,
  accepted,
  acceptedUser,
  rejected,
  rejectedUser;
const trip = {
  title: "A mountain weekend",
  from: "Delhi",
  destination: "Manali",
  start: "2099-11-20",
  end: "2099-11-23",
  min: 5000,
  max: 8000,
  going: 1,
  seats: 1,
  category: "Mountains",
  mode: "Bus",
  women: false,
  description: "A relaxed mountain weekend with a small group of travelers.",
  plan: "Explore local paths and meet in a public café.",
  rules: "Respect personal boundaries.",
  age: true,
};
try {
  await test("database-backed Tripling workflows", async (t) => {
    await t.test(
      "policy pages are public, database-backed and identify local drafts",
      async () => {
        const legal = await anonymous.request("/legal");
        assert(legal.body.documents.terms.version);
        assert(legal.body.documents.privacy.version);
        for (const path of ["/terms", "/privacy"]) {
          const response = await fetch(base + path);
          assert.equal(response.status, 200);
          const html = await response.text();
          assert(html.includes("Draft policy"));
          assert(html.includes("Version"));
        }
        assert.throws(
          () =>
            legalConfiguration({
              NODE_ENV: "production",
              LEGAL_OPERATOR_NAME: " ",
            }),
          /LEGAL_OPERATOR_NAME/,
        );
      },
    );
    await t.test(
      "signup cannot bypass policy acceptance or use stale versions",
      async () => {
        const docs = (await anonymous.request("/legal")).body.documents;
        const body = {
          email: "legal-test@example.com",
          firstName: "Legal",
          lastName: "Tester",
          password: "A long test passphrase!",
          confirmPassword: "A long test passphrase!",
          age: true,
          acceptedLegal: false,
          termsVersion: docs.terms.version,
          privacyVersion: docs.privacy.version,
        };
        assert.equal(
          (await anonymous.request("/auth/signup", { method: "POST", body }))
            .status,
          400,
        );
        assert.equal(
          (
            await anonymous.request("/auth/signup", {
              method: "POST",
              body: { ...body, acceptedLegal: true, termsVersion: "outdated" },
            })
          ).status,
          409,
        );
        assert.equal(
          (await records("users", { email: "legal-test@example.com" }))
            .rowCount,
          0,
        );
      },
    );
    await t.test(
      "signup validates password confirmation and adult policy",
      async () => {
        const docs = (await anonymous.request("/legal")).body.documents;
        const required = {
          firstName: "Test",
          lastName: "Traveler",
          acceptedLegal: true,
          termsVersion: docs.terms.version,
          privacyVersion: docs.privacy.version,
        };
        let r = await anonymous.request("/auth/signup", {
          method: "POST",
          body: {
            ...required,
            email: "bad@example.com",
            password: "long-enough-password",
            confirmPassword: "different",
            age: true,
          },
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Passwords do not match/);
        r = await anonymous.request("/auth/signup", {
          method: "POST",
          body: {
            ...required,
            email: "bad@example.com",
            password: "long-enough-password",
            confirmPassword: "long-enough-password",
            age: false,
          },
        });
        assert.equal(r.status, 400);
      },
    );
    await t.test(
      "signup creates real accounts and a protected cookie",
      async () => {
        ownerUser = await owner.signup("OWNER@example.com");
        aliceUser = await alice.signup("alice@example.com");
        bobUser = await bob.signup("bob@example.com");
        outsiderUser = await outsider.signup("outsider@example.com");
        assert.equal(ownerUser.email, "owner@example.com");
        assert.equal(
          (await records("legal_acceptances", { user_id: ownerUser.id }))
            .rowCount,
          2,
        );
        const session = await owner.request("/auth/session");
        assert.equal(session.body.user.id, ownerUser.id);
        const hash = await records("users", { id: ownerUser.id });
        assert.match(hash.rows[0].password_hash, /^scrypt-v1\$/);
        assert.notEqual(hash.rows[0].password_hash, "A long test passphrase!");
        const tokens = await records("sessions", { user_id: ownerUser.id });
        assert.notEqual(tokens.rows[0].token_hash, owner.cookie.split("=")[1]);
        assert.equal(cookieOptions(true).secure, true);
        assert.equal(cookieOptions(true).httpOnly, true);
      },
    );
    await t.test(
      "login rejects a wrong password and rotates the server session",
      async () => {
        const client = new Client();
        let r = await client.request("/auth/login", {
          method: "POST",
          body: { email: "owner@example.com", password: "wrong-password" },
        });
        assert.equal(r.status, 401);
        r = await owner.request("/auth/login", {
          method: "POST",
          body: {
            email: "owner@example.com",
            password: "A long test passphrase!",
          },
        });
        assert.equal(r.status, 200);
        assert.match(r.headers.get("set-cookie"), /HttpOnly/);
        assert.match(r.headers.get("set-cookie"), /SameSite=Lax/);
        const rows = await records("sessions", { user_id: ownerUser.id });
        assert.equal(rows.rowCount, 1);
      },
    );
    await t.test(
      "unsafe requests require the same origin and JSON",
      async () => {
        const r = await owner.request("/profile", {
          method: "PUT",
          origin: "https://untrusted.example",
          body: {},
        });
        assert.equal(r.status, 403);
        const missing = await owner.request("/auth/logout", {
          method: "POST",
          origin: null,
          body: {},
        });
        assert.equal(missing.status, 403);
      },
    );
    await t.test("profiles are stored in MongoDB", async () => {
      await owner.profile("Organizer", "woman");
      await alice.profile("Alice", "woman");
      await bob.profile("Bob", "other");
      await outsider.profile("Outsider", "other");
      const rows = await records("users", { id: ownerUser.id });
      assert.equal(rows.rows[0].display_name, "Organizer Traveler");
    });
    await t.test("anonymous users cannot mutate records", async () => {
      const r = await anonymous.request("/trips", {
        method: "POST",
        body: trip,
      });
      assert.equal(r.status, 401);
    });
    await t.test("creating a trip inserts organizer membership", async () => {
      const r = await owner.request("/trips", { method: "POST", body: trip });
      assert.equal(r.status, 201);
      tripId = r.body.id;
      const members = await records("trip_members", { trip_id: tripId });
      assert.equal(members.rowCount, 1);
      const publicFeed = await anonymous.request("/bootstrap");
      assert.equal(publicFeed.body.trips.length, 1);
      assert.equal(publicFeed.body.trips[0].start, trip.start);
      assert.equal(publicFeed.body.trips[0].seats, 1);
      assert(!JSON.stringify(publicFeed.body).includes("owner@example.com"));
    });
    await t.test("trip validation is enforced on the server", async () => {
      const r = await owner.request("/trips", {
        method: "POST",
        body: { ...trip, max: 1 },
      });
      assert.equal(r.status, 400);
      const old = await owner.request("/trips", {
        method: "POST",
        body: { ...trip, start: "2020-01-01", end: "2020-01-02" },
      });
      assert.equal(old.status, 400);
    });
    await t.test("saved trips are idempotent and private", async () => {
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await alice.request(`/trips/${tripId}/save`, {
              method: "PUT",
              body: { saved: true },
            })
          ).status,
          200,
        );
      const mine = await alice.request("/bootstrap"),
        theirs = await bob.request("/bootstrap");
      assert.deepEqual(mine.body.saved, [tripId]);
      assert.deepEqual(theirs.body.saved, []);
    });
    await t.test(
      "pending travelers cannot read or write group chat",
      async () => {
        for (const c of [alice, bob])
          assert.equal(
            (
              await c.request(`/trips/${tripId}/requests`, {
                method: "POST",
                body: { note: "I would love to join this mountain trip." },
              })
            ).status,
            201,
          );
        assert.equal(
          (await alice.request(`/trips/${tripId}/messages`)).status,
          403,
        );
        assert.equal(
          (
            await alice.request(`/trips/${tripId}/messages`, {
              method: "POST",
              body: { body: "Not accepted yet" },
            })
          ).status,
          403,
        );
      },
    );
    await t.test("only the organizer can approve a request", async () => {
      const r = await outsider.request(
        `/trips/${tripId}/requests/${aliceUser.id}`,
        { method: "PUT", body: { status: "accepted" } },
      );
      assert.equal(r.status, 403);
    });
    await t.test(
      "concurrent approvals cannot overbook the last spot",
      async () => {
        const results = await Promise.all(
          [aliceUser, bobUser].map((u) =>
            owner.request(`/trips/${tripId}/requests/${u.id}`, {
              method: "PUT",
              body: { status: "accepted" },
            }),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const aliceAccepted = results[0].status === 200;
        accepted = aliceAccepted ? alice : bob;
        acceptedUser = aliceAccepted ? aliceUser : bobUser;
        rejected = aliceAccepted ? bob : alice;
        rejectedUser = aliceAccepted ? bobUser : aliceUser;
        const members = await records("trip_members", { trip_id: tripId });
        assert.equal(members.rowCount, 2);
        const feed = await owner.request("/bootstrap");
        assert.equal(feed.body.trips.find((t) => t.id === tripId).seats, 0);
      },
    );
    await t.test(
      "approved chat messages are shared and outsiders stay excluded",
      async () => {
        const r = await accepted.request(`/trips/${tripId}/messages`, {
          method: "POST",
          body: { body: "Let’s meet at the public bus station." },
        });
        assert.equal(r.status, 201);
        const messages = await owner.request(`/trips/${tripId}/messages`);
        assert.equal(
          messages.body.messages[0].body,
          "Let’s meet at the public bus station.",
        );
        assert.equal(
          (await outsider.request(`/trips/${tripId}/members`)).status,
          403,
        );
      },
    );
    await t.test(
      "rejection, acceptance notifications, and read status persist",
      async () => {
        assert.equal(
          (
            await owner.request(
              `/trips/${tripId}/requests/${rejectedUser.id}`,
              { method: "PUT", body: { status: "rejected" } },
            )
          ).status,
          200,
        );
        const feed = await accepted.request("/bootstrap");
        assert(
          feed.body.notifications.some((n) => n.body.includes("accepted")),
        );
        await accepted.request("/notifications/read", {
          method: "POST",
          body: {},
        });
        const read = await accepted.request("/bootstrap");
        assert(read.body.notifications.every((n) => n.read_at));
      },
    );
    await t.test(
      "hiding a joined trip preserves the ability to leave it",
      async () => {
        assert.equal(
          (
            await accepted.request("/reports", {
              method: "POST",
              body: {
                tripId,
                reason: "I do not want to see this trip",
                note: "",
              },
            })
          ).status,
          201,
        );
        const feed = await accepted.request("/bootstrap");
        assert(feed.body.hidden.includes(tripId));
        assert(feed.body.trips.some((trip) => trip.id === tripId));
      },
    );
    await t.test(
      "leaving a group revokes chat access and restores capacity",
      async () => {
        assert.equal(
          (
            await accepted.request(`/trips/${tripId}/requests`, {
              method: "DELETE",
              body: {},
            })
          ).status,
          200,
        );
        assert.equal(
          (await accepted.request(`/trips/${tripId}/messages`)).status,
          403,
        );
        const feed = await owner.request("/bootstrap");
        assert.equal(feed.body.trips.find((t) => t.id === tripId).seats, 1);
      },
    );
    await t.test(
      "women-only membership is checked on server at request and approval",
      async () => {
        const r = await owner.request("/trips", {
          method: "POST",
          body: { ...trip, title: "Women-only mountain trip", women: true },
        });
        womenTripId = r.body.id;
        assert.equal(r.status, 201);
        assert.equal(
          (
            await bob.request(`/trips/${womenTripId}/requests`, {
              method: "POST",
              body: { note: "A valid introduction for this trip." },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await alice.request(`/trips/${womenTripId}/requests`, {
              method: "POST",
              body: { note: "A valid introduction for this trip." },
            })
          ).status,
          201,
        );
        await alice.profile("Alice", "other");
        assert.equal(
          (
            await owner.request(
              `/trips/${womenTripId}/requests/${aliceUser.id}`,
              { method: "PUT", body: { status: "accepted" } },
            )
          ).status,
          403,
        );
        await alice.profile("Alice", "woman");
        assert.equal(
          (
            await owner.request(
              `/trips/${womenTripId}/requests/${aliceUser.id}`,
              { method: "PUT", body: { status: "accepted" } },
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "reviews require completed trips and real shared membership",
      async () => {
        const early = await alice.request(`/trips/${womenTripId}/reviews`, {
          method: "POST",
          body: {
            travelerId: ownerUser.id,
            rating: 5,
            body: "Reliable and respectful travel companion.",
          },
        });
        assert.equal(early.status, 400);
        await pool.update(
          "trips",
          { id: womenTripId },
          { $set: { starts_on: "2020-01-01", ends_on: "2020-01-03" } },
        );
        await pool.updateMany(
          "trip_participants",
          { trip_id: womenTripId },
          {
            $set: {
              first_joined_at: new Date("2019-12-31"),
              last_joined_at: new Date("2019-12-31"),
            },
          },
        );
        const r = await alice.request(`/trips/${womenTripId}/reviews`, {
          method: "POST",
          body: {
            travelerId: ownerUser.id,
            rating: 5,
            body: "Reliable and respectful travel companion.",
          },
        });
        assert.equal(r.status, 201);
        const outside = await outsider.request(
          `/trips/${womenTripId}/reviews`,
          {
            method: "POST",
            body: {
              travelerId: ownerUser.id,
              rating: 1,
              body: "I did not travel on this trip.",
            },
          },
        );
        assert.equal(outside.status, 403);
        assert.equal(
          (await anonymous.request(`/trips/${womenTripId}/reviews`)).body
            .reviews.length,
          1,
        );
      },
    );
    await t.test("reports and hidden trips are stored per user", async () => {
      const r = await outsider.request("/reports", {
        method: "POST",
        body: {
          tripId,
          reason: "Safety concern",
          note: "Please review the trip description.",
        },
      });
      assert.equal(r.status, 201);
      const feed = await outsider.request("/bootstrap");
      assert(!feed.body.trips.some((t) => t.id === tripId));
      assert.equal(
        (await records("reports", { reporter_id: outsiderUser.id })).rowCount,
        1,
      );
      assert(
        (await owner.request("/bootstrap")).body.trips.some(
          (t) => t.id === tripId,
        ),
      );
    });
    await t.test(
      "trip records cannot be canceled or deleted, even by creator",
      async () => {
        for (const client of [owner, bob])
          for (const [path, method] of [
            [`/trips/${tripId}/cancel`, "POST"],
            [`/trips/${tripId}`, "DELETE"],
          ])
            assert.equal(
              (await client.request(path, { method, body: {} })).status,
              405,
            );
      },
    );
    await t.test(
      "prefix locations are alphabetical and names are mandatory",
      async () => {
        const locations = (await anonymous.request("/locations?q=m")).body
          .locations;
        assert(locations.length > 3);
        assert(locations.every((n) => n.toLowerCase().startsWith("m")));
        assert.deepEqual(
          locations,
          [...locations].sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase()),
          ),
        );
        assert.equal(
          (
            await owner.request("/profile", {
              method: "PUT",
              body: {
                firstName: "Organizer",
                lastName: " ",
                city: "Delhi",
                gender: "other",
                bio: "",
                age: true,
              },
            })
          ).status,
          400,
        );
        const docs = (await anonymous.request("/legal")).body.documents;
        for (const names of [
          { firstName: " ", lastName: "Traveler" },
          { firstName: "Test", lastName: "" },
        ]) {
          const invalid = await anonymous.request("/auth/signup", {
            method: "POST",
            body: {
              ...names,
              email: "no-name@example.com",
              password: "A long test passphrase!",
              confirmPassword: "A long test passphrase!",
              age: true,
              acceptedLegal: true,
              termsVersion: docs.terms.version,
              privacyVersion: docs.privacy.version,
            },
          });
          assert.equal(invalid.status, 400);
          assert.match(invalid.body.error, /name.*required/i);
        }
        await pool.update(
          "users",
          { id: outsiderUser.id },
          { $set: { first_name: null, last_name: null } },
        );
        assert.equal(
          (await outsider.request("/trips", { method: "POST", body: trip }))
            .status,
          409,
        );
        await outsider.profile("Outsider");
      },
    );
    await t.test(
      "blocks require reasons, preserve members and keep notices inside the trip",
      async () => {
        const d = {
          userId: aliceUser.id,
          tripId: womenTripId,
          category: "Safety concern",
          reason: "Repeatedly ignored the agreed meeting boundaries.",
        };
        assert.equal(
          (
            await owner.request("/blocks", {
              method: "POST",
              body: { ...d, reason: "short" },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await owner.request("/blocks", {
              method: "POST",
              body: { ...d, userId: ownerUser.id },
            })
          ).status,
          400,
        );
        assert.equal(
          (await outsider.request("/blocks", { method: "POST", body: d }))
            .status,
          403,
        );
        const block = await owner.request("/blocks", {
          method: "POST",
          body: d,
        });
        assert.equal(block.status, 201);
        const inside = await alice.request(`/trips/${womenTripId}/members`);
        assert.equal(inside.body.blocks[0].reason, d.reason);
        assert(
          inside.body.members.some((m) => m.id === aliceUser.id && m.active),
        );
        assert.equal(
          (await outsider.request(`/trips/${womenTripId}/members`)).status,
          403,
        );
        assert.equal(
          (await anonymous.request(`/trips/${womenTripId}/members`)).status,
          401,
        );
        assert(
          !JSON.stringify((await outsider.request("/bootstrap")).body).includes(
            d.reason,
          ),
        );
        assert.equal(
          (await outsider.request(`/travelers/${aliceUser.id}`)).body.notices
            .length,
          0,
        );
        assert.equal(
          (
            await outsider.request(`/blocks/${block.body.id}`, {
              method: "DELETE",
              body: {},
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await alice.request(`/blocks/${block.body.id}/report`, {
              method: "POST",
              body: { reason: "This statement omits important context." },
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await outsider.request(`/blocks/${block.body.id}/report`, {
              method: "POST",
              body: { reason: "I am not in this trip at all." },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await owner.request(`/blocks/${block.body.id}`, {
              method: "DELETE",
              body: {},
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "blocking hides messages both ways and prevents join approval",
      async () => {
        const fresh = (
          await owner.request("/trips", {
            method: "POST",
            body: { ...trip, seats: 3 },
          })
        ).body.id;
        assert.equal(
          (
            await bob.request(`/trips/${fresh}/requests`, {
              method: "POST",
              body: { note: "Happy to travel with this small crew." },
            })
          ).status,
          201,
        );
        let block = await owner.request("/blocks", {
          method: "POST",
          body: {
            userId: bobUser.id,
            category: "Other",
            reason: "We prefer to avoid traveling in the same group.",
          },
        });
        assert.equal(block.status, 201);
        assert.equal(
          (
            await owner.request(`/trips/${fresh}/requests/${bobUser.id}`, {
              method: "PUT",
              body: { status: "accepted" },
            })
          ).status,
          403,
        );
        await owner.request(`/blocks/${block.body.id}`, {
          method: "DELETE",
          body: {},
        });
        await owner.request(`/trips/${fresh}/requests/${bobUser.id}`, {
          method: "PUT",
          body: { status: "accepted" },
        });
        await bob.request(`/trips/${fresh}/messages`, {
          method: "POST",
          body: { body: "Private crew planning message" },
        });
        block = await owner.request("/blocks", {
          method: "POST",
          body: {
            userId: bobUser.id,
            tripId: fresh,
            category: "Other",
            reason: "We prefer to avoid traveling in the same group.",
          },
        });
        assert.equal(
          (await owner.request(`/trips/${fresh}/messages`)).body.messages
            .length,
          0,
        );
        await owner.request(`/trips/${fresh}/messages`, {
          method: "POST",
          body: { body: "Another crew planning message" },
        });
        assert.equal(
          (await bob.request(`/trips/${fresh}/messages`)).body.messages.length,
          1,
        );
        const leave = await owner.request(`/trips/${fresh}/requests`, {
          method: "DELETE",
          body: {},
        });
        assert.equal(leave.body.organizerId, bobUser.id);
        assert.equal(
          (await owner.request(`/trips/${fresh}/messages`)).status,
          403,
        );
        assert.equal(
          (
            await owner.request(`/trips/${fresh}/requests`, {
              method: "POST",
              body: { note: "I am trying to join this group again." },
            })
          ).status,
          403,
        );
        await bob.request(`/trips/${fresh}/requests`, {
          method: "DELETE",
          body: {},
        });
        const record = (await anonymous.request("/bootstrap")).body.trips.find(
          (t) => t.id === fresh,
        );
        assert(record);
        assert.equal(record.organizerId, null);
        assert.equal(
          (
            await outsider.request(`/trips/${fresh}/requests`, {
              method: "POST",
              body: { note: "There is nobody organizing this trip." },
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "past trips retain reviews after leaving and reject joining and messages",
      async () => {
        assert.equal(
          (
            await owner.request(`/trips/${womenTripId}/messages`, {
              method: "POST",
              body: { body: "Too late to send" },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await outsider.request(`/trips/${womenTripId}/requests`, {
              method: "POST",
              body: { note: "Trying to join a completed journey." },
            })
          ).status,
          400,
        );
        await alice.request(`/trips/${womenTripId}/requests`, {
          method: "DELETE",
          body: {},
        });
        assert.equal(
          (await alice.request(`/trips/${womenTripId}/members`)).status,
          200,
        );
        assert.equal(
          (await anonymous.request(`/trips/${womenTripId}/reviews`)).body
            .reviews.length,
          1,
        );
        const archive = (await anonymous.request("/bootstrap")).body.trips.find(
          (t) => t.id === womenTripId,
        );
        assert.equal(archive.lifecycle, "completed");
        assert.equal(archive.reviewCount, 1);
        assert.equal(
          (
            await owner.request(`/trips/${womenTripId}/reviews`, {
              method: "POST",
              body: {
                travelerId: aliceUser.id,
                rating: 4,
                body: "Respectful and reliable on our shared journey.",
              },
            })
          ).status,
          201,
        );
      },
    );
    await t.test(
      "Google callback binds browser and state, verifies email and does not auto-link",
      async () => {
        async function start(cookie = "") {
          const r = await fetch(base + "/api/auth/google/start", {
            redirect: "manual",
            headers: { Cookie: cookie },
          });
          assert.equal(r.status, 302);
          return {
            state: new URL(r.headers.get("location")).searchParams.get("state"),
            cookie: r.headers.getSetCookie()[0].split(";")[0],
          };
        }
        async function callback(flow, cookie = flow.cookie) {
          return fetch(
            base +
              "/api/auth/google/callback?state=" +
              flow.state +
              "&code=test-code",
            { redirect: "manual", headers: { Cookie: cookie } },
          );
        }
        const flow = await start();
        assert.match(
          (await callback(flow, "")).headers.get("location"),
          /expired/,
        );
        googleClaims = { ...googleClaims, email_verified: false };
        assert.match(
          (await callback(flow)).headers.get("location"),
          /verification/,
        );
        assert.match((await callback(flow)).headers.get("location"), /expired/);
        googleClaims = {
          ...googleClaims,
          email_verified: true,
          email: "owner@example.com",
        };
        assert.match(
          (await callback(await start())).headers.get("location"),
          /existing/,
        );
        googleClaims = { ...googleClaims, email: "google@example.com" };
        const pending = await callback(await start());
        assert.equal(pending.headers.get("location"), "/#sso-complete");
        const google = new Client();
        google.cookie = pending.headers
          .getSetCookie()
          .find((c) => c.startsWith("tripling_pending="))
          .split(";")[0];
        const p = await google.request("/auth/google/pending");
        assert.equal(p.body.email, "google@example.com");
        const docs = (await google.request("/legal")).body.documents;
        const details = {
          firstName: "Google",
          lastName: "Traveler",
          age: true,
          acceptedLegal: true,
          termsVersion: docs.terms.version,
          privacyVersion: docs.privacy.version,
        };
        assert.equal(
          (
            await google.request("/auth/google/complete", {
              method: "POST",
              body: { ...details, lastName: "" },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await google.request("/auth/google/complete", {
              method: "POST",
              body: { ...details, termsVersion: "old" },
            })
          ).status,
          409,
        );
        const complete = await google.request("/auth/google/complete", {
          method: "POST",
          body: details,
        });
        assert.equal(complete.status, 201);
        assert.equal(complete.body.user.googleLinked, true);
        const dbUser = (await records("users", { email: "google@example.com" }))
          .rows[0];
        assert.equal(dbUser.password_hash, null);
        const linked = await callback(await start());
        assert.equal(linked.headers.get("location"), "/#discover");
        const linkFlow = await fetch(
          base + "/api/auth/google/start?mode=link",
          { redirect: "manual", headers: { Cookie: owner.cookie } },
        );
        const link = {
          state: new URL(linkFlow.headers.get("location")).searchParams.get(
            "state",
          ),
          cookie:
            owner.cookie +
            "; " +
            linkFlow.headers.getSetCookie()[0].split(";")[0],
        };
        googleClaims = {
          ...googleClaims,
          sub: "owner-google",
          email: "owner@example.com",
        };
        assert.equal(
          (await callback(link)).headers.get("location"),
          "/#profile",
        );
        assert.equal(
          (await owner.request("/auth/providers")).body.googleLinked,
          true,
        );
      },
    );
    await t.test(
      "new group eligibility, gender and style preserve legacy contracts",
      async () => {
        const restricted = new Client();
        restricted.ip = "198.51.100.4";
        const restrictedUser = await restricted.signup(
          "restricted-group@example.test",
        );
        const original = (await owner.request("/auth/session")).body.user
          .gender;
        await owner.profile("Organizer", "man");
        const created = await owner.request("/trips", {
          method: "POST",
          body: { ...trip, groupEligibility: "men", category: "Backpacking" },
        });
        assert.equal(created.status, 201);
        const id = created.body.id;
        await restricted.profile("Bob", "woman");
        assert.equal(
          (
            await restricted.request(`/trips/${id}/requests`, {
              method: "POST",
              body: { note: "I would like to join this group." },
            })
          ).status,
          403,
        );
        await restricted.profile("Bob", "man");
        assert.equal(
          (
            await restricted.request(`/trips/${id}/requests`, {
              method: "POST",
              body: { note: "I would like to join this group." },
            })
          ).status,
          201,
        );
        await restricted.profile("Bob", "non-binary");
        assert.equal(
          (
            await owner.request(`/trips/${id}/requests/${restrictedUser.id}`, {
              method: "PUT",
              body: { status: "accepted" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await owner.request("/trips", {
              method: "POST",
              body: { ...trip, from: "  " },
            })
          ).status,
          400,
        );
        const publicTrip = (
          await anonymous.request("/bootstrap")
        ).body.trips.find((t) => t.id === id);
        assert.equal(publicTrip.groupEligibility, "men");
        assert.equal(publicTrip.category, "Backpacking");
        assert.equal(publicTrip.gender, undefined);
        const options = (await anonymous.request("/bootstrap")).body.options;
        assert.equal(options.travelStyles.length, 10);
        await owner.profile("Organizer", original || "other");
      },
    );
    await t.test(
      "data survives app restart; logout revokes sessions, not data",
      async () => {
        const second = createApp(pool, { production: false }).listen(
          0,
          "127.0.0.1",
        );
        await new Promise((r) => second.once("listening", r));
        const r = await fetch(
          `http://127.0.0.1:${second.address().port}/api/bootstrap`,
          { headers: { Cookie: alice.cookie } },
        );
        assert((await r.json()).saved.includes(tripId));
        await new Promise((r) => second.close(r));
        const cookie = alice.cookie;
        assert.equal(
          (await alice.request("/auth/logout", { method: "POST", body: {} }))
            .status,
          200,
        );
        alice.cookie = cookie;
        assert.equal((await alice.request("/auth/session")).body.user, null);
        assert.equal(
          (await records("saved_trips", { user_id: aliceUser.id })).rowCount,
          1,
        );
      },
    );
    await t.test(
      "database rate limits reject repeated bad logins",
      async () => {
        const client = new Client();
        let r;
        for (let i = 0; i < 11; i++)
          r = await client.request("/auth/login", {
            method: "POST",
            body: { email: "missing@example.com", password: "wrong-password" },
          });
        assert.equal(r.status, 429);
      },
    );
    await t.test(
      "migration reruns are safe and production TLS is mandatory",
      async () => {
        await migrate(pool);
        assert.throws(
          () =>
            validateMongoConfiguration(
              { NODE_ENV: "production" },
              "mongodb://localhost/?tls=false",
            ),
          /verified TLS/,
        );
        assert.throws(
          () =>
            validateMongoConfiguration(
              { NODE_ENV: "production" },
              "mongodb://localhost/?tlsAllowInvalidCertificates=true",
            ),
          /verified TLS/,
        );
      },
    );
  });
} finally {
  await new Promise((r) => server.close(r));
  await pool.close();
}
