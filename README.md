# Tripling

A responsive, trip-first travel companion discovery website based on the Travel Companion App Product Plan.

## This implementation
- Destination, starting-city, and overlapping-date search
- Travel style, women-only, budget, and transport filters; sorting
- Trip details, sample itineraries, estimated budgets, and ground rules
- Saved trips, local traveler profile, create/delete trip, and local join/cancel requests
- Women-only request eligibility checks using an explicitly self-declared demo profile
- Safety guidance and local report/hide controls
- Responsive layouts, keyboard-accessible dialogs, and reduced-motion support

This is a browser prototype. Existing listings, hosts, and compatibility scores are illustrative. Data persists in localStorage on the current browser only. There is no real authentication, verification, live moderation, host approval, messaging, or booking. Never use this preview to arrange actual travel.

## Run
Serve `dist/` with any static HTTP server, for example `python -m http.server 3000 --directory dist`. No build step or dependencies are required. Hosting configuration is in `.openai/hosting.json`.

## Next implementation stage
Add an authenticated API with PostgreSQL and server-side ownership and eligibility checks; define trip/request lifecycle; enable organizer approvals and member-only chat; implement privacy, reporting/moderation, account deletion, and verification policy. Replace illustrative fit scores with explainable destination/date/budget/style matching.

Photos: Unsplash, downloaded as local assets. Google Fonts: DM Sans and Manrope, with system fallbacks.

## Email-first login preview
The initial route now shows an email-only login screen. Guest discovery remains available. Saving a trip, joining, creating, viewing personal pages, opening a profile, or recording a report requires a temporary preview session. The requested action resumes after continuing with an email.

This is explicitly **not verified authentication**: no email is sent, no ownership proof is collected, and client-side guards are not a security boundary. The hosting platform's existing owner-private access remains unchanged. Before public launch, connect an email code/magic-link provider and enforce authentication and ownership on the server.

Preview sessions expire after eight hours and survive reloads in the same tab when browser storage is available. Session identity is kept in sessionStorage; trip/profile data is stored under a random per-session namespace. Ending the preview session removes that session's local records. Earlier unscoped prototype records are left untouched and are not imported into new sessions.
