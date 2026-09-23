'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import Req from '@/components/Req';
import { useOnce } from '@/lib/once';
import {
  DEFAULT_WS, MODE_LABEL, dow, holidayMap, isWorkday, leaveError, modeTimes, movedStart,
  planDays, segments, spreadHours, toYmd, totals, workHours,
  type DayMode, type DayPick, type DayPlan, type HolidayRow, type WorkSettings, type Ymd,
} from '@/lib/leave-days';

/**
 * 請假表單（2026-09-23 改版二版）：先決定用什麼單位請，再走各自最短的路。
 *
 * ============================================================
 * 【這一版改了什麼（使用者 2026-09-23 指定）】
 *
 *   ① 選假別 → ② 請假方式 → ③ 選日期／填起算
 *
 * 排成三步是因為：上一版一打開就是一整片月曆，而假別在月曆上面那一行 ——
 * 人會先點日子、選完才發現假別沒選。編號讓「還沒輪到你」看得出來。
 *
 * 【★★★ 兩種單位，兩條不同的路】
 *   · 請整天   月曆點日子，一天算一整天。**不用逐日開下拉選模式**
 *   · 請小時   填「起算日 ＋ 幾點 ＋ 請多久」，結束時間系統自己算
 *     （`spreadHours()`：午休跳過、下班換隔天、假日整天跳過）
 *
 * 上一版每一天都要開一次下拉選「整天／上午／下午／指定時段」——
 * 而九成的請假是「整天」，那個下拉等於每天多按一次。
 *
 * 【★★★ 半天在「明細」那一行改，不在月曆上】
 *   月曆只回答一個問題：**這張單要涵蓋哪幾天**。點一下選、再點一下取消，兩種狀態。
 *   某一天只請半天的話，到下面明細那一列把「整天」改成「上午／下午半天」。
 *
 *   ★ 原本做成月曆上方一個「這批裡有半天要請」的勾勾 —— 使用者看不懂那句話
 *     （2026-09-23 回報）。而它要解釋的是「點第二下會發生什麼事」，
 *     一個勾勾要先講清楚另一個動作的副作用，那就是設計錯了，不是文案錯了。
 *
 * 【★ 後端一行都沒改】
 *   送出還是 `request_leave_batch()`（migration_291），一張單一個交易，
 *   資料庫會把時數再算一次比對（HOURS_MISMATCH）。這裡只換排法。
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
 * 請假方式 —— 這是第 2 步整個要回答的問題：**這張單以什麼為單位**。
 *
 * ★★★ 半天原本藏在明細那一行的下拉裡（2026-09-23 第一版），
 *   使用者問「半天可以並到二嗎」—— 對的，半天本來就跟「天」「小時」
 *   是同一個層級的答案，擺在明細裡等於要人先選了日子才發現可以改。
 */
type Unit = 'day' | 'half' | 'hour';
const UNIT_LABEL: Record<Unit, string> = { day: '請整天', half: '請半天', hour: '請小時' };
const UNIT_HINT: Record<Unit, string> = {
  day: '整天不用填時間，點日子就好。',
  half: '點到的每一天都算半天。哪一半在右邊選，個別日子可以到下面明細改。',
  hour: '兩小時、跨天的零頭走這裡 —— 填起算點與時數，結束時間系統算。',
};

/** 「請半天」時，點日子預設落在哪一半 */
const HALF_LABEL: Record<'am' | 'pm', string> = { am: '上午', pm: '下午' };

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
  const [unit, setUnit] = useState<Unit>('day');
  const [half, setHalf] = useState<'am' | 'pm'>('am');
  const [ws, setWs] = useState<WorkSettings>(DEFAULT_WS);
  const [hol, setHol] = useState<Map<Ymd, string>>(new Map());
  const [picks, setPicks] = useState<Map<Ymd, DayPick>>(new Map());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const today = toYmd(new Date());
  const [view, setView] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) });
  /* 「請小時」的三格 */
  const [hDate, setHDate] = useState<Ymd>(today);
  const [hStart, setHStart] = useState('09:00');
  const [hLen, setHLen] = useState('');

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
      setHStart(String(c.work_start).slice(0, 5));
    }
    setHol(holidayMap((hs ?? []) as HolidayRow[]));
  }, [supabase, today]);
  useEffect(() => { loadRefs(); }, [loadRefs]);

  /*
   * ★ 兩種單位算出來的是**同一個形狀**（DayPlan[]）——
   *   底下的明細、合計、送出全部不用分岔。
   */
  const plan: DayPlan[] = useMemo(
    () => (unit === 'hour'
      ? spreadHours(hDate, hStart, Number(hLen) || 0, hol, ws)
      : planDays(picks, ws)),
    [unit, hDate, hStart, hLen, hol, ws, picks]);
  /** 月曆那兩種（整天／半天）共用同一套畫面 */
  const byCalendar = unit !== 'hour';

  const tot = useMemo(() => totals(plan, ws), [plan, ws]);
  const segs = useMemo(() => segments(plan.map((p) => p.d), hol), [plan, hol]);
  const remain = remainOf(type);
  const used = usedOf(type);
  const moved = unit === 'hour' ? movedStart(hDate, plan) : null;
  const blocker = useMemo(
    () => leaveError(plan, hol, { typeCode: type, remain }), [plan, hol, type, remain]);

  function toggle(d: Ymd) {
    setErr(null);
    setPicks((m) => {
      /*
       * ★★★ 只有兩種狀態：選 / 沒選。
       *   半天不在這裡切 —— 月曆回答的是「哪幾天」，明細回答的是「那天請多久」。
       *   一個動作只做一件事，不用在旁邊擺一句話解釋點第二下會怎樣。
       */
      const n = new Map(m);
      if (n.has(d)) n.delete(d);
      else if (isWorkday(d, hol)) n.set(d, { mode: unit === 'half' ? half : 'full' });
      return n;
    });
  }
  /*
   * ★★★ 換單位時，**已經點的日子跟著換**。
   *   留著不換的話，畫面上寫「請半天」而明細裡是一堆整天 ——
   *   兩個地方對同一張單給出不同答案（README 那條坑）。
   * ★ 換完明細馬上看得到，不是安靜改掉。
   */
  function switchUnit(u: Unit) {
    setErr(null); setUnit(u);
    if (u === 'hour') return;
    const want: DayMode = u === 'half' ? half : 'full';
    setPicks((m) => new Map([...m.keys()].map((d) => [d, { mode: want }])));
  }
  function switchHalf(k: 'am' | 'pm') {
    setErr(null); setHalf(k);
    setPicks((m) => new Map([...m.keys()].map((d) => [d, { mode: k }])));
  }

  function setMode(d: Ymd, mode: DayMode) {
    setErr(null);
    setPicks((m) => { const n = new Map(m); n.set(d, { mode }); return n; });
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
    setPicks(new Map()); setReason(''); setHLen('');
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

  /** 月曆。`readOnly` 時只是給人確認範圍（「請小時」那邊用） */
  function Calendar({ readOnly }: { readOnly?: boolean }) {
    return (
      <div className="grid grid-cols-7 gap-1.5 mt-2">
        {WD.map((w) => <div key={w} className="text-[11px] text-gray-400 text-center pb-0.5">{w}</div>)}
        {cells.map((c, i) => {
          if (!c.d) return <div key={'p' + i} />;
          const work = isWorkday(c.d, hol);
          const kind = hol.get(c.d);
          const offTag = kind === 'holiday' ? '國定假日' : kind === 'makeup' ? '補班' : !work ? '例假日' : '';
          if (readOnly) {
            const hit = plan.find((p) => p.d === c.d);
            return (
              <div key={c.d}
                className={`h-[56px] md:h-[62px] rounded-lg border flex flex-col items-center justify-center gap-0.5
                  ${hit ? 'bg-mor-bluelight border-mor-slate text-mor-slatedark'
                        : !work ? 'bg-mor-sand border-mor-line text-gray-400' : 'bg-white border-mor-line'}
                  ${c.d === hDate ? 'ring-2 ring-mor-slate ring-inset' : ''}`}>
                <span className="text-[15px] font-semibold leading-none">{c.n}</span>
                <span className="text-[10px] leading-none opacity-80">{hit ? `${fmtH(hit.h)} 小時` : offTag || ' '}</span>
              </div>
            );
          }
          const p = picks.get(c.d);
          const tag = p ? (p.mode === 'full' ? '整天' : MODE_LABEL[p.mode]) : offTag;
          const cls = p
            ? (p.mode === 'full' ? 'bg-mor-slate border-mor-slate text-white'
                                 : 'bg-mor-bluelight border-mor-slate text-mor-slatedark')
            : !work ? 'bg-mor-sand text-gray-400 cursor-not-allowed'
            : 'bg-white hover:border-mor-slate';
          return (
            <button key={c.d} type="button" disabled={!work && !p} onClick={() => toggle(c.d!)}
              title={!work ? (kind === 'holiday' ? '國定假日，不用請假' : '例假日，不用請假') : ''}
              className={`h-[56px] md:h-[62px] rounded-lg border border-mor-line flex flex-col
                          items-center justify-center gap-0.5 ${cls}`}>
              <span className="text-[15px] font-semibold leading-none">{c.n}</span>
              <span className={`text-[10px] leading-none ${p ? 'opacity-90' : 'text-gray-400'}`}>{tag || ' '}</span>
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

        <Step no={2} title="請假方式" hint="這張單以什麼為單位">
          <div className="flex gap-2 flex-wrap items-center">
            <select value={unit} onChange={(e) => switchUnit(e.target.value as Unit)} className={SEL}>
              {(['day', 'half', 'hour'] as Unit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
            </select>
            {/* ★ 只有「請半天」要問哪一半 —— 其餘兩種不出現，不佔位置 */}
            {unit === 'half' && (
              <select value={half} onChange={(e) => switchHalf(e.target.value as 'am' | 'pm')}
                className="h-10 rounded-lg border border-mor-line bg-white px-3 text-sm">
                {(['am', 'pm'] as const).map((k) => {
                  const t = modeTimes(k, ws);
                  return <option key={k} value={k}>{HALF_LABEL[k]}（{t.s}～{t.e}，{fmtH(workHours(t.s, t.e, ws))} 小時）</option>;
                })}
              </select>
            )}
          </div>
          <div className="text-[11px] text-gray-400 mt-1.5">{UNIT_HINT[unit]}</div>
        </Step>

        <Step no={3}
          title={byCalendar ? '選日期' : '填起算日與時數'}
          hint={byCalendar ? '點一下選，再點一下取消' : '結束時間系統自己算'}>
          {byCalendar ? (
            <>
              <div className="flex justify-end">{monthNav}</div>
              <Calendar />
              <div className="text-[11px] text-gray-400 mt-2">
                灰色那些不用請假，點不下去。
                {unit === 'day'
                  ? <>其中<b className="text-gray-500">某一天只請半天</b>的話，到下面明細那一行改。</>
                  : <>其中<b className="text-gray-500">某一天要請整天</b>的話，到下面明細那一行改。</>}
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2 flex-wrap items-end">
                <label className="text-sm">
                  <span className="flex items-center text-xs text-gray-500">起算日<Req /></span>
                  <input type="date" value={hDate} onChange={(e) => { setHDate(e.target.value); setErr(null); }}
                    className="h-9 rounded-lg border border-mor-line px-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="flex items-center text-xs text-gray-500">起算時間<Req /></span>
                  <input type="time" value={hStart} onChange={(e) => { setHStart(e.target.value); setErr(null); }}
                    className="h-9 rounded-lg border border-mor-line px-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="flex items-center text-xs text-gray-500">請多久（小時）<Req /></span>
                  <input type="number" min="0.5" step="0.5" value={hLen} placeholder="例如 3"
                    onChange={(e) => { setHLen(e.target.value); setErr(null); }}
                    className="h-9 w-[118px] rounded-lg border border-mor-line px-2 text-sm" />
                </label>
                <div className="text-sm">
                  <span className="block text-xs text-gray-500">算出來的起迄</span>
                  <span className="h-9 flex items-center font-semibold tabular-nums">
                    {plan.length
                      ? `${md(plan[0].d)} ${plan[0].s} ～ ${md(plan[plan.length - 1].d)} ${plan[plan.length - 1].e}`
                      : '—'}
                  </span>
                </div>
              </div>
              {/*
                ★★ 起算點被往後挪一定要講出來（假日、午休中、下班後都會挪）。
                  安靜挪的話使用者會以為自己填錯日期。
                ★ 固定高度：出現或消失不推下面的月曆（anxing-ui 二-2）。
              */}
              <div className="min-h-[18px] text-[11px] text-amber-700 mt-1">
                {moved && `${md(hDate)} 不用上班，從 ${md(moved)} 起算。`}
              </div>
              <div className="flex justify-end">{monthNav}</div>
              <Calendar readOnly />
              <div className="text-[11px] text-gray-400 mt-1.5">月曆只是給你確認：粗框是起算日，藍底是這張單蓋到的日子。</div>
            </>
          )}
        </Step>

        {/*
         * ★★★ 第 4 步跟前三步**同一張卡**（使用者 2026-09-23 指定）。
         *   原本明細是另外一張卡 —— 那讀起來像「表單填完了，下面是另一件事」，
         *   而它其實是同一張單的最後一步：核對 ＋ 填事由 ＋ 送出。
         */}
        <Step no={4} title="確認" hint="核對明細，填請假事由">
        {!plan.length ? (
          <div className="text-xs text-gray-400 py-4 text-center">
            {byCalendar ? '還沒有任何一天 —— 上面點月曆選日子。' : '還沒填 —— 上面填起算日與時數。'}
          </div>
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
              <div key={p.d} className="flex items-center gap-2 py-1.5 border-b border-dashed border-mor-line/70 last:border-0 flex-wrap">
                <span className="text-sm min-w-[88px]">{md(p.d)}<span className="text-gray-400">（{WD[dow(p.d)]}）</span></span>
                {byCalendar ? (
                  /* ★ 個別日子跟這張單的單位不一樣時，在這裡改（三天半的那個半天就是這樣填） */
                  <select value={p.mode} onChange={(e) => setMode(p.d, e.target.value as DayMode)}
                    className="h-9 rounded-lg border border-mor-line px-2 text-sm bg-white">
                    {(['full', 'am', 'pm'] as DayMode[]).map((m) => {
                      const t = modeTimes(m, ws);
                      return <option key={m} value={m}>{MODE_LABEL[m]}（{fmtH(workHours(t.s, t.e, ws))} 小時）</option>;
                    })}
                  </select>
                ) : (
                  <span className="text-sm tabular-nums text-gray-600">{p.s} ～ {p.e}</span>
                )}
                <span className={`ml-auto text-sm tabular-nums ${p.h <= 0 ? 'text-red-600' : 'text-gray-600'}`}>{fmtH(p.h)} 小時</span>
                {byCalendar && (
                  <button type="button" onClick={() => { setPicks((m) => { const n = new Map(m); n.delete(p.d); return n; }); }}
                    title="把這一天拿掉"
                    className="h-8 w-8 rounded-lg border border-mor-line text-gray-400 hover:text-red-600 hover:border-red-300">×</button>
                )}
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
