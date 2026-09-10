import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isTauri = mode === 'tauri';
  const root = fileURLToPath(new URL('.', import.meta.url));
  return {
    base: './',
    resolve: {
      alias: {
        '@backend': fileURLToPath(new URL(
          isTauri ? './src/backends/tauri.ts' : './src/backends/browser.ts',
          import.meta.url,
        )),
      },
    },
    build: {
      target: ['es2020', 'safari17'],
      sourcemap: false,
      outDir: isTauri ? 'dist/native' : 'dist/web',
      emptyOutDir: true,
      rollupOptions: {
        input: 'index.html',
      },
    },
    publicDir: isTauri ? false : `${root}/web-public`,
    worker: { format: 'es' as const },
  };
});
