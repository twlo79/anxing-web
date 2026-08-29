'use client';
import { ReactNode, useEffect, useRef, useState } from 'react';

/**
 * 小小的 ⓘ ——「這個東西是什麼」的說明，點了才出現。
 *
 * ============================================================
 * 【為什麼需要】（2026-08-29 使用者：「只做星星 旁邊 i 點下去有說明 節省空間」）
 *
 * 篩選列上的按鈕如果只放圖示（★、⚑、⚙），版面省下來了，
 * 但**第一次看到的人不知道它是什麼** —— 而 `title` 只有滑鼠停留才看得到，
 * 手機根本沒有 hover。
 *
 * 所以圖示旁邊放一顆 ⓘ：平常只佔 18px，點下去才展開一段話。
 *
 * ============================================================
 * 【★★ 這不是 tooltip，是點擊展開】
 *
 * hover 的 tooltip 在手機上等於不存在，而「只有桌機看得到說明」
 * 就是「手機使用者永遠不知道那顆星是幹嘛的」。
 *
 * 所以：
 *   · 點擊開關（不是 hover）—— 手機也按得到
 *   · Esc 關閉、點外面關閉 —— 不會卡在畫面上
 *   · `aria-expanded` ＋ `role="tooltip"` —— 讀螢幕的人知道有東西展開了
 */
export default function InfoDot({ children, label = '說明' }: {
  children: ReactNode;
  /** 給讀螢幕的人聽的。預設「說明」，說明的是特定東西時要寫清楚（「關注是什麼」）。 */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /*
   * ★★ 點外面與 Esc 都要能關。
   *
   *   只做點擊開關的話，使用者點開之後會去點別的地方，
   *   而那段說明會留在畫面上擋住下面的欄位 —— 然後他得回頭再點一次 ⓘ。
   *
   * ★ `mousedown` 不是 `click`：click 要等放開，中間如果按在說明框上
   *   拖曳選字，放開時會被判定成「點外面」而關掉。
   */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative inline-flex">
      <button type="button" aria-label={label} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`grid h-[18px] w-[18px] place-items-center rounded-full border text-[11px] font-serif
                    leading-none transition ${open
                      ? 'border-mor-slate bg-mor-slate text-white'
                      : 'border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600'}`}>
        i
      </button>
      {open && (
        /*
         * ★ `z-30`：篩選卡有 `glass`（backdrop-blur），沒有 z 的話
         *   說明框會被下一張卡蓋掉一角。
         * ★ `w-64` 固定寬度，不要 `max-w`：跟著內容長度變寬的框
         *   會讓同一頁的兩顆 ⓘ 展開成不同大小。
         */
        <div role="tooltip"
          className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-mor-line bg-white
                     p-3 text-uisub leading-relaxed text-gray-600 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}
