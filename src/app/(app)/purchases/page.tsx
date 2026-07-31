'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';

type Item = {
  id?: string; request_id?: string; item_name: string; amount: number;
  account_code: string | null; purpose_type: string; property_id: string | null;
  note: string | null; sort: number;
};
type Req = {
  id: string; req_no: string; requester_id: string; status: string; total_amount: number;
  payment_method: string | null; payee_bank_code: string | null; payee_account: string | null;
  payee_company: string | null; payee_tax_id: string | null; note: string | null;
  submitted_at: string | null;
  manager_approved_by: string | null; manager_approved_at: string | null;
  admin_approved_by: string | null; admin_approved_at: string | null;
  rejected_by: string | null; rejected_at: string | null; reject_reason: string | null;
  purchased_on: string | null; expense_generated_at: string | null; created_at: string;
  purchase_request_items?: Item[];
};
type AccountCode = { code: string; name: string };
type Property = { id: string; name: string };
type Profile = { id: string; name: string; role: string };

const FREE_THRESHOLD = 3000;   // 與 migration 的 pr_apply_status() 一致
const PAY_LABEL: Record<string, string> = { cash: '現金', transfer: '匯款', credit_card: '信用卡' };
const PAY_OPTS = ['cash', 'transfer', 'credit_card'];
const ST_LABEL: Record<string, string> = { draft: '草稿', pending: '待核可', approved: '已核可', rejected: '已駁回' };
const ST_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-mor-greenlight text-mor-green', rejected: 'bg-red-50 text-red-600',
};
const fmt = (n: number | null | undefined) => (n == null ? '' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function PurchasesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [rows, setRows] = useState<Req[]>([]);
  const [codes, setCodes] = useState<AccountCode[]>([]);
  const [props, setProps] = useState<Property[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const [edit, setEdit] = useState<Req | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [rejecting, setRejecting] = useState<Req | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [dating, setDating] = useState<Req | null>(null);
  const [dateVal, setDateVal] = useState('');

  const [stF, setStF] = useState('');
  const [reqF, setReqF] = useState('');
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'created_at', dir: 'desc' });

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setMe({ id: user.id, role: data?.role ?? 'housekeeper' });
    })();
    supabase.from('account_codes').select('code, name').order('sort').then(({ data }) => setCodes(data ?? []));
    supabase.from('properties').select('id, name').order('name').then(({ data }) => setProps(data ?? []));
    supabase.from('profiles').select('id, name, role').then(({ data }) => setPeople(data ?? []));
  }, [supabase]);

  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const propName = useMemo(() => Object.fromEntries(props.map((p) => [p.id, p.name])), [props]);
  const personName = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);

  const role = me?.role ?? '';
  const isManager = role === 'manager';
  const isAdmin = role === 'super_admin';
  const isAccountant = role === 'accountant';
  const canSeeAll = isManager || isAdmin || isAccountant;
  // 採購日:主管、Super Admin、會計都能填。會計不能核可,但能填採購日。
  const canSetDate = isManager || isAdmin || isAccountant;

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('purchase_requests')
      .select('*, purchase_request_items(*)')
      .order('created_at', { ascending: false });
    if (stF) q = q.eq('status', stF);
    if (reqF) q = q.eq('requester_id', reqF);
    if (fromD) q = q.gte('created_at', fromD);
    if (toD) q = q.lte('created_at', toD + 'T23:59:59');
    const { data, error } = await q;
    if (error) flash('載入失敗:' + error.message);
    setRows((data as Req[]) ?? []);
    setLoading(false);
  }, [supabase, stF, reqF, fromD, toD]);
  useEffect(() => { load(); }, [load]);

  const SORT_COLS: SortCols<Req> = useMemo(() => ({
    req_no:       { type: 'text',   get: (r) => r.req_no },
    created_at:   { type: 'date',   get: (r) => r.created_at },
    total_amount: { type: 'number', get: (r) => r.total_amount },
    purchased_on: { type: 'date',   get: (r) => r.purchased_on },
    status:       { type: 'text',   get: (r) => ST_LABEL[r.status] ?? r.status },
  }), []);
  const sorted = useMemo(() => sortRows(rows, sort, SORT_COLS), [rows, sort, SORT_COLS]);

  // 待核可佇列:兩票獨立,各自列出「還缺這一票」的單
  const waitManager = useMemo(() => rows.filter((r) => r.status === 'pending' && !r.manager_approved_at), [rows]);
  const waitAdmin = useMemo(() => rows.filter((r) => r.status === 'pending' && !r.admin_approved_at), [rows]);
  const waitDate = useMemo(() => rows.filter((r) => r.status === 'approved' && !r.purchased_on), [rows]);
  const sum = (xs: Req[]) => xs.reduce((a, r) => a + (Number(r.total_amount) || 0), 0);

  function blankItem(): Item {
    return { item_name: '', amount: 0, account_code: null, purpose_type: 'property', property_id: null, note: null, sort: 0 };
  }

  function openNew() {
    setEdit({
      id: '', req_no: '', requester_id: me?.id ?? '', status: 'draft', total_amount: 0,
      payment_method: 'cash', payee_bank_code: null, payee_account: null, payee_company: null, payee_tax_id: null,
      note: null, submitted_at: null, manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null, rejected_by: null, rejected_at: null, reject_reason: null,
      purchased_on: null, expense_generated_at: null, created_at: '',
    });
    setItems([blankItem()]);
  }

  function openEdit(r: Req) {
    setEdit(r);
    const its = (r.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
    setItems(its.length ? its : [blankItem()]);
  }

  const editTotal = useMemo(() => items.reduce((a, i) => a + (Number(i.amount) || 0), 0), [items]);

  async function save(submit: boolean) {
    if (!edit || !me) return;
    const clean = items.filter((i) => i.item_name.trim() || Number(i.amount) > 0);
    if (!clean.length) return flash('至少要有一個請款項目');
    for (const i of clean) {
      if (!i.item_name.trim()) return flash('每個項目都要填名稱');
      if (i.purpose_type === 'property' && !i.property_id) return flash(`「${i.item_name}」請選擇用途`);
    }
    if (edit.payment_method === 'transfer' && !edit.payee_account) return flash('匯款需填收款帳號');
    setSaving(true);
    try {
      const header: any = {
        payment_method: edit.payment_method || null,
        payee_bank_code: edit.payee_bank_code || null,
        payee_account: edit.payee_account || null,
        payee_company: edit.payee_company || null,
        payee_tax_id: edit.payee_tax_id || null,
        note: edit.note || null,
      };
      let reqId = edit.id;
      if (!reqId) {
        const { data: no, error: ne } = await supabase.rpc('next_req_no');
        if (ne) { flash('取單號失敗:' + ne.message); return; }
        const { data, error } = await supabase.from('purchase_requests')
          .insert({ ...header, req_no: no, requester_id: me.id, status: 'draft' }).select('id').single();
        if (error) { flash('建立失敗:' + error.message); return; }
        reqId = data.id;
      } else {
        const { error } = await supabase.from('purchase_requests').update(header).eq('id', reqId);
        if (error) { flash('儲存失敗:' + error.message); return; }
        await supabase.from('purchase_request_items').delete().eq('request_id', reqId);
      }
      const payload = clean.map((i, idx) => ({
        request_id: reqId, item_name: i.item_name.trim(), amount: Number(i.amount) || 0,
        account_code: i.account_code || null, purpose_type: i.purpose_type,
        property_id: i.purpose_type === 'office' ? null : i.property_id,
        note: i.note || null, sort: idx,
      }));
      const { error: ie } = await supabase.from('purchase_request_items').insert(payload);
      if (ie) { flash('項目儲存失敗:' + ie.message); return; }

      if (submit) {
        // 狀態一律送 'pending'。免核門檻由資料庫觸發器判斷後自行翻成 approved,
        // 前端不自己算 —— 否則改前端就能繞過門檻。
        const { error: se } = await supabase.from('purchase_requests').update({ status: 'pending' }).eq('id', reqId);
        if (se) { flash('送出失敗:' + se.message); return; }
        flash(editTotal < FREE_THRESHOLD ? `已送出・未達 $${fmt(FREE_THRESHOLD)},自動核可` : '已送出,等待兩位主管核可');
      } else {
        flash('已儲存草稿');
      }
      setEdit(null); load();
    } finally { setSaving(false); }
  }

  async function vote(r: Req) {
    if (!me) return;
    const patch: any = {};
    if (isManager) { patch.manager_approved_by = me.id; patch.manager_approved_at = new Date().toISOString(); }
    else if (isAdmin) { patch.admin_approved_by = me.id; patch.admin_approved_at = new Date().toISOString(); }
    else return flash('你的角色不能核可');
    const { error } = await supabase.from('purchase_requests').update(patch).eq('id', r.id);
    if (error) return flash('核可失敗:' + error.message);
    flash('已核可'); load();
  }

  async function doReject() {
    if (!rejecting || !me) return;
    if (!rejectReason.trim()) return flash('請填駁回原因');
    const { error } = await supabase.from('purchase_requests')
      .update({ status: 'rejected', rejected_by: me.id, reject_reason: rejectReason.trim() })
      .eq('id', rejecting.id);
    if (error) return flash('駁回失敗:' + error.message);
    setRejecting(null); setRejectReason(''); flash('已駁回'); load();
  }

  async function doSetDate() {
    if (!dating) return;
    if (!dateVal) return flash('請選擇採購日');
    const { error } = await supabase.from('purchase_requests').update({ purchased_on: dateVal }).eq('id', dating.id);
    if (error) return flash('儲存失敗:' + error.message);
    setDating(null);
    flash(dating.purchased_on ? '採購日已更新,連動支出的日期一併調整' : '已填採購日,費用已連動到支出');
    load();
  }

  async function del(r: Req) {
    if (!confirm(`確定刪除請款單 ${r.req_no}?`)) return;
    const { error } = await supabase.from('purchase_requests').delete().eq('id', r.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }

  function exportXlsx() {
    if (!sorted.length) return flash('沒有符合條件的請款單');
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    // 一列一個請款項目,單頭資訊重複帶上 —— 這樣才能在 Excel 裡對科目或房源做樞紐分析。
    const header = ['單號', '申請人', '狀態', '送出日', '採購日', '項目', '金額', '會計科目', '用途', '支付方式', '收款帳號', '單據總額', '項目備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      const its = (r.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
      const list = its.length ? its : [null];
      for (const i of list) {
        aoa.push([
          T(r.req_no, stCell),
          T(personName[r.requester_id] ?? '', stCell),
          T(ST_LABEL[r.status] ?? r.status, stCell),
          T(r.submitted_at ? r.submitted_at.slice(0, 10) : '', stCell),
          T(r.purchased_on ?? '', stCell),
          T(i?.item_name ?? '', stCell),
          T(Math.round(Number(i?.amount) || 0), stNum),
          T(i?.account_code ? codeName[i.account_code] ?? i.account_code : '', stCell),
          T(i ? (i.purpose_type === 'office' ? '安幸辦公室' : (i.property_id ? propName[i.property_id] ?? '' : '')) : '', stCell),
          T(r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '', stCell),
          T(r.payee_account ?? '', stCell),
          T(Math.round(Number(r.total_amount) || 0), stNum),
          T(i?.note ?? '', stCell),
        ]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 15 }, { wch: 10 }, { wch: 9 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 11 }, { wch: 24 }];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '請款單');
    const tag = [ST_LABEL[stF] ?? '', reqF ? personName[reqF] ?? '' : '', fromD, toD].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `請款單${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  const card = (title: string, list: Req[], hint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-left rounded-xl border border-mor-line bg-white p-4 hover:bg-mor-sand/40 transition-colors">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-2xl font-bold mt-1">{list.length}<span className="text-sm font-normal text-gray-400 ml-1">筆</span></div>
      <div className="text-xs text-gray-500 mt-1">合計 ${fmt(sum(list))}</div>
      <div className="text-[11px] text-gray-400 mt-1">{hint}</div>
    </button>
  );

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-4 py-2 text-sm">{msg}</div>}
      <h1 className="text-xl font-bold mb-4">請款填寫</h1>

      {canSeeAll && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {card('待主管核可', waitManager, isManager ? '你可以核可這些' : '等待 manager 投票', () => setStF('pending'))}
          {card('待 Super Admin 核可', waitAdmin, isAdmin ? '你可以核可這些' : '等待 super_admin 投票', () => setStF('pending'))}
          {card('待填採購日', waitDate, canSetDate ? '填了才會產生支出' : '等待主管或會計填寫', () => setStF('approved'))}
        </div>
      )}

      {/* 工具列 */}
      <div className="flex flex-wrap items-end gap-2 mb-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={stF} onChange={(e) => setStF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部狀態</option>
            {Object.entries(ST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        {canSeeAll && (
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">申請人</span>
            <select value={reqF} onChange={(e) => setReqF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
              <option value="">全部</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">建立日(起)</span>
          <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">建立日(迄)</span>
          <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        {(stF || reqF || fromD || toD) &&
          <button onClick={() => { setStF(''); setReqF(''); setFromD(''); setToD(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-2">
          <div className="text-xs text-gray-400 pb-1.5">共 {rows.length.toLocaleString()} 筆</div>
          <button onClick={exportXlsx} disabled={!rows.length}
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">⬇ 下載 Excel</button>
          <button onClick={openNew} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 填寫請款</button>
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-xl border border-mor-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
              <SortTh label="單號" sortKey="req_no" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">申請人</th>
              <th className="px-3 py-2.5">項目</th>
              <SortTh label="總額" sortKey="total_amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="狀態" sortKey="status" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">核可</th>
              <SortTh label="採購日" sortKey="purchased_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">無請款單</td></tr>
            : sorted.map((r) => {
              const mine = r.requester_id === me?.id;
              const canEdit = mine && (r.status === 'draft' || r.status === 'rejected');
              const canVoteMgr = isManager && r.status === 'pending' && !r.manager_approved_at && !mine;
              const canVoteAdm = isAdmin && r.status === 'pending' && !r.admin_approved_at && !mine;
              const canRej = (isManager || isAdmin) && r.status === 'pending' && !mine;
              const canDate = canSetDate && r.status === 'approved';
              return (
                <tr key={r.id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30 align-top">
                  <td className="px-3 py-2 whitespace-nowrap font-medium">{r.req_no}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{personName[r.requester_id] ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-64">
                    <div className="truncate" title={(r.purchase_request_items ?? []).map((i) => i.item_name).join('、')}>
                      {(r.purchase_request_items ?? []).map((i) => i.item_name).join('、') || '—'}
                    </div>
                    <div className="text-[11px] text-gray-400">{(r.purchase_request_items ?? []).length} 個項目</div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium">${fmt(r.total_amount)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[r.status]}`}>{ST_LABEL[r.status] ?? r.status}</span>
                    {r.status === 'rejected' && r.reject_reason &&
                      <div className="text-[11px] text-red-500 mt-1 max-w-40 truncate" title={r.reject_reason}>{r.reject_reason}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs">
                    {r.status === 'approved' && !r.manager_approved_at && !r.admin_approved_at
                      ? <span className="text-gray-400">未達門檻免核</span>
                      : <>
                          <div className={r.manager_approved_at ? 'text-mor-green' : 'text-gray-400'}>
                            {r.manager_approved_at ? '✓' : '○'} 主管{r.manager_approved_by ? `・${personName[r.manager_approved_by] ?? ''}` : ''}
                          </div>
                          <div className={r.admin_approved_at ? 'text-mor-green' : 'text-gray-400'}>
                            {r.admin_approved_at ? '✓' : '○'} Admin{r.admin_approved_by ? `・${personName[r.admin_approved_by] ?? ''}` : ''}
                          </div>
                        </>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.purchased_on ?? '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                    <button onClick={() => openEdit(r)} className="text-xs text-gray-500 underline hover:text-mor-slate">
                      {canEdit ? '編輯' : '檢視'}
                    </button>
                    {(canVoteMgr || canVoteAdm) && <button onClick={() => vote(r)} className="text-xs text-mor-green underline hover:text-mor-slate">核可</button>}
                    {canRej && <button onClick={() => { setRejecting(r); setRejectReason(''); }} className="text-xs text-amber-600 underline hover:text-amber-800">駁回</button>}
                    {canDate && <button onClick={() => { setDating(r); setDateVal(r.purchased_on ?? todayStr()); }} className="text-xs text-mor-blue underline hover:text-mor-slate">
                      {r.purchased_on ? '改採購日' : '填採購日'}</button>}
                    {canEdit && <button onClick={() => del(r)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 請款單表單 */}
      {edit && (() => {
        const readOnly = !(edit.requester_id === me?.id && (edit.status === 'draft' || edit.status === 'rejected' || !edit.id));
        return (
          <div className="fixed inset-0 bg-black/30 flex items-start justify-center overflow-auto py-10 z-50" onClick={() => setEdit(null)}>
            <div className="bg-white rounded-xl w-[760px] max-w-[95vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between z-10">
                {edit.id ? `請款單 ${edit.req_no}` : '填寫請款'}
                <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>
              <div className="p-6 space-y-4 text-sm">
                {readOnly && edit.id && (
                  <div className="rounded-lg bg-mor-sand/60 text-gray-600 px-3 py-2 text-xs">
                    {edit.status === 'approved' ? '已核可的單不可再編輯,只能修改採購日。' : '此單目前不可編輯。'}
                  </div>
                )}
                {edit.status === 'rejected' && edit.reject_reason && (
                  <div className="rounded-lg bg-red-50 text-red-600 px-3 py-2 text-xs">駁回原因:{edit.reject_reason}</div>
                )}

                {/* 項目 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium">請款項目</div>
                    {!readOnly && <button onClick={() => setItems([...items, blankItem()])} className="text-xs text-mor-blue underline">+ 增加項目</button>}
                  </div>
                  <div className="space-y-2">
                    {items.map((it, idx) => (
                      <div key={idx} className="rounded-lg border border-mor-line p-3 space-y-2">
                        <div className="flex gap-2">
                          <input disabled={readOnly} value={it.item_name} placeholder="項目名稱"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, item_name: e.target.value } : x))}
                            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" />
                          <input disabled={readOnly} type="number" value={it.amount} placeholder="金額"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, amount: Number(e.target.value) } : x))}
                            className="w-28 rounded-lg border border-mor-line px-2 py-1.5 text-right disabled:bg-gray-50" />
                          {!readOnly && items.length > 1 &&
                            <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600 px-1">✕</button>}
                        </div>
                        <div className="flex gap-2">
                          <select disabled={readOnly} value={it.account_code ?? ''}
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, account_code: e.target.value || null } : x))}
                            className="w-36 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50">
                            <option value="">會計科目</option>
                            {codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                          </select>
                          <select disabled={readOnly}
                            value={it.purpose_type === 'office' ? 'office' : (it.property_id ?? '')}
                            onChange={(e) => {
                              const v = e.target.value;
                              setItems(items.map((x, i) => i === idx
                                ? (v === 'office' ? { ...x, purpose_type: 'office', property_id: null } : { ...x, purpose_type: 'property', property_id: v || null })
                                : x));
                            }}
                            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50">
                            <option value="">用途</option>
                            <option value="office">安幸辦公室</option>
                            {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <input disabled={readOnly} value={it.note ?? ''} placeholder="備註"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, note: e.target.value } : x))}
                            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <div className={editTotal < FREE_THRESHOLD ? 'text-mor-green text-xs' : 'text-amber-600 text-xs'}>
                      {editTotal < FREE_THRESHOLD
                        ? `未達 $${fmt(FREE_THRESHOLD)},送出後直接核可`
                        : `達 $${fmt(FREE_THRESHOLD)} 以上,需主管與 Super Admin 各核可一次`}
                    </div>
                    <div className="font-bold">總額 ${fmt(editTotal)}</div>
                  </div>
                </div>

                {/* 付款 */}
                <div className="border-t border-mor-line pt-3 space-y-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
                    <select disabled={readOnly} value={edit.payment_method ?? 'cash'}
                      onChange={(e) => setEdit({ ...edit, payment_method: e.target.value })}
                      className="w-40 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50">
                      {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
                    </select></label>
                  {edit.payment_method === 'transfer' && (
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">銀行代碼</span>
                        <input disabled={readOnly} value={edit.payee_bank_code ?? ''} onChange={(e) => setEdit({ ...edit, payee_bank_code: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款帳號 *</span>
                        <input disabled={readOnly} value={edit.payee_account ?? ''} onChange={(e) => setEdit({ ...edit, payee_account: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">公司名</span>
                        <input disabled={readOnly} value={edit.payee_company ?? ''} onChange={(e) => setEdit({ ...edit, payee_company: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">統編</span>
                        <input disabled={readOnly} value={edit.payee_tax_id ?? ''} onChange={(e) => setEdit({ ...edit, payee_tax_id: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                    </div>
                  )}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                    <textarea disabled={readOnly} value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                      className="rounded-lg border border-mor-line px-2 py-1.5 h-16 disabled:bg-gray-50" /></label>
                </div>
              </div>
              <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
                <button onClick={() => setEdit(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">關閉</button>
                {!readOnly && <>
                  <button onClick={() => save(false)} disabled={saving}
                    className="rounded-lg border border-mor-line px-4 py-1.5 text-sm hover:bg-mor-sand/60 disabled:opacity-40">儲存草稿</button>
                  <button onClick={() => save(true)} disabled={saving}
                    className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                    {saving ? '處理中…' : '送出審核'}</button>
                </>}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 駁回 */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setRejecting(null)}>
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">駁回 {rejecting.req_no}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">駁回後單子回到申請人手上,可修改後重新送審。已投的票會一併清空。</div>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="駁回原因(必填)"
                className="w-full rounded-lg border border-mor-line px-2 py-1.5 h-24" />
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setRejecting(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doReject} className="rounded-lg bg-amber-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-amber-700">確認駁回</button>
            </div>
          </div>
        </div>
      )}

      {/* 採購日 */}
      {dating && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDating(null)}>
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">{dating.purchased_on ? '修改採購日' : '填寫採購日'} · {dating.req_no}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">
                {dating.purchased_on
                  ? '改日期只會同步既有支出的日期,不會重複產生新的支出。'
                  : `填入後,這張單的 ${(dating.purchase_request_items ?? []).length} 個項目會各自產生一筆支出。`}
              </div>
              <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
                className="w-full rounded-lg border border-mor-line px-2 py-1.5" />
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setDating(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doSetDate} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">確認</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
