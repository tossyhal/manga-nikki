import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const isReleaseBuild = ['staging', 'production'].includes(
  process.env.MANGA_NIKKI_RELEASE_TARGET ?? '',
);

export default defineConfig({
  envDir: isReleaseBuild ? false : undefined,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        id: '/',
        name: '漫画日記',
        short_name: '漫画日記',
        description: '小さな一日を、漫画で残す日記アプリ',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fafbf7',
        theme_color: '#24352b',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['index.html', 'assets/**/*.{js,css}', 'sample-comic.svg'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        skipWaiting: false,
        clientsClaim: false,
      },
    }),
    cloudflare(isReleaseBuild ? { config: { secrets: { required: [] } } } : undefined),
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
