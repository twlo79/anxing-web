'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { usePush } from '../use-push';
// 刻意從 notify-kinds 而不是 lib/push 匯入 —— 後者頂層 import 了 web-push（Node 專用），
// client component 碰到它會把整包拉進瀏覽器的 bundle，而且 tsc 不會報錯
import {
  NOTIFY_KINDS, NOTIFY_LABEL, NOTIFY_DESC, NOTIFY_DEFAULT, type NotifyKind,
} from '@/lib/notify-kinds';

/**
 * 通知設定。
 *
 * 【只有一組開關】
 * 第一版做成兩區：上面「這台裝置要不要收推播」、下面「要收哪幾種」。
 * 那是照著技術結構排的 —— 推播訂閱確實是每台裝置一份、偏好是每個帳號一份。
 *
 * 但使用者看到的是兩組長得一樣的開關，而且上面那個叫「核可通知」、
 * 下面有一個叫「審核通知」—— 第一個看到的人就搞混了。
 *
 * 而且那個問題本身是多餘的：**打開「訂單通知」就是在說「我要在這台收到訂單通知」**。
 * 沒有人會想「我要訂單通知，但我不要這台裝置收到」。
 *
 * 所以現在只有一組開關。打開任何一種時順手把這台裝置訂閱起來，
 * 使用者不用知道「訂閱」這件事存在 —— 除非真的做不到（權限被封鎖、
 * iPhone 沒加到主畫面），那時候才跳出來說明。
 *
 * 【為什麼訂閱要接在點擊裡】
 * `Notification.requestPermission()` 必須由使用者的點擊觸發，不能在載入時偷做。
 * 所以是「按下開關 → 同一次點擊裡完成授權與訂閱」，不是「存檔後再補」。
 *
 * 【為什麼權限失敗仍然存偏好】
 * 偏好是跟著帳號走的，套用到所有裝置。這台 iPhone 收不到，不代表他的電腦也收不到 ——
 * 不存的話他在電腦上也永遠收不到，而且看不出為什麼。
 */

const ICON: Record<NotifyKind, string> = {
  orders: '🏨', approvals: '🧾', reviews: '⭐', cleaning: '🧹',
};

type Prefs = Record<NotifyKind, boolean>;

export default function NotifyTab() {
  const supabase = useMemo(() => createClient(), []);
  const { state, ensureSubscribed, unsubscribe } = usePush();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<NotifyKind | null>(null);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('notification_prefs')
      .select('orders, approvals, reviews, cleaning')
      .eq('user_id', user.id).maybeSingle();
    // 沒有列的時候用預設值,不要顯示空白 —— 空白會讓人以為設定壞了。
    // 存檔時會 upsert 建立那一列。
    setPrefs((data as Prefs) ?? NOTIFY_DEFAULT);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  async function toggle(kind: NotifyKind) {
    if (!prefs) return;
    const on = !prefs[kind];
    const next = { ...prefs, [kind]: on };
    setBusy(kind);
    setWarn('');

    /*
     * 打開 = 這台要收得到。順手訂閱,不另外問。
     * 一定要在存檔之前做,而且要在這一次點擊的呼叫堆疊裡 ——
     * 瀏覽器的權限詢問需要 user gesture,await 過幾層非同步之後就失效了。
     */
    /*
     * 用區域變數而不是只看 warn state —— setWarn() 不是同步的,
     * 這個函式後面要判斷「有沒有出問題」時,warn 還是舊值。
     * 這種錯不會報錯,只會讓失敗的時候仍然顯示「已開啟」。
     */
    let problem = '';
    if (on) {
      const r = await ensureSubscribed();
      // 失敗了照樣存偏好（見檔頭）,只是要講清楚這台為什麼收不到
      if (!r.ok) { problem = r.message; setWarn(r.message); }
    }

    // 先更新畫面再送出。網路慢的時候開關卡住不動,使用者會以為沒點到而連按好幾次。
    setPrefs(next);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(null); return flash('請重新登入'); }

    // upsert 而不是 update —— 帳號理論上都有列（migration_92 回填）,
    // 但少了任何一條路徑就會變成「按了沒反應而且不報錯」。
    const { error } = await supabase.from('notification_prefs')
      .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });

    if (error) { setBusy(null); setPrefs(prefs); return flash('儲存失敗:' + error.message); }

    // 全部關掉就解除這台的訂閱 —— 留著一個永遠收不到東西的訂閱沒有意義,
    // 而且推播服務端每次都要為它做一次白工。
    if (!NOTIFY_KINDS.some((k) => next[k]) && state === 'on') await unsubscribe();

    setBusy(null);
    if (!problem) flash(`${NOTIFY_LABEL[kind]}已${on ? '開啟' : '關閉'}`);
  }

  const anyOn = !!prefs && NOTIFY_KINDS.some((k) => prefs[k]);
  /*
   * 只有在「有開通知，但這台裝置收不到」的時候才提醒。
   *
   * 一開始就把「這台裝置」攤出來是多餘的 —— 沒開任何通知的人不需要知道
   * 推播訂閱這回事。等到他真的開了、而這台真的收不到，那才是他需要知道的時刻。
   */
  const deviceProblem = anyOn && (state === 'denied' || state === 'ios-need-install' || state === 'off');

  return (
    <div className="max-w-[720px]">
      <p className="text-xs text-gray-400 mb-4">
        設定跟著你的帳號走。打開之後這台裝置就會收到 ——
        換手機或電腦要在那台上再打開一次。
      </p>

      {msg && (
        <div className="rounded-lg bg-mor-greenlight border border-mor-green/20 px-3 py-2 text-xs text-mor-green mb-2">
          {msg}
        </div>
      )}

      {/* 這台裝置有問題才出現。沒問題的話使用者不需要知道有「訂閱」這件事 */}
      {(warn || deviceProblem) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 mb-2 flex gap-2">
          <span className="shrink-0">🔕</span>
          <div className="leading-relaxed">
            <b>這台裝置目前收不到通知。</b>
            <div className="mt-0.5">
              {warn || (state === 'denied'
                ? '通知權限被封鎖了。到瀏覽器或系統的網站設定把通知改成「允許」，再回來重新開一次。'
                : state === 'ios-need-install'
                  ? 'iPhone 要先把網站加入主畫面 —— 用 Safari 開啟後點「分享」→「加入主畫面」，再從主畫面的圖示進來。'
                  : '把下面任一個開關關掉再打開一次，重新授權。')}
            </div>
            <div className="mt-1 text-amber-700">設定已經存起來了，其他裝置照常收得到。</div>
          </div>
        </div>
      )}

      <div className="rounded-xl glass divide-y divide-mor-line/60">
        {!prefs ? (
          <div className="px-4 py-10 text-center text-sm text-gray-400">載入中…</div>
        ) : NOTIFY_KINDS.map((k) => (
          /*
            整列是一顆按鈕，不是「文字 + 旁邊一個小開關」。
            手機上點名稱、點說明、點開關都會切換 —— 只有右邊那個方塊能點的話很容易點空。
            開關畫成 span 而不是巢狀 button（button 包 button 是無效的 HTML，
            而且點擊會往上冒泡觸發兩次）。
          */
          <button key={k} type="button" role="switch" aria-checked={prefs[k]}
            onClick={() => toggle(k)} disabled={busy === k}
            className="w-full flex items-center gap-3 px-4 py-3.5 text-left disabled:opacity-50 hover:bg-mor-sand/30">
            <span className="text-lg shrink-0">{ICON[k]}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium">{NOTIFY_LABEL[k]}</span>
              <span className="block text-xs text-gray-500 leading-relaxed">{NOTIFY_DESC[k]}</span>
            </span>
            <span aria-hidden
              className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${
                prefs[k] ? 'bg-mor-green' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-all ${
                prefs[k] ? 'left-[1.375rem]' : 'left-0.5'}`} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
