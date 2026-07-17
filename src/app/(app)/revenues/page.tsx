'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import * as XLSX from 'xlsx-js-style';

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
  const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastYm = `${lastM.getFullYear()}-${String(lastM.getMonth() + 1).padStart(2, '0')}`;
  const [fromM, setFromM] = useState(lastYm);
  const [toM, setToM] = useState(lastYm);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [estateFilter, setEstateFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');

  const fetchMonthRows = useCallback(async (y: number, m: number): Promise<Row[]> => {
    const ym = `${y}${String(m).padStart(2, '0')}`;
    if (ym < '202606') {
      const { data } = await supabase.from('revenue_snapshots').select('*').eq('ym', ym).limit(2000);
      return ((data as any[]) ?? []).map((r) => ({
        order_id: r.id, source: r.source, estate_id: null, estate_name: r.estate_name,
        property_raw: r.property_raw, guest_name: r.guest_name, checkin: r.checkin, checkout: r.checkout,
        total_amount: Number(r.total_amount ?? r.month_amount), total_nights: r.total_nights ?? 0,
        month_nights: r.month_nights ?? 0, month_amount: Number(r.month_amount),
      }));
    }
    const { data } = await supabase.from('revenue_recognitions').select('*').eq('ym', ym).limit(3000);
    return ((data as any[]) ?? []).map((r) => ({
      order_id: r.id, source: r.source, estate_id: r.estate_id, estate_name: r.estate_name,
      property_raw: r.property_raw, guest_name: r.guest_name, checkin: r.checkin, checkout: r.checkout,
      total_amount: Number(r.total_amount ?? 0), total_nights: r.total_nights ?? 0,
      month_nights: r.month_nights ?? 0, month_amount: Number(r.month_amount),
    })).filter((r) => r.month_amount !== 0);
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const months = monthsInRange(fromM, toM).slice(0, 24);
    const all: Row[] = [];
    for (const [y, m] of months) {
      const list = await fetchMonthRows(y, m);
      for (const r of list) all.push({ ...r, order_id: `${r.order_id}_${y}${m}` });
    }
    setRows(all);
    setLoading(false);
  }, [supabase, fromM, toM, fetchMonthRows]);
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
    for (const r of filtered) {
      const k = r.estate_name ?? (r.source === 'company' ? '公司登記(無物業)' : r.source === 'other' ? '其他' : '無物業');
      m[k] = (m[k] || 0) + Number(r.month_amount);
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [filtered]);
  const estateOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.estate_name ?? "無"))).sort(), [rows]);

  async function exportXlsx() {
    const months = monthsInRange(fromM, toM).slice(0, 24);
    const { data: estateRows } = await supabase.from('estates').select('name, manager, sort').order('sort');
    const managerOf: Record<string, string> = {};
    const estateSort: Record<string, number> = {};
    (estateRows ?? []).forEach((e: any, i: number) => { if (e.manager) managerOf[e.name] = e.manager; estateSort[e.name] = i; });

    const monthData: { ym: string; y: number; m: number; rows: Row[] }[] = [];
    for (const [y, m] of months) {
      monthData.push({ ym: `${y}${String(m).padStart(2, '0')}`, y, m, rows: await fetchMonthRows(y, m) });
    }

    // ===== 樣式 =====
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stTitle = { font: { bold: true, sz: 14 }, alignment: { horizontal: 'center' } };
    const stSub = { font: { sz: 11, color: { rgb: '777777' } }, alignment: { horizontal: 'center' } };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stTotal = { font: { bold: true }, fill: { fgColor: { rgb: 'F9CBAD' } }, border: BORD };
    const stGroup = { font: { bold: true }, fill: { fgColor: { rgb: 'FFF2CC' } }, border: BORD };
    const stCell = { border: BORD };
    const stSubtotal = { font: { bold: true }, fill: { fgColor: { rgb: 'E2EFDA' } }, border: BORD };
    const T = (v: any, s: any) => ({ v, t: typeof v === 'number' ? 'n' : 's', s, z: typeof v === 'number' ? '#,##0' : undefined });

    const wb = XLSX.utils.book_new();
    const AB = ['airbnb', 'partner', 'airbnb_cancelled', 'agoda'];
    const eSort = (a: string, b: string) => (estateSort[a] ?? 99) - (estateSort[b] ?? 99);

    // ===== 分頁1:營收總表 =====
    const blocks: any[][][] = [];
    for (const md of monthData) {
      const rs = md.rows;
      const S = (f: (r: Row) => boolean) => Math.round(rs.filter(f).reduce((a, r) => a + Number(r.month_amount), 0));
      const b: any[][] = [];
      b.push([T(`${md.m}月份總收入`, stTotal), T(S(() => true), stTotal)]);
      b.push([T('總營收分類', stGroup), T('', stGroup)]);
      for (const s0 of SOURCE_ORDER) { const v0 = S((r) => r.source === s0); if (v0) b.push([T(SOURCE_LABEL[s0], stCell), T(v0, stCell)]); }
      b.push([T('', {}), T('', {})]);
      b.push([T('AIRBNB', stGroup), T(S((r) => AB.includes(r.source)), stGroup)]);
      Array.from(new Set(rs.filter((r) => AB.includes(r.source)).map((r) => r.estate_name ?? '無物業'))).sort(eSort)
        .forEach((e) => b.push([T(e, stCell), T(S((r) => AB.includes(r.source) && (r.estate_name ?? '無物業') === e), stCell)]));
      b.push([T('私下', stGroup), T(S((r) => r.source === 'private'), stGroup)]);
      Array.from(new Set(rs.filter((r) => r.source === 'private').map((r) => r.estate_name ?? '無物業'))).sort(eSort)
        .forEach((e) => b.push([T(e, stCell), T(S((r) => r.source === 'private' && (r.estate_name ?? '無物業') === e), stCell)]));
      b.push([T('長租', stGroup), T(S((r) => r.source === 'longterm' && r.estate_name !== '正隆'), stGroup)]);
      Array.from(new Set(rs.filter((r) => r.source === 'longterm' && r.estate_name !== '正隆').map((r) => r.property_raw ?? ''))).sort()
        .forEach((pp) => b.push([T(pp, stCell), T(S((r) => r.source === 'longterm' && r.estate_name !== '正隆' && r.property_raw === pp), stCell)]));
      b.push([T('正隆官邸', stGroup), T(S((r) => r.source === 'longterm' && r.estate_name === '正隆'), stGroup)]);
      Array.from(new Set(rs.filter((r) => r.source === 'longterm' && r.estate_name === '正隆').map((r) => r.property_raw ?? ''))).sort()
        .forEach((pp) => b.push([T(pp, stCell), T(S((r) => r.source === 'longterm' && r.estate_name === '正隆' && r.property_raw === pp), stCell)]));
      b.push([T('辦公室租金', stGroup), T(S((r) => r.source === 'office'), stGroup)]);
      Array.from(new Set(rs.filter((r) => r.source === 'office').map((r) => r.guest_name ?? '')))
        .forEach((g) => b.push([T(g, stCell), T(S((r) => r.source === 'office' && r.guest_name === g), stCell)]));
      b.push([T('公司登記', stGroup), T(S((r) => r.source === 'company'), stGroup)]);
      Array.from(new Set(rs.filter((r) => r.source === 'company').map((r) => r.guest_name ?? '')))
        .forEach((g) => b.push([T(g, stCell), T(S((r) => r.source === 'company' && r.guest_name === g), stCell)]));
      blocks.push(b);
    }
    const maxLen = Math.max(...blocks.map((b) => b.length));
    const nCols = blocks.length * 2;
    const aoa: any[][] = [];
    aoa.push([T(`${monthData[0].y}年營收總表`, stTitle), ...Array(nCols - 1).fill(T('', {}))]);
    aoa.push(blocks.flatMap((_, i) => [T(`${monthData[i].m}月`, stHead), T('', stHead)]));
    for (let i = 0; i < maxLen; i++) aoa.push(blocks.flatMap((b) => b[i] ?? [T('', {}), T('', {})]));
    const wsT = XLSX.utils.aoa_to_sheet(aoa);
    wsT['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: nCols - 1 } }];
    wsT['!cols'] = Array.from({ length: nCols }, (_, i) => ({ wch: i % 2 === 0 ? 16 : 12 }));
    XLSX.utils.book_append_sheet(wb, wsT, '營收總表');

    // ===== 各月明細分頁 =====
    for (const md of monthData) {
      const ms = `${md.y}-${String(md.m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(md.m === 12 ? md.y + 1 : md.y, md.m === 12 ? 0 : md.m, 0)).getUTCDate();
      const me = new Date(Date.UTC(md.m === 12 ? md.y + 1 : md.y, md.m === 12 ? 0 : md.m, 1)).toISOString().slice(0, 10);
      const { data: revs } = await supabase.from('reviews')
        .select('guest_name, checkout_date, overall_rating, properties(name)')
        .gte('checkout_date', ms).lt('checkout_date', me);
      const ratingByKey: Record<string, number> = {};
      const ratingByGuest: Record<string, number> = {};
      for (const rv of (revs as any[]) ?? []) {
        const pn = rv.properties?.name ?? '';
        ratingByKey[`${pn}|${rv.checkout_date}`] = rv.overall_rating;
        ratingByGuest[`${pn}|${(rv.guest_name || '').split(' ')[0]}`] = rv.overall_rating;
      }
      const header = ['姓名', '房源', '來源', '起日', '迄日', '訂單總金額', '當月收入', '當月天數', '總天數', '均價', '負責人', '評價', '入帳', '帳戶', '押金'];
      const sheet: any[][] = [];
      sheet.push([T('收入明細總表', stTitle), ...Array(14).fill(T('', {}))]);
      sheet.push([T(`${md.y - 1911}年${md.m}月1日~${md.y - 1911}年${md.m}月${lastDay}日`, stSub), ...Array(14).fill(T('', {}))]);
      sheet.push(header.map((h) => T(h, stHead)));
      const groups = Array.from(new Set(md.rows.map((r) => r.estate_name ?? '無物業'))).sort(eSort);
      for (const e of groups) {
        const grp = md.rows.filter((r) => (r.estate_name ?? '無物業') === e);
        for (const r of grp) {
          const pn = r.property_raw ?? '';
          const rating = ratingByKey[`${pn}|${r.checkout}`] ?? ratingByGuest[`${pn}|${(r.guest_name || '').split(' ')[0]}`] ?? '';
          sheet.push([
            T(r.guest_name ?? '', stCell), T(pn, stCell), T(SOURCE_LABEL[r.source] ?? r.source, stCell),
            T(r.checkin, stCell), T(r.checkout, stCell), T(Math.round(r.total_amount), stCell), T(Math.round(r.month_amount), stCell),
            T(r.month_nights, stCell), T(r.total_nights, stCell),
            T(r.month_nights ? Math.round(Number(r.month_amount) / r.month_nights) : '', stCell),
            T(managerOf[e] ?? '', stCell), T(rating, stCell), T('', stCell), T('', stCell), T('', stCell),
          ]);
        }
        sheet.push([T(`↑${e}`, stSubtotal), ...Array(5).fill(T('', stSubtotal)), T(Math.round(grp.reduce((a, r) => a + Number(r.month_amount), 0)), stSubtotal), ...Array(8).fill(T('', stSubtotal))]);
        sheet.push([]);
      }
      const wsM = XLSX.utils.aoa_to_sheet(sheet);
      wsM['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 14 } }];
      wsM['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 6 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, wsM, md.ym);
    }
    XLSX.writeFile(wb, `營收_${fromM}_${toM}.xlsx`);
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
          <div>
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
          <div>
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
          <button onClick={exportXlsx} disabled={!filtered.length} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
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
