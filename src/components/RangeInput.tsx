'use client';
import { syncFrom, syncTo, isReversed } from '@/lib/date-range';

/**
 * 起訖篩選（日期或月份）。全站唯一一份。
 *
 * ============================================================
 * 【★★ 為什麼要做成元件，而不是在九個地方各補三行】
 *
 * 連動規則本身只有幾行，抄九次也不會抄錯。
 * 真正的問題是**第十個地方**：下次誰新增一個篩選，
 * 他會照旁邊的樣子寫兩個 `<input>` —— 而旁邊的樣子看起來就是兩個獨立輸入。
 *
 * 規則要跟輸入框綁在同一個東西上，才不會有「忘了加連動」這種狀態。
 *
 * ★ 連動邏輯本身在 `src/lib/date-range.ts`（`.ts` 才測得到）。
 *   這裡只負責畫面。
 *
 *
 * ============================================================
 * 【用法】
 *
 *   <RangeInput kind="month" from={fromM} to={toM}
 *     onChange={(f, t) => { setFromM(f); setToM(t); }} />
 *
 * ★ `onChange` 一次給兩個值 —— 不是兩個 callback。
 *   分開的話呼叫端會寫成「起點的 onChange 只 setFrom」,
 *   那就繞過連動了,而且看起來完全正常。
 */
export default function RangeInput({
  kind = 'date', from, to, onChange, className = '', inputClass = '', disabled,
}: {
  kind?: 'date' | 'month';
  from: string;
  to: string;
  /** ★ 一次給兩個值。呼叫端把兩個 state 都設掉 */
  onChange: (from: string, to: string) => void;
  className?: string;
  /**
   * 兩個輸入框額外的 class（手機加高、`flex-1` 之類）。
   *
   * ★ 只吃**尺寸與排版**。框線與底色由這裡決定 ——
   *   區間反了要變琥珀色，呼叫端蓋掉的話那個警示就沒了。
   */
  inputClass?: string;
  disabled?: boolean;
}) {
  /*
   * ★ 反的區間照理不會出現（連動擋掉了）,但**舊網址與書籤沒有經過連動**。
   *   那條路進來的話畫面會是一句無辜的「$0・0 筆」——
   *   而那句話跟「這個月真的沒有營收」長得一模一樣。
   *   所以還是要看得出來。
   */
  const bad = isReversed(from, to);
  const cls = `rounded-lg border px-2 py-1.5 min-w-0 ${
    bad ? 'border-amber-400 bg-amber-50' : 'border-gray-300'} ${inputClass}`;

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <input type={kind} value={from} disabled={disabled} className={cls}
          onChange={(e) => { const r = syncFrom(e.target.value, to); onChange(r.from, r.to); }} />
        <span className="text-gray-400 shrink-0">~</span>
        <input type={kind} value={to} disabled={disabled} className={cls}
          /* ★ 迄點不能早於起點 —— 原生的日期選擇器會直接把更早的日子擋掉,
               比事後糾正好:使用者根本不會選到那一天 */
          min={from || undefined}
          onChange={(e) => { const r = syncTo(from, e.target.value); onChange(r.from, r.to); }} />
      </div>
      {bad && (
        <div className="mt-1 text-[11px] text-amber-700">
          起迄反了（{from} 晚於 {to}），這樣查不到東西。
        </div>
      )}
    </div>
  );
}
