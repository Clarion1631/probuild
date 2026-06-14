## 2025-06-14 - Removed hardcoded secrets
**Vulnerability:** Weak, hardcoded fallback strings were being used for cryptographic operations if `NEXTAUTH_SECRET` was omitted from the environment.
**Learning:** `src/lib/crypto.ts` and `src/app/api/portal/estimates/[id]/pdf-upload/route.ts` used string literals like `"development-secret-key-at-least-32-chars-long!!"` and `"probuild-pdf-token-secret"` as fallbacks, posing a significant risk if deployed without proper configuration.
**Prevention:** Fail securely by explicitly verifying the presence of critical secrets (e.g., throwing an error if missing) rather than relying on insecure defaults.
