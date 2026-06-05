## 2024-05-18 - Heavy Component Initialization Blocking Paint
**Learning:** Initializing heavy visualization libraries (like `Recharts`) statically on the client causes blocking that delays First Contentful Paint.
**Action:** When a page has complex, large visualization libraries (like Recharts) that are not immediately necessary for the core structural rendering, utilize `next/dynamic` with `ssr: false` to move them off the critical rendering path.
