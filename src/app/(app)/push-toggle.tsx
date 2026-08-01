'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';

/** VAPID 公鑰是 base64url,轉成 Push API 要的 Uint8Array */
function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type State = 'loading' | 'unsupported' | 'ios-need-install' | 'off' | 'on' | 'denied';

export default function PushToggle() {
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const check = useCallback(async () => {
    if (typeof window === 'undefined') return;
    // 環境變數沒設就整個不顯示。少了這道防護,使用者按「開啟」會直接拋例外,
    // 而且錯誤訊息看不出是伺服器少設定 —— 這在重建主機時很容易發生。
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) { setState('unsupported'); return; }
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    // iOS 只開放給「已加到主畫面」的 web app,一般 Safari 分頁連 PushManager 都沒有。
    // 這種情況要明確告訴使用者怎麼做,不能只說「不支援」。
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState(isIOS && !standalone ? 'ios-need-install' : 'unsupported');
      return;
    }
    if (isIOS && !standalone) { setState('ios-need-install'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setState(sub ? 'on' : 'off');
  }, []);

  useEffect(() => { check(); }, [check]);

  async function call(action: string, subscription: PushSubscription) {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (session?.access_token ?? '') },
      body: JSON.stringify({ action, subscription: subscription.toJSON() }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || String(r.status));
  }

  async function enable() {
    setBusy(true); setMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
      });
      await call('subscribe', sub);
      setState('on'); setMsg('已開啟,這台裝置會收到核可通知');
    } catch (e) {
      setMsg('開啟失敗:' + (e as Error).message);
    } finally { setBusy(false); setTimeout(() => setMsg(''), 4000); }
  }

  async function disable() {
    setBusy(true); setMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await call('unsubscribe', sub); await sub.unsubscribe(); }
      setState('off'); setMsg('已關閉');
    } catch (e) {
      setMsg('關閉失敗:' + (e as Error).message);
    } finally { setBusy(false); setTimeout(() => setMsg(''), 4000); }
  }

  if (state === 'loading' || state === 'unsupported') return null;

  const box = 'rounded-xl border px-4 py-3 text-sm flex items-center gap-3';

  if (state === 'ios-need-install') {
    return (
      <div className={`${box} border-mor-line bg-white text-gray-600 mb-3`}>
        <span className="text-lg">🔔</span>
        <div className="text-xs leading-relaxed">
          要收核可通知,請用 Safari 開啟後點<b>分享</b>→<b>加入主畫面</b>,
          再從主畫面的圖示進來開啟。iPhone 只允許已安裝的 App 發送通知。
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className={`${box} border-amber-300 bg-amber-50 text-amber-800 mb-3`}>
        <span className="text-lg">🔕</span>
        <div className="text-xs leading-relaxed">
          通知權限已被封鎖。要重新開啟,請到瀏覽器或系統的網站設定把通知改成「允許」。
        </div>
      </div>
    );
  }

  return (
    <div className={`${box} border-mor-line bg-white mb-3`}>
      <span className="text-lg">{state === 'on' ? '🔔' : '🔕'}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium">核可通知</div>
        <div className="text-xs text-gray-500">{msg || (state === 'on' ? '這台裝置已開啟' : '有待核可的請款單時通知我')}</div>
      </div>
      <button onClick={state === 'on' ? disable : enable} disabled={busy}
        className={`h-10 px-4 rounded-lg text-sm font-medium shrink-0 disabled:opacity-40 ${
          state === 'on' ? 'border border-mor-line text-gray-600' : 'bg-mor-slate text-white'
        }`}>
        {busy ? '處理中…' : state === 'on' ? '關閉' : '開啟'}
      </button>
    </div>
  );
}
