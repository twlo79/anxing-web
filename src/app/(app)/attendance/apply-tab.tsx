'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { remainText } from '@/lib/punch';
import {
  toTaipeiIso, hoursBetween, leaveVote, otVote, checkFixDate, twToday, shiftMonth,
} from '@/lib/attendance-ui';
import {
  BTN, BTN2, CARD, INPUT, TONE, fmtDT,
  type Balance, type FixReq, type LeaveReq, type LeaveType, type OtReq, type TabProps,
} from './types';

/**
 * 申請：請假 · 加班 · 補登。
 *
 * 【三種申請放同一頁，用小分頁切】
 * 它們是同一件事的三個變體（我要跟主管報備某段時間），
 * 拆成三頁的話「我的申請」會散在三個地方，員工要找自己送過什麼得點三次。
 *
 * 【送出前就先算好時數並顯示】
 * 「09:00 到 13:00」在畫面上是兩個時間，在制度上是 4 小時會從特休扣掉。
 * 不先顯示的話，人是按下去看到餘額少了才知道自己請了多久。
 */

type Sub = 'leave' | 'ot' | 'fix';
const SUB: Record<Sub, string> = { leave: '請假', ot: '加班', fix: '補登打卡' };

export default function ApplyTab({ me, onMsg, prefill }: TabProps & {
  /** 從打卡分頁「補登」按鈕帶過來的那一天 */
  prefill?: { date: string; kind: 'in' | 'out'; n: number } | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [sub, setSub] = useState<Sub>('leave');

  // 帶著日期進來的話直接切到補登。n 會變，所以同一天按第二次也會重新觸發。
  useEffect(() => { if (prefill) setSub('fix'); }, [prefill?.n]); // eslint-disable-line
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [bals, setBals] = useState<Balance[]>([]);
  const [daily, setDaily] = useState(8);
  const [leaves, setLeaves] = useState<LeaveReq[]>([]);
  const [ots, setOts] = useState<OtReq[]>([]);
  const [fixes, setFixes] = useState<FixReq[]>([]);
  const [busy, setBusy] = useState(false);

  const year = new Date().getFullYear();

  const load = useCallback(async () => {
    const [{ data: lt }, { data: lb }, { data: cfg }, { data: lr }, { data: ot }, { data: fx }] =
      await Promise.all([
        supabase.from('leave_types').select('code, name, has_quota, sort').eq('active', true).order('sort'),
        supabase.from('leave_balances').select('*').eq('user_id', me.id).eq('year', year),
        supabase.rpc('effective_work_settings', { p_user: me.id }),
        supabase.from('leave_requests').select('*').eq('user_id', me.id)
          .order('start_at', { ascending: false }).limit(50),
        supabase.from('overtime_requests').select('*').eq('user_id', me.id)
          .order('work_date', { ascending: false }).limit(50),
        supabase.from('attendance_fixes').select('*').eq('user_id', me.id)
          .order('work_date', { ascending: false }).limit(50),
      ]);
    setTypes((lt ?? []) as LeaveType[]);
    setBals((lb ?? []) as Balance[]);
    const c = Array.isArray(cfg) ? cfg[0] : cfg;
    setDaily(Number(c?.work_hours_per_day ?? 8) || 8);
    setLeaves((lr ?? []) as LeaveReq[]);
    setOts((ot ?? []) as OtReq[]);
    setFixes((fx ?? []) as FixReq[]);
  }, [supabase, me.id, year]);

  useEffect(() => { load(); }, [load]);

  const typeName = (code: string) => types.find((t) => t.code === code)?.name ?? code;

  // 用字串前綴比月份就好 —— work_date 是 date，'2026-08' 開頭的就是八月，
  // 不用把時區問題再帶進來一次
  const otHours = useMemo(() => {
    const t = twToday();
    const [y, m] = t.split('-').map(Number);
    const [ly, lm] = shiftMonth(y, m, -1);
    const p = (n: number) => String(n).padStart(2, '0');
    const sum = (f: (o: OtReq) => boolean) =>
      Math.round(ots.filter(f).reduce((s, o) => s + Number(o.hours || 0), 0) * 100) / 100;
    return {
      thisMonth: sum((o) => o.status === 'approved' && o.work_date?.startsWith(`${y}-${p(m)}`)),
      lastMonth: sum((o) => o.status === 'approved' && o.work_date?.startsWith(`${ly}-${p(lm)}`)),
      pending: sum((o) => o.status === 'pending'),
    };
  }, [ots]);

  return (
    <div className="space-y-4">
      {/* ── 我還剩多少假 ───────────────────────────── */}
      <div className={`${CARD} p-4`}>
        <div className="text-sm font-medium mb-2">{year} 年我的假</div>
        <div className="flex flex-wrap gap-3">
          {types.map((t) => {
            const b = bals.find((x) => x.type_code === t.code);
            // 沒有額度上限的假別（事假）不顯示數字 —— 顯示 0 會讓人以為請不了
            const remain = !t.has_quota ? null
              : Math.max(0, Number(b?.quota_hours ?? 0) - Number(b?.used_hours ?? 0));
            const noQuota = t.has_quota && !b;
            return (
              <div key={t.code} className="rounded-lg border border-mor-line px-3 py-2 min-w-[9rem]">
                <div className="text-xs text-gray-500">{t.name}</div>
                <div className={`text-sm font-semibold ${noQuota ? 'text-amber-600' : 'text-mor-ink'}`}>
                  {noQuota ? '今年未設額度' : remainText(remain, daily)}
                </div>
                {b && t.has_quota && (
                  <div className="text-[11px] text-gray-400">
                    額度 {b.quota_hours} · 已用 {b.used_hours}
                  </div>
                )}
              </div>
            );
          })}
          {!types.length && <div className="text-sm text-gray-400">尚未設定假別</div>}
        </div>
        {types.some((t) => t.has_quota && !bals.find((b) => b.type_code === t.code)) && (
          <div className="text-xs text-amber-700 mt-2 leading-relaxed">
            有假別今年還沒有額度，那種假現在請不了。請主管到「管理 → 假別額度」設定，
            或確認你的到職日已經填寫。
          </div>
        )}
      </div>

      {/* ── 小分頁 ─────────────────────────────────── */}
      <div className="flex gap-1">
        {(Object.keys(SUB) as Sub[]).map((k) => (
          <button key={k} onClick={() => setSub(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              sub === k ? 'bg-mor-slate text-white' : 'border border-mor-line hover:bg-mor-sand/60'}`}>
            {SUB[k]}
          </button>
        ))}
      </div>

      {sub === 'leave' && (
        <LeaveForm types={types} busy={busy} setBusy={setBusy} onMsg={onMsg} onDone={load} />
      )}
      {sub === 'ot' && (
        <>
          {/* 加班時數要看得到累積 —— 不然「這個月加了多少」只能自己一張一張加 */}
          <div className={`${CARD} px-4 py-3 flex flex-wrap gap-6 text-sm`}>
            {([
              ['本月已核可', otHours.thisMonth],
              ['上月已核可', otHours.lastMonth],
              ['送審中', otHours.pending],
            ] as const).map(([lb, v]) => (
              <div key={lb}>
                <div className="text-xs text-gray-500">{lb}</div>
                <div className={`text-lg font-semibold tabular-nums ${
                  lb === '送審中' && v > 0 ? 'text-amber-600' : 'text-mor-ink'}`}>
                  {v} <span className="text-xs font-normal text-gray-400">小時</span>
                </div>
              </div>
            ))}
          </div>
          <OtForm busy={busy} setBusy={setBusy} onMsg={onMsg} onDone={load} />
        </>
      )}
      {sub === 'fix' && (
        <FixForm busy={busy} setBusy={setBusy} onMsg={onMsg} onDone={load} prefill={prefill} />
      )}

      {/* ── 我送過的 ───────────────────────────────── */}
      <div className={CARD}>
        <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40 text-sm font-medium">
          我的{SUB[sub]}紀錄
        </div>
        <div className="divide-y divide-mor-line/60">
          {sub === 'leave' && leaves.map((r) => {
            const v = leaveVote(r);
            return (
              <Row key={r.id} tone={v.tone} state={v.text}
                title={`${typeName(r.type_code)} ${r.hours} 小時`}
                sub={`${fmtDT(r.start_at)} → ${fmtDT(r.end_at)}${r.reason ? `・${r.reason}` : ''}`}
                onCancel={r.status === 'pending' ? async () => {
                  const { data, error } = await supabase.from('leave_requests')
                    .update({ status: 'cancelled' }).eq('id', r.id).select('id');
                  if (error) return onMsg('取消失敗：' + error.message, true);
                  if (!data?.length) return onMsg('取消失敗 —— 這張單已經不是待審狀態了。', true);
                  onMsg('已取消'); load();
                } : undefined} />
            );
          })}
          {sub === 'ot' && ots.map((r) => {
            const v = otVote(r);
            return (
              <Row key={r.id} tone={v.tone} state={v.text}
                title={`加班 ${r.hours} 小時`}
                sub={`${fmtDT(r.start_at)} → ${fmtDT(r.end_at)}・${r.reason}`}
                onCancel={r.status === 'pending' ? async () => {
                  const { data, error } = await supabase.from('overtime_requests')
                    .update({ status: 'cancelled' }).eq('id', r.id).select('id');
                  if (error) return onMsg('取消失敗：' + error.message, true);
                  if (!data?.length) return onMsg('取消失敗 —— 這張單已經不是待審狀態了。', true);
                  onMsg('已取消'); load();
                } : undefined} />
            );
          })}
          {sub === 'fix' && fixes.map((r) => (
            <Row key={r.id}
              tone={r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'no' : 'wait'}
              state={r.status === 'approved' ? '已補上'
                : r.status === 'rejected' ? (r.review_note ? `已駁回：${r.review_note}` : '已駁回')
                : '等主管核可'}
              title={`${r.work_date} 補${r.kind === 'in' ? '上班' : '下班'} ${r.fix_time.slice(0, 5)}`}
              sub={r.reason} />
          ))}
          {((sub === 'leave' && !leaves.length) || (sub === 'ot' && !ots.length)
            || (sub === 'fix' && !fixes.length)) && (
            <div className="px-4 py-6 text-center text-sm text-gray-400">還沒有紀錄</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ title, sub, state, tone, onCancel }: {
  title: string; sub: string; state: string; tone: string; onCancel?: () => void;
}) {
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-gray-500 mt-0.5 break-words">{sub}</div>
      </div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${TONE[tone]}`}>
        {state}
      </span>
      {onCancel && <button onClick={onCancel} className={`${BTN2} shrink-0`}>取消</button>}
    </div>
  );
}

/** 送出前把時數算出來給人看 —— 不然是按下去看到餘額少了才知道請了多久。 */
function HoursHint({ start, end }: { start: string; end: string }) {
  if (!start || !end) return null;
  const h = hoursBetween(toTaipeiIso(start), toTaipeiIso(end));
  if (h <= 0) {
    return <div className="text-xs text-red-600">結束時間要晚於開始時間。</div>;
  }
  return <div className="text-xs text-mor-slate">這樣是 <b>{h} 小時</b>。</div>;
}

// ─────────────────────────────────────────────────────

function LeaveForm({ types, busy, setBusy, onMsg, onDone }: {
  types: LeaveType[]; busy: boolean; setBusy: (b: boolean) => void;
  onMsg: TabProps['onMsg']; onDone: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [type, setType] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => { if (!type && types.length) setType(types[0].code); }, [types, type]);

  async function submit() {
    if (!type) return onMsg('請先選假別。', true);
    if (!start || !end) return onMsg('請假的開始與結束時間都要填。', true);
    if (hoursBetween(toTaipeiIso(start), toTaipeiIso(end)) <= 0) {
      return onMsg('結束時間要晚於開始時間。', true);
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('request_leave', {
      p_type: type, p_start: toTaipeiIso(start), p_end: toTaipeiIso(end),
      p_reason: reason || null,
    });
    setBusy(false);
    if (error) return onMsg('送出失敗：' + error.message, true);
    const r = data as { ok: boolean; message: string };
    // 額度不夠、時間重疊、沒有配額 —— 資料庫已經把話寫好了，原樣顯示
    if (!r?.ok) return onMsg(r?.message ?? '送出失敗', true);
    onMsg(r.message);
    setStart(''); setEnd(''); setReason('');
    onDone();
  }

  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <div className="grid md:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="text-xs text-gray-500">假別</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
            {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500">從</span>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)}
            className={INPUT} />
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500">到</span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)}
            className={INPUT} />
        </label>
      </div>
      <HoursHint start={start} end={end} />
      <input placeholder="事由（選填）" value={reason} onChange={(e) => setReason(e.target.value)}
        className={INPUT} />
      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={busy} className={BTN}>送出請假</button>
        <span className="text-xs text-gray-400">送出後由主管與總經理兩位核可。</span>
      </div>
    </div>
  );
}

function OtForm({ busy, setBusy, onMsg, onDone }: {
  busy: boolean; setBusy: (b: boolean) => void; onMsg: TabProps['onMsg']; onDone: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');

  async function submit() {
    if (!start || !end) return onMsg('加班的起訖時間都要填。', true);
    // 事由是必填（資料庫 not null）—— 在這裡擋比讓它撞 not null 清楚得多
    if (!reason.trim()) {
      return onMsg('加班一定要寫事由。\n\n加班是要付錢的，事後沒有人記得那天為什麼留下來。', true);
    }
    if (hoursBetween(toTaipeiIso(start), toTaipeiIso(end)) <= 0) {
      return onMsg('結束時間要晚於開始時間。', true);
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('request_overtime', {
      p_start: toTaipeiIso(start), p_end: toTaipeiIso(end), p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) return onMsg('送出失敗：' + error.message, true);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return onMsg(r?.message ?? '送出失敗', true);
    onMsg(r.message);
    setStart(''); setEnd(''); setReason('');
    onDone();
  }

  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-xs text-gray-500">從</span>
          <input type="datetime-local" value={start}
            onChange={(e) => { setStart(e.target.value); if (!end) setEnd(''); }} className={INPUT} />
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500">到</span>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)}
            className={INPUT} />
        </label>
      </div>
      <HoursHint start={start} end={end} />
      <input placeholder="事由（必填）" value={reason} onChange={(e) => setReason(e.target.value)}
        className={INPUT} />
      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={busy} className={BTN}>送出加班</button>
        <span className="text-xs text-gray-400">主管一位核可即可。</span>
      </div>
      <div className="text-xs text-gray-400 leading-relaxed border-t border-mor-line pt-2">
        <b>加班時數以核可的申請為準，不是打卡待多久。</b>
        申請 2 小時、實際待 3 小時，算 2 小時；沒申請就留下來，出勤表上不會有加班。
      </div>
    </div>
  );
}

function FixForm({ busy, setBusy, onMsg, onDone, prefill }: {
  busy: boolean; setBusy: (b: boolean) => void; onMsg: TabProps['onMsg']; onDone: () => void;
  prefill?: { date: string; kind: 'in' | 'out'; n: number } | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');

  // 日期與哪一張卡從打卡分頁帶過來 —— 時間與原因刻意留空，那是他要想的
  useEffect(() => {
    if (!prefill) return;
    setDate(prefill.date); setKind(prefill.kind); setTime(''); setReason('');
  }, [prefill?.n]); // eslint-disable-line

  async function submit() {
    const bad = checkFixDate(date);
    if (bad) return onMsg(bad, true);
    if (!time) return onMsg('要補幾點？', true);
    if (!reason.trim()) {
      return onMsg('補登一定要寫原因。\n\n出勤是薪資的依據，事後只看得到「這一天被改過」是不夠的。', true);
    }
    setBusy(true);
    const { data, error } = await supabase.from('attendance_fixes')
      .insert({ work_date: date, kind, fix_time: time, reason: reason.trim() })
      .select('id');
    setBusy(false);
    if (error) return onMsg('送出失敗：' + error.message, true);
    if (!data?.length) return onMsg('送出失敗 —— 沒有寫入權限，請聯絡總經理。', true);
    onMsg(`已送出 ${date} 補${kind === 'in' ? '上班' : '下班'} ${time}，等主管核可。`);
    setDate(''); setTime(''); setReason('');
    onDone();
  }

  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <div className="grid md:grid-cols-3 gap-3">
        <label className="text-sm">
          <span className="text-xs text-gray-500">補哪一天</span>
          <input type="date" value={date} max={twToday()}
            onChange={(e) => setDate(e.target.value)} className={INPUT} />
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500">補哪一張卡</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'in' | 'out')} className={INPUT}>
            <option value="out">下班卡</option>
            <option value="in">上班卡</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500">時間</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={INPUT} />
        </label>
      </div>
      {prefill && date === prefill.date && (
        <div className="rounded-lg bg-mor-slate/5 border border-mor-slate/20 px-3 py-2 text-xs text-mor-slate">
          從打卡紀錄帶過來的：<b>{prefill.date}</b> 缺{prefill.kind === 'in' ? '上班' : '下班'}卡。
          填上那天實際的時間與原因就可以送出。
        </div>
      )}
      <input placeholder="原因（必填，例：忘記打下班）" value={reason}
        onChange={(e) => setReason(e.target.value)} className={INPUT} />
      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={busy} className={BTN}>送出補登</button>
        <span className="text-xs text-gray-400">主管核可後才會寫進出勤紀錄。</span>
      </div>
      <div className="text-xs text-gray-400 leading-relaxed border-t border-mor-line pt-2">
        <b>昨天忘了打下班，要補的是昨天那一筆。</b>
        今天的打卡永遠算今天 —— 拿今天的卡去頂昨天的話，兩天的工時都會錯。
      </div>
    </div>
  );
}
