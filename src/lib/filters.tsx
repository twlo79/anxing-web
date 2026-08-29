'use client';
import { ReactNode } from 'react';
import FilterToggle from '@/components/FilterToggle';
import { syncFrom, syncTo } from '@/lib/date-range';

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

/**
 * 篩選欄位的外觀。**匯出出去** —— 有些欄位（`type="month"`、多選）
 * 這裡沒有現成元件，頁面得自己畫，但框線與圓角要跟其他欄位一致。
 *
 * ★ 自己寫一份 `border border-mor-line` 的話，同一排會出現兩種深淺的框，
 *   而那種差異只有把兩頁擺在一起才看得出來。
 */
export const FILTER_CTRL =
  'h-12 md:h-10 rounded-lg border border-gray-300 px-3 text-[17px] leading-none';
const CTRL = FILTER_CTRL;

/**
 * 篩選卡裡「跟欄位並排的按鈕」——搜尋、快捷、清除。
 *
 * ★★ 高度跟 `FILTER_CTRL` **一模一樣**。這是對齊唯一可靠的做法:
 *   靠 padding 湊的話,`select`（有下拉箭頭）、`input`、`button`
 *   算出來的高度天生就不同,而且會隨字級與瀏覽器再變一次 ——
 *   今天調對了,明天字一放大又歪。
 *
 * ★ 手機 48px:`globals.css` 只把 input/select 撐到 3rem，**按鈕沒有** ——
 *   那就是手機上搜尋鈕比輸入框矮的原因。這裡補起來。
 */
export const FILTER_BTN_H = 'h-12 md:h-10';

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
      {/*
        ★ 用 `glass` 而不是 `bg-white` —— 訂單頁（使用者指定的版型基準）
          就是 glass。兩種白並排時看得出來其中一張比較「死」。
      */}
      <div className="filter-bar collapsible-filters rounded-xl glass p-4 mb-4
                      flex flex-wrap items-end gap-3">
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
      {/*
        ★★ 標題那一行**固定高度**（h-5），不是讓內容撐。

          一個字的「狀態」跟六個字的「訂單日期(期間內有交集)」如果換行,
          那一欄的控制項就會被推低一格 —— 底部靠 items-end 還是齊的,
          但**上緣歪掉**,而使用者看到的是「這一格比較矮」。
      */}
      <label className="block h-5 mb-1 text-[15px] leading-5 text-gray-500 whitespace-nowrap">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * 沒有標題的東西（勾選框、清除）要**補一格看不見的標題**，
 * 否則它會整個往上跑，跟隔壁欄位的上緣對不齊。
 */
export function FieldSpacer({ children }: { children: ReactNode }) {
  return (
    <div>
      <span aria-hidden className="block h-5 mb-1" />
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
        {/*
          ★★ 這一支是 2026-08-27 那次「全站起訖連動」**漏掉的**。

            當時是掃 `type="date"` 靠得很近的成對輸入,而這裡包了一層 Field,
            兩個 input 中間隔著元件邊界 —— 掃不到。
            契約頁的租期篩選因此還是舊行為:改了起日,迄日留在更早的日期,
            清單直接空掉而畫面不會說為什麼。

          ★ 教訓跟 README 9.3 那條一樣:**照形狀掃會漏,要照「誰在用」掃**。
            `grep -rn "FilterDateRange"` 一次就找得到。
        */}
        <input type="date" value={from} className={CTRL}
          onChange={(e) => { const r = syncFrom(e.target.value, to); onFrom(r.from); onTo(r.to); }} />
        <span className="text-gray-400">~</span>
        <input type="date" value={to} className={CTRL} min={from || undefined}
          onChange={(e) => { const r = syncTo(from, e.target.value); onFrom(r.from); onTo(r.to); }} />
        {quick?.map((q) => (
          <button key={q.label} onClick={() => { onFrom(q.from); onTo(q.to); }}
            className={`${FILTER_BTN_H} rounded-lg border border-gray-300 px-3 text-sm hover:bg-mor-sand/60`}>
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
      <div className="flex gap-1.5">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder={placeholder} className={`${CTRL} ${width}`} />
        <button onClick={onSubmit}
          className={`${FILTER_BTN_H} rounded-lg bg-mor-slate text-white px-4
                      text-[17px] font-medium hover:bg-mor-slatedark`}>搜尋</button>
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
    <FieldSpacer>
      <button onClick={onClear}
        className={`${FILTER_BTN_H} px-2 text-[15px] text-gray-500 underline`}>清除</button>
    </FieldSpacer>
  );
}

/** 筆數。跟右側的動作鈕同一組，`pb-1.5` 讓它跟按鈕的基線對齊。 */
export function FilterCount({ n, unit = '筆' }: { n: number; unit?: string }) {
  return (
    <div className="text-[15px] text-gray-400 whitespace-nowrap">
      共 {n.toLocaleString('en-US')} {unit}
    </div>
  );
}

/**
 * 動作列。篩選卡**下面**獨立一行，靠右。
 *
 * ============================================================
 * 【★★ 為什麼不塞進篩選卡裡】
 *
 * 塞進去的話它會跟六個下拉排在同一行 —— 而它們是**兩件不同的事**:
 * 篩選是「我要看哪些」，動作是「我要做什麼」。
 * 混在一起的結果是「+ 新增」看起來像第七個篩選欄位。
 *
 * ★★ 而且手機上篩選是收起來的。動作在裡面就會跟著被收走 ——
 *   「新增」是這一頁最常按的按鈕,不該藏在「篩選」後面。
 *   放外面就永遠看得到,不需要 CSS 去豁免它。
 *
 * ============================================================
 * 【順序:筆數 → 主要 → 次要 → 下載 → 回收桶】
 *
 * ★ 筆數在最左（手機用 `mr-auto` 頂到左邊）—— 它是「這批資料」的說明,
 *   而右邊那些是對這批資料做的事。
 *
 * ★★ 主要動作（實心藍）**一頁只有一顆**。多一顆就不再是「主要」了。
 *   次要動作用白底外框、下載用綠外框（見 components/Actions.tsx）。
 */
export function ActionRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
      {children}
    </div>
  );
}
