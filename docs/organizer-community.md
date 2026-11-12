# Organizer and community release

This increment completes the organizer/community application workflows on the
existing Node.js/Express/MongoDB stack. It is not automatically deployed.

## Features and policies

- Organizer application: Not Submitted → Pending → Approved/Rejected. Only
  configured admins can decide pending applications; an administrator cannot
  approve their own application. References/contact/experience are required;
  supporting business/experience documents are optional. Do not request or upload
  government IDs. An approval is not KYC certification or a safety guarantee.
- New trip creation and join-request management require an approved organizer.
  Existing organizers are **not auto-approved**. Their existing public trip and
  participation records remain. Dashboard: counts, own trips, requests, active
  participants, limited editing and cancellation with reasons. Route/date/group
  capacity are not silently changed under accepted participants. Editing supports
  description, itinerary, rules, title, travel style and actual departure time.
- Guest-first discovery, public trip details, organizer biographies, verification
  badges, organizer review summaries/distribution and genuine traveler stories.
  Account emails/gender and verification evidence are not public profile fields.
- New trips require an actual UTC departure plus IANA display timezone, and a
  selected Google starting Place ID. Backend verifies the local date and resolves
  valid city coordinates before atomically publishing. Legacy missing departure
  times are not invented: support must process exceptions or the verified
  organizer must confirm an actual time through Edit.
- Participation cancellation is rejected at exactly 24 hours and below,
  including a started-but-not-completed trip. Pending requests can be withdrawn.
  Completed/canceled-trip participants may leave retained records. Admin overrides
  require a reason and are audited. Organizers cannot use member removal to bypass
  the 24-hour restriction. Administrators can remove/handover even an organizer
  exceptionally. Emergency safety: contact support/local emergency services;
  the platform restriction is not an instruction to remain physically present.
- Organizer reviews: confirmed date-overlapping participation, completed trip,
  no self-review, one per author/trip. Hidden reviews do not affect public
  averages. Trip cards show ratings and approved badges. Moderation is audited.
- Testimonials require completed-trip participation and explicit publication
  consent; admin approval and a featured selection are required. Resubmission
  returns a story to pending. No fake stories or photos are seeded.
- Write to Us: guest/account forms, validated email/category/message, honeypot,
  five submissions per IP per 15 minutes. Only admins can read/update status and
  internal notes. A success message follows persisted submission.

## Production configuration required before releasing

1. Choose trusted existing **account UUIDs** as administrators. Set the comma
   separated `TRIPLING_ADMIN_USER_IDS` server setting / CloudFormation
   `AdminUserIds`. An empty value disables administration. Do not put public
   registration controls on this setting. Protect those accounts and AWS access.
2. Have an administrator review organizer applications. There is no automatic
   grandfathered approval; publishing is intentionally denied until approved.
3. For optional document uploads, create a Secrets Manager JSON object with
   `key` containing a random 32-byte base64 encryption key. Set
   `TRIPLING_VERIFICATION_KEY_SECRET_ARN` when using `scripts/deploy-aws.sh`.
   The service parameter is `VerificationKeySecretArn`; startup loads it into
   `VERIFICATION_DOCUMENT_KEY`. For local work use an untracked environment.
   Back up this key safely. Do not rotate it without a re-encryption/key-version
   migration: old evidence cannot be decrypted with a replacement key.
4. Keep Google Places API (New) configured. New publishing validates starting
   cities and obtains coordinates. Existing location records need indexing via
   Administration → Location index maintenance. Each action resolves up to 25
   missing/expired trips, with Google API billing. Repeat until caught up.
5. Index records expire after 29 days. Schedule/operate periodic refresh before
   expiry; missing, ambiguous and expired points are excluded, never guessed.
   A stable production scheduler for recurring reindexing is an operational
   configuration step; the authenticated batch endpoint is supplied here.
6. Review/publish the updated Terms and Privacy alongside these behavior changes.
   Inform existing travelers of the change to leaving/cancellation rules and the
   support exception path. Keep support email monitored.

## Private evidence

Only PDF/PNG/JPEG with matching magic bytes and at most 2 MB are accepted. Content
is AES-256-GCM encrypted with independent random nonces before MongoDB storage.
The application requires a configured 32-byte secret to accept any file. No
plaintext documents are stored and no public document route exists. Only admin
requests can decrypt/download an attachment; each access is audited, responses
are `no-store`, attachment-only, sandboxed and `nosniff`. Files are not malware
scanned or identity-validated; reviewers must use an appropriately isolated
viewer. Document access expires after 30 days; startup maintenance removes
expired ciphertext. Existing backups may retain earlier encrypted copies.

## APIs

- `GET/POST /api/organizer/verification`: own status / apply.
- `GET /api/admin/verifications`, `PUT /api/admin/verifications/:user`:
  private applications / approve or reject.
- `GET /api/admin/verifications/:user/document`: audited attachment download.
- `GET /api/organizer/dashboard`: own trips, metrics, participants, requests.
- `PATCH /api/organizer/trips/:id`: verified own-trip edit.
- `POST /api/organizer/trips/:id/cancel`: verified organizer/admin cancellation.
- `DELETE /api/organizer/trips/:id/members/:user`: reasoned removal/admin override.
- `GET /api/organizers/:id`: public profile, badge, published ratings/reviews.
- `POST /api/trips/:id/organizer-review`: completed-trip organizer review.
- `POST /api/feedback`; `GET /api/admin/community`;
  `PUT /api/admin/feedback/:id`: private feedback management.
- `GET/POST /api/testimonials`; `PUT /api/admin/testimonials/:id`:
  consented submissions, public approved features, moderation.
- `PUT /api/admin/reviews/:id`: reasoned hide/unhide moderation.
- `POST /api/admin/locations/reindex`: bounded coordinate refresh/backfill.
- `GET /api/trips/nearby`: indexed radius search; `limit` 1–100, `offset`,
  `when`, `style`, `budget`, `mode`, `women`, `sort`, optional `otherq` and
  `otherPlaceId` intersect the opposite route endpoint. Returns total and
  nextOffset. Both origin/destination use MongoDB `2dsphere` indexes; distances
  are straight-line. Expired/missing indexed locations are excluded explicitly.

## Database changes

Idempotent collections/indexes: organizer_verifications (unique user),
organizer_reviews (unique trip/author), admin_audit, cancellation_audit, feedback,
testimonials (unique user/trip), trip_locations (unique trip, origin/destination
2dsphere, 29-day TTL). Existing fields are retained; optional new fields include
organizer approval, review organizer, actual departure/timezone and structured
starting city/state/display name/Place ID. City points are in expiring index
records, not permanently embedded in trip documents. Existing data is not deleted
or assigned false approvals, gender or departure times.

## Validation and remaining release considerations

See the final delivery for executed results. Real MongoDB tests cover private
admin access, publishing denial/approval, IDOR editing, exact cancellation
boundary/override audit, radius pagination/index intersection/expiration,
participation-only review uniqueness/moderation, feedback validation/privacy,
and consented testimonial approval/hiding. Existing workflows remain tested.
Local-only browser fixtures explicitly seed an approved organizer and a test
administrator; these helpers are not imported by production startup and refuse
production/remote database settings. No real Google credentials or calls are
used in tests. Live provider access, production key provisioning, administrator
selection, legacy departure confirmation, scheduled coordinate refresh and a
production deployment remain operational steps, not completed remote actions.

### Create the encryption secret without displaying the key

In AWS CloudShell, after selecting the correct account, this command creates the
optional key secret and prints only its ARN. It does not deploy resources. Keep
that ARN for `TRIPLING_VERIFICATION_KEY_SECRET_ARN`; do not generate a replacement
for an existing key without a proper re-encryption migration.

```bash
python3 -c 'import secrets,base64,json,tempfile,subprocess; f=tempfile.NamedTemporaryFile(mode="w+",encoding="utf-8"); json.dump({"key":base64.b64encode(secrets.token_bytes(32)).decode()},f); f.flush(); subprocess.run(["aws","secretsmanager","create-secret","--name","tripling/verification-documents","--secret-string","file://"+f.name,"--region","ap-southeast-2","--query","ARN","--output","text","--no-cli-pager"],check=True); f.close()'
```

Use Atlas Data Explorer to find the trusted administrator's existing `users.id`
by their private account email; configure that UUID on the server, not through a
public API. Administrators do not gain power by changing their profile/email.

## Updated feature completion matrix

| Requested area       | Implemented in this increment                                                                                               | Required before live use                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Verification         | Private applications, optional encrypted evidence, admin decisions/audit, notifications, approved-only badges/publishing    | Configure trusted admins and, for uploads, the stable encryption secret; review applications |
| Dashboard            | Own-trip metrics, requests, participants, profile, limited edit/style update, cancellation/removal with reasons             | Approve organizers and confirm legacy departure times                                        |
| Guests               | Guest-first discovery, public details/profiles/reputation/stories, authenticated action prompts                             | Deploy only after validation and configuration                                               |
| Cancellation         | Strict backend 24-hour boundary, frontend disable, admin exceptions/audit, legacy support flow                              | Notify existing users and monitor support                                                    |
| Organizer reviews    | Confirmed completed-trip reviews, unique author/trip, self-review denial, averages/distribution, card summaries, moderation | Moderator staffing; no imported fake reputation                                              |
| Travel style editing | Backend-validated metadata edit on upcoming own trips                                                                       | Approved organizer                                                                           |
| Starting locations   | Selected starting Place ID required; backend resolution; structured city/state/label; legacy indexing                       | Google key/quotas and backfill ambiguous historical locations                                |
| Nearby search        | MongoDB geo indexes, backend pagination/filter intersection, nearest sorting and missing/expired exclusion                  | Initial backfill and periodic index renewal                                                  |
| Testimonials         | Explicit consent, eligible submissions, approval/hide/feature admin controls, genuine homepage section                      | Actual consented submissions and review                                                      |
| Write to Us          | Persisted guest/account forms, rate limiting, private categories/status/notes, admin pagination                             | Admin/support availability                                                                   |

Admin lists are paginated in blocks of 100. Organizer metadata editing deliberately
does not alter route, dates, eligibility or capacity after participants commit;
changing those requires canceling and creating a new reviewed plan. Starting-city
selection is mandatory for new publishing; no uncertain historical coordinates
or departure times are fabricated during migration.

Location batches persist an unresolved-attempt marker (without a coordinate) for
15 minutes when both cities fail. This prevents a first page of ambiguous names
from starving later trips or repeating paid calls immediately. Partially resolved
trips contain only the valid point; unresolved endpoints remain excluded.

### Important files

- `server/community.js`, `server/roles.js`: role checks, verification, organizer
  management, reputation, feedback/testimonials, audit and cancellation rules.
- `server/geo-index.js`, `server/nearby.js`: validated location materialization,
  expiring geospatial records and paginated indexed search.
- `server/trips.js`, `server/app.js`, `server/auth.js`, `server/index.js`:
  publishing gate, departures, membership enforcement, account flags and secrets.
- `server/migrate.js`, `infra/service.yaml`, `scripts/deploy-aws.sh`:
  idempotent collections/indexes and explicit admin/encryption-key configuration.
- `dist/community.js`, `dist/app.js`, `dist/index.html`, `dist/styles.css`:
  responsive account/admin/public interfaces using the existing design.
- `server/test/community.test.js`, `server/test/integration.test.js`,
  `scripts/check-community-browser.mjs`, `scripts/check-browser.mjs`,
  `scripts/browser-test-server.mjs`: authorization, boundary, database and browser
  tests and isolated local fixtures.

### Executed checks

The full suite passed **113 tests**, with no failures or skipped tests, using a
real local MongoDB replica set and a dedicated PostgreSQL transfer source. Both
Chromium suites passed: existing signup/trips/requests/chat/blocks/reviews/radius
flows, and guest-first/feedback/application/admin-approval/admin-feedback flows.
JavaScript syntax (`npm run check`), `cfn-lint infra/*.yaml`, shell syntax and diff
whitespace checks passed. This plain JavaScript project has no TypeScript step
or separate frontend compiler. A new production container build, live Google
requests, AWS key provisioning and production deployment were not performed.
