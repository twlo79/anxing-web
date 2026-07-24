'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Contract = {
  id: string; estate_id: string | null; room: string | null; tenant_name: string | null;
  phone: string | null; cadence: string; monthly_rent: number | null; deposit: number | null;
  start_date: string | null; end_date: string | null; pay_day: number | null; first_payment_date: string | null;
  paid: boolean; account: string | null; note: string | null; active: boolean;
};
type Estate = { id: string; name: string; sort: number };

const CAD_LABEL: Record<string, string> = { monthly: '月繳', quarterly: '季繳', halfyear: '半年繳', yearly: '年繳' };
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
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  const [curLT, setCurLT] = useState<Record<string, { amount: number; paid: boolean }>>({});
  const curFirst = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  const curMon = (() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}`; })();

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('contracts').select('*, estates(name)').order('room');
    setRows((data as any) ?? []);
    const { data: lts } = await supabase.from('orders').select('property_raw, amount, paid').eq('source', 'longterm').eq('checkin', curFirst);
    const m: Record<string, { amount: number; paid: boolean }> = {};
    (lts ?? []).forEach((o: any) => { if (o.property_raw) m[o.property_raw] = { amount: Number(o.amount || 0), paid: !!o.paid }; });
    setCurLT(m);
    setLoading(false);
  }, [supabase, curFirst]);
  useEffect(() => {
    supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? []));
    load();
  }, [supabase, load]);
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  const filtered = useMemo(() => {
    let out = estateFilter ? rows.filter((r: any) => r.estates?.name === estateFilter) : rows;
    if (cadFilter) out = out.filter((r) => r.cadence === cadFilter);
    if (fromD || toD) out = out.filter((r) => { const st = r.start_date || '', en = r.end_date || ''; if (toD && st && st > toD) return false; if (fromD && en && en < fromD) return false; return true; });
    if (kw) { const k = kw.toLowerCase(); out = out.filter((r) => `${r.room ?? ''}${r.tenant_name ?? ''}${r.phone ?? ''}${r.note ?? ''}`.toLowerCase().includes(k)); }
    const rk = (x: string) => { const m = String(x || '').match(/^(\d+)/); return [m ? parseInt(m[1]) : 999, String(x || '')] as [number, string]; };
    out = [...out].sort((a: any, b: any) => {
      if (sortMode === 'room') { const ka = rk(a.room), kb = rk(b.room); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); }
      const av = a.start_date || '', bv = b.start_date || '';
      return sortMode === 'date_asc' ? (av > bv ? 1 : av < bv ? -1 : 0) : (av < bv ? 1 : av > bv ? -1 : 0);
    });
    return out;
  }, [rows, estateFilter, cadFilter, fromD, toD, kw, sortMode]);
  const activeCount = useMemo(() => filtered.filter((r) => r.active).length, [filtered]);
  const monthAR = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.room ?? '']?.amount ?? 0), 0), [filtered, curLT]);
  const monthPaid = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.room ?? '']?.paid ? (curLT[r.room ?? ''].amount) : 0), 0), [filtered, curLT]);
  const roomLists = useMemo(() => {
    const rk = (x: string) => { const m = String(x || '').match(/^(\d+)/); return [m ? parseInt(m[1]) : 999, String(x || '')] as [number, string]; };
    const cmp = (a: string, b: string) => { const ka = rk(a), kb = rk(b); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); };
    const paid: string[] = [], unpaid: string[] = [];
    filtered.filter((r) => r.active).forEach((r) => { const lt = curLT[r.room ?? '']; if (!lt) return; (lt.paid ? paid : unpaid).push(r.room ?? ''); });
    return { paid: paid.sort(cmp), unpaid: unpaid.sort(cmp) };
  }, [filtered, curLT]);

  async function togglePaid(c: Contract) {
    const { error } = await supabase.from('contracts').update({ paid: !c.paid }).eq('id', c.id);
    if (error) return flash('更新失敗:' + error.message);
    setRows((rs) => rs.map((r) => r.id === c.id ? { ...r, paid: !c.paid } : r));
  }
  async function save() {
    if (!edit) return;
    const payload = {
      estate_id: edit.estate_id, room: edit.room, tenant_name: edit.tenant_name, phone: edit.phone,
      cadence: edit.cadence, monthly_rent: edit.monthly_rent, deposit: edit.deposit,
      start_date: edit.start_date || null, end_date: edit.end_date || null, first_payment_date: edit.first_payment_date || null, pay_day: null,
      account: edit.account, note: edit.note, active: edit.active, name: `${edit.tenant_name ?? ''}-${edit.room ?? ''}`,
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
  function blank(): Contract {
    return { id: '', estate_id: estates.find((e) => e.name === '正隆')?.id ?? null, room: '', tenant_name: '', phone: '', cadence: 'monthly', monthly_rent: 0, deposit: 0, start_date: '', end_date: '', pay_day: null, first_payment_date: '', paid: false, account: null, note: '', active: true };
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
          <div className="text-xs text-gray-500 mb-1.5">本月({curMon}) 已收房源 <span className="text-mor-green font-medium">{roomLists.paid.length}</span></div>
          <div className="flex flex-wrap gap-1">{roomLists.paid.map((rm) => <span key={rm} className="inline-block rounded-md bg-mor-greenlight/50 text-mor-green px-1.5 py-0.5 text-xs">{rm}</span>)}{!roomLists.paid.length && <span className="text-xs text-gray-300">—</span>}</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-3">
          <div className="text-xs text-gray-500 mb-1.5">本月({curMon}) 未收房源 <span className="text-orange-600 font-medium">{roomLists.unpaid.length}</span></div>
          <div className="flex flex-wrap gap-1">{roomLists.unpaid.map((rm) => <span key={rm} className="inline-block rounded-md bg-orange-50 text-orange-600 px-1.5 py-0.5 text-xs">{rm}</span>)}{!roomLists.unpaid.length && <span className="text-xs text-gray-300">—</span>}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <select value={estateFilter} onChange={(e) => setEstateFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
          <option value="">全部物業</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
        </select>
        <select value={cadFilter} onChange={(e) => setCadFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">全部繳別</option><option value="monthly">月繳</option><option value="quarterly">季繳</option><option value="halfyear">半年繳</option><option value="yearly">年繳</option></select>
        <div className="flex items-center gap-1" title="依租期(起訖)篩選">
          <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          <span className="text-gray-400">~</span>
          <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          {(fromD || toD) && <button onClick={() => { setFromD(''); setToD(''); }} className="text-gray-400 underline text-xs">清除</button>}
        </div>
        <select value={sortMode} onChange={(e) => setSortMode(e.target.value as any)} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="room">房源</option><option value="date_desc">日期新→舊</option><option value="date_asc">日期舊→新</option></select>
        <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜尋 房源/租戶/電話" className="rounded-lg border border-gray-300 px-2 py-1.5 w-44" />
        {kw && <button onClick={() => setKw('')} className="text-gray-400 underline text-xs">清除</button>}
        {(estateFilter || cadFilter || fromD || toD || kw) && <button onClick={() => { setEstateFilter(''); setCadFilter(''); setFromD(''); setToD(''); setKw(''); }} className="text-gray-500 underline text-xs">全部清除</button>}
        <div className="text-xs text-gray-400">共 {filtered.length} 筆</div>
        <button onClick={() => setEdit(blank())} className="ml-auto rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增契約</button>
      </div>

      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <th className="px-3 py-2.5">房源</th><th className="px-3 py-2.5">租戶</th><th className="px-3 py-2.5">繳別</th>
              <th className="px-3 py-2.5 text-right">月租金</th><th className="px-3 py-2.5 text-right">押金</th>
              <th className="px-3 py-2.5 whitespace-nowrap">租期</th><th className="px-3 py-2.5">收租</th><th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">尚無契約</td></tr>
            : filtered.map((c: any) => (
              <tr key={c.id} className={`border-b border-mor-line/60 hover:bg-mor-bluelight/30 ${c.active ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{c.room}<span className="ml-1 text-xs text-gray-400">{c.estates?.name}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{c.tenant_name}</td>
                <td className="px-3 py-2 whitespace-nowrap">{CAD_LABEL[c.cadence] ?? c.cadence}</td>
                <td className="px-3 py-2 text-right">${fmt(c.monthly_rent)}</td>
                <td className="px-3 py-2 text-right text-gray-500">${fmt(c.deposit)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{c.start_date ?? '—'} ~ {c.end_date ?? '—'}</td>
                <td className="px-3 py-2">
                  <button onClick={() => togglePaid(c)} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.paid ? 'bg-mor-greenlight text-mor-green' : 'bg-orange-50 text-orange-600'}`}>
                    {c.paid ? '已收租' : '未收租'}
                  </button>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
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
              <label className="flex flex-col gap-1">第一次繳款日<input type="date" value={edit.first_payment_date ?? ''} onChange={(e) => setEdit({ ...edit, first_payment_date: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">月租金<input type="number" value={edit.monthly_rent ?? ''} onChange={(e) => setEdit({ ...edit, monthly_rent: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">押金<input type="number" value={edit.deposit ?? ''} onChange={(e) => setEdit({ ...edit, deposit: e.target.value ? parseFloat(e.target.value) : 0 })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">租期起<input type="date" value={edit.start_date ?? ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">租期迄<input type="date" value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">入款帳號<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option><option value="8088">8088</option><option value="0564">0564</option><option value="4145">4145</option></select></label>
              <label className="flex items-center gap-2 mt-6"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />啟用中</label>
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


const CAD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
function addMonths(d: Date, n: number) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

function CollectModal({ contract: c, onClose, supabase }: { contract: any; onClose: () => void; supabase: any }) {
  const [existing, setExisting] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [dep, setDep] = useState({ received: !!c.deposit_received, receivedAt: c.deposit_received_at || '', returned: !!c.deposit_returned, returnedAt: c.deposit_returned_at || '' });
  const [feeRows, setFeeRows] = useState<any[]>([]);
  const [feeDraft, setFeeDraft] = useState<{ pi: number; date: string; type: string; amount: number } | null>(null);
  const today = () => new Date().toISOString().slice(0, 10);
  const STEP = ({ monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 } as any)[c.cadence] || 1;

  const months = useMemo(() => {
    if (!c.start_date || !c.end_date) return [] as { ym: string; y: number; m: number; label: string }[];
    const sd = new Date(c.start_date + 'T00:00:00'), ed = new Date(c.end_date + 'T00:00:00');
    const out: { ym: string; y: number; m: number; label: string }[] = [];
    let cur = new Date(sd.getFullYear(), sd.getMonth(), 1);
    const endFirst = new Date(ed.getFullYear(), ed.getMonth(), 1);
    let g = 0;
    while (cur <= endFirst && g++ < 120) {
      out.push({ ym: `${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`, y: cur.getFullYear(), m: cur.getMonth() + 1, label: `${cur.getFullYear()}/${cur.getMonth() + 1}` });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return out;
  }, [c]);
  const cadPeriods = useMemo(() => { const out: any[] = []; for (let i = 0; i < months.length; i += STEP) out.push(months.slice(i, i + STEP)); return out; }, [months, STEP]);

  const loadExisting = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('orders').select('order_key, paid, amount, paid_at').like('order_key', `LT_${c.room}_%`);
    const m: Record<string, any> = {};
    (data ?? []).forEach((o: any) => { m[o.order_key] = o; });
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
            <div className="text-xs text-gray-500 mt-0.5">{CAD_LABEL[c.cadence]}・月租 ${fmt(c.monthly_rent)}・首繳 {c.first_payment_date ?? '—'}・租期 {c.start_date} ~ {c.end_date}・應收按月自動認列</div>
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
              const due = c.first_payment_date ? (() => { const dd = addMonths(new Date(c.first_payment_date + 'T00:00:00'), i * STEP); dd.setDate(dd.getDate() - 1); return `${dd.getFullYear()}/${dd.getMonth() + 1}/${dd.getDate()}`; })() : '';
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
          </div>}
        </div>
      </div>
    </div>
  );
}