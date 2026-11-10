import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
const pool = await createPool();
try {
  await migrate(pool);
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
