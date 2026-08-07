# shellcat — design constraints

## Hard rules (do NOT break)

- **Font**: JetBrains Mono only. Everything. Body, headings, UI, code. One font family. Never any other font.
- **Color**: Monochrome. No accent color. Near-black bg (#0a0a0a), gray text (#d4d4d8 through #5c5c66). Links are subtle dim→bright on hover. The only "color" is restraint.
- **Layout**: Header → content → footer. No hero sections. No centered anything. No tag filters, no chips, no stats counters.
- **Homepage**: Ordered list of entries. Each entry = thumbnail (optional) + date + title + 1-2 line description + "Read →". Like brutecat.com.
- **About page**: Under 100 words. Avatar + name + 2 paragraphs max. Sparse.
- **Decoration**: Grain texture overlay + subtle scanlines on body. Nothing else. No progress bar, no back-to-top button, no scroll handlers, no TOC.
- **Motion**: None beyond CSS hover transitions (color shift only). No scroll reveals, no view-transition animations beyond default.
- **Content**: PC or GTFO. Proof before polish.

## Aesthetic reference
brutecat.com — monochrome, JetBrains Mono, numbered entries with thumbnails, grain+scanline texture, zero decoration. Pure content.

## What "AI slop" means here (avoid ALL)
- Any color accent (green, purple, blue, anything)
- Hero sections / kickers / taglines
- Multiple font families
- Card grids with hover zoom
- Gradient borders or backgrounds
- Scroll-reveal or fade animations
- Progress bars, back-to-top buttons
- Emoji icons
- "Modern blog design"
