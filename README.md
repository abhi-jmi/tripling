# Tripling

Tripling is a travel companion website using **Node.js 22+, Express, and MongoDB**. All application logic is JavaScript. The browser interface uses HTML, CSS and vanilla JavaScript served by Node.js; HTML and CSS remain necessary browser assets.

The application uses the official MongoDB driver, not a SQL compatibility layer. PostgreSQL is no longer a runtime dependency. The `pg` development dependency is used only by the one-time read-only export tool and migration tests. Existing PostgreSQL migrations are archived under `scripts/legacy/postgres-migrations/` for data-transfer compatibility.

## Run locally

```bash
docker compose up --build
```

Open `http://localhost:3000`. Compose starts MongoDB 8 as a single-node replica set, initializes it, and starts the Node.js application. This local database has no authentication and is exposed only on loopback; use authenticated Atlas with verified TLS for production.

MongoDB 8.0 needs a supported host kernel; the current build rejects Linux 6.19+. CI uses Ubuntu 22.04 for its database runner. On an incompatible local kernel, use Atlas or a supported MongoDB host rather than bypassing the server check.

For a separate Node.js process, run `npm ci`, copy `.env.example` to untracked `.env`, configure a MongoDB replica set or Atlas URI, then run `npm start`. The example `directConnection=true` lets a host process access the local Compose database without resolving its internal `mongo` hostname. Inside Compose the app uses `mongo` directly.

`npm run db:setup` initializes collections, unique indexes, expiry indexes and the location catalog. Startup also runs this idempotent setup. It does not drop collections or manufacture traveler records.

## Features

- Email/password registration with required first/last names, confirmation, 18+ acknowledgement, and versioned legal consent. Passwords use salted scrypt; sessions use HttpOnly cookies and hashed tokens in MongoDB.
- Optional [Google sign-in](docs/google-sign-in.md) with PKCE, nonce, browser-bound state and deliberate account linking.
- Database-backed trip posting, alphabetical location suggestions, saved trips, organizer approvals, private group messages and notifications.
- Transactions and unique indexes protect membership, capacity, consent and identity changes across multiple ECS tasks. MongoDB **replica sets/Atlas are required**; standalone MongoDB is rejected at startup.
- Published trips remain available. Everyone may leave; organizer duties pass to the earliest remaining member. With no active organizer, joining closes. Participation history and past-trip reviews remain available.
- Traveler blocking with required reasons. A selected shared trip limits reason visibility to its registered participants, including those who left; private reasons remain with their author. Statements can be reported. Blocks restrict new memberships and hide messages between the affected travelers.
- Public database-backed `/terms` and `/privacy`, safe profile/name search, origin checks and database-backed login throttling.

Travel dates are interpreted in Asia/Kolkata. Public APIs expose selected fields, never password hashes or private account emails. Reporting is stored for operator follow-up; it is not emergency monitoring.

## Checks

Use an isolated MongoDB database whose name ends in `_test`:

```bash
TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=tripling-rs&directConnection=true' TEST_MONGODB_DATABASE=tripling_test npm test
npm run check
```

The PostgreSQL-to-MongoDB transfer integration test additionally takes `PG_SOURCE_TEST_URI` pointing at a **disposable PostgreSQL database ending in `_test`**. That test resets its schema. CI provisions both a MongoDB replica set for all runtime tests and a separate PostgreSQL source for the transfer test. PostgreSQL is not used to run the website.

For browser tests, start a local server against another empty `_test` MongoDB database, then run:

```bash
TRIPLING_TEST_ORIGIN=http://127.0.0.1:3000 TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=tripling-rs&directConnection=true' TEST_MONGODB_DATABASE=tripling_browser_test npm run test:browser
```

Browser tests create test accounts and trips; they reject non-local web origins. Screenshots go to ignored `work/browser-check/`.

## AWS and existing data

The selected production target is MongoDB Atlas on AWS Sydney (`ap-southeast-2`) and the existing Node.js application on ECS Fargate. [AWS deployment](docs/aws-deployment.md) covers secrets, outbound networking, CI/CD and verification. [MongoDB cutover](docs/mongodb-migration.md) covers the read-only export, atomic import, content verification, paused writes and rollback limits.

**Do not deploy this release to the old PostgreSQL-only task configuration.** Deployment guards require a verified Atlas target and explicit cutover acknowledgement. The MongoDB-only code is not a live data migration by itself. Old sessions and incomplete Google flows are deliberately invalidated on transfer; users sign in again with the same password or linked Google account.

Existing RDS resources are kept in the legacy foundation template during cutover. New installations use `infra/foundation-mongodb.yaml` and do not create RDS. The helper selects the existing foundation shape without removing database resources. Retire the old database separately after backups and acceptance; this repository does not delete your production database.
