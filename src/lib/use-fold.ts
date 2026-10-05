'use client';
import { useEffect, useState } from 'react';

/**
 * 一塊面板收起來／展開，記在這台瀏覽器上（2026-10-05 David：請款排程、跨月欠款、待開發票「收納」）。
 * ★ localStorage 讀寫都包 try/catch —— 無痕模式或被擋時就用預設值，不讓整頁壞掉。
 * ★ 第一次 render 用預設值，掛載後才讀 —— 伺服器那一輪沒有 localStorage，直接讀會 hydration 不一致。
 */
export function useFold(key: string, defaultOpen = false): [boolean, () => void] {
  const k = 'fold:' + key;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(k);
      if (v === '1' || v === '0') setOpen(v === '1');
    } catch { /* 讀不到就用預設 */ }
  }, [k]);
  const toggle = () => setOpen((o) => {
    const n = !o;
    try { window.localStorage.setItem(k, n ? '1' : '0'); } catch { /* 存不了就算了 */ }
    return n;
  });
  return [open, toggle];
}
