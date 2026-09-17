'use client';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { Tabs } from '@/components/Tabs';
import NewsTab from '../settings/news-tab';
import NoticeTab from '../attendance/notice-tab';
import type { Role } from '../attendance/types';
import SecretsTab from './secrets-tab';
import EventsTab from './events-tab';

/**
 * 佈告欄（2026-09-17 使用者指定）。
 *
 * 「做一個佈告欄，包含三格 tab —— 通知（把新訊息移進來）、帳密、活動」
 *
 * ══════════════════════════════════════════════════════════
 * 【三格】
 *
 *   通知　公告（留得住、置頂得了、看得到誰讀過）＋ 新訊息（推播的同一批）
 *   帳密　真的存帳號密碼。房務以外看得到
 *   活動　開會與團聚合成一條列表，用標籤分。開會底下掛得了資料
 *
 * ★ 「通知設定」使用者說先不放進去（2026-09-17）——
 *   它還留在「設定」頁。那一頁現在只剩通知設定與紀錄兩格。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 公告從出勤日曆搬過來】
 *
 * 出勤日曆上那顆「發布公告」與底下那張卡拿掉了（使用者:「這個 拿掉」）。
 * **公告本身沒有被刪** —— 同一張 `announcements` 表、同一個元件，
 * 只是入口換到這裡。已讀紀錄、置頂、未讀名單全部照舊。
 *
 * ★ 為什麼搬:公告跟新訊息回答的是同一個問題（「今天要知道什麼」）。
 *   分在兩頁的話，兩邊都只看一半。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不藏在「設定」裡】
 *
 * 「設定」這個名字讓人以為裡面是設定，不會每天點進去 ——
 * 而佈告欄是要大家每天看的。放錯地方的代價是沒有人看，
 * 而沒有人看的公告等於沒發。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 舊的推播網址】
 *
 * `public/sw.js` 裡寫死了 `/settings?tab=news`（兩個地方），
 * 而 **service worker 是瀏覽器快取的** —— 推上去之後，
 * 手機上那支舊的還會繼續把人送到 /settings。
 *
 * 所以 `/settings?tab=news` 會 redirect 到 `/board?tab=news`，
 * 兩邊都要做。只改 sw.js 的話，已經裝在手機上的那支要等它自己更新，
 * 而那段時間點通知會落在一個沒有新訊息的設定頁 ——
 * 使用者看到的是「通知點了什麼都沒有」。
 */

const TABS = [
  { key: 'news', label: '通知', icon: '📬' },
  { key: 'secrets', label: '帳密', icon: '🔑' },
  { key: 'events', label: '活動', icon: '🗓' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function BoardInner() {
  const supabase = useMemo(() => createClient(), []);
  const params = useSearchParams();

  /*
   * 網址指定的分頁只在第一次載入時採用 —— 之後使用者點分頁是他的選擇，
   * 不該因為網址沒變就被拉回去。（跟設定頁同一套）
   */
  const [tab, setTab] = useState<TabKey>(() => {
    const t = params.get('tab');
    return TABS.some((x) => x.key === t) ? (t as TabKey) : 'news';
  });

  const [me, setMe] = useState<{ id: string; name: string; role: Role } | null>(null);
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);

  /**
   * 成功訊息四秒後消失，失敗的不會。
   * 被擋下來的人常常是低頭看手機、抬頭訊息已經不見了，
   * 然後他只知道「按了沒反應」。（跟出勤頁同一套）
   */
  const onMsg = useCallback((t: string, err?: boolean) => {
    setMsg({ t, err });
    if (!err) setTimeout(() => setMsg(null), 4000);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setReady(true); return; }
      const { data: p } = await supabase.from('profiles')
        .select('name, role').eq('id', user.id).single();
      setMe({ id: user.id, name: p?.name ?? '', role: (p?.role ?? 'housekeeper') as Role });
      setReady(true);
    })();
  }, [supabase]);

  if (!ready) return <div className="text-sm text-gray-400 py-20 text-center">載入中…</div>;
  if (!me) return <div className="text-sm text-gray-500">請重新登入。</div>;

  const isAdmin = me.role === 'manager' || me.role === 'super_admin';

  return (
    <div>
      <h1 className="mb-3">佈告欄</h1>

      <Tabs variant="browser" tone="page" className="mb-4" value={tab}
        onChange={(k) => { setTab(k); setMsg(null); }}
        items={TABS.map((t) => ({
          key: t.key,
          label: <><span className="mr-1.5">{t.icon}</span>{t.label}</>,
        }))} />

      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}>
          <span className="shrink-0">{msg.err ? '⚠' : '✓'}</span>
          <span className="flex-1 whitespace-pre-line leading-relaxed">{msg.t}</span>
          {msg.err && (
            <button onClick={() => setMsg(null)}
              className="text-red-400 hover:text-red-600 shrink-0">✕</button>
          )}
        </div>
      )}

      {tab === 'news' && (
        <div className="space-y-5">
          {/* ★ 公告在上、新訊息在下 —— 公告是「要記得的」，新訊息是「剛發生的」 */}
          <NoticeTab me={me} isAdmin={isAdmin} onMsg={onMsg} />
          <NewsTab />
        </div>
      )}
      {tab === 'secrets' && <SecretsTab role={me.role} meId={me.id} onMsg={onMsg} />}
      {tab === 'events' && <EventsTab meId={me.id} isAdmin={isAdmin} onMsg={onMsg} />}
    </div>
  );
}

/**
 * useSearchParams 需要包在 Suspense 裡，否則整頁會被強制改成動態算繪，
 * 而 next build 會直接失敗（不是警告）。
 */
export default function BoardPage() {
  return (
    <Suspense fallback={<div className="text-gray-400 py-20 text-center">載入中…</div>}>
      <BoardInner />
    </Suspense>
  );
}
