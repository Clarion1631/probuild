## 2024-06-13 - Added ARIA Labels to Icon-Only Buttons in EntityContractsClient
**Learning:** Found multiple instances where interactive icon buttons (using SVGs or symbols like '×') lacked descriptive `aria-label` attributes, which impairs screen reader usability and accessibility.
**Action:** Always verify that every interactive button lacking visible text has a clear and descriptive `aria-label` (e.g., 'Close creator', 'Close draft panel') to maintain high accessibility standards.
