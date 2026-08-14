'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { monthGrid, shiftMonth, twToday } from '@/lib/attendance-ui';
import {
  byDate, dayCounts, isAuto, linenSets, sortTasks, taskLabel, type TaskView,
} from '@/lib/hk-task';

/**
 * 房務行事曆：每天哪些房源要清、誰負責。
 *
 * ============================================================
 * 【格子裡是「工作」，不是「幾間」】（2026-08-14 使用者指定）
 *
 * 上一版寫的是「庭玉 1・Una 2」—— 那回答的是「誰在」，但看行事曆的人
 * 真正要問的是「**今天要做什麼**」。
 *
 * 「庭玉 1」看不出是哪一間、退房還是入住、客人是誰。要知道就得點進去 ——
 * 而一個月三十天、每天都要點進去看的行事曆等於沒有行事曆。
 *
 * 所以每一筆工作各佔一條，直接寫「退房清潔 A15・Kevin」。
 * 格子也拉高了：一眼要看得完，比「排得下」重要。
 *
 *
 * ============================================================
 * 【自動長出來的用灰色】
 *
 * 退房/入住清潔是從訂單推導的（migration_121），不是誰排的。
 * 用人的顏色畫會讓人以為「有人安排過了」，然後那些沒指派的
 * 就這樣一直沒人去做。
 *
 * 灰色 ＋ 明寫「自動填入」＝ **這是系統猜的，還要你指派。**
 * 一旦指派給人，就換成那個人的顏色 —— 顏色的變化本身就是進度。
 *
 *
 * ============================================================
 * 【為什麼不再讀 TimeTree 的 hk_work_item】
 *
 * 那份資料是「人在日曆打字、每月匯入、字串解析」來的。
 * 現在工作有自己的表（hk_task），而且跟訂單連動 ——
 * 兩份都畫在同一個月曆上會變成同一件事出現兩次。
 *
 * 「排班統計」分頁還在讀 TimeTree，那是刻意的：先並行一陣子，
 * 兩邊數字對得起來再停掉匯入。
 */

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/** 每個人一個顏色。同一個人整個月都是同一色，一眼看得出誰的班比較密。 */
const TONE = [
  'bg-mor-bluelight text-mor-slate ring-mor-slate/15',
  'bg-mor-greenlight text-mor-green ring-mor-green/15',
  'bg-amber-50 text-amber-800 ring-amber-200',
  'bg-purple-50 text-purple-700 ring-purple-200',
  'bg-rose-50 text-rose-700 ring-rose-200',
  'bg-teal-50 text-teal-700 ring-teal-200',
];
/** 還沒指派的。灰色 = 還沒有人接手 */
const TONE_NONE = 'bg-gray-100 text-gray-500 ring-gray-200';

type Prop = { id: string; name: string; beds: number | null; count_linen: boolean };
type Staff = { id: string; name: string; active: boolean };

/** 手動加工作時可選的類型。跟排班統計那邊同一組 */
const WORK_TYPES = [
  '退房清潔', '入住清潔', '換房清潔', '細清', '公區清潔',
  '贈品補充', '點交', '拆備品', '清潔', '其他工時',
];

export default function CalendarTab({
  onMsg, canEdit,
}: { onMsg: (t: string, err?: boolean) => void; canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const [[y, m], setYm] = useState<[number, number]>([now.getFullYear(), now.getMonth() + 1]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [props, setProps] = useState<Prop[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sel, setSel] = useState<string | null>(twToday());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ property_id: '', work_type: '公區清潔', staff_id: '' });

  const grid = useMemo(() => monthGrid(y, m), [y, m]);
  const from = grid[0].date;
  const to = grid[41].date;
  const today = twToday();

  const load = useCallback(async () => {
    setLoading(true);
    // 範圍用整個 42 格,不是當月 —— 月初月底跨月的那幾格也要有資料,
    // 不然一號在畫面上會突然變成空白
    const [{ data: tk, error }, { data: pr }, { data: st }] = await Promise.all([
      supabase.from('hk_task')
        .select('id, work_date, property_id, work_type, staff_id, auto_kind, done_at, note, order_id, orders(guest_name)')
        .gte('work_date', from).lte('work_date', to).order('work_date'),
      supabase.from('properties').select('id, name, beds, count_linen').order('name'),
      supabase.from('staff').select('id, name, active').order('sort').order('name'),
    ]);
    // 讀不到就講出來。RLS 擋掉的查詢會回空陣列而不是錯誤 ——
    // 靜靜顯示空月曆的話，看起來就像「這個月沒有排班」
    if (error) onMsg('讀取房務工作失敗：' + error.message, true);

    const ps = (pr ?? []) as Prop[];
    const ss = (st ?? []) as Staff[];
    const pName = new Map(ps.map((p) => [p.id, p.name]));
    const sName = new Map(ss.map((s) => [s.id, s.name]));
    setProps(ps);
    setStaff(ss);
    setTasks(((tk ?? []) as unknown as (TaskView & { orders?: { guest_name: string | null } | null })[])
      .map((t) => ({
        ...t,
        room: t.property_id ? pName.get(t.property_id) ?? null : null,
        guest: t.orders?.guest_name ?? null,
        staff: t.staff_id ? sName.get(t.staff_id) ?? null : null,
      })));
    setLoading(false);
  }, [supabase, from, to, onMsg]);

  useEffect(() => { load(); }, [load]);

  const perDay = useMemo(() => byDate(tasks), [tasks]);
  const bedsOf = useCallback((id: string) => props.find((p) => p.id === id)?.beds, [props]);
  const linenOf = useCallback((id: string) => props.find((p) => p.id === id)?.count_linen !== false, [props]);

  // 顏色照人員排序固定，不照當天出現順序 —— 不然同一個人在不同日期會變色
  const toneOf = useCallback((staffId: string | null) => {
    if (!staffId) return TONE_NONE;
    const i = staff.findIndex((s) => s.id === staffId);
    return TONE[(i < 0 ? 0 : i) % TONE.length];
  }, [staff]);

  const selList = sel ? perDay[sel] ?? [] : [];
  const selCount = dayCounts(selList);
  const selLinen = linenSets(selList, bedsOf, linenOf);

  /** 指派／取消指派。空字串 = 收回，變回未指派 */
  async function assign(id: string, staffId: string) {
    const { data, error } = await supabase.from('hk_task')
      .update({ staff_id: staffId || null }).eq('id', id).select('id');
    if (error) return onMsg('指派失敗：' + error.message, true);
    // RLS 擋掉的 update 會回成功而且影響 0 列 —— 不檢查的話畫面說成功、
    // 資料一個字都沒變，而那比報錯更難查
    if (!data?.length) return onMsg('指派沒有存進去 —— 你的帳號沒有排班的權限。', true);
    load();
  }

  async function toggleDone(id: string, done: boolean) {
    const { data, error } = await supabase.from('hk_task')
      .update({ done_at: done ? new Date().toISOString() : null }).eq('id', id).select('id');
    if (error) return onMsg('更新失敗：' + error.message, true);
    if (!data?.length) return onMsg('沒有存進去 —— 你的帳號沒有排班的權限。', true);
    load();
  }

  async function addTask() {
    if (!sel) return;
    const { error } = await supabase.from('hk_task').insert({
      work_date: sel,
      property_id: draft.property_id || null,
      work_type: draft.work_type,
      staff_id: draft.staff_id || null,
    });
    if (error) return onMsg('新增失敗：' + error.message, true);
    setAdding(false);
    setDraft({ property_id: '', work_type: '公區清潔', staff_id: '' });
    onMsg('已新增');
    load();
  }

  async function removeTask(t: TaskView) {
    if (isAuto(t)) {
      return onMsg('這筆是從訂單自動長出來的,不能直接刪 —— 要拿掉請改訂單（取消或改日期）。', true);
    }
    if (!confirm(`刪掉「${taskLabel(t)}」？`)) return;
    const { error } = await supabase.from('hk_task').delete().eq('id', t.id);
    if (error) return onMsg('刪除失敗：' + error.message, true);
    onMsg('已刪除'); load();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setYm(shiftMonth(y, m, -1))}
          className="rounded-lg border border-mor-line w-9 h-9 hover:bg-mor-sand/60">‹</button>
        <div className="text-base font-semibold w-28 text-center tabular-nums">{y} 年 {m} 月</div>
        <button onClick={() => setYm(shiftMonth(y, m, 1))}
          className="rounded-lg border border-mor-line w-9 h-9 hover:bg-mor-sand/60">›</button>
        <button onClick={() => { setYm([now.getFullYear(), now.getMonth() + 1]); setSel(today); }}
          className="rounded-lg border border-mor-line px-3 h-9 text-sm hover:bg-mor-sand/60">今天</button>
        {/* 空白的月曆跟還沒載完的月曆長得一模一樣,那個要分得出來 */}
        {loading && <span className="text-xs text-gray-400">載入中…</span>}
      </div>

      {/*
        整片月曆自己捲。格子拉高之後整頁會很長，而月份切換鈕在最上面 ——
        看到月底想換月要滑回頂端。
      */}
      <div className="rounded-xl glass overflow-hidden">
        <div className="grid grid-cols-7 text-center text-xs text-gray-500 border-b border-mor-line/60">
          {DOW.map((d, i) => (
            <div key={d} className={`py-2 ${i === 0 || i === 6 ? 'text-red-400' : ''}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((c) => {
            const list = perDay[c.date] ?? [];
            const cnt = dayCounts(list);
            return (
              <button key={c.date} onClick={() => setSel(c.date === sel ? null : c.date)}
                className={`min-h-[8.5rem] border-b border-r border-mor-line/60 p-1.5 text-left
                  align-top hover:bg-white/45 transition-colors
                  ${!c.inMonth ? 'bg-gray-50/60' : ''}
                  ${sel === c.date ? 'ring-2 ring-inset ring-mor-slate' : ''}`}>
                <div className="flex items-center gap-1 mb-1">
                  <span className={`text-xs tabular-nums ${
                    c.date === today ? 'font-bold text-mor-slate' : 'text-gray-500'}`}>
                    {Number(c.date.slice(8))}
                  </span>
                  {c.date === today && <span className="w-1.5 h-1.5 rounded-full bg-mor-slate" />}
                  {/* 未指派的數量。這是唯一需要人動手的東西,要在收合之前就看得到 */}
                  {cnt.unassigned > 0 && (
                    <span className="ml-auto text-[10px] rounded-full bg-gray-200 text-gray-600 px-1.5">
                      {cnt.unassigned} 未派
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {/* 最多五條。第六條以後收成「+N」—— 格子塞滿的話整個月曆的
                      高度會被最忙的那天決定，其他天全是空白 */}
                  {list.slice(0, 5).map((t) => (
                    <div key={t.id}
                      className={`rounded px-1.5 py-0.5 text-[11px] leading-snug truncate
                        ring-1 ring-inset ${toneOf(t.staff_id)} ${t.done_at ? 'line-through opacity-60' : ''}`}>
                      {t.staff ? <b className="font-medium">{t.staff}</b> : null}
                      {t.staff ? ' ' : null}
                      {taskLabel(t)}
                    </div>
                  ))}
                  {list.length > 5 && (
                    <div className="text-[11px] text-gray-400 px-1">＋{list.length - 5}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {sel && (
        <div className="rounded-xl glass p-4">
          <div className="flex flex-wrap items-baseline gap-2 mb-3">
            <div className="font-semibold tabular-nums">
              {sel}（{DOW[new Date(`${sel}T00:00:00+08:00`).getDay()]}）
            </div>
            <div className="text-xs text-gray-500">
              {selCount.total} 筆
              {selCount.unassigned > 0 && <span className="text-amber-700"> ・{selCount.unassigned} 未指派</span>}
              {selCount.done > 0 && <span className="text-mor-green"> ・{selCount.done} 已完成</span>}
              {/*
                布巾算不出來的要講出來,不能當成 0 ——
                當成 0 的話那間房就靜靜地少帶一組床單,到現場才發現
              */}
              ・布巾 {selLinen.sets} 組
              {selLinen.unknown > 0 && (
                <span className="text-amber-700" title="這幾間還沒填床數,到「權限管理 → 房源管理」補">
                  （{selLinen.unknown} 間未填床數）
                </span>
              )}
            </div>
            <div className="flex-1" />
            {canEdit && !adding && (
              <button onClick={() => setAdding(true)}
                className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-sm font-medium hover:bg-mor-slatedark">
                ＋ 加工作
              </button>
            )}
            <button onClick={() => setSel(null)} className="text-gray-400 hover:text-gray-600 px-1">✕</button>
          </div>

          {adding && (
            <div className="rounded-lg border border-mor-line bg-mor-sand/20 p-3 mb-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">房源</span>
                <select value={draft.property_id} onChange={(e) => setDraft({ ...draft, property_id: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5 text-sm w-44">
                  <option value="">（無房源）</option>
                  {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">工作類型</span>
                <select value={draft.work_type} onChange={(e) => setDraft({ ...draft, work_type: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5 text-sm w-32">
                  {WORK_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">指派給</span>
                <select value={draft.staff_id} onChange={(e) => setDraft({ ...draft, staff_id: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5 text-sm w-32">
                  <option value="">（未指派）</option>
                  {staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <button onClick={addTask}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">新增</button>
              <button onClick={() => setAdding(false)}
                className="rounded-lg border border-mor-line px-3 py-1.5 text-sm hover:bg-mor-sand/60">取消</button>
            </div>
          )}

          {!selList.length ? (
            <div className="text-sm text-gray-400 py-6 text-center">這天沒有工作</div>
          ) : (
            <div className="space-y-1.5">
              {sortTasks(selList).map((t) => (
                <div key={t.id}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border border-mor-line/60 px-3 py-2
                    ${t.done_at ? 'bg-mor-greenlight/40' : 'bg-white/50'}`}>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${toneOf(t.staff_id)}`}>
                    {t.work_type}
                  </span>
                  <span className={`text-sm ${t.done_at ? 'line-through text-gray-400' : ''}`}>
                    {t.room ?? '（無房源）'}
                    {t.guest && <span className="text-gray-500 ml-1.5">{t.guest}</span>}
                  </span>
                  {/*
                    自動長出來的明寫出來。不寫的話看的人會以為「有人排過了」，
                    然後那些沒指派的就這樣一直沒人去做。
                  */}
                  {isAuto(t) && (
                    <span className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 text-[11px] whitespace-nowrap"
                      title="從訂單的進退房日推導出來。改訂單日期時它會自己搬,指派會保留">
                      自動填入
                    </span>
                  )}
                  <div className="flex-1" />
                  {canEdit ? (
                    <select value={t.staff_id ?? ''} onChange={(e) => assign(t.id, e.target.value)}
                      className={`rounded-lg border px-2 py-1 text-xs w-28 ${
                        t.staff_id ? 'border-mor-line' : 'border-amber-300 bg-amber-50/50'}`}>
                      <option value="">未指派</option>
                      {staff.filter((s) => s.active || s.id === t.staff_id)
                        .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-gray-500">{t.staff ?? '未指派'}</span>
                  )}
                  {canEdit && (
                    <>
                      <button onClick={() => toggleDone(t.id, !t.done_at)}
                        title={t.done_at ? '取消完成' : '標記完成'}
                        className={`w-8 h-8 rounded-lg border text-base leading-none transition-colors ${
                          t.done_at
                            ? 'border-mor-green/30 bg-mor-greenlight text-mor-green'
                            : 'border-mor-line bg-white text-gray-300 hover:text-mor-green'}`}>
                        ✓
                      </button>
                      {/* 自動的不給刪 —— 刪了下一輪同步又會長回來,而人會以為系統壞了 */}
                      {!isAuto(t) && (
                        <button onClick={() => removeTask(t)} title="刪除"
                          className="w-8 h-8 rounded-lg border border-mor-line bg-white text-gray-400
                                     text-base leading-none hover:bg-gray-100 hover:text-gray-600">
                          ✕
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
