## 2024-06-21 - Custom Modal Close Buttons Lack ARIA Labels
**Learning:** Custom implementations of modal close buttons across the app's components consistently lack `aria-label` and visible keyboard focus states (`focus-visible`), hindering screen reader users and keyboard navigation.
**Action:** Always add `aria-label`, `title`, and explicit `focus-visible` ring styling to icon-only close buttons when creating or reviewing custom modals.
