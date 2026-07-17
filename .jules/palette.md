## 2024-07-28 - Accessible Modal Close Buttons
**Learning:** Custom modal implementations in this codebase (e.g., `DocumentSignModal`) often use raw SVG icons for close buttons without proper ARIA labels, titles, or keyboard focus indicators.
**Action:** Always add `aria-label`, `title`, and explicit `focus-visible` styling (e.g., `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-md` or using the nearest contextual outline color) to icon-only buttons to ensure they are accessible to screen readers and keyboard navigators.
