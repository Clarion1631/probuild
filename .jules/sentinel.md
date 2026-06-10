## 2024-06-10 - Replace hardcoded secrets with explicit configuration failure

**Vulnerability:** Several utility functions relying on environment variables (like `NEXTAUTH_SECRET` and `SUB_PORTAL_SECRET`) were using insecure, predictable default strings (e.g., `"development-secret-key-at-least-32-chars-long!!"`) as fallbacks if the variable wasn't set.
**Learning:** These fallback defaults could inadvertently slip into production if an environment variable wasn't properly configured, allowing attackers to forge tokens or decrypt data easily.
**Prevention:** Rather than silently succeeding with a weak fallback, the codebase must "fail securely" by explicitly checking if a required secret exists and throwing a runtime error or actively rejecting the operation if it does not.
