# 字級設計系統與 RWD

> **與目前 Demo 的關係**：全站字級已統一為下列九階，`app/assets/css/main.css` 是唯一來源，`app/pages/design-system.vue` 是可即時檢視的參考頁（路由 `/design-system`）。`npm run type:validate` 會在 `npm test` 與 `npm run build` 前先跑，寫死的 `font-size` 或已移除的 Tailwind 字級 class 都會讓建置失敗。

**導入日期：** 2026-09-12
**影響範圍：** 21 個 `.vue` 元件與頁面、1 個 layout、`assets/css/main.css`

---

## 1. 九階字級

| 角色 | 尺寸 | line-height | letter-spacing | 用途 |
|---|---|---|---|---|
| Display | 72px | 1.05 | -0.03em | 單一主視覺數字或活動標題，一頁最多一次 |
| H1 | 48px | 1.1 | -0.025em | 文件／行銷頁主標題 |
| H2 | 40px | 1.15 | -0.022em | 區塊主標、儀表板主要數值 |
| H3 | 32px | 1.2 | -0.018em | 工作台頁面標題、面板標題 |
| H4 | 28px | 1.25 | -0.015em | 卡片標題、次級數值 |
| H5 | 24px | 1.3 | -0.012em | 卡片內小標、指標數字 |
| H6 | 20px | 1.4 | -0.008em | 清單標題，標題層級的下限 |
| Body1 | 16px | 1.6 | 0 | 正文、表單標籤、按鈕 |
| Body2 | 14px | 1.55 | 0 | 說明文字、標籤、表頭、註腳 |

line-height 與 letter-spacing 綁在尺寸上，不是綁在角色上——所以一個角色降階時，行高與字距會跟著換成新尺寸該有的值，不會出現「48px 的字配 72px 的行高」。中文（Noto Sans TC / PingFang TC）不吃太緊的字距，因此負字距刻意保守。

## 2. 三層結構

```
--scale-*   九個固定階梯。size + 該尺寸對應的 lh / ls。永不改寫。
--type-*    九個角色。每個角色指向一個 --scale-* 階梯，
            並在較窄的斷點改指向「更小的那一階」。
--text-*    Tailwind 橋接，讓 text-h2 / text-body2 這類 utility 存在，
            並自動繼承降階。
```

關鍵在第二層：**角色只能指向階梯，不能指向任意數值**。因此不論視窗多寬，畫面上算出來的 `font-size` 必定是那九個之一，不會有 `clamp()` 產生的中間值。

`--text-*` 必須放在 `@theme inline` 並指向 `--type-*`；若把數值直接寫進 `@theme`，Tailwind 會把值內聯進 utility，媒體查詢就改不動了。

## 3. 斷點降階

| 角色 | 桌機 ≥1280px | 筆電／平板 641–1279px | 手機 ≤640px |
|---|---|---|---|
| Display | 72 | 48 | 40 |
| H1 | 48 | 40 | 32 |
| H2 | 40 | 32 | 28 |
| H3 | 32 | 28 | 24 |
| H4 | 28 | 24 | 20 |
| H5 | 24 | 20 | 20 |
| H6 | 20 | 20 | 20 |
| Body1 | 16 | 16 | 16 |
| Body2 | 14 | 14 | 14 |

兩條規則：

1. **標題每過一個斷點降一階，H6 是下限。** 72px 是海報尺寸，塞進 900px 欄寬只會擠爆版面。
2. **Body1 / Body2 完全不動。** 為了遷就小螢幕而縮小正文，是響應式排版最不該做的事；小螢幕該做的是換版面，不是換字級。

降階寫在 `:root` 的媒體查詢裡，所以 Tailwind utility、`.type-*` class、以及 scoped CSS 裡的 `var(--type-h3)` 三者同時生效，元件端不需要為字級再寫任何斷點。

## 4. 兩個不屬於字級的例外

這兩類的 `font-size` 不是排版，硬套九階會把畫面弄壞，因此獨立成自己的 token 並明文記錄：

| 例外 | Token | 值 | 理由 |
|---|---|---|---|
| 圖示尺寸 | `--icon-sm/md/lg/xl` | 16 / 20 / 24 / 32px | 本專案的 inline SVG 以 `width/height: 1em` 繪製，大小由 `font-size` 決定——但圖示不是文字。對應 class：`.icon-sm` ~ `.icon-xl` |
| 地圖標記文字 | `--marker-label`、`--marker-label-lg` | 10px、11px | 地圖圖釘內的停靠序號。圖釘直徑固定，序號放大到 14px 會直接撐破圖釘 |

`--icon-*` 不隨斷點變動：圖示是操作目標，縮小只會讓觸控更難按。

## 5. 怎麼用

| 情境 | 寫法 |
|---|---|
| 語意標題 | 直接寫 `<h1>`～`<h6>`，base layer 已對應 H1–H6，**不要**再加字級 class |
| 非標題元素 | `.type-h4`、`.type-body2`，或 Tailwind 的 `text-h4`、`text-body2` |
| 常見角色 | `.type-caption`（Body2 + muted）、`.type-overline`（Body2 + 寬字距大寫）、`.type-metric`（等寬數字） |
| 原生 CSS | `font-size: var(--type-h3)`，搭配 `var(--type-h3-lh)` / `var(--type-h3-ls)` |
| 圖示 | `.icon-md`，或 `font-size: var(--icon-md)` |

**已停用：** Tailwind 內建的 `text-xs` ~ `text-9xl` 全部以 `--text-*: initial` 移除。寫了不會報錯，但也不會有任何效果——所以由 `type:validate` 把它變成建置錯誤。

## 6. 導入時的實際取捨

原本全站有 223 處寫死的 `font-size`，從 9px 到 34px 共 24 種尺寸，另有 290 處 Tailwind 字級 class。對照到九階時：

- **9–14px → Body2（14px）。** 影響最大的一段：原本有 67 處 12px、37 處 11px、13 處 10px。這些微標籤、表頭、徽章全部放大到 14px，密度明顯下降，但可讀性與無障礙都變好。版面因此重新調過留白與換行。
- **15–18px → Body1（16px）。** 刻意不併進 14px，否則原本 15px 的強調文字會和一大票 12px 塌成同一層，階層反而更糟。
- **19–22 → H6、23–26 → H5、27–30 → H4、31–34 → H3。**
- 12 處媒體查詢裡的字級覆寫在導入後變成多餘（覆寫值與 base 相同），已刪除——降階改由 token 集中處理。

版面標題刻意升到 H3（32/28/24）而非沿用原本的 28px：首頁指標數字是 H2（40/32/28），標題若停在 H4 會比數字小兩階，階層會倒過來。

## 7. 一併修掉的 RWD 問題

導入過程用瀏覽器在 320 / 375 / 768 / 1440px 逐頁量測 `scrollWidth`，找出兩個與字級無關但確實存在的響應式缺陷：

1. **`/dispatch` 在手機會整頁橫向捲動**（375px 視窗量到 775px）。`.dispatch-page` 是 grid，grid item 預設 `min-width: auto`，讓路線卡片橫向捲軸（`.dispatch-route-cards`，卡片各有 `min-width: 245px`）的 min-content 把整欄撐開。已加上 `.dispatch-page > * { min-width: 0 }`。
2. **`MetricCard` 的標籤列在 320px 會溢出**，且 hover 提示框固定 `w-56`（224px）會超出畫面。標籤列改為可換行、提示框加上 `max-w-[calc(100vw-2rem)]`。

修正後 `/`、`/stations`、`/dispatch`、`/stations/[id]`、`/admin/roi`、`/admin/adjustments` 在 320px 均無橫向捲動，且量到的 `font-size` 只出現九階與 10px 地圖標記。

## 8. 檢查方式

```bash
npm run type:validate   # 掃描全部 .vue / .css
npm test                # 先跑 type:validate，再跑單元測試
```

`scripts/validate-type-scale.mjs` 會擋下兩類寫法：

- 值不在允許清單內的 `font-size`（允許的是 `var(--type-*)`、`var(--icon-*)`、`var(--marker-*)`、`inherit`、`1em`）
- 已移除的 Tailwind 字級 class，含 `sm:` / `lg:` 等響應式前綴與 `text-[13px]` 這類任意值

註解與 `<code>` 區塊會被略過，所以文件裡提到這些寫法不會誤報。

視覺對照請開 `/design-system`——頁面上的尺寸是即時從樣式表讀回來的，縮放視窗就能看到降階發生。
