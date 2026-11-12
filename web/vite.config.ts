import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// The page version must equal the backend __version__ (hello_ok reload guard).
// Order: BLOB_VERSION env, then backend/blob/__init__.py, then a dev marker.
function pageVersion(): string {
  if (process.env.BLOB_VERSION) return process.env.BLOB_VERSION;
  try {
    const src = readFileSync(new URL('../backend/blob/__init__.py', import.meta.url), 'utf8');
    const m = /__version__\s*=\s*["']([^"']+)["']/.exec(src);
    if (m) return m[1];
  } catch {
    // backend not present in this checkout
  }
  return '0.0.0-dev';
}

const backend = process.env.BLOB_BACKEND ?? 'http://localhost:8000';
const proxied = ['/device-config', '/healthz', '/readyz', '/alerts'];

export default defineConfig({
  define: { __BLOB_VERSION__: JSON.stringify(pageVersion()) },
  server: {
    proxy: {
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
      ...Object.fromEntries(proxied.map((p) => [p, backend])),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
