# Deploy Tripling to AWS and connect GitHub

Target requested by the owner: **AWS account `669991883783`**, **tripling.in**, **Sydney (`ap-southeast-2`)**, with DNS at **Hostinger**. These are configuration targets, not evidence that the domain has been connected or a deployment exists.

The app serves its frontend, authentication API, database-backed legal pages, and other API routes from ECS Fargate behind one HTTPS origin. RDS PostgreSQL is private. The GitHub deployment job releases the full application container; it does not deploy a static-only copy.

## Current setup requirements

1. Connect AWS credentials through the execution environment's secure settings or use an authenticated local AWS CLI. Never commit keys or put them in chat. Initial bootstrap needs CloudFormation, VPC, IAM, ECR, ECS, RDS, Secrets Manager, logs, certificate and (if used) Route 53 permissions. The later pipeline role is much narrower.
2. Confirm control of `tripling.in` and its DNS. No existing domain records should be replaced until ownership and the intended target have been checked.
3. The public operator name is configured as **Tripling**. The owner has supplied `abhishek@tripling.in` as the public support/privacy email and selected India/Chandigarh jurisdiction in the supplied Terms; these now have configured defaults. Production startup refuses missing details; it will not publish placeholder legal pages. Legal text should be checked for the actual operator and operating countries before launch.
4. Review the infrastructure and account costs. This provisions billable Fargate tasks, a load balancer, RDS, private AWS service endpoints in two AZs, secrets, logs and storage. The templates default to one application task (scalable to three), 0.5 vCPU/1 GB each, a `db.t4g.micro` PostgreSQL database, and one-day default automated backups. RDS Multi-AZ is configurable. This is an initial production deployment configuration, not a guarantee of high availability or legal compliance.

## First deployment (one time, with an authorized AWS identity)

Use a clean checkout of `main`. The steps below create actual resources; they have not been run merely by adding this guide.

### A. Certificate

If `tripling.in` uses a public Route 53 hosted zone in this account:

```sh
export AWS_REGION=ap-southeast-2
export TRIPLING_DOMAIN=tripling.in
export TRIPLING_HOSTED_ZONE_ID='<existing public hosted-zone ID>'
aws cloudformation deploy --region "$AWS_REGION" \
  --stack-name tripling-certificate --template-file infra/certificate.yaml \
  --parameter-overrides DomainName="$TRIPLING_DOMAIN" HostedZoneId="$TRIPLING_HOSTED_ZONE_ID"
export TRIPLING_CERTIFICATE_ARN="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" --stack-name tripling-certificate \
  --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" --output text)"
```

If DNS is elsewhere, request a regional ACM certificate for `tripling.in`, add the validation CNAME at the actual DNS provider, and wait until ACM reports `ISSUED`. Set `TRIPLING_CERTIFICATE_ARN` to that certificate. Keep the validation record for renewal. An existing certificate is reusable if it covers the hostname and is in Sydney.

### B. Database, network, and HTTPS service

```sh
export LEGAL_OPERATOR_NAME=Tripling
export LEGAL_CONTACT_EMAIL=abhishek@tripling.in
export LEGAL_JURISDICTION="Chandigarh, India"
TRIPLING_DEPLOY_APPROVED=yes ./scripts/deploy-aws.sh
```

The script applies `infra/foundation.yaml`, builds and pushes the current commit's immutable ECR image, then applies `infra/service.yaml`. The application fetches its database credentials through its ECS task role, verifies database TLS, applies SQL migrations under a lock, and inserts immutable policy versions using the configured public details.

RDS is encrypted, non-public, and deletion-protected. Secrets and images have retention policies; database replacement/deletion creates or retains snapshots. Do not remove database protection or retained resources without reviewing the data impact.

### C. Point DNS at the load balancer

For Route 53, use the existing public zone:

```sh
aws cloudformation deploy --region "$AWS_REGION" \
  --stack-name tripling-dns --template-file infra/dns.yaml \
  --parameter-overrides DomainName=tripling.in HostedZoneId="$TRIPLING_HOSTED_ZONE_ID" ServiceStack=tripling-service
```

For another DNS provider, create an apex-compatible ALIAS/ANAME/flattened record to the `DnsTarget` output. A normal CNAME cannot be used at a zone apex. Never use a temporary load-balancer IP as a permanent A record. Wait for DNS and HTTPS to resolve correctly before enabling automatic releases.

### D. Verify the initial deployment

```sh
APP_ORIGIN=https://tripling.in EXPECTED_VERSION="$(git rev-parse HEAD)" node scripts/smoke-deployment.mjs
```

This checks the exact deployed commit, database-backed health/API, anonymous session behavior, and both published legal pages without creating production test accounts or trips. Actual sign-up, login, authorization, and shared-data flows are tested locally and in CI against a disposable PostgreSQL database.

## Connect GitHub using OIDC (no long-lived AWS keys)

Create the pipeline role **after** the foundation and service stacks exist. If this account already has an IAM provider for `token.actions.githubusercontent.com`, pass its ARN as `ExistingOidcProviderArn` instead of creating a duplicate.

```sh
aws cloudformation deploy --region "$AWS_REGION" \
  --stack-name tripling-github --template-file infra/github-oidc.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides FoundationStack=tripling-foundation ServiceStack=tripling-service \
    RepositoryOwner=abhi-jmi RepositoryName=tripling
export AWS_DEPLOY_ROLE_ARN="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" --stack-name tripling-github \
  --query "Stacks[0].Outputs[?OutputKey=='DeploymentRoleArn'].OutputValue | [0]" --output text)"
```

The trust policy accepts the STS audience and only this subject:

```text
repo:abhi-jmi/tripling:ref:refs/heads/main
```

It does not trust pull-request or other branch subjects. The role can push images only to this app's repository, read the foundation and service stack outputs, register task revisions, pass the two existing task roles, and update this ECS service. It has no direct database-secret read permission and cannot create RDS/VPC resources. Access to deploy application code is still privileged: deployed code runs with the application's existing runtime permissions.

In GitHub → repository **Settings → Secrets and variables → Actions → Variables**, set:

| Variable              | Value                                         |
| --------------------- | --------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN` | `DeploymentRoleArn` from the OIDC stack       |
| `AWS_REGION`          | `ap-southeast-2`                                  |
| `AWS_SERVICE_STACK`   | `tripling-service` (or the actual stack name) |

These values are identifiers, not AWS secret keys. With an already authenticated GitHub CLI, `./scripts/configure-github.sh` can set them instead. No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` repository secret is needed.

The supplied workflow uses the default branch-based OIDC subject and therefore intentionally does not attach a GitHub Environment to the deployment job. Adding an Environment changes the OIDC subject: update the trust policy and apply main-only deployment branch restrictions before making that change. Protect `main` and require application checks/code review according to your team's access model.

## What happens on each push

`.github/workflows/deploy.yml` runs on pull requests, pushes to main, and manual main-branch dispatches:

1. Install dependencies and run syntax checks and integration tests against PostgreSQL 17.
2. Validate all CloudFormation templates and shell deployment syntax.
3. On main, check deployment configuration. If identifiers are absent, clearly report deployment as **not connected** and skip AWS; tests still run. A successful test job alone does not mean the app was deployed.
4. When configured, exchange GitHub's OIDC token for temporary AWS credentials.
5. Build the exact commit, push an immutable ECR tag, resolve its digest, and register a task definition using that digest. Existing roles, secrets, region, and operator settings are preserved. `APP_VERSION` is set to the commit SHA.
6. Update ECS, wait for stability, and ensure the requested task revision actually became the completed primary deployment. An automatic ECS rollback is not counted as a successful release.
7. Check `https://tripling.in` for the expected version, PostgreSQL-backed API, and published policy pages. On failure, restore the previous task definition and fail the job. The workflow summary reports the verified URL, commit and image digest only on success.

Releases are serialized; concurrent pushes do not race the production service. PR jobs cannot assume the deployment role. No sample data or in-browser demo sessions are used in production.

## Migrations, policy changes, and rollback

Database changes run before each application task becomes healthy and are serialized across tasks. Add a new migration file rather than modifying applied SQL. Schema changes must remain compatible with the old application during rolling updates and rollback; rolling back a container does not reverse a database migration.

Policy text lives in `server/legal/*.json` and is inserted into PostgreSQL as immutable, content-hashed versions. Public pages and signup read the database. Signup requires the current versions and records both acknowledgments transactionally; stale versions are rejected. Older rows are retained. This release does not add a full existing-user re-consent workflow for future material policy changes; the operator must plan that before applying such changes.

Application releases update ECS task revisions directly, while the infrastructure remains managed by CloudFormation. For infrastructure or public operator-detail changes, apply the service template from the current clean commit using `scripts/deploy-aws.sh`, then run the same smoke checks. Be aware that infrastructure changes can update the ECS task definition too; do not blindly reapply an old checkout.

Keep database restore tests, patching, secret rotation, account recovery/deletion operations, moderation, legal review and incident response in the operating plan. Actual AWS deployment and live verification are only complete after the account, DNS, certificate, operator details and pipeline variables have been connected and the verification steps succeed.

## Account and Hostinger handoff

Both the bootstrap and release scripts check the authenticated AWS account before resource changes. The configured target is `669991883783`; the GitHub role must belong to that account. The application region is now Sydney, following the successful certificate request there; the earlier Mumbai requests were denied. Identity Center's region is separate and has not been established by the supplied console URL.

See [Hostinger DNS handoff](hostinger-dns.md) for certificate validation and preserving the existing email records. Because authoritative DNS is at Hostinger, do not run the Route 53 certificate or alias templates unless DNS management has intentionally been moved to Route 53. The Hostinger DNS step requires the actual ACM-generated validation record and the final load-balancer target; neither should be guessed.

## Create the foundation while ACM is validating

The foundation stack does not depend on the domain certificate. From the cloned repository in the authorized CloudShell, run `AWS_REGION=ap-southeast-2 TRIPLING_DEPLOY_APPROVED=yes ./scripts/deploy-foundation.sh`. This creates billable RDS/database, network, endpoint and image-repository resources. It does not yet publish the HTTPS website. Creation permissions have not been established merely by a successful stack-read or certificate request. If creation fails, inspect the CloudFormation events before retrying.

The requested ACM certificate is `arn:aws:acm:ap-southeast-2:669991883783:certificate/0d55419d-b822-4fb9-9643-f8426199f20b`. Its validation CNAME has been observed publicly with the expected value, and the owner has reported ACM status ISSUED. Recheck the certificate status if deployment is delayed. The private database and application must use this same deployment region.

Automated RDS backup retention defaults to one day for the current account-plan deployment. Set `TRIPLING_BACKUP_RETENTION_DAYS` explicitly to change it within the plan’s permitted limit (template range: 1–35 days). The earlier seven-day configuration was rejected by RDS. Inspect a failed stack’s status and remaining resources before deleting or recreating it; a `ROLLBACK_COMPLETE` stack cannot simply be updated. Retained secrets or repositories may remain after rollback and should not be removed without verifying they are unused.

## Google sign-in

See [Google sign-in setup](google-sign-in.md) for the OAuth client, Secrets Manager credentials, optional billable NAT route, and post-deployment checks. An ordinary application release does not activate Google by itself. Existing email/password login remains available.
