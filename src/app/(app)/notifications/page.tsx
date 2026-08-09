'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import PushToggle from '../push-toggle';
// 刻意從 notify-kinds 而不是 lib/push 匯入 —— 後者頂層 import 了 web-push（Node 專用），
// client component 碰到它會把整包拉進瀏覽器的 bundle，而且 tsc 不會報錯
import {
  NOTIFY_KINDS, NOTIFY_LABEL, NOTIFY_DESC, NOTIFY_DEFAULT, type NotifyKind,
} from '@/lib/notify-kinds';

/**
 * 通知設定。
 *
 * 【為什麼獨立成一頁而不是塞進「權限管理」】
 * 權限管理只有總經理進得去（`role !== 'super_admin'` 直接擋）。
 * 但通知是**每個人自己的偏好** —— 會計、主管、一般人員都該能決定自己要收什麼。
 * 塞進去的話，除了總經理以外沒有人能改自己的設定。
 *
 * 【為什麼分兩區】
 *     這台裝置   能不能收推播（瀏覽器權限 + 訂閱）
 *     通知種類   要不要收某一種（跟著帳號走，套用到所有裝置）
 *
 * 兩件事常被搞混，而搞混的後果是「我明明開了卻收不到」——
 * 可能是這台沒訂閱，也可能是那種通知關著。分開顯示才看得出是哪一個。
 */

const ICON: Record<NotifyKind, string> = {
  orders: '🏨', approvals: '🧾', reviews: '⭐', cleaning: '🧹',
};

type Prefs = Record<NotifyKind, boolean>;

export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState<NotifyKind | null>(null);
  const [msg, setMsg] = useState('');

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
    const next = { ...prefs, [kind]: !prefs[kind] };
    setBusy(kind);
    // 先更新畫面再送出。網路慢的時候開關卡住不動，使用者會以為沒點到而連按好幾次。
    setPrefs(next);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(null); return flash('請重新登入'); }

    // upsert 而不是 update —— 帳號理論上都有列（migration_92 回填），
    // 但少了任何一條路徑就會變成「按了沒反應而且不報錯」。
    const { error } = await supabase.from('notification_prefs')
      .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });
    setBusy(null);
    if (error) { setPrefs(prefs); return flash('儲存失敗:' + error.message); }
    flash(`${NOTIFY_LABEL[kind]}已${next[kind] ? '開啟' : '關閉'}`);
  }

  return (
    <div className="max-w-[720px]">
      <h1 className="text-xl font-bold mb-1">通知設定</h1>
      <p className="text-xs text-gray-400 mb-4">
        通知集中在這一頁管理。設定跟著你的帳號走，換手機或電腦都一樣。
      </p>

      {/* ═══ 這台裝置 ═══ */}
      <h2 className="text-sm font-semibold text-gray-700 mb-2">這台裝置</h2>
      <PushToggle />
      <p className="text-xs text-gray-400 mb-6 leading-relaxed">
        要收到通知，<b>每一台裝置都要各自開啟一次</b> —— 手機、電腦是分開的。
        iPhone 要先用 Safari 把網站<b>加入主畫面</b>，再從主畫面的圖示進來開啟。
      </p>

      {/* ═══ 通知種類 ═══ */}
      <h2 className="text-sm font-semibold text-gray-700 mb-2">要收哪些通知</h2>

      {msg && (
        <div className="rounded-lg bg-mor-greenlight border border-mor-green/20 px-3 py-2 text-xs text-mor-green mb-2">
          {msg}
        </div>
      )}

      <div className="rounded-xl border border-mor-line bg-white divide-y divide-mor-line/60">
        {!prefs ? (
          <div className="px-4 py-10 text-center text-sm text-gray-400">載入中…</div>
        ) : NOTIFY_KINDS.map((k) => (
          /*
            整列是一顆按鈕，不是「文字 + 旁邊一個小開關」。
            手機上點名稱、點說明、點開關都會切換 —— 只有右邊那個 48px 的方塊
            能點的話，在手機上很容易點空。
            開關本身畫成 span 而不是巢狀 button（button 包 button 是無效的 HTML，
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

      <div className="text-xs text-gray-400 mt-3 leading-relaxed space-y-1.5">
        <p>
          <b>批次匯入只會發一則。</b>爬蟲一次可能抓進兩三百筆，
          每筆一則的話手機會叮到沒人想看 —— 所以同步完成後只發一則，寫明新增幾筆。
        </p>
        <p>
          <b>只有真的新增才通知。</b>更新既有資料（補翻譯、改金額、重新同步同一個期間）不發，
          否則每天都會收到一則內容一樣的通知。
        </p>
        <p>
          <b>訂單通知</b>包含爬蟲抓到的新訂單，以及有人手動新增的私下訂單。
          契約自動產生的月租單不算 —— 那是既有契約展開成月份，不是新生意。
        </p>
      </div>
    </div>
  );
}
