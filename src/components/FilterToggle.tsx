'use client';
import { useEffect, useState } from 'react';

/**
 * 手機上的「篩選」開關。桌機完全不出現。
 *
 * ============================================================
 * 【要解決的問題】
 *
 * 篩選列在桌機是一排,在手機被 globals.css 拉成直的一欄 ——
 * 物業、來源、收款狀態、費用類別、日期、關鍵字六個欄位疊起來
 * 超過一個螢幕高。結果是每次進訂單頁都要先滑過整片下拉,
 * 才看得到第一筆資料。
 *
 * 而那些下拉九成的時間都停在「全部」。
 *
 *
 * ============================================================
 * 【收起來時「新增」與「下載」要留著】
 *
 * 把整條收掉最省事,但那會把「+ 新增訂單」也藏起來 ——
 * 而那是這個頁面最常按的按鈕。所以收起來的是**篩選欄位**,
 * 右側那組動作鈕（筆數／下載／新增／回收桶）永遠在。
 *
 * 實作上靠 CSS：收起時隱藏 .collapsible-filters 的直接子元素,
 * 但保留 .ml-auto 那一組。
 *
 *
 * ============================================================
 * 【有條件在篩的時候一定要看得出來】
 *
 * 收起來之後,「為什麼只有 3 筆」這個問題會失去線索 ——
 * 使用者看不到自己昨天設了日期區間。所以有任何條件時,
 * 按鈕變成主色實心並帶一個點,那是收起狀態下唯一的提示。
 */
export default function FilterToggle({ active, label = '篩選' }: {
  /** 目前有沒有套用任何條件 */
  active?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  /*
   * 開關狀態掛在 <html> 上,由 CSS 決定顯示什麼。
   *
   * 【為什麼不用 React 直接控制篩選列】
   * 篩選列的 JSX 散在六個頁面裡,各長各的。要用 React 控制就得
   * 把六個頁面都改成同一個元件包起來 —— 那是一次大改，
   * 而且每動一個頁面就多一次改壞的機會。
   *
   * 掛 class 只需要在每個頁面加一行,行為卻是一致的。
   */
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('filters-open', open);
    // 換頁時一定要清掉 —— 留著的話下一頁的篩選是展開的,
    // 而使用者並沒有按過那個按鈕
    return () => el.classList.remove('filters-open');
  }, [open]);

  return (
    <button type="button" onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className={`md:hidden mb-2 w-full flex items-center justify-center gap-1.5
                  rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-mor-slate text-white'
          : 'bg-white border border-mor-line text-gray-600 active:bg-mor-sand/60'
      }`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
        strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M4 5h16l-6 7v5l-4 2v-7z" />
      </svg>
      {open ? `收起${label}` : label}
      {/* 收起來時,這個點是「還有條件在篩」唯一的線索 */}
      {active && !open && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-white/90" />}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
        strokeLinecap="round" strokeLinejoin="round"
        className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}>
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}
