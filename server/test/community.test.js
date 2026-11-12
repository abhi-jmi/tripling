import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../db.js";
import { migrate, COLLECTIONS } from "../migrate.js";
import { publishLegalDocuments } from "../legal.js";
import { createApp } from "../app.js";
import { canCancelParticipation, cancellationMessage } from "../roles.js";
import { encryptDocument, decryptDocument } from "../community.js";
test("cancellation boundary uses exact UTC instants and no guessed legacy time", () => {
  const now = new Date("2030-01-01T12:00:00Z"),
    base = { status: "open", ends_on: "2030-01-10" };
  assert.equal(
    canCancelParticipation(
      { ...base, departure_utc: "2030-01-02T12:00:00.001Z" },
      now,
    ),
    true,
  );
  assert.equal(
    canCancelParticipation(
      { ...base, departure_utc: "2030-01-02T12:00:00Z" },
      now,
    ),
    false,
  );
  assert.equal(
    canCancelParticipation(
      { ...base, departure_utc: "2030-01-02T11:00:00Z" },
      now,
    ),
    false,
  );
  assert.equal(canCancelParticipation(base, now), null);
  assert.equal(
    canCancelParticipation({ ...base, status: "canceled" }, now),
    true,
  );
});
test("verification documents require a real key and authenticated encryption", () => {
  const key = randomBytes(32).toString("base64"),
    data = {
      type: "application/pdf",
      base64: Buffer.from("%PDF-1.4 supporting evidence").toString("base64"),
    };
  const encrypted = encryptDocument(data, key);
  assert(!JSON.stringify(encrypted).includes("supporting evidence"));
  assert.equal(
    decryptDocument(encrypted, key).toString(),
    "%PDF-1.4 supporting evidence",
  );
  assert.throws(() =>
    decryptDocument(
      { ...encrypted, tag: randomBytes(16).toString("base64") },
      key,
    ),
  );
  assert.throws(() => encryptDocument(data, ""));
  assert.throws(() => encryptDocument({ ...data, type: "image/png" }, key));
});
test("community authorization, verified publishing, moderation and private data", async (t) => {
  const pool = await createDatabase({
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DATABASE: "tripling_community_test",
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
  const app = createApp(pool, {
      production: false,
      cityResolver: async (name, placeId) => ({
        latitude:
          name === "Kullu"
            ? 31.9579
            : name === "Noida"
              ? 28.5355
              : name === "Manali"
                ? 32.2432
                : 28.61,
        longitude: name === "Noida" ? 77.391 : 77.2,
        label: name,
        city: name,
        state: "Delhi",
        placeId,
      }),
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => ({
    cookie: "",
    async request(path, body, method = body ? "POST" : "GET") {
      const response = await fetch(base + "/api" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.headers.get("set-cookie"))
        this.cookie = response.headers.get("set-cookie").split(";")[0];
      return { status: response.status, body: await response.json() };
    },
    async signup(name) {
      const legal = (await this.request("/legal")).body.documents;
      const r = await this.request("/auth/signup", {
        email: name + "@example.test",
        firstName: name,
        lastName: "Traveler",
        password: "A secure test passphrase!",
        confirmPassword: "A secure test passphrase!",
        age: true,
        acceptedLegal: true,
        termsVersion: legal.terms.version,
        privacyVersion: legal.privacy.version,
      });
      assert.equal(r.status, 201);
      return r.body.user;
    },
  });
  const admin = client(),
    owner = client(),
    traveler = client(),
    guest = client();
  const adminUser = await admin.signup("admin"),
    ownerUser = await owner.signup("organizer"),
    travelerUser = await traveler.signup("traveler");
  const oldKey = process.env.VERIFICATION_DOCUMENT_KEY;
  process.env.VERIFICATION_DOCUMENT_KEY = randomBytes(32).toString("base64");
  const oldAdmins = process.env.TRIPLING_ADMIN_USER_IDS;
  process.env.TRIPLING_ADMIN_USER_IDS = adminUser.id;
  const trip = {
    title: "A verified mountain adventure",
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
    description: "A proper shared travel plan with public meeting points.",
    women: false,
    age: true,
  };
  try {
    await t.test(
      "community pages support direct URLs and root-relative assets without exposing private data",
      async () => {
        for (const path of [
          "/organizer/dashboard",
          "/organizer/verification",
          "/admin",
          "/feedback",
        ]) {
          const r = await fetch(base + path);
          assert.equal(r.status, 200);
          assert.match(r.headers.get("content-type"), /text\/html/);
          assert.match(r.headers.get("cache-control"), /no-store/);
          const html = await r.text();
          assert.match(html, /<base href="\/"/);
          assert(!html.includes("contact@example.test"));
        }
        const trailing = await fetch(base + "/admin/?offset=100", {
          redirect: "manual",
        });
        assert.equal(trailing.status, 308);
        assert.equal(trailing.headers.get("location"), "/admin?offset=100");
        assert.equal((await fetch(base + "/not-a-page")).status, 404);
      },
    );
    await t.test(
      "guests read public data but cannot manage verification",
      async () => {
        assert.equal((await guest.request("/bootstrap")).status, 200);
        assert.equal(
          (await guest.request("/organizer/verification")).status,
          401,
        );
        assert.equal((await guest.request("/admin/community")).status, 401);
        assert.equal((await owner.request("/admin/community")).status, 403);
      },
    );
    await t.test(
      "unverified organizer cannot publish, submit request, admin approval audited",
      async () => {
        assert.equal((await owner.request("/trips", trip)).status, 403);
        assert.equal(
          (
            await owner.request("/organizer/verification", {
              name: "Travel Organizer",
              contact: "contact@example.test",
              experience: "Experienced in arranging responsible group travel.",
              document: {
                type: "application/pdf",
                base64: Buffer.from(
                  "%PDF-1.4 private supporting evidence",
                ).toString("base64"),
              },
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await traveler.request(
              "/admin/verifications/" + ownerUser.id,
              { status: "approved", reason: "Not authorized" },
              "PUT",
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await admin.request(
              "/admin/verifications/" + ownerUser.id,
              { status: "approved", reason: "References checked" },
              "PUT",
            )
          ).status,
          200,
        );
        assert.equal(
          (await pool.one("users", { id: ownerUser.id }))
            .organizer_verification,
          "approved",
        );
        assert(
          await pool.one("admin_audit", {
            action: "verification_approved",
            subject: ownerUser.id,
          }),
        );
        assert.equal(
          (await owner.request("/organizer/verification")).body.request
            .document,
          undefined,
        );
      },
    );
    await t.test(
      "supporting evidence is encrypted, access-controlled and audited",
      async () => {
        const row = await pool.one("organizer_verifications", {
          user_id: ownerUser.id,
        });
        assert(row.document.data);
        assert(
          !JSON.stringify(row.document).includes("private supporting evidence"),
        );
        assert.equal(
          (await owner.request(`/admin/verifications/${ownerUser.id}/document`))
            .status,
          403,
        );
        const response = await fetch(
          `${base}/api/admin/verifications/${ownerUser.id}/document`,
          { headers: { Cookie: admin.cookie } },
        );
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-disposition"), /attachment/);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.equal(
          await response.text(),
          "%PDF-1.4 private supporting evidence",
        );
        assert(
          await pool.one("admin_audit", {
            action: "verification_document_read",
            subject: ownerUser.id,
          }),
        );
        await admin.request("/organizer/verification", {
          name: "Administrator Organizer",
          contact: "admin@example.test",
          experience: "References are sufficient for this sample application.",
        });
        assert.equal(
          (
            await admin.request(
              `/admin/verifications/${adminUser.id}`,
              { status: "approved", reason: "Self approval not permitted" },
              "PUT",
            )
          ).status,
          403,
        );
      },
    );
    const created = await owner.request("/trips", trip);
    assert.equal(created.status, 201);
    const tripId = created.body.id;
    await t.test(
      "indexed nearby search excludes distant points and paginates in nearest order",
      async () => {
        const near = await owner.request("/trips", {
          ...trip,
          from: "Noida",
          fromPlaceId: "noida-id",
        });
        assert.equal(near.status, 201);
        const far = await owner.request("/trips", {
          ...trip,
          from: "Kullu",
          fromPlaceId: "kullu-id",
        });
        assert.equal(far.status, 201);
        const first = await guest.request(
          "/trips/nearby?field=origin&lat=28.61&lng=77.2&radius=50&limit=1",
        );
        assert.equal(first.status, 200);
        assert.equal(first.body.indexed, true);
        assert.equal(first.body.total, 2);
        assert.equal(first.body.results[0].id, tripId);
        assert.equal(first.body.nextOffset, 1);
        const second = await guest.request(
          "/trips/nearby?field=origin&lat=28.61&lng=77.2&radius=50&limit=1&offset=1",
        );
        assert.equal(second.body.results[0].id, near.body.id);
        assert.equal(second.body.nextOffset, null);
        const both = await guest.request(
          "/trips/nearby?field=origin&q=Delhi&otherq=Manali&radius=50",
        );
        assert.equal(both.status, 200);
        assert.equal(both.body.total, 2);
        assert.equal(
          typeof both.body.results[0].destinationDistanceKm,
          "number",
        );
        await pool.update(
          "trip_locations",
          { trip_id: tripId },
          { $set: { expires_at: new Date(0) } },
        );
        const expired = await guest.request(
          "/trips/nearby?field=origin&lat=28.61&lng=77.2&radius=50",
        );
        assert(!expired.body.results.some((r) => r.id === tripId));
      },
    );
    await t.test(
      "ownership is enforced for editing and cancellation",
      async () => {
        const edit = {
          title: "Edited title",
          description: trip.description,
          plan: "",
          rules: "",
          category: "Trekking",
          departureUtc: trip.departureUtc,
          timeZone: "UTC",
        };
        assert.equal(
          (await traveler.request("/organizer/trips/" + tripId, edit, "PATCH"))
            .status,
          403,
        );
        assert.equal(
          (await owner.request("/organizer/trips/" + tripId, edit, "PATCH"))
            .status,
          200,
        );
        assert.equal(
          (
            await traveler.request("/organizer/trips/" + tripId + "/cancel", {
              reason: "Unauthorized trip cancellation attempt.",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "private feedback can be submitted publicly and managed only by admin",
      async () => {
        assert.equal(
          (
            await guest.request("/feedback", {
              name: "Guest",
              email: "bad",
              category: "Complaint",
              message: "A detailed complaint message.",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await guest.request("/feedback", {
              name: "Guest",
              email: "guest@example.test",
              category: "Suggestion",
              message: "Please improve the accessibility of this form.",
            })
          ).status,
          201,
        );
        const row = await pool.one("feedback", {});
        assert(row.id);
        assert.equal(
          (
            await owner.request(
              "/admin/feedback/" + row.id,
              { status: "Resolved", notes: "" },
              "PUT",
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await admin.request(
              "/admin/feedback/" + row.id,
              { status: "Resolved", notes: "Acknowledged" },
              "PUT",
            )
          ).status,
          200,
        );
      },
    );
    await pool.insert("trip_members", {
      trip_id: tripId,
      user_id: travelerUser.id,
    });
    await pool.insert("trip_participants", {
      trip_id: tripId,
      user_id: travelerUser.id,
      first_joined_at: new Date("2000-01-01"),
      left_at: null,
    });
    await t.test(
      "within-24h direct cancellation is blocked; admin exception is audited",
      async () => {
        await pool.update(
          "trips",
          { id: tripId },
          { $set: { departure_utc: new Date(Date.now() + 3600000) } },
        );
        const denied = await traveler.request(
          "/trips/" + tripId + "/requests",
          {},
          "DELETE",
        );
        assert.equal(denied.status, 409);
        assert.equal(denied.body.error, cancellationMessage);
        assert.equal(
          (
            await admin.request(
              "/organizer/trips/" + tripId + "/members/" + travelerUser.id,
              { reason: "Emergency exception approved by support." },
              "DELETE",
            )
          ).status,
          200,
        );
        assert(
          await pool.one("cancellation_audit", {
            user_id: travelerUser.id,
            override: true,
          }),
        );
      },
    );
    await pool.update(
      "trips",
      { id: tripId },
      { $set: { starts_on: "2001-01-01", ends_on: "2001-01-03" } },
    );
    await pool.update(
      "trip_participants",
      { trip_id: tripId, user_id: travelerUser.id },
      { $set: { left_at: new Date("2001-01-04") } },
    );
    await t.test(
      "only actual completed-trip participants review organizer once",
      async () => {
        assert.equal(
          (
            await guest.request("/trips/" + tripId + "/organizer-review", {
              rating: 5,
              body: "Great organizer and excellent trip.",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await admin.request("/trips/" + tripId + "/organizer-review", {
              rating: 4,
              body: "A nonparticipant must not be able to review.",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await owner.request("/trips/" + tripId + "/organizer-review", {
              rating: 5,
              body: "I cannot review my own organizing.",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await traveler.request("/trips/" + tripId + "/organizer-review", {
              rating: 5,
              body: "Great organizer and excellent trip.",
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await traveler.request("/trips/" + tripId + "/organizer-review", {
              rating: 5,
              body: "Duplicate review should be rejected.",
            })
          ).status,
          409,
        );
        assert.equal(
          (await guest.request("/organizers/" + ownerUser.id)).body.average,
          5,
        );
        const publicReview = (
          await guest.request("/organizers/" + ownerUser.id)
        ).body.reviews[0];
        assert.equal(publicReview.author_id, undefined);
        assert.equal(publicReview.reason, undefined);

        const review = await pool.one("organizer_reviews", {});
        assert.equal(
          (
            await admin.request(
              "/admin/reviews/" + review.id,
              {
                hidden: true,
                reason: "Moderation example for access testing.",
              },
              "PUT",
            )
          ).status,
          200,
        );
        assert.equal(
          (await guest.request("/organizers/" + ownerUser.id)).body.total,
          0,
        );
      },
    );
    await t.test(
      "testimonials need participation, explicit consent and approval",
      async () => {
        assert.equal(
          (
            await traveler.request("/testimonials", {
              tripId,
              message: "A genuine travel experience worth sharing.",
              consent: false,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await traveler.request("/testimonials", {
              tripId,
              message: "A genuine travel experience worth sharing.",
              consent: true,
            })
          ).status,
          201,
        );
        assert.deepEqual(
          (await guest.request("/testimonials")).body.testimonials,
          [],
        );
        const row = await pool.one("testimonials", {});
        assert(row.id);
        assert.equal(
          (
            await admin.request(
              "/admin/testimonials/" + row.id,
              { status: "approved", featured: true },
              "PUT",
            )
          ).status,
          200,
        );
        assert.equal(
          (await guest.request("/testimonials")).body.testimonials.length,
          1,
        );
        assert.equal(
          (await guest.request("/testimonials")).body.testimonials[0].user_id,
          undefined,
        );
        await admin.request(
          "/admin/testimonials/" + row.id,
          { status: "hidden", featured: false },
          "PUT",
        );
        assert.equal(
          (await guest.request("/testimonials")).body.testimonials.length,
          0,
        );
      },
    );
  } finally {
    if (oldKey === undefined) delete process.env.VERIFICATION_DOCUMENT_KEY;
    else process.env.VERIFICATION_DOCUMENT_KEY = oldKey;
    if (oldAdmins === undefined) delete process.env.TRIPLING_ADMIN_USER_IDS;
    else process.env.TRIPLING_ADMIN_USER_IDS = oldAdmins;
    await new Promise((r) => server.close(r));
    await pool.close();
  }
});
