'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

type Contract = {
  id: string; estate_id: string | null; room: string | null; tenant_name: string | null;
  phone: string | null; cadence: string; monthly_rent: number | null; deposit: number | null;
  start_date: string | null; end_date: string | null; pay_day: number | null;
  paid: boolean; account: string | null; note: string | null; active: boolean;
};
type Estate = { id: string; name: string; sort: number };

const CAD_LABEL: Record<string, string> = { monthly: '月繳', quarterly: '季繳', halfyear: '半年繳', yearly: '年繳' };
const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString());

export default function ContractsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [estateFilter, setEstateFilter] = useState('');
  const [edit, setEdit] = useState<Contract | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('contracts').select('*, estates(name)').order('room');
    setRows((data as any) ?? []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => {
    supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    load();
  }, [supabase, load]);
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  const filtered = useMemo(() => estateFilter ? rows.filter((r: any) => r.estates?.name === estateFilter) : rows, [rows, estateFilter]);
  const totalRent = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (Number(r.monthly_rent) || 0), 0), [filtered]);
  const paidCount = useMemo(() => filtered.filter((r) => r.active && r.paid).length, [filtered]);
  const activeCount = useMemo(() => filtered.filter((r) => r.active).length, [filtered]);

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
      start_date: edit.start_date || null, end_date: edit.end_date || null, pay_day: edit.pay_day,
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
    return { id: '', estate_id: estates.find((e) => e.name === '正隆')?.id ?? null, room: '', tenant_name: '', phone: '', cadence: 'monthly', monthly_rent: 0, deposit: 0, start_date: '', end_date: '', pay_day: null, paid: false, account: null, note: '', active: true };
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">長租契約管理</h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="rounded-xl bg-mor-slate text-white p-4"><div className="text-xs opacity-75">契約數(啟用)</div><div className="text-2xl font-bold mt-1">{activeCount}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">月租金合計</div><div className="text-2xl font-bold mt-1">${fmt(totalRent)}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">本期已收租</div><div className="text-2xl font-bold mt-1 text-mor-green">{paidCount}</div></div>
        <div className="rounded-xl bg-white border border-mor-line p-4"><div className="text-xs text-gray-500">未收租</div><div className="text-2xl font-bold mt-1 text-orange-600">{activeCount - paidCount}</div></div>
      </div>

      <div className="flex items-center gap-3 mb-3 text-sm">
        <select value={estateFilter} onChange={(e) => setEstateFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
          <option value="">全部物業</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
        </select>
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
                  <button onClick={() => setEdit(c)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                  <button onClick={() => del(c)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              {edit.id ? '編輯契約' : '新增契約'}
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-4 grid grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">物業<select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}</select></label>
              <label className="flex flex-col gap-1">房源<input value={edit.room ?? ''} onChange={(e) => setEdit({ ...edit, room: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">租戶<input value={edit.tenant_name ?? ''} onChange={(e) => setEdit({ ...edit, tenant_name: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">電話<input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">繳別<select value={edit.cadence} onChange={(e) => setEdit({ ...edit, cadence: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="monthly">月繳</option><option value="quarterly">季繳</option><option value="halfyear">半年繳</option><option value="yearly">年繳</option></select></label>
              <label className="flex flex-col gap-1">每月幾號繳<input type="number" value={edit.pay_day ?? ''} onChange={(e) => setEdit({ ...edit, pay_day: e.target.value ? parseInt(e.target.value) : null })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
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
