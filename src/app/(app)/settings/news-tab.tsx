'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { NOTIFY_LABEL, type NotifyKind } from '@/lib/notify-kinds';

/**
 * 新訊息 —— 推播通知的存底，留一週。
 *
 * ============================================================
 * 【為什麼需要這一頁】
 *
 * 手機鎖屏跳出「新增 3 筆訂單」→ 滑掉 → **那則訊息永遠不見了**。
 * 沒有任何地方查得到剛剛那則說了什麼、是哪三筆。
 *
 * 通知的價值在即時，而即時的東西天生會被錯過：開會中、在開車、
 * 手機在充電、那台裝置根本沒開推播權限。錯過一次就等於沒發過。
 *
 *
 * ============================================================
 * 【只看得到自己的】
 *
 * 通知本來就是依「通知設定」分送的 —— 你收到什麼，這裡就是什麼。
 * 一張全公司共用的消息牌會讓請款審核的金額與品項全公司都看得到，
 * 而那不是這個功能要解決的問題。（RLS 擋在資料庫層，migration_128。）
 *
 *
 * ============================================================
 * 【未讀不是紅點，是「還沒處理」】
 *
 * 未讀的整列底色不一樣、左邊有一條實心線 —— 不是角落一個小紅點。
 * 這一頁的用途是「我漏掉了什麼」，那個問題要能一眼掃完，
 * 不是逐列去找哪個有點。
 *
 * 點進去看內容就自動標已讀 —— 再叫人多按一次「標為已讀」，
 * 那顆按鈕會變成沒有人按、然後所有東西永遠是未讀。
 */

type Row = {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  created_at: string;
  read_at: string | null;
};

const ICON: Record<string, string> = {
  orders: '🛏️', approvals: '🧾', reviews: '⭐', cleaning: '🧹',
};

/** 「8/15（五）14:30」。相對時間（3 小時前）在這裡沒用 —— 要對得起排班表上的日期 */
function stamp(iso: string): string {
  const d = new Date(iso);
  const dow = '日一二三四五六'[d.getDay()];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}（${dow}）${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 今天／昨天／再往前用日期。分組標題讓「今天有幾則」不用自己數 */
function dayLabel(iso: string, today: string, yesterday: string): string {
  const d = iso.slice(0, 10);
  if (d === today) return '今天';
  if (d === yesterday) return '昨天';
  const dt = new Date(iso);
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日（${'日一二三四五六'[dt.getDay()]}）`;
}

export default function NewsTab() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    /*
     * 只撈七天內。
     *
     * 資料的清除是每週日跑一次（purge_old_notifications），但顯示不能
     * 靠那個 —— 只靠週日清的話，週六會看到十三天份，而「留一週」
     * 就變成一個看心情的數字。
     */
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data, error } = await supabase.from('notifications')
      .select('id, kind, title, body, url, created_at, read_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) setMsg('讀取失敗：' + error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const unread = rows.filter((r) => !r.read_at);
  const shown = onlyUnread ? unread : rows;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  /** 依日期分組。同一天的擠在一起，中間一條日期橫線 */
  const groups = useMemo(() => {
    const out: { day: string; items: Row[] }[] = [];
    for (const r of shown) {
      const label = dayLabel(r.created_at, today, yesterday);
      const last = out[out.length - 1];
      if (last && last.day === label) last.items.push(r);
      else out.push({ day: label, items: [r] });
    }
    return out;
  }, [shown, today, yesterday]);

  async function markRead(ids: number[]) {
    if (!ids.length) return;
    // 畫面先動。標已讀失敗的後果是「它還是未讀」——
    // 不需要為此擋住整個畫面，下次載入就會回到真相
    setRows((rs) => rs.map((r) => (ids.includes(r.id) ? { ...r, read_at: new Date().toISOString() } : r)));
    const { error } = await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() }).in('id', ids);
    if (error) { setMsg('標記失敗：' + error.message); load(); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500">
          {unread.length > 0
            ? <>有 <b className="text-mor-slate">{unread.length}</b> 則還沒看</>
            : '都看過了'}
        </span>
        <label className="flex items-center gap-1 text-xs text-gray-500 ml-2">
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
          只看未讀
        </label>
        <button onClick={() => markRead(unread.map((r) => r.id))}
          disabled={!unread.length}
          className="ml-auto rounded-lg border border-mor-line px-3 py-1.5 text-xs hover:bg-mor-sand/60 disabled:opacity-40">
          全部標為已讀
        </button>
      </div>

      <p className="text-xs text-gray-400">
        通知只留一週,每週日自動清掉舊的。這裡看到的跟你手機上收到的是同一批 ——
        依「通知設定」分送,別人的訊息你看不到。
      </p>

      {msg && <div className="rounded-lg bg-red-50 text-red-700 px-3 py-2 text-sm">{msg}</div>}

      {loading ? (
        <div className="text-center text-gray-400 py-16">載入中…</div>
      ) : !shown.length ? (
        <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center">
          <div className="text-gray-500 text-sm">
            {onlyUnread ? '沒有未讀的訊息' : '這一週還沒有通知'}
          </div>
          <div className="text-xs text-gray-400 mt-2 max-w-md mx-auto leading-relaxed">
            通知在「通知設定」那一頁開關。四種都關掉的話這裡會一直是空的 ——
            那不是壞掉。
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="text-xs text-gray-400 mb-1.5 px-1">{g.day}</div>
              <div className="rounded-xl glass divide-y divide-mor-line/40 overflow-hidden">
                {g.items.map((r) => {
                  const isUnread = !r.read_at;
                  const inner = (
                    <div className={`flex gap-3 px-4 py-3 ${isUnread ? 'bg-mor-bluelight/40' : ''}`}>
                      {/* 未讀的左邊一條實心線。整列看得出來,不用去找角落的小紅點 */}
                      <div className={`w-1 -my-3 -ml-4 mr-1 shrink-0 ${isUnread ? 'bg-mor-slate' : ''}`} />
                      <span className="text-lg leading-none pt-0.5 shrink-0">{ICON[r.kind] ?? '🔔'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className={`text-sm ${isUnread ? 'font-semibold text-mor-slate' : 'text-gray-700'}`}>
                            {r.title}
                          </span>
                          <span className="text-[11px] text-gray-400">
                            {NOTIFY_LABEL[r.kind as NotifyKind] ?? r.kind}・{stamp(r.created_at)}
                          </span>
                        </div>
                        {/* 內文保留換行 —— 匯入通知是一行一筆,擠成一段就看不出有幾筆 */}
                        {r.body && (
                          <div className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap leading-relaxed">
                            {r.body}
                          </div>
                        )}
                      </div>
                      {r.url && <span className="text-gray-300 self-center shrink-0">›</span>}
                    </div>
                  );
                  /*
                   * 有連結就整列可點,點了跳到那件事發生的地方並標已讀。
                   * 通知的重點是「然後呢」,不是「發生了」——
                   * 讀完還要自己去側邊欄找那一頁,等於這則通知只做了一半。
                   */
                  return r.url ? (
                    <Link key={r.id} href={r.url} onClick={() => markRead([r.id])}
                      className="block hover:bg-white/70 transition-colors">
                      {inner}
                    </Link>
                  ) : (
                    <div key={r.id} onClick={() => isUnread && markRead([r.id])}
                      className={isUnread ? 'cursor-pointer hover:bg-white/70' : ''}>
                      {inner}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
