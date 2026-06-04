## 2024-06-04 - Adding ARIA label to reusable Btn in SelectionCadBar
**Learning:** Reusable inner components like `Btn` in `SelectionCadBar.tsx` might omit important accessibility props such as `aria-label`, even if they handle `title` correctly for hover tooltips. Adding `aria-label={title}` allows these icon-only buttons to be properly announced by screen readers without any visual impact.
**Action:** When inspecting inner UI components handling icons, always check if the tooltip text (`title`) can be forwarded to `aria-label`.
