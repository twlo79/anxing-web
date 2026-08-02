'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';

type Expense = {
  id: string; spent_on: string; item_name: string; amount: number;
  account_code: string | null; purpose_type: string; estate_id: string | null;
  voucher_no: string | null; payment_method: string | null; pay_account: string | null;
  note: string | null; source_item_id: string | null;
};
type AccountCode = { code: string; name: string; sort: number; active: boolean };
type Estate = { id: string; name: string; sort: number; active: boolean };
type PayAccount = { code: string; name: string; method: string };

const PAY_LABEL: Record<string, string> = { cash: '現金', transfer: '匯款', credit_card: '信用卡' };
const PAY_OPTS = ['cash', 'transfer', 'credit_card'];
const fmt = (n: number | null | undefined) => (n == null ? '' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function ExpensesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Expense[]>([]);
  const [codes, setCodes] = useState<AccountCode[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<Expense | null>(null);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState('');

  // 篩選
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [codeF, setCodeF] = useState('');
  const [payF, setPayF] = useState('');
  const [purposeF, setPurposeF] = useState('');   // '' | 'office' | estate id
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'spent_on', dir: 'desc' });

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setRole(data?.role ?? '');
    })();
    supabase.from('account_codes').select('code, name, sort, active').order('sort').then(({ data }) => setCodes(data ?? []));
    supabase.from('estates').select('id, name, sort, active').order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method')
      .eq('for_payment', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
  }, [supabase]);

  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  // 停用的物業不再出現在下拉,但既有支出仍要顯示得出名字,所以 estateName 用全部物業
  const activeEstates = useMemo(() => estates.filter((e) => e.active), [estates]);

  // 支出筆數遠少於訂單,一次載完走前端排序即可(與契約頁同策略)。
  // 若日後量大到需要分頁,要改成伺服器端排序,並比照 /shortterm 讓匯出重新向伺服器取完整結果。
  const load = useCallback(async () => {
    setLoading(true);
    let all: Expense[] = [];
    let from = 0;
    while (true) {
      let q = supabase.from('expenses').select('*').order('spent_on', { ascending: false });
      if (fromD) q = q.gte('spent_on', fromD);
      if (toD) q = q.lte('spent_on', toD);
      if (codeF) q = q.eq('account_code', codeF);
      if (payF) q = q.eq('payment_method', payF);
      if (purposeF === 'office') q = q.eq('purpose_type', 'office');
      else if (purposeF) q = q.eq('estate_id', purposeF);
      if (kw) q = q.or(`item_name.ilike.%${kw}%,note.ilike.%${kw}%,voucher_no.ilike.%${kw}%`);
      const { data, error } = await q.range(from, from + 999);
      if (error) { flash('載入失敗:' + error.message); break; }
      const chunk = (data as Expense[]) ?? [];
      all = all.concat(chunk);
      if (chunk.length < 1000) break;
      from += 1000;
    }
    setRows(all);
    setLoading(false);
  }, [supabase, fromD, toD, codeF, payF, purposeF, kw]);
  useEffect(() => { load(); }, [load]);

  const SORT_COLS: SortCols<Expense> = useMemo(() => ({
    spent_on:   { type: 'date',   get: (r) => r.spent_on },
    item_name:  { type: 'text',   get: (r) => r.item_name },
    amount:     { type: 'number', get: (r) => r.amount },
    voucher_no: { type: 'text',   get: (r) => r.voucher_no },
  }), []);
  const sorted = useMemo(() => sortRows(rows, sort, SORT_COLS), [rows, sort, SORT_COLS]);

  const total = useMemo(() => rows.reduce((a, r) => a + (Number(r.amount) || 0), 0), [rows]);

  const byCode = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { const k = r.account_code ?? '(未分類)'; m[k] = (m[k] || 0) + (Number(r.amount) || 0); });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // 物業分項:辦公室獨立一列,其餘依物業歸戶
  const byPurpose = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => {
      const k = r.purpose_type === 'office' ? '__office' : (r.estate_id ?? '__none');
      m[k] = (m[k] || 0) + (Number(r.amount) || 0);
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const purposeLabel = (r: Expense) =>
    r.purpose_type === 'office' ? '安幸辦公室' : (r.estate_id ? estateName[r.estate_id] ?? '—' : '—');

  function blank(): Expense {
    return {
      id: '', spent_on: todayStr(), item_name: '', amount: 0, account_code: null,
      purpose_type: 'estate', estate_id: null, voucher_no: null,
      payment_method: 'cash', pay_account: null, note: null, source_item_id: null,
    };
  }

  async function save() {
    if (!edit) return;
    if (!edit.spent_on) return flash('請填支出日期');
    if (!edit.item_name.trim()) return flash('請填支出項目');
    if (edit.purpose_type === 'estate' && !edit.estate_id) return flash('請選擇用途物業');
    setSaving(true);
    const payload: any = {
      spent_on: edit.spent_on,
      item_name: edit.item_name.trim(),
      amount: Number(edit.amount) || 0,
      account_code: edit.account_code || null,
      purpose_type: edit.purpose_type,
      estate_id: edit.purpose_type === 'office' ? null : edit.estate_id,
      voucher_no: edit.voucher_no || null,
      payment_method: edit.payment_method || null,
      pay_account: edit.payment_method === 'transfer' ? (edit.pay_account || null) : null,
      note: edit.note || null,
    };
    const { error } = edit.id
      ? await supabase.from('expenses').update(payload).eq('id', edit.id)
      : await supabase.from('expenses').insert({ ...payload, created_by: (await supabase.auth.getUser()).data.user?.id ?? null });
    setSaving(false);
    if (error) return flash('儲存失敗:' + error.message);
    setEdit(null); flash('已儲存'); load();
  }

  // 來自請款單的支出只有 super_admin 能刪(RLS 也擋一次)。
  // 刪掉後請款單仍顯示已採購、支出卻不見了,而且重填採購日不會重新產生。
  const canDelete = (e: Expense) => !e.source_item_id || role === 'super_admin';

  async function del(e: Expense) {
    const extra = e.source_item_id ? '\n\n這筆支出來自請款單。刪除後不會回寫請款單,若之後重填採購日也不會重新產生。' : '';
    if (!confirm(`確定刪除「${e.item_name}」($${fmt(e.amount)})?${extra}`)) return;
    const { error } = await supabase.from('expenses').delete().eq('id', e.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }

  function exportXlsx() {
    if (!sorted.length) return flash('沒有符合條件的支出');
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    // 用途已是物業層級,原本的「物業」欄與「用途」欄內容重複,合併成一欄
    const header = ['支出日期', '支出項目', '金額', '會計科目', '用途', '憑證號碼', '支付方式', '付款帳號', '備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      aoa.push([
        T(r.spent_on ?? '', stCell),
        T(r.item_name ?? '', stCell),
        T(Math.round(Number(r.amount) || 0), stNum),
        T(r.account_code ? codeName[r.account_code] ?? r.account_code : '', stCell),
        T(purposeLabel(r), stCell),
        T(r.voucher_no ?? '', stCell),
        T(r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '', stCell),
        T(r.pay_account ?? '', stCell),
        T(r.note ?? '', stCell),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 28 }];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '支出');
    const tag = [codeF ? codeName[codeF] : '', PAY_LABEL[payF] ?? '', fromD, toD, kw].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `支出${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  const maxCode = byCode.length ? byCode[0][1] : 1;
  const maxPurpose = byPurpose.length ? byPurpose[0][1] : 1;

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-4 py-2 text-sm">{msg}</div>}
      <h1 className="text-xl font-bold mb-4">支出</h1>

      {/* 統計 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <div className="rounded-xl bg-mor-slate text-white p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-sm opacity-80">總支出</div>
            <div className="text-xs opacity-60">{rows.length.toLocaleString()} 筆</div>
          </div>
          <div className="text-3xl font-bold mt-2">${fmt(total)}</div>
          <div className="text-xs opacity-60 mt-1">{fromD || toD ? `${fromD || '起始'} ~ ${toD || '至今'}` : '全部期間'}</div>
        </div>

        <div className="rounded-xl border border-mor-line bg-white p-4">
          <div className="text-sm font-medium mb-3">會計科目分項</div>
          <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
            {byCode.length === 0 ? <div className="text-xs text-gray-400">無資料</div> : byCode.map(([c, v]) => (
              <div key={c} className="flex items-center gap-2 text-xs">
                <div className="w-20 shrink-0 truncate">{codeName[c] ?? c}</div>
                <div className="flex-1 h-2 rounded bg-mor-sand/60 overflow-hidden">
                  <div className="h-full bg-mor-blue" style={{ width: `${Math.max(2, (v / maxCode) * 100)}%` }} />
                </div>
                <div className="w-20 text-right tabular-nums">${fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-mor-line bg-white p-4">
          <div className="text-sm font-medium mb-3">物業分項</div>
          <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
            {byPurpose.length === 0 ? <div className="text-xs text-gray-400">無資料</div> : byPurpose.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <div className="w-20 shrink-0 truncate">{k === '__office' ? '安幸辦公室' : k === '__none' ? '—' : estateName[k] ?? '—'}</div>
                <div className="flex-1 h-2 rounded bg-mor-sand/60 overflow-hidden">
                  <div className="h-full bg-mor-green" style={{ width: `${Math.max(2, (v / maxPurpose) * 100)}%` }} />
                </div>
                <div className="w-20 text-right tabular-nums">${fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 工具列 */}
      <div className="flex flex-wrap items-end gap-2 mb-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日(起)</span>
          <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日(迄)</span>
          <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">會計科目</span>
          <select value={codeF} onChange={(e) => setCodeF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部科目</option>
            {codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">用途</span>
          <select value={purposeF} onChange={(e) => setPurposeF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5 max-w-44">
            <option value="">全部用途</option>
            <option value="office">安幸辦公室</option>
            {activeEstates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支付方式</span>
          <select value={payF} onChange={(e) => setPayF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部</option>
            {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字(項目/備註/憑證)</span>
          <div className="flex">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setKw(kwIn.trim())}
              className="rounded-l-lg border border-mor-line px-2 py-1.5 w-44" placeholder="含否關鍵字" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-r-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div></label>
        {(fromD || toD || codeF || payF || purposeF || kw) &&
          <button onClick={() => { setFromD(''); setToD(''); setCodeF(''); setPayF(''); setPurposeF(''); setKw(''); setKwIn(''); }}
            className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-2">
          <div className="text-xs text-gray-400 pb-1.5">共 {rows.length.toLocaleString()} 筆</div>
          <button onClick={exportXlsx} disabled={!rows.length}
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">⬇ 下載 Excel</button>
          <button onClick={() => setEdit(blank())}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 填寫支出</button>
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-xl border border-mor-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
              <SortTh label="支出日" sortKey="spent_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <SortTh label="項目" sortKey="item_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="金額" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <th className="px-3 py-2.5">會計科目</th>
              <th className="px-3 py-2.5">用途</th>
              <SortTh label="憑證號碼" sortKey="voucher_no" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">支付方式</th>
              <th className="px-3 py-2.5">備註</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">無支出紀錄</td></tr>
            : sorted.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30">
                <td className="px-3 py-2 whitespace-nowrap">{r.spent_on}</td>
                <td className="px-3 py-2">
                  {r.item_name}
                  {r.source_item_id && <span className="ml-2 inline-block rounded-md bg-mor-bluelight text-mor-slate px-1.5 py-0.5 text-[10px]">請款</span>}
                </td>
                <td className="px-3 py-2 text-right font-medium">${fmt(r.amount)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.account_code ? codeName[r.account_code] ?? r.account_code : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{purposeLabel(r)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.voucher_no ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                  {r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '—'}
                  {r.pay_account && <span className="text-xs text-gray-400 ml-1">{r.pay_account}</span>}
                </td>
                <td className="px-3 py-2 text-gray-500 max-w-56 truncate" title={r.note ?? ''}>{r.note ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => setEdit(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                  {canDelete(r)
                    ? <button onClick={() => del(r)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                    : <span className="text-xs text-gray-300" title="來自請款單的支出不可刪除,需由 Super Admin 處理">刪除</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 表單 */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center overflow-auto py-10 z-50" onClick={() => setEdit(null)}>
          <div className="bg-white rounded-xl w-[560px] max-w-[94vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              {edit.id ? '編輯支出' : '填寫支出'}
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6 space-y-3 text-sm">
              {edit.source_item_id && (
                <div className="rounded-lg bg-mor-bluelight/60 text-mor-slate px-3 py-2 text-xs">
                  這筆支出由請款單連動產生。金額與項目建議回請款單修正,以免帳面與核可內容對不上。
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日期 *</span>
                  <input type="date" value={edit.spent_on ?? ''} onChange={(e) => setEdit({ ...edit, spent_on: e.target.value })}
                    className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">金額 *</span>
                  <input type="number" value={edit.amount ?? 0} onChange={(e) => setEdit({ ...edit, amount: Number(e.target.value) })}
                    className="rounded-lg border border-mor-line px-2 py-1.5 text-right" /></label>
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出項目 *</span>
                <input value={edit.item_name ?? ''} onChange={(e) => setEdit({ ...edit, item_name: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5" placeholder="例:14B5 冷氣濾網更換" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">會計科目</span>
                  <select value={edit.account_code ?? ''} onChange={(e) => setEdit({ ...edit, account_code: e.target.value || null })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    <option value="">未分類</option>
                    {codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select></label>
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">憑證號碼</span>
                  <input value={edit.voucher_no ?? ''} onChange={(e) => setEdit({ ...edit, voucher_no: e.target.value })}
                    className="rounded-lg border border-mor-line px-2 py-1.5" placeholder="發票/收據號碼" /></label>
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">用途 *</span>
                <select
                  value={edit.purpose_type === 'office' ? 'office' : (edit.estate_id ?? '')}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'office') setEdit({ ...edit, purpose_type: 'office', estate_id: null });
                    else setEdit({ ...edit, purpose_type: 'estate', estate_id: v || null });
                  }}
                  className="rounded-lg border border-mor-line px-2 py-1.5">
                  <option value="">請選擇</option>
                  <option value="office">安幸辦公室</option>
                  {activeEstates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支付方式</span>
                  <select value={edit.payment_method ?? ''} onChange={(e) => setEdit({ ...edit, payment_method: e.target.value || null })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
                  </select></label>
                {/* 現金沒有帳號可選,匯款與信用卡才需要 */}
                {(edit.payment_method === 'transfer' || edit.payment_method === 'credit_card') && (
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">付款帳號</span>
                    <select value={edit.pay_account ?? ''} onChange={(e) => setEdit({ ...edit, pay_account: e.target.value || null })}
                      className="rounded-lg border border-mor-line px-2 py-1.5">
                      <option value="">請選擇</option>
                      {payAccounts.filter((a) => a.method === edit.payment_method)
                        .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                    </select></label>
                )}
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                <textarea value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5 h-20" /></label>
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={saving}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {saving ? '儲存中…' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
