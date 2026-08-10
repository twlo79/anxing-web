'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import PunchTab from './punch-tab';
import ApplyTab from './apply-tab';
import ApproveTab from './approve-tab';
import CalendarTab from './calendar-tab';
import NoticeTab from './notice-tab';
import AdminTab from './admin-tab';
import type { Role, TabProps } from './types';

/**
 * 出勤：打卡 · 申請 · 核可 · 行事曆 · 公告 · 管理
 *
 * 【為什麼全部擠在一頁，不是六個側欄項目】
 * 側欄已經 13 個項目。每多一項，真正每天要用的功能就被往下擠一格。
 * 這六塊都屬於「出勤」這件事，放一起找得到。
 *
 * 【核可與管理對員工完全不渲染】
 * 不是灰掉 —— 灰掉的按鈕會讓人一直去點，然後問「為什麼我不能用」。
 * 跟權限管理那頁同樣的處理。
 *
 * 【分頁順序 = 使用頻率】
 * 打卡每天兩次、申請每月幾次、核可主管每週看、行事曆與公告偶爾、管理設定完就不動。
 */

const TAB_LABEL = {
  punch: '打卡', apply: '申請', approve: '核可',
  calendar: '行事曆', notice: '公告', admin: '管理',
} as const;
type TabKey = keyof typeof TAB_LABEL;
const STAFF_TABS: TabKey[] = ['punch', 'apply', 'calendar', 'notice'];
const ALL_TABS = Object.keys(TAB_LABEL) as TabKey[];

export default function AttendancePage() {
  const supabase = useMemo(() => createClient(), []);
  const [me, setMe] = useState<TabProps['me'] | null>(null);
  const [tab, setTab] = useState<TabKey>('punch');
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [pending, setPending] = useState(0);
  /**
   * 從打卡分頁按「補登」帶過來的日期。
   *
   * 【為什麼要跨分頁帶值】
   * 看到「8/7 沒打下班卡」的當下就是他最想處理的時候。
   * 讓他自己切到申請分頁、再切到補登、再從日曆選 8/7 —— 中間三步，
   * 每一步都是一次放棄的機會，而放棄的成本是那天的工時永遠是錯的。
   */
  const [fix, setFix] = useState<{ date: string; kind: 'in' | 'out'; n: number } | null>(null);

  /**
   * 成功訊息四秒後消失，失敗的不會。
   * 被擋下來的人常常是低頭看手機、抬頭訊息已經不見了，
   * 然後他只知道「按了沒反應」。
   */
  const onMsg = useCallback((t: string, err?: boolean) => {
    setMsg({ t, err });
    if (!err) setTimeout(() => setMsg(null), 4000);
  }, []);

  const [ready, setReady] = useState(false);
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

  const isAdmin = me?.role === 'manager' || me?.role === 'super_admin';

  // 待辦數量放在分頁上 —— 主管不該為了確認「沒事」而點進去
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const opts = { count: 'exact' as const, head: true };
      const [a, b, c] = await Promise.all([
        supabase.from('leave_requests').select('id', opts).eq('status', 'pending'),
        supabase.from('overtime_requests').select('id', opts).eq('status', 'pending'),
        supabase.from('attendance_fixes').select('id', opts).eq('status', 'pending'),
      ]);
      setPending((a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0));
    })();
  }, [supabase, isAdmin, tab]);

  const canSee: TabKey[] = isAdmin ? ALL_TABS : STAFF_TABS;
  // 角色是非同步載入的：第一次 render 時 role 還是 null，管理分頁不存在。
  // 用衍生值而不是 setTab —— 在 render 裡呼叫 setState 會多跑一輪，
  // 而且主管重新整理頁面時會被踢回打卡分頁。
  const cur: TabKey = canSee.includes(tab) ? tab : 'punch';

  if (!ready) return <div className="text-sm text-gray-400">載入中…</div>;
  if (!me) return <div className="text-sm text-gray-500">請重新登入。</div>;

  const props: TabProps = { me, isAdmin, onMsg };

  return (
    <div className="max-w-[980px]">
      <h1 className="hidden md:block text-xl font-bold mb-3">出勤</h1>

      {/*
        手機上六個分頁橫向捲動，不換行。
        換行的話標題列會變成兩排、把打卡按鈕推到摺線以下 ——
        打卡是這頁最主要的動作，不該需要先捲動才看得到。
      */}
      <div className="flex gap-1 mb-4 border-b border-mor-line overflow-x-auto
                      [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {canSee.map((k) => (
          <button key={k} onClick={() => { setTab(k); setMsg(null); }}
            className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap
              shrink-0 flex items-center gap-1.5 ${
              cur === k ? 'border-mor-slate text-mor-slate'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {TAB_LABEL[k]}
            {k === 'approve' && pending > 0 && (
              <span className="rounded-full bg-amber-100 text-amber-700 px-1.5 text-[11px]">
                {pending}
              </span>
            )}
          </button>
        ))}
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}>
          <span className="shrink-0">{msg.err ? '⚠' : '✓'}</span>
          <span className="flex-1 whitespace-pre-line leading-relaxed">{msg.t}</span>
          {msg.err && (
            <button onClick={() => setMsg(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
          )}
        </div>
      )}

      {cur === 'punch' && (
        <PunchTab {...props} onFix={(date, kind) => {
          // n 遞增：同一天按第二次也要讓申請分頁重新帶值
          setFix({ date, kind, n: (fix?.n ?? 0) + 1 });
          setTab('apply');
          setMsg(null);
        }} />
      )}
      {cur === 'apply' && <ApplyTab {...props} prefill={fix} />}
      {cur === 'approve' && isAdmin && <ApproveTab {...props} />}
      {cur === 'calendar' && <CalendarTab {...props} />}
      {cur === 'notice' && <NoticeTab {...props} />}
      {cur === 'admin' && isAdmin && <AdminTab {...props} />}
    </div>
  );
}
