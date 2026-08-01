'use client';
import { useEffect } from 'react';

/** 註冊 service worker。沒有畫面,純副作用。 */
export default function SwRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // 等頁面載完再註冊,不跟首屏資源搶頻寬
    const go = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }, []);
  return null;
}
