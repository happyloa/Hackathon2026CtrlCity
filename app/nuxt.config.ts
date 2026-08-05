export default defineNuxtConfig({
  srcDir: '.',
  compatibilityDate: '2026-08-05',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'YouBike 調度雷達',
      meta: [
        { name: 'description', content: '新北市公共自行車營運調度數據視覺化及預測模型' },
        { name: 'theme-color', content: '#071b28' },
      ],
      link: [
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
      productName: 'YouBike 調度雷達',
      dataMode: process.env.DATA_MODE || 'live',
    },
  },
  nitro: {
    prerender: {
      autoSubfolderIndex: false,
    },
  },
})
