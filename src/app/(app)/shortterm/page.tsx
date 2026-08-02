'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, type SortState } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';

type Order = {
  id: string; order_key: string; source: string; estate_id: string | null; property_id?: string | null; property_raw: string | null;
  guest_name: string | null; checkin: string; checkout: string; nights: number;
  amount: number; deposit: number | null; account: string | null; note: string | null;
  deposit_received?: boolean; deposit_returned?: boolean; deposit_received_at?: string | null; deposit_returned_at?: string | null;
  fx_revenue?: { cur: string; amt: number; rate: number }[];
  fx_deposit?: { cur: string; amt: number }[];
  move_group?: string | null;
  properties?: { name: string } | null;
};
type Estate = { id: string; name: string; sort: number; active: boolean };
type Fee = { id?: string; date: string; type: string; amount: number; note: string };
type Stay = { room: string; estateId: string | null; propertyId: string | null; from: string };
type MoveState = { grp: string; checkin: string; checkout: string; totalNights: number; totalAmount: number; guest: string | null; source: string; account: string | null; stays: Stay[] };

const SRC = ['airbnb', 'agoda', 'private', 'oneoff', 'partner', 'airbnb_cancelled'];
const MANUAL_SRC = ['private', 'oneoff'];  // 可手動新增的來源
const FILTER_SRC = ['airbnb', 'agoda', 'private', 'oneoff'];  // 來源篩選下拉
const SRC_LABEL: Record<string, string> = { airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', oneoff: '其他收入(一次性)', partner: '搭檔收款', airbnb_cancelled: 'Airbnb取消' };
const SRC_COLOR: Record<string, string> = {
  airbnb: 'bg-mor-bluelight text-mor-slate', agoda: 'bg-purple-50 text-purple-700',
  private: 'bg-mor-greenlight text-mor-green', oneoff: 'bg-rose-50 text-rose-600', partner: 'bg-teal-50 text-teal-700', airbnb_cancelled: 'bg-red-50 text-red-600',
};
const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString());
const PAGE = 50;

// 表頭排序 key → orders 資料表欄位。本頁走伺服器端排序,只能排真實欄位。
// 「物業」不在清單裡:它來自 orders.estate_id 關聯的 estates.name,
// PostgREST 無法用關聯表的欄位排序母表,勉強用 estate_id 排會變成 UUID 亂序。
const SORT_DB_COL: Record<string, string> = {
  source: 'source', property_raw: 'property_raw', guest_name: 'guest_name',
  checkin: 'checkin', amount: 'amount', deposit: 'deposit', account: 'account',
};

export default function ShortTermPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [detail, setDetail] = useState<Order | null>(null);
  const [rows, setRows] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [src, setSrc] = useState('');
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [edit, setEdit] = useState<Order | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const [estF, setEstF] = useState('');
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'checkin', dir: 'desc' });
  const [agg, setAgg] = useState<any[]>([]);

  useEffect(() => { supabase.from('estates').select('id, name, sort, active').order('sort').then(({ data }) => setEstates(data ?? [])); }, [supabase]);
  // 入款帳號改讀主檔,不再寫死。現金與加密貨幣沒有帳號,直接列在選單上。
  const [payAccounts, setPayAccounts] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    supabase.from('payment_accounts').select('code, name')
      .eq('for_income', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
  }, [supabase]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const [fees, setFees] = useState<Fee[]>([]);
  const [fxRev, setFxRev] = useState<{ cur: string; amt: number; rate: number }[]>([]);
  const [fxDep, setFxDep] = useState<{ cur: string; amt: number }[]>([]);
  const [twdBase, setTwdBase] = useState(0);
  const revFxTwd = useMemo(() => fxRev.reduce((a, l) => a + (Number(l.amt) || 0) * (Number(l.rate) || 0), 0), [fxRev]);
  const addFxRev = () => setFxRev((x) => [...x, { cur: 'USD', amt: 0, rate: 0 }]);
  const updFxRev = (i: number, patch: Partial<{ cur: string; amt: number; rate: number }>) => setFxRev((x) => x.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const delFxRev = (i: number) => setFxRev((x) => x.filter((_, idx) => idx !== i));
  const addFxDep = () => setFxDep((x) => [...x, { cur: 'USD', amt: 0 }]);
  const updFxDep = (i: number, patch: Partial<{ cur: string; amt: number }>) => setFxDep((x) => x.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const delFxDep = (i: number) => setFxDep((x) => x.filter((_, idx) => idx !== i));
  useEffect(() => {
    const fr = ((edit as any)?.fx_revenue ?? []) as { cur: string; amt: number; rate: number }[];
    const fd = ((edit as any)?.fx_deposit ?? []) as { cur: string; amt: number }[];
    setFxRev(fr); setFxDep(fd);
    const fxTwd = fr.reduce((a, l) => a + (Number(l.amt) || 0) * (Number(l.rate) || 0), 0);
    setTwdBase(Math.max(0, Number(edit?.amount || 0) - fxTwd));
    if (edit?.id) {
      supabase.from('orders').select('id, checkin, amount, fee_type, note').eq('parent_order_id', edit.id).eq('source', 'oneoff').then(({ data }) => setFees((data ?? []).map((f: any) => ({ id: f.id, date: f.checkin ?? '', type: f.fee_type ?? '其他', amount: Number(f.amount) || 0, note: f.note ?? '' }))));
    } else { setFees([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id, supabase]);
  const addFee = () => setFees((fs) => [...fs, { date: edit?.checkout || edit?.checkin || '', type: '清潔費', amount: 0, note: '' }]);
  const updFee = (i: number, patch: Partial<Fee>) => setFees((fs) => fs.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  const delFee = (i: number) => setFees((fs) => fs.filter((_, idx) => idx !== i));
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  useEffect(() => { supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? [])); }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    // 伺服器端排序。本頁是伺服器端分頁,若改成前端排序只會排到當前頁的 100 筆。
    // nullsFirst: false —— 空值一律殿後,與另外兩頁的前端排序行為一致。
    const sortCol = SORT_DB_COL[sort?.key ?? 'checkin'] ?? 'checkin';
    let q = supabase.from('orders').select('*, properties(name)', { count: 'exact' }).in('source', SRC)
      .order(sortCol, { ascending: sort?.dir === 'asc', nullsFirst: false });
    if (src) q = q.eq('source', src);
    if (estF) q = q.eq('estate_id', estF);
    if (toD) q = q.lte('checkin', toD);
    if (fromD) q = q.gte('checkout', fromD);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
    const { data, count } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as any) ?? []); setTotal(count ?? 0); setLoading(false);
  }, [supabase, src, kw, estF, fromD, toD, sort, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [src, kw, estF, fromD, toD, sort]);

  const loadAgg = useCallback(async () => {
    let all: any[] = []; let from = 0;
    while (true) {
      let q = supabase.from('orders').select('source, estate_id, amount, deposit, deposit_received, deposit_returned, fx_deposit').in('source', SRC);
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

  // 匯出 Excel:輸出「目前篩選 + 排序後」的結果,與畫面所見一致。
  //
  // ⚠️ 與契約頁的關鍵差異:本頁是伺服器端分頁,state 裡的 rows 只有當前這一頁。
  // 直接拿 rows 匯出只會得到 50 筆,所以這裡要重新向伺服器要完整結果,
  // 篩選與排序條件必須與 load() 完全一致,否則匯出內容會對不上畫面。
  const [exporting, setExporting] = useState(false);
  async function exportXlsx() {
    setExporting(true);
    try {
      const sortCol = SORT_DB_COL[sort?.key ?? 'checkin'] ?? 'checkin';
      let all: Order[] = [];
      let from = 0;
      while (true) {
        let q = supabase.from('orders').select('*, properties(name)').in('source', SRC)
          .order(sortCol, { ascending: sort?.dir === 'asc', nullsFirst: false });
        if (src) q = q.eq('source', src);
        if (estF) q = q.eq('estate_id', estF);
        if (toD) q = q.lte('checkin', toD);
        if (fromD) q = q.gte('checkout', fromD);
        if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
        const { data, error } = await q.range(from, from + 999);
        if (error) { flash('匯出失敗:' + error.message); return; }
        const chunk = (data as any[]) ?? [];
        all = all.concat(chunk as Order[]);
        if (chunk.length < 1000) break;
        from += 1000;
      }
      if (!all.length) { flash('沒有符合條件的訂單'); return; }

      const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
      const BORD = { top: BR, bottom: BR, left: BR, right: BR };
      const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
      const stCell = { border: BORD };
      const stNum = { border: BORD, alignment: { horizontal: 'right' } };
      const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

      const header = ['來源', '物業', '房源', '客戶', '入住日', '退房日', '晚數', '金額', '押金', '入款方式', '備註'];
      const aoa: any[][] = [header.map((h) => T(h, stHead))];
      for (const o of all) {
        aoa.push([
          T(SRC_LABEL[o.source] ?? o.source, stCell),
          T(o.estate_id ? estateName[o.estate_id] ?? '' : '', stCell),
          T(o.property_raw ?? o.properties?.name ?? '', stCell),
          T(o.guest_name ?? '', stCell),
          T(o.checkin ?? '', stCell),
          T(o.checkout ?? '', stCell),
          T(Number(o.nights) || 0, stNum),
          T(Math.round(Number(o.amount) || 0), stNum),
          T(Math.round(Number(o.deposit) || 0), stNum),
          T(o.account ?? '', stCell),
          T(o.note ?? '', stCell),
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 }];
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };   // 凍結表頭
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '短租訂單');
      // 檔名帶上篩選條件,之後回頭找得出這份是什麼
      const tag = [SRC_LABEL[src] ?? '', estF ? estateName[estF] ?? '' : '', fromD, toD, kw].filter(Boolean).join('_');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      XLSX.writeFile(wb, `短租訂單${tag ? '_' + tag : ''}_${stamp}.xlsx`);
      flash(`已匯出 ${all.length.toLocaleString()} 筆`);
    } finally {
      setExporting(false);
    }
  }

  async function save() {
    if (!edit) return;
    const co = edit.source === 'oneoff' ? (edit.checkout || edit.checkin) : edit.checkout;
    const nights = (edit.checkin && co) ? Math.max(0, Math.round((new Date(co).getTime() - new Date(edit.checkin).getTime()) / 86400000)) : 0;
    const payload = { source: edit.source, estate_id: edit.estate_id, property_id: edit.property_id ?? null, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: edit.checkin || null, checkout: co || null, nights, amount: (twdBase || 0) + revFxTwd, deposit: edit.deposit, account: edit.account, note: edit.note, deposit_received: edit.deposit_received ?? false, deposit_returned: edit.deposit_returned ?? false, deposit_received_at: edit.deposit_received ? (edit.deposit_received_at || null) : null, deposit_returned_at: edit.deposit_returned ? (edit.deposit_returned_at || null) : null, fx_revenue: fxRev.filter((l) => l.cur && l.amt), fx_deposit: fxDep.filter((l) => l.cur && l.amt) };
    let orderId = edit.id;
    if (edit.id) {
      const { error } = await supabase.from('orders').update(payload).eq('id', edit.id);
      if (error) return flash('儲存失敗:' + error.message);
    } else {
      const { data, error } = await supabase.from('orders').insert({ ...payload, order_key: `${edit.source === 'oneoff' ? 'OO' : 'PV'}_${edit.checkin || 'na'}_${edit.property_raw ?? ''}_${edit.guest_name ?? ''}_${Date.now()}`, imported_via: 'manual' }).select('id').single();
      if (error || !data) return flash('儲存失敗:' + (error?.message || ''));
      orderId = (data as any).id;
    }
    // 同步加費(oneoff 子訂單)
    const keepIds = fees.filter((f) => f.id).map((f) => f.id);
    const { data: curFees } = await supabase.from('orders').select('id').eq('parent_order_id', orderId).eq('source', 'oneoff');
    const delIds = (curFees ?? []).filter((c: any) => !keepIds.includes(c.id)).map((c: any) => c.id);
    if (delIds.length) await supabase.from('orders').delete().in('id', delIds);
    for (const f of fees) {
      if (!f.date || !f.amount) continue;
      const row = { source: 'oneoff', estate_id: edit.estate_id, property_id: edit.property_id ?? null, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: f.date, checkout: f.date, nights: 0, amount: f.amount, fee_type: f.type, note: f.note || null, parent_order_id: orderId };
      if (f.id) await supabase.from('orders').update(row).eq('id', f.id);
      else await supabase.from('orders').insert({ ...row, order_key: `FEE_${String(orderId).slice(0, 8)}_${Date.now()}${Math.floor(Math.random() * 1000)}`, imported_via: 'manual' });
    }
    flash('已儲存'); setEdit(null); setFees([]); load();
  }
  async function del(o: Order) {
    if (!confirm(`刪除訂單「${o.guest_name} ${o.property_raw}」?`)) return;
    const { error } = await supabase.from('orders').delete().eq('id', o.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }
  async function openMove(o: Order) {
    const grp = o.move_group || o.id;
    const { data: segs } = await supabase.from('orders').select('*').or(`id.eq.${grp},move_group.eq.${grp}`).order('checkin');
    const list = (segs && segs.length ? segs : [o]) as any[];
    const stays: Stay[] = list.map((x) => ({ room: x.property_raw ?? '', estateId: x.estate_id, propertyId: x.property_id ?? null, from: x.checkin }));
    const checkin = list[0].checkin, checkout = list[list.length - 1].checkout;
    const totalNights = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000));
    const totalAmount = list.reduce((a, x) => a + Number(x.amount || 0), 0);
    setMove({ grp, checkin, checkout, totalNights, totalAmount, guest: o.guest_name, source: o.source, account: o.account, stays });
  }
  function moveWithAmounts(m: MoveState) {
    const segs = m.stays.map((s, i) => {
      const from = i === 0 ? m.checkin : s.from;
      const to = i < m.stays.length - 1 ? m.stays[i + 1].from : m.checkout;
      const nights = from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) : 0;
      return { ...s, from, to, nights, amount: 0 };
    });
    let used = 0;
    segs.forEach((seg, i) => { seg.amount = i < segs.length - 1 ? Math.round(m.totalAmount * seg.nights / m.totalNights) : m.totalAmount - used; used += seg.amount; });
    return segs;
  }
  function moveErr(m: MoveState): string | null {
    const segs = moveWithAmounts(m);
    if (segs.some((s) => !s.room)) return '每段都要選房源';
    for (let i = 1; i < segs.length; i++) { if (!m.stays[i].from) return '每個移房都要填移入日期'; if (new Date(segs[i].from) <= new Date(segs[i - 1].from)) return '移入日期需晚於前一段'; }
    if (segs.some((s) => s.nights < 1)) return '每段至少 1 晚(日期需在期間內)';
    return null;
  }
  async function doMove() {
    if (!move) return;
    const err = moveErr(move);
    if (err) return flash(err);
    const segs = moveWithAmounts(move);
    const chain = segs.map((s) => s.room).join('>');
    const grp = move.grp, isMulti = segs.length > 1;
    const s0 = segs[0];
    const patch: any = { estate_id: s0.estateId, property_id: s0.propertyId, property_raw: s0.room, checkin: s0.from, checkout: s0.to, nights: s0.nights, amount: s0.amount, move_group: isMulti ? grp : null };
    if (isMulti) patch.note = `移房 ${chain}`;
    const { error: e1 } = await supabase.from('orders').update(patch).eq('id', grp);
    if (e1) return flash('移房失敗:' + e1.message);
    await supabase.from('orders').delete().eq('move_group', grp).neq('id', grp);
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      const { error } = await supabase.from('orders').insert({ order_key: `MOVE_${String(grp).slice(0, 8)}_${i}_${Date.now()}`, source: move.source, estate_id: s.estateId, property_id: s.propertyId, property_raw: s.room, guest_name: move.guest, checkin: s.from, checkout: s.to, nights: s.nights, amount: s.amount, deposit: 0, account: move.account, note: `移房 ${chain}`, move_group: grp, imported_via: 'manual' });
      if (error) return flash('建立分段失敗:' + error.message);
    }
    flash(isMulti ? `已移房,拆成 ${segs.length} 段` : '已更新'); setMove(null); load();
  }
  const addStay = () => move && setMove({ ...move, stays: [...move.stays, { room: '', estateId: move.stays[move.stays.length - 1]?.estateId ?? null, propertyId: null, from: '' }] });
  const updStay = (i: number, patch: Partial<Stay>) => move && setMove({ ...move, stays: move.stays.map((s, idx) => idx === i ? { ...s, ...patch } : s) });
  const delStay = (i: number) => move && setMove({ ...move, stays: move.stays.filter((_, idx) => idx !== i) });
  function blank(): Order { return { id: '', order_key: '', source: 'private', estate_id: null, property_id: null, property_raw: '', guest_name: '', checkin: '', checkout: '', nights: 0, amount: 0, deposit: 0, account: null, note: '', deposit_received: false, deposit_returned: false, deposit_received_at: null, deposit_returned_at: null, fx_revenue: [], fx_deposit: [] }; }

  const totRevenue = useMemo(() => agg.reduce((a, o) => a + Number(o.amount || 0), 0), [agg]);
  const heldTwd = useMemo(() => agg.reduce((a, o) => a + (o.deposit_received && !o.deposit_returned ? Number(o.deposit || 0) : 0), 0), [agg]);
  const heldFx = useMemo(() => { const m: Record<string, number> = {}; for (const o of agg) { if (o.deposit_received && !o.deposit_returned) { for (const l of (o.fx_deposit || [])) { const c = l.cur || '?'; m[c] = (m[c] || 0) + (Number(l.amt) || 0); } } } return m; }, [agg]);
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
          <div className="text-sm opacity-90 mt-2">佔收帳款(暫收) 台幣 <span className="font-semibold">${fmt(heldTwd)}</span>{Object.entries(heldFx).map(([c, v]) => <span key={c} className="ml-1">· {c} {fmt(v)}</span>)}</div>
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
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estF} onChange={(e) => setEstF(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}{es.active ? '' : '(停用)'}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={src} onChange={(e) => setSrc(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{FILTER_SRC.map((s) => <option key={s} value={s}>{SRC_LABEL[s]}</option>)}
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
          <button onClick={exportXlsx} disabled={exporting || !total} className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">{exporting ? '匯出中…' : '⬇ 下載 Excel'}</button>
          <button onClick={() => setEdit(blank())} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增訂單</button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <SortTh label="來源" sortKey="source" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="房源" sortKey="property_raw" type="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="客戶" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="訂單起訖" sortKey="checkin" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <SortTh label="金額" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">無訂單</td></tr>
            : rows.map((o) => (
              // 整列可點,開啟右側詳細抽屜。
              // 刪除與移房移進抽屜:1,900 多筆的列表上,刪除只差 8px 就在編輯旁邊,
              // 點錯就是一張真實訂單消失。要先開抽屜看到完整內容才刪得掉,那本身就是一道確認。
              <tr key={o.id} onClick={() => setDetail(o)}
                className="border-b border-mor-line/60 hover:bg-mor-bluelight/30 cursor-pointer">
                <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SRC_COLOR[o.source]}`}>{SRC_LABEL[o.source] ?? o.source}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div>{o.property_raw ?? o.properties?.name ?? '—'}</div>
                  <div className="text-[11px] text-gray-400">{o.estate_id ? estateName[o.estate_id] ?? '' : ''}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{o.guest_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{o.checkin}~{o.checkout}</td>
                <td className="px-3 py-2 text-right font-medium">${fmt(o.amount)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={(e) => { e.stopPropagation(); setEdit(o); }} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
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

      {/* 詳細資訊抽屜 —— 列表精簡掉的欄位都在這裡,破壞性操作也放這 */}
      {detail && (() => {
        const d = detail;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        const canMove = d.source !== 'oneoff' && d.checkin && d.checkout && d.nights > 1;
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold truncate">{d.guest_name ?? '—'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {d.estate_id ? estateName[d.estate_id] ?? '' : ''} {d.property_raw ?? d.properties?.name ?? ''}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('來源', <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SRC_COLOR[d.source]}`}>{SRC_LABEL[d.source] ?? d.source}</span>)}
                {row('訂單起訖', <span>{d.checkin} ~ {d.checkout}<span className="text-gray-400 ml-2">{d.nights} 晚</span></span>)}
                {row('金額', <span className="font-medium">${fmt(d.amount)}</span>)}
                {row('押金', d.deposit ? (
                  <span>
                    ${fmt(d.deposit)}
                    <span className="ml-2 text-xs text-gray-500">
                      {d.deposit_received ? `已收${d.deposit_received_at ? ' ' + d.deposit_received_at.slice(0, 10) : ''}` : '未收'}
                      {d.deposit_returned ? `・已退${d.deposit_returned_at ? ' ' + d.deposit_returned_at.slice(0, 10) : ''}` : ''}
                    </span>
                  </span>
                ) : '—')}
                {row('入款方式', d.account ?? '—')}
                {d.fx_revenue?.length ? row('外幣營收', d.fx_revenue.map((f, i) => <div key={i}>{f.cur} {fmt(f.amt)} × {f.rate}</div>)) : null}
                {d.fx_deposit?.length ? row('外幣押金', d.fx_deposit.map((f, i) => <div key={i}>{f.cur} {fmt(f.amt)}</div>)) : null}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}
                {row('訂單編號', <span className="text-xs text-gray-500 break-all">{d.order_key}</span>)}
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setDetail(null); setEdit(d); }}
                  className="flex-1 h-11 rounded-lg bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark">編輯</button>
                {canMove && (
                  <button onClick={() => { setDetail(null); openMove(d); }}
                    className="flex-1 h-11 rounded-lg border border-mor-green text-mor-green text-sm font-medium hover:bg-mor-greenlight">移房</button>
                )}
                <button onClick={() => { del(d); setDetail(null); }}
                  className="flex-1 h-11 rounded-lg border border-red-300 text-red-500 text-sm font-medium hover:bg-red-50">刪除</button>
              </div>
            </div>
          </div>
        );
      })()}

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
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '金額' : '訂單總額(台幣)'}<input type="number" value={twdBase} onChange={(e) => setTwdBase(parseFloat(e.target.value) || 0)} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">押金(台幣)<input type="number" value={edit.deposit ?? ''} onChange={(e) => setEdit({ ...edit, deposit: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
              {edit.source !== 'oneoff' && (
                <div className="col-span-2 border-t border-mor-line pt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">訂單其他幣別(外幣營收,換匯併入營收)</span>
                    <button type="button" onClick={addFxRev} className="text-xs text-mor-blue underline">+ 新增其他幣別</button>
                  </div>
                  {fxRev.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 mb-1">
                      <input value={l.cur} onChange={(e) => updFxRev(i, { cur: e.target.value.toUpperCase() })} placeholder="幣別" className="rounded border border-gray-300 px-2 py-1 text-xs w-16" />
                      <input type="number" value={l.amt} onChange={(e) => updFxRev(i, { amt: parseFloat(e.target.value) || 0 })} placeholder="金額" className="rounded border border-gray-300 px-2 py-1 text-xs w-24" />
                      <span className="text-xs text-gray-400">× 匯率</span>
                      <input type="number" value={l.rate} onChange={(e) => updFxRev(i, { rate: parseFloat(e.target.value) || 0 })} placeholder="匯率" className="rounded border border-gray-300 px-2 py-1 text-xs w-20" />
                      <span className="text-xs text-gray-600">= ${fmt((Number(l.amt) || 0) * (Number(l.rate) || 0))}</span>
                      <button type="button" onClick={() => delFxRev(i)} className="text-xs text-red-500 underline">刪除</button>
                    </div>
                  ))}
                  <div className="text-xs text-gray-500 mt-1">營收合計(台幣):<span className="font-semibold text-mor-slate">${fmt((twdBase || 0) + revFxTwd)}</span>{revFxTwd ? ` (台幣 ${fmt(twdBase)} + 外幣換算 ${fmt(revFxTwd)})` : ''}</div>
                </div>
              )}
              {edit.source !== 'oneoff' && (
                <div className="col-span-2 flex flex-wrap items-center gap-5 text-sm bg-mor-sand/30 rounded-lg px-3 py-2">
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={!!edit.deposit_received} onChange={(e) => setEdit({ ...edit, deposit_received: e.target.checked })} />已收押金</label>
                  {edit.deposit_received && <input type="date" value={edit.deposit_received_at ?? ''} onChange={(e) => setEdit({ ...edit, deposit_received_at: e.target.value || null })} className="rounded border border-gray-300 px-2 py-1 text-xs" title="收款日期" />}
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={!!edit.deposit_returned} onChange={(e) => setEdit({ ...edit, deposit_returned: e.target.checked })} />退回押金</label>
                  {edit.deposit_returned && <input type="date" value={edit.deposit_returned_at ?? ''} onChange={(e) => setEdit({ ...edit, deposit_returned_at: e.target.value || null })} className="rounded border border-gray-300 px-2 py-1 text-xs" title="退回日期" />}
                  <span className="text-xs text-gray-400">押金為暫收(佔收帳款),非營收;退回後從佔收帳款扣除</span>
                </div>
              )}
              {edit.source !== 'oneoff' && (
                <div className="col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">押金其他幣別(暫收,原幣退還,不換匯)</span>
                    <button type="button" onClick={addFxDep} className="text-xs text-mor-blue underline">+ 新增其他幣別</button>
                  </div>
                  {fxDep.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 mb-1">
                      <input value={l.cur} onChange={(e) => updFxDep(i, { cur: e.target.value.toUpperCase() })} placeholder="幣別" className="rounded border border-gray-300 px-2 py-1 text-xs w-16" />
                      <input type="number" value={l.amt} onChange={(e) => updFxDep(i, { amt: parseFloat(e.target.value) || 0 })} placeholder="金額" className="rounded border border-gray-300 px-2 py-1 text-xs w-24" />
                      <button type="button" onClick={() => delFxDep(i)} className="text-xs text-red-500 underline">刪除</button>
                    </div>
                  ))}
                </div>
              )}
              <label className="flex flex-col gap-1">入款方式<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option><option value="現金">現金</option>{payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}<option value="加密貨幣">加密貨幣</option></select></label>
              <label className="flex flex-col gap-1 col-span-2">備註<input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && (
                <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">加費(一次性收入)</span>
                    <button type="button" onClick={addFee} className="text-xs text-mor-blue underline hover:text-mor-slate">+ 新增加費</button>
                  </div>
                  {fees.length === 0 && <p className="text-xs text-gray-400">尚無加費。清潔費/修繕費等一次性費用,認列在該費用日期當月,並以「其他收入(一次性)」計入營收報表。</p>}
                  <div className="flex flex-col gap-2">
                    {fees.map((f, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 bg-mor-sand/30 rounded-lg px-2 py-2">
                        <input type="date" value={f.date} onChange={(e) => updFee(i, { date: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <select value={f.type} onChange={(e) => updFee(i, { type: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-xs"><option value="清潔費">清潔費</option><option value="修繕費">修繕費</option><option value="其他">其他</option></select>
                        <input type="number" value={f.amount} onChange={(e) => updFee(i, { amount: parseFloat(e.target.value) || 0 })} placeholder="費用" className="rounded border border-gray-300 px-2 py-1 text-xs w-24" />
                        <input value={f.note} onChange={(e) => updFee(i, { note: e.target.value })} placeholder="備註" className="rounded border border-gray-300 px-2 py-1 text-xs flex-1 min-w-[6rem]" />
                        <button type="button" onClick={() => delFee(i)} className="text-xs text-red-500 underline">刪除</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">儲存</button>
            </div>
          </div>
        </div>
      )}

      {move && (() => {
        const segs = moveWithAmounts(move);
        const err = moveErr(move);
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setMove(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">移房 · {move.guest ?? ''}<button onClick={() => setMove(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button></div>
            <div className="px-6 py-4 flex flex-col gap-3 text-sm">
              <div className="text-xs text-gray-500">整筆:{move.checkin}~{move.checkout} · 共 {move.totalNights} 晚 · 總營收 ${fmt(move.totalAmount)}(按晚數比例分攤各段)</div>
              {move.stays.map((s, i) => {
                const seg = segs[i];
                return (
                  <div key={i} className="bg-mor-sand/30 rounded-lg px-3 py-2 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{i === 0 ? '入住(第 1 間)' : `第 ${i + 1} 間`}</span>
                      {i > 0 && <button type="button" onClick={() => delStay(i)} className="text-xs text-red-500 underline">刪除</button>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select value={s.estateId ?? ''} onChange={(e) => updStay(i, { estateId: e.target.value || null, room: '', propertyId: null })} className="rounded border border-gray-300 px-2 py-1 text-xs"><option value="">物業</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}{es.active ? '' : '(停用)'}</option>)}</select>
                      <select value={s.room} onChange={(e) => { const nm = e.target.value; const pr = properties.find((x) => x.estate_id === s.estateId && x.name === nm); updStay(i, { room: nm, propertyId: pr?.id ?? null }); }} className="rounded border border-gray-300 px-2 py-1 text-xs"><option value="">房源</option>{properties.filter((x) => x.estate_id === s.estateId).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select>
                      {i === 0 ? <span className="text-xs text-gray-500">入住日 {move.checkin}</span> : <input type="date" value={s.from} min={move.checkin} max={move.checkout} onChange={(e) => updStay(i, { from: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-xs" />}
                    </div>
                    <div className="text-xs text-gray-600">{seg.from}~{seg.to} · {seg.nights}晚 · 認列 <span className="font-semibold">${fmt(seg.amount)}</span></div>
                  </div>
                );
              })}
              <button type="button" onClick={addStay} className="text-xs text-mor-blue underline self-start">+ 增加移房</button>
              {err && <p className="text-xs text-red-500">{err}</p>}
              <p className="text-xs text-gray-400">押金留在第 1 段。各段各自認列到應收,備註「移房 {segs.map((s) => s.room || '?').join('>')}」。</p>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setMove(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doMove} disabled={!!err} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">確認移房</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}