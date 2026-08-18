'use client';
import { useEffect, useState } from 'react';
import { useProfile } from '@/lib/profile';
import CalendarTab from './calendar-tab';
import StatsTab from './stats-tab';
import DemandTab from './demand-tab';

/**
 * 房務管理：行事曆 · 排班統計
 *
 * ============================================================
 * 【為什麼合併】（2026-08-14 使用者指定）
 *
 * 「房務行事曆」原本掛在**出勤**頁底下，而它跟出勤沒有關係 ——
 * 出勤講的是「員工幾點上下班、請了什麼假」，行事曆講的是
 * 「哪一間房什麼時候要清、誰去清」。
 *
 * 放錯地方的代價不是不好看，是**找不到**：要看排班的人會先點
 * 「房務管理」，找不到再點「出勤」，而多數人在第一步就放棄了。
 *
 * 現在兩個都在「房務管理」底下，同一件事的兩個視角：
 *
 *     行事曆    這個月每天誰在哪 —— 給要配合排班的人看
 *     排班統計  這個月各房源幾間幾次、布巾多少 —— 給算工作量與叫貨的人看
 *
 *
 * ============================================================
 * 【為什麼行事曆排第一】
 *
 * 分頁順序 = 使用頻率。行事曆是每天會看的，統計是月底才算一次。
 * 而且行事曆是唯讀的 —— 進來先看到一個不會改壞任何東西的畫面，
 * 比一進來就是一整片可編輯的表格安全。
 *
 *
 * ============================================================
 * 【「設定」為什麼還是獨立一頁】
 *
 * 工作類型、計數方式那些設定是「設一次就不動」的東西。
 * 做成第三個分頁的話，它會跟每天在用的兩個分頁搶同樣的視覺份量，
 * 而且點錯進去會看到一堆看不懂的開關。留在統計頁右上角的 ⚙ 就好。
 */

/*
 * 【採購需求排第三】（2026-08-17 使用者指定）
 *
 * 順序仍然是使用頻率:行事曆每天看、統計月底算一次、
 * 採購需求是「想到才提」。
 *
 * 但它**全員可見**（含房務）—— 提需求的人正是每天在現場、
 * 發現東西用完的那些人。放在他們每天會來的頁面底下，
 * 比獨立一頁更容易被想起來。
 */
const TAB_LABEL = { calendar: '行事曆', stats: '排班統計', demand: '採購需求' } as const;
type TabKey = keyof typeof TAB_LABEL;

export default function HousekeepingPage() {
  const [tab, setTab] = useState<TabKey>('calendar');
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);

  /*
   * 【行事曆全員可見，排班統計只有主管以上】
   *
   * 行事曆原本在出勤頁，那裡是開放給所有員工的 —— 搬過來時如果
   * 整頁鎖給主管，管家就看不到自己的班表了。那不是「權限收緊」，
   * 是**功能消失**，而且沒有任何提示。
   *
   * 排班統計會改資料（改間數、布巾、覆寫），所以照舊只給主管以上。
   *
   * 【為什麼不渲染而不是灰掉】
   * 灰掉的分頁會讓人一直去點，然後問「為什麼我不能用」。
   * 跟權限管理那頁同樣的處理。
   */
  const { role } = useProfile();
  const canEdit = role === 'manager' || role === 'super_admin';
  /*
   * 採購需求全員可見 —— 房務也要能提。
   * 「只看得到自己提的」由 RLS 擋（migration_140 的 pd_own），
   * 不是靠這裡少給一個分頁。
   */
  const tabs: TabKey[] = canEdit
    ? ['calendar', 'stats', 'demand']
    : ['calendar', 'demand'];

  /**
   * 成功訊息四秒後消失，失敗的不會。
   *
   * 被擋下來的人常常是低頭看手機、抬頭訊息已經不見了 ——
   * 然後他只知道「按了沒反應」。
   */
  useEffect(() => {
    if (!msg || msg.err) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  return (
    /*
     * 【手機上滿版】（2026-08-16 使用者指定：照 TimeTree）
     *
     * 月曆七欄，手機寬度 390px 扣掉左右各 16px 的 padding，
     * 每欄只剩 51px —— 「退-開封整棟」在那個寬度只放得下三個字。
     *
     * TimeTree 手機版是貼齊左右邊緣的，那不是省空間的取巧，
     * 是七欄月曆在小螢幕上唯一讀得到內容的做法。
     *
     * 桌機維持有 padding —— 那裡不缺寬度，貼邊反而難看。
     */
    <div className="-mx-4 px-0 py-4 md:mx-0 md:p-6">
      <h1 className="text-xl md:text-2xl font-semibold mb-3 px-4 md:px-0">房務管理</h1>

      {/* 只有一個分頁時整條不畫 —— 一個孤零零的分頁看起來像壞掉 */}
      {tabs.length > 1 && (
      <div className="flex gap-1 border-b border-mor-line mb-4 overflow-x-auto px-4 md:px-0">
        {tabs.map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === k
                ? 'border-mor-slate text-mor-slate font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>
      )}

      {msg && (
        <div className={`mb-3 mx-4 md:mx-0 rounded-lg px-3 py-2 text-sm ${
          msg.err ? 'bg-red-50 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}
          onClick={() => setMsg(null)}>
          {msg.t}
        </div>
      )}

      {/*
        兩個分頁都保留自己的狀態沒有意義 —— 它們各自載自己的資料，
        切回來重載一次比較確定看到的是最新的。
        （排班統計會改資料，切走再切回來時舊狀態可能已經過期。）
      */}
      {/* canEdit 還沒載到之前 tab 不可能是 stats，載到之後若被降權也會退回行事曆 */}
      {tab === 'demand'
        ? <DemandTab onMsg={(t, err) => setMsg({ t, err })} />
        : tab === 'stats' && canEdit
          ? <StatsTab onGoCalendar={() => setTab('calendar')} />
          : <CalendarTab onMsg={(t, err) => setMsg({ t, err })} canEdit={canEdit} />}
    </div>
  );
}
