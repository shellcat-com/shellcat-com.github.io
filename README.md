# shellcat

Personal bug-bounty / security-research blog. Dark, minimal, fast — built with
[Astro](https://astro.build) and deployed to GitHub Pages.

**Live:** https://bswxyz.github.io

## Writing a new post

Drop a Markdown file in `src/content/blog/`. Frontmatter:

```md
---
title: 'Your title'
description: 'One or two sentences shown on the homepage card + meta description.'
pubDate: 2026-08-07
heroImage: '/thumbnails/your-image.png'   # optional; put the file in public/thumbnails/
tags: ['SSRF', 'High']                    # optional; 'critical'/'rce'/'ato' render red, 'ssrf'/'idor'/'sqli'/'high' render amber
draft: false                              # set true to keep it out of the build
---

Your Markdown here. Code blocks are syntax-highlighted automatically.
```

That's it — commit and push, and the site rebuilds and redeploys itself.

## Commands

| Command           | Action                                    |
| ----------------- | ----------------------------------------- |
| `npm install`     | Install dependencies                      |
| `npm run dev`     | Local dev server at `localhost:4321`      |
| `npm run build`   | Build the production site to `./dist/`    |
| `npm run preview` | Preview the built site locally            |

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds with
`withastro/action` and publishes to GitHub Pages. No manual steps.

## Branding & config

Edit `src/consts.ts` to change the site title, tagline, description, and social
links. Swap the mascot at `public/avatar.png`, the social-share image at
`public/og/og-default.png`, and the favicon at `public/favicon.svg`.

## A note on anonymity

This repo is intentionally pseudonymous. Commits are authored as `shellcat` via a
GitHub noreply email — no real name or personal email in the history. The avatar is
an original illustration, not a photo, so it can't be reverse-image-searched. Keep
it that way: don't commit with your real git identity, and don't add a real name,
email, or location to `src/consts.ts` or any post.
