## 2025-02-14 - Remove Hardcoded Cryptographic Fallback Secrets
**Vulnerability:** The application previously relied on hardcoded fallback secrets (`development-secret-key-at-least-32-chars-long!!` in `src/lib/crypto.ts` and `sub-portal-dev-secret-change-me` in `src/lib/subcontractor-actions.ts`) in the event that `NEXTAUTH_SECRET` or `SUB_PORTAL_SECRET` weren't provided in the environment variables.
**Learning:** Hardcoded cryptographic keys allow attackers to forge tokens or decipher encrypted data if the application is misconfigured without those environment variables set.
**Prevention:** Rather than using a default fallback, applications must "fail securely" by immediately throwing an error if required secrets are unconfigured.
