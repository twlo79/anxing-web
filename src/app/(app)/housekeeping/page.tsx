'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import { parseRows, cleanCounts, splitAssignees, type HkStaff, type HkProperty } from '@/lib/hkParse';

/**
 * 房務排班統計。
 *
 * 兩種計數方式並存,這是整頁的核心:
 *   間數     = 某人某日的工作項數。兩人合掃 → 各 +1
 *   打掃次數 = Σ_日期 MAX_over_人(該人當日在該房源的筆數)。兩人合掃 → 只算 1
 *
 * 次數要乘上「幾床」推算床單,用人頭計次會讓布巾量翻倍。
 */

type Ev = {
  id: string; period: string; event_date: string; title: string;
  assignees: string[]; parsed_code: string | null; work_type: string | null;
  excluded: string | null;
};
type Wi = { id: string; period: string; work_date: string; property_code: string | null; work_type: string; staff_id: string };
type Day = { period: string; work_date: string; staff_id: string; status: string | null; hours: number | null };
type MP = { period: string; property_code: string; count_override: number | null; linen_taken: number };

const GROUP_LABEL: Record<string, string> = { kai: '房源（開整棟系）', ab: '房源（A、B 系）', zl: '正隆', other: '其他（未列於三表）' };
const GROUPS = ['kai', 'ab', 'zl', 'other'] as const;
const LEAVE_OPTS = ['', '休', '特休', '請假', '颱風假', '報到'];

const ymOf = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const daysIn = (period: string) => {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(4, 6));
  return new Date(y, m, 0).getDate();
};
const dateStr = (period: string, d: number) =>
  `${period.slice(0, 4)}-${period.slice(4, 6)}-${String(d).padStart(2, '0')}`;

export default function HousekeepingPage() {
  const supabase = createClient();
  const [period, setPeriod] = useState(ymOf(new Date()));
  const [tab, setTab] = useState<'schedule' | 'linen' | 'exception'>('schedule');
  const [staff, setStaff] = useState<HkStaff[]>([]);
  const [props, setProps] = useState<HkProperty[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [items, setItems] = useState<Wi[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [mps, setMps] = useState<MP[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const loadMaster = useCallback(async () => {
    const [s, p] = await Promise.all([
      supabase.from('hk_staff').select('*').eq('active', true).order('sort'),
      supabase.from('hk_property').select('*').eq('active', true).order('sort'),
    ]);
    setStaff((s.data ?? []) as HkStaff[]);
    setProps((p.data ?? []) as HkProperty[]);
  }, [supabase]);

  const loadPeriod = useCallback(async () => {
    setLoading(true);
    const [e, w, d, m] = await Promise.all([
      supabase.from('hk_event').select('*').eq('period', period).order('event_date'),
      supabase.from('hk_work_item').select('*').eq('period', period).order('work_date'),
      supabase.from('hk_day').select('*').eq('period', period),
      supabase.from('hk_month_property').select('*').eq('period', period),
    ]);
    setEvents((e.data ?? []) as Ev[]);
    setItems((w.data ?? []) as Wi[]);
    setDays((d.data ?? []) as Day[]);
    setMps((m.data ?? []) as MP[]);
    setLoading(false);
  }, [supabase, period]);

  useEffect(() => { loadMaster(); }, [loadMaster]);
  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  const staffById = useMemo(() => Object.fromEntries(staff.map((s) => [s.id, s])), [staff]);
  const roomStaff = useMemo(() => staff.filter((s) => s.count_mode === 'rooms'), [staff]);
  const hourStaff = useMemo(() => staff.filter((s) => s.count_mode === 'hours'), [staff]);
  const propByCode = useMemo(() => Object.fromEntries(props.map((p) => [p.code, p])), [props]);

  /** 每人每日間數 */
  const roomCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of items) m[`${i.work_date}|${i.staff_id}`] = (m[`${i.work_date}|${i.staff_id}`] ?? 0) + 1;
    return m;
  }, [items]);

  const dayMap = useMemo(
    () => Object.fromEntries(days.map((d) => [`${d.work_date}|${d.staff_id}`, d])), [days]);

  /** 打掃次數（自動值）。手動覆寫在 mpMap。 */
  const autoCounts = useMemo(() => cleanCounts(items, 'clean'), [items]);
  const mpMap = useMemo(() => Object.fromEntries(mps.map((m) => [m.property_code, m])), [mps]);
  const countOf = (code: string) => mpMap[code]?.count_override ?? autoCounts[code] ?? 0;
  const linenOf = (code: string) => mpMap[code]?.linen_taken ?? 0;

  const dayList = useMemo(() => {
    const n = daysIn(period);
    return Array.from({ length: n }, (_, i) => dateStr(period, i + 1));
  }, [period]);

  /** 某日的工作項,依人分組並保持「先 Una 後庭玉」的順序 */
  const itemsOfDay = useCallback((date: string) => {
    const out: { code: string; type: string; staffId: string }[] = [];
    for (const s of staff) {
      for (const i of items) {
        if (i.work_date === date && i.staff_id === s.id) {
          out.push({ code: i.property_code ?? i.work_type, type: i.work_type, staffId: s.id });
        }
      }
    }
    return out;
  }, [items, staff]);

  // ── 匯入 ───────────────────────────────────────────
  const preview = useMemo(() => {
    if (!raw.trim() || !staff.length) return null;
    const rows = raw.trim().split('\n').map((l) => {
      const parts = l.split(/[,\t]/).map((x) => x.trim());
      return { date: parts[0], title: parts[1] ?? '', assignees: parts.slice(2).join(',') };
    }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    const parsed = parseRows(rows, staff, props, { includeGift: true });
    const unknownNames = new Set<string>();
    for (const r of rows) {
      for (const n of splitAssignees(r.assignees)) {
        if (!staff.some((s) => s.source_name === n)) unknownNames.add(n);
      }
    }
    return { rows, parsed, unknownNames: Array.from(unknownNames) };
  }, [raw, staff, props]);

  async function doImport() {
    if (!preview) return;
    const { parsed } = preview;
    const per = parsed[0]?.date.slice(0, 7).replace('-', '') ?? period;
    if (!confirm(`匯入 ${parsed.length} 筆到 ${per}?\n\n同月份的既有資料會先清空再重建。`)) return;
    setBusy(true);
    try {
      // 全刪重建。解析規則會改,增量更新會讓新舊規則的結果混在同一個月裡。
      await supabase.from('hk_work_item').delete().eq('period', per);
      await supabase.from('hk_event').delete().eq('period', per);

      const byName = new Map(staff.map((s) => [s.source_name, s]));
      for (const e of parsed) {
        // 入住準備組完全不匯入
        const known = e.assigneeNames.map((n) => byName.get(n)).filter(Boolean) as HkStaff[];
        if (e.excluded === 'not_counted' && !known.some((s) => s.count_mode !== 'none')) continue;

        const { data: ev, error } = await supabase.from('hk_event').insert({
          period: per, event_date: e.date, title: e.title,
          assignees: e.assigneeNames, parsed_code: e.propertyCode,
          work_type: e.workType, excluded: e.excluded,
        }).select('id').single();
        if (error) { flash('匯入失敗:' + error.message); return; }

        // 休假寫進 hk_day,不產生工作項
        if (e.excluded === 'leave') {
          const s = staff.find((x) => x.code === e.leaveStaffCode);
          if (s) {
            const status = e.title.includes('颱風') ? '颱風假' : '休';
            await supabase.from('hk_day').upsert({
              period: per, work_date: e.date, staff_id: s.id, status,
            }, { onConflict: 'work_date,staff_id' });
          }
          continue;
        }
        if (e.excluded) continue;

        const rows = known.filter((s) => s.count_mode !== 'none').map((s) => ({
          event_id: ev.id, period: per, work_date: e.date,
          property_code: e.propertyCode, work_type: e.workType, staff_id: s.id,
        }));
        if (rows.length) await supabase.from('hk_work_item').insert(rows);
      }
      setPeriod(per); setImportOpen(false); setRaw('');
      flash('匯入完成'); loadPeriod();
    } finally { setBusy(false); }
  }

  // ── 編輯 ───────────────────────────────────────────
  async function setDay(date: string, staffId: string, patch: Partial<Day>) {
    const cur = dayMap[`${date}|${staffId}`];
    const next = { period, work_date: date, staff_id: staffId, status: cur?.status ?? null, hours: cur?.hours ?? null, ...patch };
    setDays((ds) => {
      const rest = ds.filter((d) => !(d.work_date === date && d.staff_id === staffId));
      return [...rest, next as Day];
    });
    await supabase.from('hk_day').upsert(next, { onConflict: 'work_date,staff_id' });
  }

  async function setMp(code: string, patch: Partial<MP>) {
    const cur = mpMap[code];
    const next = { period, property_code: code, count_override: cur?.count_override ?? null, linen_taken: cur?.linen_taken ?? 0, ...patch };
    setMps((ms) => [...ms.filter((m) => m.property_code !== code), next as MP]);
    await supabase.from('hk_month_property').upsert(next, { onConflict: 'period,property_code' });
  }

  // ── 匯出 ───────────────────────────────────────────
  function exportXlsx() {
    const head: any[] = ['日期', ...roomStaff.map((s) => `${s.name}/間數`), ...hourStaff.map((s) => `${s.name}/時數`), '房源'];
    const body = dayList.map((d) => {
      const row: any[] = [d];
      for (const s of roomStaff) {
        const st = dayMap[`${d}|${s.id}`]?.status;
        row.push(st ? st : (roomCount[`${d}|${s.id}`] ?? ''));
      }
      for (const s of hourStaff) row.push(dayMap[`${d}|${s.id}`]?.hours ?? '');
      for (const it of itemsOfDay(d)) row.push(it.type === '贈品補充' ? `${it.code}-贈` : it.code);
      return row;
    });
    const sheet = [head, ...body, []];

    for (const g of GROUPS) {
      const list = props.filter((p) => p.linen_group === g);
      if (!list.length) continue;
      sheet.push([GROUP_LABEL[g], '次數', '幾床', '床數', '拿床單', '小計']);
      let sub = 0;
      for (const p of list) {
        const c = countOf(p.code), b = p.beds ?? 0, lt = linenOf(p.code);
        sheet.push([p.code, c, p.beds ?? '', c * b, lt, c * b + lt]);
        sub += c * b + lt;
      }
      sheet.push(['小計', '', '', '', '', sub]);
      sheet.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(sheet);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, period);
    XLSX.writeFile(wb, `${period}_房務排班統計.xlsx`);
  }

  const exceptions = useMemo(() => ({
    noAssignee: events.filter((e) => e.excluded === 'no_assignee'),
    unknownProp: events.filter((e) => !e.excluded && !e.parsed_code
      && !['協助行政', '洗烘折毛巾'].some((k) => e.title.includes(k))),
    noBeds: Array.from(new Set(items.map((i) => i.property_code).filter(Boolean) as string[]))
      .filter((c) => propByCode[c]?.beds == null),
    heavy: Object.entries(autoCounts).filter(([, n]) => n >= 3),
  }), [events, items, propByCode, autoCounts]);

  const totalLinen = useMemo(() => {
    let t = 0;
    for (const p of props) t += countOf(p.code) * (p.beds ?? 0) + linenOf(p.code);
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, mpMap, autoCounts]);

  const inp = 'rounded border border-gray-300 px-1.5 py-1 text-xs';
  const tabBtn = (k: typeof tab, label: string) => (
    <button onClick={() => setTab(k)}
      className={`px-4 h-10 rounded-lg text-sm font-medium ${tab === k ? 'bg-mor-slate text-white' : 'bg-white border border-mor-line text-gray-600'}`}>
      {label}
    </button>
  );

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-sm">{msg}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input type="month" value={`${period.slice(0, 4)}-${period.slice(4, 6)}`}
          onChange={(e) => setPeriod(e.target.value.replace('-', ''))}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        {tabBtn('schedule', '排班表')}
        {tabBtn('linen', '布巾統計')}
        {tabBtn('exception', `例外 ${exceptions.noAssignee.length + exceptions.unknownProp.length + exceptions.noBeds.length}`)}
        <div className="ml-auto flex gap-2">
          <button onClick={() => setImportOpen(true)}
            className="rounded-lg border border-mor-slate text-mor-slate px-3 py-1.5 text-sm font-medium hover:bg-mor-sand/60">⬆ 匯入排班</button>
          <button onClick={exportXlsx} disabled={!items.length}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
        </div>
      </div>

      {/* 摘要 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {roomStaff.map((s) => {
          const total = dayList.reduce((a, d) => a + (roomCount[`${d}|${s.id}`] ?? 0), 0);
          const leave = dayList.filter((d) => dayMap[`${d}|${s.id}`]?.status).length;
          return (
            <div key={s.id} className="rounded-xl bg-white border border-mor-line p-4 min-w-0">
              <div className="text-xs text-gray-500">{s.name}</div>
              <div className="stat-num font-bold mt-1">{total} <span className="text-sm font-normal text-gray-400">間</span></div>
              <div className="text-xs text-gray-400 mt-0.5">休假 {leave} 天</div>
            </div>
          );
        })}
        {hourStaff.map((s) => {
          const total = dayList.reduce((a, d) => a + Number(dayMap[`${d}|${s.id}`]?.hours ?? 0), 0);
          return (
            <div key={s.id} className="rounded-xl bg-white border border-mor-line p-4 min-w-0">
              <div className="text-xs text-gray-500">{s.name}</div>
              <div className="stat-num font-bold mt-1">{total} <span className="text-sm font-normal text-gray-400">小時</span></div>
              <div className="text-xs text-gray-400 mt-0.5">手動填寫</div>
            </div>
          );
        })}
        <div className="rounded-xl bg-mor-slate text-white p-4 min-w-0">
          <div className="text-xs opacity-80">床單總計</div>
          <div className="stat-num font-bold mt-1">{totalLinen}</div>
          <div className="text-xs opacity-70 mt-0.5">床數 + 拿床單</div>
        </div>
      </div>

      {loading ? <div className="text-center text-gray-400 py-16">載入中…</div>
      : tab === 'schedule' ? (
        <div className="rounded-xl border border-mor-line bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
                <th className="px-3 py-2.5 whitespace-nowrap">日期</th>
                {roomStaff.map((s) => <th key={s.id} className="px-3 py-2.5 whitespace-nowrap">{s.name}/間數</th>)}
                {hourStaff.map((s) => <th key={s.id} className="px-3 py-2.5 whitespace-nowrap">{s.name}/時數</th>)}
                <th className="px-3 py-2.5">房源</th>
              </tr>
            </thead>
            <tbody>
              {dayList.map((d) => {
                const its = itemsOfDay(d);
                return (
                  <tr key={d} className="border-b border-mor-line/60 last:border-0">
                    <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{d.slice(5)}</td>
                    {roomStaff.map((s) => {
                      const st = dayMap[`${d}|${s.id}`]?.status ?? '';
                      const n = roomCount[`${d}|${s.id}`] ?? 0;
                      return (
                        <td key={s.id} className="px-3 py-1.5 whitespace-nowrap">
                          {/* 休假是狀態不是數字 —— 兩者互斥,休假日不該有間數 */}
                          <select value={st} onChange={(e) => setDay(d, s.id, { status: e.target.value || null })}
                            className={`${inp} w-20 ${st ? 'bg-amber-50 text-amber-700' : 'text-gray-400'}`}>
                            {LEAVE_OPTS.map((o) => <option key={o} value={o}>{o || (n ? String(n) : '—')}</option>)}
                          </select>
                          {!st && n > 0 && <span className="ml-1 font-medium">{n}</span>}
                        </td>
                      );
                    })}
                    {hourStaff.map((s) => (
                      <td key={s.id} className="px-3 py-1.5">
                        <input type="number" step="0.5" min="0" value={dayMap[`${d}|${s.id}`]?.hours ?? ''}
                          onChange={(e) => setDay(d, s.id, { hours: e.target.value === '' ? null : Number(e.target.value) })}
                          className={`${inp} w-16 text-right`} />
                      </td>
                    ))}
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {its.map((it, i) => {
                          const c = staffById[it.staffId]?.color;
                          return (
                            <span key={i} className="inline-block rounded px-1.5 py-0.5 text-xs"
                              style={{ backgroundColor: c ? `#${c}` : '#f3f4f6' }}>
                              {it.type === '贈品補充' ? `${it.code}-贈` : it.code}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'linen' ? (
        <div className="space-y-4">
          {GROUPS.map((g) => {
            const list = props.filter((p) => p.linen_group === g);
            if (!list.length) return null;
            const sub = list.reduce((a, p) => a + countOf(p.code) * (p.beds ?? 0) + linenOf(p.code), 0);
            return (
              <div key={g} className="rounded-xl border border-mor-line bg-white overflow-x-auto">
                <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40 font-medium text-sm">{GROUP_LABEL[g]}</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-mor-line/60 text-left text-xs text-gray-500">
                      <th className="px-3 py-2">房源</th>
                      <th className="px-3 py-2 text-right">次數</th>
                      <th className="px-3 py-2 text-right">幾床</th>
                      <th className="px-3 py-2 text-right">床數</th>
                      <th className="px-3 py-2 text-right">拿床單</th>
                      <th className="px-3 py-2 text-right">小計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => {
                      const auto = autoCounts[p.code] ?? 0;
                      const c = countOf(p.code);
                      const beds = p.beds ?? 0;
                      const lt = linenOf(p.code);
                      const over = mpMap[p.code]?.count_override != null;
                      return (
                        <tr key={p.code} className={`border-b border-mor-line/40 last:border-0 ${c === 0 ? 'text-gray-300' : ''}`}>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {p.code}
                            {p.beds == null && <span className="ml-1 text-[10px] text-amber-600">待補幾床</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <input type="number" min="0" value={c}
                              onChange={(e) => setMp(p.code, { count_override: e.target.value === '' ? null : Number(e.target.value) })}
                              className={`${inp} w-14 text-right ${over ? 'bg-amber-50 text-amber-700' : ''}`}
                              title={over ? `自動值 ${auto},已手動覆寫` : '自動計算'} />
                          </td>
                          <td className="px-3 py-1.5 text-right text-gray-500">{p.beds ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right">{c * beds}</td>
                          <td className="px-3 py-1.5 text-right">
                            <input type="number" min="0" value={lt || ''}
                              onChange={(e) => setMp(p.code, { linen_taken: Number(e.target.value) || 0 })}
                              className={`${inp} w-14 text-right`} />
                          </td>
                          <td className="px-3 py-1.5 text-right font-medium">{c * beds + lt}</td>
                        </tr>
                      );
                    })}
                    <tr className="bg-mor-sand/30 font-medium">
                      <td className="px-3 py-2" colSpan={5}>小計</td>
                      <td className="px-3 py-2 text-right">{sub}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {[
            { title: '未指派負責人', rows: exceptions.noAssignee.map((e) => `${e.event_date}　${e.title}`), hint: '這些事件沒有人負責,不計入任何統計。' },
            { title: '房源無法解析', rows: exceptions.unknownProp.map((e) => `${e.event_date}　${e.title}`), hint: '標題裡抽不出對得上主檔的房源。到設定加別名,或建立新房源後重新匯入。' },
            { title: '尚未建檔「幾床」', rows: exceptions.noBeds, hint: '這些房源有清掃紀錄但沒有床數,床單推算會少算。' },
            { title: '同月清掃 3 次以上', rows: exceptions.heavy.map(([c, n]) => `${c}　${n} 次`), hint: '可能是重複建立的事件,值得看一眼。' },
          ].map((sec) => (
            <div key={sec.title} className="rounded-xl border border-mor-line bg-white">
              <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40 flex items-center justify-between">
                <span className="font-medium text-sm">{sec.title}</span>
                <span className={`text-xs ${sec.rows.length ? 'text-amber-600' : 'text-gray-400'}`}>{sec.rows.length} 筆</span>
              </div>
              <div className="px-4 py-3 text-sm">
                <div className="text-xs text-gray-400 mb-2">{sec.hint}</div>
                {sec.rows.length === 0 ? <div className="text-gray-300 text-xs">無</div>
                : <ul className="space-y-1">{sec.rows.map((r, i) => <li key={i} className="text-gray-700">{r}</li>)}</ul>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 匯入 */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50"
          onClick={() => setImportOpen(false)}>
          <div className="bg-white w-full md:w-[860px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between z-10">
              匯入排班
              <button onClick={() => setImportOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="p-6 space-y-3 text-sm">
              <div className="text-xs text-gray-500">
                每行一筆,格式 <code className="bg-gray-100 px-1">日期,事項,負責人</code>。
                多位負責人用 <code className="bg-gray-100 px-1">+</code> 分隔。可直接從 Excel 複製貼上。
              </div>
              <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
                placeholder={'2026-07-01,17B5-細清（不用鋪床）,SHAO-YING HSIEH + Ayu\n2026-07-02,贈-4B1*2,SHAO-YING HSIEH + Ayu'}
                className="w-full h-48 rounded-lg border border-mor-line px-2 py-2 font-mono text-xs" />

              {preview && (
                <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40 text-xs">
                  <div className="px-3 py-2 flex flex-wrap gap-4">
                    <span>共 <b>{preview.parsed.length}</b> 筆</span>
                    <span className="text-mor-green">採計 {preview.parsed.filter((p) => !p.excluded).length}</span>
                    <span className="text-amber-600">休假 {preview.parsed.filter((p) => p.excluded === 'leave').length}</span>
                    <span className="text-gray-400">不計 {preview.parsed.filter((p) => p.excluded === 'not_counted').length}</span>
                    <span className="text-red-600">未指派 {preview.parsed.filter((p) => p.excluded === 'no_assignee').length}</span>
                  </div>
                  {preview.parsed.some((p) => !p.excluded && p.unknownToken) && (
                    <div className="px-3 py-2 text-red-600">
                      未識別房源:{Array.from(new Set(preview.parsed.filter((p) => !p.excluded && p.unknownToken).map((p) => p.unknownToken))).join('、')}
                      <div className="text-gray-400 mt-0.5">仍會匯入,但不會計入打掃次數。建議先到設定補建房源或別名。</div>
                    </div>
                  )}
                  {preview.unknownNames.length > 0 && (
                    <div className="px-3 py-2 text-red-600">
                      未知人員:{preview.unknownNames.join('、')}
                      <div className="text-gray-400 mt-0.5">不在人員主檔內,這些人的工作項會被略過。</div>
                    </div>
                  )}
                  <div className="px-3 py-2 max-h-40 overflow-auto">
                    {preview.parsed.slice(0, 12).map((p, i) => (
                      <div key={i} className="flex gap-2 py-0.5">
                        <span className="text-gray-400 w-20 shrink-0">{p.date.slice(5)}</span>
                        <span className="flex-1 min-w-0 truncate">{p.title}</span>
                        <span className={`w-24 shrink-0 text-right ${p.excluded ? 'text-gray-400' : 'text-mor-blue'}`}>
                          {p.excluded === 'leave' ? '休假' : p.excluded === 'no_assignee' ? '未指派'
                            : p.excluded ? '不計' : (p.propertyCode ?? '無房源')}
                        </span>
                      </div>
                    ))}
                    {preview.parsed.length > 12 && <div className="text-gray-400 pt-1">…另有 {preview.parsed.length - 12} 筆</div>}
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setImportOpen(false)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doImport} disabled={!preview || busy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {busy ? '匯入中…' : '確認匯入'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
