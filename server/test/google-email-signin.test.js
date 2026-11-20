import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./launch-helpers.js";
import { cookieName } from "../auth.js";
async function setup(t, database) {
  let claims = {
      sub: "google-subject",
      email: "owner@example.test",
      email_verified: true,
      given_name: "Google",
      family_name: "Name",
    },
    onExchange;
  const f = await fixture(t, database, {
    googleAdapter: {
      authorize: async ({ state, redirectUri, nonce, verifier }) => {
        assert(nonce && verifier);
        return (
          "https://accounts.google.com/o/oauth2/v2/auth?" +
          new URLSearchParams({ state, redirect_uri: redirectUri })
        );
      },
      exchange: async (url, flow) => {
        assert(flow.nonce && flow.verifier && flow.state);
        await onExchange?.();
        return claims;
      },
    },
  });
  const start = async (client, mode = "") => {
    const r = await fetch(
      f.base + "/api/auth/google/start" + (mode ? "?mode=" + mode : ""),
      { redirect: "manual", headers: { Cookie: client?.cookie || "" } },
    );
    assert.equal(r.status, 302);
    return {
      state: new URL(r.headers.get("location")).searchParams.get("state"),
      cookie: [client?.cookie, r.headers.getSetCookie()[0].split(";")[0]]
        .filter(Boolean)
        .join("; "),
    };
  };
  const callback = (flow, extra = "", cookie = flow.cookie) =>
    fetch(
      f.base +
        "/api/auth/google/callback?state=" +
        flow.state +
        "&code=example-code" +
        extra,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
  const session = async (response) => {
    const client = f.client();
    client.cookie =
      response.headers
        .getSetCookie()
        .find((c) => c.startsWith(cookieName + "="))
        ?.split(";")[0] || "";
    assert(client.cookie);
    return (await client.request("/auth/session")).body.user;
  };
  return {
    ...f,
    start,
    callback,
    session,
    setClaims: (value) => {
      claims = value;
    },
    setExchange: (value) => {
      onExchange = value;
    },
  };
}
test("a verified matching email signs into the same account and preserves its data/password/consent", async (t) => {
  const { db, client, start, callback, session, setClaims } = await setup(
    t,
    "tripling_google_email_match_test",
  );
  const passwordClient = client(),
    user = await passwordClient.signup("Owner");
  await db.update(
    "users",
    { id: user.id },
    {
      $set: {
        city: "Delhi",
        bio: "My existing travel profile",
        gender: "woman",
        organizer_verification: "approved",
      },
    },
  );
  const before = await db.one("users", { id: user.id });
  const consent = await db.all("legal_acceptances", { user_id: user.id });
  const trip = await db.insert("trips", {
    owner_id: user.id,
    organizer_id: user.id,
    title: "My existing mountain plan",
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
  });
  await db.insert("saved_trips", { user_id: user.id, trip_id: trip.id });
  await db.insert("trip_members", { user_id: user.id, trip_id: trip.id });
  setClaims({
    sub: "google-owner",
    email: user.email.toUpperCase(),
    email_verified: true,
    given_name: "Different",
    family_name: "Provider Name",
  });
  const flow = await start(),
    response = await callback(flow);
  assert.equal(response.headers.get("location"), "/#discover");
  const signedIn = await session(response);
  assert.equal(signedIn.id, user.id);
  assert.equal(signedIn.googleLinked, true);
  assert.equal(signedIn.name, before.display_name);
  assert.equal(signedIn.city, "Delhi");
  assert.equal(signedIn.organizerVerification, "approved");
  assert.equal(await db.count("users"), 1);
  assert.equal(await db.count("oauth_identities", { user_id: user.id }), 1);
  assert.equal(
    (await db.one("users", { id: user.id })).password_hash,
    before.password_hash,
  );
  assert.deepEqual(
    await db.all("legal_acceptances", { user_id: user.id }),
    consent,
  );
  assert(await db.one("saved_trips", { user_id: user.id, trip_id: trip.id }));
  assert(await db.one("trip_members", { user_id: user.id, trip_id: trip.id }));
  assert.equal((await db.one("trips", { id: trip.id })).owner_id, user.id);
  assert.match((await callback(flow)).headers.get("location"), /expired/);
  assert.equal(
    (
      await passwordClient.request("/auth/login", {
        email: user.email,
        password: "A secure test password!",
      })
    ).status,
    200,
  );
  assert.equal((await session(await callback(await start()))).id, user.id);
});
test("unverified email, wrong browser, expired state and browser-supplied email cannot link an account", async (t) => {
  const f = await setup(t, "tripling_google_email_verification_test"),
    user = await f.client().signup("Owner");
  for (const email_verified of [false, undefined, "true"]) {
    f.setClaims({ sub: "unverified", email: user.email, email_verified });
    assert.match(
      (await f.callback(await f.start())).headers.get("location"),
      /verification/,
    );
  }
  f.setClaims({ sub: "google-owner", email: user.email, email_verified: true });
  const wrongBrowser = await f.start();
  assert.match(
    (await f.callback(wrongBrowser, "", "")).headers.get("location"),
    /expired/,
  );
  const expired = await f.start();
  await f.db.updateMany(
    "oauth_flows",
    {},
    { $set: { expires_at: new Date(0) } },
  );
  assert.match((await f.callback(expired)).headers.get("location"), /expired/);
  f.setClaims({
    sub: "new-google",
    email: "different@example.test",
    email_verified: true,
  });
  const unmatched = await f.callback(
    await f.start(),
    "&email=" + encodeURIComponent(user.email),
  );
  assert.equal(unmatched.headers.get("location"), "/#sso-complete");
  assert.equal(await f.db.count("oauth_identities"), 0);
  assert.equal(await f.db.count("users"), 1);
  assert.equal(
    (await f.db.one("oauth_pending", {})).email,
    "different@example.test",
  );
});
test("an existing Google subject is never reassigned to a different matching email", async (t) => {
  const f = await setup(t, "tripling_google_identity_binding_test");
  const first = await f.client().signup("First"),
    secondClient = f.client(),
    second = await secondClient.signup("Second");
  await f.db.insert("oauth_identities", {
    provider: "google",
    subject: "first-subject",
    user_id: first.id,
  });
  f.setClaims({
    sub: "first-subject",
    email: second.email,
    email_verified: true,
  });
  assert.equal(
    (await f.session(await f.callback(await f.start()))).id,
    first.id,
  );
  assert.equal(await f.db.count("oauth_identities", { user_id: second.id }), 0);
  f.setClaims({
    sub: "different-subject",
    email: first.email,
    email_verified: true,
  });
  assert.match(
    (await f.callback(await f.start())).headers.get("location"),
    /auth_error=link/,
  );
  f.setClaims({
    sub: "first-subject",
    email: second.email,
    email_verified: true,
  });
  assert.match(
    (await f.callback(await f.start(secondClient, "link"))).headers.get(
      "location",
    ),
    /auth_error=link/,
  );
  assert.equal(
    (await f.db.one("oauth_identities", { subject: "first-subject" })).user_id,
    first.id,
  );
});
test("concurrent matching Google sign-ins create one binding and keep both sessions valid", async (t) => {
  const f = await setup(t, "tripling_google_email_concurrent_test"),
    user = await f.client().signup("Owner");
  f.setClaims({
    sub: "owner-concurrent",
    email: user.email,
    email_verified: true,
  });
  const flows = await Promise.all([f.start(), f.start()]);
  const responses = await Promise.all(flows.map((flow) => f.callback(flow)));
  for (const r of responses) {
    assert.equal(r.headers.get("location"), "/#discover");
    assert.equal((await f.session(r)).id, user.id);
  }
  assert.equal(
    await f.db.count("oauth_identities", {
      provider: "google",
      user_id: user.id,
    }),
    1,
  );
  assert.equal(await f.db.count("users", { email: user.email }), 1);
});
test("explicit profile linking rechecks the active session after the Google exchange", async (t) => {
  const f = await setup(t, "tripling_google_link_session_test"),
    owner = f.client(),
    user = await owner.signup("Owner");
  f.setClaims({ sub: "owner-link", email: user.email, email_verified: true });
  const flow = await f.start(owner, "link");
  f.setExchange(() => f.db.removeMany("sessions", { user_id: user.id }));
  assert.match((await f.callback(flow)).headers.get("location"), /expired/);
  assert.equal(await f.db.count("oauth_identities", { user_id: user.id }), 0);
});
