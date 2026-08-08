<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bswxyz/bswxyz.github.io/main/public/screenshot.png">
    <img src="https://raw.githubusercontent.com/bswxyz/bswxyz.github.io/main/public/screenshot.png" alt="shellcat blog" width="100%">
  </picture>
</p>

<br>

# &ensp;shellcat

### &ensp;&ensp;Bug bounty write-ups. Exploit chains. Methodology.

<p align="right">
  <a href="https://bswxyz.github.io"><img src="https://img.shields.io/badge/live-bswxyz.github.io-555?style=flat-square" alt="Live"></a>
  <a href="https://github.com/bswxyz/bswxyz.github.io/actions"><img src="https://img.shields.io/github/actions/workflow/status/bswxyz/bswxyz.github.io/deploy.yml?style=flat-square&color=555" alt="Build"></a>
  <img src="https://img.shields.io/badge/built%20with-Astro-555?style=flat-square" alt="Astro">
</p>

<br>

---

### &ensp;What this is

A pseudonymous security research blog. Three posts. No padding. No SEO fluff. Every piece of content has a reason to exist — either it documents a methodology that paid out, or it captures a system that others can adapt and use.

<br>

| # | Post | |
|:---:|---|:-:|
| 3 | **The model that finds the bug will defend the bug**<br>Why AI pipelines need adversarial validation — and how to build a gate that kills 80% of false positives before you waste a single Burp request. | `Aug 2026` |
| 2 | **How I do recon**<br>Subdomain enumeration gives you a haystack. AI gives you a classifier. JS bundle mining, API surface mapping, auth topology, and hypothesis-driven recon. Includes the BBHUNTER automation tool. | `Aug 2026` |
| 1 | **Starting shellcat**<br>Why this blog exists. What goes here. The methodology transfers — the payloads don't. | `May 2026` |

<br>

---

### &ensp;Stack

```
Astro 5   ·   Zero JavaScript by default   ·   JetBrains Mono   ·   Dark theme only
```

- **Zero client JS** except the dark-mode toggle and code-copy buttons
- **View transitions** via Astro's ClientRouter — no full-page reloads
- **Monochrome palette** — near-black `#0a0a0a`, gray text `#d4d4d8` through `#5c5c66`
- **Grain texture + scanline overlay** on the body
- **RSS feed** at `/rss.xml`, sitemap at `/sitemap-index.xml`

<br>

### &ensp;Write a post

Drop a Markdown file in `src/content/blog/`:

```md
---
title: 'Your title'
description: 'One or two sentences — shown on the homepage and in the meta tag.'
pubDate: 2026-08-07
tags: ['SSRF', 'High']
---

Your content here. Code blocks get syntax highlighting and a copy button.
```

Commit and push. GitHub Actions builds and deploys.

<br>

### &ensp;Develop

```bash
npm install        # once
npm run dev        # localhost:4321 — hot-reloads
npm run build      # production build to dist/
npm run preview    # preview the built site
```

<br>

### &ensp;Anonymous by design

| Layer | What's protected |
|-------|-----------------|
| Git history | Committed as `shellcat` via GitHub noreply email — no real name |
| Site config | Pseudonymous author, no location, no email, no photo |
| Avatar | Original illustration — not reverse-image-searchable |
| Socials | GitHub + RSS only — no X, no LinkedIn, no Instagram |

No real identity anywhere in the repo, the commits, or the deployed site.

<br>

---

<p align="center">
  <sub>
    <a href="https://bswxyz.github.io">bswxyz.github.io</a>
  </sub>
</p>
