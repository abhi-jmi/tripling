# AWS deployment: Node.js and MongoDB Atlas

Tripling runs on ECS Fargate in AWS account `669991883783`, Sydney `ap-southeast-2`, at `https://tripling.in`. The application now needs **MongoDB Atlas**, not the old RDS environment variables. The existing live database is not moved by a Git push.

For an existing PostgreSQL site, complete [the cutover runbook](mongodb-migration.md) first. Do not run a normal release over the old task definition. PostgreSQL remains intact until a separate retirement decision.

## 1. Prepare Atlas

Create a MongoDB Atlas project and cluster on AWS in Sydney, subject to the selected tier's available regions. Use a dedicated application database user, unique password, and only the required `readWrite` access on database `tripling`. Initial index setup also requires the collection/index creation privileges included in that role. Enable the backup option appropriate for the chosen tier and verify retention/restore capability. Free tiers may not include managed backups; do not assume the old RDS backups protect Atlas.

Atlas service charges are separate; AWS credits do not automatically cover them. Review the chosen Atlas tier and AWS NAT/public IPv4/data-transfer costs before enabling networking. A MongoDB replica set or Atlas cluster is required for transactions. Amazon DocumentDB is a different product and is not the target of this migration.

Create an AWS Secrets Manager secret in Sydney with JSON `{"uri":"<your authenticated Atlas SRV connection string>"}`. Enter the value privately in the AWS console. Do not put credentials in chat, source code, GitHub variables, or literal shell commands. Copy only the secret ARN for deployment. Database name is configured separately with `MONGODB_DATABASE=tripling`.

## 2. Prepare outbound access before cutover

ECS tasks remain in private subnets. The supported public Atlas connection uses a single optional NAT gateway with a stable public IPv4 address. This costs money even while idle and has one-AZ availability limits. The foundation allows outbound TCP 27017 for MongoDB and HTTPS for AWS/Google. It exposes no public MongoDB listener in your VPC.

From authenticated CloudShell in Sydney, update networking only, with the existing account's authorization:

```bash
cd "$HOME/tripling" && git pull --ff-only && AWS_REGION=ap-southeast-2 TRIPLING_INTERNET_EGRESS=true TRIPLING_DEPLOY_APPROVED=yes bash scripts/deploy-foundation.sh
```

If reviewing this change on its feature branch, fetch and check out that branch first. The helper detects an existing RDS foundation and preserves its template/resources. New foundations use `foundation-mongodb.yaml` with no RDS instance. An authorization failure stops rather than guessing the stack is missing.

Read the printed `InternetEgressIp`, then allow **only that address `/32`** in Atlas Network Access. Do not allow all Internet addresses. For a separate migration runner, allow only its verified egress address as well. Atlas PrivateLink/peering is an alternative but requires tier/network-specific configuration not provided by these templates.

The VPC Secrets Manager endpoint permits requests for secrets in this AWS account. The application IAM role separately permits its configured MongoDB secret, optional Google secret, and a temporary scoped legacy RDS secret grant to make pre-write rollback possible. New installations have no legacy grant; retire it separately after acceptance. Custom KMS encryption requires an additional scoped decrypt grant. Production connections enforce verified TLS; use the standard Atlas CA trust chain unless you have a specific custom CA requirement.

## 3. Transfer existing data

Follow [MongoDB cutover](mongodb-migration.md). Pause all writers, export the original source consistently, import into an empty Atlas database, and verify counts and original fields before switching. Save the previous ECS task definition and foundation/service parameters. An ECS circuit-breaker rollback is safe only before new MongoDB writes; see the runbook for rollback after reopening.

## 4. Update the application service

After successful verification, set the non-secret MongoDB secret ARN and cutover acknowledgement. Replace `YOUR_MONGODB_SECRET_ARN`:

```bash
cd "$HOME/tripling" && AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2 TRIPLING_MONGODB_SECRET_ARN=YOUR_MONGODB_SECRET_ARN TRIPLING_MONGODB_DATABASE=tripling TRIPLING_MONGODB_CUTOVER_APPROVED=yes TRIPLING_CERTIFICATE_ARN=arn:aws:acm:ap-southeast-2:669991883783:certificate/0d55419d-b822-4fb9-9643-f8426199f20b TRIPLING_DEPLOY_APPROVED=yes bash scripts/deploy-aws.sh
```

Keep any existing custom infrastructure settings in the environment. This updates the foundation/service, builds an immutable application image, reads the URI through the task role at startup, and sets `PUBLIC_ORIGIN=https://tripling.in`. No database credential is embedded in the image or task's plaintext environment. Reapply an approved desired count if you set the service to zero during the maintenance window; `DesiredCount: 1` in the service template may already restore it.

Verify `curl --fail --show-error https://tripling.in/healthz`, then check the exact Git version, password login, any configured Google login, trip lists, saved trips, messages, approvals, blocks, reviews and policies. Run the read-only verification command from the migration runbook before reopening normal traffic. Keep an eye on errors and replica-set/Atlas metrics. The application server fails startup if it cannot connect, create required indexes or use a replica-set deployment.

Existing DNS and ACM configuration remain applicable; see [Hostinger DNS](hostinger-dns.md). [Google sign-in setup](google-sign-in.md) still requires its own OAuth credentials.

## 5. GitHub CI/CD

`.github/workflows/deploy.yml` runs MongoDB application tests and PostgreSQL transfer tests, syntax and CloudFormation checks. Main releases use GitHub OIDC, immutable ECR image digests, ECS stability checks, a health/API/legal smoke check, and rollback on failed rollout.

Repository **Settings → Secrets and variables → Actions → Variables** needs:

| Variable              | Value                                                  |
| --------------------- | ------------------------------------------------------ |
| `AWS_DEPLOY_ROLE_ARN` | Scoped OIDC deployment role ARN from `tripling-github` |
| `AWS_REGION`          | `ap-southeast-2`                                       |
| `AWS_SERVICE_STACK`   | `tripling-service` (optional; default)                 |

For the existing repository, the OIDC template remains `infra/github-oidc.yaml`. Its one-time deployment needs IAM/OIDC permissions. An organization service-control-policy denial must be resolved with the account/organization administrator; neither a GitHub variable nor a static key overrides it. Do not put database credentials into these variables.

The release script refuses a service stack without `MongoDBSecretArn`, preserving the PostgreSQL deployment. Only the explicit one-time service update performs the database configuration switch. Later releases preserve the secret ARN and task-role configuration. Secret rotation requires new tasks to reload the secret.

## Read-only connectivity check before migration

After allowing the NAT IP in Atlas, run this from the feature-branch checkout in CloudShell. Set `TRIPLING_MONGODB_SECRET_ARN` to the existing secret ARN, not its value:

```bash
AWS_REGION=ap-southeast-2 TRIPLING_MONGODB_SECRET_ARN=YOUR_MONGODB_SECRET_ARN TRIPLING_DEPLOY_APPROVED=yes bash scripts/check-mongodb-aws.sh
```

This builds a separate immutable check image, creates the `tripling-mongodb-check` stack with narrowly scoped task/execution roles and a seven-day log group, and runs one short-lived billable Fargate task using the running service's private subnets/security groups. It does not update the service, read PostgreSQL, create collections, publish policies, or write MongoDB records. It fetches the URI through its task role and tests verified TLS, replica-set discovery and projected read access to `tripling.trips`; it logs no credentials or row contents.

Success prints `MONGODB_CONNECTION_OK` and confirms task exit code zero. This proves the separate check task can connect, not that the website has switched databases. Continue with the controlled data transfer before changing the website. An authentication error may mean the saved password is incorrect; a network error requires checking the Atlas allowlist, NAT route and DNS. Do not post the URI/password when requesting help.

The command leaves the website intact. After migration, the separate check stack can be removed with `aws cloudformation delete-stack --stack-name tripling-mongodb-check --region ap-southeast-2`; this removes only its own roles/task definition/log group, not the application stacks or database. The tagged ECR check image can be removed separately when no longer needed.

### Recover an interrupted final reopening

If cutover reports `MONGODB_FINAL_VERIFICATION_OK` and then stops in phase
`opening` with a public HTTP 503, keep `work/mongodb-cutover` and both databases.
Do not repeat the import or return traffic to PostgreSQL. Pull the latest branch
and run `scripts/reopen-mongodb-aws.sh` with `AWS_REGION`,
`TRIPLING_MONGODB_SECRET_ARN`, and `TRIPLING_DEPLOY_APPROVED=yes`.
This checks the saved verification, current MongoDB release, service stability,
and healthy load balancer targets before removing the dedicated maintenance
rule. HTTPS smoke checks retry temporary 503 responses during rule propagation.
On failure it attempts to restore maintenance; it never imports data or deploys
an application image. Successful output is `MONGODB_CUTOVER_COMPLETE`.
