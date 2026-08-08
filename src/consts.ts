// ─────────────────────────────────────────────────────────────
//  Central site config. Edit these to change branding everywhere.
// ─────────────────────────────────────────────────────────────

export const SITE = {
  /** Brand / stage name shown in the header wordmark and titles. */
  title: 'shellcat',
  /** Short line under the name on the homepage. */
  tagline: 'bug bounty hunter — web & cloud security research',
  /** Used for <meta description> and RSS. */
  description:
    'Security research, bug bounty write-ups, and exploit notes by shellcat.',
  /** Must match `site` in astro.config.mjs (no trailing slash). */
  url: 'https://shellcat-com.github.io',
  /** Pseudonymous author name. No real name — kept for anonymity. */
  author: 'shellcat',
  /** Handle shown in the About page. */
  handle: '@shellcat',
  /** Default social-share image (Higgsfield-generated). */
  ogImage: '/og/og-default.png',
};

// Social links shown in the header + footer.
// GitHub + RSS are live. Add your own X/Mastodon/email when ready —
// left out on purpose so nothing links to an account that isn't yours.
export const SOCIALS: { name: 'github' | 'x' | 'rss'; label: string; href: string }[] = [
  { name: 'github', label: 'GitHub', href: 'https://github.com/shellcat-com' },
  { name: 'rss', label: 'RSS', href: '/rss.xml' },
  // { name: 'x', label: 'X', href: 'https://x.com/YOUR_HANDLE' },
];

/** Posts per page could go here later; kept minimal for now. */
export const NAV = [
  { label: 'writing', href: '/' },
  { label: 'about', href: '/about' },
];
