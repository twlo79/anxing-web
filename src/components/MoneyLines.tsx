'use client';
import { useState } from 'react';
import {
  blankLine, isTwd, lineTwd, totalTwd, TWD,
  CURRENCIES, isKnownCurrency, currencyLabel, type Line,
} from '@/lib/money-lines';
import MoneyInput from '@/components/MoneyInput';
import Req from '@/components/Req';

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

const OTHER = '__other__';

export default function MoneyLines({
  lines, onChange, mode, label, hint, disabled = false, action, invalid, required,
}: {
  lines: Line[];
  onChange: (next: Line[]) => void;
  mode: 'revenue' | 'deposit';
  label: string;
  hint?: string;
  disabled?: boolean;
  /** 必填但總額是 0 —— 台幣那一列畫紅框 */
  invalid?: boolean;
  /** 標題後面加紅色星號。用元件而不是在 label 字串裡打 `*` ——
      那個星號會是灰的,跟其他必填欄位對不起來 */
  required?: boolean;
  /** 標題右邊的額外連結（例如「到押金管理」）。 */
  action?: React.ReactNode;
}) {
  const withRate = mode === 'revenue';
  /**
   * 哪幾列切成了自由輸入。
   *
   * 選單收了 19 種幣別，覆蓋實際會收到的絕大多數，但不該是死路 ——
   * 選「其他」就把那一列換成文字框。用索引記是因為這時 cur 還是空的，
   * 沒有別的東西可以當識別。
   */
  const [custom, setCustom] = useState<Set<number>>(new Set());
  const markCustom = (i: number, on: boolean) => setCustom((s) => {
    const n = new Set(s); if (on) n.add(i); else n.delete(i); return n;
  });

  const upd = (i: number, patch: Partial<Line>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const del = (i: number) => {
    onChange(lines.filter((_, idx) => idx !== i));
    // 索引會往前移，自由輸入的標記要跟著搬，否則刪一列之後換成別列變成文字框
    setCustom((s) => new Set([...s].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x))));
  };

  return (
    <div className="col-span-2 rounded-lg border border-mor-line p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-gray-500 flex items-center">{label}{required && <Req />}</span>
        <span className="flex items-center gap-3">
          {action}
          {!disabled && (
            <button type="button" onClick={() => onChange([...lines, blankLine(lines)])}
              className="text-xs text-mor-blue underline hover:text-mor-slate">+ 新增幣別</button>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {lines.map((l, i) => {
          // 台幣那一列是骨架的一部分：不能刪、不能改幣別、匯率恆為 1。
          // 允許改的話使用者可以把它變成 USD，然後就沒有台幣欄位了。
          const locked = isTwd(l.cur) && i === 0;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              {locked ? (
                <span className="w-24 h-11 md:h-8 rounded-lg bg-mor-bluelight text-mor-slate
                                 text-xs font-medium flex items-center justify-center shrink-0">{TWD}</span>
              ) : custom.has(i) ? (
                // 選了「其他」的那一列。旁邊留一個「選單」把它切回去，免得選錯了出不來。
                <span className="flex items-center gap-1 shrink-0">
                  <input value={l.cur} disabled={disabled} autoFocus maxLength={5}
                    onChange={(e) => upd(i, { cur: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
                    placeholder="代碼" className={`${CTRL} w-16 uppercase`} />
                  <button type="button" onClick={() => { markCustom(i, false); upd(i, { cur: '' }); }}
                    className="text-[11px] text-mor-blue underline">選單</button>
                </span>
              ) : (
                /*
                  下拉而不是自由輸入 —— 自由輸入會長出 usd / Usd / US$ / 美金
                  這種同一種幣別的好幾種寫法，而營收報表是按幣別字串分組的，
                  分組會裂開而且不會有人發現。
                */
                <select value={isKnownCurrency(l.cur) || !l.cur ? l.cur : l.cur} disabled={disabled}
                  onChange={(e) => {
                    if (e.target.value === OTHER) { markCustom(i, true); upd(i, { cur: '' }); return; }
                    upd(i, { cur: e.target.value });
                  }}
                  className={`${CTRL} w-24 shrink-0`}>
                  <option value="">幣別</option>
                  {/* 舊資料若是選單沒收的幣別，要保留成一個選項，否則一存檔就被清掉 */}
                  {l.cur && !isKnownCurrency(l.cur) && <option value={l.cur}>{l.cur}</option>}
                  {CURRENCIES.filter((c) => c.code !== TWD).map((c) => (
                    <option key={c.code} value={c.code}>{currencyLabel(c.code)}</option>
                  ))}
                  <option value={OTHER}>其他（自行輸入）</option>
                </select>
              )}

              {/* 千分位。196000 跟 19600 在沒有分隔的一串數字裡
                  要一位一位數才看得出差別 —— 而那正是「少打一個 0」的來源 */}
              <MoneyInput value={l.amt} disabled={disabled}
                onChange={(n) => upd(i, { amt: n })}
                invalid={i === 0 && invalid}
                className={`${CTRL} flex-1 min-w-[6rem] text-right`} />

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
