const liveFeedPath = '/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

export default defineNuxtConfig({
  ssr: false,
  srcDir: '.',
  // Pages uses the standalone `functions/` directory. The legacy Nuxt API tree
  // is intentionally excluded in every mode so the 14 MB build artifact is not
  // imported into local dev or the edge bundle.
  serverDir: '.pages-static-no-server',
  compatibilityDate: '2026-08-05',
  devtools: { enabled: true },
  css: ['leaflet/dist/leaflet.css', '~/assets/css/main.css'],
  vite: {
    server: {
      proxy: {
        '/api/v1/live-stations': {
          target: 'https://data.ntpc.gov.tw',
          changeOrigin: true,
          rewrite: () => liveFeedPath,
        },
      },
    },
  },
  app: {
    head: {
      title: '新北市 YouBike 調度工作台',
      meta: [
        { name: 'description', content: '新北市公共自行車站點庫存、風險與調度決策支援' },
        { name: 'theme-color', content: '#1d2926' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+TC:wght@400;500;600;700&display=swap' },
      ],
    },
  },
  runtimeConfig: {
    appMode: process.env.APP_MODE || 'local',
    dataBackend: process.env.DATA_BACKEND || 'filesystem',
    narrativeProvider: process.env.GENAI_BACKEND || 'template',
    awsRegion: process.env.AWS_REGION || '',
    bedrockModelId: process.env.BEDROCK_MODEL_ID || '',
    liveFeedUrl: process.env.LIVE_FEED_URL || 'https://data.ntpc.gov.tw/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000',
    public: {
      productName: '新北市 YouBike 調度工作台',
      dataMode: process.env.DATA_MODE || 'live',
    },
  },
  nitro: {
    prerender: {
      autoSubfolderIndex: false,
    },
  },
})
