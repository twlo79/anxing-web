'use client';
import type { ReactNode } from 'react';

/**
 * 分頁籤 —— 全站唯一一份（2026-08-29 使用者:「tab 有好幾種形式 也要統一」）。
 *
 * ============================================================
 * 【盤點:同一個東西有五種長相】
 *
 *   房務管理    底線 ＋ 主色字
 *   出勤        圓角膠囊塞在一個淺色面板裡
 *   出勤·管理   同上,但小一號（分頁裡還有分頁）
 *   其他收支帳  實心藍膠囊（帳本）＋ 底線（收支帳/儀錶板）—— 一頁兩種
 *   帳戶明細    小的實心膠囊
 *   請款單      底線 ＋ 一顆數字徽章
 *
 * 不是誰寫錯了 —— 是**沒有一個地方定義「分頁籤長什麼樣」**。
 * 而這種不一致 `tsc` 與測試都抓不到:class 打錯不會報錯,只會變醜。
 *
 *
 * ============================================================
 * 【★★ 兩種樣式，各有各的意思 —— 不是「挑好看的」】
 *
 *   `line`（底線）  **切換同一份資料的檢視**
 *                   行事曆／排班統計、收支帳／儀錶板、請款審核／請款單。
 *                   底線像書籤:內容換了,但還在同一本書裡。
 *
 *   `solid`（膠囊） **切換「哪一份資料」**
 *                   愛皮／洪鯊、元大 70564／24145／48088。
 *                   膠囊像檔案夾:換一個就是換一整批東西。
 *
 * ★ 一頁可以同時有兩種（其他收支帳就是:先選帳本，再選檢視）——
 *   那正是為什麼不能統一成同一種。**它們回答的是不同的問題。**
 *
 *
 * ============================================================
 * 【★ 徽章放數字，不放狀態】
 *
 * 請款單的「請款審核 13」是「有 13 件等你」。
 * 徽章只在 `> 0` 時出現 —— 顯示 `0` 等於用一個醒目的記號說「沒事」,
 * 那會訓練人忽略它,而它真正有事的時候就沒有人看了。
 */

export type TabItem<T extends string> = {
  key: T;
  label: ReactNode;
  /** 右上角的數字。0 或 undefined 不畫 —— 見檔頭。 */
  badge?: number;
};

export function Tabs<T extends string>({
  items, value, onChange, variant = 'line', size = 'md', className = '',
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (k: T) => void;
  /** line = 換檢視（同一份資料）；solid = 換資料（哪一本帳、哪個帳戶） */
  variant?: 'line' | 'solid';
  /** sm 給「分頁裡的分頁」用 —— 兩層一樣大的話看不出誰包誰 */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const md = size === 'md';

  if (variant === 'solid') {
    return (
      <div className={`flex flex-wrap gap-2 ${className}`} role="tablist">
        {items.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={on}
              onClick={() => onChange(t.key)}
              className={`${md ? 'h-10 px-5 text-ui' : 'h-9 px-4 text-uisub'}
                rounded-full font-medium whitespace-nowrap transition-colors ${
                on ? 'bg-mor-slate text-white'
                   : 'bg-white border border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
              {t.label}
              <Badge n={t.badge} on={on} />
            </button>
          );
        })}
      </div>
    );
  }

  /*
   * ★★ 底線畫在**整條的下緣**，每個籤自己蓋掉自己那一段。
   *
   *   只給選中的那個畫底線的話,沒選中的下面是空的 ——
   *   眼睛會把「有線的那一段」讀成一個獨立的框,而不是一整排的其中一個。
   */
  return (
    <div className={`flex flex-wrap items-end gap-1 border-b border-mor-line ${className}`}
      role="tablist">
      {items.map((t) => {
        const on = t.key === value;
        return (
          <button key={t.key} type="button" role="tab" aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`${md ? 'h-11 px-4 text-ui' : 'h-9 px-3 text-uisub'}
              -mb-px border-b-2 font-medium whitespace-nowrap transition-colors ${
              on ? 'border-mor-slate text-mor-slate'
                 : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
            <Badge n={t.badge} on={on} />
          </button>
        );
      })}
    </div>
  );
}

/** 數字徽章。★ `> 0` 才畫 —— 見檔頭「不放 0」。 */
function Badge({ n, on }: { n?: number; on: boolean }) {
  if (!n || n <= 0) return null;
  return (
    <span className={`ml-1.5 inline-flex items-center justify-center rounded-full
      px-1.5 min-w-[1.25rem] h-5 text-uisub font-semibold tabular-nums ${
      on ? 'bg-mor-slate text-white' : 'bg-amber-100 text-amber-800'}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
