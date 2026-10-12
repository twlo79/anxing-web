'use client';
import { useEffect, useState } from 'react';

/**
 * 手機版（< md，767px 以下）。卡片與移房在手機上是**底部抽屜**，桌機是小卡片／右側抽屜。
 * ★ 一開始回 false（伺服器端沒有視窗），掛上之後才量 —— 不在 render 裡讀 window。
 * （2026-10-12 從房源狀態頁搬出來，訂單頁的移房也要用）
 */
export function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 767px)');
    const f = () => setM(q.matches);
    f(); q.addEventListener('change', f);
    return () => q.removeEventListener('change', f);
  }, []);
  return m;
}
