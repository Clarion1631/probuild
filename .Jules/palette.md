## 2025-06-22 - Accessibility additions
**Learning:** In `src/components/studio/RoomList.tsx`, custom modals often use icon-only close buttons that lack `aria-label`, `title` and proper visual focus indicators.
**Action:** Always ensure any icon-only button contains `aria-label`, `title` (if applicable), and clear `focus-visible:ring` styles so keyboard and screen reader users can interact with them successfully.
