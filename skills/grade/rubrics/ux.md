# Rubric: UX, visual design and accessibility

Collections: one per experience area (screen or flow), plus **Design System**,
**Accessibility Debt** and **Deferred Polish**. Grade against the project's own design
tokens and guidelines (DESIGN.md or the theme file) where they exist.

**Accessibility is a gate.** If a keyboard or screen-reader user cannot complete a
primary flow, that is a Blocker and caps the area at **D**, however it looks.

| Dimension | What A looks like |
|---|---|
| Visual consistency | Uses the tokens for type, spacing and colour; no one-off values |
| Accessibility (WCAG 2.1 AA) | Semantic HTML, contrast, full keyboard use, visible focus, labels, reduced motion |
| Responsiveness | Works from phone to desktop; no overflow or clipping; adequate touch targets |
| Interaction and feedback | Loading, disabled, hover, focus and active states; clear affordances |
| Information architecture | Clear hierarchy, labels and wayfinding; back and forward behave |
| Content and microcopy | Clear, consistent voice; helpful empty and error messages; no placeholder text |
| Designed states | Empty, loading, error and success states are all designed (offline too where relevant) |
| Theming | Light and dark parity through tokens; no hard-coded fallbacks |

## Mechanical checks

```bash
# raw colours and sizes outside the token files
git grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' -- '*.css' '*.tsx' '*.jsx' ':(exclude)**/tokens*'
# images without alt, click handlers on non-interactive elements, positive tabindex
git grep -nP '<img(?![^>]*\balt=)' -- '*.tsx' '*.jsx'   # -P: lookahead needs PCRE
git grep -nE 'tabIndex=\{?[1-9]|<div[^>]*onClick' -- '*.tsx' '*.jsx'
```

`-E` has no lookahead: `git grep -E` rejects the pattern (exit 128), and other greps
may instead match nothing without complaint. Use `-P` for lookahead. Prove each scan can fire (point it at a known hit) before trusting
an empty result.

## When a browser is available

- Screenshot each primary screen in light AND dark mode, and prove the theme actually
  flipped (compare the images or the root class), not only that two files exist.
- Use the accessibility tree and roles to find elements, never guessed test ids.
- Watch for observation traps: a toast that hides the content, a reload that resets
  state, a screenshot taken before fonts load. Computed style beats a screenshot for
  colour questions.
- A page that needs sign-in, viewed anonymously, is reported as *blocked*, not graded.

## Human verification checklist

Static reading can't grade feel, motion or real content. Each primary flow gets a
click-through item (keyboard only, screen reader, phone width, dark mode). No area
gets an A+ without it.
