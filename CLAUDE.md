# shellcat — design constraints

## Hard rules (do NOT break)

- **Fonts**: JetBrains Mono for headings, UI, code. System sans-serif stack for body. Never Fraunces, Inter, Roboto, or any display serif.
- **Layout**: Asymmetric, left-aligned. Content-first. No centered hero blurbs.
- **Color**: One accent (green #6fe79f) + neutrals on dark. No purple gradients. No neon. No gradient borders.
- **Motion**: Never scroll-reveal animations. Never decorative transitions. Keep: reading progress, sticky header blur, back-to-top, hover color shifts.
- **Decoration**: Never aurora blobs, gradient mesh, floating orbs, or decorative WebGL. Subtle noise texture on body is the only background treatment.
- **Cards**: Dense text rows, not image-forward card grids. Thumbnails optional. Hover = underline or color shift only.
- **Terminal**: Static `<pre>` block, not animated typing. It's a design element, not a gimmick.
- **Content**: PC or GTFO. Proof before polish.

## Aesthetic reference
Brutalist-adjacent. Hacker with taste. Think: Project Zero, lcamtuf, daniel.haxx.se — not Linear, not Stripe, not Vercel templates.

## What "AI slop" means here (avoid ALL)
- Inter as primary/display font
- Purple/neon gradient on white or dark
- Centered hero → logo bar → 3-column features → pricing cards layout
- Scroll-reveal animations (fade-up, fade-left, scale)
- Animated gradient borders on hover
- Emoji icons
- "Modern, clean" aesthetic
