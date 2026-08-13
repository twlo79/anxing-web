'use client';
import { ReactNode } from 'react';
import FilterToggle from '@/components/FilterToggle';

/**
 * 篩選列的共用元件。**版型以短租訂單頁為準**，全站一致。
 *
 * 【為什麼要有這支】
 * 各頁的篩選原本各長各的：契約頁有三顆清除鈕（日期一顆、關鍵字一顆、還有「全部清除」），
 * 支出頁一顆、清潔頁叫「清除篩選」、儀表板叫「清除」。
 * 同一個動作四個名字、四種樣式、四個位置，使用者每換一頁就要重新找。
 *
 * 統一成短租那一套：
 *   1. 每個欄位上方都有小標題 —— 光看下拉裡的「全部」猜不出那是在篩什麼
 *   2. 關鍵字要按「搜尋」或 Enter 才送出 —— 邊打邊查會在每個字上打一次資料庫
 *   3. 清除是**底線文字**不是按鈕，放在搜尋右邊，而且只有一顆
 *   4. 右側 ml-auto：筆數 → 下載 → 新增
 *
 * 【關於 <input type="date"> 的顯示格式】
 * 那是**瀏覽器與作業系統的地區設定決定的**，網頁改不了。
 * 顯示 dd/mm/yyyy 代表瀏覽器語言是英式英文，改成中文（台灣）就會變 yyyy/mm/dd。
 * 送出的值一律是 ISO 的 YYYY-MM-DD，不受顯示格式影響 —— 純視覺問題。
 *
 * 表格裡自己畫的日期不受這個限制，一律走 lib/period 的 fmtDate（YYYY/MM/DD）。
 */

const CTRL = 'rounded-lg border border-gray-300 px-2 py-1.5';

/**
 * @param active 目前有沒有套用任何條件。手機收起篩選時，
 *               這是「為什麼只有 3 筆」唯一的線索 —— 傳進來按鈕才會亮。
 */
export function FilterBar({ children, right, active }: {
  children: ReactNode; right?: ReactNode; active?: boolean;
}) {
  return (
    <>
      <FilterToggle active={active} />
      <div className="filter-bar collapsible-filters bg-white rounded-xl border border-mor-line p-4 mb-4
                      flex flex-wrap items-end gap-3 text-sm">
        {children}
        {right && <div className="ml-auto flex items-end gap-3">{right}</div>}
      </div>
    </>
  );
}

/** 欄位外框：小標題 + 內容。標題是必要的 —— 下拉裡只寫「全部」猜不出在篩什麼。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

/** 下拉。`all` 預設「全部」—— 跟短租頁一致，不要寫成「全部物業」那種長字串。 */
export function FilterSelect({ label, value, onChange, options, all = '全部' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  all?: string;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={CTRL}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

/**
 * 日期區間。起訖兩欄中間一個 `~`。
 *
 * label 要說清楚是「哪個日期」—— 短租寫「訂單日期(期間內有交集)」，
 * 因為跨月訂單只要跟區間有重疊就算，跟「入住日落在區間內」不是同一件事。
 * 那種差異不寫出來，使用者篩出來的東西會跟預期不同而且不會發現。
 */
export function FilterDateRange({ label, from, to, onFrom, onTo, quick }: {
  label: string;
  from: string; to: string;
  onFrom: (v: string) => void; onTo: (v: string) => void;
  quick?: { label: string; from: string; to: string }[];
}) {
  return (
    <Field label={label}>
      {/* 起訖兩個日期框加上快捷鈕，手機一行放不下 —— flex-wrap 讓它自然折行而不是溢出 */}
      <div className="flex flex-wrap items-center gap-1">
        <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className={CTRL} />
        <span className="text-gray-400">~</span>
        <input type="date" value={to} onChange={(e) => onTo(e.target.value)} className={CTRL} />
        {quick?.map((q) => (
          <button key={q.label} onClick={() => { onFrom(q.from); onTo(q.to); }}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs hover:bg-mor-sand/60">
            {q.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

/**
 * 關鍵字 + 搜尋鈕。
 *
 * 【為什麼要按鈕而不是邊打邊查】
 * 邊打邊查會在每一個字上送一次查詢。訂單有 1900 多筆、支援模糊比對,
 * 打「王小明」就是四次全表掃描,而前三次的結果沒有人要看。
 *
 * 所以外面維持兩個狀態：`value` 是輸入框的內容,`onSubmit` 才是真的去查。
 * Enter 等同按搜尋 —— 習慣打完就按 Enter 的人不該被迫去點按鈕。
 */
export function FilterSearch({ label, value, onChange, onSubmit, placeholder = '搜尋', width = 'w-36' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  width?: string;
}) {
  return (
    <Field label={label}>
      <div className="flex gap-1">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder={placeholder} className={`${CTRL} ${width}`} />
        <button onClick={onSubmit}
          className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
      </div>
    </Field>
  );
}

/**
 * 清除。**一頁只放一顆**，底線文字，放在最後一個篩選欄位的右邊。
 *
 * 沒有任何條件時不顯示（跟短租頁一致）—— 一整排欄位都空的時候,
 * 一顆灰掉的按鈕只是視覺雜訊。
 */
export function FilterClear({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) return null;
  return (
    <button onClick={onClear} className="text-gray-500 underline pb-1.5">清除</button>
  );
}

/** 筆數。跟右側的動作鈕同一組，`pb-1.5` 讓它跟按鈕的基線對齊。 */
export function FilterCount({ n, unit = '筆' }: { n: number; unit?: string }) {
  return (
    <div className="text-xs text-gray-400 pb-1.5 whitespace-nowrap">
      共 {n.toLocaleString('en-US')} {unit}
    </div>
  );
}
