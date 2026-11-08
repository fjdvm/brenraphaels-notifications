import { build } from 'esbuild';
await build({
  entryPoints: ['src/node/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  loader: { '.html': 'text' },
  alias: { 'worker-mailer': './src/node/mailer.ts' },
});
