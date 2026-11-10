# Tripling

Tripling is a trip-first travel companion website with a Node.js API and PostgreSQL database. The frontend and API run from the same server so account sessions work without cross-origin configuration.

## Implemented

- Versioned, PostgreSQL-backed Terms and Privacy pages at `/terms` and `/privacy`, with transactional signup acknowledgments. Public operator details are configured as Tripling, abhishek@tripling.in, and Chandigarh/India; invalid production policy configuration is rejected.
- Email/password signup with password confirmation and adult confirmation; email/password login and logout. No email-verification step.
- Salted scrypt password hashes, opaque server-side sessions, HttpOnly cookies, same-origin write protection, persistent login throttling, and bounded password-hashing concurrency.
- Public trip discovery with destination, overlapping date, origin, budget, travel style, and transport filters. No sample accounts or seeded trip listings are inserted into the database.
- Database-backed profiles, trips, saves, requests, memberships, messages, notifications, reports, hidden trips, and post-trip traveler reviews.
- Organizer approval/decline, atomic capacity checks, server-side women-only eligibility checks using self-declared profile eligibility, cancellation, and leaving a group.
- Group chat available only to organizers and approved members, refreshed every five seconds. Leaving revokes access. Canceled groups are read-only.
- Persistent in-app notifications; post-trip reviews only between registered members of the same completed trip.
- Responsive login, discovery, personal plans, and modal flows. Existing illustrative landscape photos are bundled locally.

## Run locally

Requires Node.js 22.21+ and Docker Compose.

```sh
npm ci
docker compose up -d db
cp .env.example .env
npm start
```

Open `http://localhost:3000`. Create your own account, complete your traveler profile, and create the first trip. Open a separate browser profile or incognito window to try a second account and the approval/chat flows.

Alternatively, `docker compose up --build` runs both the app and database. The Compose database password is for local development only; PostgreSQL is bound to loopback. Data survives container restarts in the named `tripling_db` volume. `docker compose down` preserves it; adding `-v` permanently removes local data.

Do not serve `dist/` alone: its interactions now require the Node API. The existing `.openai/hosting.json` identifies the previous static Sites preview; it is not an AWS deployment manifest and that hosted preview has not been updated to this backend.

## Checks

Integration tests reset their database, so the test runner requires a dedicated database whose name ends in `_test`.

```sh
docker compose exec db createdb -U tripling tripling_test
TEST_DATABASE_URL=postgres://tripling:local-development-only@localhost:5432/tripling_test npm test
npm run check
```

Tests cover password validation/storage, login/session rotation, origin checks, authorization, durable records, concurrent last-spot approvals, women-only eligibility at request and approval time, chat membership, leaving, cancellations, reviews, notifications, reports, logout, restart persistence, throttling, and migration safety.

For end-to-end browser checks, start the app against that dedicated test database in another terminal, then run:

```sh
# Requires an installed Chromium/Chrome executable; no cloud services are used.
TRIPLING_TEST_ORIGIN=http://127.0.0.1:3000 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

These checks create two local test accounts and a trip, exercise the complete approval/chat workflow, and capture desktop/mobile screenshots in ignored `work/browser-check/`. The script refuses non-local server origins. The GitHub Actions workflow runs database and deployment-control tests on main-branch pushes and pull requests, and deploys main to AWS only after its OIDC role and repository variables are configured.

## Database and migrations

`server/migrations/*.sql` defines the schema. Startup applies new migrations in order, under a PostgreSQL advisory lock, before listening for requests. Applied migrations are checksum-protected; add new migrations instead of editing an applied file. `npm run migrate` runs them separately when needed.

Sessions expire after seven days. Expired sessions and old throttle buckets are pruned on startup. Passwords and bearer session tokens are never placed in browser storage. The browser keeps only an allowlisted intended action in sessionStorage so login can return to a trip or action.

The original prototype's localStorage records are not imported. This app starts with a clean database and cannot turn old unverified browser profiles into real accounts.

## AWS deployment preparation

**Target: `tripling.in` in Mumbai (`ap-south-1`). The target AWS account is `669991883783` and DNS is at Hostinger. Authenticated AWS access and DNS/certificate setup are still required before the first live deployment.**

See [the AWS deployment guide](docs/aws-deployment.md) for the one-time infrastructure, DNS/certificate, OIDC role, and GitHub configuration. Once configured, passing pushes to main deploy automatically. Until then the workflow explicitly reports deployment as not connected and skips AWS.

The intended architecture is:

```text
Browser → HTTPS Application Load Balancer → ECS Fargate frontend/API
                                                 ↓
                                        private RDS PostgreSQL
                                                 ↑
                                 credentials in Secrets Manager
```

- `infra/foundation.yaml`: VPC, two public load-balancer subnets, two private application/database subnets, ECR repository, encrypted RDS PostgreSQL, seven-day backups, generated database credentials, private ECR/Logs/Secrets Manager endpoints, and an S3 gateway endpoint for image layers. There is no NAT gateway and no public database.
- `infra/service.yaml`: HTTPS load balancer, ACM certificate binding, HTTP-to-HTTPS redirect, non-root Fargate container, scoped IAM roles, health checks, rolling deployments with circuit-breaker rollback, CloudWatch logs, and CPU-based scaling from one to three tasks.
- `Dockerfile`: Node.js 22 container with production dependencies and bundled RDS trust roots. Production database connections require certificate-verified TLS. AWS credentials come from the ECS task role; the application retrieves its database secret without exposing it to the browser.
- `scripts/deploy-aws.sh`: initial infrastructure setup and explicit infrastructure updates.
- `.github/workflows/deploy.yml` and `scripts/deploy-release.sh`: tested main-branch application releases using GitHub OIDC, digest-pinned images, ECS rollout verification, HTTPS smoke checks, and rollback on failure. No long-lived AWS keys are stored in GitHub.
- `infra/github-oidc.yaml`, `infra/certificate.yaml`, and `infra/dns.yaml`: least-privilege release role, regional ACM certificate, and apex-safe Route 53 alias.

For the initial deployment, you need AWS CLI credentials with the necessary permissions, Docker, a domain, and an issued ACM certificate for that domain in the chosen region. Review the templates, service limits, and cost estimate in your account first. Region defaults to Mumbai (`ap-south-1`) and is configurable; no region has been provisioned.

```sh
# Run after connecting AWS and supplying the public operator details.
export AWS_REGION=ap-south-1
export TRIPLING_DOMAIN=tripling.in
export TRIPLING_CERTIFICATE_ARN='<issued ACM certificate ARN in this region>'
export LEGAL_OPERATOR_NAME=Tripling
export LEGAL_CONTACT_EMAIL=abhishek@tripling.in
export LEGAL_JURISDICTION="Chandigarh, India"
TRIPLING_DEPLOY_APPROVED=yes ./scripts/deploy-aws.sh
```

The script prints the load balancer DNS target. Add a DNS alias/CNAME for your hostname, then verify `/healthz` and signup/login over HTTPS. Application versions are released by GitHub Actions after setup; apply infrastructure changes using the bootstrap script from the current clean commit. `TRIPLING_MULTI_AZ=true` enables a standby RDS instance for higher database availability. Database deletion protection is enabled; snapshots, the secret, logs, and ECR repository have retention policies.

AWS validation here is schema-level only. Account permissions, quotas, region-specific availability, DNS, certificate validity, and actual cloud connectivity still require testing during a future authorized deployment. This setup incurs charges for RDS, Fargate, the load balancer, private interface endpoints in both AZs, Secrets Manager, logs, storage, and image scans. Review those costs before enabling deployment.

## API overview

| Area                  | Routes                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Accounts              | `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`       |
| Profile and discovery | `PUT /api/profile`, `GET /api/bootstrap`                                                                |
| Trips                 | `POST /api/trips`, `POST /api/trips/:id/cancel`, `PUT /api/trips/:id/save`                              |
| Requests              | `POST /api/trips/:id/requests`, `DELETE /api/trips/:id/requests`, `PUT /api/trips/:id/requests/:userId` |
| Group                 | `GET /api/trips/:id/members`, `GET/POST /api/trips/:id/messages`                                        |
| Trust                 | `POST /api/reports`, `GET/POST /api/trips/:id/reviews`                                                  |
| Notifications         | `POST /api/notifications/read`                                                                          |
| Legal                 | `GET /terms`, `GET /privacy`, `GET /api/legal`                                                          |
| Health                | `GET /healthz`                                                                                          |

Write requests require JSON and a same-origin `Origin` header. Production uses `PUBLIC_ORIGIN` and secure `__Host-` cookies. Queries are parameterized; ownership, membership, dates, capacity, and eligibility are enforced on the server.

## Remaining launch work

The reporting database is implemented; a moderator console, operational review process, password-recovery flow, and account-deletion UI are not. Terms and Privacy pages are implemented; the supplied operator details are configured, and jurisdiction-specific legal review remains an operating responsibility. Gender eligibility is self-declared, not identity verification. Chat polling returns the newest 100 messages; large-scale discovery, chat pagination, automated abuse detection, and full observability/alerting need further work. The initial deployment uses one database credential for migrations and runtime; separate database roles and a credential-rotation/restart process should be established for a production operating environment. Database backup restoration should be exercised before real users depend on it.

Photos: Unsplash. Fonts: DM Sans and Manrope with system fallbacks. RDS CA bundle: `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`; refresh it as part of certificate maintenance.
