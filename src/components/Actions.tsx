'use client';
import type { ReactNode } from 'react';

/**
 * 列表頁右上角那一組動作鈕。全站共用。
 *
 * ============================================================
 * 【為什麼要統一】
 *
 * 改版前每一頁長得都不一樣：
 *
 *   訂單    下載 Excel（白）→ + 新增訂單（藍）→ 垃圾桶
 *   支出    下載 Excel（白）→ + 填寫支出（藍）
 *   押金    + 手動新增（藍框白底）→ 下載 Excel（**藍底**）
 *   請款單  + 手動新增 → 垃圾桶 → 下載 Excel
 *   營收    下載 Excel（藍底）
 *   清潔    ⬇ CSV
 *
 * 順序不同、顏色不同、名字不同。使用者每換一頁就要重新找按鈕在哪裡，
 * 而且「藍色的那顆」在押金頁是下載、在訂單頁是新增 ——
 * 顏色本來是最快的識別線索，不一致的時候它反而在誤導。
 *
 *
 * ============================================================
 * 【規則】（使用者決定）
 *
 *   順序    新增 → 下載 Excel → 刪除（回收桶）
 *   顏色    新增是藍底白字（主要動作，一頁只有一個）
 *           下載是白底（次要動作）
 *   用語    一律「⬇ 下載 Excel」—— 不叫匯出、不叫 CSV、不省略「下載」
 *
 * 順序的理由：新增是最常按的，放在最左邊（視線從左掃過來的第一個）；
 * 刪除放最右邊，離另外兩個最遠 —— 那是唯一不可逆的動作。
 */

const BASE = 'rounded-lg px-4 py-1.5 font-medium whitespace-nowrap transition-colors disabled:opacity-40';

/**
 * 主要動作：新增。一頁只有一個。
 *
 * 藍底白字是全站唯一的「主要動作」樣式 —— 多一個就不再是「主要」了。
 */
export function AddButton({ onClick, children, disabled }: {
  onClick: () => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`${BASE} bg-mor-slate text-white hover:bg-mor-slatedark`}>
      + {children}
    </button>
  );
}

/**
 * 匯出鈕的配色。**手刻尺寸的地方也要吃這一條**（手機的滿版鈕、卡片標題裡的小鈕）。
 *
 * ============================================================
 * 【為什麼是綠色外框】（2026-08-28 使用者:「這個好 整站都改」）
 *
 * ★ 綠色 = **產出一個檔案**。而 Excel 本身就是綠的 ——
 *   那是不用教就認得的線索，白撿的。
 *
 * ★★ 外框而不是實心:一個畫面只能有一個主要動作。
 *   實心綠會跟實心藍的「新增」搶,而那兩個的後果差很多 ——
 *   下載按錯只是多一個檔案，新增按錯是資料庫裡多一列。
 *
 * ★★★ 顏色用 `mor-greendark` 不是 `mor-green`。
 *   `mor-green`（#3FAE7C）當文字只有 **2.78:1** —— 它是給進度條那種「面」用的,
 *   拿來當細字與 1px 邊框會糊掉。#217346 是 5.82:1。
 *   有一條測試讀 `tailwind.config.ts` 守著這件事。
 *
 * 【為什麼一律叫「下載 Excel」】
 * 原本有「匯出」「⬇ CSV」「⬇ Excel」三種說法。
 * 「匯出」是系統的視角，「下載」是使用者的視角 —— 他要的是一個檔案在電腦上。
 */
export const EXPORT_TONE =
  'border border-mor-greendark/50 bg-white text-mor-greendark hover:bg-mor-greenlight';

export function ExportButton({ onClick, disabled, busy, label = '下載 Excel' }: {
  onClick: () => void; disabled?: boolean; busy?: boolean; label?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy}
      className={`${BASE} ${EXPORT_TONE}`}>
      {busy ? '匯出中…' : <>⬇ {label}</>}
    </button>
  );
}

/**
 * 一整組動作鈕的外框。
 *
 * 順序由呼叫端排（新增 → 下載 → 刪除），這裡只負責間距與靠右。
 * 不強制順序是刻意的 —— 有些頁沒有新增（營收）、有些沒有回收桶，
 * 硬塞成固定插槽會讓那些頁多出空欄位。
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex items-end gap-3">{children}</div>;
}
