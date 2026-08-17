'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * 這台裝置的推播訂閱。
 *
 * 【為什麼是 hook 而不是一顆開關】
 * 原本是獨立的「開啟通知」按鈕，跟下面的通知種類並排 —— 使用者看到兩組開關，
 * 而它們其實是前提關係（上面關掉，下面全開也收不到）。
 *
 * 但那個前提**沒有必要讓使用者知道**：他打開「訂單通知」就是在說
 * 「我要在這台收到訂單通知」，系統自己去訂閱就好。
 * 多一顆開關只是把實作細節（瀏覽器權限 + Push 訂閱）攤給使用者處理。
 *
 * 所以改成：打開任何一種通知時順手訂閱，只有在**真的做不到**的時候才出聲。
 *
 * 【唯一擋不掉的那一步】
 * `Notification.requestPermission()` 一定會跳瀏覽器原生的詢問視窗，
 * 而且**必須由使用者的點擊觸發**（user gesture）—— 不能在頁面載入時偷偷做。
 * 所以訂閱要接在「按下開關」那一次點擊裡完成，不能等存檔回來再做。
 */

/** VAPID 公鑰是 base64url,轉成 Push API 要的 Uint8Array */
function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushState =
  /** 還在檢查 */
  | 'loading'
  /** 這個瀏覽器/環境根本不支援,或伺服器沒設 VAPID 金鑰 */
  | 'unsupported'
  /** iPhone 要先「加入主畫面」才能收通知 */
  | 'ios-need-install'
  /** 支援但還沒訂閱 */
  | 'off'
  /** 已訂閱 */
  | 'on'
  /** 使用者或系統封鎖了通知權限,程式救不回來 */
  | 'denied';

export type EnsureResult = { ok: true } | { ok: false; state: PushState; message: string };

const MESSAGE: Record<string, string> = {
  unsupported: '這個瀏覽器不支援推播通知。設定會存起來，換一台裝置就收得到。',
  'ios-need-install': 'iPhone 要先把網站加入主畫面才能收通知 —— 用 Safari 開啟後點「分享」→「加入主畫面」，再從主畫面的圖示進來。',
  denied: '通知權限被封鎖了。到瀏覽器或系統的網站設定把通知改成「允許」，再回來重新開一次。',
};

export function usePush() {
  const [state, setState] = useState<PushState>('loading');

  const check = useCallback(async () => {
    if (typeof window === 'undefined') return;
    // 環境變數沒設就當成不支援。少了這道防護,按下去會直接拋例外,
    // 而且錯誤訊息看不出是伺服器少設定 —— 這在重建主機時很容易發生。
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) { setState('unsupported'); return; }

    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    // iOS 只開放給「已加到主畫面」的 web app,一般 Safari 分頁連 PushManager 都沒有。
    // 這種情況要明確說怎麼做,不能只說「不支援」。
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState(isIOS && !standalone ? 'ios-need-install' : 'unsupported');
      return;
    }
    if (isIOS && !standalone) { setState('ios-need-install'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }

    const reg = await navigator.serviceWorker.ready;
    setState((await reg.pushManager.getSubscription()) ? 'on' : 'off');
  }, []);

  useEffect(() => { check(); }, [check]);

  async function call(action: string, subscription: PushSubscription) {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (session?.access_token ?? ''),
      },
      body: JSON.stringify({ action, subscription: subscription.toJSON() }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || String(r.status));
  }

  /**
   * 確保這台裝置訂閱得起來。已經訂閱就直接回 ok。
   *
   * **必須在使用者的點擊事件裡呼叫** —— requestPermission() 需要 user gesture。
   */
  const ensureSubscribed = useCallback(async (): Promise<EnsureResult> => {
    if (state === 'on') return { ok: true };
    if (state === 'unsupported' || state === 'ios-need-install' || state === 'denied')
      return { ok: false, state, message: MESSAGE[state] };

    try {
      /*
       * 【為什麼要 race 一個逾時】
       *
       * `Notification.requestPermission()` 回傳的 Promise **可能永遠不 resolve**。
       *
       * Chrome 的「安靜通知請求」（quieter notification permissions）不跳彈窗，
       * 而是在網址列右邊放一個很小的鈴鐺圖示。使用者不會注意到它，
       * 而在他點下那個圖示之前，這個 await **就停在這裡**。
       *
       * 沒有逾時的話後面的程式一行都不會跑 —— 按鈕永遠停在「啟用中…」，
       * 而畫面上沒有任何東西說明在等什麼。
       *
       * 15 秒之後放棄並明講鈴鐺在哪。放棄不代表失敗:
       * 他點了鈴鐺按允許之後，「重新檢查」就會看到。
       */
      const perm = await Promise.race([
        Notification.requestPermission(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15000)),
      ]);
      if (perm === 'timeout') {
        return { ok: false, state: 'off',
          message: '瀏覽器沒有跳出詢問視窗 —— Chrome 可能把它縮成網址列右邊的小鈴鐺 🔔。'
                 + '點那個鈴鐺選「允許」，再按「重新檢查」。' };
      }
      if (perm !== 'granted') {
        const s: PushState = perm === 'denied' ? 'denied' : 'off';
        setState(s);
        return { ok: false, state: s, message: MESSAGE.denied };
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
      });
      await call('subscribe', sub);
      setState('on');
      return { ok: true };
    } catch (e) {
      return { ok: false, state: 'off', message: '開啟通知失敗:' + (e as Error).message };
    }
  }, [state]);

  /**
   * 對這台裝置發一則測試通知。
   *
   * 【為什麼需要它】
   * 推播失敗**沒有任何徵兆** —— 訂閱存進去了、開關是綠的、
   * 而通知就是不會跳出來。使用者唯一的驗證方式是「等下一則真的通知」，
   * 而那可能是三天後，那時他已經不記得今天調過什麼。
   *
   * 這顆按鈕把「有沒有真的通」從等待變成一次點擊。
   *
   * **不寫進 notifications 表** —— 測試訊息混進「新訊息」分頁，
   * 那一頁就開始有雜訊，而那一頁存在的理由正是「這裡只有真的事情」。
   */
  const sendTest = useCallback(async (): Promise<string> => {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + (session?.access_token ?? ''),
        },
        body: JSON.stringify({ action: 'test' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return '測試失敗：' + (j.error || String(r.status));
      /*
       * sent 是「推播服務收下了幾則」，不是「跳出來幾則」。
       * 說成「已送出」而不是「已收到」—— 送出去之後還有作業系統的
       * 專注模式、勿擾、通知中心設定，那些這裡看不到。
       */
      if (!j.sent) return '你的帳號目前沒有任何裝置訂閱成功。先按上面的「在這台裝置啟用」。';
      return `已送出 ${j.sent} 則到你的 ${j.subscriptions} 台裝置。沒跳出來的話看下面第 3 步。`;
    } catch (e) {
      return '測試失敗：' + (e as Error).message;
    }
  }, []);

  /**
   * 解除這台裝置的訂閱。
   *
   * 全部通知都關掉時呼叫 —— 留著一個永遠收不到東西的訂閱沒有意義，
   * 而且推播服務端每次都要為它做一次白工。
   */
  const unsubscribe = useCallback(async () => {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await call('unsubscribe', sub); await sub.unsubscribe(); }
      setState('off');
    } catch { /* 解除失敗不影響使用者,下次還會再試 */ }
  }, []);

  /*
   * 重新檢查權限狀態。
   *
   * 【為什麼一定要有】
   * `Notification.permission` 是在頁面載入時讀一次的快照。使用者到 Chrome 設定
   * 把封鎖改成允許之後，**這個頁面完全不知道** —— React 裡的 state 還是 'denied'，
   * 而 denied 會讓 ensureSubscribed() 連試都不試就回失敗。
   *
   * 沒有這支的話，唯一的出路是整頁重新整理，而畫面上沒有任何地方寫著要這麼做。
   */
  return { state, ensureSubscribed, unsubscribe, sendTest, recheck: check };
}
