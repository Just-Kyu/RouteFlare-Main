## 2025-04-17 - Large monolithic index.html
**Learning:** This application extensively uses SVGs and unicode characters directly inside buttons for iconography (e.g. `✕`, `⛶`), spanning a >9000-line `index.html` file.
**Action:** When working on this UI, use regex or `grep` to quickly find these inline icon instances across the large monolithic file to systematically add `aria-label`s, as they are not abstracted into components.
