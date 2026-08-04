'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';

/**
 * 押金管理。
 *
 * 金額不在這裡改 —— 那是契約條件的一部分,來源在 orders / contracts,
 * 由觸發器同步過來(migration_56)。這一頁只管「錢什麼時候收、什麼時候退、走哪個帳戶」。
 *
 * 暫收 = 有 received_on 且沒有 returned_on。
 */

type Dep = {
  id: string;
  order_id: string | null; contract_id: string | null;
  estate_id: string | null; property_id: string | null;
  room: string | null; guest_name: string | null;
  currency: string; amount: number;
  received_on: string | null; received_method: string | null; received_account: string | null;
  returned_on: string | null; returned_method: string | null; returned_account: string | null;
  note: string | null; orphaned: boolean; is_manual?: boolean; created_at: string;
};
type Estate = { id: string; name: string };
type PayAccount = { code: string; name: string; method: string };

const METHOD_LABEL: Record<string, string> = {
  cash: '現金', transfer: '匯款', credit_card: '信用卡', crypto: '加密貨幣',
};
const METHOD_OPTS = ['cash', 'transfer', 'credit_card', 'crypto'];

const fmt = (n: number | null) => (n == null ? '0' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

const COLS: SortCols<Dep> = {
  room: { type: 'text', get: (d) => d.room },
  guest_name: { type: 'text', get: (d) => d.guest_name },
  amount: { type: 'number', get: (d) => d.amount },
  received_on: { type: 'date', get: (d) => d.received_on },
  returned_on: { type: 'date', get: (d) => d.returned_on },
};

export default function DepositsPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Dep[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // 篩選
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [estateF, setEstateF] = useState('');
  const [roomF, setRoomF] = useState('');
  const [methodF, setMethodF] = useState('');
  const [acctF, setAcctF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');

  const [sort, setSort] = useState<SortState>({ key: 'received_on', dir: 'desc' });
  const [detail, setDetail] = useState<Dep | null>(null);
  const [edit, setEdit] = useState<Dep | null>(null);
  const [saving, setSaving] = useState(false);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('deposits').select('*').limit(5000);
    setRows((data ?? []) as Dep[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name')
      .then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method').eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
  }, [load, supabase]);

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);
  const rooms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.room).filter(Boolean) as string[])).sort(),
    [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    // 日期區間比對收押金日;還沒收的單子在有設區間時不顯示 ——
    // 「這段期間收了哪些押金」不該混進還沒發生的
    if (fromD || toD) {
      if (!r.received_on) return false;
      if (fromD && r.received_on < fromD) return false;
      if (toD && r.received_on > toD) return false;
    }
    if (estateF && r.estate_id !== estateF) return false;
    if (roomF && r.room !== roomF) return false;
    if (methodF && r.received_method !== methodF) return false;
    if (acctF && r.received_account !== acctF) return false;
    if (statusF === 'held' && !(r.received_on && !r.returned_on)) return false;
    if (statusF === 'pending' && r.received_on) return false;
    if (statusF === 'returned' && !r.returned_on) return false;
    if (statusF === 'orphan' && !r.orphaned) return false;
    if (kw) {
      const hay = `${r.room ?? ''} ${r.guest_name ?? ''} ${r.note ?? ''}`.toLowerCase();
      if (!hay.includes(kw.toLowerCase())) return false;
    }
    return true;
  }), [rows, fromD, toD, estateF, roomF, methodF, acctF, statusF, kw]);

  const sorted = useMemo(() => sortRows(filtered, sort, COLS), [filtered, sort]);

  // 暫收 = 收了還沒退。依幣別分開,外幣原幣退還不換匯,加總沒有意義。
  const held = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) {
      if (r.received_on && !r.returned_on) m[r.currency] = (m[r.currency] ?? 0) + Number(r.amount || 0);
    }
    return m;
  }, [filtered]);

  const counts = useMemo(() => ({
    held: filtered.filter((r) => r.received_on && !r.returned_on).length,
    pending: filtered.filter((r) => !r.received_on).length,
    returned: filtered.filter((r) => r.returned_on).length,
    orphan: filtered.filter((r) => r.orphaned).length,
  }), [filtered]);

  /** 手動押金:不掛在任何訂單/契約下,金額與房源姓名可以直接填 */
  function blankManual(): Dep {
    return {
      id: '', order_id: null, contract_id: null, estate_id: null, property_id: null,
      room: '', guest_name: '', currency: 'TWD', amount: 0,
      received_on: null, received_method: null, received_account: null,
      returned_on: null, returned_method: null, returned_account: null,
      note: null, orphaned: false, is_manual: true, created_at: '',
    };
  }

  async function save() {
    if (!edit) return;
    if (edit.returned_on && !edit.received_on) return flash('還沒收到押金,不能填退款日');
    const manual = !!edit.is_manual;
    if (manual) {
      if (!(Number(edit.amount) > 0)) return flash('請填押金金額');
      if (!edit.room?.trim() && !edit.guest_name?.trim()) return flash('房源與姓名至少要填一個');
    }
    setSaving(true);
    const payload: any = {
      received_on: edit.received_on || null,
      received_method: edit.received_on ? (edit.received_method || null) : null,
      // 現金沒有帳戶可言。換了方式要把舊帳號清掉,否則會留下「現金 + 元大8088」這種組合。
      received_account: edit.received_on && edit.received_method !== 'cash' ? (edit.received_account || null) : null,
      returned_on: edit.returned_on || null,
      returned_method: edit.returned_on ? (edit.returned_method || null) : null,
      returned_account: edit.returned_on && edit.returned_method !== 'cash' ? (edit.returned_account || null) : null,
      note: edit.note || null,
    };
    // 連動列的這幾欄是來源的快照,改了下次同步就被蓋回去,所以只有手動列能改
    if (manual) {
      Object.assign(payload, {
        is_manual: true,
        estate_id: edit.estate_id || null,
        room: edit.room?.trim() || null,
        guest_name: edit.guest_name?.trim() || null,
        currency: edit.currency || 'TWD',
        amount: Number(edit.amount) || 0,
      });
    }
    const { error } = edit.id
      ? await supabase.from('deposits').update(payload).eq('id', edit.id)
      : await supabase.from('deposits').insert(payload);
    setSaving(false);
    if (error) return flash('儲存失敗:' + error.message);
    setEdit(null); flash('已儲存'); load();
  }

  async function del(d: Dep) {
    if (!confirm(`刪除這筆押金紀錄（${d.room ?? ''} ${d.guest_name ?? ''}）?`)) return;
    const { error } = await supabase.from('deposits').delete().eq('id', d.id);
    if (error) return flash('刪除失敗:' + error.message);
    setEdit(null); setDetail(null); flash('已刪除'); load();
  }

  function exportXlsx() {
    const head = ['物業', '房源', '姓名', '幣別', '押金', '收押金日', '入款方式', '入款帳號',
      '退押金日', '退款方式', '退款帳號', '狀態', '備註'];
    const body = sorted.map((r) => [
      r.estate_id ? estateName[r.estate_id] ?? '' : '', r.room ?? '', r.guest_name ?? '',
      r.currency, Math.round(Number(r.amount) || 0),
      r.received_on ?? '', r.received_method ? METHOD_LABEL[r.received_method] ?? '' : '',
      r.received_account ? acctName[r.received_account] ?? r.received_account : '',
      r.returned_on ?? '', r.returned_method ? METHOD_LABEL[r.returned_method] ?? '' : '',
      r.returned_account ? acctName[r.returned_account] ?? r.returned_account : '',
      r.orphaned ? '孤兒' : r.returned_on ? '已退' : r.received_on ? '暫收中' : '尚未收',
      r.note ?? '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '押金');
    XLSX.writeFile(wb, `押金_${todayStr().replace(/-/g, '')}.xlsx`);
  }

  const statusChip = (r: Dep) => {
    if (r.orphaned) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-red-50 text-red-600">孤兒</span>;
    if (r.returned_on) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">已退</span>;
    if (r.received_on) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-mor-bluelight text-mor-slate">暫收中</span>;
    return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-600">尚未收</span>;
  };

  const inp = 'rounded-lg border border-gray-300 px-2 py-1.5';

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-sm">{msg}</div>}

      {/* 卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div className="rounded-xl bg-mor-slate text-white p-5 min-w-0">
          <div className="text-xs opacity-80">暫收款(已收未退)</div>
          <div className="stat-num-lg font-bold mt-1">
            NT$ {fmt(held['TWD'] ?? 0)}
          </div>
          <div className="text-xs opacity-90 mt-1">
            {Object.entries(held).filter(([c]) => c !== 'TWD').map(([c, v]) => (
              <span key={c} className="mr-2">{c} {fmt(v)}</span>
            ))}
            <span className="opacity-70">共 {counts.held} 筆</span>
          </div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-5 min-w-0">
          <div className="text-xs text-gray-500">尚未收款</div>
          <div className="stat-num font-bold mt-1 text-amber-600">{counts.pending} 筆</div>
          <div className="text-xs text-gray-400 mt-1">已填押金但還沒收到錢</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-5 min-w-0">
          <div className="text-xs text-gray-500">已退還 / 孤兒</div>
          <div className="stat-num font-bold mt-1">{counts.returned} <span className="text-sm font-normal text-gray-400">筆</span>
            {counts.orphan > 0 && <span className="text-red-600 text-sm ml-2">孤兒 {counts.orphan}</span>}
          </div>
          <div className="text-xs text-gray-400 mt-1">孤兒 = 來源已刪除但錢還在</div>
        </div>
      </div>

      {/* 篩選 */}
      <div className="filter-bar bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收押金日</span>
          <div className="flex items-center gap-1">
            <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className={inp} />
            <span className="text-gray-400">~</span>
            <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className={inp} />
          </div></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={`${inp} min-w-24`}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源</span>
          <select value={roomF} onChange={(e) => setRoomF(e.target.value)} className={`${inp} min-w-24 max-w-40`}>
            <option value="">全部</option>
            {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款方式</span>
          <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className={inp}>
            <option value="">全部</option>
            {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款帳號</span>
          <select value={acctF} onChange={(e) => setAcctF(e.target.value)} className={`${inp} min-w-28`}>
            <option value="">全部</option>
            {payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className={inp}>
            <option value="">全部</option>
            <option value="held">暫收中</option>
            <option value="pending">尚未收</option>
            <option value="returned">已退</option>
            <option value="orphan">孤兒</option>
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字(房源/姓名/備註)</span>
          <div className="flex items-center gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="搜尋" className={`${inp} w-28`} />
            <button onClick={() => setKw(kwInput.trim())}
              className="rounded-lg bg-mor-slate text-white px-3 py-1.5 hover:bg-mor-slatedark">搜尋</button>
          </div></label>
        <div className="ml-auto flex gap-2">
          <button onClick={() => { setFromD(''); setToD(''); setEstateF(''); setRoomF(''); setMethodF(''); setAcctF(''); setStatusF(''); setKwInput(''); setKw(''); }}
            className="rounded-lg border border-gray-300 px-3 py-1.5">清除</button>
          <button onClick={() => setEdit(blankManual())}
            className="rounded-lg border border-mor-slate text-mor-slate px-3 py-1.5 font-medium hover:bg-mor-sand/60">+ 手動新增</button>
          <button onClick={exportXlsx} disabled={!sorted.length}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
        </div>
      </div>

      {/* 手機卡片 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="text-center text-gray-400 py-10">載入中…</div>
        : sorted.length === 0 ? <div className="text-center text-gray-400 py-10">無押金紀錄</div>
        : sorted.map((r) => (
          <div key={r.id} onClick={() => setDetail(r)}
            className="rounded-xl border border-mor-line bg-white p-4 active:bg-mor-sand/40">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium truncate">{r.room ?? '—'}</div>
                <div className="text-xs text-gray-500 truncate">{r.guest_name ?? '—'}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="stat-num font-bold">{r.currency === 'TWD' ? 'NT$' : r.currency} {fmt(r.amount)}</div>
                <div className="mt-1">{statusChip(r)}</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              收 {r.received_on ?? '—'}
              {r.returned_on ? `・退 ${r.returned_on}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 桌機表格 */}
      <div className="hidden md:block rounded-xl border border-mor-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
              <th className="px-3 py-2.5">物業</th>
              <SortTh label="房源" sortKey="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="姓名" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="押金" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="收押金日" sortKey="received_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">入款方式</th>
              <SortTh label="退押金日" sortKey="returned_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">退款方式</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400">無押金紀錄</td></tr>
            : sorted.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 last:border-0 hover:bg-mor-sand/30">
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.estate_id ? estateName[r.estate_id] ?? '—' : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium">
                  {r.room ?? '—'}
                  {r.is_manual && <span className="ml-1 text-[10px] text-gray-400">手動</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.guest_name ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.currency !== 'TWD' && <span className="text-xs text-gray-400 mr-1">{r.currency}</span>}
                  {fmt(r.amount)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.received_on ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {r.received_method ? METHOD_LABEL[r.received_method] ?? r.received_method : '—'}
                  {r.received_account && <div className="text-gray-400">{acctName[r.received_account] ?? r.received_account}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.returned_on ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {r.returned_method ? METHOD_LABEL[r.returned_method] ?? r.returned_method : '—'}
                  {r.returned_account && <div className="text-gray-400">{acctName[r.returned_account] ?? r.returned_account}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{statusChip(r)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => setDetail(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">檢視</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 詳細抽屜 */}
      {detail && (() => {
        const d = detail;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold">{d.room ?? '—'}・{d.guest_name ?? '—'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {d.is_manual ? '手動建立' : d.contract_id ? '契約押金' : '短租押金'}
                    {d.orphaned && <span className="text-red-600 ml-1">・來源已刪除</span>}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('狀態', statusChip(d))}
                {row('物業', d.estate_id ? estateName[d.estate_id] ?? '—' : '—')}
                {row('押金', <span className="font-bold">{d.currency === 'TWD' ? 'NT$' : d.currency} {fmt(d.amount)}</span>)}
                {row('收押金日', d.received_on ?? '—')}
                {row('入款方式', d.received_method
                  ? `${METHOD_LABEL[d.received_method] ?? d.received_method}${d.received_account ? `・${acctName[d.received_account] ?? d.received_account}` : ''}`
                  : '—')}
                {row('退押金日', d.returned_on ?? '—')}
                {row('退款方式', d.returned_method
                  ? `${METHOD_LABEL[d.returned_method] ?? d.returned_method}${d.returned_account ? `・${acctName[d.returned_account] ?? d.returned_account}` : ''}`
                  : '—')}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}

                {!d.is_manual && (
                  <div className="mt-3 rounded-lg bg-mor-sand/60 text-gray-500 px-3 py-2 text-xs">
                    押金金額不在這裡改 —— 那是契約條件的一部分,請到
                    {d.contract_id ? '契約' : '短租訂單'}頁修改,這裡會自動同步。
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setEdit({ ...d }); setDetail(null); }}
                  className="flex-1 h-11 rounded-lg bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark">管理押金</button>
                <button onClick={() => setDetail(null)}
                  className="flex-1 h-11 rounded-lg border border-gray-300 text-sm">關閉</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 管理押金 */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50"
          onClick={() => setEdit(null)}>
          <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between z-10"
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              {edit.id ? `管理押金・${edit.room ?? '—'}` : '手動新增押金'}
              <button onClick={() => setEdit(null)} aria-label="關閉"
                className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="p-4 md:p-6 space-y-4 text-sm">
              {edit.is_manual ? (
                /* 手動列沒有來源可同步,這幾欄就在這裡填 */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {!edit.id && (
                    <div className="md:col-span-2 rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs">
                      手動押金不掛在任何訂單或契約下,適合舊約押金、代收、還沒開單就先收的訂金。
                    </div>
                  )}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
                    <select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                      <option value="">未指定</option>
                      {estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源</span>
                    <input value={edit.room ?? ''} onChange={(e) => setEdit({ ...edit, room: e.target.value })}
                      placeholder="例:14B5"
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">姓名</span>
                    <input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <div className="flex gap-2">
                    <label className="flex flex-col gap-1 w-24"><span className="text-xs text-gray-500">幣別</span>
                      <select value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                        {['TWD', 'USD', 'JPY', 'CNY', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></label>
                    <label className="flex flex-col gap-1 flex-1 min-w-0"><span className="text-xs text-gray-500">押金金額 *</span>
                      <input type="number" min="0" value={edit.amount || ''}
                        onChange={(e) => setEdit({ ...edit, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-right" /></label>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
                  {edit.guest_name ?? '—'}・押金 <span className="font-bold">{edit.currency === 'TWD' ? 'NT$' : edit.currency} {fmt(edit.amount)}</span>
                  <span className="text-gray-400 ml-1">(金額請到來源頁修改)</span>
                </div>
              )}

              <div className="border-t border-mor-line pt-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">收押金</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收押金日</span>
                    <input type="date" value={edit.received_on ?? ''}
                      onChange={(e) => setEdit({ ...edit, received_on: e.target.value || null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款方式</span>
                    <select value={edit.received_method ?? ''} disabled={!edit.received_on}
                      onChange={(e) => setEdit({ ...edit, received_method: e.target.value || null, received_account: null })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-100">
                      <option value="">請選擇</option>
                      {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                    </select></label>
                  {/* 現金沒有帳戶可言 */}
                  {edit.received_method && edit.received_method !== 'cash' && (
                    <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-gray-500">入款帳號</span>
                      <select value={edit.received_account ?? ''}
                        onChange={(e) => setEdit({ ...edit, received_account: e.target.value || null })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                        <option value="">未指定</option>
                        {payAccounts.filter((a) => a.method === edit.received_method)
                          .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                      </select></label>
                  )}
                </div>
                {!edit.received_on && (
                  <button onClick={() => setEdit({ ...edit, received_on: todayStr() })}
                    className="mt-2 text-xs text-mor-blue underline">填入今天</button>
                )}
              </div>

              <div className="border-t border-mor-line pt-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">退押金</div>
                {!edit.received_on ? (
                  <div className="text-xs text-gray-400">還沒收到押金,先填收款資訊。</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">退押金日</span>
                        <input type="date" value={edit.returned_on ?? ''}
                          onChange={(e) => setEdit({ ...edit, returned_on: e.target.value || null })}
                          className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">退款方式</span>
                        <select value={edit.returned_method ?? ''} disabled={!edit.returned_on}
                          onChange={(e) => setEdit({ ...edit, returned_method: e.target.value || null, returned_account: null })}
                          className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-100">
                          <option value="">請選擇</option>
                          {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                        </select></label>
                      {edit.returned_method && edit.returned_method !== 'cash' && (
                        <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-gray-500">退款帳號</span>
                          <select value={edit.returned_account ?? ''}
                            onChange={(e) => setEdit({ ...edit, returned_account: e.target.value || null })}
                            className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                            <option value="">未指定</option>
                            {payAccounts.filter((a) => a.method === edit.returned_method)
                              .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                          </select></label>
                      )}
                    </div>
                    {!edit.returned_on && (
                      <button onClick={() => setEdit({ ...edit, returned_on: todayStr() })}
                        className="mt-2 text-xs text-mor-blue underline">填入今天</button>
                    )}
                    {edit.currency !== 'TWD' && (
                      <p className="text-xs text-gray-400 mt-2">外幣押金原幣退還,不換匯。</p>
                    )}
                  </>
                )}
              </div>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                <textarea value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  className="bg-white rounded-lg border border-mor-line px-2 py-2 h-24 md:h-16" /></label>
            </div>

            <div className="sticky bottom-0 md:static bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex gap-2 md:justify-end"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              {/* 連動列不能刪 —— 刪了下次來源同步又會長回來,只會讓人以為壞掉 */}
              {edit.id && (edit.is_manual || edit.orphaned) && (
                <button onClick={() => del(edit)}
                  className="h-12 md:h-auto rounded-lg border border-red-300 text-red-600 px-4 md:py-1.5 text-sm">刪除</button>
              )}
              <button onClick={() => setEdit(null)}
                className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={saving}
                className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {saving ? '儲存中…' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
