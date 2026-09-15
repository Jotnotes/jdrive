import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development this is a separate server on 5173 and the box is on 9990. In
// production there is one origin: the box serves this build itself, so none of
// these proxies exist and no path here can be reached from somewhere else.
//
// The regular-expression keys matter. A plain vite proxy key is a prefix, so
// '/p' would also swallow '/password-reset' and hand it to the API, which
// answers a 404 and reads as the page being broken rather than as the proxy
// being wrong about what a path is.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT || 5173),
    proxy: (() => {
      const box = process.env.JDRIVE_API || 'http://127.0.0.1:9990';
      return {
        '/api': box,
        '^/p/': box,      // a published file
        '^/s/': box,      // a share link
        '^/brand': box,   // the hosting company's logo and app icon
        '/health': box,
      };
    })(),
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
