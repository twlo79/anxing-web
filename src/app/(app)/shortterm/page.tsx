'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Order = {
  id: string; order_key: string; source: string; estate_id: string | null; property_id?: string | null; property_raw: string | null;
  guest_name: string | null; checkin: string; checkout: string; nights: number;
  amount: number; deposit: number | null; account: string | null; note: string | null;
  deposit_received?: boolean; deposit_returned?: boolean;
  properties?: { name: string } | null;
};
type Estate = { id: string; name: string; sort: number; active: boolean };

const SRC = ['airbnb', 'agoda', 'private', 'oneoff', 'partner', 'airbnb_cancelled'];
const MANUAL_SRC = ['private', 'oneoff'];  // 可手動新增的來源
const FILTER_SRC = ['airbnb', 'agoda', 'private', 'oneoff'];  // 來源篩選下拉(搭檔已併airbnb、取消已併一次性)
const SRC_LABEL: Record<string, string> = { airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', oneoff: '其他收入(一次性)', partner: '搭檔收款', airbnb_cancelled: 'Airbnb取消' };
const SRC_COLOR: Record<string, string> = {
  airbnb: 'bg-mor-bluelight text-mor-slate', agoda: 'bg-purple-50 text-purple-700',
  private: 'bg-mor-greenlight text-mor-green', oneoff: 'bg-rose-50 text-rose-600', partner: 'bg-teal-50 text-teal-700', airbnb_cancelled: 'bg-red-50 text-red-600',
};
const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString());
const PAGE = 50;

export default function ShortTermPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [src, setSrc] = useState('');
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [edit, setEdit] = useState<Order | null>(null);
  const [estF, setEstF] = useState('');
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [agg, setAgg] = useState<any[]>([]);

  useEffect(() => { supabase.from('estates').select('id, name, sort, active').order('sort').then(({ data }) => setEstates(data ?? [])); }, [supabase]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  useEffect(() => { supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? [])); }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('orders').select('*, properties(name)', { count: 'exact' }).in('source', SRC).order('checkout', { ascending: false });
    if (src) q = q.eq('source', src);
    if (estF) q = q.eq('estate_id', estF);
    if (toD) q = q.lte('checkin', toD);
    if (fromD) q = q.gte('checkout', fromD);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
    const { data, count } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as any) ?? []); setTotal(count ?? 0); setLoading(false);
  }, [supabase, src, kw, estF, fromD, toD, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [src, kw, estF, fromD, toD]);

  const loadAgg = useCallback(async () => {
    let all: any[] = []; let from = 0;
    while (true) {
      let q = supabase.from('orders').select('source, estate_id, amount, deposit, deposit_received, deposit_returned').in('source', SRC);
      if (src) q = q.eq('source', src);
      if (estF) q = q.eq('estate_id', estF);
      if (toD) q = q.lte('checkin', toD);
      if (fromD) q = q.gte('checkout', fromD);
      if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
      const { data } = await q.range(from, from + 999);
      const chunk = (data as any[]) ?? [];
      all = all.concat(chunk);
      if (chunk.length < 1000) break;
      from += 1000;
    }
    setAgg(all);
  }, [supabase, src, kw, estF, fromD, toD]);
  useEffect(() => { loadAgg(); }, [loadAgg]);
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  async function save() {
    if (!edit) return;
    const co = edit.source === 'oneoff' ? (edit.checkout || edit.checkin) : edit.checkout;
    const nights = (edit.checkin && co) ? Math.max(0, Math.round((new Date(co).getTime() - new Date(edit.checkin).getTime()) / 86400000)) : 0;
    const payload = { source: edit.source, estate_id: edit.estate_id, property_id: edit.property_id ?? null, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: edit.checkin || null, checkout: co || null, nights, amount: edit.amount, deposit: edit.deposit, account: edit.account, note: edit.note, deposit_received: edit.deposit_received ?? false, deposit_returned: edit.deposit_returned ?? false };
    const { error } = edit.id
      ? await supabase.from('orders').update(payload).eq('id', edit.id)
      : await supabase.from('orders').insert({ ...payload, order_key: `${edit.source === 'oneoff' ? 'OO' : 'PV'}_${edit.checkin || 'na'}_${edit.property_raw ?? ''}_${edit.guest_name ?? ''}_${Date.now()}`, imported_via: 'manual' });
    if (error) return flash('儲存失敗:' + error.message);
    flash('已儲存'); setEdit(null); load();
  }
  async function del(o: Order) {
    if (!confirm(`刪除訂單「${o.guest_name} ${o.property_raw}」?`)) return;
    const { error } = await supabase.from('orders').delete().eq('id', o.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }
  function blank(): Order { return { id: '', order_key: '', source: 'private', estate_id: null, property_id: null, property_raw: '', guest_name: '', checkin: '', checkout: '', nights: 0, amount: 0, deposit: 0, account: null, note: '', deposit_received: false, deposit_returned: false }; }

  const totRevenue = useMemo(() => agg.reduce((a, o) => a + Number(o.amount || 0), 0), [agg]);
  const heldDeposit = useMemo(() => agg.reduce((a, o) => a + (o.deposit_received && !o.deposit_returned ? Number(o.deposit || 0) : 0), 0), [agg]);
  const bySource = useMemo(() => { const m: Record<string, number> = {}; for (const o of agg) m[o.source] = (m[o.source] || 0) + Number(o.amount || 0); return m; }, [agg]);
  const byEstate = useMemo(() => { const m: Record<string, number> = {}; for (const o of agg) { const k = o.estate_id ? (estateName[o.estate_id] ?? '—') : '—'; m[k] = (m[k] || 0) + Number(o.amount || 0); } return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [agg, estateName]);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">短租訂單與收款 <span className="text-sm font-normal text-gray-400">Airbnb・Agoda・私下・一次性</span></h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4 items-stretch">
        <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center">
          <div className="text-xs opacity-75">當期營收(訂單總額)</div>
          <div className="text-3xl font-bold mt-1">${fmt(totRevenue)}</div>
          <div className="text-sm opacity-90 mt-2">佔收帳款(暫收押金) <span className="font-semibold">${fmt(heldDeposit)}</span></div>
          <div className="text-xs opacity-60 mt-1">{total.toLocaleString()} 筆・押金非營收</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依來源</div>
          <div>
            {SRC.filter((sc) => bySource[sc]).map((sc) => (
              <div key={sc} onClick={() => setSrc(src === sc ? '' : sc)} className={`px-4 py-2 flex items-center justify-between text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${src === sc ? 'bg-mor-bluelight/60' : ''}`}>
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SRC_COLOR[sc]}`}>{SRC_LABEL[sc]}</span>
                <span className="font-semibold">${fmt(bySource[sc])}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依物業</div>
          <div className="max-h-44 overflow-y-auto">
            {byEstate.map(([e, v]) => { const id = estates.find((x) => x.name === e)?.id || ''; return (
              <div key={e} onClick={() => setEstF(estF === id ? '' : id)} className={`px-4 py-1.5 flex items-center justify-between text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${estF && estF === id ? 'bg-mor-bluelight/60' : ''}`}>
                <span className="truncate">{e}</span><span className="font-semibold whitespace-nowrap">${fmt(v as number)}</span>
              </div>); })}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={src} onChange={(e) => setSrc(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{FILTER_SRC.map((s) => <option key={s} value={s}>{SRC_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estF} onChange={(e) => setEstF(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}{es.active ? '' : '(停用)'}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">訂單日期(期間內有交集)</label>
          <div className="flex items-center gap-1">
            <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
            <span className="text-gray-400">~</span>
            <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(客戶/房源)</label>
          <div className="flex gap-1">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }} placeholder="搜尋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-36" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(src || kw || estF || fromD || toD) && <button onClick={() => { setSrc(''); setKw(''); setKwIn(''); setEstF(''); setFromD(''); setToD(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {total.toLocaleString()} 筆</div>
          <button onClick={() => setEdit(blank())} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增訂單</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5">來源</th><th className="px-3 py-2.5">物業</th><th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">客戶</th><th className="px-3 py-2.5 whitespace-nowrap">訂單起訖</th><th className="px-3 py-2.5 text-right">金額</th>
              <th className="px-3 py-2.5 text-right">押金</th><th className="px-3 py-2.5">帳戶</th><th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">無訂單</td></tr>
            : rows.map((o) => (
              <tr key={o.id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30">
                <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SRC_COLOR[o.source]}`}>{SRC_LABEL[o.source] ?? o.source}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{o.estate_id ? estateName[o.estate_id] ?? '—' : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.property_raw ?? o.properties?.name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.guest_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{o.checkin}~{o.checkout}</td>
                <td className="px-3 py-2 text-right font-medium">${fmt(o.amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{o.deposit ? '$' + fmt(o.deposit) : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{o.account ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => setEdit(o)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                  <button onClick={() => del(o)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
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

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">{edit.id ? '編輯訂單' : '新增訂單(私下/一次性)'}<button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button></div>
            <div className="px-6 py-4 grid grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">來源<select value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5">{Array.from(new Set([...(edit.id ? [edit.source] : []), ...MANUAL_SRC])).map((s) => <option key={s} value={s}>{SRC_LABEL[s] ?? s}</option>)}</select></label>
              <label className="flex flex-col gap-1">物業<select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null, property_raw: null, property_id: null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}{es.active ? '' : '(停用)'}</option>)}</select></label>
              <label className="flex flex-col gap-1">房源<select value={edit.property_raw ?? ''} onChange={(e) => { const nm = e.target.value; const pr = properties.find((x) => x.estate_id === edit.estate_id && x.name === nm); setEdit({ ...edit, property_raw: nm || null, property_id: pr?.id ?? null }); }} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{properties.filter((x) => x.estate_id === edit.estate_id).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>
              <label className="flex flex-col gap-1">客戶<input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '日期(認列月份)' : '起日'}<input type="date" value={edit.checkin} onChange={(e) => setEdit({ ...edit, checkin: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">迄日<input type="date" value={edit.checkout} onChange={(e) => setEdit({ ...edit, checkout: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '金額' : '訂單總額'}<input type="number" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: parseFloat(e.target.value) || 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">押金<input type="number" value={edit.deposit ?? ''} onChange={(e) => setEdit({ ...edit, deposit: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
              {edit.source !== 'oneoff' && (
                <div className="col-span-2 flex flex-wrap items-center gap-5 text-sm bg-mor-sand/30 rounded-lg px-3 py-2">
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={!!edit.deposit_received} onChange={(e) => setEdit({ ...edit, deposit_received: e.target.checked })} />已收押金</label>
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={!!edit.deposit_returned} onChange={(e) => setEdit({ ...edit, deposit_returned: e.target.checked })} />退回押金</label>
                  <span className="text-xs text-gray-400">押金為暫收(佔收帳款),非營收;退回後從佔收帳款扣除</span>
                </div>
              )}
              <label className="flex flex-col gap-1">入款帳號<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option><option value="8088">8088</option><option value="0564">0564</option><option value="4145">4145</option></select></label>
              <label className="flex flex-col gap-1 col-span-2">備註<input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">儲存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
