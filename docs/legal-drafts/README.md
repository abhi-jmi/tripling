# Supplied policy drafts and implementation edits

The owner supplied Terms and Conditions and a Privacy Policy dated November 10, 2026, and supplied `abhishek@tripling.in` as the public contact. The Terms select Indian law and Chandigarh courts. The supplied drafts are retained as `user-terms.txt` and `user-privacy.md` for comparison. The application's active templates are in `server/legal/terms.json` and `server/legal/privacy.json`.

The website templates follow the supplied structure and use the supplied date, contact, and choice of governing law/jurisdiction. Changes made to avoid inaccurate or overbroad published statements:

- Government ID upload, third-party KYC, masking/deletion of identity documents, and verification badges are described as unavailable, with conditions for any future introduction.
- Account fields describe the actual schema rather than claiming collection of phone numbers, exact ages, or profile photographs.
- “No data sharing” is expressed as no sale/rental/trade or advertising profiling, with the actual public listing, organizer/group, hosting, font-provider, operator, and lawful-disclosure flows explained.
- Account closure/deletion is described as a contact-based request, with actual backup/log retention and no promise of automatic or immediate deletion.
- Zero-liability, automatic intermediary immunity/DPDP-compliance assertions, absolute non-refund rules, unrestricted law-enforcement disclosure, and unconditional jurisdiction/termination provisions are qualified by applicable law and mandatory rights.
- Current service has no fees or payments. Future fees/refund terms must be disclosed before payment.

These edits update policy content, not implement ID verification, payments, or an automatic account-deletion feature. The owner subsequently supplied Tripling as the public operator name, which is now configured along with the supplied email and jurisdiction. New content produces new immutable database policy versions on application startup; existing acceptance records are retained.
