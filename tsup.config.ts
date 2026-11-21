import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library bundle
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    minify: false,
    external: ['node-pty'],
    // tsup supplies __dirname/__filename; its generic dynamic-require shim
    // alone cannot load the external native node-pty module from ESM.
    shims: true,
    banner: ({ format }) => format === 'esm' ? {
      js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
    } : undefined,
  },
  // PTY worker (standalone Node.js script for Bun compatibility)
  {
    entry: ['src/pty-worker.ts'],
    format: ['cjs'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    minify: false,
    external: ['node-pty'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
