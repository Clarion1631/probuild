## 2024-03-20 - Missing ARIA Labels on Icon-only Buttons
**Learning:** Found multiple instances where interactive icon-only buttons lacked `aria-label`s, breaking screen reader functionality. These appeared in modals, template managers, and sidebars.
**Action:** Consistently search for `<button>` elements containing only `<svg>` or icon components and ensure they have descriptive `aria-label`s.
