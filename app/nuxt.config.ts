const liveFeedPath = '/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

export default defineNuxtConfig({
  ssr: false,
  srcDir: '.',
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
        { name: 'theme-color', content: '#f5f5f1' },
      ],
      script: [{
        id: 'theme-init',
        innerHTML: `(function(){try{var saved=localStorage.getItem('yb-ops-theme');var dark=saved==='dark'||(!saved&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=dark?'dark':'light';document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#151517':'#f5f5f1')}catch(_){}})()`,
      }],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      liveStationsEndpoint: process.env.NUXT_PUBLIC_LIVE_STATIONS_ENDPOINT || '/api/v1/live-stations',
      agentEnabled: process.env.NUXT_PUBLIC_AGENT_ENABLED === 'true',
      agentReviewEndpoint: process.env.NUXT_PUBLIC_AGENT_REVIEW_ENDPOINT || '/api/v1/agent-review',
    },
  },
  nitro: {
    prerender: {
      autoSubfolderIndex: false,
    },
  },
})
