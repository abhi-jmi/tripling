import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { publishLegalDocuments, legalConfiguration } from "./legal.js";
import { createApp } from "./app.js";
// Load OAuth credentials only on the server; never bake secrets into the image.
if (process.env.GOOGLE_OAUTH_SECRET_ARN) {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  try {
    const value = await client.send(
      new GetSecretValueCommand({
        SecretId: process.env.GOOGLE_OAUTH_SECRET_ARN,
      }),
    );
    let credentials;
    try {
      credentials = JSON.parse(value.SecretString || "{}");
    } catch {
      throw new Error("Google OAuth credentials must be a valid JSON secret.");
    }
    if (
      typeof credentials.clientId !== "string" ||
      !credentials.clientId ||
      typeof credentials.clientSecret !== "string" ||
      !credentials.clientSecret
    )
      throw new Error(
        "Google OAuth secret requires clientId and clientSecret.",
      );
    process.env.GOOGLE_CLIENT_ID = credentials.clientId;
    process.env.GOOGLE_CLIENT_SECRET = credentials.clientSecret;
  } finally {
    client.destroy();
  }
}
legalConfiguration();
const pool = await createPool();
await migrate(pool);
await publishLegalDocuments(pool);
const server = createApp(pool).listen(
  Number(process.env.PORT) || 3000,
  "0.0.0.0",
  (error) => {
    if (error) {
      console.error("Server startup failed:", error.code || error.name);
      process.exit(1);
    }
    console.log("Tripling is ready.");
  },
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
