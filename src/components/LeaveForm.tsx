'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import {
  DEFAULT_WS, dow, holidayMap, hoursWithinDay, isWorkday, leaveError, modeTimes,
  planDays, segments, toYmd, totals, workHours,
  type DayPick, type DayPlan, type Hm, type HolidayRow, type WorkSettings, type Ymd,
} from '@/lib/leave-days';

/**
 * 請假表單（2026-09-29 改版三版）：先選日期，再決定每一天怎麼請。
 *
 * ============================================================
 * 【這一版改了什麼（使用者 2026-09-29 指定：「順序錯了，先選日期再選請假方式」）】
 *
 *   ① 選假別 → ② 選日期 → ③ 每一天怎麼請 → ④ 確認
 *
 * 上一版把「請假方式」放在第 2 步，**一張單只能一種單位** ——
 * 「10/5 請整天、10/6 只請早上 3 小時」得送兩張單。
 * 現在月曆只回答「哪幾天」，第 3 步每一天各自一列：整天／上午／下午／小時。
 * 預設整天，所以只請整天的人點完日子就直接到第 4 步，不用每天開下拉。
 *
 * 【★ 小時只在當天鋪，不溢到隔天】
 *   `hoursWithinDay()`：從起算時間鋪到下班，午休跳過。塞不下的在那一列底下橘字提醒
 *   「多的 N 小時要另外選隔天」—— 自動溢到隔天會跟第 2 步選的日子打架。
 *
 * 【★ 後端一行都沒改】
 *   送出還是 `request_leave_batch()`（migration_291）—— 它本來就是一天一列、每天各自時段，
 *   這正是它設計的樣子。資料庫會把時數再算一次比對（HOURS_MISMATCH）。
 *
 * ★ 錯誤留在表單裡（按鈕旁邊），不丟頁面最上方（anxing-ui 二-5）。
 */

type LeaveType = { code: string; name: string; has_quota: boolean };
type Props = {
  types: LeaveType[];
  /** code → 剩餘小時；沒額度上限的假別給 null */
  remainOf: (code: string) => number | null;
  /** code → 今年已請幾小時（沒額度的假別用這個報累積） */
  usedOf: (code: string) => number;
  onMsg: (text: string, err?: boolean) => void;
  onDone: () => void;
};

/**
 * 第 3 步每一天的選法。`hour` 才有起算時間與時數；其餘三種時間由 `modeTimes()` 決定。
 * 送出前換成 `DayPick`（hour → custom ＋ 起訖），底下的明細、合計、送出都吃同一個形狀。
 */
type Way = 'full' | 'am' | 'pm' | 'hour';
type Row = { way: Way; start: Hm; len: string };
const WAY_LABEL: Record<Way, string> = { full: '整天', am: '上午', pm: '下午', hour: '小時' };

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const md = (d: Ymd) => d.slice(5).replace('-', '/');

/** 步驟外框：編號 ＋ 標題 ＋ 內容。標題的副標寫「這一步要做什麼」 */
function Step({ no, title, hint, children }: {
  no: number; title: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-3.5 border-t border-dashed border-mor-line first:border-t-0 first:pt-0.5">
      <div className="shrink-0 w-[26px] h-[26px] mt-0.5 rounded-full bg-mor-slate text-white
                      text-[13px] font-bold flex items-center justify-center">{no}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold mb-2">
          {title}<span className="ml-1.5 text-xs font-normal text-gray-400">{hint}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 下拉：兩步用同一個樣子，寬度一致 */
const SEL = 'h-10 w-full max-w-[260px] rounded-lg border border-mor-line bg-white px-3 text-sm';

export default function LeaveForm({ types, remainOf, usedOf, onMsg, onDone }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [type, setType] = useState('');
  const [ws, setWs] = useState<WorkSettings>(DEFAULT_WS);
  const [hol, setHol] = useState<Map<Ymd, string>>(new Map());
  /** 選了哪幾天、每一天怎麼請 */
  const [rows, setRows] = useState<Map<Ymd, Row>>(new Map());
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

  /**
   * 每一列 → DayPick。小時那種先用 `hoursWithinDay()` 鋪成當天的起訖（custom），
   * 塞不下的記在 `over` 給那一列底下提醒。四種選法算出來是同一個形狀（DayPlan[]），
   * 底下的明細、合計、送出不用分岔。
   */
  const { picks, over } = useMemo(() => {
    const picks = new Map<Ymd, DayPick>();
    const over = new Map<Ymd, number>();
    for (const [d, r] of rows) {
      if (r.way === 'hour') {
        const w = hoursWithinDay(r.start, Number(r.len) || 0, ws);
        picks.set(d, { mode: 'custom', start: w.s, end: w.e });
        if (w.over > 0) over.set(d, w.over);
      } else picks.set(d, { mode: r.way });
    }
    return { picks, over };
  }, [rows, ws]);
  const plan: DayPlan[] = useMemo(() => planDays(picks, ws), [picks, ws]);

  const tot = useMemo(() => totals(plan, ws), [plan, ws]);
  const segs = useMemo(() => segments(plan.map((p) => p.d), hol), [plan, hol]);
  const remain = remainOf(type);
  const used = usedOf(type);
  const blocker = useMemo(
    () => leaveError(plan, hol, { typeCode: type, remain }), [plan, hol, type, remain]);

  function toggle(d: Ymd) {
    setErr(null);
    setRows((m) => {
      // 月曆只有兩種狀態：選 / 沒選。怎麼請在第 3 步那一列選，預設整天。
      const n = new Map(m);
      if (n.has(d)) n.delete(d);
      else if (isWorkday(d, hol)) n.set(d, { way: 'full', start: ws.work_start, len: '' });
      return n;
    });
  }
  function patch(d: Ymd, f: Partial<Row>) {
    setErr(null);
    setRows((m) => { const n = new Map(m); const r = n.get(d); if (r) n.set(d, { ...r, ...f }); return n; });
  }
  function drop(d: Ymd) { setRows((m) => { const n = new Map(m); n.delete(d); return n; }); }

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
    setRows(new Map()); setReason('');
    onDone();
  });

  /* ── 月曆格子 ── */
  const cells = useMemo(() => {
    const lead = new Date(view.y, view.m - 1, 1).getDay();
    const last = new Date(view.y, view.m, 0).getDate();
    const out: { d: Ymd | null; n: number }[] = [];
    for (let i = 0; i < lead; i++) out.push({ d: null, n: 0 });
    for (let i = 1; i <= last; i++) out.push({ d: `${view.y}-${String(view.m).padStart(2, '0')}-${String(i).padStart(2, '0')}`, n: i });
    return out;
  }, [view]);

  const monthNav = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => setView((v) => (v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 }))}
        className="h-9 w-9 rounded-lg border border-mor-line bg-white text-gray-600 hover:border-mor-slate">‹</button>
      <span className="text-sm font-semibold min-w-[104px] text-center tabular-nums">{view.y} 年 {view.m} 月</span>
      <button type="button" onClick={() => setView((v) => (v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 }))}
        className="h-9 w-9 rounded-lg border border-mor-line bg-white text-gray-600 hover:border-mor-slate">›</button>
    </div>
  );

  /** 月曆：只回答「哪幾天」。格子上的小字寫那一天怎麼請 */
  function Calendar() {
    return (
      <div className="grid grid-cols-7 gap-1.5 mt-2">
        {WD.map((w) => <div key={w} className="text-[11px] text-gray-400 text-center pb-0.5">{w}</div>)}
        {cells.map((c, i) => {
          if (!c.d) return <div key={'p' + i} />;
          const work = isWorkday(c.d, hol);
          const kind = hol.get(c.d);
          const offTag = kind === 'holiday' ? '國定假日' : kind === 'makeup' ? '補班' : !work ? '例假日' : '';
          const r = rows.get(c.d);
          const hit = r ? plan.find((p) => p.d === c.d) : undefined;
          const tag = r ? (r.way === 'hour' ? `${fmtH(hit?.h ?? 0)} 小時` : WAY_LABEL[r.way]) : offTag;
          const cls = r
            ? (r.way === 'full' ? 'bg-mor-slate border-mor-slate text-white'
                                : 'bg-mor-bluelight border-mor-slate text-mor-slatedark')
            : !work ? 'bg-mor-sand text-gray-400 cursor-not-allowed'
            : 'bg-white hover:border-mor-slate';
          return (
            <button key={c.d} type="button" disabled={!work && !r} onClick={() => toggle(c.d!)}
              title={!work ? (kind === 'holiday' ? '國定假日，不用請假' : '例假日，不用請假') : ''}
              className={`h-[56px] md:h-[62px] rounded-lg border border-mor-line flex flex-col
                          items-center justify-center gap-0.5 ${cls}`}>
              <span className="text-[15px] font-semibold leading-none">{c.n}</span>
              <span className={`text-[10px] leading-none ${r ? 'opacity-90' : 'text-gray-400'}`}>{tag || ' '}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── 三步 ── */}
      <div className="rounded-xl glass p-4">
        <Step no={1} title="選假別" hint="要請哪一種假">
          {types.length ? (
            <select value={type} onChange={(e) => { setType(e.target.value); setErr(null); }} className={SEL}>
              {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          ) : <span className="text-sm text-gray-400">尚未設定假別</span>}
        </Step>

        <Step no={2} title="選日期" hint="點一下選，再點一下取消；可以選好幾天">
          <div className="flex justify-end">{monthNav}</div>
          <Calendar />
          <div className="text-[11px] text-gray-400 mt-2">灰色那些不用請假，點不下去。</div>
        </Step>

        {/*
         * ★★★ 第 3 步：每一天各自選（2026-09-29）。一張單可以混 —— 10/5 整天、10/6 請 3 小時。
         *   小時只在當天鋪；塞不下的橘字提醒，不自動溢到隔天。
         *   提示佔固定一行，出現或消失不推版面（anxing-ui 二-2）。
         */}
        <Step no={3} title="每一天怎麼請" hint="整天、半天或幾個小時，每天各自選">
          {!rows.size ? (
            <div className="text-xs text-gray-400 py-2">上面還沒選日子。</div>
          ) : [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, r]) => {
            const p = plan.find((x) => x.d === d);
            const ov = over.get(d);
            return (
              <div key={d} className="py-1.5 border-b border-dashed border-mor-line/70 last:border-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium min-w-[92px]">{md(d)}<span className="text-gray-400 font-normal">（{WD[dow(d)]}）</span></span>
                  <select value={r.way}
                    onChange={(e) => patch(d, { way: e.target.value as Way, ...(e.target.value === 'hour' && !r.len ? { len: '1' } : {}) })}
                    className="h-9 rounded-lg border border-mor-line px-2 text-sm bg-white">
                    {(['full', 'am', 'pm', 'hour'] as Way[]).map((w) => {
                      if (w === 'hour') return <option key={w} value={w}>小時（自己填）</option>;
                      const t = modeTimes(w, ws);
                      return <option key={w} value={w}>{WAY_LABEL[w]}（{t.s}～{t.e}，{fmtH(workHours(t.s, t.e, ws))} 小時）</option>;
                    })}
                  </select>
                  {r.way === 'hour' && (
                    <>
                      <input type="time" value={r.start} onChange={(e) => patch(d, { start: e.target.value })}
                        className="h-9 rounded-lg border border-mor-line px-2 text-sm" />
                      <input type="number" min="0.5" step="0.5" value={r.len} placeholder="最少 0.5"
                        onChange={(e) => patch(d, { len: e.target.value })}
                        className="h-9 w-[84px] rounded-lg border border-mor-line px-2 text-sm text-right" />
                      <span className="text-xs text-gray-400">小時</span>
                    </>
                  )}
                  <span className={`ml-auto text-sm tabular-nums ${!p || p.h <= 0 ? 'text-red-600' : 'text-gray-600'}`}>
                    {p ? `${p.s}～${p.e}・${fmtH(p.h)} 小時` : '—'}
                  </span>
                  <button type="button" onClick={() => drop(d)} title="把這一天拿掉"
                    className="h-8 w-8 rounded-lg border border-mor-line text-gray-400 hover:text-red-600 hover:border-red-300">×</button>
                </div>
                <div className="min-h-[16px] text-[11px] text-amber-700 pl-1">
                  {ov ? `超過下班時間 ${ws.work_end}，多的 ${fmtH(ov)} 小時要另外選隔天。` : ''}
                </div>
              </div>
            );
          })}
        </Step>

        {/*
         * ★★★ 第 4 步跟前三步**同一張卡**（使用者 2026-09-23 指定）。
         *   原本明細是另外一張卡 —— 那讀起來像「表單填完了，下面是另一件事」，
         *   而它其實是同一張單的最後一步：核對 ＋ 填事由 ＋ 送出。
         */}
        <Step no={4} title="確認" hint="核對明細，填請假事由">
        {!plan.length ? (
          <div className="text-xs text-gray-400 py-4 text-center">還沒有任何一天 —— 上面點月曆選日子。</div>
        ) : segs.map((seg, si) => (
          <div key={si}>
            <div className="flex items-center gap-2 mt-3 mb-1">
              <span className="text-[11px] text-gray-500 whitespace-nowrap">
                第 {si + 1} 段　{md(seg[0])}（{WD[dow(seg[0])]}）
                {seg.length > 1 && `～${md(seg[seg.length - 1])}（${WD[dow(seg[seg.length - 1])]}）`}
              </span>
              <i className="flex-1 h-px bg-mor-line" />
              <span className="text-[11px] text-gray-400 whitespace-nowrap tabular-nums">
                {fmtH(totals(plan.filter((p) => seg.includes(p.d)), ws).days)} 天
              </span>
            </div>
            {plan.filter((p) => seg.includes(p.d)).map((p) => (
              <div key={p.d} className="flex items-center gap-2 py-1 border-b border-dashed border-mor-line/70 last:border-0">
                <span className="text-sm min-w-[88px]">{md(p.d)}<span className="text-gray-400">（{WD[dow(p.d)]}）</span></span>
                <span className="text-sm text-gray-600">{WAY_LABEL[rows.get(p.d)?.way ?? 'full']}</span>
                <span className="text-sm tabular-nums text-gray-500">{p.s}～{p.e}</span>
                <span className={`ml-auto text-sm tabular-nums ${p.h <= 0 ? 'text-red-600' : 'text-gray-600'}`}>{fmtH(p.h)} 小時</span>
              </div>
            ))}
          </div>
        ))}

        {/* ── 合計 ── */}
        <div className="mt-3 rounded-lg bg-[#FAFAF9] border border-mor-line px-3 py-2.5">
          <div className="text-[15px]">
            {plan.length ? <>共 <b className="text-lg tabular-nums">{fmtH(tot.days)}</b> 天 · <b className="text-lg tabular-nums">{fmtH(tot.hours)}</b> 小時
              <span className="ml-2 rounded-full bg-mor-sand px-2 py-0.5 text-[11px] text-[#6b5b3f]">{segs.length === 1 ? '連續' : `分成 ${segs.length} 段`}</span></>
              : <span className="text-gray-400">還沒選任何一天</span>}
          </div>
          {/*
            ★★ 沒有額度的假別報「累積」不報「剩餘」（使用者 2026-09-23 指定）——
              事假寫「不限」讀起來像鼓勵，而病假的 56 只是設定值不是法規上限。
          */}
          <div className={`text-xs mt-0.5 ${remain != null && tot.hours > remain ? 'text-red-600' : 'text-gray-400'}`}>
            {plan.length
              ? (remain == null
                ? `這個假別不看額度 —— 送出後今年累積 ${fmtH(used + tot.hours)} 小時。`
                : `請完剩 ${fmtH(Math.max(0, remain - tot.hours))} 小時（現在 ${fmtH(remain)}）`)
              : ' '}
          </div>
        </div>

        {/* ★ 沒有紅星就是非必填，不用再寫一次「非必填」（anxing-ui 二-10） */}
        <label className="block mt-3">
          <span className="text-xs text-gray-500">請假事由</span>
          <input placeholder="例如：家裡有事、回診" value={reason} onChange={(e) => setReason(e.target.value)}
            className="mt-1 rounded-lg border border-mor-line px-3 py-2 text-sm w-full" />
        </label>

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
        </Step>
      </div>
    </div>
  );
}
