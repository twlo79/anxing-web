'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import Req from '@/components/Req';
import { useOnce } from '@/lib/once';
import {
  DEFAULT_WS, MODE_LABEL, addDays, dow, holidayMap, isWorkday, leaveError, modeTimes, planDays,
  segments, toYmd, totals, workHours,
  type DayMode, type DayPick, type HolidayRow, type WorkSettings, type Ymd,
} from '@/lib/leave-days';

/**
 * 請假表單（2026-09-22 改版，migration_291）：一張單裝一份日期明細。
 *
 * ============================================================
 * 【為什麼不是「從幾點到幾點」】
 *
 * 舊表單是兩個 datetime，時數是「結束 − 開始」的牆上時鐘。
 * 9/24 09:00 → 9/30 18:00 會算成 **153 小時**（午休、晚上、週末、中秋全算進去），
 * 年假總共 56，所以多天請假從上線到現在一次都沒成功過。
 *
 * 改成：**月曆點日子 → 每天各自選整天／半天／時段 → 送出前看到共幾天幾小時**。
 * 送出時一天一列（`request_leave_batch()`，一個交易），同一批共用 `batch_id`。
 *
 * ★ 週末與國定假日**點不下去**，格子上寫著為什麼。
 * ★ 時數在 `lib/leave-days.ts` 算（有測試），資料庫會再算一次比對 —— 對不上就擋。
 * ★ 錯誤留在表單裡（按鈕旁邊），不丟頁面最上方（anxing-ui 二-5）。
 */

type LeaveType = { code: string; name: string; has_quota: boolean };
type Props = {
  types: LeaveType[];
  /** code → 剩餘小時；沒額度上限的假別給 null */
  remainOf: (code: string) => number | null;
  onMsg: (text: string, err?: boolean) => void;
  onDone: () => void;
};

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function LeaveForm({ types, remainOf, onMsg, onDone }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [type, setType] = useState('');
  const [ws, setWs] = useState<WorkSettings>(DEFAULT_WS);
  const [hol, setHol] = useState<Map<Ymd, string>>(new Map());
  const [picks, setPicks] = useState<Map<Ymd, DayPick>>(new Map());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const today = toYmd(new Date());
  const [view, setView] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) });

  useEffect(() => { if (!type && types.length) setType(types[0].code); }, [types, type]);

  /* 設定（含午休）＋ 假日表：一次撈今年到明年 */
  const loadRefs = useCallback(async () => {
    const y = Number(today.slice(0, 4));
    const [{ data: cfg }, { data: hs }] = await Promise.all([
      supabase.rpc('effective_work_settings', { p_user: (await supabase.auth.getUser()).data.user?.id }),
      supabase.from('holidays').select('d, kind').gte('d', `${y}-01-01`).lte('d', `${y + 1}-12-31`),
    ]);
    const c = Array.isArray(cfg) ? cfg[0] : cfg;
    if (c?.work_start) {
      setWs({
        work_start: String(c.work_start).slice(0, 5), work_end: String(c.work_end).slice(0, 5),
        lunch_start: String(c.lunch_start ?? '12:30').slice(0, 5), lunch_end: String(c.lunch_end ?? '13:30').slice(0, 5),
        work_hours_per_day: Number(c.work_hours_per_day ?? 8) || 8,
      });
    }
    setHol(holidayMap((hs ?? []) as HolidayRow[]));
  }, [supabase, today]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  const plan = useMemo(() => planDays(picks, ws), [picks, ws]);
  const tot = useMemo(() => totals(plan, ws), [plan, ws]);
  const segs = useMemo(() => segments([...picks.keys()], hol), [picks, hol]);
  const remain = remainOf(type);
  const blocker = useMemo(
    () => leaveError(plan, hol, { typeCode: type, remain }), [plan, hol, type, remain]);

  function toggle(d: Ymd) {
    setErr(null);
    setPicks((m) => {
      const n = new Map(m);
      if (n.has(d)) n.delete(d); else if (isWorkday(d, hol)) n.set(d, { mode: 'full' });
      return n;
    });
  }
  function setMode(d: Ymd, mode: DayMode) {
    setErr(null);
    setPicks((m) => {
      const n = new Map(m); const cur = n.get(d) ?? { mode: 'full' };
      n.set(d, mode === 'custom'
        ? { mode, start: cur.start ?? ws.work_start, end: cur.end ?? ws.work_end } : { mode });
      return n;
    });
  }
  function setCustom(d: Ymd, k: 'start' | 'end', v: string) {
    setPicks((m) => { const n = new Map(m); n.set(d, { ...(n.get(d) ?? { mode: 'custom' }), mode: 'custom', [k]: v }); return n; });
  }

  const [submit, submitting] = useOnce(async () => {
    setErr(null);
    if (blocker) { setErr(blocker); return; }
    const { data, error } = await supabase.rpc('request_leave_batch', {
      p_type: type,
      p_days: plan.map((p) => ({ d: p.d, s: p.s, e: p.e, h: p.h })),
      p_reason: reason || null,
    });
    if (error) { setErr('送出失敗：' + error.message); return; }
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) { setErr(r?.message ?? '送出失敗'); return; }
    onMsg(r.message);
    setPicks(new Map()); setReason('');
    onDone();
  });

  /* ── 月曆格子 ── */
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m - 1, 1);
    const lead = first.getDay();
    const last = new Date(view.y, view.m, 0).getDate();
    const out: { d: Ymd | null; n: number }[] = [];
    for (let i = 0; i < lead; i++) out.push({ d: null, n: 0 });
    for (let i = 1; i <= last; i++) out.push({ d: `${view.y}-${String(view.m).padStart(2, '0')}-${String(i).padStart(2, '0')}`, n: i });
    return out;
  }, [view]);

  return (
    <div className="space-y-3">
      {/* ── 假別 ＋ 月份 ── */}
      <div className="rounded-xl glass p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-sm min-w-[180px]">
            <span className="flex items-center text-xs text-gray-500">假別<Req /></span>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="rounded-lg border border-mor-line px-3 py-2 text-sm w-full">
              {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setView((v) => (v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 }))}
              className="h-9 w-9 rounded-lg border border-mor-line bg-white text-gray-600 hover:border-mor-slate">‹</button>
            <span className="text-sm font-semibold min-w-[104px] text-center">{view.y} 年 {view.m} 月</span>
            <button onClick={() => setView((v) => (v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 }))}
              className="h-9 w-9 rounded-lg border border-mor-line bg-white text-gray-600 hover:border-mor-slate">›</button>
          </div>
        </div>

        {/* ── 月曆 ── */}
        <div className="grid grid-cols-7 gap-1.5 mt-3">
          {WD.map((w) => <div key={w} className="text-[11px] text-gray-400 text-center pb-0.5">{w}</div>)}
          {cells.map((c, i) => {
            if (!c.d) return <div key={'p' + i} />;
            const p = picks.get(c.d);
            const work = isWorkday(c.d, hol);
            const kind = hol.get(c.d);
            const tag = p
              ? (p.mode === 'full' ? '已選' : p.mode === 'custom'
                  ? `${fmtH(workHours(p.start ?? ws.work_start, p.end ?? ws.work_end, ws))} 小時`
                  : MODE_LABEL[p.mode])
              : kind === 'holiday' ? '國定假日' : kind === 'makeup' ? '補班' : !work ? '例假日' : '';
            const cls = p
              ? (p.mode === 'full' ? 'bg-mor-slate border-mor-slate text-white'
                  : 'bg-mor-bluelight border-mor-slate text-mor-slatedark')
              : !work ? 'bg-mor-sand text-gray-400 cursor-not-allowed'
              : 'bg-white hover:border-mor-slate';
            return (
              <button key={c.d} type="button" disabled={!work && !p} onClick={() => toggle(c.d!)}
                title={!work ? (kind === 'holiday' ? '國定假日，不用請假' : '例假日，不用請假') : ''}
                className={`h-[60px] md:h-[68px] rounded-lg border border-mor-line flex flex-col items-center
                            justify-center gap-0.5 ${cls}`}>
                <span className="text-[15px] font-semibold leading-none">{c.n}</span>
                <span className={`text-[10px] leading-none ${p ? 'opacity-90' : 'text-gray-400'}`}>{tag || ' '}</span>
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-gray-400 mt-2">點一下選，再點一下取消。灰色那些不用請假，點不下去。</div>
      </div>

      {/* ── 明細 ── */}
      <div className="rounded-xl glass p-4">
        <div className="text-sm font-medium mb-1">這張單的明細</div>
        {!plan.length ? (
          <div className="text-xs text-gray-400 py-4 text-center">還沒有任何一天 —— 上面點月曆選日子。</div>
        ) : segs.map((seg, si) => (
          <div key={si}>
            <div className="flex items-center gap-2 mt-3 mb-1">
              <span className="text-[11px] text-gray-500 whitespace-nowrap">
                第 {si + 1} 段　{seg[0].slice(5).replace('-', '/')}（{WD[dow(seg[0])]}）
                {seg.length > 1 && `～${seg[seg.length - 1].slice(5).replace('-', '/')}（${WD[dow(seg[seg.length - 1])]}）`}
              </span>
              <i className="flex-1 h-px bg-mor-line" />
              <span className="text-[11px] text-gray-400 whitespace-nowrap">
                {fmtH(totals(plan.filter((p) => seg.includes(p.d)), ws).days)} 天
              </span>
            </div>
            {plan.filter((p) => seg.includes(p.d)).map((p) => {
              const pk = picks.get(p.d)!;
              return (
                <div key={p.d} className="flex items-center gap-2 py-1.5 border-b border-dashed border-mor-line/70 last:border-0 flex-wrap">
                  <span className="text-sm min-w-[88px]">{p.d.slice(5).replace('-', '/')}<span className="text-gray-400">（{WD[dow(p.d)]}）</span></span>
                  <select value={pk.mode} onChange={(e) => setMode(p.d, e.target.value as DayMode)}
                    className="h-9 rounded-lg border border-mor-line px-2 text-sm bg-white">
                    {(Object.keys(MODE_LABEL) as DayMode[]).map((m) => {
                      const t = modeTimes(m, ws, pk);
                      return <option key={m} value={m}>{MODE_LABEL[m]}{m !== 'custom' ? `（${fmtH(workHours(t.s, t.e, ws))} 小時）` : ''}</option>;
                    })}
                  </select>
                  {pk.mode === 'custom' && (
                    <span className="flex items-center gap-1 text-xs">
                      <input type="time" value={pk.start ?? ws.work_start} onChange={(e) => setCustom(p.d, 'start', e.target.value)}
                        className="h-9 rounded-lg border border-mor-line px-1.5 text-sm" />
                      ～
                      <input type="time" value={pk.end ?? ws.work_end} onChange={(e) => setCustom(p.d, 'end', e.target.value)}
                        className="h-9 rounded-lg border border-mor-line px-1.5 text-sm" />
                    </span>
                  )}
                  <span className={`ml-auto text-sm tabular-nums ${p.h <= 0 ? 'text-red-600' : 'text-gray-600'}`}>{fmtH(p.h)} 小時</span>
                  <button type="button" onClick={() => toggle(p.d)} title="把這一天拿掉"
                    className="h-8 w-8 rounded-lg border border-mor-line text-gray-400 hover:text-red-600 hover:border-red-300">×</button>
                </div>
              );
            })}
          </div>
        ))}

        {/* ── 合計 ── */}
        <div className="mt-3 rounded-lg bg-[#FAFAF9] border border-mor-line px-3 py-2.5">
          <div className="text-[15px]">
            {plan.length ? <>共 <b className="text-lg tabular-nums">{fmtH(tot.days)}</b> 天 · <b className="text-lg tabular-nums">{fmtH(tot.hours)}</b> 小時
              <span className="ml-2 rounded-full bg-mor-sand px-2 py-0.5 text-[11px] text-[#6b5b3f]">{segs.length === 1 ? '連續' : `分成 ${segs.length} 段`}</span></>
              : <span className="text-gray-400">還沒選任何一天</span>}
          </div>
          <div className={`text-xs mt-0.5 ${remain != null && tot.hours > remain ? 'text-red-600' : 'text-gray-400'}`}>
            {plan.length
              ? (remain == null ? '這個假別沒有額度上限。'
                : `請完剩 ${fmtH(Math.max(0, remain - tot.hours))} 小時（現在 ${fmtH(remain)}）`)
              : ' '}
          </div>
        </div>

        <input placeholder="事由（選填）" value={reason} onChange={(e) => setReason(e.target.value)}
          className="mt-3 rounded-lg border border-mor-line px-3 py-2 text-sm w-full" />

        {/* ★ 錯誤留在這裡：固定高度，出現或消失不推版面 */}
        <div className="min-h-[20px] mt-2">
          {err && <div className="text-xs text-red-600">{err}</div>}
        </div>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <button onClick={submit} disabled={submitting || !!blocker}
            title={blocker ?? ''}
            className="rounded-lg px-5 h-11 text-sm font-medium bg-mor-slate text-white hover:bg-mor-slatedark
                       disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed">
            {submitting ? '送出中⋯' : '送出請假'}
          </button>
          <span className="text-xs text-gray-400">一張單，主管與總經理各核一次。</span>
        </div>
      </div>
    </div>
  );
}
