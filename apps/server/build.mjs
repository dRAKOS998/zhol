// Bundles the server and the workspace packages (TypeScript sources) into dist/index.js.
// Third-party runtime dependencies stay external and are installed from package.json.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', 'express', 'socket.io', 'zod'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
