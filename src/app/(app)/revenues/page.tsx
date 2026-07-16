'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Row = {
  order_id: string; source: string; estate_id: string | null; estate_name: string | null;
  property_raw: string | null; guest_name: string | null; checkin: string; checkout: string;
  total_amount: number; total_nights: number; month_nights: number; month_amount: number;
};

const SOURCE_LABEL: Record<string, string> = {
  airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', partner: '搭檔收款',
  airbnb_cancelled: 'Airbnb取消', longterm: '長租', office: '辦公室租金', company: '公司登記', other: '其他',
};
const SOURCE_COLOR: Record<string, string> = {
  airbnb: 'bg-mor-bluelight text-mor-slate', agoda: 'bg-purple-50 text-purple-700',
  private: 'bg-mor-greenlight text-mor-green', partner: 'bg-teal-50 text-teal-700',
  airbnb_cancelled: 'bg-red-50 text-red-600', longterm: 'bg-amber-50 text-amber-700',
  office: 'bg-orange-50 text-orange-700', company: 'bg-gray-100 text-gray-600', other: 'bg-gray-100 text-gray-500',
};
const SOURCE_ORDER = ['airbnb', 'agoda', 'private', 'partner', 'airbnb_cancelled', 'longterm', 'office', 'company', 'other'];

const fmt = (n: number) => Math.round(n).toLocaleString();
function monthsInRange(from: string, to: string) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const out: [number, number][] = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) { out.push([y, m]); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
function csvEsc(v: unknown) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default function RevenuesPage() {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [fromM, setFromM] = useState('2026-06');
  const [toM, setToM] = useState('2026-06');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [estateFilter, setEstateFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const months = monthsInRange(fromM, toM).slice(0, 24);
    const all: Row[] = [];
    for (const [y, m] of months) {
      const { data } = await supabase.rpc('monthly_revenue', { p_year: y, p_month: m });
      for (const r of (data as Row[]) ?? []) if (Number(r.month_amount) !== 0) all.push({ ...r, order_id: `${r.order_id}_${y}${m}` });
    }
    setRows(all);
    setLoading(false);
  }, [supabase, fromM, toM]);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (estateFilter && (r.estate_name ?? '無') !== estateFilter) return false;
    if (sourceFilter && r.source !== sourceFilter) return false;
    if (kw) { const s = `${r.guest_name ?? ''}${r.property_raw ?? ''}${r.estate_name ?? ''}`; if (!s.includes(kw)) return false; }
    return true;
  }), [rows, estateFilter, sourceFilter, kw]);

  const total = useMemo(() => filtered.reduce((s, r) => s + Number(r.month_amount), 0), [filtered]);
  const bySource = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) m[r.source] = (m[r.source] || 0) + Number(r.month_amount);
    return SOURCE_ORDER.filter((s) => m[s]).map((s) => [s, m[s]] as [string, number]);
  }, [filtered]);
  const byEstate = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) { const k = r.estate_name ?? '無物業'; m[k] = (m[k] || 0) + Number(r.month_amount); }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [filtered]);
  const estateOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.estate_name ?? "無"))).sort(), [rows]);

  function exportCsv() {
    const header = ['來源', '物業', '房源', '客戶', '起日', '迄日', '訂單總額', '總天數', '當期天數', '當期認列'];
    const lines = [header.join(',')];
    for (const r of filtered) lines.push([
      SOURCE_LABEL[r.source] ?? r.source, r.estate_name ?? '', r.property_raw ?? '', r.guest_name ?? '',
      r.checkin, r.checkout, Math.round(r.total_amount), r.total_nights, r.month_nights, Math.round(r.month_amount),
    ].map(csvEsc).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `營收_${fromM}_${toM}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-xl font-bold">營收</h1>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs text-gray-500">期間</span>
          <input type="month" value={fromM} onChange={(e) => setFromM(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
          <span className="text-gray-400">~</span>
          <input type="month" value={toM} onChange={(e) => setToM(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
        </div>
      </div>

      {/* Dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4 items-stretch">
        <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center">
          <div className="text-xs opacity-75">當期營收總額</div>
          <div className="text-3xl font-bold mt-1">${fmt(total)}</div>
          <div className="text-xs opacity-75 mt-2">{fromM} ~ {toM}・{filtered.length} 筆認列</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依來源</div>
          <div className="max-h-56 overflow-y-auto">
            {bySource.map(([s, v]) => (
              <div key={s} onClick={() => setSourceFilter(sourceFilter === s ? '' : s)}
                className={`px-4 py-2 flex items-center justify-between text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${sourceFilter === s ? 'bg-mor-bluelight/60' : ''}`}>
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[s]}`}>{SOURCE_LABEL[s] ?? s}</span>
                <span className="font-semibold">${fmt(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依物業</div>
          <div className="max-h-56 overflow-y-auto">
            {byEstate.map(([e, v]) => {
              const max = byEstate[0]?.[1] || 1;
              return (
                <div key={e} onClick={() => setEstateFilter(estateFilter === e ? '' : e)}
                  className={`px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${estateFilter === e ? 'bg-mor-bluelight/60' : ''}`}>
                  <span className="w-16 truncate">{e}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden"><div className="h-full bg-mor-blue" style={{ width: `${(v / max) * 100}%` }} /></div>
                  <span className="w-24 text-right font-semibold">${fmt(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estateFilter} onChange={(e) => setEstateFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-24">
            <option value="">全部</option>{estateOptions.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{SOURCE_ORDER.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(客戶/房源)</label>
          <div className="flex gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="搜尋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-28" />
            <button onClick={() => setKw(kwInput.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(estateFilter || sourceFilter || kw) && <button onClick={() => { setEstateFilter(''); setSourceFilter(''); setKw(''); setKwInput(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {filtered.length} 筆・${fmt(total)}</div>
          <button onClick={exportCsv} disabled={!filtered.length} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 CSV</button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5">來源</th><th className="px-3 py-2.5">物業</th><th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">客戶</th><th className="px-3 py-2.5 whitespace-nowrap">起~迄</th>
              <th className="px-3 py-2.5 text-right">訂單總額</th><th className="px-3 py-2.5 text-right whitespace-nowrap">當期天數</th>
              <th className="px-3 py-2.5 text-right">當期認列</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">此期間無認列營收</td></tr>
            : filtered.sort((a, b) => Number(b.month_amount) - Number(a.month_amount)).map((r) => (
              <tr key={r.order_id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30">
                <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[r.source]}`}>{SOURCE_LABEL[r.source] ?? r.source}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{r.estate_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.property_raw ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.guest_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{r.checkin}~{r.checkout}</td>
                <td className="px-3 py-2 text-right text-gray-500">${fmt(r.total_amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500 text-xs">{r.month_nights}/{r.total_nights}</td>
                <td className="px-3 py-2 text-right font-semibold">${fmt(r.month_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
