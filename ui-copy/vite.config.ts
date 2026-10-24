import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const originalClient = existsSync(path.join(root, 'client/src/App.tsx'))
  ? path.join(root, 'client')
  : path.resolve(root, '../client');
if (!existsSync(path.join(originalClient, 'src/App.tsx'))) {
  throw new Error('Original CODE-AI client source is required for the exact UI copy');
}

export default defineConfig({
  root,
  publicDir: path.join(originalClient, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(originalClient, 'src'),
      '@original': path.join(originalClient, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
