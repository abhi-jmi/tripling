# Google sign-in for Tripling

The application implements Google OpenID Connect with authorization code exchange, PKCE, nonce, a browser-bound one-use state, and server-side sessions. It requests only `openid email profile`. No Google credentials are included in the repository. Until configured, email/password login works and Google sign-in is shown as unavailable.

## Create the Google OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/), select/create a project, and open **Google Auth Platform**.
2. Configure Branding, Audience, Data Access, and the consent screen. Use Tripling, support `abhishek@tripling.in`, home `https://tripling.in`, Terms `https://tripling.in/terms`, Privacy `https://tripling.in/privacy`, and authorized domain `tripling.in`. Complete any Google domain/brand verification that is requested. While the application is in Testing, add your permitted test users; publish to Production when ready for everyone.
3. Under Clients, create a **Web application** OAuth client. Authorized JavaScript origin: `https://tripling.in`. Authorized redirect URI, exactly: `https://tripling.in/api/auth/google/callback`.
4. Store the client ID and client secret privately. Do not paste the secret into chat, GitHub variables, a shell command, or source code.

For local development, add a separate callback such as `http://localhost:3000/api/auth/google/callback` and origin `http://localhost:3000`. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in untracked `.env`; set `PUBLIC_ORIGIN` to the exact local origin if needed. Use the same hostname throughout login.

## AWS configuration

The current ECS tasks are in private subnets without an Internet route. Google token exchange, discovery, and signature-key downloads require outbound HTTPS. The foundation template includes an **optional, disabled by default, single NAT gateway** and private default route. Enabling Google through the bootstrap script enables this route. NAT gateway hourly, data processing, public IPv4, Secrets Manager, and possible cross-AZ transfer charges apply, even when nobody signs in. Check [Sydney VPC pricing](https://aws.amazon.com/vpc/pricing/) before enabling it. A single gateway trades cost for an availability dependency on one AZ. Database and ECS tasks remain private.

1. In **AWS Secrets Manager → Store a new secret → Other type of secret**, create a secret in **ap-southeast-2** with the exact keys `clientId` and `clientSecret`. Enter the Google values in the console. Use the default Secrets Manager encryption key; a custom KMS key would also need a scoped decrypt grant. Save it, and copy its ARN (the ARN is not the secret).
2. In authenticated CloudShell, pull the repository and run the following after replacing `YOUR_GOOGLE_SECRET_ARN` with that ARN. This updates the existing stacks and enables the billable outbound route. Keep your existing custom infrastructure environment settings if you changed their defaults.

```bash
cd "$HOME/tripling" && git pull --ff-only && AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2 TRIPLING_GOOGLE_SECRET_ARN=YOUR_GOOGLE_SECRET_ARN TRIPLING_CERTIFICATE_ARN=arn:aws:acm:ap-southeast-2:669991883783:certificate/0d55419d-b822-4fb9-9643-f8426199f20b TRIPLING_DEPLOY_APPROVED=yes bash scripts/deploy-aws.sh
```

The service grants its runtime role access only to that optional secret, retrieves it at startup, and never exposes it to the frontend. Future releases preserve the configured secret ARN and route when these optional parameters are omitted. Changing a secret requires new tasks (`aws ecs update-service --force-new-deployment` with the actual cluster/service) to reload it. Disabling the feature requires explicitly clearing the service's `GoogleOAuthSecretArn`; disable the foundation's `InternetEgress` only after no remaining feature needs it.

Account-plan or organization policy restrictions on NAT or secret creation must be resolved through the account owner/AWS support. Do not delete the database or foundation to work around an authorization error. GitHub automatic deployment still requires the previously documented OIDC role configuration; Google sign-in does not change that requirement.

## Verify after deployment

- Visit `https://tripling.in/api/auth/providers`: `google` should be `true`.
- New Google user: choose Google, verify first/last names, confirm 18+, and accept the current policies. A Google-only user signs in with Google subsequently; no local password is invented.
- Existing email/password user: log in normally, open the traveler profile, choose **Connect Google**, and select the Google account with the same email. Matching an email alone never auto-links accounts.
- Cancel Google authorization, try a stale callback, and confirm login can be restarted without an account being created.
- Sign out and sign in again. Check that the correct profile, saved trips and memberships return.

Automated tests use an injected provider adapter for callback/account/link logic, not real Google credentials. A real Google consent/sign-in check remains necessary after configuration.
