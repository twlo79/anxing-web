'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { monthGrid, shiftMonth, twToday } from '@/lib/attendance-ui';
import { byDate, groupByStaff, entryText, dayTotal, type WorkItem } from '@/lib/hk-calendar';
import { CARD, type TabProps } from './types';

/**
 * 房務行事曆：每天哪些房源要清、誰負責。
 *
 * 【唯讀】
 * 要改排班仍然到「房務管理」。兩套編輯介面的話，之後改規則
 * （例如「同一天同一間不能排兩次」）要改兩邊，而漏掉的那一邊不會報錯。
 *
 * 【全公司都看得到全部】（使用者指定）
 * 排班本來就是要互相配合的資訊：今天誰在哪一棟、誰可以幫忙、誰休假。
 * 資料庫那邊對應 migration_110 的唯讀政策 —— 寫入仍然只有主管以上。
 *
 * 【格子裡按「人」收攏，不是一筆一列】
 * 一天可能有二十筆（一個人掃八間就是八筆）。一筆一列的話格子裡是
 * 二十行看不完的字，而人想知道的只有「今天誰在、大概多少間」。
 */

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/** 每個人一個顏色。同一個人整個月都是同一色，一眼看得出誰的班比較密。 */
const TONE = [
  'bg-mor-bluelight text-mor-slate',
  'bg-mor-greenlight text-mor-green',
  'bg-amber-50 text-amber-700',
  'bg-purple-50 text-purple-700',
  'bg-rose-50 text-rose-600',
  'bg-teal-50 text-teal-700',
];

export default function HkCalendarTab({ onMsg }: TabProps) {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const [[y, m], setYm] = useState<[number, number]>([now.getFullYear(), now.getMonth() + 1]);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [staff, setStaff] = useState<Map<string, string>>(new Map());
  const [rooms, setRooms] = useState<Map<string, string>>(new Map());
  const [works, setWorks] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const grid = useMemo(() => monthGrid(y, m), [y, m]);
  const from = grid[0].date;
  const to = grid[41].date;
  const today = twToday();

  const load = useCallback(async () => {
    setLoading(true);
    // 範圍用整個 42 格,不是當月 —— 月初月底跨月的那幾格也要有資料,
    // 不然一號在畫面上會突然變成空白
    const [{ data: wi, error }, { data: st }, { data: pr }, { data: wt }] = await Promise.all([
      supabase.from('hk_work_item')
        .select('id, work_date, property_code, work_type, staff_id')
        .gte('work_date', from).lte('work_date', to).order('work_date'),
      supabase.from('hk_staff').select('id, name'),
      supabase.from('hk_property').select('code, name'),
      supabase.from('hk_work_type').select('code, name'),
    ]);
    // 讀不到就講出來。RLS 擋掉的查詢會回空陣列而不是錯誤 ——
    // 靜靜顯示空月曆的話，看起來就像「這個月沒有排班」。
    if (error) onMsg('讀取排班失敗：' + error.message, true);
    setItems((wi ?? []) as WorkItem[]);
    setStaff(new Map((st ?? []).map((s: { id: string; name: string }) => [s.id, s.name])));
    setRooms(new Map((pr ?? []).map((p: { code: string; name: string }) => [p.code, p.name || p.code])));
    setWorks(new Map((wt ?? []).map((w: { code: string; name: string }) => [w.code, w.name || w.code])));
    setLoading(false);
  }, [supabase, from, to, onMsg]);

  useEffect(() => { load(); }, [load]);

  const staffName = useCallback((id: string) => staff.get(id) ?? id, [staff]);
  const workName = useCallback((c: string) => works.get(c) ?? c, [works]);
  const roomName = useCallback((c: string) => rooms.get(c) ?? c, [rooms]);

  const perDay = useMemo(() => byDate(items), [items]);

  const entriesOf = useCallback(
    (date: string) => groupByStaff(perDay[date] ?? [], staffName, workName, roomName),
    [perDay, staffName, workName, roomName]);

  // 顏色照人員排序固定，不照當天出現順序 —— 不然同一個人在不同日期會變色
  const toneOf = useCallback((staffId: string) => {
    const ids = [...staff.keys()].sort();
    const i = ids.indexOf(staffId);
    return TONE[(i < 0 ? 0 : i) % TONE.length];
  }, [staff]);

  const monthCount = useMemo(() => {
    const inMonth = items.filter((i) => i.work_date.slice(0, 7) === `${y}-${String(m).padStart(2, '0')}`);
    return { rooms: inMonth.filter((i) => i.property_code).length, all: inMonth.length };
  }, [items, y, m]);

  const selEntries = sel ? entriesOf(sel) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button onClick={() => { setYm(shiftMonth(y, m, -1)); setSel(null); }}
            className="rounded-lg border border-mor-line w-8 h-8 hover:bg-mor-sand/60">‹</button>
          <div className="text-sm font-semibold w-24 text-center tabular-nums">{y} 年 {m} 月</div>
          <button onClick={() => { setYm(shiftMonth(y, m, 1)); setSel(null); }}
            className="rounded-lg border border-mor-line w-8 h-8 hover:bg-mor-sand/60">›</button>
        </div>
        <div className="text-xs text-gray-400 tabular-nums">
          {loading ? '載入中…' : `本月 ${monthCount.rooms} 間・${monthCount.all} 筆工作`}
        </div>
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="grid grid-cols-7 text-center text-xs text-gray-500 border-b border-mor-line/60">
          {DOW.map((d, i) => (
            <div key={d} className={`py-2 ${i === 0 || i === 6 ? 'text-red-400' : ''}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((c) => {
            const es = entriesOf(c.date);
            const t = dayTotal(es);
            return (
              <button key={c.date} onClick={() => setSel(c.date === sel ? null : c.date)}
                title={t.people ? `${t.people} 人・${t.rooms} 間` : undefined}
                className={`min-h-[5.5rem] border-b border-r border-mor-line/60 p-1 text-left
                  align-top hover:bg-white/45
                  ${!c.inMonth ? 'bg-gray-50/60' : ''}
                  ${sel === c.date ? 'ring-2 ring-inset ring-mor-slate' : ''}`}>
                <div className="flex items-center gap-1">
                  <span className={`text-xs tabular-nums ${
                    c.date === today ? 'font-bold text-mor-slate' : 'text-gray-500'}`}>
                    {Number(c.date.slice(8))}
                  </span>
                  {c.date === today && <span className="w-1.5 h-1.5 rounded-full bg-mor-slate" />}
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {/* 最多三列。第四個人以後收成「+N」—— 格子塞滿的話
                      整個月曆的高度會被最忙的那天決定，其他天全是空白 */}
                  {es.slice(0, 3).map((e) => (
                    <div key={e.staffId + e.work}
                      className={`rounded px-1 py-0.5 text-[11px] leading-tight truncate ${toneOf(e.staffId)}`}>
                      {entryText(e)}
                    </div>
                  ))}
                  {es.length > 3 && (
                    <div className="text-[11px] text-gray-400 px-1">+{es.length - 3}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {sel && (
        <div className={`${CARD} p-4`}>
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-sm tabular-nums">
              {sel}（{DOW[new Date(`${sel}T00:00:00+08:00`).getDay()]}）
            </div>
            <button onClick={() => setSel(null)} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          {!selEntries.length ? (
            <div className="text-sm text-gray-400 py-4 text-center">這天沒有排班</div>
          ) : (
            <div className="space-y-2">
              {selEntries.map((e) => (
                <div key={e.staffId + e.work} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${toneOf(e.staffId)}`}>
                    {e.staff}
                  </span>
                  <span className="text-xs text-gray-500">{e.work}</span>
                  {e.rooms.length > 0 && (
                    <>
                      <span className="text-xs text-gray-400 tabular-nums">{e.rooms.length} 間</span>
                      <span className="text-xs text-gray-600 flex-1 min-w-0">{e.rooms.join('、')}</span>
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
