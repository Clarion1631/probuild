## 2026-05-31 - [Icon Button Accessibility]
**Learning:** Found several icon-only buttons (e.g., delete and copy buttons for estimates) across the app that were only using `title` attributes. While tooltips appear on hover, screen readers relying purely on text labels lack context without proper `aria-label` attributes.
**Action:** Ensure all icon-only buttons receive an `aria-label` and the inner SVGs get `aria-hidden="true"` to prevent redundant/confusing announcements.
