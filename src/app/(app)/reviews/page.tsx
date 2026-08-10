'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';

type Estate = { id: string; name: string; manager: string | null; sort: number };
type Property = { id: string; name: string; active: boolean; estate_id: string | null };
type Review = {
  id: string; airbnb_review_id: string; property_id: string | null;
  listing_name_raw: string | null; guest_name: string;
  checkin_date: string | null; checkout_date: string | null; nights: number | null;
  overall_rating: number; comment: string | null; comment_original: string | null;
  comment_language: string | null;
  rating_checkin: number | null; rating_cleanliness: number | null; rating_accuracy: number | null;
  rating_communication: number | null; rating_location: number | null; rating_value: number | null;
  detail_comments: any; host_reply: string | null; source_url: string | null;
};
type Stat = { estate_id: string; estate_name: string; manager: string | null; sort: number; review_count: number; avg_rating: number };
type MgrStat = { manager: string; avg_rating: number; s5: number; s4: number; s3: number; s2: number; s1: number; total: number };

const PAGE_SIZE = 50;
const CAT_LABEL: Record<string, string> = {
  CHECKIN: '入住', CLEANLINESS: '清潔', ACCURACY: '準確',
  COMMUNICATION: '溝通', LOCATION: '位置', VALUE: '性價比',
};

// 星等配色:5=金黃(標準) 4=藍(不佳) 3=橘(差) 2=紅 1=深紅(非常差)
// 星等配色:5=黃 4=橘 3=紅 2=紫 1=黑
const MGR_ORDER = ['芊', '月', '花', '唐'];
function mgrOrder(name: string) {
  if (name === '未指派') return 99;
  const i = MGR_ORDER.indexOf(name);
  return i === -1 ? 50 : i;
}

function starColor(n: number) {
  const r = Math.round(n);
  return r >= 5 ? 'text-amber-400' : r === 4 ? 'text-orange-500' : r === 3 ? 'text-red-500' : r === 2 ? 'text-purple-600' : 'text-gray-900';
}
function Stars({ n }: { n: number }) {
  return <span className={`font-semibold ${starColor(n)}`}>{'★'.repeat(Math.round(n))}<span className="text-gray-300">{'★'.repeat(Math.max(0, 5 - Math.round(n)))}</span></span>;
}

function hasNegative(r: Review) {
  if (r.overall_rating <= 3) return true;
  const tags = r.detail_comments?.tags;
  if (!tags) return false;
  return Object.values(tags).some((arr: any) => (arr as any[]).some((t) => t.intent === 'NEGATIVE'));
}

// 留言顯示:有中文的欄位優先(不信任 comment_language,因為多筆標記錯誤)
function displayComment(r: Review) {
  const hasCJK = (s?: string | null) => !!s && /[\u4e00-\u9fff]/.test(s);
  if (hasCJK(r.comment)) return r.comment;
  if (hasCJK(r.comment_original)) return r.comment_original;
  return r.comment ?? r.comment_original ?? null;
}

function csvEsc(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r\n/g, '\n');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function ReviewsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [rows, setRows] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Review | null>(null);
  const [exporting, setExporting] = useState(false);
  // 表格篩選
  const [estateId, setEstateId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');
  // Dashboard 獨立篩選
  const [statsFrom, setStatsFrom] = useState('');
  const [statsTo, setStatsTo] = useState('');
  const [stats, setStats] = useState<Stat[]>([]);
  const [mgrStats, setMgrStats] = useState<MgrStat[]>([]);
  const [mgrOpen, setMgrOpen] = useState<MgrStat | null>(null);
  const [listModal, setListModal] = useState<{ title: string; propIds: string[] | null; rating: number | null } | null>(null);

  const propById = useMemo(() => Object.fromEntries(properties.map((p) => [p.id, p])), [properties]);
  const estateById = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e])), [estates]);
  const visibleProps = useMemo(
    () => (estateId ? properties.filter((p) => p.estate_id === estateId) : properties),
    [properties, estateId]
  );

  useEffect(() => {
    supabase.from('estates').select('id, name, manager, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('properties').select('id, name, active, estate_id').order('active', { ascending: false }).order('name')
      .then(({ data }) => setProperties(data ?? []));
  }, [supabase]);

  // Dashboard 統計
  useEffect(() => {
    supabase.rpc('review_stats', { p_from: statsFrom || null, p_to: statsTo || null })
      .then(({ data }) => setStats((data as Stat[]) ?? []));
    supabase.rpc('manager_stats', { p_from: statsFrom || null, p_to: statsTo || null })
      .then(({ data }) => setMgrStats((data as MgrStat[]) ?? []));
  }, [supabase, statsFrom, statsTo]);

  const overall = useMemo(() => {
    const cnt = stats.reduce((s, x) => s + Number(x.review_count), 0);
    if (!cnt) return { avg: 0, cnt: 0 };
    const sum = stats.reduce((s, x) => s + Number(x.avg_rating) * Number(x.review_count), 0);
    return { avg: sum / cnt, cnt };
  }, [stats]);

  const overallDist = useMemo(() => {
    const t = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const m of mgrStats) { t.s5 += +m.s5; t.s4 += +m.s4; t.s3 += +m.s3; t.s2 += +m.s2; t.s1 += +m.s1; }
    const total = t.s5 + t.s4 + t.s3 + t.s2 + t.s1;
    return { total, rows: [['5 星', t.s5], ['4 星', t.s4], ['3 星', t.s3], ['2 星', t.s2], ['1 星', t.s1]] as [string, number][] };
  }, [mgrStats]);

  const buildQuery = useCallback((withCount: boolean) => {
    let q = supabase.from('reviews')
      .select('*', withCount ? { count: 'exact' } : undefined)
      .order('checkout_date', { ascending: false, nullsFirst: false });
    if (propertyId) q = q.eq('property_id', propertyId);
    else if (estateId) {
      const ids = properties.filter((p) => p.estate_id === estateId).map((p) => p.id);
      q = q.in('property_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    }
    if (dateFrom) q = q.gte('checkout_date', dateFrom);
    if (dateTo) q = q.lte('checkout_date', dateTo);
    if (ratingFilter === '5') q = q.gte('overall_rating', 5);
    if (ratingFilter === '4') q = q.gte('overall_rating', 4).lt('overall_rating', 5);
    if (ratingFilter === 'low') q = q.lte('overall_rating', 3);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,comment.ilike.%${kw}%,comment_original.ilike.%${kw}%,listing_name_raw.ilike.%${kw}%`);
    return q;
  }, [supabase, estateId, propertyId, dateFrom, dateTo, ratingFilter, kw, properties]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, count } = await buildQuery(true).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    setRows((data as any) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [buildQuery, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [estateId, propertyId, dateFrom, dateTo, ratingFilter, kw]);
  useEffect(() => { setPropertyId(''); }, [estateId]);

  // CSV 匯出(目前篩選的全部資料)
  async function exportCsv() {
    setExporting(true);
    const all: Review[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      const { data } = await buildQuery(false).range(from, from + 999);
      const batch = (data as any as Review[]) ?? [];
      all.push(...batch);
      if (batch.length < 1000) break;
    }
    const header = ['入住日','退房日','物業','房源','旅客','負責人','總評','留言','原文','語言','入住','清潔','準確','溝通','位置','性價比','私下回饋','房東回覆','review_id'];
    const lines = [header.join(',')];
    for (const r of all) {
      const p = r.property_id ? propById[r.property_id] : null;
      const e = p?.estate_id ? estateById[p.estate_id] : null;
      lines.push([
        r.checkin_date, r.checkout_date, e?.name ?? '', p?.name ?? '', r.guest_name, e?.manager ?? '',
        r.overall_rating, displayComment(r), r.comment_original, r.comment_language,
        r.rating_checkin, r.rating_cleanliness, r.rating_accuracy, r.rating_communication, r.rating_location, r.rating_value,
        r.detail_comments?.private_feedback ?? '', r.host_reply ?? '', r.airbnb_review_id,
      ].map(csvEsc).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `評價匯出_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setExporting(false);
  }

  function exportMgrCsv() {
    const pct = (n: number, t: number) => (t ? Math.round((n / t) * 100) : 0);
    const lines = ['管家,5星,4星,3星,2星,1星'];
    for (const m of mgrStats) {
      const t = Number(m.total);
      lines.push([
        m.manager,
        `${m.s5} (${pct(Number(m.s5), t)}%)`,
        `${m.s4} (${pct(Number(m.s4), t)}%)`,
        `${m.s3} (${pct(Number(m.s3), t)}%)`,
        `${m.s2} (${pct(Number(m.s2), t)}%)`,
        `${m.s1} (${pct(Number(m.s1), t)}%)`,
      ].map(csvEsc).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `管家評分_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function drillTo(estate: string) {
    setEstateId(estate);
    setPropertyId('');
    if (statsFrom) setDateFrom(statsFrom);
    if (statsTo) setDateTo(statsTo);
    setTimeout(() => document.getElementById('review-filters')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {/* ===== Dashboard ===== */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h1>評價</h1>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-gray-500">統計區間(退房日)</span>
            <input type="date" value={statsFrom} onChange={(e) => setStatsFrom(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1" />
            <span className="text-gray-400">~</span>
            <input type="date" value={statsTo} onChange={(e) => setStatsTo(e.target.value)}
              className="rounded-lg border border-gray-300 px-2 py-1" />
            {(statsFrom || statsTo) && (
              <button onClick={() => { setStatsFrom(''); setStatsTo(''); }} className="text-gray-400 underline">清除</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
          {/* 總覽 + 星等分布 */}
          <div onClick={() => drillTo('')} title="點擊查看全部評價" className="rounded-xl bg-mor-slate text-white p-5 flex flex-col cursor-pointer hover:bg-mor-slatedark transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-xs opacity-75">所有平均評價</span>
              <span className="text-xs opacity-75">{overall.cnt.toLocaleString()} 筆</span>
            </div>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="text-4xl font-bold tracking-tight">{overall.cnt ? overall.avg.toFixed(2) : '—'}</span>
              <span className="text-amber-300 text-xl">★</span>
            </div>
            <div className="mt-4 space-y-1.5">
              {overallDist.rows.map(([label, n]) => (
                <div key={label} onClick={(e) => { e.stopPropagation(); setListModal({ title: `${label}評價`, propIds: null, rating: parseInt(label) }); }}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:opacity-80" title={`點擊查看${label}評價`}>
                  <span className="w-8 opacity-75">{label}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/15 overflow-hidden">
                    <div className={`h-full ${label === '5 星' ? 'bg-amber-400' : label === '4 星' ? 'bg-orange-500' : label === '3 星' ? 'bg-red-500' : label === '2 星' ? 'bg-purple-500' : 'bg-gray-900'}`}
                      style={{ width: overallDist.total ? `${Math.max((n / overallDist.total) * 100, n ? 1.5 : 0)}%` : '0%' }} />
                  </div>
                  <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right opacity-75">{n.toLocaleString()} ({overallDist.total ? Math.round((n / overallDist.total) * 100) : 0}%)</span>
                </div>
              ))}
            </div>
          </div>

          {/* 物業評分 */}
          <div className="rounded-xl bg-white border border-mor-line flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">物業評分</div>
            <div className="flex-1">
              {[...stats].filter((x) => Number(x.review_count) > 0).sort((a, b) => Number(a.sort) - Number(b.sort)).map((x, _, arr) => {
                const max = Math.max(...arr.map((y) => Number(y.review_count))) || 1;
                return (
                  <div key={x.estate_id} onClick={() => setListModal({ title: `物業「${x.estate_name}」的評價`, propIds: properties.filter((pp) => pp.estate_id === x.estate_id).map((pp) => pp.id), rating: null })} title="點擊查看該物業評價"
                    className="px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/50">
                    <span className="w-14 truncate font-medium">{x.estate_name}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden">
                      <div className="h-full bg-mor-blue" style={{ width: `${(Number(x.review_count) / max) * 100}%` }} />
                    </div>
                    <span className={`min-w-[4rem] shrink-0 whitespace-nowrap text-right font-semibold ${Number(x.avg_rating) < 4.5 ? 'text-orange-600' : 'text-mor-ink'}`}>
                      {Number(x.avg_rating).toFixed(2)} ★
                    </span>
                    <span className="w-14 shrink-0 whitespace-nowrap text-right text-xs text-gray-400">{Number(x.review_count).toLocaleString()} 筆</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 管家評分 */}
          <div className="rounded-xl bg-white border border-mor-line flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-mor-line bg-mor-sand/40">
              <span className="text-sm font-semibold">管家評分</span>
              <button onClick={exportMgrCsv}
                className="rounded-lg border border-mor-line bg-white px-2.5 py-0.5 text-xs text-mor-slate hover:bg-mor-bluelight">
                ⬇ CSV
              </button>
            </div>
            <div className="flex-1">
              {[...mgrStats].sort((a, b) => mgrOrder(a.manager) - mgrOrder(b.manager)).map((m, _, arr) => {
                const max = Math.max(...arr.map((y) => Number(y.total))) || 1;
                return (
                  <button key={m.manager} onClick={() => setMgrOpen(m)}
                    className="w-full px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 hover:bg-mor-bluelight/40 text-left">
                    <span className="w-14 truncate font-medium">{m.manager}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden">
                      <div className="h-full bg-mor-green" style={{ width: `${(Number(m.total) / max) * 100}%` }} />
                    </div>
                    <span className={`min-w-[4rem] shrink-0 whitespace-nowrap text-right font-semibold ${Number(m.avg_rating) < 4.5 ? 'text-orange-600' : 'text-mor-ink'}`}>
                      {Number(m.avg_rating).toFixed(2)} ★
                    </span>
                    <span className="min-w-[4rem] shrink-0 whitespace-nowrap text-right text-xs text-gray-400">{Number(m.total).toLocaleString()} 筆 ›</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 表格篩選 ===== */}
      <div id="review-filters" className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estateId} onChange={(e) => setEstateId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-28">
            <option value="">全部物業</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">房源</label>
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-36">
            <option value="">全部房源</option>
            {visibleProps.map((p) => (
              <option key={p.id} value={p.id}>{p.active ? '' : '〔停用〕'}{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">評分</label>
          <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>
            <option value="5">5 星</option>
            <option value="4">4 星</option>
            <option value="low">3 星以下(需關注)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">退房日期(起)</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">退房日期(迄)</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(旅客/留言/房源)</label>
          <div className="flex gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="含舊物業" className="rounded-lg border border-gray-300 px-2 py-1.5 w-32" />
            <button onClick={() => setKw(kwInput.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(estateId || propertyId || dateFrom || dateTo || ratingFilter) && (
          <button onClick={() => { setEstateId(''); setPropertyId(''); setDateFrom(''); setDateTo(''); setRatingFilter(''); }}
            className="text-gray-500 underline pb-1.5">清除篩選</button>
        )}
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {total.toLocaleString()} 筆</div>
          <button onClick={exportCsv} disabled={exporting || total === 0}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">
            {exporting ? '匯出中…' : '⬇ 下載 CSV'}
          </button>
        </div>
      </div>

      {/* ===== 表格 ===== */}
      <div className="rounded-xl glass overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5 whitespace-nowrap">入住日</th>
              <th className="px-3 py-2.5 whitespace-nowrap">退房日</th>
              <th className="px-3 py-2.5">物業</th>
              <th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">旅客</th>
              <th className="px-3 py-2.5">負責人</th>
              <th className="px-3 py-2.5 whitespace-nowrap">總評</th>
              <th className="px-3 py-2.5">留言</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">沒有符合條件的評價</td></tr>
            ) : rows.map((r) => {
              const p = r.property_id ? propById[r.property_id] : null;
              const e = p?.estate_id ? estateById[p.estate_id] : null;
              return (
                <tr key={r.id} onClick={() => setSelected(r)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer align-top">
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{r.checkin_date ?? '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{r.checkout_date ?? '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="inline-block rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs font-medium">{e?.name ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="inline-block rounded-md bg-mor-sand px-2 py-0.5 text-xs font-medium">{p?.name ?? '未對應'}</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{r.guest_name}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{e?.manager ?? '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {hasNegative(r) && <span className="mr-1 inline-block w-2 h-2 rounded-full bg-red-500" title="需關注" />}
                    <Stars n={r.overall_rating} />
                    <span className={`ml-1 text-xs font-medium ${r.overall_rating >= 5 ? 'text-mor-ink' : starColor(r.overall_rating)}`}>{r.overall_rating} 星</span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600 min-w-64">
                    <div className="line-clamp-2">{displayComment(r) ?? <span className="text-gray-300">（無留言）</span>}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-500">
          <div>第 {page + 1} / {pages} 頁</div>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}
              className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">上一頁</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}
              className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">下一頁</button>
          </div>
        </div>
      </div>

      {listModal && (
        <ListModal cfg={listModal} onClose={() => setListModal(null)}
          statsFrom={statsFrom} statsTo={statsTo}
          propById={propById} estateById={estateById}
          onSelectReview={(r) => setSelected(r)} />
      )}
      {mgrOpen && (
        <MgrModal m={mgrOpen} onClose={() => setMgrOpen(null)}
          estates={estates} properties={properties}
          statsFrom={statsFrom} statsTo={statsTo}
          propById={propById} estateById={estateById}
          onSelectReview={(r) => setSelected(r)} />
      )}
      {selected && (
        <Drawer review={selected} onClose={() => setSelected(null)}
          property={selected.property_id ? propById[selected.property_id] : null}
          estate={selected.property_id && propById[selected.property_id]?.estate_id ? estateById[propById[selected.property_id].estate_id!] : null} />
      )}
    </div>
  );
}

function Drawer({ review: r, onClose, property, estate }: {
  review: Review; onClose: () => void; property: Property | null; estate: Estate | null;
}) {
  const cats: [string, number | null][] = [
    ['CHECKIN', r.rating_checkin], ['CLEANLINESS', r.rating_cleanliness], ['ACCURACY', r.rating_accuracy],
    ['COMMUNICATION', r.rating_communication], ['LOCATION', r.rating_location], ['VALUE', r.rating_value],
  ];
  const tags = r.detail_comments?.tags ?? {};
  const privateFb = r.detail_comments?.private_feedback;
  const shown = displayComment(r);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="font-bold">{r.guest_name} 的評價</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {estate?.name ?? '—'}・{property?.name ?? '未對應'}・{r.checkin_date} ~ {r.checkout_date}
              {r.nights ? `・${r.nights} 晚` : ''}
              {estate?.manager ? `・負責人 ${estate.manager}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-6 text-sm">
          <div><Stars n={r.overall_rating} /> <span className="ml-1 font-semibold">{r.overall_rating}</span></div>
          <div>
            <div className="text-xs text-gray-500 mb-1.5 font-medium">留言</div>
            <p className="whitespace-pre-wrap leading-relaxed">{shown ?? '（無）'}</p>
            {r.comment_original && r.comment_original !== shown && (
              <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
                <div className="text-xs text-gray-400 mb-1">原文({r.comment_language})</div>
                <p className="whitespace-pre-wrap text-gray-600">{r.comment_original}</p>
              </div>
            )}
            {r.comment && r.comment !== shown && (
              <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 p-3">
                <div className="text-xs text-gray-400 mb-1">翻譯</div>
                <p className="whitespace-pre-wrap text-gray-600">{r.comment}</p>
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-2 font-medium">細節評分</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {cats.map(([cat, v]) => (
                <div key={cat} className="flex items-center justify-between">
                  <span className="text-gray-600">{CAT_LABEL[cat]}</span>
                  <span className={`font-semibold ${v && v <= 3 ? 'text-red-600' : ''}`}>{v ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
          {Object.keys(tags).length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-2 font-medium">分項回饋</div>
              <div className="space-y-2">
                {Object.entries(tags).map(([cat, arr]) => (
                  <div key={cat}>
                    <span className="text-xs text-gray-400 mr-2">{CAT_LABEL[cat] ?? cat}</span>
                    {(arr as any[]).map((t, i) => (
                      <span key={i} className={`inline-block rounded-full px-2.5 py-0.5 text-xs mr-1 mb-1 ${
                        t.intent === 'NEGATIVE' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      }`}>
                        {t.label}{t.comment ? `:${t.comment}` : ''}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {privateFb && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
              <div className="text-xs text-amber-700 mb-1 font-medium">私下回饋(僅房東可見)</div>
              <p className="whitespace-pre-wrap text-amber-900">{privateFb}</p>
            </div>
          )}
          {r.host_reply && (
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
              <div className="text-xs text-gray-500 mb-1 font-medium">房東回覆</div>
              <p className="whitespace-pre-wrap text-gray-700">{r.host_reply}</p>
            </div>
          )}
          {r.source_url && (
            <a href={r.source_url} target="_blank" rel="noreferrer" className="inline-block text-xs text-gray-400 underline">
              在 Airbnb 後台查看
            </a>
          )}
        </div>
      </div>
    </div>
  );
}


function MgrModal({ m, onClose, estates, properties, statsFrom, statsTo, propById, estateById, onSelectReview }: {
  m: MgrStat; onClose: () => void;
  estates: Estate[]; properties: Property[];
  statsFrom: string; statsTo: string;
  propById: Record<string, Property>; estateById: Record<string, Estate>;
  onSelectReview: (r: Review) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [list, setList] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const estateIds = estates
      .filter((e) => (m.manager === '未指派' ? !e.manager : e.manager === m.manager))
      .map((e) => e.id);
    const propIds = properties.filter((p) => p.estate_id && estateIds.includes(p.estate_id)).map((p) => p.id);
    /*
     * ⚠️ 這是**統計**用的查詢，撈不全會直接讓平均星等算錯。
     *
     * 原本寫死 .limit(500) 且是按退房日新到舊排序 —— 區間一拉大就只算到
     * 最近 500 則，平均分被最近的評價主導，而且**數字看起來完全正常**。
     * 統計的查詢尤其不能截斷：少幾列不會少一個項目，只會讓每一個數字都偏。
     */
    fetchAll<any>((f, t) => {
      let q = supabase.from('reviews').select('*')
        .in('property_id', propIds.length ? propIds : ['00000000-0000-0000-0000-000000000000'])
        .order('checkout_date', { ascending: false, nullsFirst: false });
      if (statsFrom) q = q.gte('checkout_date', statsFrom);
      if (statsTo) q = q.lte('checkout_date', statsTo);
      return q.range(f, t);
    }).then(({ rows }) => { setList(rows); setLoading(false); });
  }, [supabase, m, estates, properties, statsFrom, statsTo]);

  const total = Number(m.total);
  const dist: [string, number, string][] = [
    ['5 星', Number(m.s5), 'bg-amber-400'],
    ['4 星', Number(m.s4), 'bg-orange-500'],
    ['3 星', Number(m.s3), 'bg-red-500'],
    ['2 星', Number(m.s2), 'bg-purple-500'],
    ['1 星', Number(m.s1), 'bg-gray-900'],
  ];

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-mor-line flex items-center justify-between">
          <div>
            <div className="font-bold">管家「{m.manager}」的評價</div>
            <div className="text-xs text-gray-500 mt-0.5">
              平均 {Number(m.avg_rating).toFixed(2)} ★・{total.toLocaleString()} 筆
              {(statsFrom || statsTo) && `・${statsFrom || '…'} ~ ${statsTo || '…'}`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-4 border-b border-mor-line space-y-1.5">
          {dist.map(([label, n, color]) => (
            <div key={label} className="flex items-center gap-3 text-xs">
              <span className="w-8 text-gray-500">{label}</span>
              <div className="flex-1 h-3 rounded-full bg-mor-sand overflow-hidden">
                <div className={`h-full ${color}`} style={{ width: total ? `${(n / total) * 100}%` : '0%' }} />
              </div>
              <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right text-gray-600">{n} ({total ? Math.round((n / total) * 100) : 0}%)</span>
            </div>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center text-gray-400 text-sm">載入中…</div>
          ) : list.map((r) => {
            const p = r.property_id ? propById[r.property_id] : null;
            const e = p?.estate_id ? estateById[p.estate_id] : null;
            return (
              <button key={r.id} onClick={() => onSelectReview(r)}
                className="w-full text-left px-6 py-3 border-b border-mor-line/60 hover:bg-mor-bluelight/40">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.guest_name}</span>
                    <span className="text-xs text-gray-400">{e?.name}・{p?.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stars n={r.overall_rating} />
                    <span className="text-xs text-gray-400">{r.checkout_date}</span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1 line-clamp-1">{displayComment(r)}</div>
              </button>
            );
          })}
          {!loading && list.length >= 500 && (
            <div className="py-3 text-center text-xs text-gray-400">僅顯示最近 500 筆,可縮小統計區間查看更早的評價</div>
          )}
        </div>
      </div>
    </div>
  );
}


function ListModal({ cfg, onClose, statsFrom, statsTo, propById, estateById, onSelectReview }: {
  cfg: { title: string; propIds: string[] | null; rating: number | null };
  onClose: () => void; statsFrom: string; statsTo: string;
  propById: Record<string, Property>; estateById: Record<string, Estate>;
  onSelectReview: (r: Review) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [list, setList] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 這一份也拿掉寫死的 1000 —— 同一頁兩個地方各有自己的上限，
    // 一邊改了另一邊沒改，兩個清單就會對不起來而且沒人說得出為什麼。
    fetchAll<any>((f, t) => {
      let q = supabase.from('reviews').select('*')
        .order('checkout_date', { ascending: false, nullsFirst: false });
      if (cfg.propIds) q = q.in('property_id', cfg.propIds.length ? cfg.propIds : ['00000000-0000-0000-0000-000000000000']);
      if (cfg.rating === 5) q = q.gte('overall_rating', 5);
      else if (cfg.rating != null) q = q.gte('overall_rating', cfg.rating).lt('overall_rating', cfg.rating + 1);
      if (statsFrom) q = q.gte('checkout_date', statsFrom);
      if (statsTo) q = q.lte('checkout_date', statsTo);
      return q.range(f, t);
    }).then(({ rows }) => { setList(rows); setLoading(false); });
  }, [supabase, cfg, statsFrom, statsTo]);

  const dist = useMemo(() => {
    const t = [0, 0, 0, 0, 0]; // index 0=5星 … 4=1星
    for (const r of list) {
      const v = r.overall_rating >= 5 ? 0 : r.overall_rating >= 4 ? 1 : r.overall_rating >= 3 ? 2 : r.overall_rating >= 2 ? 3 : 4;
      t[v]++;
    }
    return t;
  }, [list]);
  const total = list.length;
  const avg = total ? list.reduce((a, r) => a + Number(r.overall_rating), 0) / total : 0;
  const BAR = ['bg-amber-400', 'bg-orange-500', 'bg-red-500', 'bg-purple-500', 'bg-gray-900'];
  const LABEL = ['5 星', '4 星', '3 星', '2 星', '1 星'];

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-mor-line flex items-center justify-between">
          <div>
            <div className="font-bold">{cfg.title}</div>
            <div className="text-xs text-gray-500 mt-0.5">
              平均 {avg.toFixed(2)} ★・{total.toLocaleString()} 筆
              {(statsFrom || statsTo) && `・${statsFrom || '…'} ~ ${statsTo || '…'}`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        {cfg.rating == null && (
          <div className="px-6 py-4 border-b border-mor-line space-y-1.5">
            {LABEL.map((label, i) => (
              <div key={label} className="flex items-center gap-3 text-xs">
                <span className="w-8 text-gray-500">{label}</span>
                <div className="flex-1 h-3 rounded-full bg-mor-sand overflow-hidden">
                  <div className={`h-full ${BAR[i]}`} style={{ width: total ? `${(dist[i] / total) * 100}%` : '0%' }} />
                </div>
                <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right text-gray-600">{dist[i]} ({total ? Math.round((dist[i] / total) * 100) : 0}%)</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center text-gray-400 text-sm">載入中…</div>
          ) : list.map((r) => {
            const p = r.property_id ? propById[r.property_id] : null;
            const e = p?.estate_id ? estateById[p.estate_id] : null;
            return (
              <button key={r.id} onClick={() => onSelectReview(r)}
                className="w-full text-left px-6 py-3 border-b border-mor-line/60 hover:bg-mor-bluelight/40">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.guest_name}</span>
                    <span className="text-xs text-gray-400">{e?.name}・{p?.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stars n={r.overall_rating} />
                    <span className="text-xs text-gray-400">{r.checkout_date}</span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1 line-clamp-1">{displayComment(r)}</div>
              </button>
            );
          })}
          {!loading && list.length >= 1000 && (
            <div className="py-3 text-center text-xs text-gray-400">僅顯示最近 1,000 筆,可用統計區間縮小範圍</div>
          )}
        </div>
      </div>
    </div>
  );
}
