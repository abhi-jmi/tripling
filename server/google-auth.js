import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  digest,
  issueSession,
  publicUser,
  sessionToken,
  cookieOptions,
} from "./auth.js";
import { transaction } from "./db.js";
import { currentLegalDocuments } from "./legal.js";
import { httpError } from "./travel-rules.js";

export function googleClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return null;
  let config;
  const configuration = async () =>
    (config ||= await oidc.discovery(
      new URL("https://accounts.google.com"),
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    ));
  return {
    async authorize({ redirectUri, state, nonce, verifier }) {
      return oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).href;
    },
    async exchange(url, flow) {
      const tokens = await oidc.authorizationCodeGrant(
        await configuration(),
        new URL(url),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      return tokens.claims();
    },
  };
}
export function registerGoogleAuth(
  app,
  pool,
  {
    production,
    publicOrigin,
    requireUser,
    throttle,
    personName,
    googleAdapter,
  },
) {
  const adapter = googleAdapter || googleClient();
  const flowCookie = production ? "__Host-tripling-oauth" : "tripling_oauth";
  const pendingCookie = production
    ? "__Host-tripling-pending"
    : "tripling_pending";
  const options = { ...cookieOptions(production), maxAge: 600000 };
  const cookie = (req, name) =>
    (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || "";
  const clear = (res, name) =>
    res.clearCookie(name, { ...options, maxAge: undefined });
  const origin = (req) =>
    publicOrigin
      ? new URL(publicOrigin).origin
      : production
        ? null
        : `http://${req.get("host")}`;
  const available = () =>
    !!adapter && (!production || !!publicOrigin?.startsWith("https://"));
  app.get("/api/auth/providers", (req, res) =>
    res.json({ google: available(), googleLinked: !!req.user?.google_linked }),
  );
  app.get("/api/auth/google/start", async (req, res) => {
    if (!available())
      throw httpError(
        503,
        "Google sign-in is not configured yet. Use email and password.",
      );
    await throttle(req, `google:${req.ip}`, 30);
    const linking = req.query.mode === "link";
    if (linking && !req.user)
      throw httpError(401, "Log in before connecting Google.");
    const state = randomBytes(32).toString("hex"),
      browser = randomBytes(32).toString("hex"),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce();
    const redirectUri = origin(req) + "/api/auth/google/callback";
    const url = await adapter.authorize({
      redirectUri,
      state,
      nonce,
      verifier,
    });
    await pool.query("DELETE FROM oauth_flows WHERE expires_at<now()");
    await pool.query("DELETE FROM oauth_pending WHERE expires_at<now()");
    await pool.query(
      "INSERT INTO oauth_flows(state_hash,browser_hash,verifier,nonce,expires_at,link_user_id,link_session_hash) VALUES($1,$2,$3,$4,now()+interval '10 minutes',$5,$6)",
      [
        digest(state),
        digest(browser),
        verifier,
        nonce,
        linking ? req.user.id : null,
        linking ? digest(sessionToken(req)) : null,
      ],
    );
    res.cookie(flowCookie, browser, options).redirect(url);
  });
  app.get("/api/auth/google/callback", async (req, res) => {
    const reject = (code) => res.redirect("/?auth_error=" + code + "#login");
    try {
      if (!available()) return reject("unavailable");
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const browser = cookie(req, flowCookie);
      clear(res, flowCookie);
      if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser))
        return reject("expired");
      const { rows } = await pool.query(
        "DELETE FROM oauth_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *",
        [digest(state), digest(browser)],
      );
      const flow = rows[0];
      if (!flow) return reject("expired");
      if (req.query.error) return reject("canceled");
      if (
        flow.link_user_id &&
        (req.user?.id !== flow.link_user_id ||
          !sessionToken(req) ||
          digest(sessionToken(req)) !== flow.link_session_hash)
      )
        return reject("expired");
      const claims = await adapter.exchange(origin(req) + req.originalUrl, {
        ...flow,
        state,
      });
      if (
        typeof claims?.sub !== "string" ||
        !claims.sub ||
        claims.email_verified !== true ||
        !z.email().safeParse(claims.email).success
      )
        return reject("verification");
      const email = claims.email.toLowerCase();
      const identity = await pool.query(
        "SELECT u.* FROM oauth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='google' AND i.subject=$1",
        [claims.sub],
      );
      if (flow.link_user_id) {
        if (
          email !== req.user.email ||
          (identity.rows[0] && identity.rows[0].id !== req.user.id)
        )
          return reject("link");
        await pool.query(
          "INSERT INTO oauth_identities(provider,subject,user_id) VALUES('google',$1,$2) ON CONFLICT(provider,subject) DO NOTHING",
          [claims.sub, req.user.id],
        );
        return res.redirect("/#profile");
      }
      if (identity.rows[0]) {
        await transaction(pool, (db) =>
          issueSession(db, req, res, identity.rows[0].id, production),
        );
        return res.redirect("/#discover");
      }
      if (
        (await pool.query("SELECT 1 FROM users WHERE email=$1", [email]))
          .rowCount
      )
        return reject("existing");
      const token = randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO oauth_pending(token_hash,subject,email,first_name,last_name,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
        [
          digest(token),
          claims.sub,
          email,
          String(claims.given_name || "").slice(0, 50),
          String(claims.family_name || "").slice(0, 50),
        ],
      );
      res.cookie(pendingCookie, token, options).redirect("/#sso-complete");
    } catch (e) {
      console.error("Google sign-in failed:", e.code || e.name);
      return reject("verification");
    }
  });
  async function pending(req, db = pool, consume = false) {
    const token = cookie(req, pendingCookie);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw httpError(401, "Restart Google sign-in to continue.");
    const { rows } = await db.query(
      `${consume ? "DELETE FROM" : "SELECT * FROM"} oauth_pending WHERE token_hash=$1 AND expires_at>now()${consume ? " RETURNING *" : ""}`,
      [digest(token)],
    );
    if (!rows[0])
      throw httpError(401, "Google sign-in expired. Please start again.");
    return rows[0];
  }
  app.get("/api/auth/google/pending", async (req, res) => {
    const p = await pending(req);
    res.json({
      email: p.email,
      firstName: p.first_name,
      lastName: p.last_name,
    });
  });
  app.post("/api/auth/google/complete", async (req, res) => {
    await throttle(req, `google-complete:${req.ip}`, 20);
    const d = z
      .object({
        firstName: personName,
        lastName: personName,
        age: z.literal(true),
        acceptedLegal: z.literal(true),
        termsVersion: z.string().max(80),
        privacyVersion: z.string().max(80),
      })
      .parse(req.body);
    try {
      const user = await transaction(pool, async (db) => {
        const p = await pending(req, db, true),
          docs = await currentLegalDocuments(db, { production });
        if (!docs.terms || !docs.privacy)
          throw httpError(503, "Policies are not available.");
        if (
          d.termsVersion !== docs.terms.version ||
          d.privacyVersion !== docs.privacy.version
        )
          throw httpError(
            409,
            "Policies changed. Refresh and review them again.",
          );
        const { rows } = await db.query(
          "INSERT INTO users(email,first_name,last_name,display_name,adult_confirmed) VALUES($1,$2,$3,$4,true) RETURNING *",
          [p.email, d.firstName, d.lastName, d.firstName + " " + d.lastName],
        );
        await db.query(
          "INSERT INTO oauth_identities(provider,subject,user_id) VALUES('google',$1,$2)",
          [p.subject, rows[0].id],
        );
        for (const slug of ["terms", "privacy"])
          await db.query(
            "INSERT INTO legal_acceptances(user_id,slug,version) VALUES($1,$2,$3)",
            [rows[0].id, slug, docs[slug].version],
          );
        await issueSession(db, req, res, rows[0].id, production);
        return { ...rows[0], google_linked: true };
      });
      clear(res, pendingCookie);
      res.status(201).json({ user: publicUser(user) });
    } catch (e) {
      if (e.code === "23505")
        throw httpError(
          409,
          "An account already exists. Log in with your existing method and connect Google from your profile.",
        );
      throw e;
    }
  });
}
