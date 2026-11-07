import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds carry a strict Content-Security-Policy: the page may load only
// its own files and may not connect to any other server, so consumer data cannot
// be transmitted anywhere even by accident. (Not applied to the dev server, whose
// hot-reload scripts would be blocked.)
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'none'";

const cspPlugin = {
  name: 'csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

// GitHub Pages serves a project repository from /<repo-name>/.
// The deploy workflow sets BASE_PATH automatically; locally the app runs from /.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react(), cspPlugin],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
} as any);
