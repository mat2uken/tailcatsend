import { fileURLToPath } from 'node:url';
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
      target: 'es2018',
      minify: 'esbuild',
      sourcemap: false,
      cssMinify: true,
      outDir: isTauri ? 'dist/native' : 'dist/web',
      emptyOutDir: true,
      rollupOptions: {
        input: 'index.html',
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    publicDir: isTauri ? false : `${root}/web-public`,
    server: {
      port: 3000,
      open: false,
    },
    worker: { format: 'es' },
  };
});
