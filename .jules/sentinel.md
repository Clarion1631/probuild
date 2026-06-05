## 2025-06-05 - Insecure Hardcoded JWT Secret Fallback

**Vulnerability:** The `SUB_PORTAL_SECRET` in `src/lib/subcontractor-actions.ts` uses a hardcoded fallback string `"sub-portal-dev-secret-change-me"`.
**Learning:** Hardcoding secrets for JWT signing allows attackers to forge tokens if the environment variable isn't set, potentially leading to unauthorized access.
**Prevention:** Remove hardcoded fallbacks and enforce that secrets are loaded from environment variables exclusively.
