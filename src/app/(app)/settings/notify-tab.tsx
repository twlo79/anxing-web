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
 *
 *
 * ============================================================
 * 【裝置區塊：為什麼又長回來了】（2026-08-16）
 *
 * 上面那段「只有一組開關」漏掉一個情況，而那個情況是常態:
 *
 *   在手機上打開通知  →  prefs 存進資料庫（**跟著帳號**）
 *   換到電腦開這一頁  →  開關全是綠的（因為 prefs 是帳號層的）
 *   但這台電腦        →  push_subscriptions 裡一列都沒有
 *
 * 而 `ensureSubscribed()` **只在 toggle() 裡被呼叫** —— 開關已經是開的，
 * 他沒有東西可以按。唯一的出路是「關掉再打開」，
 * 而關掉的那一瞬間**手機也停止收通知**（prefs 是共用的）。
 *
 * 也就是:要讓這台開始收，得先弄壞另一台。那不是設定，那是陷阱。
 *
 * 所以裝置狀態要有自己的區塊、自己的按鈕，跟偏好開關**分開**。
 * 兩者本來就是兩件事:
 *
 *   偏好（帳號）  「我要不要收到訂單通知」
 *   訂閱（裝置）  「這台機器收不收得到東西」
 *
 * 第一版把它們合成一組是對的直覺（少一個概念），但代價是
 * 第二種狀態變成無法操作的。看得見、按不到，比看不見更糟。
 *
 * 【還有一個 denied 的死結】
 * `Notification.permission` 是頁面載入時的快照。他到 Chrome 設定改成允許之後，
 * 這一頁完全不知道 —— state 還是 'denied'，而 denied 會讓 ensureSubscribed()
 * 連試都不試。所以要有「重新檢查」，不然唯一出路是 F5 而畫面沒寫。
 */

const ICON: Record<NotifyKind, string> = {
  orders: '🏨', approvals: '🧾', reviews: '⭐', cleaning: '🧹', purchasing: '🛒',
};

type Prefs = Record<NotifyKind, boolean>;

export default function NotifyTab() {
  const supabase = useMemo(() => createClient(), []);
  const { state, ensureSubscribed, unsubscribe, sendTest, recheck } = usePush();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<NotifyKind | null>(null);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');
  const [devBusy, setDevBusy] = useState('');
  const [testMsg, setTestMsg] = useState('');
  /** 存檔失敗要留在畫面上。flash 三秒就沒了,而使用者的眼睛在開關上不在頂端 */
  const [saveErr, setSaveErr] = useState('');

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('notification_prefs')
      .select('orders, approvals, reviews, cleaning, purchasing')
      .eq('user_id', user.id).maybeSingle();
    // 沒有列的時候用預設值,不要顯示空白 —— 空白會讓人以為設定壞了。
    // 存檔時會 upsert 建立那一列。
    setPrefs((data as Prefs) ?? NOTIFY_DEFAULT);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  /**
   * 切換一種通知偏好。**只存偏好，不碰訂閱。**
   *
   * ============================================================
   * 【為什麼把 ensureSubscribed() 從這裡拿掉】（2026-08-16，症狀「電腦只能開一個」）
   *
   * 原本這裡是「打開任何一種就順手訂閱」。那個順手會**卡死整個開關**:
   *
   *   `Notification.requestPermission()` 回傳的 Promise 可能永遠不 resolve ——
   *   Chrome 的「安靜通知請求」不跳彈窗，只在網址列放一個很小的鈴鐺圖示，
   *   而在使用者點它之前那個 await 就停在那裡。
   *
   * 停在那裡的後果不是「訂閱失敗」，是**下面的存檔一行都沒跑**:
   *
   *     setPrefs(next)   ← 沒跑,開關彈回去
   *     upsert           ← 沒跑,資料庫沒變
   *     setBusy(null)    ← 沒跑,那一列永遠 disabled
   *
   * 所以畫面上看到的正是「第一個開得起來（那次有回應），
   * 之後每一個按了都沒反應」。而且**完全沒有錯誤訊息** ——
   * 因為根本沒有錯，只是永遠在等。
   *
   * 【真正的修法是責任分開，不是加逾時】
   *
   * 加逾時只是讓它 15 秒後才失敗（還是加了，那是第二道防線）。
   * 根本問題是:**存偏好不需要瀏覽器權限。**
   *
   * 偏好是帳號層的資料，跟這台機器收不收得到毫無關係 ——
   * 讓一個必定成功的資料庫寫入，去等一個可能永遠不回來的瀏覽器 API，
   * 本來就是錯的順序。
   *
   * 訂閱現在是上面「這台裝置」區塊的事，它有自己的按鈕、自己的 busy。
   * 那顆卡住的時候，卡住的是那顆，不是這四個開關。
   */
  async function toggle(kind: NotifyKind) {
    if (!prefs) return;
    const on = !prefs[kind];
    const next = { ...prefs, [kind]: on };
    const prev = prefs;          // 失敗要回滾。用區域變數,不靠 closure 裡的 prefs
    setBusy(kind);

    // 先更新畫面再送出。網路慢的時候開關卡住不動,使用者會以為沒點到而連按好幾次。
    setPrefs(next);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(null); setPrefs(prev); setSaveErr('請重新登入'); return; }

    // upsert 而不是 update —— 帳號理論上都有列（migration_92 回填）,
    // 但少了任何一條路徑就會變成「按了沒反應而且不報錯」。
    const { error } = await supabase.from('notification_prefs')
      .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });

    setBusy(null);

    /*
     * 存檔失敗要**留在畫面上**，不能用 flash。
     *
     * 原本是 flash 三秒就消失 —— 而使用者按完開關的眼睛在開關上，
     * 不在畫面頂端。他看到的是「開關彈回去了，沒說為什麼」。
     */
    if (error) { setPrefs(prev); setSaveErr('儲存失敗：' + error.message); return; }
    setSaveErr('');

    // 全部關掉就解除這台的訂閱 —— 留著一個永遠收不到東西的訂閱沒有意義,
    // 而且推播服務端每次都要為它做一次白工。
    if (!NOTIFY_KINDS.some((k) => next[k]) && state === 'on') await unsubscribe();

    flash(`${NOTIFY_LABEL[kind]}已${on ? '開啟' : '關閉'}`);
  }

  /** 在這台啟用。跟偏好完全無關 —— 不動 prefs，所以按了不影響其他裝置 */
  async function enableHere() {
    setDevBusy('enable'); setTestMsg('');
    const r = await ensureSubscribed();
    setWarn(r.ok ? '' : r.message);
    if (r.ok) flash('這台裝置已啟用');
    setDevBusy('');
  }

  async function testHere() {
    setDevBusy('test');
    setTestMsg(await sendTest());
    setDevBusy('');
  }

  /** 改完瀏覽器權限之後要重讀 —— state 是載入時的快照 */
  async function recheckHere() {
    setDevBusy('recheck'); setWarn(''); setTestMsg('');
    await recheck();
    setDevBusy('');
  }

  const anyOn = !!prefs && NOTIFY_KINDS.some((k) => prefs[k]);

  return (
    <div className="max-w-[720px]">
      {/*
        把兩層關係先講清楚。不講的話「開關是綠的但收不到」永遠像故障，
        而它其實是設計 —— 偏好跟著帳號，訂閱跟著機器。
      */}
      <p className="text-xs text-gray-400 mb-3 leading-relaxed">
        <b className="text-gray-500">下面的開關跟著你的帳號走</b>，在哪台改都一樣。
        但<b className="text-gray-500">每台裝置要各自啟用一次</b> ——
        手機開好了，電腦還是要在這台按一次。
      </p>

      {msg && (
        <div className="rounded-lg bg-mor-greenlight border border-mor-green/20 px-3 py-2 text-xs text-mor-green mb-2">
          {msg}
        </div>
      )}

      {/*
        ── 這台裝置 ──────────────────────────────────
        永遠顯示，不再只在出問題時才冒出來。

        藏起來的代價:訂閱失敗時畫面跟成功時**長得一模一樣**（開關都是綠的），
        而使用者要等到下一則真的通知沒來才會發現 —— 那可能是三天後。
      */}
      <div className="rounded-xl glass px-4 py-3.5 mb-3">
        <div className="flex items-center gap-3">
          <span className="text-lg shrink-0">{state === 'on' ? '🔔' : '🔕'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">這台裝置</div>
            <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              {state === 'loading' ? '檢查中…'
                : state === 'on' ? '已啟用，收得到通知'
                : state === 'denied' ? '瀏覽器把這個網站的通知封鎖了'
                : state === 'ios-need-install' ? 'iPhone 要先把網站加入主畫面'
                : state === 'unsupported' ? '這個瀏覽器不支援推播通知'
                : '還沒啟用 —— 上面的開關是跟著帳號走的，這台要另外啟用一次'}
            </div>
          </div>
          {/* 已啟用就給測試，沒啟用就給啟用。denied 沒有按鈕能救,下面出步驟 */}
          {state === 'on' ? (
            <button onClick={testHere} disabled={!!devBusy}
              className="shrink-0 rounded-full border border-mor-line px-3.5 py-1.5 text-xs
                         hover:bg-mor-sand/60 disabled:opacity-40">
              {devBusy === 'test' ? '送出中…' : '發測試通知'}
            </button>
          ) : state === 'off' ? (
            <button onClick={enableHere} disabled={!!devBusy}
              className="shrink-0 rounded-full bg-mor-slate text-white px-3.5 py-1.5 text-xs
                         hover:opacity-90 disabled:opacity-40">
              {devBusy === 'enable' ? '啟用中…' : '在這台啟用'}
            </button>
          ) : null}
        </div>

        {/*
          被封鎖時給實際步驟，不是「到瀏覽器設定改一下」。
          那句話對不知道鎖頭圖示在哪的人等於沒說 —— 而且改完之後
          這一頁還是 denied，他會以為沒用。所以「重新檢查」要就在旁邊。
        */}
        {state === 'denied' && (
          <div className="mt-3 pt-3 border-t border-mor-line/50 text-xs text-gray-600 leading-relaxed">
            <div className="font-medium text-amber-800 mb-1">封鎖之後網站沒辦法再問你一次，只能手動解開：</div>
            <ol className="list-decimal ml-4 space-y-0.5">
              <li>點網址列<b>左邊的鎖頭圖示</b></li>
              <li>找「通知」，改成<b>「允許」</b></li>
              <li>回到這裡按下面的「重新檢查」</li>
            </ol>
            <button onClick={recheckHere} disabled={!!devBusy}
              className="mt-2.5 rounded-full border border-mor-line px-3.5 py-1.5 text-xs
                         hover:bg-mor-sand/60 disabled:opacity-40">
              {devBusy === 'recheck' ? '檢查中…' : '我改好了，重新檢查'}
            </button>
          </div>
        )}

        {state === 'ios-need-install' && (
          <div className="mt-3 pt-3 border-t border-mor-line/50 text-xs text-gray-600 leading-relaxed">
            用 Safari 開啟這個網站 → 點下方的<b>「分享」</b> → <b>「加入主畫面」</b>，
            再從主畫面的圖示進來。iPhone 只讓加到主畫面的網站發通知，這是系統限制。
          </div>
        )}

        {/*
          測試結果講「送出」不講「收到」——
          送出去之後還有作業系統的專注模式、勿擾、通知中心設定，這裡看不到。
        */}
        {testMsg && (
          <div className="mt-3 pt-3 border-t border-mor-line/50 text-xs text-gray-600 leading-relaxed">
            {testMsg}
            {testMsg.startsWith('已送出') && (
              <div className="mt-1.5 text-gray-500">
                <b>3.</b> 還是沒跳出來的話，看 Windows 的<b>「設定 → 系統 → 通知」</b>——
                Chrome 要是關的、或「專注輔助 / 勿擾」開著，通知會直接進通知中心不彈出來。
              </div>
            )}
          </div>
        )}

        {warn && (
          <div className="mt-3 pt-3 border-t border-mor-line/50 text-xs text-amber-800">{warn}</div>
        )}
      </div>

      {anyOn && state !== 'on' && state !== 'loading' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 mb-2">
          下面的設定已經存起來了，<b>其他裝置照常收得到</b> —— 只有這一台收不到。
        </div>
      )}

      {saveErr && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 mb-2">
          {saveErr}
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
