<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { SLOT_OPTIONS, WEEKDAY_OPTIONS, useOperationalRoi } from '~/composables/useOperationalRoi'
import type { RoiMapPoint } from '~/components/RoiMap.client.vue'
import forecastEvaluation from '~/data/forecast-evaluation.json'
import modelEvaluation from '~/data/model-evaluation.json'

const route = useRoute()
const router = useRouter()
const {
  meta,
  weekdayNames,
  districtOptions,
  stationsForDistrict,
  cell,
  daySeries,
  weekSeries,
  scope,
  loadWeekday,
  loadAllWeekdays,
  stationCell,
  stationDaySeries,
  stationWeekSeries,
  shardLoading,
  shardError,
  loadStationDetail,
  stationDetailRecords,
  detailLoading,
  detailMissing,
} = useOperationalRoi()

const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')
const selectedWeekday = ref(typeof route.query.weekday === 'string' ? route.query.weekday : '1')
const selectedSlot = ref(typeof route.query.slot === 'string' ? route.query.slot : '16')
const selectedStationId = ref(typeof route.query.station === 'string' ? route.query.station : '')
const mapMetric = ref<'emptyRate' | 'fullRate'>('emptyRate')
const hoveredSlot = ref<number | null>(null)

const weekday = computed(() => Number(selectedWeekday.value))
const slot = computed(() => Number(selectedSlot.value))

const districtStations = computed(() => stationsForDistrict(selectedDistrict.value))
const stationOptions = computed(() => [
  { value: '', label: `全部站點（${districtStations.value.length} 站）` },
  ...districtStations.value.map(entry => ({ value: entry.station.id, label: entry.station.name })),
])

const selectedStation = computed(() =>
  districtStations.value.find(entry => entry.station.id === selectedStationId.value) ?? null)

// A chosen station overrides the district aggregate everywhere on the page.
const current = computed(() => selectedStation.value
  ? stationCell(selectedStation.value.index, weekday.value, slot.value)
  : cell(selectedDistrict.value, weekday.value, slot.value))

const day = computed(() => selectedStation.value
  ? stationDaySeries(selectedStation.value.index, weekday.value)
  : daySeries(selectedDistrict.value, weekday.value))

const week = computed(() => selectedStation.value
  ? stationWeekSeries(selectedStation.value.index, slot.value)
  : weekSeries(selectedDistrict.value, slot.value))

const activeScope = computed(() => scope(selectedDistrict.value))
const scopeLabel = computed(() => selectedStation.value
  ? `${selectedStation.value.station.district} ${selectedStation.value.station.name}`
  : (activeScope.value?.label ?? '全部行政區'))

const mapPoints = computed<RoiMapPoint[]>(() => districtStations.value.map(entry => ({
  station: entry.station,
  index: entry.index,
  cell: stationCell(entry.index, weekday.value, slot.value),
})))

const slotLabel = computed(() => SLOT_OPTIONS[slot.value]?.label ?? '')
const percent = (value: number) => `${(value * 100).toFixed(1)}%`

/**
 * The rule-baseline F1 is the 6-month held-out test evaluation (60min), fixed
 * to the PoC success criterion. It only breaks down by district (not by
 * weekday/slot, and not by individual station -- a single station's monthly
 * sample is too small for a stable P/R/F1 read) -- picking a district swaps
 * in that district's own confusion matrix; clearing it falls back to the
 * all-station number.
 */
type BaselineHorizonMetrics = { tp: number, fp: number, fn: number, tn: number, precision: number, recall: number, f1: number }
const byDistrictLookup = forecastEvaluation.test?.byDistrict as
  Record<string, { stationCount: number, horizons: Record<string, BaselineHorizonMetrics> }> | undefined

const baselineF1 = computed(() => {
  const byDistrict = selectedDistrict.value
    ? byDistrictLookup?.[selectedDistrict.value]?.horizons?.['60']
    : null
  const horizon = byDistrict ?? forecastEvaluation.test?.horizons?.['60']?.inventoryIssue
  if (!horizon) return null
  return {
    precision: horizon.precision,
    recall: horizon.recall,
    f1: horizon.f1,
    samples: horizon.tp + horizon.fp + horizon.fn + horizon.tn,
    scoped: Boolean(byDistrict),
  }
})

/**
 * Model F1 comes from the Step 7 XGBoost held-out test evaluation
 * (ml/src/evaluate.py -> app/data/model-evaluation.json). Unlike the rule
 * baseline, this has not been broken down by district/station yet (see
 * model-evaluation.json's `limitations`), so all three horizons show the
 * same all-cohort number regardless of the pickers above until a per-scope
 * evaluation pipeline exists.
 */
type ModelF1Metrics = { f1: number, precision: number, recall: number }
const modelF1Horizons = [30, 60, 120] as const
const modelF1Rows = computed(() => modelF1Horizons.map((horizon) => {
  const metrics = (modelEvaluation.test?.horizons as Record<string, ModelF1Metrics> | undefined)?.[String(horizon)]
  return { horizon, metrics: metrics ?? null }
}))

const dayPeak = computed(() => {
  let best = -1
  let index = -1
  day.value.forEach((item, position) => {
    if (item && item.emptyRate > best) { best = item.emptyRate; index = position }
  })
  return index >= 0 ? { label: SLOT_OPTIONS[index]!.label, rate: best } : null
})

/**
 * Empty and full are plotted as separate rows with independent scales.
 * A shared scale flattens the full row into a one-pixel sliver — system-wide
 * shortages outnumber overflows about nine to one — which makes a genuinely
 * rare 0% indistinguishable from a broken statistic. Each row states its own
 * peak so the differing scales are never implied to be comparable.
 */
const dayRows = computed(() => ([
  { key: 'emptyRate' as const, label: '缺車率', barClass: 'bg-danger' },
  { key: 'fullRate' as const, label: '滿柱率', barClass: 'bg-warning' },
]).map((row) => {
  const values = day.value.map(item => item?.[row.key] ?? 0)
  const peak = Math.max(...values)
  const peakIndex = values.indexOf(peak)
  return {
    ...row,
    values,
    // A flat-zero row would otherwise divide by zero and render full-height bars.
    scale: Math.max(peak, 0.001),
    peak,
    peakLabel: peak > 0 ? SLOT_OPTIONS[peakIndex]?.label ?? '' : '',
  }
}))

/**
 * The readout is rendered outside the horizontally scrolling chart, because an
 * absolutely positioned tooltip inside an `overflow-x-auto` container gets
 * clipped at the container edge.
 */
const readoutSlot = computed(() => hoveredSlot.value ?? slot.value)
const readout = computed(() => ({
  label: SLOT_OPTIONS[readoutSlot.value]?.label ?? '',
  cell: day.value[readoutSlot.value] ?? null,
  isHover: hoveredSlot.value !== null,
}))

// Clearing a station that is not in the newly chosen district keeps the picker
// and the map from disagreeing.
watch(selectedDistrict, () => {
  if (selectedStationId.value && !selectedStation.value) selectedStationId.value = ''
})

// A single station's week comparison spans every weekday, so pull the rest of
// the shards once one is chosen. This must also run for a station restored from
// the URL, otherwise a reload leaves every other weekday blank.
watch(selectedStationId, (stationId) => {
  if (!stationId) return
  void loadAllWeekdays()
  void loadStationDetail(stationId)
}, { immediate: true })

const detailRecords = computed(() => selectedStation.value
  ? stationDetailRecords(selectedStation.value.station.id, weekday.value, slot.value)
  : [])

watch(weekday, value => void loadWeekday(value), { immediate: true })
onMounted(() => void loadWeekday(weekday.value))

watch([selectedDistrict, selectedWeekday, selectedSlot, selectedStationId], () => {
  if (!import.meta.client) return
  const query: Record<string, string> = { weekday: selectedWeekday.value, slot: selectedSlot.value }
  if (selectedDistrict.value) query.district = selectedDistrict.value
  if (selectedStationId.value) query.station = selectedStationId.value
  void router.replace({ query })
})
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <!-- F1 Dashboard -->
    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="min-w-0">
        <h2 class="m-0 text-xl font-bold">預測品質 F1 對照</h2>
        <p class="mt-1 text-base leading-6 text-muted">
          規則基線是固定目標值（6月保留測試集，不受下方篩選影響）；模型 F1 依所選時段與範圍換算，待 XGBoost 完成後顯示。
        </p>
      </div>

      <div v-if="baselineF1" class="mt-4">
        <h3 class="m-0 text-base font-bold text-muted">
          規則基線{{ baselineF1.scoped ? `（${selectedDistrict}）` : '（全站）' }} · 60分鐘 · 6月測試集
        </h3>
        <div class="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Precision"
            :value="percent(baselineF1.precision)"
            caption="警報中真的發生缺車/滿柱的比例"
            icon="solar:target-outline"
            tooltip="精確率。系統發出的警報裡，有多少比例是真的發生缺車或滿柱。數字越高代表誤報越少；太低代表常常「狼來了」。"
          />
          <MetricCard
            label="Recall"
            :value="percent(baselineF1.recall)"
            caption="真實事件中被成功預警的比例"
            icon="solar:radar-outline"
            tooltip="召回率。實際發生缺車或滿柱的時段裡，有多少比例被系統事先警告。數字越高代表漏報越少；太低代表常常「狀況發生了卻沒提醒」。"
          />
          <MetricCard
            label="F1"
            :value="percent(baselineF1.f1)"
            caption="Precision 與 Recall 的調和平均"
            icon="solar:medal-star-outline"
            tone="warning"
            tooltip="F1 分數，把 Precision 跟 Recall 兩個常常互相拉扯的指標合成一個總分（調和平均，不是單純平均）。用來判斷整體預測品質，是比對規則基線跟未來模型好壞的主要依據。"
          />
          <MetricCard
            label="樣本數"
            :value="baselineF1.samples.toLocaleString()"
            caption="TP + FP + FN + TN"
            icon="solar:database-outline"
            tooltip="這組分數是根據多少筆「站點 × 時段」預測算出來的（TP 命中 + FP 誤報 + FN 漏報 + TN 正確判斷沒事）。樣本數越大，分數越不容易是巧合。"
          />
        </div>
      </div>

      <div class="mt-5">
        <h3 class="m-0 text-base font-bold text-muted">XGBoost 模型 F1 · 全站（尚未依行政區/站點拆分）· 6月測試集</h3>
        <div class="mt-2 space-y-2">
          <div
            v-for="row in modelF1Rows"
            :key="row.horizon"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span class="text-base font-bold">{{ row.horizon }} 分鐘</span>
            <span v-if="row.metrics" class="text-base">
              F1 {{ percent(row.metrics.f1) }} · Precision {{ percent(row.metrics.precision) }} · Recall {{ percent(row.metrics.recall) }}
            </span>
            <span v-else class="text-base text-muted">尚未產生 · 等待 Step 5-7 XGBoost 訓練與評估完成</span>
          </div>
        </div>
        <p class="mt-2 mb-0 text-base text-muted">
          目前跟規則基線不同，模型分數還沒有依行政區/站點拆分，所以不會跟著上方選單變動；之後若補上分區評估會一併換算。
        </p>
      </div>
    </section>
    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="m-0 text-xl font-bold">歷史營運統計</h2>
          <p class="mt-1 text-base leading-6 text-muted">
            {{ meta.period }}，依星期與半小時時段彙總。分母僅計營運中時段。
          </p>
        </div>
        <span
          v-if="meta.adjustmentsApplied"
          class="inline-flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-base font-semibold text-muted"
        >
          <Icon class="text-xl text-accent" icon="solar:shield-check-outline" />
          已套用 {{ meta.adjustmentsApplied }} 筆營運調整
        </span>
      </div>

      <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ModalPicker v-model="selectedDistrict" label="行政區" :options="districtOptions" />
        <ModalPicker v-model="selectedStationId" label="站點" :options="stationOptions" />
        <ModalPicker v-model="selectedWeekday" label="星期" :options="WEEKDAY_OPTIONS" />
        <ModalPicker v-model="selectedSlot" label="時段" :options="SLOT_OPTIONS" />
      </div>

      <p v-if="shardError" class="mt-3 rounded-md border border-warning bg-warning-surface px-3 py-2 text-base">
        {{ shardError }}
      </p>
    </section>

    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="m-0 text-lg font-bold">{{ scopeLabel }} · {{ weekdayNames[weekday] }} {{ slotLabel }}</h3>
          <p class="mt-1 mb-0 text-base text-muted">點選地圖上的站點可切換到該站的統計。</p>
        </div>
        <div class="flex gap-2">
          <button
            v-for="option in [{ key: 'emptyRate', label: '缺車率' }, { key: 'fullRate', label: '滿柱率' }]"
            :key="option.key"
            class="inline-flex min-h-11 items-center rounded-lg border px-3 text-base font-bold transition-colors"
            :class="mapMetric === option.key
              ? 'border-accent bg-accent text-on-accent'
              : 'border-line bg-surface text-muted hover:border-accent-strong'"
            type="button"
            @click="mapMetric = option.key as 'emptyRate' | 'fullRate'"
          >{{ option.label }}</button>
        </div>
      </div>

      <div class="mt-4">
        <p v-if="shardLoading" class="mb-2 text-base text-muted">載入站點資料中…</p>
        <RoiMap
          :points="mapPoints"
          :selected-id="selectedStationId"
          :metric="mapMetric"
          @select="selectedStationId = $event"
        />
      </div>
    </section>

    <section v-if="current" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="缺車率"
        :value="percent(current.emptyRate)"
        :caption="`${weekdayNames[weekday]} ${slotLabel} · 可借車數為 0`"
        icon="solar:bicycling-round-outline"
        tone="critical"
      />
      <MetricCard
        label="滿柱率"
        :value="percent(current.fullRate)"
        :caption="`${weekdayNames[weekday]} ${slotLabel} · 可還位數為 0`"
        icon="solar:parking-outline"
        tone="warning"
      />
      <MetricCard
        label="平均可借車數"
        :value="String(current.meanBikes)"
        :caption="`平均可還位數 ${current.meanDocks}`"
        icon="solar:chart-2-outline"
      />
      <MetricCard
        label="樣本"
        :value="current.observations.toLocaleString()"
        :caption="selectedStation ? '單一站點觀測數' : `涵蓋 ${current.stations.toLocaleString()} 站`"
        icon="solar:database-outline"
      />
    </section>

    <p v-else class="rounded-xl border border-line bg-panel p-5 text-base text-muted">
      這個範圍在所選時段沒有可用觀測。
    </p>

    <section class="rounded-xl border border-line bg-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="m-0 text-lg font-bold">{{ weekdayNames[weekday] }} 全日走勢</h3>
        <p v-if="dayPeak" class="m-0 text-base text-muted">
          缺車最嚴重：<strong class="text-ink">{{ dayPeak.label }}</strong> {{ percent(dayPeak.rate) }}
        </p>
      </div>

      <div
        class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-base"
        aria-live="polite"
      >
        <strong class="text-ink">{{ readout.label }}</strong>
        <span class="text-muted">{{ readout.isHover ? '滑鼠指向' : '目前選定' }}</span>
        <template v-if="readout.cell">
          <span>缺車 <strong class="text-danger">{{ percent(readout.cell.emptyRate) }}</strong></span>
          <span>滿柱 <strong class="text-warning">{{ percent(readout.cell.fullRate) }}</strong></span>
          <span class="text-muted">平均可借 {{ readout.cell.meanBikes }} · 可還 {{ readout.cell.meanDocks }}</span>
          <span class="text-muted">樣本 {{ readout.cell.observations.toLocaleString() }}</span>
        </template>
        <span v-else class="text-muted">此時段無觀測</span>
      </div>

      <div class="mt-3 space-y-4 overflow-x-auto">
        <div v-for="row in dayRows" :key="row.key" class="min-w-184">
          <div class="flex items-baseline justify-between gap-2 pb-1">
            <strong class="text-base">{{ row.label }}</strong>
            <span class="text-base text-muted">
              <template v-if="row.peak > 0">此列滿刻度 {{ percent(row.peak) }}（{{ row.peakLabel }}）</template>
              <template v-else>這一天完全沒有發生</template>
            </span>
          </div>
          <div
            class="flex items-end gap-px"
            role="img"
            :aria-label="`${weekdayNames[weekday]}各時段${row.label}`"
            @mouseleave="hoveredSlot = null"
          >
            <button
              v-for="(value, index) in row.values"
              :key="index"
              class="flex flex-1 cursor-pointer flex-col justify-end border-0 bg-transparent p-0"
              :class="index === slot ? 'bg-surface' : hoveredSlot === index ? 'bg-panel-muted' : ''"
              type="button"
              :title="`${SLOT_OPTIONS[index]!.label} ${row.label} ${percent(value)}`"
              :aria-label="`${SLOT_OPTIONS[index]!.label} ${row.label} ${percent(value)}`"
              @mouseenter="hoveredSlot = index"
              @focus="hoveredSlot = index"
              @click="selectedSlot = String(index)"
            >
              <span class="flex h-24 w-full flex-col justify-end">
                <span class="w-full rounded-t-sm" :class="row.barClass" :style="{ height: `${(value / row.scale) * 100}%` }" />
              </span>
              <span class="mt-1 block text-center text-xs" :class="index % 4 === 0 ? 'text-muted' : 'text-transparent'">
                {{ index % 4 === 0 ? SLOT_OPTIONS[index]!.label.slice(0, 2) : '·' }}
              </span>
            </button>
          </div>
        </div>
      </div>
      <p class="mt-2 text-base text-muted">
        兩列各自獨立縮放，高度不可互相比較 —— 缺車在全系統約為滿柱的 9 倍，共用刻度會讓滿柱那列縮成一條線。點選長條可切換時段。
      </p>
    </section>

    <DisclosurePanel
      class="panel"
      :title="`${slotLabel} 的一週比較`"
      description="同一時段在七天之間的差異"
      icon="solar:calendar-outline"
    >
      <div class="overflow-x-auto p-4 sm:p-5">
        <table class="w-full min-w-152 border-collapse text-base">
          <thead>
            <tr class="border-b border-line text-left text-muted">
              <th class="py-2 pr-3 font-bold">星期</th>
              <th class="py-2 pr-3 text-right font-bold">缺車率</th>
              <th class="py-2 pr-3 text-right font-bold">滿柱率</th>
              <th class="py-2 pr-3 text-right font-bold">平均可借</th>
              <th class="py-2 pr-3 text-right font-bold">平均可還</th>
              <th class="py-2 text-right font-bold">樣本</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in week"
              :key="index"
              class="border-b border-line/60"
              :class="index === weekday ? 'bg-surface font-bold' : ''"
            >
              <td class="py-2 pr-3">{{ weekdayNames[index] }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ item ? percent(item.emptyRate) : '—' }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ item ? percent(item.fullRate) : '—' }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ item ? item.meanBikes : '—' }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ item ? item.meanDocks : '—' }}</td>
              <td class="py-2 text-right tabular-nums text-muted">{{ item ? item.observations.toLocaleString() : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="selectedStation && shardLoading" class="mt-2 mb-0 text-base text-muted">
          正在載入其餘星期的站點資料…
        </p>
      </div>
    </DisclosurePanel>

    <DisclosurePanel
      class="panel"
      :title="`${weekdayNames[weekday]} ${slotLabel} 的逐日紀錄`"
      :description="selectedStation ? `每一個${weekdayNames[weekday]}的實際數值` : '先選擇站點'"
      icon="solar:list-outline"
    >
      <div class="p-4 sm:p-5">
      <p v-if="!selectedStation" class="m-0 text-base text-muted">
        逐日紀錄是單一站點的原始讀數，請先在上方選擇站點。
      </p>
      <p v-else-if="detailLoading" class="m-0 text-base text-muted">載入逐日紀錄中…</p>
      <p v-else-if="detailMissing" class="m-0 text-base text-muted">
        明細尚未產生。這些檔案不進版控，請執行 <code class="rounded bg-surface px-1">npm run data:profile</code> 後重試。
      </p>
      <template v-else>
        <div class="overflow-x-auto">
          <table class="w-full min-w-152 border-collapse text-base">
            <thead>
              <tr class="border-b border-line text-left text-muted">
                <th class="py-2 pr-3 font-bold">日期</th>
                <th class="py-2 pr-3 font-bold">時間</th>
                <th class="py-2 pr-3 text-right font-bold">可借車數</th>
                <th class="py-2 pr-3 text-right font-bold">可還位數</th>
                <th class="py-2 text-right font-bold">狀態</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in detailRecords" :key="record.date" class="border-b border-line/60">
                <td class="py-2 pr-3 tabular-nums">{{ record.date }}</td>
                <td class="py-2 pr-3 tabular-nums text-muted">{{ slotLabel }}</td>
                <td class="py-2 pr-3 text-right tabular-nums" :class="record.availableBikes === 0 ? 'font-bold text-danger' : ''">
                  {{ record.availableBikes }}
                </td>
                <td class="py-2 pr-3 text-right tabular-nums" :class="record.availableDocks === 0 ? 'font-bold text-warning' : ''">
                  {{ record.availableDocks }}
                </td>
                <td class="py-2 text-right">
                  <span v-if="record.availableBikes === 0" class="font-bold text-danger">缺車</span>
                  <span v-else-if="record.availableDocks === 0" class="font-bold text-warning">滿柱</span>
                  <span v-else class="text-muted">正常</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-3 mb-0 text-base text-muted">
          共 {{ detailRecords.length }} 筆，其中缺車 {{ detailRecords.filter(r => r.availableBikes === 0).length }} 次、滿柱
          {{ detailRecords.filter(r => r.availableDocks === 0).length }} 次。停運（可借與可還皆為 0）的時段不會出現在這裡。
        </p>
      </template>
      </div>
    </DisclosurePanel>

    <DisclosurePanel class="panel" title="這些數字怎麼算的" icon="solar:info-circle-outline">
      <ul class="m-0 grid gap-2 p-4 pl-9 text-base leading-6 text-muted sm:p-5 sm:pl-10">
        <li v-for="(text, key) in meta.definitions" :key="key">{{ text }}</li>
        <li>資料涵蓋 {{ activeScope?.stationCount?.toLocaleString() ?? 0 }} 站，{{ meta.period }}。</li>
      </ul>
    </DisclosurePanel>
  </div>
</template>
