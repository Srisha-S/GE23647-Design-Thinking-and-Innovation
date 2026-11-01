import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 8000, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // Keep matching maps so Android's bundled stack locations can be traced to source.
  build: { target: 'es2022', sourcemap: 'hidden' },
});
