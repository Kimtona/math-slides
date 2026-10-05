import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    include: ['mathjax-full/js/mathjax.js', 'mathjax-full/js/input/tex.js', 'mathjax-full/js/output/svg.js',
      'mathjax-full/js/adaptors/liteAdaptor.js', 'mathjax-full/js/handlers/html.js', 'mathjax-full/js/input/tex/AllPackages.js'],
  },
  build: { chunkSizeWarningLimit: 4000 },
});
