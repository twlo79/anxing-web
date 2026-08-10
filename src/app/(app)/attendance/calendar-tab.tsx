'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { monthGrid, shiftMonth, twToday, dayStatus, type ReportRow } from '@/lib/attendance-ui';
import { CARD, type Holiday, type TabProps } from './types';

/**
 * 行事曆：國定假日 ＋ 我的請假 ＋（主管）當天誰請假。
 *
 * 【假日資料是查表，不是算出來的】
 * 農曆假日每年日期不同、補假規則改過（2025 下半年起取消補班）。
 * 用程式算一定會錯，而且是「明年才發現」的那種錯。
 * holidays 表由人事行政總處的公告逐年匯入。
 *
 * 【為什麼主管看得到全員請假，員工只看得到自己】
 * 排班要知道那天誰不在。但員工看得到同事請幾天病假是另一回事 ——
 * 那是健康資訊。所以員工只看到自己的。
 */

type LeaveDay = { d: string; name: string; type_name: string };

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

const CELL_TONE: Record<string, string> = {
  ok: 'bg-mor-greenlight text-mor-green border-mor-green/30',
  bad: 'bg-red-50 text-red-600 border-red-200',
  wait: 'bg-amber-50 text-amber-700 border-amber-200',
  off: 'bg-gray-100 text-gray-500 border-gray-200',
  none: '',
};

export default function CalendarTab({ me, isAdmin }: TabProps) {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const [[y, m], setYm] = useState<[number, number]>([now.getFullYear(), now.getMonth() + 1]);
  const [holidays, setHolidays] = useState<Record<string, Holiday>>({});
  const [leaveDays, setLeaveDays] = useState<Record<string, LeaveDay[]>>({});
  /** 我自己每一天的出勤狀態，key = YYYY-MM-DD */
  const [mine, setMine] = useState<Record<string, ReportRow>>({});
  const [sel, setSel] = useState<string | null>(null);

  const grid = useMemo(() => monthGrid(y, m), [y, m]);
  const from = grid[0].date;
  const to = grid[41].date;
  const today = twToday();

  const load = useCallback(async () => {
    // 範圍用整個 42 格，不是當月 —— 月初月底跨月的那幾格也要顯示，
    // 不然一號在畫面上會突然變成沒有任何資訊的空格。
    const [{ data: hs }, { data: lr }, { data: lt }, { data: pf }, { data: att }] = await Promise.all([
      supabase.from('holidays').select('d, name, kind').gte('d', from).lte('d', to),
      supabase.from('leave_requests').select('user_id, type_code, start_at, end_at, status')
        .eq('status', 'approved')
        .lte('start_at', `${to}T23:59:59+08:00`).gte('end_at', `${from}T00:00:00+08:00`),
      supabase.from('leave_types').select('code, name'),
      supabase.from('profiles').select('id, name'),
      // 用 attendance_report 而不是直接讀 attendance —— 它已經算好
      // 每一天的狀態（含請假、例假日、遲到早退），格子裡要顯示的就是那些
      supabase.rpc('attendance_report', { p_user: me.id, p_from: from, p_to: to }),
    ]);

    setHolidays(Object.fromEntries((hs ?? []).map((h) => [h.d as string, h as Holiday])));
    setMine(Object.fromEntries(((att ?? []) as ReportRow[]).map((r) => [r.work_date, r])));

    const tName = new Map((lt ?? []).map((t) => [t.code as string, t.name as string]));
    const pName = new Map((pf ?? []).map((p) => [p.id as string, p.name as string]));
    const map: Record<string, LeaveDay[]> = {};
    // 會計的 RLS 讀得到全員的假單（他要算薪），但行事曆上只該看到自己的 ——
    // 誰請了幾天病假是健康資訊，不是排班需要的。所以這裡再濾一次。
    const rows = (lr ?? []).filter((r) => isAdmin || r.user_id === me.id);
    for (const r of rows) {
      // 跨天的假要攤成每一天 —— 只標開始那天的話，
      // 三天的假在月曆上只看得到一格，排班的人會以為他隔天就回來了。
      const s = new Date(r.start_at as string);
      const e = new Date(r.end_at as string);
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const p = (n: number) => String(n).padStart(2, '0');
        const key = `${tw.getFullYear()}-${p(tw.getMonth() + 1)}-${p(tw.getDate())}`;
        if (key < from || key > to) continue;
        (map[key] ??= []).push({
          d: key,
          name: pName.get(r.user_id as string) ?? '—',
          type_name: tName.get(r.type_code as string) ?? r.type_code as string,
        });
      }
    }
    setLeaveDays(map);
  }, [supabase, from, to, isAdmin, me.id]);

  useEffect(() => { load(); }, [load]);

  const selInfo = sel ? { h: holidays[sel], lv: leaveDays[sel] ?? [] } : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button onClick={() => { setYm(shiftMonth(y, m, -1)); setSel(null); }}
            className="rounded-lg border border-mor-line w-8 h-8 hover:bg-mor-sand/60">‹</button>
          <div className="text-sm font-semibold w-24 text-center tabular-nums">{y} 年 {m} 月</div>
          <button onClick={() => { setYm(shiftMonth(y, m, 1)); setSel(null); }}
            className="rounded-lg border border-mor-line w-8 h-8 hover:bg-mor-sand/60">›</button>
          <button onClick={() => { setYm([now.getFullYear(), now.getMonth() + 1]); setSel(null); }}
            className="ml-2 rounded-lg border border-mor-line px-2 h-8 text-xs hover:bg-mor-sand/60">
            回本月
          </button>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[11px] text-gray-500">
          <Legend cls="bg-mor-greenlight border-mor-green/30" label="正常" />
          <Legend cls="bg-red-50 border-red-200" label="要處理" />
          <Legend cls="bg-amber-50 border-amber-200" label="請假" />
          <Legend cls="bg-gray-100 border-gray-200" label="假日" />
        </div>
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="grid grid-cols-7 text-center text-[11px] text-gray-500 border-b border-mor-line">
          {DOW.map((d, i) => (
            <div key={d} className={`py-1.5 ${i === 0 || i === 6 ? 'text-red-400' : ''}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((c) => {
            const h = holidays[c.date];
            const lv = leaveDays[c.date] ?? [];
            const rep = mine[c.date];
            const st = rep ? dayStatus(rep, today) : null;
            const isHol = h?.kind === 'holiday';
            const isWeekend = c.dow === 0 || c.dow === 6;
            return (
              <button key={c.date} onClick={() => setSel(c.date === sel ? null : c.date)}
                className={`min-h-[5.5rem] border-b border-r border-mor-line/60 p-1 text-left
                  align-top hover:bg-mor-sand/40
                  ${!c.inMonth ? 'bg-gray-50/60' : ''}
                  ${sel === c.date ? 'ring-2 ring-inset ring-mor-slate' : ''}`}>
                <div className="flex items-center gap-1">
                  <span className={`text-xs tabular-nums ${
                    !c.inMonth ? 'text-gray-300'
                      : isHol || isWeekend ? 'text-red-500' : 'text-mor-ink'}
                    ${c.date === today ? 'bg-mor-slate text-white rounded px-1' : ''}`}>
                    {c.day}
                  </span>
                </div>

                {/*
                  【自己的打卡狀態直接畫在格子裡】
                  月曆本來只有假日與請假 —— 那是「別人的事」。
                  真正每天要看的是「我那天打卡正不正常」，
                  而那件事原本要切到打卡分頁才看得到。
                  狀態徽章 ＋ 上下班時間，一眼掃完一個月。
                */}
                {c.inMonth && st && st.tone !== 'none' && st.tone !== 'off' && (
                  <div className={`mt-0.5 text-[10px] leading-tight rounded px-1 truncate border ${
                    CELL_TONE[st.tone]}`}>
                    {st.label}
                  </div>
                )}
                {c.inMonth && rep && (rep.in_at || rep.out_at) && (
                  <div className="mt-0.5 text-[10px] leading-tight text-gray-500 tabular-nums truncate">
                    {rep.in_at ?? '—'} {rep.out_at ?? '—'}
                  </div>
                )}

                {h && (
                  <div className={`mt-0.5 text-[10px] leading-tight truncate ${
                    h.kind === 'makeup' ? 'text-mor-slate' : 'text-red-500'}`}>
                    {h.kind === 'makeup' ? `補班・${h.name}` : h.name}
                  </div>
                )}
                {lv.slice(0, 2).map((l, i) => (
                  <div key={i} className="mt-0.5 text-[10px] leading-tight truncate
                                          rounded bg-amber-50 text-amber-700 px-1">
                    {isAdmin ? `${l.name} ${l.type_name}` : l.type_name}
                  </div>
                ))}
                {lv.length > 2 && (
                  <div className="text-[10px] text-amber-600">+{lv.length - 2} 人</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 點某一天看細節 —— 格子放不下三個人以上的名字 */}
      {sel && (
        <div className={`${CARD} p-4`}>
          <div className="text-sm font-medium mb-2">{sel}</div>
          {/* 我那天的打卡 —— 格子裡只放得下時間，遲到幾分鐘要點進來看 */}
          {mine[sel] && (() => {
            const r = mine[sel];
            const s = dayStatus(r, today);
            return (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-1">
                <span>上班 <b className="tabular-nums">{r.in_at ?? '—'}</b></span>
                <span>下班 <b className="tabular-nums">{r.out_at ?? '—'}</b></span>
                {r.work_hours > 0 && <span className="text-gray-500">工時 {r.work_hours} 小時</span>}
                {r.ot_hours > 0 && <span className="text-mor-slate">加班 {r.ot_hours} 小時</span>}
                {s.tone !== 'none' && (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${CELL_TONE[s.tone]}`}>
                    {s.label}
                  </span>
                )}
              </div>
            );
          })()}
          {selInfo?.h && (
            <div className="text-sm text-red-600">
              {selInfo.h.kind === 'makeup' ? '補班日' : '國定假日'}：{selInfo.h.name}
            </div>
          )}
          {selInfo?.lv.length ? (
            <ul className="text-sm mt-1 space-y-0.5">
              {selInfo.lv.map((l, i) => (
                <li key={i} className="text-amber-700">
                  {isAdmin ? `${l.name}　${l.type_name}` : l.type_name}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-gray-400 mt-1">
              {isAdmin ? '這天沒有人請假' : '這天你沒有請假'}
            </div>
          )}
        </div>
      )}

      <div className="text-xs text-gray-400 leading-relaxed">
        國定假日與補班日<b>由人事行政總處的公告逐年匯入</b>，不是程式算的 ——
        農曆假日每年日期不同，補假規則也改過。目前已匯入 2026 年。
        {!isAdmin && <><br />你只看得到自己的請假；主管看得到當天全員的請假名單。</>}
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`w-3 h-3 rounded border ${cls}`} />{label}
    </span>
  );
}
