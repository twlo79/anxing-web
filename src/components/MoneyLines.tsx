'use client';
import { blankLine, isTwd, lineTwd, totalTwd, TWD, type Line } from '@/lib/money-lines';

/**
 * 多幣別金額輸入：一列一種幣別，台幣只是其中一列。
 *
 * 【為什麼台幣不再是獨立欄位】
 * 原本是「台幣一個欄位 ＋ 其他幣別一份清單」。金額能填的地方有兩處，
 * 使用者得先判斷這筆該填哪邊，而且台幣看起來像跟外幣不同的東西。
 *
 * 現在一份清單解決。台幣固定第一列、刪不掉、幣別鎖住、匯率鎖 1 ——
 * 它是最常用的那一種，不該比外幣難填：只收台幣時打開就能直接輸入。
 *
 * 【mode 的差別】
 *   revenue  有匯率，右邊即時顯示換算後的台幣，底下有合計
 *   deposit  沒有匯率欄（原幣退還、不換匯），也沒有合計（不同幣別相加沒有意義）
 *
 * 【手機】
 * 一列拆成兩行 —— 五個欄位擠在 375px 會全部變成 30px 寬的小格子。
 * 幣別＋金額一行，匯率＋換算＋刪除一行。
 */

const fmt = (n: number) => Math.round(n || 0).toLocaleString('en-US');
const CTRL = 'h-11 md:h-8 bg-white rounded-lg border border-mor-line px-2 text-sm';

export default function MoneyLines({
  lines, onChange, mode, label, hint, disabled = false,
}: {
  lines: Line[];
  onChange: (next: Line[]) => void;
  mode: 'revenue' | 'deposit';
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const withRate = mode === 'revenue';
  const upd = (i: number, patch: Partial<Line>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const del = (i: number) => onChange(lines.filter((_, idx) => idx !== i));

  return (
    <div className="col-span-2 rounded-lg border border-mor-line p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">{label}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange([...lines, blankLine(lines)])}
            className="text-xs text-mor-blue underline hover:text-mor-slate">+ 新增幣別</button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {lines.map((l, i) => {
          // 台幣那一列是骨架的一部分：不能刪、不能改幣別、匯率恆為 1。
          // 允許改的話使用者可以把它變成 USD，然後就沒有台幣欄位了。
          const locked = isTwd(l.cur) && i === 0;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              {locked ? (
                <span className="w-16 h-11 md:h-8 rounded-lg bg-mor-bluelight text-mor-slate
                                 text-xs font-medium flex items-center justify-center shrink-0">{TWD}</span>
              ) : (
                <input value={l.cur} disabled={disabled}
                  onChange={(e) => upd(i, { cur: e.target.value.toUpperCase() })}
                  placeholder="幣別" className={`${CTRL} w-16 shrink-0 uppercase`} />
              )}

              <input type="number" inputMode="numeric" value={l.amt || ''} disabled={disabled}
                onChange={(e) => upd(i, { amt: parseFloat(e.target.value) || 0 })}
                placeholder="0" className={`${CTRL} flex-1 min-w-[6rem] text-right`} />

              {withRate && (
                <div className="flex items-center gap-2 shrink-0">
                  {locked ? (
                    <span className="text-xs text-gray-400 w-[5.5rem] text-center">匯率 1</span>
                  ) : (
                    <input type="number" inputMode="decimal" value={l.rate || ''} disabled={disabled}
                      onChange={(e) => upd(i, { rate: parseFloat(e.target.value) || 0 })}
                      placeholder="匯率" className={`${CTRL} w-[5.5rem] text-right`} />
                  )}
                  {/* 當場看得出這一列值多少台幣,不用等看合計 */}
                  <span className="text-xs text-gray-600 w-20 text-right">${fmt(lineTwd(l))}</span>
                </div>
              )}

              {/* 位置固定保留 —— 台幣列沒有刪除鈕,但欄寬要一致,否則每列會對不齊 */}
              <span className="w-6 shrink-0 text-center">
                {!locked && !disabled && (
                  <button type="button" onClick={() => del(i)} aria-label="刪除這列幣別"
                    className="text-xs text-red-400 hover:text-red-600">✕</button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {withRate && (
        <div className="border-t border-mor-line mt-2 pt-2 flex items-center justify-between text-sm">
          <span className="text-gray-500 text-xs">營收合計（台幣）</span>
          <span className="font-semibold text-mor-slate">${fmt(totalTwd(lines))}</span>
        </div>
      )}
      {hint && <div className="text-xs text-gray-400 mt-2">{hint}</div>}
    </div>
  );
}
