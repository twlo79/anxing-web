'use client';
import { useState } from 'react';
import { fmtInt as fmt } from '@/lib/fmt';
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
 *   revenue  有匯率（**只有外幣那一列**），兩種幣別以上才顯示合計
 *   deposit  沒有匯率欄（原幣退還、不換匯），也沒有合計（不同幣別相加沒有意義）
 *
 * ══════════════════════════════════════════════════════════
 * 【2026-09-16 改版：bare 模式】
 *
 * 使用者:「給我感覺太多獨立框」「金額框盡量對齊」。
 *
 * 改版前這個元件自帶一個外框與一行標題，於是訂單金額、押金各是一個框，
 * 中間還夾著別的框 —— 一個視窗裡五個長方形，而它們代表的東西不一樣。
 *
 * `bare` 打開之後它**只吐出幾列**，外框與分段交給呼叫端。
 * 這樣訂單金額、訂金、押金、寵物押金可以排進**同一組欄寬**裡，
 * 金額框的左緣才切得齊 —— 那是各自畫一個框時做不到的。
 *
 * ★★ 欄寬用下面這兩個常數，呼叫端畫自己的列時**要用同一組**。
 *   各自寫死數字的話，改一邊就會歪掉而且沒有人會發現。
 * ══════════════════════════════════════════════════════════
 *
 * 【手機】
 * 一列拆成兩行 —— 五個欄位擠在 375px 會全部變成 30px 寬的小格子。
 */

const CTRL = 'h-11 md:h-8 bg-white rounded-lg border border-mor-line px-2 text-sm';

/** 左邊標籤欄。呼叫端自己畫「訂金」「寵物押金」那幾列時要用同一個 */
export const ML_LABEL = 'w-[4.5rem] shrink-0 text-xs text-gray-600';
/** 幣別欄（籤或下拉）。同上 */
export const ML_CUR = 'w-24 shrink-0';

const OTHER = '__other__';

export default function MoneyLines({
  lines, onChange, mode, label, hint, disabled = false, action, invalid, required, footer,
  bare = false,
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
  /** 最後一列右邊的額外連結（例如「＋ 寵物押金」）。 */
  action?: React.ReactNode;
  /** 幣別各列**底下**的額外內容。 */
  footer?: React.ReactNode;
  /**
   * 不要外框與標題列，只吐出幾列（2026-09-16）。
   * 標籤變成第一列左邊的那一格，跟呼叫端自己畫的列排在同一組欄寬裡。
   */
  bare?: boolean;
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

  const addBtn = !disabled && (
    <button type="button" onClick={() => onChange([...lines, blankLine(lines)])}
      className="text-xs text-mor-slate hover:text-mor-slatedark">＋ 幣別</button>
  );

  const rows = (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => {
        // 台幣那一列是骨架的一部分：不能刪、不能改幣別、匯率恆為 1。
        // 允許改的話使用者可以把它變成 USD，然後就沒有台幣欄位了。
        const locked = isTwd(l.cur) && i === 0;
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            {/*
              ★ 第一列放標題，其餘列留一個同寬的空格 ——
                空格拿掉的話第二列整排會往左跑，金額框就對不齊了。
            */}
            {bare && (
              <span className={`${ML_LABEL} flex items-center`}>
                {i === 0 ? <>{label}{required && <Req />}</> : null}
              </span>
            )}
            {locked ? (
              <span className={`${ML_CUR} h-11 md:h-8 rounded-lg bg-mor-bluelight text-mor-slate
                               text-xs font-medium flex items-center justify-center`}>{TWD}</span>
            ) : custom.has(i) ? (
              // 選了「其他」的那一列。旁邊留一個「選單」把它切回去，免得選錯了出不來。
              <span className={`${ML_CUR} flex items-center gap-1`}>
                <input value={l.cur} disabled={disabled} autoFocus maxLength={5}
                  onChange={(e) => upd(i, { cur: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
                  placeholder="代碼" className={`${CTRL} w-16 uppercase`} />
                <button type="button" onClick={() => { markCustom(i, false); upd(i, { cur: '' }); }}
                  className="text-[11px] text-mor-slate">選單</button>
              </span>
            ) : (
              /*
                下拉而不是自由輸入 —— 自由輸入會長出 usd / Usd / US$ / 美金
                這種同一種幣別的好幾種寫法，而營收報表是按幣別字串分組的，
                分組會裂開而且不會有人發現。
              */
              <select value={l.cur} disabled={disabled}
                onChange={(e) => {
                  if (e.target.value === OTHER) { markCustom(i, true); upd(i, { cur: '' }); return; }
                  upd(i, { cur: e.target.value });
                }}
                className={`${CTRL} ${ML_CUR}`}>
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

            {/*
              ★★★ 匯率只長在**外幣那一列**（2026-09-16 使用者:「匯率換算怎麼記」）。
                台幣列的匯率永遠是 1，而「匯率 1　$175,800」等於把
                「1 乘以 175,800 等於 175,800」寫在畫面上 ——
                九成的單只有台幣，那兩格就永遠是那個樣子。

                匯率是「外幣那一列」的屬性，所以它長在那一列上，
                換算結果直接寫在旁邊:700 × 32.1 = NT$ 22,470，
                一眼看得懂是怎麼算的。
            */}
            {withRate && !locked && (
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] text-gray-400">×</span>
                <input type="number" inputMode="decimal" value={l.rate || ''} disabled={disabled}
                  onChange={(e) => upd(i, { rate: parseFloat(e.target.value) || 0 })}
                  placeholder="匯率" className={`${CTRL} w-[4.5rem] text-right`} />
                <span className="text-[11px] text-gray-600 whitespace-nowrap tabular-nums">
                  = NT$ {fmt(lineTwd(l))}
                </span>
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
  );

  /*
   * ★★ 合計**只在兩種幣別以上才出現**（2026-09-16）。
   *   單一幣別時它是把上面那個數字再寫一次 —— 而它出現的時候，
   *   才真的在做加法。
   */
  const total = withRate && lines.length > 1 && (
    <div className="flex items-center justify-end gap-2 text-xs mt-2 pr-8">
      <span className="text-gray-500">營收合計</span>
      <span className="font-semibold text-mor-ink tabular-nums">NT$ {fmt(totalTwd(lines))}</span>
    </div>
  );

  if (bare) {
    return (
      <>
        {rows}
        {/* ＋幣別 與 呼叫端給的連結（例如「＋ 寵物押金」）排在標籤欄右邊，跟幣別欄對齊 */}
        {(addBtn || action) && (
          <div className="flex items-center gap-3 mt-1.5">
            <span className={ML_LABEL} />
            {addBtn}
            {action}
          </div>
        )}
        {total}
        {footer}
      </>
    );
  }

  return (
    <div className="col-span-2 rounded-lg border border-mor-line p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-gray-500 flex items-center">{label}{required && <Req />}</span>
        <span className="flex items-center gap-3">{action}{addBtn}</span>
      </div>
      {rows}
      {total}
      {footer}
      {hint && <div className="text-xs text-gray-400 mt-2">{hint}</div>}
    </div>
  );
}
