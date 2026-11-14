import { defineConfig } from 'astro/config';

// Static output. The API lives in /functions (Cloudflare Pages Functions), not in Astro.
export default defineConfig({
  site: 'https://axo86.pages.dev',
  output: 'static',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
