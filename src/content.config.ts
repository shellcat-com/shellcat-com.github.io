import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  // Markdown posts live in src/content/blog/*.md
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    // Path into /public, e.g. "/thumbnails/ssrf.png". Optional.
    heroImage: z.string().optional(),
    tags: z.array(z.string()).default([]),
    // Set draft: true to keep a post out of the build.
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
