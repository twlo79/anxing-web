'use client';
import { ReactNode, useState } from 'react';

/**
 * 標題列右上角的「模式開關 ＋ ⓘ 說明」。
 *
 * ============================================================
 * 【誰在用】
 *
 *   👀 防呆     訂單、營收（`components/Audit.tsx` 的 AuditButton）
 *   ★ 重要支出  支出（原本是篩選列裡的「☆ 關注」按鈕）
 *
 * 兩個都是**模式**不是動作：按下去之後整個列表的意義就變了
 * （多出標記／只剩一部分列），而不是「做一件事然後回到原狀」。
 * 模式開關要長得像開關 —— 所以是滑軌，不是按鈕。
 *
 * ============================================================
 * 【★★ 為什麼從篩選列搬到標題列】（2026-08-29 使用者:
 *   「參考防呆 ⓘ 然後關注移到右上角」）
 *
 * 「☆ 關注」原本跟六個下拉排在篩選卡裡，看起來像第七個篩選欄位。
 * 但它跟那六個不是同一種東西：那六個是「這一批資料要留哪些」，
 * 而它是「這一頁現在用哪個模式在看」。
 *
 * ★ 而且篩選列在手機上是收起來的 —— 模式開關被收走就找不到了。
 *
 * ============================================================
 * 【★★★ 三條從防呆學來的規矩】
 *
 * 1. **沒有外框。** 它跟標題同一列，而標題列不該有按鈕的框 ——
 *    那一列只有「這是哪一頁」跟這一顆，加了框就變成兩個東西在搶注意力。
 *
 * 2. **滑軌是唯一的狀態訊號，所以顏色與位置兩個都要。**
 *    只靠顏色的話色弱或縮圖時分不出開關；只靠位置的話太小聲。
 *    開啟時文字也一起變色。
 *
 * 3. **ⓘ 是獨立的按鈕，不是包在開關裡。**
 *    包在裡面的話，想看說明就得先把它打開 ——
 *    而那正是他還不確定要不要打開的時候。
 */

export type ToggleTone = 'red' | 'amber' | 'violet';

const TONE: Record<ToggleTone, { text: string; hover: string; track: string }> = {
  red: { text: 'text-red-700', hover: 'hover:bg-red-50', track: 'bg-red-500' },
  amber: { text: 'text-amber-700', hover: 'hover:bg-amber-50', track: 'bg-amber-500' },
  /*
   * ★ 紫色給「非營運」——刻意**不用** mor 色盤裡的任何一個。
   *   綠＝已收、藍＝主色與押金、琥珀＝訂金與重要、紅＝警示或支出方向,
   *   四個都有語意了（見 anxing-ui skill 的色盤表）。
   *   非營運是第五種意思,借用任何一個都會讓那個顏色失去原本的意思。
   */
  violet: { text: 'text-violet-700', hover: 'hover:bg-violet-50', track: 'bg-violet-500' },
};

export default function ToggleInfo({
  label, on, onToggle, tone = 'red', busy, busyText, infoLabel, children,
}: {
  /** 開關上的字。含圖示，例如 `👀 防呆`、`★ 重要支出`。 */
  label: ReactNode;
  on: boolean;
  onToggle: () => void;
  tone?: ToggleTone;
  busy?: boolean;
  busyText?: string;
  /** 給讀螢幕的人聽的 ⓘ 說明，例如「防呆會檢查什麼」。 */
  infoLabel: string;
  /** ⓘ 展開後的內容。★ 只能放 inline 元素 —— 外層是 `<span>`。 */
  children: ReactNode;
}) {
  const [info, setInfo] = useState(false);
  const c = TONE[tone];

  return (
    <span className="relative inline-flex items-center gap-1">
      <button type="button" onClick={onToggle} disabled={busy}
        role="switch" aria-checked={on}
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-ui font-medium
                    whitespace-nowrap transition-colors disabled:opacity-50 ${
          on ? `${c.text} ${c.hover}` : 'text-gray-500 hover:bg-mor-sand/60'}`}>
        <span>{label}</span>
        <span aria-hidden
          className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${
            busy ? 'bg-gray-300' : on ? c.track : 'bg-gray-300'}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
            on ? 'left-[1.125rem]' : 'left-0.5'}`} />
        </span>
        {busy && busyText && <span className="text-xs text-gray-500">{busyText}</span>}
      </button>

      <button type="button" onClick={() => setInfo((v) => !v)}
        aria-expanded={info} aria-label={infoLabel}
        /* ★ 保留 w-6 h-6 —— 沒有框也要有手指點得到的面積 */
        className={`w-6 h-6 shrink-0 rounded-full text-xs leading-none transition-colors ${
          info ? 'bg-mor-bluelight text-mor-slate' : 'text-gray-400 hover:text-mor-slate'}`}>
        ⓘ
      </button>

      {info && (
        <>
          {/* 點外面關掉。★ 不用 onBlur —— 點面板裡的文字也會觸發 blur */}
          <span className="fixed inset-0 z-40" onClick={() => setInfo(false)} />
          <span className="absolute top-full right-0 z-50 mt-1 block w-[min(20rem,calc(100vw-2rem))]
                           rounded-xl border border-mor-line bg-white p-3 shadow-lg text-left">
            {children}
          </span>
        </>
      )}
    </span>
  );
}
