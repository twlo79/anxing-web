'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilterToggle from '@/components/FilterToggle';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import DeferralPanel from '@/components/DeferralPanel';
import { deferralLabel, childLabel, recognizedTotal, paidTotal, paidCell } from '@/lib/deferral';
import { softDelete } from '@/lib/trash';
import TrashLink from '@/components/TrashLink';

type Expense = {
  id: string; spent_on: string; item_name: string; amount: number;
  account_code: string | null; purpose_type: string; estate_id: string | null;
  property_id?: string | null;   // 選填,用途的細分
  voucher_no: string | null; no_voucher?: boolean; payment_method: string | null; pay_account: string | null;
  // 由哪張請款單產生。憑證照片沿用那張單上的，不另外複製檔案。
  request_id?: string | null;
  note: string | null; source_item_id: string | null;
  // amount 一律台幣;外幣的單另存原幣別與原金額供對帳
  currency?: string | null; fx_rate?: number | null; amount_original?: number | null;
  /**
   * 遞延認列（migration_88）。
   * 母單:deferred=true、gross_amount=實付總額、amount=這一天認列多少。
   * 子單:parent_expense_id 指回母單,不可單獨編輯或刪除。
   */
  parent_expense_id?: string | null; gross_amount?: number | null; deferred?: boolean;
  /** 關注支出。遞延母子單會一起連動（migration_89 的觸發器）。 */
  starred?: boolean;
};
/** kind：expense=只用於支出 / income=只用於收入 / both=兩邊都用（migration_90） */
type AccountCode = { code: string; name: string; sort: number; active: boolean; kind?: string };
type Estate = { id: string; name: string; sort: number; active: boolean };
type PayAccount = { code: string; name: string; method: string };
type Property = { id: string; name: string; estate_id: string | null };

const CURRENCIES = ['TWD', 'USD', 'JPY', 'CNY', 'EUR'];

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
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<Expense | null>(null);
  const [starF, setStarF] = useState(false);   // 只看關注
  const [saving, setSaving] = useState(false);
  // 新支出還沒有 id，憑證要等這筆建立後才傳得上去 —— 存檔時呼叫 flush()
  const receiptsRef = useRef<ReceiptsHandle>(null);
  const [role, setRole] = useState('');

  // 篩選
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [codeF, setCodeF] = useState('');
  const [payF, setPayF] = useState('');
  const [purposeF, setPurposeF] = useState('');   // '' | 'office' | estate id
  const [acctF, setAcctF] = useState('');         // 安幸付款帳號 / 卡別
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
    supabase.from('account_codes').select('code, name, sort, active, kind').order('sort').then(({ data }) => setCodes(data ?? []));
    supabase.from('estates').select('id, name, sort, active').order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method')
      .eq('for_payment', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
    supabase.from('properties').select('id, name, estate_id').order('name')
      .then(({ data }) => setProperties(data ?? []));
  }, [supabase]);

  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  /*
   * 下拉只給支出方向的科目。
   *
   * codeName 那份刻意保留全部 —— 名稱查表要撈得到每一個 code，
   * 只留支出的話，萬一有一列掛著別的科目，畫面會顯示原始代碼而不是名稱。
   * 過濾只發生在「可以選什麼」，不發生在「怎麼顯示」。
   */
  const expenseCodes = useMemo(
    // active=false 的科目也要濾掉 —— migration_91 把「水電瓦斯」停用改成水費/電費/瓦斯費，
    // 不濾的話停用的科目會繼續出現在選單裡，等於沒停用。
    () => codes.filter((c) => c.kind !== 'income' && c.active !== false), [codes]);
  /** id → 支出。子單要靠它找到母單（顯示母單日期、點了跳過去）。 */
  const byId = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r])), [rows]);
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
      if (acctF === '__cash') q = q.is('pay_account', null);
      else if (acctF) q = q.eq('pay_account', acctF);
      if (kw) q = q.or(`item_name.ilike.%${kw}%,note.ilike.%${kw}%,voucher_no.ilike.%${kw}%`);
      if (starF) q = q.eq('starred', true);
      const { data, error } = await q.range(from, from + 999);
      if (error) { flash('載入失敗:' + error.message); break; }
      const chunk = (data as Expense[]) ?? [];
      all = all.concat(chunk);
      if (chunk.length < 1000) break;
      from += 1000;
    }
    setRows(all);
    setLoading(false);
  }, [supabase, fromD, toD, codeF, payF, purposeF, acctF, kw, starF]);
  useEffect(() => { load(); }, [load]);

  const SORT_COLS: SortCols<Expense> = useMemo(() => ({
    spent_on:   { type: 'date',   get: (r) => r.spent_on },
    item_name:  { type: 'text',   get: (r) => r.item_name },
    amount:     { type: 'number', get: (r) => r.amount },
    voucher_no: { type: 'text',   get: (r) => r.voucher_no },
  }), []);
  const sorted = useMemo(() => sortRows(rows, sort, SORT_COLS), [rows, sort, SORT_COLS]);

  /*
   * 遞延之後支出有兩個數字,兩個都要看得到:
   *
   *   認列支出  這段期間的費用是多少（sum(amount),跟改版前完全一樣）
   *   實際支出  這段期間真的付出去多少錢（子單不算,它們沒有付款事實）
   *
   * 只看認列會以為 8 月沒花錢,銀行對帳對不上;
   * 只看實際會讓 9、10 月的費用憑空消失。
   * **沒有任何遞延時兩個數字完全相同**,所以舊資料的行為不變。
   */
  const total = useMemo(() => recognizedTotal(rows), [rows]);
  const paid = useMemo(() => paidTotal(rows), [rows]);
  const hasDeferral = useMemo(() => rows.some((r) => r.deferred || r.parent_expense_id), [rows]);

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

  // 帳戶分項:錢從哪個戶頭/哪張卡出去的。
  // pay_account 為空的歸到「現金/未指定」—— 現金沒有帳戶，那是正常狀態不是缺漏。
  const byAccount = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => {
      const k = r.pay_account || '__cash';
      m[k] = (m[k] || 0) + (Number(r.amount) || 0);
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);

  const purposeLabel = (r: Expense) =>
    r.purpose_type === 'office' ? '安幸辦公室' : (r.estate_id ? estateName[r.estate_id] ?? '—' : '—');

  function blank(): Expense {
    return {
      id: '', spent_on: todayStr(), item_name: '', amount: 0, account_code: null,
      purpose_type: 'estate', estate_id: null, property_id: null, voucher_no: null, no_voucher: false,
      payment_method: 'cash', pay_account: null, note: null, source_item_id: null,
      currency: 'TWD', fx_rate: 1, amount_original: 0,
    };
  }

  /**
   * 打星／取消。
   *
   * **只寫這一筆,不管母子連動** —— 那是資料庫觸發器的事（migration_89）。
   * 前端自己去更新兄弟的話,從別的路徑改（匯入、API、儀表板）就不會同步,
   * 而不同步不會報錯,只會讓篩選出來的清單少幾張子單。
   *
   * 畫面先動再寫資料庫,按下去立刻有反應。連動的結果要重載才看得到,
   * 所以有母子關係時多重載一次。
   */
  async function toggleStar(r: Expense) {
    const next = !r.starred;
    const group = r.deferred || r.parent_expense_id;
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, starred: next } : x)));
    const { error } = await supabase.from('expenses').update({ starred: next }).eq('id', r.id);
    if (error) { flash('失敗:' + error.message); load(); return; }
    if (group) load();   // 母子連動由觸發器做,要重載才看得到整組
  }

  async function save() {
    if (!edit) return;
    if (!edit.spent_on) return flash('請填支出日期');
    if (!edit.item_name.trim()) return flash('請填支出項目');
    if (edit.purpose_type === 'estate' && !edit.estate_id) return flash('請選擇用途物業');
    const cur = edit.currency || 'TWD';
    const rate = cur === 'TWD' ? 1 : (Number(edit.fx_rate) || 0);
    if (cur !== 'TWD' && !(rate > 0)) return flash('請填匯率');
    setSaving(true);
    const orig = Number(edit.amount_original) || 0;
    /*
     * 【遞延母單的金額不能在這裡重算】
     *
     * 一般支出的 amount = 原幣 × 匯率。但遞延母單的 amount 是
     * 「這一天認列多少」= 實付總額 − 子單合計,可能是 0。
     * 照一般規則重算會把它蓋成全額,母單 + 子單就不等於實付總額,
     * migration_88 的觸發器會直接把整筆存檔打回來。
     *
     * 母單金額本來就不允許改（使用者定的規則）——
     * 要改先取消遞延,或刪掉重建。
     */
    const payload: any = {
      spent_on: edit.spent_on,
      item_name: edit.item_name.trim(),
      // amount 一律台幣,與請款單同一套規則 —— 報表與統計都只看這欄
      ...(edit.deferred ? {} : { amount: Math.round(orig * rate) }),
      amount_original: orig,
      currency: cur,
      fx_rate: rate,
      account_code: edit.account_code || null,
      purpose_type: edit.purpose_type,
      estate_id: edit.purpose_type === 'office' ? null : edit.estate_id,
      // 房源選填。選了辦公室就沒有房源可言,清成 null。
      property_id: edit.purpose_type === 'office' ? null : (edit.property_id || null),
      // 互斥,見 exp_voucher_chk
      voucher_no: edit.no_voucher ? null : (edit.voucher_no?.trim() || null),
      no_voucher: !!edit.no_voucher,
      payment_method: edit.payment_method || null,
      // 匯款與信用卡都要記錄從哪個帳戶/哪張卡付出去;現金沒有帳戶,清成 null。
      // 這裡的條件必須與畫面上顯示下拉的條件一致 —— 先前只判斷 transfer,
      // 結果信用卡選了卡片存檔時被清掉,而且沒有任何錯誤訊息。
      pay_account: (edit.payment_method === 'transfer' || edit.payment_method === 'credit_card')
        ? (edit.pay_account || null) : null,
      note: edit.note || null,
    };
    // 新建時要拿回 id —— 填表時選的憑證還留在瀏覽器裡，等這個 id 才傳得上去
    const { data, error } = edit.id
      ? await supabase.from('expenses').update(payload).eq('id', edit.id).select('id').single()
      : await supabase.from('expenses')
          .insert({ ...payload, created_by: (await supabase.auth.getUser()).data.user?.id ?? null })
          .select('id').single();
    if (error) { setSaving(false); return flash('儲存失敗:' + error.message); }

    const fe = await receiptsRef.current?.flush(data.id);
    setSaving(false);
    if (fe) return flash('憑證' + fe);
    setEdit(null); flash('已儲存'); load();
  }

  // 來自請款單的支出只有 super_admin 能刪(RLS 也擋一次)。
  // 刪掉後請款單仍顯示已採購、支出卻不見了,而且重填採購日不會重新產生。
  const canDelete = (e: Expense) => !e.source_item_id || role === 'super_admin';

  async function del(e: Expense) {
    const extra = e.source_item_id ? '\n\n這筆支出來自請款單。刪除後不會回寫請款單,若之後重填採購日也不會重新產生。' : '';
    if (!confirm(`確定刪除「${e.item_name}」($${fmt(e.amount)})?${extra}\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'expenses', e.id);
    flash(r.message); if (r.ok) load();
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
    const header = ['關注', '支出日期', '支出項目', '認列金額', '實際支出', '遞延', '會計科目', '用途', '憑證號碼', '支付方式', '安幸付款帳號', '備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      aoa.push([
        T(r.starred ? '★' : '', stCell),
        T(r.spent_on ?? '', stCell),
        T(r.item_name ?? '', stCell),
        T(Math.round(Number(r.amount) || 0), stNum),
        // 實際支出:子單留空 —— 那一列沒有付款事實,印 0 會讓人以為那天付了 0 元
        T(paidCell(r), stNum),
        T(r.deferred ? '母單' : (r.parent_expense_id ? '子單' : ''), stCell),
        T(r.account_code ? codeName[r.account_code] ?? r.account_code : '', stCell),
        T(purposeLabel(r), stCell),
        T(r.voucher_no ?? '', stCell),
        T(r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '', stCell),
        T(r.pay_account ?? '', stCell),
        T(r.note ?? '', stCell),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 28 }];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '支出');
    const tag = [
      codeF ? codeName[codeF] : '', PAY_LABEL[payF] ?? '',
      acctF === '__cash' ? '現金' : (acctF ? acctName[acctF] ?? acctF : ''),
      fromD, toD, kw,
    ].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `支出${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  const maxCode = byCode.length ? byCode[0][1] : 1;
  const maxPurpose = byPurpose.length ? byPurpose[0][1] : 1;
  const maxAccount = byAccount.length ? byAccount[0][1] : 1;

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-4 py-2 text-sm">{msg}</div>}
      <h1 className="mb-4">支出</h1>

      {/* 統計 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <div className="rounded-xl min-w-0 bg-mor-slate text-white p-5">
          <div className="flex items-baseline justify-between">
            <div className="text-sm opacity-80">認列支出</div>
            <div className="text-xs opacity-60">{rows.length.toLocaleString()} 筆</div>
          </div>
          <div className="stat-num-lg font-bold mt-2">${fmt(total)}</div>
          {/*
            有遞延才顯示第二個數字。沒有的話兩者永遠相同,
            多印一行只是讓每天都在看的人多讀一次一樣的數字。
          */}
          {hasDeferral && (
            <div className="text-sm mt-1.5 pt-1.5 border-t border-white/20 flex items-baseline justify-between">
              <span className="opacity-80">實際支出</span>
              <span className="font-semibold">${fmt(paid)}</span>
            </div>
          )}
          <div className="text-xs opacity-60 mt-1">
            {fromD || toD ? `${fromD || '起始'} ~ ${toD || '至今'}` : '全部期間'}
            {hasDeferral && <span className="block mt-0.5">認列＝費用發生在哪個月・實際＝錢哪天出去</span>}
          </div>
        </div>

        <div className="rounded-xl glass p-4">
          <div className="text-sm font-medium mb-3">會計科目分項</div>
          <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
            {byCode.length === 0 ? <div className="text-xs text-gray-400">無資料</div> : byCode.map(([c, v]) => (
              <div key={c} className="flex items-center gap-2 text-xs">
                <div className="w-20 shrink-0 truncate">{codeName[c] ?? c}</div>
                <div className="flex-1 h-2 rounded bg-mor-sand/60 overflow-hidden">
                  <div className="h-full bg-mor-blue" style={{ width: `${Math.max(2, (v / maxCode) * 100)}%` }} />
                </div>
                <div className="min-w-[5rem] shrink-0 whitespace-nowrap text-right tabular-nums">${fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl glass p-4">
          <div className="text-sm font-medium mb-3">物業分項</div>
          <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
            {byPurpose.length === 0 ? <div className="text-xs text-gray-400">無資料</div> : byPurpose.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <div className="w-20 shrink-0 truncate">{k === '__office' ? '安幸辦公室' : k === '__none' ? '—' : estateName[k] ?? '—'}</div>
                <div className="flex-1 h-2 rounded bg-mor-sand/60 overflow-hidden">
                  <div className="h-full bg-mor-green" style={{ width: `${Math.max(2, (v / maxPurpose) * 100)}%` }} />
                </div>
                <div className="min-w-[5rem] shrink-0 whitespace-nowrap text-right tabular-nums">${fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 帳戶分項:點一列可直接篩選成該帳戶 */}
        <div className="rounded-xl glass p-4">
          <div className="text-sm font-medium mb-3">帳戶分項</div>
          <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
            {byAccount.length === 0 ? <div className="text-xs text-gray-400">無資料</div> : byAccount.map(([k, v]) => (
              <button key={k} onClick={() => setAcctF(acctF === k ? '' : k)}
                className={`w-full flex items-center gap-2 text-xs rounded px-1 py-0.5 ${acctF === k ? 'bg-mor-bluelight' : 'hover:bg-white/45'}`}>
                <div className="w-20 shrink-0 truncate text-left">{k === '__cash' ? '現金/未指定' : acctName[k] ?? k}</div>
                <div className="flex-1 h-2 rounded bg-mor-sand/60 overflow-hidden">
                  <div className="h-full bg-mor-slate" style={{ width: `${Math.max(2, (v / maxAccount) * 100)}%` }} />
                </div>
                <div className="min-w-[5rem] shrink-0 whitespace-nowrap text-right tabular-nums">${fmt(v)}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 工具列 */}
      <FilterToggle />
      <div className="filter-bar collapsible-filters flex flex-wrap items-end gap-2 mb-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日(起)</span>
          <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日(迄)</span>
          <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">會計科目</span>
          <select value={codeF} onChange={(e) => setCodeF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部科目</option>
            {expenseCodes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
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
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">帳戶</span>
          <select value={acctF} onChange={(e) => setAcctF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部帳戶</option>
            <option value="__cash">現金/未指定</option>
            {payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字(項目/備註/憑證)</span>
          <div className="flex">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setKw(kwIn.trim())}
              className="rounded-l-lg border border-mor-line px-2 py-1.5 w-44" placeholder="含否關鍵字" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-r-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div></label>
        {/* 只看關注。做成切換鈕而不是下拉 —— 它只有開/關兩種狀態,而且會常按。 */}
        <button onClick={() => setStarF(!starF)}
          className={`rounded-lg border px-3 py-1.5 font-medium ${
            starF ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-mor-line bg-white text-gray-600 hover:bg-mor-sand/60'}`}>
          {starF ? '★ 只看關注' : '☆ 只看關注'}
        </button>
        {(fromD || toD || codeF || payF || purposeF || acctF || kw || starF) &&
          <button onClick={() => { setFromD(''); setToD(''); setCodeF(''); setPayF(''); setPurposeF(''); setAcctF(''); setKw(''); setKwIn(''); setStarF(false); }}
            className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-2">
          <div className="text-xs text-gray-400 pb-1.5">共 {rows.length.toLocaleString()} 筆</div>
          <button onClick={exportXlsx} disabled={!rows.length}
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">⬇ 下載 Excel</button>
          <button onClick={() => setEdit(blank())}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 填寫支出</button>
          <TrashLink table="expenses" label="支出" />
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-xl glass overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
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
                  {/* 子單縮排並標明來自哪一張母單,點了跳到母單 */}
                  {r.parent_expense_id && (
                    <button onClick={() => { const p = byId[r.parent_expense_id!]; if (p) setEdit(p); }}
                      className="mr-1 text-[11px] text-mor-blue underline hover:text-mor-slate"
                      title="回到母單修改">
                      {childLabel(byId[r.parent_expense_id]?.spent_on ?? '', null)}
                    </button>
                  )}
                  {r.item_name}
                  {r.source_item_id && <span className="ml-2 inline-block rounded-md bg-mor-bluelight text-mor-slate px-1.5 py-0.5 text-[10px]">請款</span>}
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {fmt(r.amount)}
                  {/*
                    遞延母單的紅字。**一定要同時講出實付總額**——
                    母單的 amount 可能是 0,只顯示本期的話,
                    會計拿 10,000 的發票會搜不到任何一列。
                  */}
                  {r.deferred && (
                    <div className="text-[11px] font-normal text-red-500 whitespace-nowrap">
                      {deferralLabel(Number(r.gross_amount) || 0, Number(r.amount) || 0)}
                    </div>
                  )}
                  {r.currency && r.currency !== 'TWD' && (
                    <div className="text-[11px] font-normal text-gray-400">
                      {r.currency} {fmt(r.amount_original)} × {r.fx_rate}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.account_code ? codeName[r.account_code] ?? r.account_code : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{purposeLabel(r)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                  {r.voucher_no ?? (r.no_voucher ? <span className="text-gray-400 text-xs">無憑證</span> : '—')}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                  {r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '—'}
                  {r.pay_account && <span className="text-xs text-gray-400 ml-1">{r.pay_account}</span>}
                </td>
                <td className="px-3 py-2 text-gray-500 max-w-56 truncate" title={r.note ?? ''}>{r.note ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  {/*
                    子單不給單獨編輯或刪除 —— 刪一筆就會破壞
                    「母單 + 子單 = 實付總額」那條等式（資料庫也會擋）。
                    要改一律回母單重設整組。
                  */}
                  {/*
                    關注。遞延的母子單會一起亮 —— 連動由資料庫觸發器做,
                    所以子單上的星星也可以點,母單與其他兄弟會跟著。
                  */}
                  <button onClick={() => toggleStar(r)}
                    title={r.starred ? '取消關注' : '關注這筆支出'}
                    className={`text-sm align-middle ${r.starred ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}>
                    {r.starred ? '★' : '☆'}
                  </button>
                  {r.parent_expense_id ? (
                    <button onClick={() => { const p = byId[r.parent_expense_id!]; if (p) setEdit(p); }}
                      className="text-xs text-mor-blue underline hover:text-mor-slate">到母單</button>
                  ) : (<>
                    <button onClick={() => setEdit(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">編輯</button>
                    {canDelete(r)
                      ? <button onClick={() => del(r)} className="text-xs text-red-500 underline hover:text-red-700">刪除</button>
                      : <span className="text-xs text-gray-300" title="來自請款單的支出不可刪除,需由 Super Admin 處理">刪除</span>}
                  </>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 表單 */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center overflow-auto py-10 z-50">
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出日期 *</span>
                  <input type="date" value={edit.spent_on ?? ''} onChange={(e) => setEdit({ ...edit, spent_on: e.target.value })}
                    className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">金額 *</span>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                      {(edit.currency ?? 'TWD') === 'TWD' ? 'NT$' : edit.currency}
                    </span>
                    {/* 空字串而非 0 —— 否則打字會接在 0 後面變成 0500 */}
                    <input type="number" inputMode="decimal" min="0" disabled={!!edit.deferred}
                      value={edit.amount_original === 0 || edit.amount_original == null ? '' : edit.amount_original}
                      onChange={(e) => setEdit({ ...edit, amount_original: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className="w-full rounded-lg border border-mor-line pl-9 pr-2 py-1.5 text-right disabled:bg-gray-100 disabled:text-gray-400" />
                  </div>
                  {edit.deferred && (
                    <span className="text-[11px] text-gray-500 mt-0.5">
                      已設遞延認列,金額不可改。實付總額 ${fmt(edit.gross_amount)}、本期認列 ${fmt(edit.amount)}。
                      要改金額請先在下方取消遞延。
                    </span>
                  )}
                </label>
              </div>

              {/* 幣別與匯率:選非台幣才會出現匯率欄 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">幣別</span>
                  <select value={edit.currency ?? 'TWD'}
                    onChange={(e) => setEdit({ ...edit, currency: e.target.value, fx_rate: e.target.value === 'TWD' ? 1 : (edit.fx_rate || 0) })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select></label>
                {(edit.currency ?? 'TWD') !== 'TWD' && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-500">匯率 * (1 {edit.currency} = ? NTD)</span>
                    <input type="number" inputMode="decimal" step="0.0001" min="0"
                      value={edit.fx_rate ? edit.fx_rate : ''} placeholder="例 31.5"
                      onChange={(e) => setEdit({ ...edit, fx_rate: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className="rounded-lg border border-mor-line px-2 py-1.5 text-right" /></label>
                )}
              </div>
              {(edit.currency ?? 'TWD') !== 'TWD' && (
                <div className="text-right text-sm">
                  <span className="text-xs text-gray-500 mr-2">
                    {edit.currency} {fmt(edit.amount_original)} × {edit.fx_rate || '—'}
                  </span>
                  <span className="font-bold">
                    NT$ {fmt(Math.round((Number(edit.amount_original) || 0) * (Number(edit.fx_rate) || 0)))}
                  </span>
                </div>
              )}
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出項目 *</span>
                <input value={edit.item_name ?? ''} onChange={(e) => setEdit({ ...edit, item_name: e.target.value })}
                  className="rounded-lg border border-mor-line px-2 py-1.5" placeholder="例:14B5 冷氣濾網更換" /></label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">會計科目</span>
                  <select value={edit.account_code ?? ''} onChange={(e) => setEdit({ ...edit, account_code: e.target.value || null })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    <option value="">未分類</option>
                    {expenseCodes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select></label>
                {/* 憑證號碼與「無憑證」互斥 —— 分開才知道空白是漏填還是本來就沒有 */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">憑證號碼</span>
                  <div className="flex items-center gap-2">
                    <input value={edit.voucher_no ?? ''} disabled={!!edit.no_voucher}
                      onChange={(e) => setEdit({ ...edit, voucher_no: e.target.value })}
                      className="flex-1 min-w-0 rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-100 disabled:text-gray-400"
                      placeholder={edit.no_voucher ? '已註記無憑證' : '發票/收據號碼'} />
                    <label className={`flex items-center gap-1 text-sm whitespace-nowrap
                      ${(edit.voucher_no ?? '').trim() ? 'text-gray-300' : 'text-gray-600'}`}>
                      <input type="checkbox" disabled={!!(edit.voucher_no ?? '').trim()} checked={!!edit.no_voucher}
                        onChange={(e) => setEdit({ ...edit, no_voucher: e.target.checked, voucher_no: e.target.checked ? null : edit.voucher_no })} />
                      無憑證
                    </label>
                  </div>
                </div>
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">用途 *</span>
                <select
                  value={edit.purpose_type === 'office' ? 'office' : (edit.estate_id ?? '')}
                  onChange={(e) => {
                    const v = e.target.value;
                    // 換物業時清掉房源 —— 否則會留著上一個物業的房間
                    if (v === 'office') setEdit({ ...edit, purpose_type: 'office', estate_id: null, property_id: null });
                    else setEdit({ ...edit, purpose_type: 'estate', estate_id: v || null, property_id: null });
                  }}
                  className="rounded-lg border border-mor-line px-2 py-1.5">
                  <option value="">請選擇</option>
                  <option value="office">安幸辦公室</option>
                  {activeEstates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select></label>

              {/* 房源選填:知道是哪一間就填,之後要追單一房間的花費才有依據。
                  選了物業才出現 —— 沒有物業就篩不出房源清單。 */}
              {edit.purpose_type === 'estate' && edit.estate_id && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">房源（選填）</span>
                  <select value={edit.property_id ?? ''} onChange={(e) => setEdit({ ...edit, property_id: e.target.value || null })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    <option value="">整個物業（不指定房源）</option>
                    {properties.filter((p) => p.estate_id === edit.estate_id)
                      .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支付方式</span>
                  <select value={edit.payment_method ?? ''} onChange={(e) => setEdit({ ...edit, payment_method: e.target.value || null })}
                    className="rounded-lg border border-mor-line px-2 py-1.5">
                    {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
                  </select></label>
                {/* 現金沒有帳號可選,匯款與信用卡才需要 */}
                {(edit.payment_method === 'transfer' || edit.payment_method === 'credit_card') && (
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">安幸付款帳號</span>
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
              {/*
                遞延認列。只有已存檔的支出才能設 —— 新增中的那筆還沒有 id,
                子單掛不上去。母單金額不可改也是在這裡強制的（見 DeferralPanel）。
              */}
              {edit.id && (
                <DeferralPanel expense={edit} canEdit onChanged={() => { setEdit(null); load(); }} />
              )}
              <Receipts ref={receiptsRef} kind="exp" parentId={edit.id || null} label="憑證圖片"
                inheritFromRequestId={edit.request_id ?? null} />
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
