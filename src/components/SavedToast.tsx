'use client';
import { useEffect, useRef, useState } from 'react';
import { SAVED_EVENT, SAVED_TOAST_MS } from '@/lib/saved-feedback';

/**
 * 全站的「已儲存」綠字（lib/saved-feedback.ts 的 ②）。掛在 (app)/layout.tsx，只有這一份。
 *
 * ★ z-[60]：在所有編輯視窗（z-50）之上 —— 2026-09-30 請款單就是成功訊息被視窗蓋住，
 *   使用者以為沒存進去。
 * ★ 新的一句會取消上一句的計時器，不然連存兩筆時第一句的 2.5 秒會把第二句提早收掉。
 * ★ 位置跟 components/Toast.tsx 的成功樣式一樣（上方置中）—— 兩個都在的話同一個位置同一個長相。
 */
export default function SavedToast() {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const t = String((e as CustomEvent).detail ?? '');
      if (!t) return;
      if (timer.current) clearTimeout(timer.current);
      setMsg(t);
      timer.current = setTimeout(() => { timer.current = null; setMsg(''); }, SAVED_TOAST_MS);
    };
    window.addEventListener(SAVED_EVENT, on);
    return () => {
      window.removeEventListener(SAVED_EVENT, on);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!msg) return null;
  return (
    <div role="status" aria-live="polite"
      className="fixed z-[60] left-1/2 -translate-x-1/2 px-4 w-full max-w-lg pointer-events-none"
      style={{ top: 'max(1rem, env(safe-area-inset-top))' }}>
      <div className="w-full text-sm rounded-xl bg-mor-greenlight text-mor-greendark border border-mor-green/30
                      px-4 py-2.5 font-medium shadow-lg shadow-black/10">
        ✓ {msg}
      </div>
    </div>
  );
}

/** 「剛剛儲存」小籤。表格第一格或卡片標題前面 */
export function SavedBadge() {
  return (
    <span className="inline-block rounded-md bg-amber-400 px-2 py-0.5 mr-1.5 text-xs font-bold text-white align-middle whitespace-nowrap">
      剛剛儲存
    </span>
  );
}
