// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Live URL — GitHub Pages user site. Change if you move to a custom domain.
  site: 'https://bswxyz.github.io',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      // Code-block syntax highlighting theme (matches the dark UI).
      theme: 'github-dark-default',
      wrap: true,
    },
  },
});
