## 2024-06-07 - Hardcoded Secrets in Authentication Modules
**Vulnerability:** Found hardcoded fallback values for `NEXTAUTH_SECRET` and `SUB_PORTAL_SECRET` in `src/lib/actions.ts`, `src/lib/crypto.ts`, and `src/lib/subcontractor-actions.ts`.
**Learning:** Hardcoding secrets as fallbacks in authentication or encryption logic poses a critical risk if a deployment forgets to configure these variables. The system will silently fall back to known, insecure values.
**Prevention:** Always implement a fail-secure approach: check for the existence of required environment variables early and throw an explicit error if they are missing, rather than providing a default fallback. This ensures the application fails fast and loudly during startup or execution if misconfigured.
