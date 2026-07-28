'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { onlyLtOf } from '@/lib/ltKey';

type Contract = {
  id: string; estate_id: string | null; room: string | null; tenant_name: string | null;
  phone: string | null; cadence: string; type: string | null; monthly_rent: number | null; amount_per_period: number | null; deposit: number | null;
  start_date: string | null; end_date: string | null; pay_day: number | null; first_payment_date: string | null;
  paid: boolean; account: string | null; note: string | null; active: boolean; watch?: boolean; display_name?: string | null;
};
type Estate = { id: string; name: string; sort: number };

const CAD_LABEL: Record<string, string> = { monthly: '月繳', quarterly: '季繳', halfyear: '半年繳', yearly: '年繳' };
const TYPE_LABEL: Record<string, string> = { longterm: '長租', company: '公司登記', office: '辦公室' };
const STEP_OF: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
const TYPE_SRC: Record<string, string> = { longterm: 'longterm', company: 'company', office: 'office' };
const FEE_TYPES = ['水費', '電費', '網路費', '瓦斯費', '管理費', '清潔費', '修繕費', '其他'];
const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString());

export default function ContractsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [estateFilter, setEstateFilter] = useState('');
  const [edit, setEdit] = useState<Contract | null>(null);
  const [collect, setCollect] = useState<Contract | null>(null);
  const [kw, setKw] = useState('');
  const [sortMode, setSortMode] = useState<'date_desc' | 'date_asc' | 'room'>('date_desc');
  const [cadFilter, setCadFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [ext, setExt] = useState({ months: '', monthly: '', total: '' });
  const [extBatches, setExtBatches] = useState<any[]>([]);
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  const [curLT, setCurLT] = useState<Record<string, { amount: number; paid: boolean }>>({});
  const [overdue, setOverdue] = useState<{ order_key: string; property_raw: string | null; guest_name: string | null; amount: number; checkin: string }[]>([]);
  const curFirst = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  const curMon = (() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}`; })();

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('contracts').select('*, estates(name)').order('room');
    setRows((data as any) ?? []);
    const { data: lts } = await supabase.from('orders').select('property_raw, amount, paid').in('source', ['longterm', 'company', 'office']).eq('checkin', curFirst);
    const m: Record<string, { amount: number; paid: boolean }> = {};
    (lts ?? []).forEach((o: any) => { if (o.property_raw) m[o.property_raw] = { amount: Number(o.amount || 0), paid: !!o.paid }; });
    setCurLT(m);
    // 跨月欠款:本月之前已到期但仍未收的月租單(本月未收另計,兩者不重疊)
    const { data: ovd } = await supabase.from('orders')
      .select('order_key, property_raw, guest_name, amount, checkin')
      .in('source', ['longterm', 'company', 'office'])
      .eq('paid', false)
      .lt('checkin', curFirst)
      .order('checkin');
    setOverdue((ovd as any) ?? []);
    setLoading(false);
  }, [supabase, curFirst]);
  useEffect(() => {
    supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? []));
    load();
  }, [supabase, load]);
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  const todayS = new Date().toISOString().slice(0, 10);
  const statusOf = (c: any) => (!c.active ? 'disabled' : (c.end_date && c.end_date < todayS ? 'expired' : 'active'));
  const filtered = useMemo(() => {
    let out = estateFilter ? rows.filter((r: any) => r.estates?.name === estateFilter) : rows;
    if (cadFilter) out = out.filter((r) => r.cadence === cadFilter);
    if (typeFilter) out = out.filter((r) => (r.type ?? 'longterm') === typeFilter);
    if (statusFilter) out = out.filter((r) => statusOf(r) === statusFilter);
    if (fromD || toD) out = out.filter((r) => { const st = r.start_date || '', en = r.end_date || ''; if (toD && st && st > toD) return false; if (fromD && en && en < fromD) return false; return true; });
    if (kw) { const k = kw.toLowerCase(); out = out.filter((r) => `${r.room ?? ''}${r.tenant_name ?? ''}${r.phone ?? ''}${r.note ?? ''}`.toLowerCase().includes(k)); }
    const rk = (x: string) => { const m = String(x || '').match(/^(\d+)/); return [m ? parseInt(m[1]) : 999, String(x || '')] as [number, string]; };
    out = [...out].sort((a: any, b: any) => {
      if (sortMode === 'room') { const ka = rk(a.room), kb = rk(b.room); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); }
      const av = a.start_date || '', bv = b.start_date || '';
      return sortMode === 'date_asc' ? (av > bv ? 1 : av < bv ? -1 : 0) : (av < bv ? 1 : av > bv ? -1 : 0);
    });
    return out;
  }, [rows, estateFilter, cadFilter, typeFilter, statusFilter, fromD, toD, kw, sortMode]);
  const activeCount = useMemo(() => filtered.filter((r) => r.active).length, [filtered]);
  const monthAR = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.room ?? '']?.amount ?? 0), 0), [filtered, curLT]);
  const monthPaid = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.room ?? '']?.paid ? (curLT[r.room ?? ''].amount) : 0), 0), [filtered, curLT]);
  const roomLists = useMemo(() => {
    const rk = (x: string) => { const m = String(x || '').match(/^(\d+)/); return [m ? parseInt(m[1]) : 999, String(x || '')] as [number, string]; };
    const cmp = (a: { room: string }, b: { room: string }) => { const ka = rk(a.room), kb = rk(b.room); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); };
    const paid: { room: string; label: string }[] = [], unpaid: { room: string; label: string }[] = [];
    filtered.filter((r) => r.active && r.watch).forEach((r) => { const lt = curLT[r.room ?? '']; if (!lt) return; const it = { room: r.room ?? '', label: (r.display_name || r.room || '') as string }; (lt.paid ? paid : unpaid).push(it); });
    return { paid: paid.sort(cmp), unpaid: unpaid.sort(cmp) };
  }, [filtered, curLT]);

  // 跨月欠款:依房源彙總,連續月份合併顯示(2026/4,5,6 → 2026/4~6)
  const arrears = useMemo(() => {
    const byRoom = new Map<string, { room: string; label: string; tenant: string | null; yms: string[]; amount: number }>();
    for (const o of overdue) {
      const room = o.property_raw ?? '';
      if (!room) continue;
      const c = rows.find((r) => r.room === room);
      const g = byRoom.get(room) ?? { room, label: (c?.display_name || room) as string, tenant: o.guest_name ?? c?.tenant_name ?? null, yms: [], amount: 0 };
      g.yms.push(o.checkin.slice(0, 4) + o.checkin.slice(5, 7));
      g.amount += Number(o.amount || 0);
      byRoom.set(room, g);
    }
    const squash = (yms: string[]) => {
      const s = [...new Set(yms)].sort();
      const out: string[] = [];
      let i = 0;
      while (i < s.length) {
        let j = i;
        while (j + 1 < s.length && nextYm(s[j]) === s[j + 1]) j++;
        out.push(i === j ? fmtYm(s[i]) : `${fmtYm(s[i])}~${fmtYm(s[j])}`);
        i = j + 1;
      }
      return out.join('、');
    };
    return [...byRoom.values()]
      .map((g) => ({ ...g, periods: g.yms.length, span: squash(g.yms), oldest: [...g.yms].sort()[0] }))
      .sort((a, b) => (a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : 0));
  }, [overdue, rows]);
  const arrearsTotal = useMemo(() => arrears.reduce((s, g) => s + g.amount, 0), [arrears]);

  async function togglePin(c: Contract) {
    const { error } = await supabase.from('contracts').update({ watch: !c.watch }).eq('id', c.id);
    if (error) return flash('更新失敗:' + error.message);
    setRows((rs) => rs.map((r) => r.id === c.id ? { ...r, watch: !c.watch } : r));
  }
  async function togglePaid(c: Contract) {
    const { error } = await supabase.from('contracts').update({ paid: !c.paid }).eq('id', c.id);
    if (error) return flash('更新失敗:' + error.message);
    setRows((rs) => rs.map((r) => r.id === c.id ? { ...r, paid: !c.paid } : r));
  }
  async function save() {
    if (!edit) return;
    const payload = {
      estate_id: edit.estate_id, room: edit.room, tenant_name: edit.tenant_name, phone: edit.phone,
      cadence: edit.cadence, type: edit.type, amount_per_period: edit.amount_per_period,
      monthly_rent: Math.round((edit.amount_per_period || 0) / (STEP_OF[edit.cadence] || 1)), deposit: edit.deposit,
      start_date: edit.start_date || null, end_date: edit.end_date || null, first_payment_date: edit.first_payment_date || null, pay_day: edit.pay_day ?? null,
      account: edit.account, note: edit.note, active: edit.active, watch: edit.watch ?? false, display_name: edit.display_name || null, name: `${edit.tenant_name ?? ''}-${edit.room ?? ''}`,
    };
    const { error } = edit.id
      ? await supabase.from('contracts').update(payload).eq('id', edit.id)
      : await supabase.from('contracts').insert(payload);
    if (error) return flash('儲存失敗:' + error.message);
    flash('已儲存'); setEdit(null); load();
  }
  async function del(c: Contract) {
    if (!confirm(`刪除契約「${c.tenant_name} ${c.room}」?`)) return;
    const { error } = await supabase.from('contracts').delete().eq('id', c.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }
  const loadExtBatches = useCallback(async () => {
    if (!edit?.id || !edit?.room) { setExtBatches([]); return; }
    const { data } = await supabase.from('orders').select('order_key, amount').eq('imported_via', 'extend').like('order_key', `LT_${edit.room}_%`);
    const rows = onlyLtOf(data as any[], edit.room).map((o: any) => ({ ym: o.order_key.split('_').pop() as string, amount: Number(o.amount || 0) })).sort((a, b) => (a.ym < b.ym ? -1 : 1));
    const batches: any[] = [];
    for (const r of rows) {
      const last = batches[batches.length - 1];
      if (last && nextYm(last.endYm) === r.ym && last.amount === r.amount) { last.endYm = r.ym; last.count++; }
      else batches.push({ startYm: r.ym, endYm: r.ym, count: 1, amount: r.amount });
    }
    setExtBatches(batches);
  }, [edit?.id, edit?.room, supabase]);
  useEffect(() => { loadExtBatches(); }, [loadExtBatches]);

  async function delExtBatch(b: any) {
    if (!edit?.id) return;
    const { data: all } = await supabase.from('orders').select('id, order_key').eq('imported_via', 'extend').like('order_key', `LT_${edit.room}_%`);
    const toDel = onlyLtOf(all as any[], edit.room).filter((o: any) => (o.order_key.split('_').pop() || '') >= b.startYm).map((o: any) => o.id);
    if (toDel.length) { const { error } = await supabase.from('orders').delete().in('id', toDel); if (error) return flash('刪除失敗:' + error.message); }
    const y = +b.startYm.slice(0, 4), m = +b.startYm.slice(4, 6);
    const pe = new Date(y, m - 1, 0);
    const peStr = `${pe.getFullYear()}-${String(pe.getMonth() + 1).padStart(2, '0')}-${String(pe.getDate()).padStart(2, '0')}`;
    await supabase.from('contracts').update({ end_date: peStr }).eq('id', edit.id);
    setEdit((prev) => prev ? { ...prev, end_date: peStr } : prev);
    flash(`已刪除延展(${fmtYm(b.startYm)} 起),對應收租一併移除`);
    loadExtBatches(); load();
  }

  async function doExtend() {
    if (!edit || !edit.id) return;
    const N = parseInt(ext.months); const amt = parseFloat(ext.monthly);
    if (!N || N < 1) return flash('請輸入追加月數');
    if (!amt || amt <= 0) return flash('請輸入月租金或總共租金');
    if (!edit.end_date) return flash('需先設定租期迄才能展延');
    const ed = new Date(edit.end_date + 'T00:00:00');
    const newEnd = new Date(ed.getFullYear(), ed.getMonth() + 1 + N, 0);
    const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const newEndStr = fmtLocal(newEnd);
    const yms: string[] = []; let cur = new Date(ed.getFullYear(), ed.getMonth() + 1, 1);
    for (let i = 0; i < N; i++) { yms.push(`LT_${edit.room}_${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`); cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); }
    const { error: e1 } = await supabase.from('contracts').update({ end_date: newEndStr }).eq('id', edit.id);
    if (e1) return flash('展延失敗:' + e1.message);
    await new Promise((r) => setTimeout(r, 400));
    const src = TYPE_SRC[edit.type ?? 'longterm'] ?? 'longterm';
    await supabase.from('orders').update({ amount: amt, source: src, imported_via: 'extend' }).in('order_key', yms);
    setEdit({ ...edit, end_date: newEndStr });
    setExt({ months: '', monthly: '', total: '' });
    flash(`已展延 ${N} 個月・新增 ${N} 期待收款(月租 $${amt})`);
    loadExtBatches(); load();
  }
  function blank(): Contract {
    return { id: '', estate_id: estates.find((e) => e.name === '正隆')?.id ?? null, room: '', tenant_name: '', phone: '', cadence: 'monthly', type: 'longterm', monthly_rent: 0, amount_per_period: 0, deposit: 0, start_date: '', end_date: '', pay_day: null, first_payment_date: '', paid: false, account: null, note: '', active: true, watch: false, display_name: '' };
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">契約訂單與收款</h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="rounded-xl bg-mor-slate text-white p-4"><div className="text-xs opacity-75">契約數(啟用)</div><div className="text-2xl font-bold mt-1">{activeCount}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">本月({curMon}) 應收</div><div className="text-2xl font-bold mt-1">${fmt(monthAR)}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">本月({curMon}) 已收</div><div className="text-2xl font-bold mt-1 text-mor-green">${fmt(monthPaid)}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">本月({curMon}) 未收</div><div className="text-2xl font-bold mt-1 text-orange-600">${fmt(monthAR - monthPaid)}</div></div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
        <div className="rounded-xl bg-white border border-mor-line p-3">
          <div className="text-xs text-gray-500 mb-1.5">本月({curMon}) 已收房源(關注) <span className="text-mor-green font-medium">{roomLists.paid.length}</span></div>
          <div className="flex flex-wrap gap-1">{roomLists.paid.map((it) => <span key={it.room} className="inline-block rounded-md bg-mor-greenlight/50 text-mor-green px-1.5 py-0.5 text-xs">{it.label}</span>)}{!roomLists.paid.length && <span className="text-xs text-gray-300">—</span>}</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-3">
          <div className="text-xs text-gray-500 mb-1.5">本月({curMon}) 未收房源(關注) <span className="text-orange-600 font-medium">{roomLists.unpaid.length}</span></div>
          <div className="flex flex-wrap gap-1">{roomLists.unpaid.map((it) => <span key={it.room} className="inline-block rounded-md bg-orange-50 text-orange-600 px-1.5 py-0.5 text-xs">{it.label}</span>)}{!roomLists.unpaid.length && <span className="text-xs text-gray-300">—</span>}</div>
        </div>
      </div>

      {arrears.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 mb-3 overflow-hidden">
          <div className="px-4 py-2 border-b border-red-200/70 flex items-center justify-between">
            <div className="text-sm font-semibold text-red-700">
              跨月欠款
              <span className="ml-2 text-xs font-normal text-red-500">
                {arrears.length} 間・共 {arrears.reduce((s, g) => s + g.periods, 0)} 期(不含本月未收)
              </span>
            </div>
            <div className="text-sm font-bold text-red-700">${fmt(arrearsTotal)}</div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {arrears.map((g) => {
              const c = rows.find((r) => r.room === g.room);
              return (
                <div key={g.room}
                  onClick={() => c && setCollect(c)}
                  className="px-4 py-1.5 flex items-center justify-between text-sm border-b border-red-100 last:border-0 cursor-pointer hover:bg-red-100/40">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium shrink-0">{g.label}</span>
                    <span className="text-gray-600 truncate">{g.tenant ?? ''}</span>
                    {c && !c.active && <span className="shrink-0 rounded bg-gray-200 text-gray-500 px-1.5 py-0.5 text-[11px]">已終止</span>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-red-600">欠 {g.periods} 期</span>
                    <span className="text-xs text-gray-500">{g.span}</span>
                    <span className="font-semibold w-24 text-right">${fmt(g.amount)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <select value={estateFilter} onChange={(e) => setEstateFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
          <option value="">全部物業</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
        </select>
        <select value={cadFilter} onChange={(e) => setCadFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">全部繳別</option><option value="monthly">月繳</option><option value="quarterly">季繳</option><option value="halfyear">半年繳</option><option value="yearly">年繳</option></select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">全部類別</option><option value="longterm">長租</option><option value="office">辦公室</option><option value="company">公司登記</option></select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">全部狀態</option><option value="active">進行中</option><option value="expired">已到期</option><option value="disabled">已停用</option></select>
        <div className="flex items-center gap-1" title="依租期(起訖)篩選">
          <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          <span className="text-gray-400">~</span>
          <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          {(fromD || toD) && <button onClick={() => { setFromD(''); setToD(''); }} className="text-gray-400 underline text-xs">清除</button>}
        </div>
        <select value={sortMode} onChange={(e) => setSortMode(e.target.value as any)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="room">房源</option><option value="date_desc">日期新→舊</option><option value="date_asc">日期舊→新</option></select>
        <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜尋 房源/租戶/電話" className="rounded-lg border border-gray-300 px-2 py-1.5 w-44" />
        {kw && <button onClick={() => setKw('')} className="text-gray-400 underline text-xs">清除</button>}
        {(estateFilter || cadFilter || typeFilter || statusFilter || fromD || toD || kw) && <button onClick={() => { setEstateFilter(''); setCadFilter(''); setTypeFilter(''); setStatusFilter(''); setFromD(''); setToD(''); setKw(''); }} className="text-gray-500 underline text-xs">全部清除</button>}
        <div className="text-xs text-gray-400">共 {filtered.length} 筆</div>
        <button onClick={() => setEdit(blank())} className="ml-auto rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增契約</button>
      </div>

      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5">房源</th><th className="px-3 py-2.5">租戶</th><th className="px-3 py-2.5">繳別</th>
              <th className="px-3 py-2.5 text-right">租金 / 對應月租</th><th className="px-3 py-2.5 text-right">押金</th>
              <th className="px-3 py-2.5 whitespace-nowrap">租期</th><th className="px-3 py-2.5">收租</th><th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">尚無契約</td></tr>
            : filtered.map((c: any) => (
              <tr key={c.id} className={`border-b border-mor-line/60 hover:bg-mor-bluelight/30 ${c.active ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{c.room}<span className="ml-1 text-xs text-gray-400">{c.estates?.name}</span>{statusOf(c) === 'expired' && <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] bg-amber-50 text-amber-600">已到期</span>}{statusOf(c) === 'disabled' && <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-500">已停用</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">{c.tenant_name}</td>
                <td className="px-3 py-2 whitespace-nowrap">{CAD_LABEL[c.cadence] ?? c.cadence}</td>
                <td className="px-3 py-2 text-right">{(() => { const step = STEP_OF[c.cadence] || 1; const per = c.amount_per_period || (c.monthly_rent || 0) * step; const mo = Math.round(per / step); return (<><div className="font-medium">${fmt(per)}</div><div className="text-xs text-gray-400">月 ${fmt(mo)}</div></>); })()}</td>
                <td className="px-3 py-2 text-right text-gray-500">${fmt(c.deposit)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{c.start_date ?? '—'} ~ {c.end_date ?? '—'}</td>
                <td className="px-3 py-2">
                  {(() => { const lt = curLT[c.room ?? '']; if (!lt) return <span className="text-xs text-gray-300" title="本月無應收(缺租期或不在租期內)">—</span>; return <button onClick={() => setCollect(c)} title="點擊開啟收款" className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lt.paid ? 'bg-mor-greenlight text-mor-green' : 'bg-orange-50 text-orange-600'}`}>{lt.paid ? '本月已收' : '本月未收'}</button>; })()}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => togglePin(c)} title={c.watch ? '已關注(顯示於已收/未收清單)' : '關注收租(釘選)'} className={`text-xs ${c.watch ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}>{c.watch ? '★' : '☆'}</button>
                  <button onClick={() => setCollect(c)} className="text-xs text-mor-green underline hover:text-emerald-700 font-medium">收租</button>
                  <button onClick={() => setEdit(c)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                  <button onClick={() => del(c)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {collect && <CollectModal contract={collect} onClose={() => { setCollect(null); load(); }} supabase={supabase} />}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              {edit.id ? '編輯契約' : '新增契約'}
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-4 grid grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">物業<select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null, room: '' })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}</select></label>
              <label className="flex flex-col gap-1">房源<select value={edit.room ?? ''} onChange={(e) => setEdit({ ...edit, room: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{properties.filter((x) => x.estate_id === edit.estate_id).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>
              <label className="flex flex-col gap-1">租戶<input value={edit.tenant_name ?? ''} onChange={(e) => setEdit({ ...edit, tenant_name: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">電話<input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">繳別<select value={edit.cadence} onChange={(e) => setEdit({ ...edit, cadence: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="monthly">月繳</option><option value="quarterly">季繳</option><option value="halfyear">半年繳</option><option value="yearly">年繳</option></select></label>
              <label className="flex flex-col gap-1">類別<select value={edit.type ?? 'longterm'} onChange={(e) => setEdit({ ...edit, type: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="longterm">長租</option><option value="company">公司登記</option><option value="office">辦公室</option></select></label>
              <label className="flex flex-col gap-1">首繳日<input type="date" value={edit.first_payment_date ?? ''} onChange={(e) => setEdit({ ...edit, first_payment_date: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <div className="col-span-2 -mt-1 text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                <span>租金對應:</span>
                {edit.cadence === 'yearly'
                  ? <span>每年 {edit.first_payment_date ? Number(edit.first_payment_date.slice(5, 7)) : '?'} 月</span>
                  : <span>{edit.cadence === 'monthly' ? '每月' : edit.cadence === 'quarterly' ? '每三個月' : '每半年'}</span>}
                <input type="number" min={1} max={31} value={edit.pay_day ?? (edit.first_payment_date ? Number(edit.first_payment_date.slice(8, 10)) : '')} onChange={(e) => setEdit({ ...edit, pay_day: e.target.value ? parseInt(e.target.value) : null })} className="w-14 rounded border border-gray-300 px-1 py-0.5" />
                <span>日</span>
              </div>
              <label className="flex flex-col gap-1">每期租金({CAD_LABEL[edit.cadence]})<input type="number" value={edit.amount_per_period ?? ''} onChange={(e) => setEdit({ ...edit, amount_per_period: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /><span className="text-xs text-gray-500 mt-0.5">對應月租金:${fmt(Math.round((edit.amount_per_period || 0) / (STEP_OF[edit.cadence] || 1)))}</span></label>
              <label className="flex flex-col gap-1">押金<input type="number" value={edit.deposit ?? ''} onChange={(e) => setEdit({ ...edit, deposit: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">租期起<input type="date" value={edit.start_date ?? ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">租期迄<input type="date" value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">入款帳號<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option><option value="8088">8088</option><option value="0564">0564</option><option value="4145">4145</option></select></label>
              <label className="flex items-center gap-2 mt-6"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />啟用中</label>
              <label className="flex items-center gap-2 mt-6" title="釘選後才會出現在上方「本月已收/未收」清單"><input type="checkbox" checked={edit.watch ?? false} onChange={(e) => setEdit({ ...edit, watch: e.target.checked })} />關注收租(釘選)</label>
              <label className="flex flex-col gap-1 col-span-2">顯示名稱(釘選清單顯示,可填人名或自訂;留空則用房源)<input value={edit.display_name ?? ''} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} placeholder={edit.room ?? ''} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1 col-span-2">備註<input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.id && (
                <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                  <div className="text-xs font-semibold text-gray-500 mb-1.5">展延租期(在現有租期之後追加 N 個月;追加後會多出對應 N 期待收款,可多次展延,持續認列營收直到停用)</div>
                  <div className="flex flex-wrap items-end gap-2 text-sm">
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">追加月數
                      <input type="number" min={1} value={ext.months} onChange={(e) => { const m = e.target.value; const mn = parseInt(m) || 0; const mo = parseFloat(ext.monthly) || 0; setExt({ months: m, monthly: ext.monthly, total: mo && mn ? String(mo * mn) : ext.total }); }} className="w-24 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">月租金
                      <input type="number" value={ext.monthly} onChange={(e) => { const v = e.target.value; const mn = parseInt(ext.months) || 0; const mo = parseFloat(v) || 0; setExt({ months: ext.months, monthly: v, total: mn ? String(mo * mn) : '' }); }} className="w-28 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                    <span className="pb-2 text-gray-400">或</span>
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">總共租金
                      <input type="number" value={ext.total} onChange={(e) => { const v = e.target.value; const mn = parseInt(ext.months) || 0; const tt = parseFloat(v) || 0; setExt({ months: ext.months, total: v, monthly: mn ? String(Math.round(tt / mn)) : '' }); }} className="w-32 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                    <button type="button" onClick={doExtend} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark">展延</button>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-1">目前租期迄 {edit.end_date || '—'}・月租金與總共租金擇一輸入,另一個自動換算(月租金 × 月數 = 總共租金)。展延後租期迄自動延後。</div>
                  {extBatches.length > 0 && (
                    <div className="mt-2 border-t border-mor-line/50 pt-2">
                      <div className="text-[11px] text-gray-500 mb-1">已加延展(刪除會連同對應收租一併移除,不需再確認):</div>
                      <div className="space-y-1">
                        {extBatches.map((b, bi) => (
                          <div key={bi} className="flex items-center justify-between text-xs">
                            <span className="text-gray-700"><span className="rounded bg-mor-bluelight text-mor-blue px-1.5 py-0.5 text-[10px] mr-1">延展</span>{fmtYm(b.startYm)}{b.count > 1 ? ` ~ ${fmtYm(b.endYm)}` : ''} · {b.count} 個月 · 月租 ${fmt(b.amount)}</span>
                            <button type="button" onClick={() => delExtBatch(b)} className="text-red-500 underline hover:text-red-700">刪除</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
    </div>
  );
}


const CAD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
function addMonths(d: Date, n: number) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function payScheduleText(cadence: string, fpd: string | null | undefined, payDay?: number | null) {
  const p = fpd ? fpd.split('-').map(Number) : null;
  const m = p ? p[1] : null;
  const d = payDay || (p ? p[2] : null);
  if (!d) return '';
  if (cadence === 'monthly') return `每月 ${d} 日`;
  if (cadence === 'quarterly') return `每三個月 ${d} 日`;
  if (cadence === 'halfyear') return `每半年 ${d} 日`;
  if (cadence === 'yearly' && m) return `每年 ${m} 月 ${d} 日`;
  return '';
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
const nextYm = (ym: string) => { let y = +ym.slice(0, 4), m = +ym.slice(4, 6); m++; if (m > 12) { m = 1; y++; } return `${y}${String(m).padStart(2, '0')}`; };
const fmtYm = (ym: string) => `${+ym.slice(0, 4)}/${+ym.slice(4, 6)}`;

function CollectModal({ contract: c, onClose, supabase }: { contract: any; onClose: () => void; supabase: any }) {
  const [existing, setExisting] = useState<Record<string, any>>({});
  const [endDate, setEndDate] = useState<string | null>(c.end_date ?? null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [dep, setDep] = useState({ received: !!c.deposit_received, receivedAt: c.deposit_received_at || '', returned: !!c.deposit_returned, returnedAt: c.deposit_returned_at || '' });
  const [feeRows, setFeeRows] = useState<any[]>([]);
  const [feeDraft, setFeeDraft] = useState<{ pi: number; date: string; type: string; amount: number } | null>(null);
  const today = () => new Date().toISOString().slice(0, 10);
  const STEP = ({ monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 } as any)[c.cadence] || 1;

  const months = useMemo(() => {
    if (!c.start_date) return [] as { ym: string; y: number; m: number; label: string }[];
    const sd = new Date(c.start_date + 'T00:00:00');
    let ed = endDate ? new Date(endDate + 'T00:00:00') : new Date(sd);
    // 涵蓋任何已產生(展延)的月份
    const exYms = Object.keys(existing).map((k) => k.split('_').pop() || '').filter((x) => /^\d{6}$/.test(x));
    if (exYms.length) { const mx = exYms.sort()[exYms.length - 1]; const my = new Date(Number(mx.slice(0, 4)), Number(mx.slice(4, 6)) - 1, 1); if (my > ed) ed = my; }
    const out: { ym: string; y: number; m: number; label: string }[] = [];
    let cur = new Date(sd.getFullYear(), sd.getMonth(), 1);
    const endFirst = new Date(ed.getFullYear(), ed.getMonth(), 1);
    let g = 0;
    while (cur <= endFirst && g++ < 360) {
      out.push({ ym: `${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`, y: cur.getFullYear(), m: cur.getMonth() + 1, label: `${cur.getFullYear()}/${cur.getMonth() + 1}` });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return out;
  }, [c, existing, endDate]);
  const extYms = useMemo(() => { const set = new Set<string>(); Object.entries(existing).forEach(([k, o]: any) => { if (o?.imported_via === 'extend') set.add(k.split('_').pop()); }); return set; }, [existing]);
  const cadPeriods = useMemo(() => { const base = months.filter((m: any) => !extYms.has(m.ym)); const out: any[] = []; for (let i = 0; i < base.length; i += STEP) out.push(base.slice(i, i + STEP)); return out; }, [months, STEP, extYms]);
  const extPeriods = useMemo(() => months.filter((m: any) => extYms.has(m.ym)).map((m: any) => [m]), [months, extYms]);

  const loadExisting = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('orders').select('order_key, paid, amount, paid_at, imported_via').like('order_key', `LT_${c.room}_%`);
    const m: Record<string, any> = {};
    onlyLtOf(data as any[], c.room).forEach((o: any) => { m[o.order_key] = o; });
    setExisting(m); setLoading(false);
  }, [supabase, c.room]);
  useEffect(() => { loadExisting(); }, [loadExisting]);

  async function updDep(patch: any) {
    const { error } = await supabase.from('contracts').update(patch).eq('id', c.id);
    if (error) { alert('更新失敗:' + error.message); return; }
    Object.assign(c, patch);
    setDep({ received: !!c.deposit_received, receivedAt: c.deposit_received_at || '', returned: !!c.deposit_returned, returnedAt: c.deposit_returned_at || '' });
  }
  async function setPeriodPaid(chunk: any[], v: boolean) {
    setBusy(chunk[0].ym);
    const keys = chunk.map((mm) => `LT_${c.room}_${mm.ym}`);
    const { error } = await supabase.from('orders').update({ paid: v, paid_at: v ? today() : null }).in('order_key', keys);
    if (error) alert('失敗:' + error.message);
    setBusy(''); loadExisting();
  }
  // 「刪除此期起」已移除:它會一次刪掉該期之後的所有月租單(含已收款者)並回推租期迄,
  // 而 UI 是以「期」呈現,實際刪除範圍卻是「該期及之後全部」,兩者不一致極易誤刪。
  // 需要縮短租期請改在編輯視窗調整「租期迄」,由觸發器安全地移除多餘月份
  // (gen_contract_orders 只刪 imported_via='contract' 且 paid=false 的列)。
  async function setPeriodPaidAt(chunk: any[], date: string) {
    const keys = chunk.map((mm) => `LT_${c.room}_${mm.ym}`);
    const { error } = await supabase.from('orders').update({ paid_at: date || null }).in('order_key', keys);
    if (error) alert('失敗:' + error.message);
    loadExisting();
  }
  const loadFees = useCallback(async () => {
    const { data } = await supabase.from('orders').select('id, checkin, amount, fee_type').eq('contract_id', c.id).eq('source', 'oneoff').order('checkin');
    setFeeRows(data ?? []);
  }, [supabase, c.id]);
  useEffect(() => { loadFees(); }, [loadFees]);
  async function saveFee() {
    if (!feeDraft || !feeDraft.amount || !feeDraft.date) { alert('請填費用日期與金額'); return; }
    const { error } = await supabase.from('orders').insert({ order_key: `CFEE_${String(c.id).slice(0, 8)}_${Date.now()}`, source: 'oneoff', contract_id: c.id, estate_id: c.estate_id, property_raw: c.room, guest_name: c.tenant_name, checkin: feeDraft.date, checkout: feeDraft.date, nights: 0, amount: feeDraft.amount, fee_type: feeDraft.type, note: '契約加費', imported_via: 'manual' });
    if (error) { alert('失敗:' + error.message); return; }
    setFeeDraft(null); loadFees();
  }
  async function delFee(id: string) { await supabase.from('orders').delete().eq('id', id); loadFees(); }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-center justify-between">
          <div>
            <div className="font-bold">收款 — {c.room} {c.tenant_name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{TYPE_LABEL[c.type ?? 'longterm']}・{CAD_LABEL[c.cadence]}・每期 ${fmt(c.amount_per_period)}(月 ${fmt(c.monthly_rent)})・首繳 {c.first_payment_date ?? '—'}{payScheduleText(c.cadence, c.first_payment_date, c.pay_day) ? `・繳款 ${payScheduleText(c.cadence, c.first_payment_date, c.pay_day)}` : ''}・租期 {c.start_date} ~ {c.end_date}・應收按月自動認列</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="px-6 py-4">
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 mb-2">押金(暫收帳款,不計入營收)</div>
            <div className={`rounded-xl border px-4 py-3 text-sm ${dep.received && !dep.returned ? 'border-amber-200 bg-amber-50/50' : 'border-mor-line'}`}>
              <div className="flex items-center justify-between">
                <div className="font-medium">押金 ${fmt(c.deposit)}</div>
                {!dep.received
                  ? <button onClick={() => updDep({ deposit_received: true, deposit_received_at: today() })} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark">確認已收</button>
                  : <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-600">已收 <input type="date" value={dep.receivedAt} onChange={(e) => updDep({ deposit_received_at: e.target.value || null })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>
                      {!dep.returned
                        ? <button onClick={() => updDep({ deposit_returned: true, deposit_returned_at: today() })} className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs font-medium hover:bg-mor-slatedark">退回</button>
                        : <span className="text-xs text-gray-600">已退 <input type="date" value={dep.returnedAt} onChange={(e) => updDep({ deposit_returned_at: e.target.value || null })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>}
                    </div>}
              </div>
              {dep.received && <div className="mt-1"><button onClick={() => updDep({ deposit_received: false, deposit_received_at: null, deposit_returned: false, deposit_returned_at: null })} className="text-xs text-gray-400 underline">清除押金狀態</button></div>}
            </div>
          </div>
          <div className="text-xs font-semibold text-gray-500 mb-2">收款({CAD_LABEL[c.cadence]},每期確認)</div>
          {!c.start_date || !c.end_date ? <div className="text-center text-orange-600 py-8 text-sm">此契約缺租期,請先編輯補上起訖日</div>
          : loading ? <div className="text-center text-gray-400 py-8">載入中…</div>
          : <div className="space-y-2">
            {cadPeriods.map((chunk: any[], i: number) => {
              const os = chunk.map((mm) => existing[`LT_${c.room}_${mm.ym}`]).filter(Boolean);
              const amount = os.reduce((a: number, o: any) => a + Number(o.amount || 0), 0);
              const allPaid = os.length > 0 && os.every((o: any) => o.paid);
              const paidAt = os.find((o: any) => o.paid_at)?.paid_at;
              const first = chunk[0], last = chunk[chunk.length - 1];
              const due = c.first_payment_date ? (() => { const base = addMonths(new Date(c.first_payment_date + 'T00:00:00'), i * STEP); const day = c.pay_day || base.getDate(); const dd = new Date(base.getFullYear(), base.getMonth(), day); return `${dd.getFullYear()}/${dd.getMonth() + 1}/${dd.getDate()}`; })() : '';
              const pfees = feeRows.filter((f: any) => f.checkin && chunk.some((mm: any) => (f.checkin.slice(0, 4) + f.checkin.slice(5, 7)) === mm.ym));
              return (
                <div key={i} className={`rounded-xl border px-4 py-2.5 text-sm ${allPaid ? 'border-mor-greenlight bg-mor-greenlight/30' : 'border-mor-line'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium"><span className="text-mor-blue">第 {i + 1} 期</span> <span className="text-gray-700">{first.label}{STEP > 1 ? `~${last.label}` : ''}</span>{due ? <span className="ml-2 text-xs text-gray-400">應繳 {due}</span> : null}</div>
                      <div className="text-xs text-gray-500">應收 ${fmt(amount)}</div>
                    </div>
                    {os.length > 0 && (allPaid
                      ? <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-600">收款日 <input type="date" value={paidAt || ''} onChange={(e) => setPeriodPaidAt(chunk, e.target.value)} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>
                          <button onClick={() => setPeriodPaid(chunk, false)} disabled={!!busy} className="rounded-lg bg-mor-greenlight text-mor-green px-2.5 py-1.5 text-xs font-medium hover:bg-red-50 hover:text-red-600">取消</button>
                        </div>
                      : <button onClick={() => setPeriodPaid(chunk, true)} disabled={!!busy} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark disabled:opacity-40">{busy === first.ym ? '…' : '確認收款'}</button>)}
                  </div>
                  <div className="mt-2 border-t border-mor-line/50 pt-1.5">
                    {pfees.map((f: any) => (
                      <div key={f.id} className="flex items-center justify-between text-xs text-gray-600 py-0.5">
                        <span>· {f.fee_type} ${fmt(f.amount)} <span className="text-gray-400">({f.checkin})</span></span>
                        <button onClick={() => delFee(f.id)} className="text-red-400 underline">刪</button>
                      </div>
                    ))}
                    {feeDraft?.pi === i ? (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        <select value={feeDraft.type} onChange={(e) => setFeeDraft({ ...feeDraft, type: e.target.value })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">{FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                        <input type="number" placeholder="金額" value={feeDraft.amount || ''} onChange={(e) => setFeeDraft({ ...feeDraft, amount: parseFloat(e.target.value) || 0 })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs w-20" />
                        <input type="date" value={feeDraft.date} onChange={(e) => setFeeDraft({ ...feeDraft, date: e.target.value })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" />
                        <button onClick={saveFee} className="rounded bg-mor-slate text-white px-2 py-0.5 text-xs">儲存</button>
                        <button onClick={() => setFeeDraft(null)} className="text-gray-400 underline text-xs">取消</button>
                      </div>
                    ) : <button onClick={() => setFeeDraft({ pi: i, date: `${first.y}-${String(first.m).padStart(2, '0')}-01`, type: '電費', amount: 0 })} className="text-xs text-mor-blue underline">+ 加費(認列營收)</button>}
                  </div>
                </div>
              );
            })}
            {extPeriods.length > 0 && <div className="text-[11px] font-semibold text-mor-blue pt-1 pb-0.5">— 延展期數(每月一期確認)—</div>}
            {extPeriods.map((chunk: any[], j: number) => {
              const mm = chunk[0];
              const o = existing[`LT_${c.room}_${mm.ym}`];
              const amount = Number(o?.amount || 0);
              const paid = !!o?.paid;
              const paidAt = o?.paid_at;
              return (
                <div key={'ext' + j} className={`rounded-xl border px-4 py-2.5 text-sm ${paid ? 'border-mor-greenlight bg-mor-greenlight/30' : 'border-dashed border-mor-blue/40'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium"><span className="rounded bg-mor-bluelight text-mor-blue px-1.5 py-0.5 text-[10px]">延展</span> <span className="text-mor-blue">第 {j + 1} 期</span> <span className="text-gray-700">{mm.label}</span></div>
                      <div className="text-xs text-gray-500">應收 ${fmt(amount)}</div>
                    </div>
                    {o && (paid
                      ? <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-600">收款日 <input type="date" value={paidAt || ''} onChange={(e) => setPeriodPaidAt(chunk, e.target.value)} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>
                          <button onClick={() => setPeriodPaid(chunk, false)} disabled={!!busy} className="rounded-lg bg-mor-greenlight text-mor-green px-2.5 py-1.5 text-xs font-medium hover:bg-red-50 hover:text-red-600">取消</button>
                        </div>
                      : <button onClick={() => setPeriodPaid(chunk, true)} disabled={!!busy} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark disabled:opacity-40">{busy === mm.ym ? '…' : '確認收款'}</button>)}
                  </div>
                </div>
              );
            })}
          </div>}
        </div>
      </div>
    </div>
  );
}