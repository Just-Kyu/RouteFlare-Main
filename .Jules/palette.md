## 2024-05-19 - Initial Learnings
**Learning:** The application uses pure HTML/JS without modern frameworks. The UI relies heavily on raw SVG strings for icons, especially within button tags. There are several icon-only buttons that are missing `aria-label` attributes for accessibility.
**Action:** Focus on adding `aria-label` to icon-only buttons to improve accessibility, as per the guidelines. Use search and replace to target specific `<button>` elements that only contain `<svg>` tags.
