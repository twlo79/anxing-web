'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Estate = { id: string; name: string; sort: number };
type StaffStat = { staff_name: string; staff_type: string; total: number; rated: number; avg_rating: number | null; low_count: number };
type Rec = {
  id: string; record_key: string; record_date: string; staff_name: string; staff_type: string | null;
  property_id: string | null; property_raw: string | null; estate_name: string | null;
  overall_rating: number | null; note: string | null; doc_url: string | null;
};

const PAGE_SIZE = 50;
const TYPE_LABEL: Record<string, string> = { housekeeper: '管家', roomservice: '房務', other: '其他' };

function csvEsc(v: unknown) {
  if (v == null) return '';
  const s = String(v).replace(/\r\n/g, '\n');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function CleaningPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [exporting, setExporting] = useState(false);
  // filters
  const [estate, setEstate] = useState('');
  const [staff, setStaff] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');
  // stats
  const [statsFrom, setStatsFrom] = useState('');
  const [statsTo, setStatsTo] = useState('');
  const [stats, setStats] = useState<StaffStat[]>([]);

  useEffect(() => {
    supabase.from('estates').select('id, name, sort').order('sort').then(({ data }) => setEstates(data ?? []));
  }, [supabase]);
  useEffect(() => {
    supabase.rpc('cleaning_staff_stats', { p_from: statsFrom || null, p_to: statsTo || null })
      .then(({ data }) => setStats((data as StaffStat[]) ?? []));
  }, [supabase, statsFrom, statsTo]);

  const totalCount = useMemo(() => stats.reduce((s, x) => s + Number(x.total), 0), [stats]);

  const buildQuery = useCallback((count: boolean) => {
    let q = supabase.from('cleaning_records').select('*', count ? { count: 'exact' } : undefined)
      .order('record_date', { ascending: false });
    if (estate) q = q.eq('estate_name', estate);
    if (staff) q = q.eq('staff_name', staff);
    if (dateFrom) q = q.gte('record_date', dateFrom);
    if (dateTo) q = q.lte('record_date', dateTo);
    if (kw) q = q.or(`note.ilike.%${kw}%,property_raw.ilike.%${kw}%`);
    return q;
  }, [supabase, estate, staff, dateFrom, dateTo, kw]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, count } = await buildQuery(true).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    setRows((data as any) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [buildQuery, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [estate, staff, dateFrom, dateTo, kw]);

  const staffNames = useMemo(() => [...stats].sort((a, b) => Number(b.total) - Number(a.total)).map((s) => s.staff_name), [stats]);

  async function exportCsv() {
    setExporting(true);
    const all: Rec[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      const { data } = await buildQuery(false).range(from, from + 999);
      const b = (data as any as Rec[]) ?? [];
      all.push(...b);
      if (b.length < 1000) break;
    }
    const header = ['記錄日', '物業', '房源', '填寫人', '身分', '備註', '表單'];
    const lines = [header.join(',')];
    for (const r of all) lines.push([
      r.record_date, r.estate_name, r.property_raw, r.staff_name, TYPE_LABEL[r.staff_type || 'other'],
      r.note ?? '', r.doc_url ?? '',
    ].map(csvEsc).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `清潔紀錄_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setExporting(false);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {/* Dashboard */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h1 className="text-xl font-bold">清潔記錄</h1>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-gray-500">統計區間</span>
            <input type="date" value={statsFrom} onChange={(e) => setStatsFrom(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
            <span className="text-gray-400">~</span>
            <input type="date" value={statsTo} onChange={(e) => setStatsTo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
            {(statsFrom || statsTo) && <button onClick={() => { setStatsFrom(''); setStatsTo(''); }} className="text-gray-400 underline">清除</button>}
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
          <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center">
            <div className="text-xs opacity-75">總清潔次數</div>
            <div className="text-4xl font-bold mt-1">{totalCount.toLocaleString()}</div>
            <div className="text-xs opacity-75 mt-2">共 {stats.length} 位填寫人</div>
          </div>
          <div className="lg:col-span-2 rounded-xl bg-white border border-mor-line overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依填寫人統計</div>
            <div className="max-h-56 overflow-y-auto">
              {stats.map((m) => {
                const max = Math.max(...stats.map((x) => Number(x.total))) || 1;
                return (
                  <div key={m.staff_name} className="px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0">
                    <span className="w-16 font-medium truncate">{m.staff_name}<span className="ml-1 text-xs text-gray-400">{TYPE_LABEL[m.staff_type]}</span></span>
                    <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden"><div className="h-full bg-mor-green" style={{ width: `${(Number(m.total) / max) * 100}%` }} /></div>
                    <span className="w-16 text-right text-xs text-gray-500">{Number(m.total)} 次</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estate} onChange={(e) => setEstate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-24">
            <option value="">全部</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">填寫人</label>
          <select value={staff} onChange={(e) => setStaff(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-20">
            <option value="">全部</option>{staffNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">日期(起)</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">日期(迄)</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(備註/房號)</label>
          <div className="flex gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="例:冰箱、拖鞋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-32" />
            <button onClick={() => setKw(kwInput.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(estate || staff || dateFrom || dateTo || kw) && (
          <button onClick={() => { setEstate(''); setStaff(''); setDateFrom(''); setDateTo(''); setKw(''); setKwInput(''); }} className="text-gray-500 underline pb-1.5">清除篩選</button>
        )}
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {total.toLocaleString()} 筆</div>
          <button onClick={exportCsv} disabled={exporting || total === 0} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">{exporting ? '匯出中…' : '⬇ 下載 CSV'}</button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5 whitespace-nowrap">記錄日</th>
              <th className="px-3 py-2.5">物業</th>
              <th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">填寫人</th>
              <th className="px-3 py-2.5">備註</th>
              <th className="px-3 py-2.5 whitespace-nowrap">表單</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">沒有符合條件的紀錄</td></tr>
            : rows.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/40 align-top">
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 cursor-pointer" onClick={() => setDetail(r)}>{r.record_date}</td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}><span className="inline-block rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs font-medium">{r.estate_name ?? '—'}</span></td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}>{r.property_raw ?? '—'}</td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}>{r.staff_name}<span className="ml-1 text-xs text-gray-400">{TYPE_LABEL[r.staff_type || 'other']}</span></td>
                <td className="px-3 py-2.5 text-gray-600 min-w-64 cursor-pointer" onClick={() => setDetail(r)}><div className="line-clamp-2">{r.note ?? <span className="text-gray-300">（無備註）</span>}</div></td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.doc_url ? <a href={r.doc_url} target="_blank" rel="noreferrer" className="text-mor-slate underline hover:text-mor-blue" onClick={(e) => e.stopPropagation()}>📄 詳細內容</a> : <span className="text-gray-300">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-500">
          <div>第 {page + 1} / {pages} 頁</div>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">上一頁</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">下一頁</button>
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-center justify-between">
              <div>
                <div className="font-bold">{detail.estate_name} ・ {detail.property_raw}</div>
                <div className="text-xs text-gray-500 mt-0.5">{detail.record_date}・{detail.staff_name}({TYPE_LABEL[detail.staff_type || 'other']})</div>
              </div>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="px-6 py-5 space-y-5 text-sm">
              <div>
                <div className="text-xs text-gray-500 mb-1.5 font-medium">備註</div>
                <p className="whitespace-pre-wrap leading-relaxed">{detail.note ?? '（無）'}</p>
              </div>
              {detail.doc_url && <a href={detail.doc_url} target="_blank" rel="noreferrer" className="inline-block rounded-lg bg-mor-bluelight text-mor-slate px-4 py-2 font-medium hover:bg-mor-blue hover:text-white">📄 開啟詳細記錄</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
