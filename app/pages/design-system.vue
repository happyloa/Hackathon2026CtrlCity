<script setup lang="ts">
/**
 * Living reference for the type scale. Every number on this page is read back
 * from the running stylesheet rather than hard-coded, so it cannot drift from
 * `assets/css/main.css`: resize the window and the readouts change with the
 * design. That also makes it the quickest way to check a breakpoint change --
 * open it at the width in question and read the column.
 */
const ROLES = [
  { key: 'display', name: 'Display', use: '單一主視覺數字或活動標題，一頁最多一次', sample: '營運工作台' },
  { key: 'h1', name: 'H1', use: '文件或行銷頁的主標題（工作台頁面標題用 H3）', sample: '新北市公共自行車' },
  { key: 'h2', name: 'H2', use: '區塊主標、儀表板主要數值', sample: '調度規劃' },
  { key: 'h3', name: 'H3', use: '工作台頁面標題、面板標題', sample: '即時站況地圖' },
  { key: 'h4', name: 'H4', use: '卡片標題、次級數值', sample: '優先搬運路線' },
  { key: 'h5', name: 'H5', use: '卡片內小標、指標數字', sample: '路線 01' },
  { key: 'h6', name: 'H6', use: '清單標題、最小的標題層級', sample: '停靠站點' },
  { key: 'body1', name: 'Body1', use: '正文、表單標籤、按鈕', sample: '掌握即時站況與未來風險' },
  { key: 'body2', name: 'Body2', use: '說明文字、標籤、表頭、註腳', sample: '每 5 分鐘檢查更新' },
] as const

const BREAKPOINTS = [
  { label: '桌機', hint: '≥ 1280px', min: 1280 },
  { label: '筆電 / 平板', hint: '641–1279px', min: 641 },
  { label: '手機', hint: '≤ 640px', min: 0 },
] as const

const measured = ref<Record<string, string>>({})
const viewport = ref(0)

function measure() {
  if (!import.meta.client) return
  const styles = getComputedStyle(document.documentElement)
  measured.value = Object.fromEntries(
    ROLES.map(role => [role.key, styles.getPropertyValue(`--type-${role.key}`).trim()]),
  )
  viewport.value = window.innerWidth
}

/**
 * The step-down table is derived from the same source as the live readout:
 * each role maps to a `--scale-*` step per band, and the band a role lands in
 * is exactly one step down per breakpoint until H6 / Body, which hold.
 */
const STEP_DOWN: Record<string, [string, string, string]> = {
  display: ['72', '48', '40'],
  h1: ['48', '40', '32'],
  h2: ['40', '32', '28'],
  h3: ['32', '28', '24'],
  h4: ['28', '24', '20'],
  h5: ['24', '20', '20'],
  h6: ['20', '20', '20'],
  body1: ['16', '16', '16'],
  body2: ['14', '14', '14'],
}

const activeBand = computed(() => BREAKPOINTS.findIndex(band => viewport.value >= band.min))

onMounted(() => {
  measure()
  window.addEventListener('resize', measure, { passive: true })
})
onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener('resize', measure)
})
</script>

<template>
  <div class="design-system">
    <section class="ds-hero">
      <p class="type-overline">Design System</p>
      <p class="type-display ds-hero-figure">9</p>
      <h2 class="ds-hero-title">個字級，整個網站只用這九個</h2>
      <p class="ds-hero-lede">
        字級是一組固定的階梯，不是可以自由調整的數字。每個角色在不同斷點會往下走一階，
        但落點永遠是這九個尺寸之一，所以無論在哪個螢幕寬度，畫面上都不會出現第十種字級。
      </p>
      <p class="ds-hero-meta">
        目前視窗寬度 <b>{{ viewport }}px</b>
        <span aria-hidden="true">·</span>
        套用
        <b>{{ BREAKPOINTS[activeBand]?.label }}</b>
        階梯
      </p>
    </section>

    <section class="ds-section" aria-labelledby="ds-scale">
      <h3 id="ds-scale">九個字級</h3>
      <p class="ds-section-lede">右欄是此刻真正算出來的值，會隨視窗寬度改變。</p>
      <ul class="ds-specimens">
        <li v-for="role in ROLES" :key="role.key" class="ds-specimen">
          <div class="ds-specimen-meta">
            <b>{{ role.name }}</b>
            <span class="ds-specimen-size">{{ measured[role.key] || '—' }}</span>
            <small>{{ role.use }}</small>
          </div>
          <p class="ds-specimen-sample" :class="`type-${role.key}`">{{ role.sample }}</p>
        </li>
      </ul>
    </section>

    <section class="ds-section" aria-labelledby="ds-rwd">
      <h3 id="ds-rwd">斷點降階</h3>
      <p class="ds-section-lede">
        標題每過一個斷點降一階，H6 是標題的下限；Body1 與 Body2 固定不變 ——
        把正文縮小來遷就小螢幕，是響應式排版最不該做的事。
      </p>
      <div class="ds-table-scroll">
        <table class="ds-table">
          <thead>
            <tr>
              <th scope="col">角色</th>
              <th v-for="(band, index) in BREAKPOINTS" :key="band.label" scope="col"
                :class="{ 'is-active': index === activeBand }">
                {{ band.label }}<small>{{ band.hint }}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in ROLES" :key="role.key">
              <th scope="row">{{ role.name }}</th>
              <td v-for="(size, index) in STEP_DOWN[role.key]" :key="index"
                :class="{ 'is-active': index === activeBand, 'is-held': index > 0 && size === STEP_DOWN[role.key]![index - 1] }">
                {{ size }}px
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ds-section" aria-labelledby="ds-usage">
      <h3 id="ds-usage">怎麼用</h3>
      <div class="ds-usage">
        <article class="ds-card">
          <h4>語意標籤已經內建</h4>
          <p><code>&lt;h1&gt;</code> 到 <code>&lt;h6&gt;</code> 直接對應 H1–H6，不需要再加字級 class。</p>
        </article>
        <article class="ds-card">
          <h4>不是標題的元素</h4>
          <p>用 <code>.type-h4</code>、<code>.type-body2</code> 這類語意 class，或 Tailwind 的 <code>text-h4</code>、<code>text-body2</code>。</p>
        </article>
        <article class="ds-card">
          <h4>原生 CSS</h4>
          <p>寫 <code>font-size: var(--type-h3)</code>，不要寫死 px。降階會自動跟著走。</p>
        </article>
        <article class="ds-card ds-card--warn">
          <h4>已經移除的寫法</h4>
          <p>Tailwind 內建的 <code>text-sm</code>、<code>text-base</code>、<code>text-xl</code> 全部已停用，寫了不會有任何效果。</p>
        </article>
      </div>
    </section>

    <section class="ds-section" aria-labelledby="ds-exceptions">
      <h3 id="ds-exceptions">兩個不屬於字級的例外</h3>
      <div class="ds-usage">
        <article class="ds-card">
          <h4>圖示尺寸</h4>
          <p>
            圖示用 <code>width/height: 1em</code> 繪製，所以它的大小是 <code>font-size</code> —— 但圖示不是文字。
            用 <code>.icon-sm</code> / <code>.icon-md</code> / <code>.icon-lg</code> / <code>.icon-xl</code>（16 / 20 / 24 / 32px）。
          </p>
        </article>
        <article class="ds-card">
          <h4>地圖標記文字</h4>
          <p>
            地圖圖釘內的停靠序號固定在 <code>--marker-label</code>（10–11px）。
            把它放大到 14px 會撐破圖釘，所以這是唯一明文允許的例外。
          </p>
        </article>
      </div>
      <p class="ds-footnote">
        <code>npm run type:validate</code> 會掃描全部 <code>.vue</code> 與 <code>.css</code>，
        只要出現寫死的 <code>font-size</code> 或已移除的 Tailwind 字級 class 就讓建置失敗。
      </p>
    </section>
  </div>
</template>

<style scoped>
.design-system {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px;
  display: grid;
  gap: 40px;
}

/* Grid items default to min-width:auto, so the step-down table's own
   `min-width` would widen the whole page instead of scrolling inside
   `.ds-table-scroll`. */
.design-system > * {
  min-width: 0;
}

.ds-hero {
  padding-bottom: 32px;
  border-bottom: 1px solid var(--line);
}

.ds-hero-figure {
  margin: 10px 0 0;
  color: var(--accent);
  line-height: 0.9;
}

.ds-hero-title {
  margin-top: 4px;
  font-size: var(--type-h2);
  line-height: var(--type-h2-lh);
  letter-spacing: var(--type-h2-ls);
}

.ds-hero-lede {
  max-width: 60ch;
  margin-top: 16px;
  font-size: var(--type-body1);
  line-height: var(--type-body1-lh);
  color: var(--muted);
}

.ds-hero-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  font-size: var(--type-body2);
  color: var(--muted);
}

.ds-hero-meta b {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.ds-section-lede {
  max-width: 60ch;
  margin-top: 8px;
  font-size: var(--type-body2);
  line-height: var(--type-body2-lh);
  color: var(--muted);
}

.ds-specimens {
  display: grid;
  gap: 4px;
  margin: 24px 0 0;
  padding: 0;
  list-style: none;
}

.ds-specimen {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  align-items: baseline;
  padding: 18px 0;
  border-top: 1px solid var(--line);
}

.ds-specimen-meta {
  display: grid;
  gap: 2px;
}

.ds-specimen-meta b {
  font-size: var(--type-body1);
  font-weight: 650;
}

.ds-specimen-size {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--type-body2);
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.ds-specimen-meta small {
  color: var(--muted);
  line-height: var(--type-body2-lh);
}

.ds-specimen-sample {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.ds-table-scroll {
  margin-top: 20px;
  overflow-x: auto;
}

.ds-table {
  width: 100%;
  min-width: 420px;
  border-collapse: collapse;
  font-size: var(--type-body2);
  font-variant-numeric: tabular-nums;
}

.ds-table th,
.ds-table td {
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}

.ds-table thead th {
  font-weight: 650;
  white-space: nowrap;
  border-bottom-color: var(--line-strong);
}

.ds-table thead th small {
  display: block;
  font-weight: 400;
  color: var(--muted);
}

.ds-table tbody th {
  font-weight: 650;
}

.ds-table .is-active {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
}

.ds-table .is-held {
  color: var(--muted);
}

.ds-usage {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 20px;
}

.ds-card {
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}

.ds-card--warn {
  border-color: var(--warning);
  background: var(--warning-surface);
}

.ds-card h4 {
  font-size: var(--type-h6);
  line-height: var(--type-h6-lh);
}

.ds-card p {
  margin-top: 6px;
  font-size: var(--type-body2);
  line-height: var(--type-body2-lh);
  color: var(--muted);
}

.ds-card--warn p {
  color: var(--warning);
}

code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--type-body2);
}

.ds-footnote {
  margin-top: 16px;
  font-size: var(--type-body2);
  line-height: var(--type-body2-lh);
  color: var(--muted);
}

@media (max-width: 900px) {
  .design-system {
    padding: 24px;
    gap: 32px;
  }

  .ds-specimen {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}

@media (max-width: 640px) {
  .design-system {
    padding: 20px 16px 32px;
  }
}
</style>
