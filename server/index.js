import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { createApp } from "./app.js";
const pool = await createPool();
await migrate(pool);
const server = createApp(pool).listen(
  Number(process.env.PORT) || 3000,
  "0.0.0.0",
  () => console.log("Tripling is ready."),
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
