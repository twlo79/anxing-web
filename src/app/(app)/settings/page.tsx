'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import NewsTab from './news-tab';
import NotifyTab from './notify-tab';
import TrashTab from './trash-tab';

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
 * 【新訊息排第一】（2026-08-15 使用者指定）
 *
 * 分頁順序 = 使用頻率。「通知設定」是設一次就不動的東西，
 * 「新訊息」是每天會來看的 —— 手機上滑掉的那則要回來這裡查。
 *
 * 原本的分頁叫「通知」，跟新訊息擺在一起會分不出誰是誰，
 * 所以改名「通知設定」—— 它本來就只是四個開關。
 */

const TABS = [
  { key: 'news', label: '新訊息', icon: '📬' },
  { key: 'notify', label: '通知設定', icon: '🔔' },
  { key: 'trash', label: '紀錄', icon: '🗑️' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function SettingsInner() {
  const params = useSearchParams();
  // 網址指定的分頁只在第一次載入時採用 —— 之後使用者點分頁是他的選擇，
  // 不該因為網址沒變就被拉回去。
  /*
   * 推播點開會帶 ?tab=news 進來 —— 那是這一頁存在的主要入口,
   * 網址對不上的話,人點了通知會落在「通知設定」的四個開關前面。
   */
  const [tab, setTab] = useState<TabKey>(() => {
    const t = params.get('tab');
    return TABS.some((x) => x.key === t) ? (t as TabKey) : 'news';
  });
  const [initialTable] = useState(params.get('table') ?? '');

  return (
    <div className="max-w-[1100px]">
      <h1 className="mb-3">設定</h1>

      <div className="inline-flex gap-1 p-1 mb-4 rounded-xl bg-white/45 backdrop-blur border border-white/60">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-white text-mor-slate shadow-[0_2px_8px_-2px_rgba(46,56,64,0.25)]'
                : 'text-gray-500 hover:text-mor-slate'
            }`}>
            <span className="mr-1.5">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {tab === 'news' ? <NewsTab />
        : tab === 'notify' ? <NotifyTab />
        : <TrashTab initialTable={initialTable} />}
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
