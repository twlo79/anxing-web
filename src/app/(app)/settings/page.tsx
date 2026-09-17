'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import NotifyTab from './notify-tab';
import TrashTab from './trash-tab';
import { Tabs } from '@/components/Tabs';

/**
 * 設定。
 *
 * 【為什麼把通知設定與刪除紀錄併在一起】
 * 側邊選單原本有十四個項目，最後兩個是「通知設定」與「刪除紀錄」——
 * 兩個都是「偶爾才進來一次」的東西，卻各佔一格，把每天要用的功能往下推。
 *
 * 併成一個「設定」之後選單短一格，而這兩件事本來就同一類：
 * 不是每天的工作，是需要的時候才來調整或查看的。
 *
 * 【網址帶得動分頁】
 * `?tab=trash` 直接落在紀錄，`?table=orders` 再篩到訂單 ——
 * 各列表頁的 🗑️ 入口靠這個直接把人送到他要看的那一段，
 * 而不是丟到一個「全部」的清單前面讓他自己找。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 新訊息搬到「佈告欄」了（2026-09-17 使用者指定）】
 *
 * 使用者:「做一個佈告欄⋯1. 通知 把新訊息移進來」。
 * 所以這一頁現在只剩「通知設定」與「紀錄」兩格。
 *
 * ★★ 但 `?tab=news` **不能就這樣不見** ——
 *   `public/sw.js` 裡寫死了 `/settings?tab=news`，而 service worker
 *   是**瀏覽器快取的**：推上去之後，已經裝在手機上的那一支
 *   還會繼續把人送到這裡，直到它自己更新為止。
 *
 *   不接的話，那段時間點推播會落在一個沒有新訊息的設定頁 ——
 *   使用者看到的是「通知點了什麼都沒有」，而系統沒有任何錯誤。
 *
 * ★ 所以 `?tab=news` 在這裡 redirect 到 `/board?tab=news`。
 *   sw.js 也改了，兩邊都要有 —— 只改一邊就會有一段空窗期。
 *   （2026-09-03 那條坑的另一種形狀:只找到一條產生路徑就當成唯一的）
 *
 * ★★ 等到確定沒有人的手機上還留著舊的 sw（幾個月後），
 *   這個 redirect 才可以拿掉。在那之前它不是贅碼。
 * ══════════════════════════════════════════════════════════
 */

const TABS = [
  { key: 'notify', label: '通知設定', icon: '🔔' },
  { key: 'trash', label: '紀錄', icon: '🗑️' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function SettingsInner() {
  const params = useSearchParams();
  const router = useRouter();

  /* ★ 舊的推播網址 —— 送去佈告欄，不要停在這裡 */
  const stale = params.get('tab') === 'news';
  useEffect(() => {
    if (stale) router.replace('/board?tab=news');
  }, [stale, router]);

  // 網址指定的分頁只在第一次載入時採用 —— 之後使用者點分頁是他的選擇，
  // 不該因為網址沒變就被拉回去。
  const [tab, setTab] = useState<TabKey>(() => {
    const t = params.get('tab');
    return TABS.some((x) => x.key === t) ? (t as TabKey) : 'notify';
  });
  const [initialTable] = useState(params.get('table') ?? '');

  /*
   * ★ 轉頁的那一瞬間不要先畫出「通知設定」的四個開關 ——
   *   閃一下再跳走，看起來像點錯了。
   */
  if (stale) {
    return <div className="text-gray-400 py-20 text-center">帶你去佈告欄的通知…</div>;
  }

  return (
    <div>
      <h1 className="mb-3">設定</h1>

      <Tabs variant="browser" tone="page" className="mb-4" value={tab} onChange={setTab}
        items={TABS.map((t) => ({
          key: t.key,
          label: <><span className="mr-1.5">{t.icon}</span>{t.label}</>,
        }))} />

      {tab === 'notify' ? <NotifyTab /> : <TrashTab initialTable={initialTable} />}
    </div>
  );
}

/**
 * useSearchParams 需要包在 Suspense 裡，否則整頁會被強制改成動態算繪，
 * 而 next build 會直接失敗（不是警告）。
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="text-gray-400 py-20 text-center">載入中…</div>}>
      <SettingsInner />
    </Suspense>
  );
}
