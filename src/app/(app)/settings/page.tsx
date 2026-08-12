'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
 */

const TABS = [
  { key: 'notify', label: '通知', icon: '🔔' },
  { key: 'trash', label: '紀錄', icon: '🗑️' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function SettingsInner() {
  const params = useSearchParams();
  // 網址指定的分頁只在第一次載入時採用 —— 之後使用者點分頁是他的選擇，
  // 不該因為網址沒變就被拉回去。
  const [tab, setTab] = useState<TabKey>(
    params.get('tab') === 'trash' ? 'trash' : 'notify');
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
