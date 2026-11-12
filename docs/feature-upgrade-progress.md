# Tripling upgrade: Phase 1 and location-search increment

## Repository analysis and implementation plan

Tripling has a plain JavaScript/HTML/CSS frontend in `dist/`, an Express backend
on Node.js, and the official MongoDB driver with transactional helper methods.
`server/migrate.js` creates collections/indexes idempotently; SQL files are
archived transfer tooling, not runtime migrations. Password authentication uses
scrypt, hashed server-side sessions and an HttpOnly cookie. Optional Google OIDC
uses browser-bound state/nonce/PKCE. Roles currently distinguish guests, signed-in
travelers, and a trip's current organizer; there is no administrator role or
admin console. Request approval already locks trips and checks capacity.

Existing reusable functionality includes accessible city comboboxes, backend
Google Places requests/Secrets Manager loading, modal forms, private notifications,
transactional membership/organizer handover, private group chat, participant-only
block notices, and completed-trip participant reviews. Reviews currently target
travelers; they are not yet an organizer reputation/moderation system. Existing
My Trips is not a dedicated organizer/admin dashboard. Starting city was already
required and whitespace-validated; gender previously supported only woman,
other and unspecified. No verification upload system, testimonials or feedback
management exists.

Implementation order:

1. **This increment:** shared profile/group/style options, eligibility checks at
   creation/request/approval, preservation of legacy records, starting/destination
   Place IDs, and real 25/50/100 km discovery with a 50 km default.
2. Add explicit UTC departure timestamps with timezone display and an audited
   admin-override foundation before enforcing the new cancellation policy.
3. Add server-owned admin authorization, private verification documents, decision
   audit records and organizer dashboard/management; gate publishing only as part
   of that complete workflow. Never let signup/profile assign admin status.
4. Extend verified participation reviews to organizers with moderation, then
   consented/approved testimonials and private feedback management.
5. Finish guest-first navigation, editing, review widgets and release validation.

No production deployment, destructive database change, administrator bootstrap,
verification approval, cancellation policy change or document upload is included
in this increment. It is a phased implementation, not a claim that all twelve
features are complete.

## Feature status

| #   | Feature                | Status after this increment                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Organizer verification | Not implemented. Needs private document storage, server-owned admins, audit and review UI. Publishing remains under the existing policy.                                                                                                                                                                              |
| 2   | Organizer dashboard    | Partial, existing My Trips/requests/chat/handover retained. Dedicated metrics, edit/cancel and participant administration remain.                                                                                                                                                                                     |
| 3   | Guest permissions      | Partial, existing public browse/details and login/resume retained. Guest-first landing and public organizer profiles remain.                                                                                                                                                                                          |
| 4   | 24-hour cancellation   | Not implemented. Existing leave-anytime behavior remains. UTC departures, audited overrides and corresponding UI/legal changes must land together.                                                                                                                                                                    |
| 5   | Organizer reviews      | Partial, existing completed-trip traveler reviews retained; organizer aggregation, distribution and admin moderation remain.                                                                                                                                                                                          |
| 6   | Group eligibility      | Implemented for creation, join requests and approval. Men Only, Women Only, Mixed Group use self-declared gender on the server; approval rechecks changed profiles.                                                                                                                                                   |
| 7   | Profile gender         | Implemented. Male, Female, Non-Binary, Self-Describe, Prefer Not to Say, unspecified and preserved legacy Other. Self-description is private account profile data.                                                                                                                                                    |
| 8   | Travel styles          | Partial. All ten requested choices work in create, cards/details and discovery filters; existing legacy labels remain readable. Editing awaits trip-edit management.                                                                                                                                                  |
| 9   | Starting location      | Partial. Mandatory frontend/backend city retained; Google Place ID captured when selected. Latitude/longitude are obtained in the temporary city cache; permanent city/state backfill and mandatory resolved selection remain.                                                                                        |
| 10  | 50 km starting search  | Partial. Backend Haversine filtering/ranking, coordinates and radius validation, starting/destination selectors and distance labels work. Larger-catalog background resolution, geospatial indexing and server pagination remain; explicit partial results after 30 distinct cities prevent unbounded provider calls. |
| 11  | Testimonials           | Not implemented. No fabricated testimonials or placeholder publishing.                                                                                                                                                                                                                                                |
| 12  | Write to Us            | Not implemented. Private storage, rate-limited submission and admin management remain.                                                                                                                                                                                                                                |

## Database compatibility

- No existing accounts/trips are dropped, rewritten or assigned inferred genders.
- Existing `women_only` values fall back to Women Only or Mixed Group; new records
  additionally store `group_eligibility`. Legacy clients sending `women` remain
  supported. Existing `other` profiles do not become Male or Female.
- New profiles can store optional `gender_description`; it is returned only with
  the account's own profile. Public trip APIs do not expose gender descriptions.
- New trips may store `from_place_id` and `destination_place_id`. Old free-text
  city records remain usable; ambiguous names are excluded from distance results
  rather than assigned guessed coordinates.
- `place_coordinates` has a unique `key` index and `expires_at` TTL index. Google
  city coordinates expire after 29 days; expired values are never used while TTL
  cleanup catches up. It contains city centers, not live traveler locations.
- Bootstrap returns shared option metadata; no duplicate frontend option catalog.

## API changes

- `GET /api/bootstrap`: `options` metadata, trip `groupEligibility` and group tags.
- `PUT /api/profile`: expanded gender enum and optional `genderDescription`.
- `POST /api/trips`: expanded style enum, optional groupEligibility, fromPlaceId
  and destinationPlaceId. Mandatory starting city remains enforced.
- Existing request/approval endpoints enforce all group types server-side.
- `GET /api/locations`: predictions now optionally include Google Place IDs.
- `GET /api/trips/nearby?field=origin&q=Chandigarh&radius=50`: public eligible
  geographic result IDs ordered by distance, with optional selected `placeId`.
  `field=destination` supports the preceding Manali-radius request. Alternatively
  pass both `lat` and `lng`; ranges and supported 25/50/100 km radii are validated.
  Distances are straight-line, not road distance. No browser GPS is requested.
- Frontend applies existing date/budget/style/visibility filters and pagination
  to geographic matches; if both origins and destinations are provided it
  intersects their result sets. Unknown/ambiguous city coordinates are excluded
  and partial searches are identified. A provider failure explicitly falls back
  to text matching, rather than labelling textual matches as within 50 km.

## Configuration and production prerequisites

Use the existing Google Places API (New) key and server-side AWS secret. Nearby
lookup adds Place Details requests (and city autocomplete when a historical city
has no saved ID). Configure provider quotas and billing alerts. Live Google
requests cannot be validated without configured credentials in this workspace.
No new provider, public API key or database credential is added.

Existing date-only departures are insufficient for an exact 24-hour rule. The
next phase must collect an actual departure instant/timezone and provide a safe
legacy-trip completion flow; it must not guess midnight for existing trips.
The new cancellation requirement supersedes the previous leave-anytime rule,
but it is deliberately not partially enforced before audited exceptions exist.

See the final chat delivery for actual executed test results. Remaining features
must be completed and regression-tested before treating this as the full release.

## Executed validation for this increment

- 101 automated tests passed, zero failed/skipped, using a local MongoDB replica
  set and dedicated PostgreSQL migration source. New tests exercise eligibility
  changes before approval, all style metadata, mandatory starting city, coordinate
  bounds, nearby origin/destination matching, distance ordering, cache expiry and
  provider failures. Existing authentication, capacity and migration checks pass.
- Chromium end-to-end checks passed for signup/login/profile, creation, joining,
  private chat, blocks, reviews, Google suggestions, both radius-search controls,
  keyboard interactions and desktop/mobile layouts. A separate tablet check
  confirmed visible starting/radius controls and no horizontal overflow.
- `npm run check` passed (JavaScript syntax); `cfn-lint infra/*.yaml` passed;
  `git diff --check` passed. There is no TypeScript type-check step in this plain
  JavaScript application and no separate frontend compilation step.
- No production container rebuild or live Google/AWS call was performed. Google
  HTTP responses were mocked in automated tests; runtime database tests used
  actual local databases. No production deployment was performed.
