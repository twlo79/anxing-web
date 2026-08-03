'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import PushToggle from '../push-toggle';

type Item = {
  id?: string; request_id?: string; item_name: string; amount: number;
  account_code: string | null; purpose_type: string; estate_id: string | null;
  note: string | null; sort: number;
  amount_original?: number | null;   // 原幣別金額。amount 一律是換算後的台幣。
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
  planned_transfer_on: string | null; payout_account: string | null;
  currency: string; fx_rate: number;
  purchase_request_items?: Item[];
};
type AccountCode = { code: string; name: string };
type Estate = { id: string; name: string };
type PayAccount = { code: string; name: string; method: string };
type Profile = { id: string; name: string; role: string };

const FREE_THRESHOLD = 3000;   // 與 migration 的 pr_apply_status() 一致
const PAY_LABEL: Record<string, string> = { cash: '現金', transfer: '匯款', credit_card: '信用卡' };
const PAY_OPTS = ['cash', 'transfer', 'credit_card'];
// 信用卡是「刷」不是「匯」，同一個欄位在兩種付款方式下要用不同說法
const dateWord = (m?: string | null) => (m === 'credit_card' ? '刷卡日' : '出款日');
const acctWord = (m?: string | null) => (m === 'credit_card' ? '刷卡卡片' : '出款帳號');
const CURRENCIES = ['TWD', 'USD', 'JPY', 'CNY', 'EUR'];
const PURCHASE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc3ZE8jE6dIDTzrrDDeYYL6EcMKUniPRhhhKXCRbWddGt4bbw/viewform';
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
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
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
  const [dateAcct, setDateAcct] = useState('');
  const [planning, setPlanning] = useState<Req | null>(null);
  const [planDate, setPlanDate] = useState('');
  const [planAcct, setPlanAcct] = useState('');

  const [stF, setStF] = useState('');
  const [reqF, setReqF] = useState('');
  // 月份是主要的時間軸(依建立日)。空字串 = 全部期間。
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [estateF, setEstateF] = useState('');
  const [methodF, setMethodF] = useState('');
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'created_at', dir: 'desc' });
  // 匯款排程獨立查詢:它看的是「預定付款日」,跟列表的「建立日」是兩條時間軸。
  // 上個月建的單可能排在這個月付,混在同一個查詢裡會漏掉。
  const [schedule, setSchedule] = useState<Req[]>([]);
  const [detail, setDetail] = useState<Req | null>(null);
  // 新單還沒有 id，憑證要等母單建立後才傳得上去 —— 存檔時呼叫 flush()
  const receiptsRef = useRef<ReceiptsHandle>(null);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setMe({ id: user.id, role: data?.role ?? 'housekeeper' });
    })();
    supabase.from('account_codes').select('code, name').order('sort').then(({ data }) => setCodes(data ?? []));
    supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name').then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method')
      .eq('for_payment', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
    supabase.from('profiles').select('id, name, role').then(({ data }) => setPeople(data ?? []));
  }, [supabase]);

  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const personName = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);
  // 資料庫存的是 code（如 8088），畫面上要顯示可讀的名稱（如 元大 8088）
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);

  const role = me?.role ?? '';
  const isManager = role === 'manager';
  const isAdmin = role === 'super_admin';
  const isAccountant = role === 'accountant';
  const canSeeAll = isManager || isAdmin || isAccountant;
  // 排匯款與匯出:主管、總經理、會計都能操作。會計不能核可,但能安排與執行付款。
  const canSetDate = isManager || isAdmin || isAccountant;

  /** 月份字串 YYYY-MM → [起, 迄) 兩個日期字串 */
  function monthRange(m: string): [string, string] {
    const [y, mo] = m.split('-').map(Number);
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    return [`${m}-01`, next];
  }

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('purchase_requests')
      .select('*, purchase_request_items(*)')
      .order('created_at', { ascending: false });
    if (stF) q = q.eq('status', stF);
    if (reqF) q = q.eq('requester_id', reqF);
    if (month) {
      const [from, to] = monthRange(month);
      q = q.gte('created_at', from).lt('created_at', to);
    }
    const { data, error } = await q;
    if (error) flash('載入失敗:' + error.message);
    setRows((data as Req[]) ?? []);

    // 匯款排程:該月要付出去、但還沒付的單。不受列表其他篩選影響 ——
    // 它回答的是「這個月還要準備多少錢」,那跟你正在看誰的單無關。
    if (month) {
      const [from, to] = monthRange(month);
      const { data: sc } = await supabase.from('purchase_requests')
        .select('*, purchase_request_items(*)')
        .eq('status', 'approved').is('purchased_on', null)
        .gte('planned_transfer_on', from).lt('planned_transfer_on', to)
        .order('planned_transfer_on');
      setSchedule((sc as Req[]) ?? []);
    } else setSchedule([]);
    setLoading(false);
  }, [supabase, stF, reqF, month]);
  useEffect(() => { load(); }, [load]);

  // 從分享連結進來(?req=PR-YYYYMM-NNN)時,自動打開那張單的抽屜。
  // 月份預設是本月,若該單不在本月會找不到,所以先把月份篩選清掉。
  const [pendingReqNo, setPendingReqNo] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search).get('req');
    if (!q) return;
    setPendingReqNo(q);
    setMonth('');
    // 網址列留著 ?req= 會讓重新整理又跳出抽屜,處理完就清掉
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (!pendingReqNo || loading) return;
    const hit = rows.find((r) => r.req_no === pendingReqNo);
    if (hit) { setDetail(hit); setPendingReqNo(null); }
    else if (rows.length) { flash(`找不到單號 ${pendingReqNo}`); setPendingReqNo(null); }
  }, [pendingReqNo, rows, loading]);

  const SORT_COLS: SortCols<Req> = useMemo(() => ({
    req_no:       { type: 'text',   get: (r) => r.req_no },
    created_at:   { type: 'date',   get: (r) => r.created_at },
    total_amount: { type: 'number', get: (r) => r.total_amount },
    purchased_on: { type: 'date',   get: (r) => r.purchased_on },
    planned_transfer_on: { type: 'date', get: (r) => r.planned_transfer_on },
    status:       { type: 'text',   get: (r) => ST_LABEL[r.status] ?? r.status },
  }), []);
  // 物業與關鍵字要看子項目,做不成 Supabase 的欄位條件,改在前端篩。
  // 請款單數量不大(一個月幾十張),不需要為此改成伺服器端分頁。
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return rows.filter((r) => {
      if (methodF && r.payment_method !== methodF) return false;
      const its = r.purchase_request_items ?? [];
      if (estateF && !its.some((i) => i.estate_id === estateF)) return false;
      if (k) {
        const hay = [
          r.req_no, r.note, r.payee_company, r.payee_account,
          ...its.map((i) => i.item_name), ...its.map((i) => i.note),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(k)) return false;
      }
      return true;
    });
  }, [rows, methodF, estateF, kw]);

  const sorted = useMemo(() => sortRows(filtered, sort, SORT_COLS), [filtered, sort, SORT_COLS]);

  // 待辦佇列:兩票獨立,各自列出「還缺這一票」的單
  const waitManager = useMemo(() => filtered.filter((r) => r.status === 'pending' && !r.manager_approved_at), [filtered]);
  const waitAdmin = useMemo(() => filtered.filter((r) => r.status === 'pending' && !r.admin_approved_at), [filtered]);
  // 待排付款:匯款/信用卡且還沒排。現金沒有這個階段,所以排除。
  const waitPlan = useMemo(() => filtered.filter((r) =>
    r.status === 'approved' && !r.purchased_on && !r.planned_transfer_on
    && (r.payment_method === 'transfer' || r.payment_method === 'credit_card')), [filtered]);
  // 待支付:現金核可後即可付;匯款/信用卡要排過才算
  const waitDate = useMemo(() => filtered.filter((r) =>
    r.status === 'approved' && !r.purchased_on
    && (r.payment_method === 'cash' || !!r.planned_transfer_on)), [filtered]);
  const sum = (xs: Req[]) => xs.reduce((a, r) => a + (Number(r.total_amount) || 0), 0);

  // 金額卡:依目前篩選結果,排除草稿與已駁回(那些不算數)
  const counted = useMemo(() => filtered.filter((r) => r.status === 'pending' || r.status === 'approved'), [filtered]);
  const byMethod = useMemo(() => ({
    cash: counted.filter((r) => r.payment_method === 'cash'),
    transfer: counted.filter((r) => r.payment_method === 'transfer'),
    credit_card: counted.filter((r) => r.payment_method === 'credit_card'),
  }), [counted]);

  // 匯款排程:日期 × 帳號 分組
  const scheduleRows = useMemo(() => {
    const m: Record<string, { date: string; acct: string; n: number; amt: number }> = {};
    schedule.forEach((r) => {
      const key = `${r.planned_transfer_on}|${r.payout_account ?? '—'}`;
      if (!m[key]) m[key] = { date: r.planned_transfer_on ?? '', acct: r.payout_account ?? '—', n: 0, amt: 0 };
      m[key].n += 1;
      m[key].amt += Number(r.total_amount) || 0;
    });
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date) || a.acct.localeCompare(b.acct));
  }, [schedule]);

  function blankItem(): Item {
    return { item_name: '', amount: 0, amount_original: 0, account_code: null, purpose_type: 'estate', estate_id: null, note: null, sort: 0 };
  }

  function openNew() {
    setEdit({
      id: '', req_no: '', requester_id: me?.id ?? '', status: 'draft', total_amount: 0,
      payment_method: 'cash', payee_bank_code: null, payee_account: null, payee_company: null, payee_tax_id: null,
      note: null, submitted_at: null, manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null, rejected_by: null, rejected_at: null, reject_reason: null,
      purchased_on: null, expense_generated_at: null, created_at: '',
      planned_transfer_on: null, payout_account: null,
      currency: 'TWD', fx_rate: 1,
    });
    setItems([blankItem()]);
  }

  function openEdit(r: Req) {
    setEdit(r);
    const its = (r.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
    setItems(its.length ? its : [blankItem()]);
  }

  // 使用者輸入的是原幣別金額,台幣總額 = 原幣合計 × 匯率。
  // 台幣單的匯率是 1,所以兩者相等,不用寫兩套邏輯。
  const fxRate = Number(edit?.fx_rate) || 1;
  const editSubtotal = useMemo(() => items.reduce((a, i) => a + (Number(i.amount_original) || 0), 0), [items]);
  const editTotal = useMemo(() => Math.round(editSubtotal * fxRate), [editSubtotal, fxRate]);

  async function save(submit: boolean) {
    if (!edit || !me) return;
    const clean = items.filter((i) => i.item_name.trim() || Number(i.amount_original) > 0);
    if (!clean.length) return flash('至少要有一個請款項目');
    for (const i of clean) {
      if (!i.item_name.trim()) return flash('每個項目都要填名稱');
      if (!(Number(i.amount_original) > 0)) return flash(`「${i.item_name}」請填金額`);
      if (i.purpose_type === 'estate' && !i.estate_id) return flash(`「${i.item_name}」請選擇用途`);
    }
    if (edit.payment_method === 'transfer' && !edit.payee_account) return flash('匯款需填收款帳號');
    if (edit.currency !== 'TWD' && !(fxRate > 0)) return flash('請填匯率');
    const needsPayout = edit.payment_method === 'transfer' || edit.payment_method === 'credit_card';
    // 送審中的單被改動,既有的票就不算數了 —— 有人投過票的話先問一聲
    const wasPending = !!edit.id && edit.status === 'pending';
    const hadVotes = !!edit.manager_approved_at || !!edit.admin_approved_at;
    if (wasPending && hadVotes && !confirm('這張單已經有人核可。存檔會清掉既有核可票並重新送審,確定嗎?')) return;
    setSaving(true);
    try {
      const header: any = {
        payment_method: edit.payment_method || null,
        payee_bank_code: edit.payee_bank_code || null,
        payee_account: edit.payee_account || null,
        payee_company: edit.payee_company || null,
        payee_tax_id: edit.payee_tax_id || null,
        note: edit.note || null,
        currency: edit.currency || 'TWD',
        fx_rate: edit.currency === 'TWD' ? 1 : fxRate,
        // 現金沒有出款帳號，換了付款方式要把舊值清掉，否則會違反 pr_planned_chk
        payout_account: needsPayout ? (edit.payout_account || null) : null,
        planned_transfer_on: needsPayout ? (edit.planned_transfer_on || null) : null,
        // 送審中被編輯:退回草稿並清空核可票。
        // 退回 draft 有兩個作用 —— 項目的 pri_write policy 只認 draft/rejected,
        // 而且之後再送 pending 會走既有狀態機,免核門檻依「新金額」重算。
        ...(wasPending ? {
          status: 'draft',
          manager_approved_by: null, manager_approved_at: null,
          admin_approved_by: null, admin_approved_at: null,
        } : {}),
      };
      let reqId = edit.id;
      let newReqNo = '';
      const isCreate = !reqId;
      if (!reqId) {
        const { data: no, error: ne } = await supabase.rpc('next_req_no');
        if (ne) { flash('取單號失敗:' + ne.message); return; }
        const { data, error } = await supabase.from('purchase_requests')
          .insert({ ...header, req_no: no, requester_id: me.id, status: 'draft' }).select('id, req_no').single();
        if (error) { flash('建立失敗:' + error.message); return; }
        reqId = data.id;
        newReqNo = data.req_no;
      } else {
        const { error } = await supabase.from('purchase_requests').update(header).eq('id', reqId);
        if (error) { flash('儲存失敗:' + error.message); return; }
        await supabase.from('purchase_request_items').delete().eq('request_id', reqId);
      }
      // amount 一律存台幣,amount_original 存使用者輸入的原幣別金額。
      // 換算在這裡一次做完,資料庫不會有「一半換過一半沒換」的中間狀態。
      const payload = clean.map((i, idx) => ({
        request_id: reqId, item_name: i.item_name.trim(),
        amount_original: Number(i.amount_original) || 0,
        amount: Math.round((Number(i.amount_original) || 0) * (edit.currency === 'TWD' ? 1 : fxRate)),
        account_code: i.account_code || null, purpose_type: i.purpose_type,
        estate_id: i.purpose_type === 'office' ? null : i.estate_id,
        note: i.note || null, sort: idx,
      }));
      const { error: ie } = await supabase.from('purchase_request_items').insert(payload);
      if (ie) { flash('項目儲存失敗:' + ie.message); return; }

      // 填表時選的憑證留在瀏覽器裡，母單有 id 了才真正上傳
      const fe = await receiptsRef.current?.flush(reqId);
      if (fe) { flash('憑證' + fe); return; }

      if (submit) {
        // 狀態一律送 'pending'。免核門檻由資料庫觸發器判斷後自行翻成 approved,
        // 前端不自己算 —— 否則改前端就能繞過門檻。
        const { error: se } = await supabase.from('purchase_requests').update({ status: 'pending' }).eq('id', reqId);
        if (se) { flash('送出失敗:' + se.message); return; }
        const head = wasPending ? '已重新送審' : '已送出';
        flash(editTotal < FREE_THRESHOLD ? `${head}・未達 $${fmt(FREE_THRESHOLD)},自動核可` : `${head},等待主管與總經理核可`);
        setEdit(null); load();
      } else {
        flash(wasPending ? '已存為草稿・原本的核可已清空,記得再送出審核' : '已儲存草稿');
        // 新建的草稿存完留在原地,讓人可以接著補憑證或直接送審
        if (isCreate) setEdit({ ...edit, id: reqId, req_no: newReqNo, status: 'draft' });
        else setEdit(null);
        load();
      }
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
    if (!dateVal) return flash('請選擇日期');
    // 匯款/信用卡一定要記錄從哪個帳戶付出去。
    // 這個檢查放在「匯出」而不是「排匯款」—— 排匯款可以跳過,匯出不行,
    // 把必填綁在可跳過的步驟上,等於沒綁。
    const needAcct = dating.payment_method === 'transfer' || dating.payment_method === 'credit_card';
    if (needAcct && !dateAcct) return flash('請選擇匯出帳號');
    const patch: Record<string, unknown> = { purchased_on: dateVal };
    if (needAcct) patch.payout_account = dateAcct;
    const { error } = await supabase.from('purchase_requests').update(patch).eq('id', dating.id);
    if (error) return flash('儲存失敗:' + error.message);
    setDating(null);
    flash(dating.purchased_on ? '已更新,連動支出的日期一併調整' : '已匯出,費用已連動到支出');
    load();
  }

  // 排匯款:只寫計畫欄位,不碰 purchased_on —— 錢還沒出去,不該產生支出
  async function savePlan() {
    if (!planning) return;
    if (!planDate) return flash('請選擇預定匯款日');
    if (!planAcct) return flash('請選擇匯出帳號');
    const { error } = await supabase.from('purchase_requests')
      .update({ planned_transfer_on: planDate, payout_account: planAcct }).eq('id', planning.id);
    if (error) return flash('儲存失敗:' + error.message);
    setPlanning(null); flash('已排定匯款'); load();
  }

  // 撤銷 = 硬刪除。已產生支出的單一律擋下 —— 支出是錢真的花掉的紀錄,
  // 連動刪除會讓請款單與支出兩邊對不上,而且 gen_expenses_from_pr() 只在
  // 採購日「從無到有」時建立,刪掉救不回來。這條同時寫在 RLS 裡,不只靠前端藏按鈕。
  async function cancel(r: Req) {
    if (r.expense_generated_at) return flash('已產生支出,不能撤銷。請到支出頁處理。');
    if (!confirm(`確定撤銷請款單 ${r.req_no}?撤銷後資料不會保留。`)) return;
    const { error } = await supabase.from('purchase_requests').delete().eq('id', r.id);
    if (error) return flash('撤銷失敗:' + error.message);
    flash('已撤銷'); load();
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
          T(i ? (i.purpose_type === 'office' ? '安幸辦公室' : (i.estate_id ? estateName[i.estate_id] ?? '' : '')) : '', stCell),
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
    const tag = [ST_LABEL[stF] ?? '', reqF ? personName[reqF] ?? '' : '',
      estateF ? estateName[estateF] ?? '' : '', methodF ? PAY_LABEL[methodF] ?? '' : '',
      month, kw].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `請款單${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  // 桌機表格與手機卡片共用同一份權限判斷 —— 分開寫遲早會有一邊漏改
  function perms(r: Req) {
    const mine = r.requester_id === me?.id;
    return {
      mine,
      // 核可前都能改。approved 之後不行 —— 錢要出去了,改內容等於繞過審核。
      // 送審中(pending)存檔會清掉既有核可票並重新送審,見 save()。
      // 總經理可以改別人的單(RLS 本來就允許);主管與會計只能改自己送的。
      canEdit: (mine || isAdmin) && (r.status === 'draft' || r.status === 'rejected' || r.status === 'pending'),
      // 開放自核:主管送的單那一票由他自己投,不再要求第二人。
      canVoteMgr: isManager && r.status === 'pending' && !r.manager_approved_at,
      canVoteAdm: isAdmin && r.status === 'pending' && !r.admin_approved_at,
      canRej: (isManager || isAdmin) && r.status === 'pending',
      // 匯款與信用卡一定要先排付款(選日期與帳號/卡別)才能確認支付。
      // 順序不強制的話,可以跳過排付款直接確認,結果是付了錢卻不知道從哪個帳戶出去。
      needPlan: r.payment_method === 'transfer' || r.payment_method === 'credit_card',
      canPlan: canSetDate && r.status === 'approved' && !r.purchased_on
               && (r.payment_method === 'transfer' || r.payment_method === 'credit_card'),
      canDate: canSetDate && r.status === 'approved'
               && (r.payment_method === 'cash' || !!r.planned_transfer_on || !!r.purchased_on),
      // 撤銷:提交者本人 / 主管 / 會計 / 總經理,任何狀態皆可,已產生支出除外
      canCancel: (mine || isManager || isAccountant || isAdmin) && !r.expense_generated_at,
    };
  }

  // 不要寫成三元運算子回傳 fragment —— `: <>` 會被 SWC 當成型別註記開頭而解析失敗
  function voteLine(r: Req) {
    if (r.status === 'approved' && !r.manager_approved_at && !r.admin_approved_at) {
      return <span className="text-gray-400">未達門檻免核</span>;
    }
    return (
      <>
        <div className={r.manager_approved_at ? 'text-mor-green' : 'text-gray-400'}>
          {r.manager_approved_at ? '✓' : '○'} 主管{r.manager_approved_by ? `・${personName[r.manager_approved_by] ?? ''}` : ''}
        </div>
        <div className={r.admin_approved_at ? 'text-mor-green' : 'text-gray-400'}>
          {r.admin_approved_at ? '✓' : '○'} 總經理{r.admin_approved_by ? `・${personName[r.admin_approved_by] ?? ''}` : ''}
        </div>
      </>
    );
  }

  /**
   * 分享請款單到 LINE,讓主管直接點連結進來核可。
   * 連結帶 ?req=單號,對方開啟後會自動跳到那張單並展開抽屜 ——
   * 只給網址的話對方還要自己找,單號一多就找不到。
   */
  function shareReq(r: Req) {
    const items = (r.purchase_request_items ?? []).map((i) => i.item_name).filter(Boolean).join('、');
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/purchases?req=${encodeURIComponent(r.req_no)}`;
    const text = [
      r.status === 'pending' ? '🧾 請款單待核可' : '🧾 請款單',
      '',
      r.req_no,
      `NT$ ${fmt(r.total_amount)}`,
      '',
      `申請人　${personName[r.requester_id] ?? '—'}`,
      `項目　　${items || '—'}`,
      `支出方式　${r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '—'}`,
      '',
      '前往核可',
      url,
    ].join('\n');

    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: '請款單 ' + r.req_no, text }).catch(() => {});
      return;
    }
    window.open('https://line.me/R/msg/text/?' + encodeURIComponent(text), '_blank', 'noopener');
  }

  const card = (title: string, list: Req[], hint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-left rounded-xl border border-mor-line bg-white p-2.5 md:p-4 min-w-0 hover:bg-mor-sand/40 transition-colors">
      <div className="text-xs md:text-sm font-medium leading-tight">{title}</div>
      <div className="stat-num font-bold mt-1">{list.length}<span className="text-xs md:text-sm font-normal text-gray-400 ml-1">筆</span></div>
      <div className="text-[11px] md:text-xs text-gray-500 mt-0.5 md:mt-1">${fmt(sum(list))}</div>
      <div className="hidden md:block text-[11px] text-gray-400 mt-1">{hint}</div>
    </button>
  );

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-4 py-2 text-sm">{msg}</div>}
      {/* 手機上標題由頂列顯示,這裡只留桌機用 */}
      <h1 className="hidden md:block text-xl font-bold mb-4">請款填寫</h1>

      <PushToggle />

      {/* 手機:主要動作放最上面,一按就能送單 */}
      <div className="md:hidden flex gap-2 mb-3">
        <button onClick={openNew}
          className="flex-1 h-12 rounded-xl bg-mor-slate text-white font-medium active:bg-mor-slatedark">
          + 填寫請款
        </button>
        <a href={PURCHASE_FORM_URL} target="_blank" rel="noreferrer"
          className="flex-1 h-12 rounded-xl border border-mor-line bg-white font-medium flex items-center justify-center active:bg-mor-sand/60">
          + 採購單
        </a>
      </div>

      {canSeeAll && (
        <>
          {/* 上排:該做什麼 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 mb-2 md:mb-3">
            {card('待主管核可', waitManager, isManager ? '你可以核可' : '等待主管投票', () => setStF('pending'))}
            {card('待總經理核可', waitAdmin, isAdmin ? '你可以核可' : '等待總經理投票', () => setStF('pending'))}
            {card('待排付款', waitPlan, '選日期與帳號', () => setStF('approved'))}
            {card('待支付', waitDate, '支付後才會產生支出', () => setStF('approved'))}
          </div>

          {/* 下排:多少錢。依建立日所屬月份 + 目前篩選,不含草稿與已駁回。 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 mb-4 md:mb-5">
            {card(`申請總額${month ? `・${month}` : ''}`, counted, '依建立日', () => {})}
            {card('現金', byMethod.cash, '', () => setMethodF('cash'))}
            {card('匯款', byMethod.transfer, '', () => setMethodF('transfer'))}
            {card('信用卡', byMethod.credit_card, '', () => setMethodF('credit_card'))}
          </div>

          {/* 匯款排程:依預定付款日,獨立於上面的篩選 */}
          {scheduleRows.length > 0 && (
            <div className="rounded-xl border border-mor-line bg-white mb-4 md:mb-5 overflow-hidden">
              <div className="px-4 py-2.5 text-sm font-medium border-b border-mor-line bg-mor-sand/40 flex items-center justify-between">
                <span>{month} 付款排程</span>
                <span className="text-xs font-normal text-gray-500">
                  依預定付款日・尚未支付・共 NT$ {fmt(scheduleRows.reduce((a, s) => a + s.amt, 0))}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-mor-line/60">
                    <th className="px-4 py-2">預定付款日</th>
                    <th className="px-4 py-2">帳號 / 卡別</th>
                    <th className="px-4 py-2 text-right">筆數</th>
                    <th className="px-4 py-2 text-right">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduleRows.map((s) => (
                    <tr key={s.date + s.acct} className="border-b border-mor-line/40 last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap">{s.date}</td>
                      <td className="px-4 py-2">{s.acct}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{s.n}</td>
                      <td className="px-4 py-2 text-right font-medium">NT$ {fmt(s.amt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 工具列 —— 手機只留狀態篩選,其餘收在 details 裡 */}
      <details className="md:hidden mb-3 rounded-xl border border-mor-line bg-white">
        <summary className="px-4 py-3 text-sm text-gray-600 cursor-pointer select-none">
          篩選{(stF || reqF || estateF || methodF || kw) ? '（已套用）' : ''}・共 {sorted.length.toLocaleString()} 筆
        </summary>
        <div className="px-4 pb-4 flex flex-col gap-3 text-sm border-t border-mor-line pt-3">
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
            <select value={stF} onChange={(e) => setStF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部狀態</option>
              {Object.entries(ST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {canSeeAll && (
            <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">申請人</span>
              <select value={reqF} onChange={(e) => setReqF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
                <option value="">全部</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          )}
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
            <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部物業</option>
              {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
            <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部方式</option>
              {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
            </select></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">月份(建立日)</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字</span>
            <div className="flex gap-1">
              <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }}
                placeholder="單號/項目/備註/廠商" className="flex-1 min-w-0 h-12 rounded-lg border border-mor-line px-2" />
              <button onClick={() => setKw(kwIn.trim())} className="h-12 px-4 rounded-lg bg-mor-slate text-white">搜尋</button>
            </div></label>
          <div className="flex gap-2">
            {(stF || reqF || estateF || methodF || kw) &&
              <button onClick={() => { setStF(''); setReqF(''); setEstateF(''); setMethodF(''); setKw(''); setKwIn(''); }}
                className="flex-1 h-12 rounded-lg border border-mor-line text-gray-600">清除篩選</button>}
            <button onClick={exportXlsx} disabled={!sorted.length}
              className="flex-1 h-12 rounded-lg border border-mor-line disabled:opacity-40">⬇ Excel</button>
          </div>
        </div>
      </details>

      {/* 工具列 —— 桌機 */}
      <div className="hidden md:flex flex-wrap items-end gap-2 mb-3 text-sm">
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
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5 max-w-32">
            <option value="">全部物業</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
          <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部方式</option>
            {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">月份(建立日)</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字</span>
          <div className="flex">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }}
              placeholder="單號/項目/備註/廠商" className="rounded-l-lg border border-mor-line px-2 py-1.5 w-40" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-r-lg bg-mor-slate text-white px-3">搜尋</button>
          </div></label>
        {(stF || reqF || estateF || methodF || kw) &&
          <button onClick={() => { setStF(''); setReqF(''); setEstateF(''); setMethodF(''); setKw(''); setKwIn(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-2">
          <div className="text-xs text-gray-400 pb-1.5">共 {sorted.length.toLocaleString()} 筆</div>
          <button onClick={exportXlsx} disabled={!rows.length}
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">⬇ 下載 Excel</button>
          <a href={PURCHASE_FORM_URL} target="_blank" rel="noreferrer"
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60">+ 採購單</a>
          <button onClick={openNew} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 填寫請款</button>
        </div>
      </div>

      {/* 列表 —— 手機卡片版 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="rounded-xl border border-mor-line bg-white py-10 text-center text-gray-400 text-sm">載入中…</div>
        : sorted.length === 0 ? <div className="rounded-xl border border-mor-line bg-white py-10 text-center text-gray-400 text-sm">無請款單</div>
        : sorted.map((r) => {
          const { canVoteMgr, canVoteAdm } = perms(r);
          return (
            // 卡片本體可點開抽屜,底下只留核可與分享,其餘操作都在抽屜內
            <div key={r.id} className="rounded-xl border border-mor-line bg-white p-3">
              <div onClick={() => setDetail(r)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{personName[r.requester_id] ?? '—'}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.created_at ? r.created_at.slice(0, 10) : ''}・{(r.purchase_request_items ?? []).length} 個項目
                      {r.payment_method ? `・${PAY_LABEL[r.payment_method] ?? r.payment_method}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold">${fmt(r.total_amount)}</div>
                    <span className={`inline-block mt-1 rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[r.status]}`}>
                      {ST_LABEL[r.status] ?? r.status}
                    </span>
                  </div>
                </div>

                <div className="mt-2 text-sm text-gray-600 line-clamp-2">
                  {(r.purchase_request_items ?? []).map((i) => i.item_name).join('、') || '—'}
                </div>

                {r.status === 'rejected' && r.reject_reason &&
                  <div className="mt-2 rounded-lg bg-red-50 text-red-600 px-2 py-1.5 text-xs">駁回原因:{r.reject_reason}</div>}

                <div className="mt-2 flex items-center justify-between text-xs">
                  <div>{voteLine(r)}</div>
                  <div className="text-gray-500 shrink-0 text-right">
                    {r.purchased_on
                      ? <>付款日 {r.purchased_on}</>
                      : r.planned_transfer_on
                        ? <span className="text-mor-blue">預定 {r.planned_transfer_on}{r.payout_account ? `・${acctName[r.payout_account] ?? r.payout_account}` : ''}</span>
                        : null}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                {(canVoteMgr || canVoteAdm) && (
                  <button onClick={() => vote(r)}
                    className="flex-1 h-12 rounded-lg bg-mor-green text-white text-sm font-medium active:opacity-80">核可</button>
                )}
                <button onClick={() => shareReq(r)}
                  className="flex-1 h-12 rounded-lg border border-mor-line text-sm font-medium active:bg-mor-sand/60">↗ 分享</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 列表 —— 桌機表格版 */}
      <div className="hidden md:block rounded-xl border border-mor-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
              <SortTh label="建立日" sortKey="created_at" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">申請人</th>
              <th className="px-3 py-2.5">項目</th>
              <SortTh label="總額" sortKey="total_amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <th className="px-3 py-2.5">支出方式</th>
              <SortTh label="狀態" sortKey="status" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="付款日" sortKey="purchased_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">無請款單</td></tr>
            : sorted.map((r) => {
              const { canVoteMgr, canVoteAdm } = perms(r);
              return (
                // 整列可點開抽屜。列上只留「核可」與「分享」——
                // 核可是最高頻的動作,分享是要拉主管進來的動作,其餘都在抽屜裡。
                <tr key={r.id} onClick={() => setDetail(r)}
                  className="border-b border-mor-line/60 hover:bg-mor-bluelight/30 align-top cursor-pointer">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.created_at ? r.created_at.slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{personName[r.requester_id] ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-64">
                    <div className="truncate" title={(r.purchase_request_items ?? []).map((i) => i.item_name).join('、')}>
                      {(r.purchase_request_items ?? []).map((i) => i.item_name).join('、') || '—'}
                    </div>
                    <div className="text-[11px] text-gray-400">{(r.purchase_request_items ?? []).length} 個項目</div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    ${fmt(r.total_amount)}
                    {r.currency && r.currency !== 'TWD' && (
                      <div className="text-[11px] font-normal text-gray-400">{r.currency} × {r.fx_rate}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '—'}
                    {r.payout_account && <div className="text-[11px] text-gray-400">{r.payout_account}</div>}
                  </td>
                  {/* 狀態與核可進度合併成一欄 */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[r.status]}`}>{ST_LABEL[r.status] ?? r.status}</span>
                    <div className="text-[11px] mt-1">{voteLine(r)}</div>
                    {r.status === 'rejected' && r.reject_reason &&
                      <div className="text-[11px] text-red-500 mt-1 max-w-40 truncate" title={r.reject_reason}>{r.reject_reason}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.purchased_on ?? (r.planned_transfer_on
                      ? <span className="text-mor-blue text-xs">預定 {r.planned_transfer_on}</span>
                      : '—')}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-2" onClick={(e) => e.stopPropagation()}>
                    {(canVoteMgr || canVoteAdm) && <button onClick={() => vote(r)} className="text-xs text-mor-green underline hover:text-mor-slate font-medium">核可</button>}
                    <button onClick={() => shareReq(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">分享</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 詳細資訊抽屜 —— 列表精簡掉的欄位與所有操作都在這裡 */}
      {detail && (() => {
        const d = detail;
        const p = perms(d);
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        const its = (d.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
        const btn = 'flex-1 min-w-[5rem] h-11 rounded-lg text-sm font-medium';
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold">{d.req_no}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {personName[d.requester_id] ?? '—'}・{d.created_at ? d.created_at.slice(0, 10) : ''}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('狀態', (
                  <span>
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[d.status]}`}>{ST_LABEL[d.status] ?? d.status}</span>
                    <div className="text-xs mt-1">{voteLine(d)}</div>
                    {d.status === 'rejected' && d.reject_reason && <div className="text-xs text-red-500 mt-1">駁回原因:{d.reject_reason}</div>}
                  </span>
                ))}
                {row('總額', (
                  <span>
                    <span className="font-medium">NT$ {fmt(d.total_amount)}</span>
                    {d.currency !== 'TWD' && <div className="text-xs text-gray-400">{d.currency} × 匯率 {d.fx_rate}</div>}
                  </span>
                ))}
                {row('支出方式', (
                  <span>
                    {d.payment_method ? PAY_LABEL[d.payment_method] ?? d.payment_method : '—'}
                    {d.payout_account && <span className="text-gray-500 ml-1">・{acctName[d.payout_account] ?? d.payout_account}</span>}
                  </span>
                ))}
                {d.payee_account ? row('收款方', (
                  <span className="text-xs">
                    {d.payee_company ?? ''} {d.payee_bank_code ?? ''} {d.payee_account}
                    {d.payee_tax_id ? <div>統編 {d.payee_tax_id}</div> : null}
                  </span>
                )) : null}
                {row(`預定${dateWord(d.payment_method)}`, d.planned_transfer_on ?? '—')}
                {row(`確認${dateWord(d.payment_method)}`, d.purchased_on ?? '—')}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}

                {/* 審核者最需要的就是看發票,放在項目上方 */}
                <div className="mt-3"><Receipts kind="pr" parentId={d.id} canEdit={p.canEdit} label="憑證圖片" /></div>

                <div className="mt-4 text-xs text-gray-400 mb-1">請款項目（{its.length}）</div>
                <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40">
                  {its.map((i, idx) => (
                    <div key={idx} className="px-3 py-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{i.item_name}</span>
                        <span className="shrink-0">
                          {d.currency !== 'TWD' && <span className="text-xs text-gray-400 mr-1">{d.currency} {fmt(i.amount_original ?? 0)}</span>}
                          NT$ {fmt(i.amount)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {i.account_code ? codeName[i.account_code] ?? i.account_code : '未分類'}
                        ・{i.purpose_type === 'office' ? '安幸辦公室' : (i.estate_id ? estateName[i.estate_id] ?? '' : '')}
                        {i.note ? `・${i.note}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex flex-wrap gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setDetail(null); openEdit(d); }}
                  className={`${btn} border border-mor-line`}>{p.canEdit ? '編輯' : '檢視內容'}</button>
                {(p.canVoteMgr || p.canVoteAdm) && (
                  <button onClick={() => { vote(d); setDetail(null); }} className={`${btn} bg-mor-green text-white`}>核可</button>
                )}
                {p.canRej && (
                  <button onClick={() => { setDetail(null); setRejecting(d); setRejectReason(''); }}
                    className={`${btn} border border-amber-400 text-amber-700`}>駁回</button>
                )}
                {p.canPlan && (
                  <button onClick={() => { setDetail(null); setPlanning(d); setPlanDate(d.planned_transfer_on ?? todayStr()); setPlanAcct(d.payout_account ?? ''); }}
                    className={`${btn} border border-mor-slate text-mor-slate`}>{d.planned_transfer_on ? '改付款計畫' : `排${dateWord(d.payment_method)}`}</button>
                )}
                {p.canDate && (
                  <button onClick={() => { setDetail(null); setDating(d); setDateVal(d.purchased_on ?? d.planned_transfer_on ?? todayStr()); setDateAcct(d.payout_account ?? ''); }}
                    className={`${btn} border border-mor-blue text-mor-blue`}>{d.purchased_on ? `改${dateWord(d.payment_method)}` : `確認${dateWord(d.payment_method)}`}</button>
                )}
                {p.canCancel && (
                  <button onClick={() => { cancel(d); setDetail(null); }} className={`${btn} border border-red-300 text-red-500`}>撤銷</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 請款單表單 */}
      {edit && (() => {
        // pending 也開放編輯。存檔會清票重送審 —— 判斷邏輯要跟 perms().canEdit 一致
        const readOnly = !((edit.requester_id === me?.id || isAdmin)
          && (edit.status === 'draft' || edit.status === 'rejected' || edit.status === 'pending' || !edit.id));
        const editingPending = !readOnly && edit.status === 'pending';
        // 手機:整頁式(貼齊上下邊)。桌機:置中對話框
        return (
          <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50" onClick={() => setEdit(null)}>
            <div className="bg-white w-full md:w-[760px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0" onClick={(e) => e.stopPropagation()}>
              <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between z-10"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                {edit.id ? `請款單 ${edit.req_no}` : '填寫請款'}
                <button onClick={() => setEdit(null)} aria-label="關閉"
                  className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>
              <div className="p-4 md:p-6 space-y-4 text-sm">
                {editingPending && (
                  <div className="rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs">
                    這張單審核中。存檔後既有的核可會被清空,需要重新走一次審核。
                    {edit.requester_id !== me?.id && `（申請人:${personName[edit.requester_id] ?? '—'}）`}
                  </div>
                )}
                {readOnly && edit.id && (
                  <div className="rounded-lg bg-mor-sand/60 text-gray-600 px-3 py-2 text-xs">
                    {edit.status === 'approved' ? '已核可的單不可再編輯,只能安排匯款與確認付款日。' : '此單目前不可編輯。'}
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
                          <input disabled={readOnly} value={it.item_name} placeholder="項目名稱 *"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, item_name: e.target.value } : x))}
                            className="flex-1 min-w-0 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" />
                          <div className="relative w-28 md:w-32 shrink-0">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                              {edit.currency === 'TWD' ? 'NT$' : edit.currency}
                            </span>
                            {/* 值用字串保存,不是 Number(0) —— 否則欄位永遠顯示 0,
                                打字時新數字會接在 0 後面變成 0500。空字串才能被直接取代。 */}
                            <input disabled={readOnly} type="number" inputMode="decimal" min="0"
                              value={it.amount_original === 0 || it.amount_original == null ? '' : it.amount_original}
                              placeholder="金額 *"
                              onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, amount_original: e.target.value === '' ? 0 : Number(e.target.value) } : x))}
                              className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line pl-9 pr-2 md:py-1.5 text-right disabled:bg-gray-50" />
                          </div>
                          {!readOnly && items.length > 1 &&
                            <button onClick={() => setItems(items.filter((_, i) => i !== idx))} aria-label="刪除項目"
                              className="w-10 shrink-0 text-red-400 hover:text-red-600">✕</button>}
                        </div>
                        <div className="flex flex-col md:flex-row gap-2">
                          <select disabled={readOnly} value={it.account_code ?? ''}
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, account_code: e.target.value || null } : x))}
                            className="w-full md:w-36 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                            <option value="">會計科目</option>
                            {codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                          </select>
                          <select disabled={readOnly}
                            value={it.purpose_type === 'office' ? 'office' : (it.estate_id ?? '')}
                            onChange={(e) => {
                              const v = e.target.value;
                              setItems(items.map((x, i) => i === idx
                                ? (v === 'office' ? { ...x, purpose_type: 'office', estate_id: null } : { ...x, purpose_type: 'estate', estate_id: v || null })
                                : x));
                            }}
                            className="w-full md:w-auto md:flex-1 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                            <option value="">用途 *</option>
                            <option value="office">安幸辦公室</option>
                            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          <input disabled={readOnly} value={it.note ?? ''} placeholder="備註"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, note: e.target.value } : x))}
                            className="w-full md:w-auto md:flex-1 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" />
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* 幣別與匯率 */}
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">幣別</span>
                      <select disabled={readOnly} value={edit.currency ?? 'TWD'}
                        onChange={(e) => setEdit({ ...edit, currency: e.target.value, fx_rate: e.target.value === 'TWD' ? 1 : (edit.fx_rate || 0) })}
                        className="w-full md:w-auto h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></label>
                    {edit.currency !== 'TWD' && (
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">匯率 * (1 {edit.currency} = ? NTD)</span>
                        <input disabled={readOnly} type="number" inputMode="decimal" step="0.0001" min="0"
                          value={edit.fx_rate ? edit.fx_rate : ''} placeholder="例 31.5"
                          onChange={(e) => setEdit({ ...edit, fx_rate: e.target.value === '' ? 0 : Number(e.target.value) })}
                          className="w-full md:w-32 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-right disabled:bg-gray-50" /></label>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between text-sm">
                    <div className={editTotal < FREE_THRESHOLD ? 'text-mor-green text-xs' : 'text-amber-600 text-xs'}>
                      {editTotal < FREE_THRESHOLD
                        ? `未達 NT$${fmt(FREE_THRESHOLD)},送出後直接核可`
                        : `達 NT$${fmt(FREE_THRESHOLD)} 以上,需主管與總經理各核可一次`}
                    </div>
                    <div className="text-right">
                      {edit.currency !== 'TWD' && (
                        <div className="text-xs text-gray-500">{edit.currency} {fmt(editSubtotal)} × {fxRate || '—'}</div>
                      )}
                      <div className="font-bold">總額 NT$ {fmt(editTotal)}</div>
                    </div>
                  </div>
                </div>

                {/* 付款 */}
                <div className="border-t border-mor-line pt-3 space-y-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
                    <select disabled={readOnly} value={edit.payment_method ?? 'cash'}
                      onChange={(e) => setEdit({ ...edit, payment_method: e.target.value })}
                      className="w-full md:w-40 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                      {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
                    </select></label>
                  {edit.payment_method === 'transfer' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 [&_input]:h-12 md:[&_input]:h-auto [&_input]:bg-white">
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">銀行代碼</span>
                        <input disabled={readOnly} value={edit.payee_bank_code ?? ''} onChange={(e) => setEdit({ ...edit, payee_bank_code: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">入款帳號 *</span>
                        <input disabled={readOnly} value={edit.payee_account ?? ''} onChange={(e) => setEdit({ ...edit, payee_account: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">公司名／戶名</span>
                        <input disabled={readOnly} value={edit.payee_company ?? ''} onChange={(e) => setEdit({ ...edit, payee_company: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">統編</span>
                        <input disabled={readOnly} value={edit.payee_tax_id ?? ''} onChange={(e) => setEdit({ ...edit, payee_tax_id: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                    </div>
                  )}

                  {/*
                    出款帳號與預定日期：申請時就能填，但都是選填。
                    會計在核可後可以覆寫 —— 這裡填的是「打算」，不是「已付」。
                    現金沒有出款帳號可言，所以只在匯款／信用卡時出現。
                  */}
                  {(edit.payment_method === 'transfer' || edit.payment_method === 'credit_card') && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500">
                          {edit.payment_method === 'credit_card' ? '刷卡卡片' : '出款帳號'}
                          <span className="text-gray-400">（選填）</span>
                        </span>
                        <select disabled={readOnly} value={edit.payout_account ?? ''}
                          onChange={(e) => setEdit({ ...edit, payout_account: e.target.value || null })}
                          className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                          <option value="">未指定</option>
                          {payAccounts.filter((a) => a.method === edit.payment_method)
                            .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                        </select></label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500">
                          {edit.payment_method === 'credit_card' ? '預定刷卡日' : '預定出款日'}
                          <span className="text-gray-400">（選填）</span>
                        </span>
                        <input disabled={readOnly} type="date" value={edit.planned_transfer_on ?? ''}
                          onChange={(e) => setEdit({ ...edit, planned_transfer_on: e.target.value || null })}
                          className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" /></label>
                      <div className="md:col-span-2 text-xs text-gray-400">
                        核可後由會計確認實際出款日，這裡填的只是預定。
                      </div>
                    </div>
                  )}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                    <textarea disabled={readOnly} value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                      className="bg-white rounded-lg border border-mor-line px-2 py-2 h-24 md:h-16 disabled:bg-gray-50" /></label>
                  <Receipts ref={receiptsRef} kind="pr" parentId={edit.id || null} canEdit={!readOnly} label="憑證圖片" />
                </div>
              </div>
              {/* 手機:按鈕列吸在畫面底部,捲到哪都按得到 */}
              <div className="sticky bottom-0 md:static bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex gap-2 md:justify-end"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => setEdit(null)}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">關閉</button>
                {!readOnly && <>
                  <button onClick={() => save(false)} disabled={saving}
                    className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-mor-line px-4 md:py-1.5 text-sm hover:bg-mor-sand/60 disabled:opacity-40">儲存草稿</button>
                  <button onClick={() => save(true)} disabled={saving}
                    className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                    {saving ? '處理中…' : (editingPending ? '重新送審' : '送出審核')}</button>
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
            <div className="border-b border-mor-line px-6 py-4 font-bold">{dating.purchased_on ? `修改${dateWord(dating.payment_method)}` : `確認${dateWord(dating.payment_method)}`} · {dating.req_no}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">
                {dating.purchased_on
                  ? '改日期只會同步既有支出的日期,不會重複產生新的支出。'
                  : `確認後,這張單的 ${(dating.purchase_request_items ?? []).length} 個項目會各自產生一筆支出,而且這張單就不能再撤銷。`}
              </div>
              {!dating.purchased_on && dating.planned_transfer_on && (
                <div className="text-xs text-mor-blue">預定{dateWord(dating.payment_method)} {dating.planned_transfer_on} —— 已帶入,實際日期不同請自行修改。</div>
              )}
              <label className="block text-xs text-gray-500 pt-1">確認{dateWord(dating.payment_method)}</label>
              <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
                className="w-full rounded-lg border border-mor-line px-2 py-1.5" />
              {/* 匯款與信用卡必須記錄從哪個帳戶付出去,現金沒有帳戶所以不問 */}
              {(dating.payment_method === 'transfer' || dating.payment_method === 'credit_card') && (
                <>
                  <label className="block text-xs text-gray-500 pt-1">{acctWord(dating.payment_method)}(我方) *</label>
                  <select value={dateAcct} onChange={(e) => setDateAcct(e.target.value)}
                    className="w-full rounded-lg border border-mor-line px-2 py-1.5">
                    <option value="">請選擇</option>
                    {payAccounts.filter((a) => a.method === dating.payment_method)
                      .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select>
                </>
              )}
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setDating(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doSetDate} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">確認</button>
            </div>
          </div>
        </div>
      )}

      {/* 排匯款:只寫計畫,不產生支出 */}
      {planning && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setPlanning(null)}>
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">
              {planning.planned_transfer_on ? '修改付款計畫' : `排${dateWord(planning.payment_method)}`} · {planning.req_no}
            </div>
            <div className="p-6 text-sm space-y-3">
              <div className="text-xs text-gray-500">
                這裡只是排定計畫,不會產生支出。實際出款後再按「確認{dateWord(planning.payment_method)}」,那時才會記帳。
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">預定{dateWord(planning.payment_method)}</span>
                <input type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)}
                  className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">{acctWord(planning.payment_method)}(我方)</span>
                <select value={planAcct} onChange={(e) => setPlanAcct(e.target.value)}
                  className="rounded-lg border border-mor-line px-2 py-1.5">
                  <option value="">請選擇</option>
                  {payAccounts.filter((a) => a.method === planning.payment_method)
                    .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                </select></label>
              <div className="text-xs text-gray-400">
                金額 ${fmt(planning.total_amount)}
                {planning.payee_account ? `・匯給 ${planning.payee_company ?? ''} ${planning.payee_account}` : ''}
              </div>
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setPlanning(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={savePlan} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">儲存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
