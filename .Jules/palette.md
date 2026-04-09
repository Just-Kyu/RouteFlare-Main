## 2024-05-24 - Interactive Div Accessibility
**Learning:** In a single-file application with inline handlers, interactive `div` elements (like theme toggles) need explicit `role="button"`, `tabindex="0"`, and keydown handlers (listening for 'Enter' or ' ') to be fully accessible to keyboard users.
**Action:** When adding accessibility to interactive non-button elements, always ensure keyboard navigation (Space/Enter) is supported alongside ARIA labels.
