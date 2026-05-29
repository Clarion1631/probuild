## 2024-05-24 - Accessibility on section toggles in EntitySidebar
**Learning:** Found an accessibility issue in EntitySidebar.tsx where the section toggle button lacks `aria-expanded` and an `aria-controls` or similar indicator. Screen readers would just read it as a button with the section title, but wouldn't know it expands/collapses content.
**Action:** Always ensure toggleable buttons (like accordions or collapsible sections) have an `aria-expanded` attribute set to true/false depending on the expanded state.
