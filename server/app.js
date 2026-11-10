import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import {
  currentLegalDocuments,
  legalMetadata,
  renderLegalPage,
} from "./legal.js";
import { registerTripRoutes } from "./trips.js";
import { registerBlockRoutes } from "./blocks.js";
import { registerGoogleAuth } from "./google-auth.js";
import { transaction } from "./db.js";
import {
  cookieName,
  cookieOptions,
  digest,
  dummyHash,
  hashPassword,
  issueSession,
  publicUser,
  sessionToken,
  verifyPassword,
} from "./auth.js";
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const uuid = z.uuid();
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z
  .string()
  .min(10, "Use at least 10 characters for your password.")
  .max(128);
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const personName = z
  .string()
  .trim()
  .min(1, "First and last name are required.")
  .max(50)
  .refine(
    (v) => /\p{L}/u.test(v) && !/[\x00-\x1f\x7f]/.test(v),
    "Use a valid name.",
  );
const signupSchema = z
  .object({
    email,
    firstName: personName,
    lastName: personName,
    password,
    confirmPassword: z.string().max(128),
    acceptedLegal: z.literal(true, {
      error:
        "Agree to the Terms and acknowledge the Privacy Policy to create an account.",
    }),
    termsVersion: z.string().min(1).max(80),
    privacyVersion: z.string().min(1).max(80),
    age: z.literal(true, { error: "You must be 18 or older to sign up." }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
const profileSchema = z.object({
  firstName: personName,
  lastName: personName,
  city: z.string().trim().max(60),
  gender: z.enum(["", "woman", "other"]),
  bio: z.string().trim().max(500),
  age: z.literal(true, { error: "You must be 18 or older to use Tripling." }),
});
export function createApp(
  pool,
  {
    production = process.env.NODE_ENV === "production",
    publicOrigin = process.env.PUBLIC_ORIGIN,
    googleAdapter = null,
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.set("Cache-Control", "no-store").json({
        status: "ok",
        version: process.env.APP_VERSION || "development",
      });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get(["/terms", "/privacy"], async (req, res) => {
    const docs = await currentLegalDocuments(pool, { production });
    const doc = docs[req.path.slice(1)];
    if (!doc)
      return res
        .status(503)
        .type("text")
        .send(
          "This policy is not published yet. Please check back before creating an account.",
        );
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderLegalPage(doc));
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.get("origin");
      let valid = false;
      try {
        const url = new URL(origin);
        valid = publicOrigin
          ? url.origin === new URL(publicOrigin).origin
          : url.host === req.get("host") &&
            url.protocol === (production ? "https:" : "http:");
      } catch {}
      if (!valid)
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Use JSON for API requests." });
    }
    next();
  });
  app.use("/api", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) {
        const result = await pool.query(
          "SELECT u.*, EXISTS(SELECT 1 FROM oauth_identities oi WHERE oi.user_id=u.id AND oi.provider='google') AS google_linked FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
          [digest(token)],
        );
        req.user = result.rows[0] || null;
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  const requireUser = (req, res, next) =>
    req.user
      ? next()
      : res.status(401).json({ error: "Please log in to continue." });
  async function throttle(req, key, limit) {
    const window = Math.floor(Date.now() / 900000);
    const result = await pool.query(
      "INSERT INTO auth_rate_limits(bucket_key,window_start) VALUES($1,$2) ON CONFLICT(bucket_key,window_start) DO UPDATE SET attempts=auth_rate_limits.attempts+1 RETURNING attempts",
      [digest(key), window],
    );
    if (result.rows[0].attempts > limit)
      fail(429, "Too many attempts. Please try again in 15 minutes.");
  }
  app.get("/api/legal", async (req, res) =>
    res.json({
      documents: legalMetadata(
        await currentLegalDocuments(pool, { production }),
      ),
    }),
  );
  app.post("/api/auth/signup", async (req, res) => {
    await throttle(req, `signup:${req.ip}`, 10);
    const data = signupSchema.parse(req.body);
    const hash = await hashPassword(data.password);
    try {
      const user = await transaction(pool, async (db) => {
        const result = await db.query(
          "INSERT INTO users(email,password_hash,adult_confirmed,first_name,last_name,display_name) VALUES($1,$2,true,$3,$4,$5) RETURNING *",
          [
            data.email,
            hash,
            data.firstName,
            data.lastName,
            data.firstName + " " + data.lastName,
          ],
        );
        const docs = await currentLegalDocuments(db, { production });
        if (!docs.terms || !docs.privacy)
          fail(
            503,
            "The legal policies are not available yet. Please try again later.",
          );
        if (
          data.termsVersion !== docs.terms.version ||
          data.privacyVersion !== docs.privacy.version
        )
          fail(
            409,
            "Our policies changed. Refresh this page and review the latest versions before signing up.",
          );
        for (const slug of ["terms", "privacy"])
          await db.query(
            "INSERT INTO legal_acceptances(user_id,slug,version) VALUES($1,$2,$3)",
            [result.rows[0].id, slug, docs[slug].version],
          );
        await issueSession(db, req, res, result.rows[0].id, production);
        return result.rows[0];
      });
      res.status(201).json({ user: publicUser(user) });
    } catch (e) {
      if (e.code === "23505")
        fail(
          409,
          "An account cannot be created with these details. Try logging in.",
        );
      throw e;
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    await throttle(req, `login-ip:${req.ip}`, 40);
    const data = loginSchema.parse(req.body);
    await throttle(req, `login-email:${data.email}`, 10);
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      data.email,
    ]);
    const user = result.rows[0];
    const valid = await verifyPassword(
      data.password,
      user?.password_hash || dummyHash,
    );
    if (!user || !valid) fail(401, "Email or password is incorrect.");
    await transaction(pool, (db) =>
      issueSession(db, req, res, user.id, production),
    );
    res.json({ user: publicUser(user) });
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({ user: req.user ? publicUser(req.user) : null }),
  );
  app.post("/api/auth/logout", async (req, res) => {
    const token = sessionToken(req);
    if (token)
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        digest(token),
      ]);
    res.clearCookie(cookieName, {
      ...cookieOptions(production),
      maxAge: undefined,
    });
    res.json({ ok: true });
  });
  app.put("/api/profile", requireUser, async (req, res) => {
    const d = profileSchema.parse(req.body);
    const result = await pool.query(
      "UPDATE users SET display_name=$2,city=$3,gender=$4,bio=$5,adult_confirmed=true,first_name=$6,last_name=$7 WHERE id=$1 RETURNING *",
      [
        req.user.id,
        d.firstName + " " + d.lastName,
        d.city,
        d.gender,
        d.bio,
        d.firstName,
        d.lastName,
      ],
    );
    res.json({ user: publicUser(result.rows[0]) });
  });
  registerGoogleAuth(app, pool, {
    production,
    publicOrigin,
    requireUser,
    throttle,
    personName,
    googleAdapter,
  });
  registerTripRoutes(app, pool, { requireUser, throttle, publicUser });
  registerBlockRoutes(app, pool, { requireUser, throttle });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    express.static(fileURLToPath(new URL("../dist/", import.meta.url)), {
      index: "index.html",
      maxAge: 0,
    }),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: err.issues[0]?.message || "Invalid request." });
    const status = err.status || 500;
    if (status >= 500) console.error("Request failed:", err.code || err.name);
    res.status(status).json({
      error:
        status >= 500 ? "Something went wrong. Please try again." : err.message,
    });
  });
  return app;
}
