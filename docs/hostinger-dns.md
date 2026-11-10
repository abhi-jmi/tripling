# tripling.in DNS handoff

The owner identified Hostinger as the DNS provider. Public DNS checked during setup showed:

- Nameservers: `nova.dns-parking.com`, `cosmos.dns-parking.com`.
- Existing website A record: `2.57.91.91`.
- Mail exchangers: preference 5 `mx1.hostinger.com`, preference 10 `mx2.hostinger.com`.

These are observations, not records to blindly recreate later. Refresh the current zone before making changes. No DNS records have been changed by this configuration work.

## Certificate validation

Once authenticated to AWS account `669991883783`, request an ACM public certificate for `tripling.in` in **Mumbai (`ap-south-1`)** using DNS validation. For Hostinger-managed DNS, use ACM's external-DNS validation flow rather than the Route 53 certificate template. Add the exact validation CNAME name and value from ACM to Hostinger's DNS editor. Leave that validation record in place for renewal.

Do not guess the ACM validation record; AWS generates it after the certificate request. Wait until the certificate is `ISSUED` before creating the HTTPS service.

## Website routing

After the load balancer exists, retrieve its DNS target from the `tripling-service` stack. The root domain `tripling.in` needs an apex-compatible ALIAS/ANAME or supported CNAME-flattening feature. Confirm what Hostinger supports for the actual domain/plan before editing the web record. Do not replace the root A record with a temporary load-balancer IP.

If apex aliasing is unavailable, plan a Route 53 DNS migration or another supported HTTPS frontend. Before changing nameservers, copy the full existing zone, including mail, SPF, DKIM, DMARC, verification, and any other application records. Merely creating a Route 53 zone does not move the domain's authoritative DNS.

Preserve the Hostinger MX and mail-related records so `abhishek@tripling.in` continues receiving mail. Website deployment does not authorize removing or changing the email service. Only replace the existing web target after the new HTTPS service is ready and the intended routing change is clear.

## Authentication detail still needed

The console URL supplied by the owner opens the account's console in Sydney. It does not establish an SSO session here or identify the SSO start URL. Identity Center's own region may differ from both the console's selected region and Mumbai. The AWS access-portal/start URL and Identity Center region are needed before the SSO authorization flow can begin. Do not store passwords, MFA codes, or access tokens in this document or the repository.
