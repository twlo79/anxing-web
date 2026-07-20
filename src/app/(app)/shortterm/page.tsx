'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Order = {
  id: string; order_key: string; source: string; estate_id: string | null; property_raw: string | null;
  guest_name: string | null; checkin: string; checkout: string; nights: number;
  amount: number; deposit: number | null; account: string | null; note: string | null;
  properties?: { name: string } | null;
};
type Estate = { id: string; name: string; sort: number };

const SRC = ['airbnb', 'agoda', 'private', 'oneoff', 'partner', 'airbnb_cancelled'];
const MANUAL_SRC = ['private', 'oneoff'];  // 可手動新增的來源
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

  useEffect(() => { supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? [])); }, [supabase]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('orders').select('*, properties(name)', { count: 'exact' }).in('source', SRC).order('checkout', { ascending: false });
    if (src) q = q.eq('source', src);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
    const { data, count } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as any) ?? []); setTotal(count ?? 0); setLoading(false);
  }, [supabase, src, kw, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [src, kw]);
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  async function save() {
    if (!edit) return;
    const co = edit.source === 'oneoff' ? (edit.checkout || edit.checkin) : edit.checkout;
    const nights = (edit.checkin && co) ? Math.max(0, Math.round((new Date(co).getTime() - new Date(edit.checkin).getTime()) / 86400000)) : 0;
    const payload = { source: edit.source, estate_id: edit.estate_id, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: edit.checkin || null, checkout: co || null, nights, amount: edit.amount, deposit: edit.deposit, account: edit.account, note: edit.note };
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
  function blank(): Order { return { id: '', order_key: '', source: 'private', estate_id: null, property_raw: '', guest_name: '', checkin: '', checkout: '', nights: 0, amount: 0, deposit: 0, account: null, note: '' }; }

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">短租訂單與收款</h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      <div className="bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={src} onChange={(e) => setSrc(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{SRC.map((s) => <option key={s} value={s}>{SRC_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(客戶/房源)</label>
          <div className="flex gap-1">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }} placeholder="搜尋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-36" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(src || kw) && <button onClick={() => { setSrc(''); setKw(''); setKwIn(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
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
              <th className="px-3 py-2.5">客戶</th><th className="px-3 py-2.5 whitespace-nowrap">起~迄</th><th className="px-3 py-2.5 text-right">金額</th>
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
                <td className="px-3 py-2 whitespace-nowrap">{o.properties?.name ?? o.property_raw ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.guest_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{o.checkin}~{o.checkout}</td>
                <td className="px-3 py-2 text-right font-medium">${fmt(o.amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{o.deposit ? '$' + fmt(o.deposit) : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{o.account ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => setEdit(o)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                  {(o.source === 'private' || o.source === 'oneoff') && <button onClick={() => del(o)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>}
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
              <label className="flex flex-col gap-1">來源<select value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5">{MANUAL_SRC.map((s) => <option key={s} value={s}>{SRC_LABEL[s]}</option>)}</select></label>
              <label className="flex flex-col gap-1">物業<select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}</select></label>
              <label className="flex flex-col gap-1">房源<input value={edit.property_raw ?? ''} onChange={(e) => setEdit({ ...edit, property_raw: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">客戶<input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '日期(認列月份)' : '起日'}<input type="date" value={edit.checkin} onChange={(e) => setEdit({ ...edit, checkin: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">迄日<input type="date" value={edit.checkout} onChange={(e) => setEdit({ ...edit, checkout: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '金額' : '訂單總額'}<input type="number" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: parseFloat(e.target.value) || 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">押金<input type="number" value={edit.deposit ?? ''} onChange={(e) => setEdit({ ...edit, deposit: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
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
