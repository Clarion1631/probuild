## 2025-06-13 - Dynamic Import for Heavy Client Libraries
**Learning:** Recharts is a heavy charting library. Including Recharts components statically in Next.js Server or Client Components can cause SSR issues and block the main thread during hydration, negatively impacting Time to First Byte (TTFB) and initial load performance.
**Action:** When a component relies on heavy client-side libraries like `recharts` (or others like `tiptap`, `three`), dynamically import them using `next/dynamic` with `ssr: false` and a loading placeholder skeleton.
