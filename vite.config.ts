import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { publicConfigGuard } from './src/build/public-config-guard';
import {
  selectProductionConnectedProfile,
  productionGenerationQueueConfiguration,
  validateProductionReleasePublicValues,
} from './src/build/production-connected-deployment';

const isReleaseBuild = ['staging', 'production', 'demo'].includes(
  process.env.MANGA_NIKKI_RELEASE_TARGET ?? '',
);
const isConnectedProductionBuild = process.env.MANGA_NIKKI_RELEASE_TARGET === 'production';
const productionProfile = selectProductionConnectedProfile(
  process.env.PRODUCTION_GENERATION_INFRA_ENABLED,
  process.env.PRODUCTION_GENERATION_ENABLED,
);
const isPlaywrightE2e = process.env.MANGA_NIKKI_E2E === '1';

export default defineConfig({
  envDir: isReleaseBuild ? false : undefined,
  cacheDir: isPlaywrightE2e ? 'node_modules/.vite-e2e' : undefined,
  plugins: [
    publicConfigGuard(),
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
        background_color: '#f5f5fb',
        theme_color: '#f5f5fb',
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
    cloudflare(
      isReleaseBuild
        ? {
            config: (workerConfig) => {
              const secrets = {
                required: isConnectedProductionBuild
                  ? [...(productionProfile.requiredSecretBindings ?? [])]
                  : [],
              };
              if (!isConnectedProductionBuild) return { secrets };

              const { workerPublicVars } = validateProductionReleasePublicValues({
                VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
                VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
                VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY,
              });
              return {
                vars: {
                  ...(workerConfig.vars ?? {}),
                  ...workerPublicVars,
                  GENERATION_ENABLED: String(productionProfile.generationEnabled ?? false),
                },
                ...(productionProfile.queueName
                  ? {
                      queues: productionGenerationQueueConfiguration(productionProfile.queueName),
                      // Vite pluginは配列を連結するため、Wranglerにある日次Cronは重ねない。
                      triggers: { crons: ['* * * * *'] },
                    }
                  : {}),
                secrets,
              };
            },
          }
        : undefined,
    ),
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
