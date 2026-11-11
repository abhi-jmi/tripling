# PostgreSQL → MongoDB Atlas cutover

This is a controlled data transfer, not a runtime SQL adapter. The Node.js application uses MongoDB exclusively. The `pg` package exists only in development/migration tooling; it is excluded from the normal production image. The old RDS database and credentials are retained for a separately approved retirement.

## What is preserved

The transfer preserves user UUIDs, emails and password hashes; trip/organizer records; active and historical participation; requests, saves and hidden choices; messages and notifications (including large numeric IDs as strings); reviews; reports and block reasons; linked Google identities; every legal-policy version and acceptance. Date-only travel fields remain `YYYY-MM-DD`; timestamps become BSON Dates. Legacy accounts keep missing names empty and complete them after sign-in.

For a source before migration 003, current memberships are backfilled into participation history and the creator remains organizer only if still an active member. Already deleted old membership records cannot be reconstructed. Existing sessions, throttle buckets, and incomplete OAuth flows are not transferred; everyone signs in again. The original passwords still work. Linked Google identities are copied when present.

The export uses a single **repeatable-read, read-only PostgreSQL transaction**. It never changes the source schema or data. The snapshot contains sensitive hashes/messages: store it privately, encrypt any transport/storage, keep file access restricted, and remove temporary copies under the operator's retention policy. The utility creates a new file with mode 0600 and refuses to overwrite an existing path.

The import verifies the snapshot checksum and references, requires an empty destination, creates indexes, and writes every collection plus a transfer marker in one MongoDB transaction. Content and counts are checked before commit. Later read-only verification permits newly published legal-policy versions while requiring every original policy and acceptance to remain unchanged. Other original collections must still match; run final verification before reopening writes. A failed import rolls back; an identical verified rerun performs a verification without overwriting data. Unique indexes reject duplicate emails, identities, memberships and reviews. Modified/non-empty destinations are refused. A snapshot checksum detects file changes, not an independently authenticated source; transport it securely.

The atomic importer is intended for the current small application dataset. It holds the snapshot in memory and must fit Atlas transaction/resource limits. If your data exceeds those limits, it stops safely; prepare a separate batched offline migration and verification plan rather than increasing live write activity or deleting the source.

## Prepare privately

1. Provision Atlas on AWS Sydney, database `tripling`, a scoped database user, verified TLS, network access and appropriate backups. See [AWS setup](aws-deployment.md).
2. Prepare a trusted runner with access to private RDS **and** Atlas: for example, a one-off ECS migration task in the application's VPC/subnets/security group, using the NAT route. Ordinary CloudShell cannot reach a private RDS instance unless launched/configured with suitable VPC connectivity. Do not make RDS public to run the export.
3. Build the separate migration image with `docker build -f Dockerfile.migration -t tripling-migration .`, push it to an approved repository, and run it with a dedicated least-privilege task role. The normal application image intentionally has no PostgreSQL driver or migration CLI. For local rehearsal, `npm ci` includes the tooling.
4. The migration role needs access to the source DB secret and target MongoDB secret; grant only those ARNs. Provide `PG_SOURCE_SECRET_ARN`, `PG_SOURCE_HOST`, `PG_SOURCE_DATABASE=tripling`, `PG_SOURCE_SSL_CA=/app/certs/global-bundle.pem`, `MONGODB_SECRET_ARN`, `MONGODB_DATABASE=tripling`, `AWS_REGION=ap-southeast-2`, and `NODE_ENV=production`. A dedicated read-only PostgreSQL user is preferable; the export also enforces a read-only transaction. Alternatively, supply `PG_SOURCE_DATABASE_URL` through a private untracked environment/secret. Never paste raw credentials into commands.
5. Mount a private writable directory for snapshots (for example `/transfer` owned by the container's `node` UID). Export/import/verify must access the **same** snapshot. Separate Fargate tasks do not share ephemeral disks; keep the phases in one trusted runner or transfer the file through encrypted storage with scoped access. Do not include snapshots in Git or container images.

## Maintenance window

Record the current ECS task definition and counts, source RDS snapshot/restore point, Atlas backup settings, and current service parameters. Put public traffic into maintenance, suspend automatic scaling, stop **all** old application writers, and wait for zero running writer tasks/connections before final export. Setting an environment acknowledgement does not actually pause writers. Tell users the website will be briefly unavailable.

Do not merge/release the MongoDB branch to production before the database and maintenance window are ready. Existing application tests and migration rehearsals can run beforehand against disposable databases.

On the trusted runner (real credentials come from private environment settings), run these Node.js commands:

```bash
TRIPLING_WRITES_PAUSED=yes npm run data:export -- /private/transfer/snapshot.json
TRIPLING_WRITES_PAUSED=yes TRIPLING_DATA_MIGRATION_APPROVED=yes npm run data:import -- /private/transfer/snapshot.json
npm run data:verify -- /private/transfer/snapshot.json
```

The migration image entrypoint is the same CLI. Its arguments are `export /transfer/snapshot.json`, `import /transfer/snapshot.json`, or `verify /transfer/snapshot.json`. Supply the corresponding acknowledgements privately as task environment values. Logs print counts/status/error codes, not credentials or row contents.

After verification, update the ECS service using the command in [AWS setup](aws-deployment.md), with the Atlas secret ARN and `TRIPLING_MONGODB_CUTOVER_APPROVED=yes`. Keep the source database unchanged. Check versioned health, policies and imported read-only records before inviting writes. Then restore the approved scaling settings/desired count and reopen traffic. Test sign-in with an existing account and verify its personal trip data. Confirm backups/monitoring after cutover.

## Rollback and retirement

Before any new MongoDB writes, you can stop the new tasks, restore the previous ECS task definition and old database configuration/IAM access, and reopen PostgreSQL. The one-time service update preserves a scoped read grant for the legacy DB secret so the old task can still retrieve it. The source is untouched by the migration. Do not delete the foundation, RDS instance or retained secrets.

**After new MongoDB writes, PostgreSQL is stale.** Freeze writes again, export/retain MongoDB changes, and reconcile them before any reverse cutover. A simple old-image rollback would lose those new changes from the user's view. The CI release script retains its normal rollback for later MongoDB-to-MongoDB application releases; this does not provide cross-database replication.

Keep RDS and its backups until an agreed acceptance/retention period is complete. Its ongoing AWS charges continue. Retirement is a separate action requiring backup verification, export/reference cleanup and approval; the templates/scripts intentionally do not remove the existing RDS resources during this migration.
