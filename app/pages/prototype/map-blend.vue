<script setup lang="ts">
// ─────────────────────────────────────────────────────────────────────────────
// 拋棄式原型 — 不是正式程式碼,驗完就丟。
//
// 問題:在真實的 1,526 站分布下,鄰近群的「柔邊疊加」要用哪一種畫法?
// 三種畫法在 /prototype/map-blend?variant=A|B|C 之間切換,同一批真實資料。
//
// 為什麼是獨立路由而不是嵌進 index.vue:首頁的資料流是 useLiveDashboard
// 驅動的(即時/回放/xgboost 覆寫),而這題只問「像素怎麼畫」,接進那條管線
// 只會增加 demo 前弄壞首頁的風險。地圖面板寬度刻意設成規劃中的版面比例,
// 密度判斷才有參考價值。
// ─────────────────────────────────────────────────────────────────────────────

type Row = {
  id: string
  n: string
  d: string
  lat: number
  lng: number
  t: number
  b: number
  k: number
  x: 0 | 1
}

type Bucket = 'anomaly' | 'green' | 'yellow' | 'cyan' | 'orange' | 'red'

const BUCKET_COLOUR: Record<Bucket, [number, number, number]> = {
  anomaly: [156, 163, 175], // 灰 — 服務異常
  green: [34, 197, 94], // 綠 — 正常
  yellow: [234, 179, 8], // 黃 — 低於總車格一半
  cyan: [34, 211, 238], // 天青藍 — 滿柱
  orange: [249, 115, 22], // 橘 — 可借 < 2
  red: [239, 68, 68], // 紅 — 可借 = 0
}

// 由淺到深,C 畫法依此順序疊,紅色最後畫所以永遠在最上面。
const PAINT_ORDER: Bucket[] = ['anomaly', 'green', 'yellow', 'cyan', 'orange', 'red']

const BUCKET_LABEL: Record<Bucket, string> = {
  red: '紅 · 可借 0 台',
  orange: '橘 · 可借 < 2 台',
  yellow: '黃 · 低於總車格一半',
  green: '綠 · 正常',
  cyan: '天青藍 · 滿柱',
  anomaly: '灰 · 服務異常',
}

function bucketFor(s: Row): Bucket {
  if (s.x === 1) return 'anomaly'
  if (s.k === 0) return 'cyan'
  if (s.b === 0) return 'red'
  if (s.b < 2) return 'orange'
  if (s.b < s.t / 2) return 'yellow'
  return 'green'
}

const RADIUS_METRES = 500

const VARIANTS = [
  { key: 'A', name: '兩層(綠底 + 問題層)' },
  { key: 'B', name: '強度堆疊(單一色階 heatmap)' },
  { key: 'C', name: '每站獨立色 alpha 疊加' },
  { key: 'D', name: '混搭:A 的綠底 + C 的疊法' },
] as const

type VariantKey = (typeof VARIANTS)[number]['key']

const route = useRoute()
const router = useRouter()

const variant = computed<VariantKey>(() => {
  const raw = String(route.query.variant ?? 'A').toUpperCase()
  return (VARIANTS.some(v => v.key === raw) ? raw : 'A') as VariantKey
})

const rows = ref<Row[]>([])
const loadError = ref('')
const showDots = ref(true)
const asOf = ref('')

const mapElement = ref<HTMLElement | null>(null)
let leafletMap: import('leaflet').Map | null = null
let overlay: HTMLCanvasElement | null = null
let frame = 0

// ── 統計(把狀態攤出來,方便對照畫面) ───────────────────────────────────────

const tally = computed(() => {
  const counts = { red: 0, orange: 0, yellow: 0, green: 0, cyan: 0, anomaly: 0 } as Record<Bucket, number>
  for (const s of rows.value) counts[bucketFor(s)] += 1
  return counts
})

const districtStats = computed(() => {
  const map = new Map<string, { total: number; short: number }>()
  for (const s of rows.value) {
    if (s.x === 1) continue
    const entry = map.get(s.d) ?? { total: 0, short: 0 }
    entry.total += 1
    if (s.b < 2) entry.short += 1
    map.set(s.d, entry)
  }
  return [...map.entries()]
    .map(([district, v]) => ({ district, ...v, rate: v.total ? v.short / v.total : 0 }))
    .sort((a, b) => b.total - a.total)
})

// 假設檢驗的核心:密集但健康 vs 稀疏但嚴重。
const densest = computed(() => districtStats.value[0])
const sparsest = computed(() => [...districtStats.value].sort((a, b) => a.total - b.total)[0])

// ── 畫布疊圖 ────────────────────────────────────────────────────────────────

function metresPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/** 一顆柔邊圓斑。stop 由中心的 peak 透明度漸退到邊緣的 0。 */
function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rgb: [number, number, number],
  peak: number,
) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  const [rr, gg, bb] = rgb
  g.addColorStop(0, `rgba(${rr},${gg},${bb},${peak})`)
  g.addColorStop(0.55, `rgba(${rr},${gg},${bb},${peak * 0.5})`)
  g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * 依嚴重度由淺到深疊畫,清單順序就是繪製順序 —— 紅色排最後,所以永遠壓在最上面。
 * C 用完整色階,D 只用它當上層(綠色由底層負責,不重複畫)。
 */
function paintStacked(
  ctx: CanvasRenderingContext2D,
  visible: { s: Row; x: number; y: number }[],
  r: number,
  buckets: Bucket[],
  peakFor: (bucket: Bucket) => number,
) {
  const grouped = new Map<Bucket, { x: number; y: number }[]>()
  for (const { s, x, y } of visible) {
    const bucket = bucketFor(s)
    if (!buckets.includes(bucket)) continue
    const list = grouped.get(bucket) ?? []
    list.push({ x, y })
    grouped.set(bucket, list)
  }
  for (const bucket of buckets) {
    const list = grouped.get(bucket)
    if (!list) continue
    const peak = peakFor(bucket)
    for (const p of list) blob(ctx, p.x, p.y, r, BUCKET_COLOUR[bucket], peak)
  }
}

/** 所有營運中的站畫一層均勻的綠色涵蓋 —— 表達「這裡有服務」,與站況無關。 */
function paintCoverage(
  ctx: CanvasRenderingContext2D,
  visible: { s: Row; x: number; y: number }[],
  r: number,
) {
  for (const { s, x, y } of visible) {
    if (s.x === 1) continue
    blob(ctx, x, y, r, BUCKET_COLOUR.green, 0.1)
  }
}

/** B 畫法的色階:強度 0→1 對應 綠→黃→橘→紅。這是「真 heatmap」的做法。 */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0.0, [34, 197, 94]],
    [0.35, [234, 179, 8]],
    [0.65, [249, 115, 22]],
    [1.0, [239, 68, 68]],
  ]
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [p0, c0] = stops[i]!
    const [p1, c1] = stops[i + 1]!
    if (t <= p1) {
      const f = (t - p0) / (p1 - p0)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ]
    }
  }
  return stops.at(-1)![1]
}

function redraw() {
  if (!leafletMap || !overlay) return
  const map = leafletMap
  const size = map.getSize()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  if (overlay.width !== size.x * dpr || overlay.height !== size.y * dpr) {
    overlay.width = size.x * dpr
    overlay.height = size.y * dpr
    overlay.style.width = `${size.x}px`
    overlay.style.height = `${size.y}px`
  }

  const ctx = overlay.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.x, size.y)

  const zoom = map.getZoom()
  const r = RADIUS_METRES / metresPerPixel(map.getCenter().lat, zoom)
  if (r < 1) return

  // 只畫視野內(外擴一個半徑)的站,避免整批 1500 顆都算。
  const pad = r + 4
  const visible: { s: Row; x: number; y: number }[] = []
  for (const s of rows.value) {
    const p = map.latLngToContainerPoint([s.lat, s.lng])
    if (p.x < -pad || p.y < -pad || p.x > size.x + pad || p.y > size.y + pad) continue
    visible.push({ s, x: p.x, y: p.y })
  }

  if (variant.value === 'A') {
    // 兩層:底層所有營運站的綠色涵蓋,上層只有缺車站(黃與天青藍不表達)。
    ctx.globalCompositeOperation = 'source-over'
    paintCoverage(ctx, visible, r)
    for (const { s, x, y } of visible) {
      if (s.x === 1 || s.b >= 2) continue
      blob(ctx, x, y, r, s.b === 0 ? BUCKET_COLOUR.red : BUCKET_COLOUR.orange, 0.42)
    }
  } else if (variant.value === 'D') {
    // 混搭:A 的均勻綠色涵蓋當底,C 的嚴重度疊加當上層。
    // 綠色只在底層畫一次,所以健康站密集不會把底色疊深。
    ctx.globalCompositeOperation = 'source-over'
    paintCoverage(ctx, visible, r)
    paintStacked(
      ctx,
      visible,
      r,
      ['anomaly', 'yellow', 'cyan', 'orange', 'red'],
      bucket => (bucket === 'yellow' ? 0.2 : bucket === 'anomaly' ? 0.22 : 0.36),
    )
  } else if (variant.value === 'B') {
    // 強度堆疊:每站權重相同(1),用 lighter 累加成強度場,再過色階。
    // 這是 leaflet.heat 一類套件的標準做法,也是要檢驗的那個假設。
    const off = document.createElement('canvas')
    off.width = Math.ceil(size.x)
    off.height = Math.ceil(size.y)
    const octx = off.getContext('2d')
    if (!octx) return
    octx.globalCompositeOperation = 'lighter'
    for (const { s, x, y } of visible) {
      if (s.x === 1) continue
      blob(octx, x, y, r, [255, 255, 255], 0.22)
    }
    const img = octx.getImageData(0, 0, off.width, off.height)
    const px = img.data
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i]! / 255 // 累積強度
      if (a <= 0.01) {
        px[i + 3] = 0
        continue
      }
      const t = Math.min(1, a)
      const [rr, gg, bb] = ramp(t)
      px[i] = rr
      px[i + 1] = gg
      px[i + 2] = bb
      px[i + 3] = Math.round(Math.min(0.55, 0.18 + t * 0.5) * 255)
    }
    octx.putImageData(img, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(off, 0, 0, size.x, size.y)
  } else {
    // C:每站依自己狀態上色,半透明疊加,紅色最後蓋上去。綠色也會互相疊。
    ctx.globalCompositeOperation = 'source-over'
    paintStacked(
      ctx,
      visible,
      r,
      PAINT_ORDER,
      bucket => (bucket === 'green' ? 0.14 : bucket === 'yellow' ? 0.2 : 0.34),
    )
  }

  if (showDots.value) {
    ctx.globalCompositeOperation = 'source-over'
    for (const { s, x, y } of visible) {
      const [rr, gg, bb] = BUCKET_COLOUR[bucketFor(s)]
      ctx.fillStyle = `rgba(${rr},${gg},${bb},.95)`
      ctx.strokeStyle = 'rgba(255,255,255,.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
}

function scheduleRedraw() {
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = 0
    redraw()
  })
}

// ── 快速跳點:密集區 vs 稀疏區,正好對應要驗的假設 ──────────────────────────

const JUMPS = [
  { label: '全新北', center: [25.0, 121.55] as [number, number], zoom: 11 },
  { label: '板橋(最密集 216 站)', center: [25.0118, 121.4628] as [number, number], zoom: 14 },
  { label: '三重(134 站)', center: [25.0616, 121.4877] as [number, number], zoom: 14 },
  { label: '平溪 · 雙溪(最稀疏)', center: [25.0246, 121.7245] as [number, number], zoom: 13 },
]

function jump(to: (typeof JUMPS)[number]) {
  leafletMap?.setView(to.center, to.zoom)
}

// ── 變體切換 ────────────────────────────────────────────────────────────────

function goToVariant(key: VariantKey) {
  router.replace({ query: { ...route.query, variant: key } })
}

function cycle(step: number) {
  const index = VARIANTS.findIndex(v => v.key === variant.value)
  const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!
  goToVariant(next.key)
}

function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
  if (target?.isContentEditable) return
  if (event.key === 'ArrowLeft') cycle(-1)
  if (event.key === 'ArrowRight') cycle(1)
}

watch(variant, scheduleRedraw)
watch(showDots, scheduleRedraw)

onMounted(async () => {
  window.addEventListener('keydown', onKey)

  try {
    const payload = await $fetch<{ asOf: string; stations: Row[] }>('/data/prototype-stations.json')
    rows.value = payload.stations
    asOf.value = payload.asOf
  } catch {
    loadError.value = '讀不到 /data/prototype-stations.json'
    return
  }

  if (!mapElement.value) return
  const leaflet = await import('leaflet')
  leafletMap = leaflet.map(mapElement.value, {
    attributionControl: false,
    scrollWheelZoom: true,
    zoomControl: true,
    minZoom: 9,
    maxZoom: 18,
  }).setView([25.0, 121.55], 11)

  leaflet.control.attribution({ position: 'bottomright', prefix: false }).addTo(leafletMap)
  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(leafletMap)

  overlay = document.createElement('canvas')
  overlay.style.position = 'absolute'
  overlay.style.inset = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = '450'
  mapElement.value.appendChild(overlay)

  leafletMap.on('move zoom resize zoomend moveend', scheduleRedraw)
  scheduleRedraw()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (frame) cancelAnimationFrame(frame)
  leafletMap?.remove()
  leafletMap = null
})

const currentVariant = computed(() => VARIANTS.find(v => v.key === variant.value)!)

// 切換列只在開發模式出現,萬一這支原型被誤 merge 也不會出現在正式站。
const isDev = import.meta.dev
</script>

<template>
  <div class="min-h-svh bg-canvas p-4 text-ink">
    <header class="mb-3">
      <p class="text-xs tracking-widest text-accent uppercase">拋棄式原型 · 驗完即丟</p>
      <h1 class="text-xl font-semibold">鄰近群疊加渲染對照</h1>
      <p class="mt-1 text-sm text-muted">
        半徑 {{ RADIUS_METRES }} m · {{ rows.length }} 站真實快照({{ asOf.slice(0, 16).replace('T', ' ') }})·
        淺色 OSM 底圖 · 用 ← → 或下方切換列換畫法
      </p>
    </header>

    <p v-if="loadError" class="rounded border border-danger bg-danger-surface p-3 text-sm">
      {{ loadError }}
    </p>

    <div class="grid gap-3 lg:grid-cols-[1fr_22rem]">
      <!-- 地圖面板寬度刻意接近規劃中的首頁比例,密度判斷才有意義 -->
      <section class="rounded-lg border border-line bg-panel p-3">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <button
            v-for="j in JUMPS" :key="j.label" type="button"
            class="rounded border border-line px-2 py-1 text-xs hover:border-accent"
            @click="jump(j)"
          >
            {{ j.label }}
          </button>
          <label class="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <input v-model="showDots" type="checkbox" class="accent-accent"> 顯示站點圓點
          </label>
        </div>
        <div ref="mapElement" class="relative h-[68svh] w-full overflow-hidden rounded bg-map" />
      </section>

      <aside class="flex flex-col gap-3">
        <section class="rounded-lg border border-line bg-panel p-3">
          <h2 class="mb-2 text-sm font-semibold">目前畫法</h2>
          <p class="text-lg font-semibold text-accent">{{ currentVariant.key }}</p>
          <p class="text-sm text-muted">{{ currentVariant.name }}</p>
        </section>

        <section class="rounded-lg border border-line bg-panel p-3">
          <h2 class="mb-2 text-sm font-semibold">站況分布</h2>
          <ul class="space-y-1 text-sm">
            <li v-for="b in PAINT_ORDER.slice().reverse()" :key="b" class="flex items-center gap-2">
              <span
                class="inline-block h-3 w-3 shrink-0 rounded-full"
                :style="{ background: `rgb(${BUCKET_COLOUR[b].join(',')})` }"
              />
              <span class="flex-1 text-muted">{{ BUCKET_LABEL[b] }}</span>
              <span class="tabular-nums">{{ tally[b] }}</span>
            </li>
          </ul>
        </section>

        <section class="rounded-lg border border-line bg-panel p-3">
          <h2 class="mb-1 text-sm font-semibold">假設檢驗</h2>
          <p class="mb-2 text-xs text-muted">
            B 畫法若成立,密集而健康的區會比稀疏而嚴重的區更紅 —— 那就是說謊。
          </p>
          <dl v-if="densest && sparsest" class="space-y-1.5 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-muted">最密集 · {{ densest.district }}</dt>
              <dd class="tabular-nums">
                {{ densest.total }} 站 / 缺車 {{ densest.short }}
                <span class="text-muted">({{ (densest.rate * 100).toFixed(0) }}%)</span>
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted">最稀疏 · {{ sparsest.district }}</dt>
              <dd class="tabular-nums">
                {{ sparsest.total }} 站 / 缺車 {{ sparsest.short }}
                <span class="text-muted">({{ (sparsest.rate * 100).toFixed(0) }}%)</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="rounded-lg border border-line bg-panel p-3">
          <h2 class="mb-2 text-sm font-semibold">各區缺車率</h2>
          <ul class="max-h-56 space-y-1 overflow-y-auto pr-1 text-xs">
            <li v-for="d in districtStats" :key="d.district" class="flex items-center gap-2">
              <span class="w-14 shrink-0 text-muted">{{ d.district }}</span>
              <span class="h-1.5 flex-1 rounded bg-panel-muted">
                <span class="block h-full rounded bg-danger" :style="{ width: `${d.rate * 100}%` }" />
              </span>
              <span class="w-16 shrink-0 text-right tabular-nums text-muted">
                {{ d.short }}/{{ d.total }}
              </span>
            </li>
          </ul>
        </section>
      </aside>
    </div>

    <!-- 浮動切換列 —— 刻意做成跟頁面不同調,不要當成設計的一部分 -->
    <div
      v-if="isDev"
      class="fixed bottom-4 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-1 rounded-full bg-white px-1.5 py-1.5 text-black shadow-2xl ring-2 ring-black/20"
    >
      <button type="button" class="rounded-full px-3 py-1 text-lg leading-none hover:bg-black/10" @click="cycle(-1)">
        ←
      </button>
      <span class="min-w-56 px-2 text-center text-sm font-semibold">
        {{ currentVariant.key }} · {{ currentVariant.name }}
      </span>
      <button type="button" class="rounded-full px-3 py-1 text-lg leading-none hover:bg-black/10" @click="cycle(1)">
        →
      </button>
    </div>
  </div>
</template>
