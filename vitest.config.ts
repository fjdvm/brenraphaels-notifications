import { defineConfig } from 'vitest/config';

// wrangler bundles .html as text; vite needs telling the same.
const htmlAsText = {
  name: 'html-as-text',
  transform(code: string, id: string) {
    if (id.endsWith('.html'))
      return { code: `export default ${JSON.stringify(code)}`, map: null };
  },
};

export default defineConfig({
  plugins: [htmlAsText],
  test: {
    globals: true,
    include: ['test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
