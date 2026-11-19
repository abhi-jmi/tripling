import { createDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { publishLegalDocuments } from "../legal.js";
import { createApp } from "../app.js";
export async function fixture(t, name, options = {}) {
  if (
    !name.endsWith("_test") ||
    !/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(
      process.env.TEST_MONGODB_URI || "",
    )
  )
    throw Error("Launch fixtures require an explicit local test database.");
  const db = await createDatabase({
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DATABASE: name,
    NODE_ENV: "test",
  });
  await db.database.dropDatabase();
  await migrate(db);
  await publishLegalDocuments(db, { NODE_ENV: "test" });
  const app = createApp(db, { production: false, ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });
  const client = () => ({
    cookie: "",
    async request(path, body, method = body ? "POST" : "GET") {
      const r = await fetch(base + "/api" + path, {
        method,
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (r.headers.get("set-cookie"))
        this.cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, body: await r.json() };
    },
    async signup(name) {
      const legal = (await this.request("/legal")).body.documents;
      const r = await this.request("/auth/signup", {
        email: name + "@example.test",
        firstName: name,
        lastName: "Traveler",
        password: "A secure test password!",
        confirmPassword: "A secure test password!",
        age: true,
        acceptedLegal: true,
        termsVersion: legal.terms.version,
        privacyVersion: legal.privacy.version,
      });
      if (r.status !== 201) throw Error(JSON.stringify(r));
      return r.body.user;
    },
  });
  return { db, base, client };
}
