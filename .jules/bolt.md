## 2024-06-07 - Code-Split Heavy Text Editor Dependencies

**Learning:** Static imports of heavy rich text editor libraries (like `@tiptap/react` and its extensions) in client-side containers parse massively on page load, even when hidden behind a modal. This causes WebKit main-thread hydration freeze and delays TBT significantly.
**Action:** Use `next/dynamic` with `ssr: false` to dynamically import heavy text editors only when instantiated. Ensure a loading placeholder is added.
