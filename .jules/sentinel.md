## 2025-02-28 - Unsanitized AI HTML Output
**Vulnerability:** XSS vulnerability in `src/app/projects/[id]/contracts/ProjectContractsClient.tsx` where AI generated HTML for a drafted contract was injected via `dangerouslySetInnerHTML` without proper sanitization.
**Learning:** Even when outputting data from an AI or an internal service, we cannot blindly trust that it will not contain malicious scripts, especially when user input (like prompts or names) is fed into the AI generation step.
**Prevention:** Always use `DOMPurify.sanitize(html)` when using `dangerouslySetInnerHTML` even for AI-generated text. This pattern was already correctly used in `EntityContractsClient.tsx` but missed in `ProjectContractsClient.tsx`. Consistency across components is important.
