'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 工具列的「⋯」選單。
 *
 * ============================================================
 * 【放什麼進來，放什麼留在外面】（2026-08-16 使用者指定）
 *
 * 進來:防呆、筆數與總額、回收桶 —— **一天用不到一次**的東西。
 * 留外面:新增、下載 Excel —— 每天在用的。
 *
 * 判準不是「重不重要」而是「多久用一次」。
 * 防呆很重要，但重要的東西一天按一次也還是一天一次；
 * 而它佔的那塊寬度是每一次載入這一頁都在佔的。
 *
 * 【代價要知道】
 * 總額收進來之後，**看一眼總額變成要點一下**。
 * 那個數字原本是掃過去就看到的。這是使用者明確選的取捨（2026-08-16），
 * 不是我判斷它不重要。
 *
 *
 * ============================================================
 * 【為什麼不用 <details>】
 *
 * `<details>` 免費送收合，但**點外面不會關**。
 * 一個關不掉的浮層在表格上方，滑鼠移開之後還蓋著下面兩列 ——
 * 而使用者不會想到要回去點它一次。
 */

export default function OverflowMenu({
  children, label = '更多', width = 230,
}: {
  children: ReactNode;
  label?: string;
  /** 選單寬度。內容不同頁不一樣寬，但同一頁要固定 —— 會變寬的選單看起來像在抖 */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    /*
     * 點外面關掉。用 mousedown 而不是 click ——
     * click 要等放開，中間那段時間選單還開著，
     * 而使用者是在「按下去」的當下就認為它該關了。
     */
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-colors
                    ${open
                      ? 'border-mor-slate bg-mor-slate/[0.12] text-mor-slate'
                      : 'border-mor-line text-gray-500 hover:bg-mor-sand/60 hover:text-gray-700'}`}>
        {/* 三個點。用 SVG 而不是「⋯」字元 —— 那個字元在 Windows 上會被
            算成標點而貼在框的底部，看起來像沒對齊 */}
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4" aria-hidden>
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {open && (
        /*
         * 靠右對齊 —— 這顆通常在工具列右側，靠左展開會超出畫面。
         * z-50 是因為下面就是表格的 sticky 表頭。
         */
        <div role="menu" style={{ width }}
          className="absolute right-0 top-full mt-1 z-50 rounded-xl border border-mor-line
                     bg-white shadow-lg p-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** 選單裡的一列（可按的）。整列可點,不是只有文字 —— 在 230px 寬裡點空很容易 */
export function MenuItem({
  icon, children, onClick, right,
}: {
  icon?: ReactNode; children: ReactNode; onClick: () => void; right?: ReactNode;
}) {
  return (
    <button role="menuitem" onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left
                 hover:bg-mor-sand/60 transition-colors">
      {icon && <span className="shrink-0 w-4 flex justify-center text-gray-400">{icon}</span>}
      <span className="flex-1 min-w-0">{children}</span>
      {right}
    </button>
  );
}

/** 選單裡的分隔線 */
export const MenuSep = () => <div className="my-1 border-t border-mor-line/70" />;

/** 選單裡「只能看的」一塊（筆數、總額）。不是按鈕 —— 沒有 hover 才不會讓人以為點得下去 */
export function MenuInfo({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-2">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-[15px] font-semibold mt-0.5">{value}</div>
    </div>
  );
}
