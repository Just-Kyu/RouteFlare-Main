## 2024-05-18 - Missing ARIA Labels for Icon-Only Buttons
**Learning:** This app heavily relies on raw SVG strings and Unicode characters (like ✕) directly inside <button> tags for icons.
**Action:** Always add explicit aria-label attributes to ensure accessibility for these types of buttons.
