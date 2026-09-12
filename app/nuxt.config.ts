import tailwindcss from '@tailwindcss/vite'

const liveFeedPath = '/api/datasets/010e5b15-3823-4b20-b401-b1cf000550c5/json?page=0&size=2000'

export default defineNuxtConfig({
  ssr: false,
  srcDir: '.',
  compatibilityDate: '2026-08-05',
  devtools: { enabled: true },
  css: ['leaflet/dist/leaflet.css', '~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
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
      title: '新北市 YouBike 營運工作台',
      meta: [
        { name: 'description', content: '掌握即時站況、未來風險與多站搬運路線' },
        { name: 'theme-color', content: '#09090b' },
      ],
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
      // Not linked from the sidebar, so the link crawler (starting at "/")
      // never discovers them on its own — list them explicitly.
      routes: ['/admin/roi', '/admin/adjustments', '/design-system'],
    },
  },
})
