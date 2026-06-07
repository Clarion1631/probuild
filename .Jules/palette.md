## 2024-05-18 - Icon-only Controls in File Browser
**Learning:** Icon-only buttons in the file browser (like grid/list view toggles or download actions) lack screen-reader context and keyboard focus states, making navigation difficult for accessibility users relying on keyboard tabs or screen readers.
**Action:** Always pair icon-only controls with `aria-label` (and `title` for pointer users), and ensure they have prominent `focus-visible` rings so keyboard navigation is visibly obvious.
