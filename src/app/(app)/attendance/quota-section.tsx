'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import { annualLeaveDays, tierLabel, leaveHours, tiersFrom, type Tier } from '@/lib/annual-leave';
import {
  parseImportRows, TEMPLATE_HEADERS, TEMPLATE_EXAMPLE_ROWS, OVERTIME_KIND, type ParsedRow,
} from '@/lib/leave-import';
import {
  BTN, BTN2, C_IN, C_OUT, noRowsMsg,
  type Balance, type LeaveReq, type LeaveType, type OtReq, type TabProps,
} from './types';

/* ══════════════════════════════════════════════════════
 * 管理 → 假別額度（2026-09-29 改版，migration_302）
 *
 * 三張表、三件事（過審的稿子 假別額度-應有假-UI稿.html）：
 *   ① 年假額度：只記「應有」＝ 法定（到職日算）＋ 公司多給（全公司一個數）。
 *      沒有可以手填的額度格 —— 資料庫自己算、自己寫（ensure_leave_quotas）。
 *   ①-b 匯入上線前的紀錄：Excel 一列一筆，匯進來就是已核可的單，②③ 自動算。
 *   ② 補休帳：＋已核可加班 −已請補休 ＝ 餘額。全自動（觸發器），沒有可以填的格子。
 *   ③ 請假狀況：每個人每種假 應有 − 已請 ＝ 剩餘；點名字展開那一年每一筆。
 *
 * 【額度單位是小時】半天、兩小時是常態；顯示時換算成天（人腦用天在想）。
 * 【已請時數不能手改】由核可的假單重算。要改「已請」，改假單（匯入的可以刪）。
 * ══════════════════════════════════════════════════════ */

type Person = {
  id: string; name: string; role: string; active: boolean;
  work_start: string | null; work_end: string | null;
  work_hours_per_day: number | null; hired_on: string | null;
};
type Ws = { work_hours_per_day: number; annual_extra_days: number };

const fmtH = (h: number) => Math.round(h * 100) / 100;
const TH = 'px-3 py-2 text-left text-xs text-gray-500 font-medium whitespace-nowrap';
const TD = 'px-3 py-2 align-middle';
/** 區塊標題（定在模組層：定在元件裡每次 render 都是新型別，React 會整塊拆掉重做） */
function H2({ n, title, hint }: { n: string; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap mt-1">
      <span className="text-[11px] font-bold tracking-wide text-mor-slatedark">{n}</span>
      <span className="text-sm font-medium">{title}</span>
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </div>
  );
}
const md = (ymd: string) => { const [, m, d] = ymd.slice(0, 10).split('-'); return `${Number(m)}/${Number(d)}`; };
/** timestamptz → 台北那天的 YYYY-MM-DD（畫面只認日期） */
const tpeDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

export default function QuotaSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [ppl, setPpl] = useState<Person[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [bals, setBals] = useState<Balance[]>([]);
  const [tiers, setTiers] = useState<Tier[]>(tiersFrom(null));
  const [ws, setWs] = useState<Ws>({ work_hours_per_day: 8, annual_extra_days: 0 });
  /** 那一年所有人的已核可假單與加班單（③ 的「往前看」與 ② 的明細） */
  const [leaves, setLeaves] = useState<LeaveReq[]>([]);
  const [ots, setOts] = useState<OtReq[]>([]);

  const load = useCallback(async () => {
    // ★ 先讓資料庫把這一年的「應有」寫好，再讀 —— 跨年那天才有新一年的列
    await supabase.rpc('ensure_leave_quotas', { p_year: year });
    const y0 = `${year}-01-01T00:00:00+08:00`, y1 = `${year + 1}-01-01T00:00:00+08:00`;
    const [{ data: p }, { data: t }, { data: b }, { data: sen }, { data: w }, { data: lr }, { data: ot }] = await Promise.all([
      supabase.from('profiles').select('id, name, role, active, work_start, work_end, work_hours_per_day, hired_on').order('name'),
      supabase.from('leave_types').select('code, name, has_quota, sort').eq('active', true).order('sort'),
      supabase.from('leave_balances').select('*').eq('year', year),
      supabase.from('leave_seniority').select('threshold_months, days'),
      supabase.from('work_settings').select('work_hours_per_day, annual_extra_days').eq('id', 1).maybeSingle(),
      supabase.from('leave_requests').select('*').eq('status', 'approved').gte('start_at', y0).lt('start_at', y1).order('start_at'),
      supabase.from('overtime_requests').select('*').eq('status', 'approved')
        .gte('work_date', `${year}-01-01`).lte('work_date', `${year}-12-31`).order('work_date'),
    ]);
    setPpl((p ?? []) as Person[]);
    setTypes((t ?? []) as LeaveType[]);
    setBals((b ?? []) as Balance[]);
    setTiers(tiersFrom(sen as { threshold_months: number; days: number }[] | null));
    const wr = w as Partial<Ws> | null;
    setWs({ work_hours_per_day: Number(wr?.work_hours_per_day ?? 8) || 8, annual_extra_days: Number(wr?.annual_extra_days ?? 0) || 0 });
    setLeaves((lr ?? []) as LeaveReq[]);
    setOts((ot ?? []) as OtReq[]);
  }, [supabase, year]);
  useEffect(() => { load(); }, [load]);

  const active = ppl.filter((p) => p.active);
  const asOf = `${year}-12-31`;
  const hpdOf = (p: Person) => Number(p.work_hours_per_day ?? ws.work_hours_per_day) || ws.work_hours_per_day;
  const balOf = (userId: string, code: string) => bals.find((x) => x.user_id === userId && x.type_code === code);
  const typeName = (code: string) => types.find((t) => t.code === code)?.name ?? code;

  /** 到職日改了就存（走 set_work_time，四個值整組送）；資料庫觸發器會重算年假 */
  async function setHired(p: Person, v: string) {
    const { data, error } = await supabase.rpc('set_work_time', {
      p_user: p.id, p_start: p.work_start || null, p_end: p.work_end || null,
      p_hours: p.work_hours_per_day ?? null, p_hired: v || null,
    });
    if (error) return onMsg('存不進去：' + error.message, true);
    const r = data as { ok: boolean; message: string };
    if (!r?.ok) return onMsg(r?.message ?? noRowsMsg('到職日'), true);
    load();
  }
  /** 公司多給：全公司一個數，存進 work_settings；觸發器會把每個人的年假重算 */
  async function setExtra(v: number) {
    const { data, error } = await supabase.from('work_settings')
      .update({ annual_extra_days: v }).eq('id', 1).select('id');
    if (error) return onMsg('存不進去：' + error.message, true);
    if (!data?.length) return onMsg(noRowsMsg('公司多給'), true);
    onMsg(`公司多給改成 ${v} 天，每個人的年假已重算`);
    load();
  }

  /* ── ①-b 匯入 ─────────────────────────────────── */
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: number; rows: { i: number; status: string; message?: string }[] } | null>(null);

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(TEMPLATE_EXAMPLE_ROWS, { header: [...TEMPLATE_HEADERS] });
    sheet['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(wb, sheet, '紀錄');
    const help = XLSX.utils.aoa_to_sheet([
      ['欄位', '怎麼填'],
      ['姓名', '跟系統上顯示的一樣：' + active.map((p) => p.name).join('、')],
      ['日期', '一天一列，像 2026-03-12（跨三天的假寫三列）'],
      ['種類', [...types.map((t) => t.name), OVERTIME_KIND.name].join('／')],
      ['小時', '數字，0.5 的倍數；整天 ' + ws.work_hours_per_day + '、半天 ' + ws.work_hours_per_day / 2],
      ['備註', '可以空白'],
      [],
      ['示範的兩列要刪掉再匯入（姓名對不到會被標紅，不會誤進）'],
    ]);
    help['!cols'] = [{ wch: 8 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, help, '說明');
    XLSX.writeFile(wb, '上線前請假加班紀錄-範本.xlsx');
  }
  async function pickFile(f: File | undefined) {
    if (!f) return;
    setResult(null);
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, unknown>[];
    const parsed = parseImportRows(rows, active, types);
    if (!parsed.length) onMsg('這份檔案裡沒有資料列（第一個工作表要有 姓名・日期・種類・小時 這幾欄）', true);
    setPreview(parsed);
    if (fileRef.current) fileRef.current.value = '';
  }
  async function confirmImport() {
    if (!preview) return;
    const ok = preview.filter((r): r is Extract<ParsedRow, { ok: true }> => r.ok);
    if (!ok.length) return;
    setImporting(true);
    const { data, error } = await supabase.rpc('import_leave_history', { p_rows: ok.map((r) => r.row) });
    setImporting(false);
    if (error) return onMsg('匯不進去：' + error.message, true);
    const r = data as { ok: boolean; message?: string; inserted: number; skipped: number; errors: number; rows: { i: number; status: string; message?: string }[] };
    if (!r?.ok) return onMsg(r?.message ?? '匯不進去', true);
    // RPC 回的 i 是「送出去那批」的序號 → 對回預覽的列
    const mapped = r.rows.map((x) => ({ ...x, i: ok[x.i - 1]?.i ?? x.i }));
    setResult({ ...r, rows: mapped });
    onMsg(`已匯入 ${r.inserted} 筆${r.skipped ? `、跳過 ${r.skipped} 筆（那天已有單）` : ''}${r.errors ? `、${r.errors} 筆失敗` : ''}`, r.errors > 0);
    load();
  }
  async function deleteImported(id: string, kind: string, label: string) {
    if (!confirm(`刪掉這筆匯入的紀錄？\n${label}\n\n刪了會從已請／加班裡扣回來。`)) return;
    const { data, error } = await supabase.rpc('delete_imported_leave', { p_id: id, p_kind: kind });
    if (error) return onMsg('刪不掉：' + error.message, true);
    const r = data as { ok: boolean; message?: string };
    if (!r?.ok) return onMsg(r?.message ?? '刪不掉', true);
    load();
  }

  /* ── ③ 展開 ───────────────────────────────────── */
  const [open, setOpen] = useState<string | null>(null);


  return (
    <section className="space-y-5">
      {/* 年度 ＋ 公司多給 */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm">年度
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)}
            className="w-24 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
        </label>
        <label className="flex items-center gap-2 text-sm border-l border-mor-line pl-3">公司多給
          <input key={`extra-${ws.annual_extra_days}`} type="number" step="0.5" min="0" defaultValue={ws.annual_extra_days}
            onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v !== ws.annual_extra_days) setExtra(v); }}
            className="w-20 rounded border border-mor-line px-2 py-1 text-sm tabular-nums" />
          天 <span className="text-[11px] text-gray-400">全公司統一，改了每個人的年假立刻重算</span>
        </label>
      </div>

      {/* ① 年假額度（應有） */}
      <div>
        <H2 n="①" title="年假（特休）應有" hint={`法定照到職日（年資算到 ${year}/12/31）＋ 公司多給；只講今年應該有幾天，剩餘在 ③`} />
        <div className="overflow-x-auto mt-2">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b border-mor-line">
              <th className={TH}>姓名</th><th className={TH}>到職日</th><th className={TH}>年假（特休）應有</th>
            </tr></thead>
            <tbody>
              {active.map((p) => {
                const st = annualLeaveDays(p.hired_on, asOf, tiers);
                const b = balOf(p.id, 'annual');
                const dbH = b ? Number(b.quota_hours) : null;
                const calcH = st == null ? null : leaveHours(st + ws.annual_extra_days, hpdOf(p));
                return (
                  <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                    <td className={`${TD} font-medium whitespace-nowrap`}>{p.name}</td>
                    <td className={TD}>
                      {/* key 綁值：uncontrolled 的 defaultValue 只在第一次算數，重載後框裡會留舊值 */}
                      <input key={`h-${p.id}-${p.hired_on ?? ''}`} type="date" defaultValue={p.hired_on ?? ''}
                        onBlur={(e) => { const v = e.target.value; if (v !== (p.hired_on ?? '')) setHired(p, v); }}
                        className="rounded border border-mor-line px-2 py-1 text-sm" />
                    </td>
                    <td className={`${TD} tabular-nums`}>
                      {!p.hired_on ? <span className="text-xs text-amber-600">先填到職日</span>
                      : st == null ? <span className="text-xs text-amber-600">到職日有誤</span>
                      : (
                        <span className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-gray-600">法定 <b className="text-mor-ink">{st}</b> ＋ 多給 {ws.annual_extra_days} ＝ <b className="text-mor-ink text-[15px]">{fmtH(st + ws.annual_extra_days)} 天</b></span>
                          <span className="text-[11px] text-gray-400">{dbH ?? calcH} 小時（{tierLabel(p.hired_on, asOf)}）</span>
                          {dbH != null && calcH != null && Math.abs(dbH - calcH) > 0.01 && (
                            <span className="text-[11px] text-amber-700">系統記 {dbH} 小時，畫面算 {calcH} —— 重新整理；還是不一樣就跟工程師講</span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!active.length && <tr><td className={`${TD} text-gray-400`} colSpan={3}>沒有在職的人</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* ①-b 匯入上線前的紀錄 */}
      <div>
        <H2 n="①-b" title="匯入上線前的紀錄" hint="一次把以前請過的假、加過的班倒進來；匯進來就是已核可的單，②③ 自動算" />
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <button type="button" onClick={downloadTemplate} className={`${BTN2} text-mor-slate border-mor-slate`}>⬇ 下載範本 Excel</button>
          <button type="button" onClick={() => fileRef.current?.click()} className={BTN}>⬆ 匯入</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])} />
          <span className="text-[11px] text-gray-400">一列一筆：姓名・日期・種類（{[...types.map((t) => t.name), OVERTIME_KIND.name].join('／')}）・小時・備註</span>
        </div>

        {preview && (
          <div className="mt-3 rounded-xl border border-mor-line bg-[#FAFAF9] p-3">
            {(() => {
              const okN = preview.filter((r) => r.ok).length;
              const badN = preview.length - okN;
              return (
                <div className="flex items-center gap-3 flex-wrap mb-2 text-sm">
                  <span>預覽：<b className="tabular-nums">{okN}</b> 筆會進{badN ? <>、<b className="text-red-600 tabular-nums">{badN}</b> 筆對不到（不會進）</> : null}</span>
                  <span className="text-[11px] text-gray-400">還沒寫進去。同一人同一天已經有單的會在寫入時跳過。</span>
                  <span className="ml-auto flex gap-2">
                    <button type="button" onClick={() => { setPreview(null); setResult(null); }} className={BTN2}>取消</button>
                    {!result && (
                      <button type="button" onClick={confirmImport} disabled={importing || !okN} className={BTN}
                        title={!okN ? '沒有一列對得到' : undefined}>
                        {importing ? '寫入中⋯' : `確認寫入 ${okN} 筆`}
                      </button>
                    )}
                  </span>
                </div>
              );
            })()}
            <div className="overflow-x-auto max-h-[22rem] overflow-y-auto">
              <table className="w-full min-w-[620px] text-xs">
                <thead><tr className="border-b border-mor-line text-gray-500">
                  <th className="px-2 py-1.5 text-left">列</th><th className="px-2 py-1.5 text-left">姓名</th><th className="px-2 py-1.5 text-left">日期</th>
                  <th className="px-2 py-1.5 text-left">種類</th><th className="px-2 py-1.5 text-right">小時</th><th className="px-2 py-1.5 text-left">備註</th><th className="px-2 py-1.5 text-left">結果</th>
                </tr></thead>
                <tbody>
                  {preview.map((r) => {
                    const res = result?.rows.find((x) => x.i === r.i);
                    return (
                      <tr key={r.i} className={`border-b border-mor-line/50 last:border-0 ${r.ok ? '' : 'text-red-600'}`}>
                        <td className="px-2 py-1 tabular-nums text-gray-400">{r.i}</td>
                        <td className="px-2 py-1">{r.who}</td>
                        <td className="px-2 py-1 tabular-nums">{r.ok ? r.row.d : r.d}</td>
                        <td className="px-2 py-1">{r.kindName}</td>
                        <td className="px-2 py-1 tabular-nums text-right">{r.ok ? r.row.hours : r.hours}</td>
                        <td className="px-2 py-1 text-gray-500">{r.ok ? r.row.note ?? '' : ''}</td>
                        <td className="px-2 py-1">
                          {!r.ok ? `✗ ${r.error}`
                          : !res ? <span className="text-mor-greendark">✓ 會進</span>
                          : res.status === 'ok' ? <span className="text-mor-greendark">✓ 已匯入</span>
                          : res.status === 'skip' ? <span className="text-amber-700">— 跳過：{res.message}</span>
                          : <span className="text-red-600">✗ {res.message}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ② 補休帳 */}
      <div>
        <H2 n="②" title="補休帳" hint="＋ 已核可加班 − 已請補休 ＝ 餘額。加班核一張就 ＋、補休核一張就 −，這裡沒有東西要填" />
        <div className="overflow-x-auto mt-2">
          <table className="w-full min-w-[620px] text-sm">
            <thead><tr className="border-b border-mor-line">
              <th className={TH}>姓名</th><th className={`${TH} text-right`}>＋ 已核可加班</th><th className={`${TH} text-right`}>− 已請補休</th>
              <th className={`${TH} text-right`}>＝ 補休餘額</th><th className={TH}>明細</th>
            </tr></thead>
            <tbody>
              {active.map((p) => {
                const plus = ots.filter((o) => o.user_id === p.id);
                const minus = leaves.filter((l) => l.user_id === p.id && l.type_code === 'comp');
                const b = balOf(p.id, 'comp');
                const q = b ? Number(b.quota_hours) : plus.reduce((n, o) => n + Number(o.hours), 0);
                const u = b ? Number(b.used_hours) : minus.reduce((n, l) => n + Number(l.hours), 0);
                const lines = [
                  ...plus.map((o) => ({ d: o.work_date, t: `加班 +${fmtH(Number(o.hours))}` })),
                  ...minus.map((l) => ({ d: tpeDay(l.start_at), t: `補休 −${fmtH(Number(l.hours))}` })),
                ].sort((a, b2) => a.d.localeCompare(b2.d));
                return (
                  <tr key={p.id} className="border-b border-mor-line/60 last:border-0">
                    <td className={`${TD} font-medium whitespace-nowrap`}>{p.name}</td>
                    <td className={`${TD} text-right tabular-nums`}>{fmtH(q)} 小時</td>
                    <td className={`${TD} text-right tabular-nums`}>{fmtH(u)} 小時</td>
                    <td className={`${TD} text-right tabular-nums`}><b className={q - u < 0 ? 'text-red-600' : ''}>{fmtH(q - u)}</b> 小時</td>
                    <td className={`${TD} text-[11px] text-gray-500`}>
                      {lines.length ? lines.map((l) => `${md(l.d)} ${l.t}`).join('・') : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ③ 請假狀況 */}
      <div>
        <H2 n="③" title="請假狀況" hint="應有 − 已請 ＝ 剩餘。點名字展開那一年每一筆；員工在「申請」頁看到的卡片就是自己那一列" />
        <div className="overflow-x-auto mt-2">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b border-mor-line">
              <th className={TH}>姓名</th>
              {types.map((t) => <th key={t.code} className={TH}>{t.name}</th>)}
              <th className={`${TH} text-right`}>剩餘合計</th>
            </tr></thead>
            <tbody>
              {active.map((p) => {
                const hpd = hpdOf(p);
                const d = (h: number) => fmtH(h / hpd);
                const left = types.filter((t) => t.has_quota).reduce((n, t) => {
                  const b = balOf(p.id, t.code);
                  return n + (b ? Math.max(0, Number(b.quota_hours) - Number(b.used_hours)) : 0);
                }, 0);
                const mine = [
                  ...leaves.filter((l) => l.user_id === p.id).map((l) => ({
                    id: l.id, d: tpeDay(l.start_at), kind: l.type_code, name: typeName(l.type_code),
                    hours: Number(l.hours), note: l.reason ?? '', imported: (l.reason ?? '').startsWith('上線前匯入'),
                  })),
                  ...ots.filter((o) => o.user_id === p.id).map((o) => ({
                    id: o.id, d: o.work_date, kind: 'overtime', name: '加班',
                    hours: Number(o.hours), note: o.reason ?? '', imported: (o.reason ?? '').startsWith('上線前匯入'),
                  })),
                ].sort((a, b2) => a.d.localeCompare(b2.d));
                const isOpen = open === p.id;
                return (
                  <FragmentRow key={p.id}>
                    <tr className="border-b border-mor-line/60">
                      <td className={`${TD} whitespace-nowrap`}>
                        <button type="button" onClick={() => setOpen(isOpen ? null : p.id)}
                          className="font-medium text-mor-slate hover:text-mor-slatedark"
                          title="展開這一年每一筆">{p.name} <span className="text-[10px] text-gray-400">{isOpen ? '▾' : '▸'}</span></button>
                      </td>
                      {types.map((t) => {
                        const b = balOf(p.id, t.code);
                        const q = Number(b?.quota_hours ?? 0), u = Number(b?.used_hours ?? 0);
                        if (t.code === 'comp') {
                          return <td key={t.code} className={`${TD} tabular-nums text-gray-600`}>餘額 <b className={`text-mor-ink ${q - u < 0 ? 'text-red-600' : ''}`}>{fmtH(q - u)}</b> 小時</td>;
                        }
                        if (!t.has_quota) {
                          return <td key={t.code} className={`${TD} tabular-nums text-gray-600`}>已請 <b className="text-mor-ink">{fmtH(u)}</b> 小時</td>;
                        }
                        if (!b) return <td key={t.code} className={`${TD} text-xs text-amber-600`}>{t.code === 'annual' ? '先填到職日' : '今年沒有額度'}</td>;
                        const remain = q - u;
                        const ratio = q > 0 ? Math.min(1, Math.max(0, remain / q)) : 0;
                        return (
                          <td key={t.code} className={`${TD} tabular-nums`}>
                            <span className="text-gray-600">應有 {d(q)} − 已請 {d(u)} ＝ <b className={`text-mor-ink ${remain < 0 ? 'text-red-600' : ''}`}>剩 {d(remain)} 天</b></span>
                            <div className="mt-1 h-1.5 w-40 max-w-full rounded-full bg-mor-line/70 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, backgroundColor: ratio > 0.2 ? C_IN : C_OUT }} />
                            </div>
                          </td>
                        );
                      })}
                      <td className={`${TD} text-right tabular-nums whitespace-nowrap`}>
                        <b>{d(left)}</b> 天<div className="text-[11px] text-gray-400">{fmtH(left)} 小時</div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-mor-line/60 bg-[#FAFAF9]">
                        <td className="px-3 py-2" colSpan={types.length + 2}>
                          {!mine.length ? <span className="text-xs text-gray-400">{year} 年沒有已核可的假單或加班單</span> : (
                            <table className="text-xs">
                              <tbody>
                                {mine.map((r) => (
                                  <tr key={r.id}>
                                    <td className="pr-3 py-0.5 tabular-nums text-gray-500">{r.d}</td>
                                    <td className="pr-3 py-0.5">{r.name}</td>
                                    <td className="pr-3 py-0.5 tabular-nums text-right">{fmtH(r.hours)} 小時</td>
                                    <td className="pr-3 py-0.5 text-gray-500">{r.note}</td>
                                    <td className="py-0.5">
                                      {r.imported && (
                                        <button type="button" onClick={() => deleteImported(r.id, r.kind, `${p.name} ${r.d} ${r.name} ${fmtH(r.hours)} 小時`)}
                                          className="text-red-400 hover:text-red-600" title="刪掉這筆匯入的紀錄">✕</button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">「上線前匯入」的那幾筆可以在展開後按 ✕ 刪掉再匯一次；正常送審的單走「申請 → 3 狀態」取消。</p>
      </div>
    </section>
  );
}

/** <tbody> 裡兩列共用一個 key —— Fragment 不能帶 className，用最小的包裝 */
function FragmentRow({ children }: { children: ReactNode }) { return <>{children}</>; }
