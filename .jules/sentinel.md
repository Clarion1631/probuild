## 2026-05-28 - XSS in AI Contract Drafting
**Vulnerability:** XSS vulnerability where AI-generated HTML string was injected directly via `dangerouslySetInnerHTML={{ __html: draftedHtml }}` without sanitization in `ProjectContractsClient`.
**Learning:** Even internal backend-generated HTML (from `fetch("/api/ai/draft-contract")`) must be sanitized because AI-generated text is untrusted input.
**Prevention:** Always wrap variables passed to `dangerouslySetInnerHTML` with `DOMPurify.sanitize()`, e.g., `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}`.
