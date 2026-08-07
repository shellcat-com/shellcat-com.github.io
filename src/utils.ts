import type { CollectionEntry } from 'astro:content';

/** ~220 wpm reading-time estimate from a post's raw markdown body. */
export function readingTime(body = ''): string {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

/** kebab-case slug for tags/filters. */
export function slugify(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Published posts, newest first. */
export function byNewest(a: CollectionEntry<'blog'>, b: CollectionEntry<'blog'>): number {
  return b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
}
