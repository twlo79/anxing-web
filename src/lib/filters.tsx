'use client';
import { ReactNode } from 'react';

/**
 * 篩選列的共用元件。
 *
 * 【為什麼要有這支】
 * 各頁的篩選各長各的：契約頁有三顆清除鈕（日期一顆、關鍵字一顆、全部清除一顆），
 * 支出頁只有一顆，清潔頁叫「清除篩選」，儀表板叫「清除」。
 * 同一個動作四個名字、四種位置，使用者每換一頁就要重新找。
 *
 * 這裡統一三件事：
 *   1. 版面 —— 白底圓角卡片，欄位橫排，右側放筆數與動作鈕
 *   2. 清除 —— **只有一顆**，叫「清除」，永遠在篩選欄位的最後面
 *   3. 日期 —— 起訖兩欄 + 快捷鈕，格式由 lib/period 統一
 *
 * 【關於 <input type="date"> 的顯示格式】
 * 那是**瀏覽器與作業系統的地區設定決定的**，網頁改不了。
 * 顯示成 dd/mm/yyyy 代表瀏覽器語言是英式英文；改成中文（台灣）就會變 yyyy/mm/dd。
 * 送出的值一律是 ISO 的 YYYY-MM-DD，不受顯示格式影響 —— 所以是純顯示問題。
 *
 * 表格裡自己畫的日期不受這個限制，一律走 lib/period 的 fmtDate（YYYY/MM/DD）。
 */

export function FilterBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-mor-line px-3 py-2.5 mb-3
                    flex flex-wrap items-center gap-2 text-sm">
      {children}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

const SEL = 'rounded-lg border border-mor-line bg-white px-2 py-1.5 text-sm';

/** 下拉。`all` 是「全部 XX」那一項的文字。 */
export function FilterSelect({ value, onChange, all, options }: {
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={SEL}>
      <option value="">{all}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * 日期區間。起訖兩欄中間一個 `~`。
 *
 * 快捷鈕（本月 / 上月 / 近三月）刻意放在右邊而不是下拉選單裡 ——
 * 那三個是最常用的區間，多一次點擊就會有人懶得用，然後手動打日期打錯。
 */
export function FilterDateRange({ from, to, onFrom, onTo, quick, title }: {
  from: string; to: string;
  onFrom: (v: string) => void; onTo: (v: string) => void;
  quick?: { label: string; from: string; to: string }[];
  title?: string;
}) {
  return (
    <div className="flex items-center gap-1" title={title}>
      <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className={SEL} />
      <span className="text-gray-400">~</span>
      <input type="date" value={to} onChange={(e) => onTo(e.target.value)} className={SEL} />
      {quick?.map((q) => (
        <button key={q.label} onClick={() => { onFrom(q.from); onTo(q.to); }}
          className="rounded-lg border border-mor-line px-2 py-1.5 text-xs hover:bg-mor-sand/60">
          {q.label}
        </button>
      ))}
    </div>
  );
}

/** 關鍵字。placeholder 要寫清楚搜得到什麼，不要只寫「搜尋」。 */
export function FilterSearch({ value, onChange, placeholder, width = 'w-44' }: {
  value: string; onChange: (v: string) => void; placeholder: string; width?: string;
}) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`${SEL} ${width}`} />
  );
}

/**
 * 清除。**一頁只放一顆**，永遠在篩選欄位的最後面。
 *
 * 沒有任何條件時停用而不是隱藏 —— 隱藏的話按鈕會忽隱忽現，
 * 後面的元素跟著左右跳，滑鼠移過去按鈕就不見了。
 */
export function FilterClear({ active, onClear }: { active: boolean; onClear: () => void }) {
  return (
    <button onClick={onClear} disabled={!active}
      className="rounded-lg border border-mor-line px-3 py-1.5 text-sm
                 hover:bg-mor-sand/60 disabled:opacity-35 disabled:cursor-default">
      清除
    </button>
  );
}

/** 筆數。放在動作鈕左邊，讓人按下載之前先確認範圍對不對。 */
export function FilterCount({ n, unit = '筆' }: { n: number; unit?: string }) {
  return <span className="text-xs text-gray-400 whitespace-nowrap">共 {n.toLocaleString('en-US')} {unit}</span>;
}
