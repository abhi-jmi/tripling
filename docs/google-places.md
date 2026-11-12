# Google Places city suggestions

Before deploying the organizer/community release, configure trusted admin account UUIDs and review the [release prerequisites](organizer-community.md). New publishing requires organizer approval and a confirmed starting city.

Destination, starting city, trip creation and profile city use the same keyboard
accessible combobox. With Places configured, the backend calls Places API (New)
Autocomplete with the `(cities)` type collection. English results use Indian formatting and a broad geographic bias around
India, without restricting searches to India. No browser geolocation is requested. The dropdown
shows full regional labels; selection inserts the city name so existing city
searches and stored trips remain compatible. Free text remains supported.

The API key stays on the backend, not in HTML or JavaScript. Only the typed text
is sent; account identities, dates and browser IP addresses are not forwarded.
Google sees the backend's public egress IP. Predictions are not cached. Selected Place IDs can be stored on trips. Nearby search uses a separate 29-day, automatically expiring city-coordinate cache.
Each debounced call is billed individually: no session tokens or Place Details
requests are used. Queries shorter than two characters do not call Google.
Requests are limited to 120 per IP and 2,000 globally per fifteen minutes, across
app instances using MongoDB counters. These limits are abuse controls, not a
billing budget or guaranteed cost cap. Set Google Cloud quota limits and billing
alerts appropriate to your budget.

If no key is configured, the existing catalog is used. Provider failures fall
back to catalog cities with a visible notice. Rate-limited requests show a
suggestions-unavailable message; manual entry stays usable. Google predictions
show the unmodified Powered by Google asset bundled from
https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3.png.
Terms and Privacy describe the integration.

## Google Cloud configuration

1. Create/select a Google Cloud project and enable billing as required by Google.
2. Enable **Places API (New)** and create an API key. This is separate from the
   OAuth client used for Google sign-in.
3. Restrict the key to **Places API (New)**. Use an **IP address** application
   restriction for this server-side integration, rather than browser referrers.
   Obtain the current AWS egress IP with:

```bash
aws cloudformation describe-stacks --stack-name tripling-foundation --region ap-southeast-2 --query "Stacks[0].Outputs[?OutputKey=='InternetEgressIp'].OutputValue | [0]" --output text --no-cli-pager
```

Add that address to the Google key's allowed IPs (the current deployment previously
reported `16.176.94.170`). Do not use the load balancer IP or your browser IP.
Do not share the key in chat, screenshots, GitHub variables or source files.

## Store the key and deploy

Run this single line in AWS CloudShell. When prompted, paste the actual API key;
input is hidden. It creates a new `tripling/google-places` JSON secret and prints
only its ARN. If the secret already exists, update it using Secrets Manager's
Edit button, preserving the JSON key `apiKey`; do not create duplicate secrets.

```bash
python3 -c 'import getpass,json,subprocess,tempfile; key=getpass.getpass("Google Places API key (hidden): ").strip(); assert key,"API key cannot be empty"; f=tempfile.NamedTemporaryFile(mode="w+",encoding="utf-8"); json.dump({"apiKey":key},f); f.flush(); subprocess.run(["aws","secretsmanager","create-secret","--name","tripling/google-places","--secret-string","file://"+f.name,"--region","ap-southeast-2","--query","ARN","--output","text","--no-cli-pager"],check=True); f.close()'
```

Pull the current MongoDB branch and run the existing infrastructure deployment
with `TRIPLING_PLACES_SECRET_ARN` set to the returned ARN. Keep the existing
MongoDB and certificate ARNs. Example for Tripling (the command retrieves the
Places secret ARN automatically after creation):

```bash
cd "$HOME/tripling" && git pull --ff-only && TRIPLING_PLACES_SECRET_ARN=$(aws secretsmanager describe-secret --secret-id tripling/google-places --region ap-southeast-2 --query ARN --output text --no-cli-pager) && export TRIPLING_PLACES_SECRET_ARN && AWS_REGION=ap-southeast-2 TRIPLING_MONGODB_SECRET_ARN=arn:aws:secretsmanager:ap-southeast-2:669991883783:secret:tripling/mongodb-1rAOZU TRIPLING_CERTIFICATE_ARN=arn:aws:acm:ap-southeast-2:669991883783:certificate/0d55419d-b822-4fb9-9643-f8426199f20b TRIPLING_DEPLOY_APPROVED=yes TRIPLING_MONGODB_CUTOVER_APPROVED=yes bash scripts/deploy-aws.sh
```

This updates the application and scoped secret-read permission. It does not run
the data migration or reopen/cutover scripts. A retired PostgreSQL instance stays
retired because its foundation parameters are preserved. Subsequent ordinary CI
releases preserve the configured Places secret environment variable. Updating a
secret value requires replacing/restarting ECS tasks to load it.

After deployment, type `jawa` into either search field. Check for a city such as
Jawalamukhi with a regional label and Google attribution. The API response at
`/api/locations?q=jawa` has `provider: "google"` when live predictions succeed.
A local response or fallback notice means the key, provider access, quota or
network configuration needs review. It does not prove that Google is working.

For local development, use `GOOGLE_PLACES_API_KEY` in an untracked environment
file and configure key restrictions for that development backend separately.
Never reuse the production key in browser tests. Automated tests mock Google;
live billing/API-key activation must be verified in the deployed environment.

Nearby search supports destination and origin city centers through `/api/trips/nearby`, defaults to 50 km, and shows straight-line distances. It adds Place Details calls and may resolve a saved city name through city autocomplete. Ambiguous historical names are excluded with a partial-results notice. Quotas and API-key restrictions still apply. See [organizer/community release](organizer-community.md) for indexed search, pagination, location backfill and periodic renewal.
