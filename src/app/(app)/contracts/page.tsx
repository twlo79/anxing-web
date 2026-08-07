'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterBar, FilterSelect, FilterDateRange, FilterSearch, FilterClear, FilterCount } from '@/lib/filters';
import { createClient } from '@/lib/supabase';
import { FEE_TYPES, feeLabel } from '@/lib/fee-types';
import ContractFees from '@/components/ContractFees';
import { keyBase, onlyKeyOf } from '@/lib/ltKey';
import {
  summarize, needsTypedConfirm, deleteConfirmText, typedConfirmPrompt,
  strayPaid, endLeaseRemoved, endLeaseConfirmText, type OrderLite,
} from '@/lib/contract-lifecycle';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import * as XLSX from 'xlsx-js-style';

type Contract = {
  id: string; estate_id: string | null; room: string | null; tenant_name: string | null;
  phone: string | null; cadence: string; type: string | null; monthly_rent: number | null; amount_per_period: number | null; deposit: number | null;
  start_date: string | null; end_date: string | null; pay_day: number | null; first_payment_date: string | null;
  paid: boolean; account: string | null; note: string | null; active: boolean; watch?: boolean; display_name?: string | null;
  invoice_required?: boolean; invoice_day?: number | null; invoice_after_paid?: boolean;
  invoice_title?: string | null; invoice_tax_id?: string | null; invoice_note?: string | null;
  concessions?: Concession[] | null;
};
/** 折讓約定：純文字備查，不影響金額。實際折讓走 oneoff 負數訂單。 */
type Concession = { date: string; amount: number; note: string };
type Estate = { id: string; name: string; sort: number };
type Invoice = {
  id: string; contract_id: string | null; order_id: string | null; room: string; ym: string;
  amount: number | null; invoice_no: string; invoice_date: string;
  title: string | null; tax_id: string | null; note: string | null; status: string;
};

const CAD_LABEL: Record<string, string> = { monthly: '月繳', quarterly: '季繳', halfyear: '半年繳', yearly: '年繳' };
const TYPE_LABEL: Record<string, string> = { longterm: '長租', company: '公司登記', office: '辦公室' };
const STEP_OF: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
const TYPE_SRC: Record<string, string> = { longterm: 'longterm', company: 'company', office: 'office' };
// FEE_TYPES 的定義搬到 @/lib/fee-types —— 契約加費、短租加費、一次性收入共用一份
const fmt = (n: number | null) => (n == null ? '' : Math.round(n).toLocaleString());

// 表頭排序:key 對應欄位型別與取值。租金一律換算成「每期租金」比較,
// 否則月繳 3 萬與年繳 36 萬會被當成同一個量級直接比大小。
const SORT_COLS: SortCols<any> = {
  room: { type: 'room', get: (c) => c.room },
  tenant_name: { type: 'text', get: (c) => c.tenant_name },
  cadence: { type: 'text', get: (c) => CAD_LABEL[c.cadence] ?? c.cadence },
  amount: { type: 'number', get: (c) => c.amount_per_period || (c.monthly_rent || 0) * (STEP_OF[c.cadence] || 1) },
  deposit: { type: 'number', get: (c) => c.deposit },
  start_date: { type: 'date', get: (c) => c.start_date },
};

export default function ContractsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<{ code: string; name: string }[]>([]);
  const [rows, setRows] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [estateFilter, setEstateFilter] = useState('');
  const [edit, setEdit] = useState<Contract | null>(null);
  const [collect, setCollect] = useState<Contract | null>(null);
  const [detail, setDetail] = useState<Contract | null>(null);
  const [kw, setKw] = useState('');
  // 輸入框與實際查詢分開 —— 邊打邊查會在每個字上跑一次全表比對,
  // 而前幾次的結果沒有人要看。跟短租頁同一套。
  const [kwIn, setKwIn] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'start_date', dir: 'desc' });
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
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invOrders, setInvOrders] = useState<{ property_raw: string | null; amount: number; paid: boolean; checkin: string }[]>([]);
  // 改完租期後「掉在租期外但已收款」的提示。null = 沒有。
  const [stray, setStray] = useState<{ name: string; n: number; amt: number; months: string } | null>(null);
  const curFirst = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  const curMon = (() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}`; })();
  const curYm = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  // 待開發票的回溯窗口:本月 + 前 INVOICE_LOOKBACK 個月。
  // 不回溯全部歷史,否則功能剛上線時會把每個契約自起始月以來的所有月份都列成逾期。
  const lookFirst = (() => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth() - INVOICE_LOOKBACK, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`; })();
  const lookYm = lookFirst.slice(0, 4) + lookFirst.slice(5, 7);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('contracts').select('*, estates(name)').order('room');
    setRows((data as any) ?? []);
    /*
     * 本月應收:**用 contract_id 當鍵,不用房號。**
     *
     * 原本是 m[o.property_raw] —— 沒有房號的契約(公司登記、辦公室租金)
     * 在 `if (o.property_raw)` 就被整筆跳過,列表的「收租」欄永遠顯示「—」,
     * 看起來像這張契約本月沒有應收,實際上月租單好好地在那裡。
     *
     * contract_id 是契約產生月租單時一定會寫的,而且不受房號改名或刪除影響。
     */
    const { data: lts } = await supabase.from('orders').select('contract_id, amount, paid').in('source', ['longterm', 'company', 'office']).eq('checkin', curFirst);
    const m: Record<string, { amount: number; paid: boolean }> = {};
    (lts ?? []).forEach((o: any) => { if (o.contract_id) m[o.contract_id] = { amount: Number(o.amount || 0), paid: !!o.paid }; });
    setCurLT(m);
    // 跨月欠款:本月之前已到期但仍未收的月租單(本月未收另計,兩者不重疊)
    const { data: ovd } = await supabase.from('orders')
      .select('order_key, property_raw, guest_name, amount, checkin')
      .in('source', ['longterm', 'company', 'office'])
      .eq('paid', false)
      .lt('checkin', curFirst)
      .order('checkin');
    setOverdue((ovd as any) ?? []);
    // 發票:回溯窗口內的月租單與已開立發票
    const { data: invO } = await supabase.from('orders')
      .select('property_raw, amount, paid, checkin')
      .in('source', ['longterm', 'company', 'office'])
      .gte('checkin', lookFirst)
      .lte('checkin', curFirst)
      .order('checkin');
    setInvOrders((invO as any) ?? []);
    const { data: invR } = await supabase.from('invoices')
      .select('*').eq('status', 'issued').gte('ym', lookYm);
    setInvoices((invR as any) ?? []);
    setLoading(false);
  }, [supabase, curFirst, lookFirst, lookYm]);
  useEffect(() => {
    supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    // 入款帳號改讀主檔,不再寫死
    supabase.from('payment_accounts').select('code, name')
      .eq('for_income', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
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
    return sortRows(out, sort, SORT_COLS);
  }, [rows, estateFilter, cadFilter, typeFilter, statusFilter, fromD, toD, kw, sort]);
  const activeCount = useMemo(() => filtered.filter((r) => r.active).length, [filtered]);
  const monthAR = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.id]?.amount ?? 0), 0), [filtered, curLT]);
  const monthPaid = useMemo(() => filtered.filter((r) => r.active).reduce((s, r) => s + (curLT[r.id]?.paid ? curLT[r.id].amount : 0), 0), [filtered, curLT]);
  const roomLists = useMemo(() => {
    const rk = (x: string) => { const m = String(x || '').match(/^(\d+)/); return [m ? parseInt(m[1]) : 999, String(x || '')] as [number, string]; };
    const cmp = (a: { room: string }, b: { room: string }) => { const ka = rk(a.room), kb = rk(b.room); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); };
    const paid: { room: string; label: string }[] = [], unpaid: { room: string; label: string }[] = [];
    // label 依序退回 顯示名稱 → 房號 → 租戶 —— 三個都空的話會是一個看不見的項目,
    // 使用者只會看到清單裡多了一個空白列而不知道那是什麼。沒有房號的契約靠租戶名認。
    filtered.filter((r) => r.active && r.watch).forEach((r) => { const lt = curLT[r.id]; if (!lt) return; const it = { room: r.room ?? '', label: (r.display_name || r.room || r.tenant_name || '(未命名契約)') as string }; (lt.paid ? paid : unpaid).push(it); });
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

  // 待開發票:以「月份」為單位,不是以「期」。
  // 年繳契約收款時 12 個月會一次轉 paid,若以入帳為準會一次湧入 12 列淹沒其他家;
  // 以月份為準則每月只出現一列,在該契約的 invoice_day 當天提醒。
  const invPending = useMemo(() => {
    const need = rows.filter((r) => r.active && r.invoice_required);
    if (!need.length) return [] as any[];
    const issued = new Set(invoices.map((v) => `${v.contract_id}|${v.ym}`));
    const nowDay = new Date().getDate();
    const out: any[] = [];
    for (const c of need) {
      for (const o of invOrders) {
        if (!o.property_raw || o.property_raw !== c.room) continue;
        const ym = o.checkin.slice(0, 4) + o.checkin.slice(5, 7);
        if (issued.has(`${c.id}|${ym}`)) continue;
        const canIssue = c.invoice_after_paid === false || !!o.paid;
        const past = ym < curYm || (ym === curYm && !!c.invoice_day && nowDay > c.invoice_day);
        out.push({
          c, ym, amount: Number(o.amount || 0), paid: !!o.paid,
          status: !canIssue ? 'waiting' : past ? 'overdue' : 'due',
          day: c.invoice_day ?? 99,
        });
      }
    }
    const rank: Record<string, number> = { overdue: 0, due: 1, waiting: 2 };
    return out.sort((a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0) ||
      a.day - b.day);
  }, [rows, invoices, invOrders, curYm]);

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
      invoice_required: edit.invoice_required ?? false,
      invoice_day: edit.invoice_required ? (edit.invoice_day ?? null) : null,
      invoice_after_paid: edit.invoice_after_paid !== false,
      invoice_title: edit.invoice_title || null,
      invoice_tax_id: edit.invoice_tax_id || null,
      invoice_note: edit.invoice_note || null,
      // 只留有填金額的，空白列不寫進去
      concessions: (((edit.concessions as any[]) ?? []).filter((cn: any) => Number(cn?.amount) > 0)),
    };
    const { error } = edit.id
      ? await supabase.from('contracts').update(payload).eq('id', edit.id)
      : await supabase.from('contracts').insert(payload);
    if (error) return flash('儲存失敗:' + error.message);
    flash('已儲存'); setEdit(null); load();
    // 改租期會讓月租單重產。等觸發器跑完再檢查有沒有「租期外但已收款」的殘留。
    if (edit.id) { setTimeout(() => { warnStray({ ...(edit as Contract) }); }, 500); }
  }
  /** 一張契約底下的全部訂單。刪除與結束租約都要先知道會動到什麼。 */
  async function ordersOf(id: string): Promise<OrderLite[]> {
    const { data } = await supabase.from('orders')
      .select('id, order_key, checkin, amount, paid, imported_via')
      .eq('contract_id', id).order('checkin');
    return (data ?? []) as OrderLite[];
  }

  const nameOf = (c: Contract) =>
    (c.display_name || [c.tenant_name, c.room].filter(Boolean).join(' ') || '(未命名契約)').trim();

  /**
   * 刪除契約。
   *
   * migration_81 之後 orders.contract_id 是 on delete cascade ——
   * 按下去會連同月租單（含已收款）、加費、續約與營收認列一起消失。
   * 所以先把「會失去什麼」算出來給人看,有已收款的還要打字確認。
   *
   * 不擋 —— 要刪就刪得掉。只是不能在不知情的狀況下刪掉。
   */
  async function del(c: Contract) {
    const name = nameOf(c);
    const im = summarize(await ordersOf(c.id));
    if (!confirm(deleteConfirmText(name, im))) return;
    if (needsTypedConfirm(im)) {
      const typed = prompt(typedConfirmPrompt(name, im));
      if (typed === null) return;
      if (typed.trim() !== name) return flash('名稱不符,已取消刪除');
    }
    const { error } = await supabase.from('contracts').delete().eq('id', c.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash(im.total.n ? `已刪除契約與 ${im.total.n} 筆訂單` : '已刪除'); load();
  }

  /**
   * 結束租約 —— 這才是「租約完成」該走的路。
   *
   * 設迄日 + 停用,剩下的交給 gen_contract_orders:它會清掉迄日之後
   * **未收款**的月租單,已收款的一列都不動。
   *
   * 為什麼要清未來的未收款:那些是還沒發生的應收,留著會讓營收預估虛高。
   * 停用本身不會清 —— 觸發器看到 active=false 就 return 了,
   * 是「改 end_date」這件事讓它清的,所以兩個一定要一起送。
   */
  async function endLease(c: Contract) {
    const name = nameOf(c);
    const d = prompt(`結束租約「${name}」\n\n請輸入租約結束日 (YYYY-MM-DD)`,
      c.end_date || new Date().toISOString().slice(0, 10));
    if (d === null) return;
    const end = d.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return flash('日期格式要像 2026-06-30');

    const rows = await ordersOf(c.id);
    if (!confirm(endLeaseConfirmText(name, end, endLeaseRemoved(rows, end)))) return;

    const { error } = await supabase.from('contracts')
      .update({ end_date: end, active: false }).eq('id', c.id);
    if (error) return flash('結束失敗:' + error.message);
    // 觸發器是非同步生效的,等一下再回頭查租期外已收款
    await new Promise((r) => setTimeout(r, 500));
    await warnStray({ ...c, end_date: end });
    flash('已結束租約,契約改為停用'); load();
  }

  /**
   * 改完租期之後,把「掉在租期外但已收款」的月租單指出來。
   *
   * gen_contract_orders 只刪未收款的 —— 錢收了是既成事實,不該因為改了
   * 一個日期就從帳上消失。但如果那筆其實是誤標成已收款,它就會變成
   * 契約上看不到、營收裡卻還在的殘留。所以主動講出來讓人自己判斷。
   */
  const warnStray = useCallback(async (c: Contract) => {
    const rows = await ordersOf(c.id);
    const s = strayPaid(rows, c.start_date, c.end_date);
    if (!s.length) { setStray(null); return; }
    setStray({
      name: nameOf(c), n: s.length,
      amt: s.reduce((a, o) => a + Number(o.amount || 0), 0),
      months: s.map((o) => o.checkin.slice(0, 7)).join('、'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);
  const loadExtBatches = useCallback(async () => {
    if (!edit?.id || !edit?.room) { setExtBatches([]); return; }
    const eb = keyBase(edit);
    const { data } = await supabase.from('orders').select('order_key, amount').eq('imported_via', 'extend').like('order_key', `${eb}%`);
    const rows = onlyKeyOf(data as any[], eb).map((o: any) => ({ ym: o.order_key.slice(eb.length), amount: Number(o.amount || 0) })).sort((a, b) => (a.ym < b.ym ? -1 : 1));
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
    const eb = keyBase(edit);
    const { data: all } = await supabase.from('orders').select('id, order_key').eq('imported_via', 'extend').like('order_key', `${eb}%`);
    const toDel = onlyKeyOf(all as any[], eb).filter((o: any) => o.order_key.slice(eb.length) >= b.startYm).map((o: any) => o.id);
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
    const eb = keyBase(edit);
    for (let i = 0; i < N; i++) { yms.push(`${eb}${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`); cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); }
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
  // 匯出 Excel:輸出「目前篩選 + 排序後」的結果,與畫面所見一致。
  function exportXlsx() {
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    const header = ['租戶', '物業', '房源', '類別', '租期起', '租期迄', '繳別', '每期租金', '對應月租', '押金', '入款帳號', '備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const c of filtered as any[]) {
      const step = STEP_OF[c.cadence] || 1;
      const per = c.amount_per_period || (c.monthly_rent || 0) * step;
      aoa.push([
        T(c.tenant_name ?? '', stCell),
        T(c.estates?.name ?? '', stCell),
        T(c.room ?? '', stCell),
        T(TYPE_LABEL[c.type ?? 'longterm'] ?? '', stCell),
        T(c.start_date ?? '', stCell),
        T(c.end_date ?? '', stCell),
        T(CAD_LABEL[c.cadence] ?? c.cadence ?? '', stCell),
        T(Math.round(per), stNum),
        T(Math.round(per / step), stNum),
        T(Math.round(c.deposit || 0), stNum),
        T(c.account ?? '', stCell),
        T(c.note ?? '', stCell),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 30 }];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };   // 凍結表頭
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '契約');
    // 檔名帶上篩選條件,之後回頭找得出這份是什麼
    const tag = [estateFilter, TYPE_LABEL[typeFilter] ?? '', CAD_LABEL[cadFilter] ?? '', kw].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `契約${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  function blank(): Contract {
    return { id: '', estate_id: estates.find((e) => e.name === '正隆')?.id ?? null, room: '', tenant_name: '', phone: '', cadence: 'monthly', type: 'longterm', monthly_rent: 0, amount_per_period: 0, deposit: 0, start_date: '', end_date: '', pay_day: null, first_payment_date: '', paid: false, account: null, note: '', active: true, watch: false, display_name: '',
      invoice_required: false, invoice_day: null, invoice_after_paid: true, invoice_title: '', invoice_tax_id: '', invoice_note: '', concessions: [] };
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">契約訂單與收款</h1>
        {msg && <span className="text-sm text-mor-green font-medium">{msg}</span>}
      </div>

      {/*
        租期外但已收款的殘留。
        gen_contract_orders 清租期外的列時刻意跳過已收款的 —— 錢收了是既成事實。
        代價是誤標成已收款的那種會留在營收裡,而契約上已經看不到那個月。
        所以改完租期主動指出來,讓人自己判斷是真的收過還是標錯。
      */}
      {stray && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-amber-900">
                「{stray.name}」有 {stray.n} 筆月租單掉在租期外,但標記為已收款（${fmt(stray.amt)}）
              </div>
              <div className="text-amber-800 mt-1 break-words">月份:{stray.months}</div>
              <div className="text-amber-700 text-xs mt-1.5 leading-relaxed">
                系統不會自動刪已收款的列 —— 錢真的收過就不該因為改日期而消失。
                若這幾筆是誤標成已收款,請到收租視窗把它們改回未收或直接刪除,否則營收會偏高。
              </div>
            </div>
            <button onClick={() => setStray(null)}
              className="shrink-0 text-amber-500 hover:text-amber-700 text-lg leading-none">✕</button>
          </div>
        </div>
      )}

      {/*
        手機是兩欄,每張卡扣掉間距與內距後只剩約 150px。
        原本每張卡的標籤都寫「本月(2026/08) 應收」—— 13 個字必然折行擠壓,
        所以把月份抽出來只顯示一次,卡片標籤縮到兩個字。
        數字用 .stat-num（clamp 流體字級）,位數再多也不會撐破。
      */}
      <div className="text-xs text-gray-500 mb-1.5 md:hidden">本月 {curMon}</div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3 mb-4">
        <div className="rounded-xl bg-mor-slate text-white p-3 md:p-4 min-w-0">
          <div className="text-xs opacity-75 truncate">契約數(啟用)</div>
          <div className="stat-num font-bold mt-1">{activeCount}</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-3 md:p-4 min-w-0">
          <div className="text-xs text-gray-500 truncate"><span className="hidden md:inline">本月({curMon}) </span>應收</div>
          <div className="stat-num font-bold mt-1">${fmt(monthAR)}</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-3 md:p-4 min-w-0">
          <div className="text-xs text-gray-500 truncate"><span className="hidden md:inline">本月({curMon}) </span>已收</div>
          <div className="stat-num font-bold mt-1 text-mor-green">${fmt(monthPaid)}</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line p-3 md:p-4 min-w-0">
          <div className="text-xs text-gray-500 truncate"><span className="hidden md:inline">本月({curMon}) </span>未收</div>
          <div className="stat-num font-bold mt-1 text-orange-600">${fmt(monthAR - monthPaid)}</div>
        </div>
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
                    <span className="font-semibold min-w-[6rem] shrink-0 whitespace-nowrap text-right">${fmt(g.amount)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {invPending.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 mb-3 overflow-hidden">
          <div className="px-4 py-2 border-b border-amber-200/70 flex items-center justify-between">
            <div className="text-sm font-semibold text-amber-700">
              待開發票
              <span className="ml-2 text-xs font-normal text-amber-600">
                {invPending.length} 張
                {invPending.some((p) => p.status === 'overdue') && <span className="text-red-600 font-medium">・{invPending.filter((p) => p.status === 'overdue').length} 張逾期</span>}
              </span>
            </div>
            <div className="text-xs text-amber-600">近 {INVOICE_LOOKBACK + 1} 個月</div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {invPending.map((p) => (
              <div key={p.c.id + p.ym}
                onClick={() => setCollect(p.c)}
                className="px-4 py-1.5 flex items-center justify-between text-sm border-b border-amber-100 last:border-0 cursor-pointer hover:bg-amber-100/40">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${p.status === 'overdue' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{p.c.invoice_day ? `${p.c.invoice_day} 日` : '—'}</span>
                  <span className="font-medium shrink-0">{p.c.display_name || p.c.room}</span>
                  <span className="text-gray-600 truncate">{p.c.invoice_title || p.c.tenant_name || ''}</span>
                  {p.c.invoice_after_paid === false && <span className="shrink-0 rounded bg-mor-bluelight text-mor-blue px-1.5 py-0.5 text-[11px]">先開</span>}
                  {p.c.invoice_note && <span className="shrink-0 text-[11px] text-gray-400 truncate">{p.c.invoice_note}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{fmtYm(p.ym)}</span>
                  {p.status === 'waiting' && <span className="text-xs text-gray-400">尚未入帳</span>}
                  {p.status === 'overdue' && <span className="text-xs text-red-600 font-medium">逾期</span>}
                  <span className="font-semibold min-w-[6rem] shrink-0 whitespace-nowrap text-right">${fmt(p.amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 篩選列走 lib/filters 的共用元件，版型以短租訂單頁為準。
          原本這裡有三顆清除鈕（日期一顆、關鍵字一顆、全部清除一顆），
          同一個動作三個位置。現在只有一顆，底線文字，在搜尋右邊。 */}
      <FilterBar
        right={<>
          <FilterCount n={filtered.length} />
          <button onClick={exportXlsx} disabled={!filtered.length}
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">⬇ 下載 Excel</button>
          <button onClick={() => setEdit(blank())}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增契約</button>
        </>}>
        <FilterSelect label="物業" value={estateFilter} onChange={setEstateFilter}
          options={estates.map((e) => ({ value: e.name, label: e.name }))} />
        <FilterSelect label="繳別" value={cadFilter} onChange={setCadFilter} options={[
          { value: 'monthly', label: '月繳' }, { value: 'quarterly', label: '季繳' },
          { value: 'halfyear', label: '半年繳' }, { value: 'yearly', label: '年繳' }]} />
        <FilterSelect label="類別" value={typeFilter} onChange={setTypeFilter} options={[
          { value: 'longterm', label: '長租' }, { value: 'office', label: '辦公室' },
          { value: 'company', label: '公司登記' }]} />
        <FilterSelect label="狀態" value={statusFilter} onChange={setStatusFilter} options={[
          { value: 'active', label: '進行中' }, { value: 'expired', label: '已到期' },
          { value: 'disabled', label: '已停用' }]} />
        <FilterDateRange label="租期(期間內有交集)" from={fromD} to={toD} onFrom={setFromD} onTo={setToD} />
        <FilterSearch label="關鍵字(房源/租戶/電話)" value={kwIn} onChange={setKwIn}
          onSubmit={() => setKw(kwIn.trim())} />
        <FilterClear
          active={!!(estateFilter || cadFilter || typeFilter || statusFilter || fromD || toD || kw || kwIn)}
          onClear={() => { setEstateFilter(''); setCadFilter(''); setTypeFilter(''); setStatusFilter(''); setFromD(''); setToD(''); setKw(''); setKwIn(''); }} />
      </FilterBar>

      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
              <SortTh label="房源" sortKey="room" type="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="租戶" sortKey="tenant_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="租金 / 繳別" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="租期" sortKey="start_date" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <th className="px-3 py-2.5">收租</th><th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">尚無契約</td></tr>
            : filtered.map((c: any) => (
              // 整列可點開詳細抽屜。押金與刪除移進抽屜 ——
              // 刪除契約會連帶影響已產生的月租單,不該在列表上一鍵可及。
              <tr key={c.id} onClick={() => setDetail(c)}
                className={`border-b border-mor-line/60 hover:bg-mor-bluelight/30 cursor-pointer ${c.active ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{c.room}<span className="ml-1 text-xs text-gray-400">{c.estates?.name}</span>{statusOf(c) === 'expired' && <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] bg-amber-50 text-amber-600">已到期</span>}{statusOf(c) === 'disabled' && <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-500">已停用</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">{c.tenant_name}</td>
                <td className="px-3 py-2 text-right">{(() => { const step = STEP_OF[c.cadence] || 1; const per = c.amount_per_period || (c.monthly_rent || 0) * step; const mo = Math.round(per / step); return (<><div className="font-medium">${fmt(per)}</div><div className="text-xs text-gray-400">{CAD_LABEL[c.cadence] ?? c.cadence}・月 ${fmt(mo)}</div></>); })()}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{c.start_date ?? '—'} ~ {c.end_date ?? '—'}</td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const lt = curLT[c.id];
                    if (!lt) return <span className="text-xs text-gray-300" title="本月無應收(缺租期、不在租期內,或月租金是空的)">—</span>;
                    // 月繳講「本月」,季繳/半年繳/年繳講「本期」—— 那些繳別是整期一起確認收款的,
                    // 對他們說「本月」會讓人以為只收了其中一個月。
                    const unit = c.cadence === 'monthly' ? '本月' : '本期';
                    return <button onClick={() => setCollect(c)} title="點擊開啟收款" className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lt.paid ? 'bg-mor-greenlight text-mor-green' : 'bg-orange-50 text-orange-600'}`}>{unit}{lt.paid ? '已收' : '未收'}</button>;
                  })()}
                </td>
                {/*
                  「收租」收進抽屜,列上只留「檢視」—— 跟短租頁一致。
                  收租視窗會列出整份租期的每一期、能改金額、能折讓、能開發票,
                  那是進去做事的地方,不該在列表上一鍵就打開。
                  真的要快速收款的話,左邊「收租」欄的「本月已收/未收」標籤本來就點得開。

                  關注(★)留在列上:它是一鍵切換的顯示偏好,不是要進去做的事。
                */}
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => togglePin(c)} title={c.watch ? '已關注(顯示於已收/未收清單)' : '關注收租(釘選)'} className={`text-xs ${c.watch ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}>{c.watch ? '★' : '☆'}</button>
                  <button onClick={() => setDetail(c)} className="text-xs text-mor-slate underline hover:text-mor-blue">檢視</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 詳細資訊抽屜 —— 列表精簡掉的欄位都在這裡,編輯與刪除也在這 */}
      {detail && (() => {
        const c: any = detail;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        const step = STEP_OF[c.cadence] || 1;
        const per = c.amount_per_period || (c.monthly_rent || 0) * step;
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold truncate">{c.room} <span className="text-sm font-normal text-gray-500">{c.estates?.name}</span></div>
                  <div className="text-xs text-gray-500 mt-0.5">{c.tenant_name}{c.display_name ? `・${c.display_name}` : ''}</div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('類型', TYPE_LABEL[c.type] ?? c.type ?? '—')}
                {row('租金', <span><span className="font-medium">${fmt(per)}</span> <span className="text-gray-500">/ {CAD_LABEL[c.cadence] ?? c.cadence}</span><div className="text-xs text-gray-400">對應月租 ${fmt(Math.round(per / step))}</div></span>)}
                {/* 收退狀態在「押金管理」頁。帶契約 id 而不是押金 id —— 一張契約可能有多幣別押金。 */}
                {row('押金', c.deposit ? <span>${fmt(c.deposit)}</span> : '—')}
                {row('租期', `${c.start_date ?? '—'} ~ ${c.end_date ?? '—'}`)}
                {row('繳款日', c.pay_day ? `每期 ${c.pay_day} 號` : '—')}
                {row('首期繳款', c.first_payment_date ?? '—')}
                {row('入款帳號', c.account ?? '—')}
                {row('電話', c.phone ?? '—')}
                {row('狀態', (
                  <span className="space-x-1">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${c.active ? 'bg-mor-greenlight text-mor-green' : 'bg-gray-100 text-gray-500'}`}>{c.active ? '啟用' : '停用'}</span>
                    {c.watch && <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-600">已關注</span>}
                    {c.auto_renew && <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-mor-bluelight text-mor-slate">自動續約</span>}
                  </span>
                ))}
                {c.invoice_required ? row('發票', `需開立${c.invoice_day ? `・每月 ${c.invoice_day} 號` : ''}${c.invoice_after_paid ? '・收款後開' : ''}${c.invoice_title ? `\n抬頭 ${c.invoice_title}` : ''}${c.invoice_tax_id ? `・統編 ${c.invoice_tax_id}` : ''}`) : null}
                {((c.concessions ?? []) as Concession[]).length > 0 ? row('折讓約定', (
                  <span className="space-y-0.5 block">
                    {((c.concessions ?? []) as Concession[]).map((cn: Concession, i: number) => (
                      <span key={i} className="block">{cn.date || '未定'}・${fmt(cn.amount)}{cn.note ? `・${cn.note}` : ''}</span>
                    ))}
                    <span className="block text-[11px] text-gray-400">約定紀錄,實際折讓看收租視窗</span>
                  </span>
                )) : null}
                {row('備註', c.note ? <span className="whitespace-pre-wrap">{c.note}</span> : '—')}
              </div>

              {/*
                租約結束走「結束租約」,不是刪除。
                所以結束租約做成正常大小的按鈕,刪除縮成一行小字 ——
                大部分人想做的是前者,以前卻只看得到後者那顆紅色大按鈕。
              */}
              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                {/*
                  四顆按鈕用 flex-wrap + min-w —— 手機一排放不下時自動折成兩排,
                  不會壓成四個 60px 寬、字擠成兩行的方塊。
                  「押金」帶契約 id 而不是押金 id:一張契約可能有多幣別押金,
                  帶押金 id 只會看到其中一種。
                */}
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => { setDetail(null); setEdit(c); }}
                    className="flex-1 min-w-[6rem] h-11 rounded-lg bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark">編輯</button>
                  <button onClick={() => { setDetail(null); setCollect(c); }}
                    className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-green text-mor-green text-sm font-medium hover:bg-mor-greenlight">收租</button>
                  <a href={`/deposits?contract=${c.id}`}
                    className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-blue text-mor-blue text-sm font-medium hover:bg-mor-bluelight flex items-center justify-center">押金</a>
                  {c.active && (
                    <button onClick={() => { endLease(c); setDetail(null); }}
                      className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-slate text-mor-slate text-sm font-medium hover:bg-mor-sand/40">結束租約</button>
                  )}
                </div>
                <div className="mt-2 text-center">
                  <button onClick={() => { del(c); setDetail(null); }}
                    className="text-xs text-red-400 underline hover:text-red-600">
                    刪除契約（連同所有訂單與營收,不可復原）
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {collect && <CollectModal contract={collect} onClose={() => { setCollect(null); load(); }} supabase={supabase} />}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              {edit.id ? '編輯契約' : '新增契約'}
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
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
              <label className="flex flex-col gap-1">入款帳號<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}</select></label>
              <label className="flex items-center gap-2 mt-6"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />啟用中</label>
              <label className="flex items-center gap-2 mt-6" title="釘選後才會出現在上方「本月已收/未收」清單"><input type="checkbox" checked={edit.watch ?? false} onChange={(e) => setEdit({ ...edit, watch: e.target.checked })} />關注收租(釘選)</label>
              <label className="flex flex-col gap-1 col-span-2">顯示名稱(釘選清單顯示,可填人名或自訂;留空則用房源)<input value={edit.display_name ?? ''} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} placeholder={edit.room ?? ''} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1 col-span-2">備註<input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

              {/*
                折讓約定:純文字備查,記錄雙方談好的條件,可以有多筆。
                這裡不影響任何金額 —— 實際發生的折讓要到收租視窗按「− 折讓」,
                那才會產生負數的一次性收入並減少該月營收。
              */}
              <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                <div className="text-xs font-semibold text-gray-500 mb-1.5">折讓約定（僅記錄,不影響金額）</div>
                <div className="space-y-1.5">
                  {((edit.concessions as any[]) ?? []).map((cn: any, idx: number) => (
                    <div key={idx} className="flex flex-wrap items-center gap-1.5">
                      <input type="date" value={cn.date ?? ''}
                        onChange={(e) => { const a = [...((edit.concessions as any[]) ?? [])]; a[idx] = { ...a[idx], date: e.target.value }; setEdit({ ...edit, concessions: a } as any); }}
                        className="rounded border border-gray-300 px-1.5 py-1 text-xs" />
                      <input type="number" min="0" placeholder="金額" value={cn.amount || ''}
                        onChange={(e) => { const a = [...((edit.concessions as any[]) ?? [])]; a[idx] = { ...a[idx], amount: Number(e.target.value) }; setEdit({ ...edit, concessions: a } as any); }}
                        className="w-24 rounded border border-gray-300 px-1.5 py-1 text-xs text-right" />
                      <input placeholder="說明" value={cn.note ?? ''}
                        onChange={(e) => { const a = [...((edit.concessions as any[]) ?? [])]; a[idx] = { ...a[idx], note: e.target.value }; setEdit({ ...edit, concessions: a } as any); }}
                        className="flex-1 min-w-32 rounded border border-gray-300 px-1.5 py-1 text-xs" />
                      <button type="button" onClick={() => setEdit({ ...edit, concessions: ((edit.concessions as any[]) ?? []).filter((_, j) => j !== idx) } as any)}
                        className="text-xs text-red-400 underline px-1">刪</button>
                    </div>
                  ))}
                </div>
                <button type="button"
                  onClick={() => setEdit({ ...edit, concessions: [...(((edit.concessions as any[]) ?? [])), { date: '', amount: 0, note: '' }] } as any)}
                  className="text-xs text-mor-blue underline mt-1.5">+ 增加折讓約定</button>
                <p className="text-[11px] text-gray-400 mt-1">
                  這裡只是備查。實際折讓請在「收租」視窗對該期按「− 折讓」,那才會扣減營收。
                </p>
              </div>

              <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                <label className="flex items-center gap-2 text-xs font-semibold text-gray-500" title="勾選後會出現在主畫面的「待開發票」提醒清單">
                  <input type="checkbox" checked={!!edit.invoice_required} onChange={(e) => setEdit({ ...edit, invoice_required: e.target.checked })} />
                  需要開發票
                </label>
                {edit.invoice_required && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2 text-sm">
                      <label className="flex flex-col gap-1 text-xs text-gray-500">每月開票日
                        <input type="number" min={1} max={31} value={edit.invoice_day ?? ''} onChange={(e) => setEdit({ ...edit, invoice_day: e.target.value ? parseInt(e.target.value) : null })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
                      <label className="flex items-center gap-2 mt-5 text-sm" title="勾選=必須先確認入帳才能開票;不勾=可先開後收">
                        <input type="checkbox" checked={edit.invoice_after_paid !== false} onChange={(e) => setEdit({ ...edit, invoice_after_paid: e.target.checked })} />
                        收費後開
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-gray-500">公司名(發票抬頭)
                        <input value={edit.invoice_title ?? ''} onChange={(e) => setEdit({ ...edit, invoice_title: e.target.value })} placeholder={edit.tenant_name ?? ''} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
                      <label className="flex flex-col gap-1 text-xs text-gray-500">統一編號(8 碼)
                        <input value={edit.invoice_tax_id ?? ''} onChange={(e) => setEdit({ ...edit, invoice_tax_id: e.target.value.replace(/\D/g, '').slice(0, 8) })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
                      <label className="flex flex-col gap-1 col-span-2 text-xs text-gray-500">固定備註(每次開票都會顯示,例 PO4701105619)
                        <input value={edit.invoice_note ?? ''} onChange={(e) => setEdit({ ...edit, invoice_note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1.5">
                      發票由人員自行在平台開立,系統只負責提醒與記錄號碼。開票操作在「收租」視窗內,每個月一張。
                      {edit.cadence === 'yearly' && <span className="text-mor-blue">此契約為年繳,收款一次確認,但發票仍為每月一張。</span>}
                    </div>
                  </>
                )}
              </div>

              {edit.id && (
                <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                  <div className="text-xs font-semibold text-gray-500 mb-1.5">展延租期(在現有租期之後追加 N 個月;追加後會多出對應 N 期待收款,可多次展延,持續認列營收直到停用)</div>
                  <div className="filter-bar flex flex-wrap items-end gap-2 text-sm">
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">追加月數
                      <input type="number" min={1} value={ext.months} onChange={(e) => { const m = e.target.value; const mn = parseInt(m) || 0; const mo = parseFloat(ext.monthly) || 0; setExt({ months: m, monthly: ext.monthly, total: mo && mn ? String(mo * mn) : ext.total }); }} className="w-24 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">月租金
                      <input type="number" value={ext.monthly || ''} placeholder="0" onChange={(e) => { const v = e.target.value; const mn = parseInt(ext.months) || 0; const mo = parseFloat(v) || 0; setExt({ months: ext.months, monthly: v, total: mn ? String(mo * mn) : '' }); }} className="w-28 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                    <span className="pb-2 text-gray-400">或</span>
                    <label className="flex flex-col gap-0.5 text-xs text-gray-500">總共租金
                      <input type="number" value={ext.total || ''} placeholder="0" onChange={(e) => { const v = e.target.value; const mn = parseInt(ext.months) || 0; const tt = parseFloat(v) || 0; setExt({ months: ext.months, total: v, monthly: mn ? String(Math.round(tt / mn)) : '' }); }} className="w-32 rounded-lg border border-gray-300 px-2 py-1.5" /></label>
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
// 待開發票清單回溯的月數(本月往前推幾個月)。調大會翻出更多歷史未開月份。
const INVOICE_LOOKBACK = 2;
// 台灣統一發票號碼:2 碼英文 + 8 碼數字
const INV_NO_RE = /^[A-Z]{2}[0-9]{8}$/;

function CollectModal({ contract: c, onClose, supabase }: { contract: any; onClose: () => void; supabase: any }) {
  const [existing, setExisting] = useState<Record<string, any>>({});
  const [endDate, setEndDate] = useState<string | null>(c.end_date ?? null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [feeRows, setFeeRows] = useState<any[]>([]);
  const [feeDraft, setFeeDraft] = useState<{ pi: number; date: string; type: string; amount: number } | null>(null);
  const [concDraft, setConcDraft] = useState<{ pi: number; date: string; amount: number; note: string; baseAmount: number; priorDisc: number } | null>(null);
  const [invMap, setInvMap] = useState<Record<string, any>>({});
  const [invDraft, setInvDraft] = useState<{ id?: string; ym: string; date: string; no: string; note: string } | null>(null);
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

  // showSpinner=false 用於背景重新整理:不切 loading 狀態,列表就不會被換成
  // 「載入中」再重建,捲軸位置得以保留。首次載入才需要 spinner。
  /** 這張契約的月租單鍵基底。房號空的走 LTC_{契約id}_ —— 見 lib/ltKey。 */
  const kb = keyBase(c);

  const loadExisting = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    // 房號空的契約鍵是 LTC_{契約id}_,不是 LT_{房號}_ —— 一律走 keyBase()
    const base = keyBase(c);
    const { data } = await supabase.from('orders')
      .select('id, order_key, paid, amount, paid_at, imported_via').like('order_key', `${base}%`);
    const m: Record<string, any> = {};
    onlyKeyOf(data as any[], base).forEach((o: any) => { m[o.order_key] = o; });
    setExisting(m);
    if (showSpinner) setLoading(false);
    // c.id 也要在相依裡 —— 房號空的契約鍵是靠 id 組的,漏了就會沿用上一張契約的結果
  }, [supabase, c.room, c.id]);
  useEffect(() => { loadExisting(); }, [loadExisting]);

  /**
   * 只改本地那幾期的欄位,不整份重新載入。
   * 原本每次操作都呼叫 loadExisting(),而它會 setLoading(true) ——
   * 列表被換成「載入中」再重建,捲軸就彈回頂端,也就是「按一下就跳掉」。
   */
  function patchLocal(keys: string[], patch: Record<string, unknown>) {
    setExisting((prev) => {
      const next = { ...prev };
      keys.forEach((k) => { if (next[k]) next[k] = { ...next[k], ...patch }; });
      return next;
    });
  }

  const keysOf = (chunk: any[]) => chunk.map((mm) => kb + mm.ym);
  const ordersOf = (chunk: any[]) => keysOf(chunk).map((k) => existing[k]).filter(Boolean);

  /**
   * 這一期記的金額跟契約現在的月租對不對得起來。
   *
   * 【為什麼會對不起來】
   * gen_contract_orders 的 upsert 有 `and orders.paid = false` ——
   * 已收款的月份不覆蓋。那個保護是對的:錢收了之後金額是既成事實,
   * 不該被後來的編輯無聲改掉(改了會連帶重算已認列的營收)。
   *
   * 但代價是「契約改了、已收的期別沒跟上」完全看不出來 ——
   * 2026-08 就遇到:契約月租從 117 改成 1470,已收的 12 期還是照 117 顯示,
   * 畫面上沒有任何跡象。所以這裡把差額標出來,並給一個明確的重算動作。
   */
  function periodMismatch(chunk: any[]) {
    const rent = Math.round(Number(c.monthly_rent) || 0);
    if (!rent) return null;
    const os = ordersOf(chunk);
    if (!os.length) return null;
    const now = os.reduce((a: number, o: any) => a + Math.round(Number(o.amount) || 0), 0);
    const expect = os.length * rent;
    if (now === expect) return null;
    return { now, expect, months: os.length, rent, paidCount: os.filter((o: any) => o.paid).length };
  }

  /**
   * 重算這一期的應收:金額改成契約現值,已收款的退回「未收」。
   *
   * **收款日刻意保留。** 退回未收之後使用者要重按「確認收款」,
   * 而確認收款預設會填今天 —— 12 期一路重按下去,原本 2023 年的收款日會全部變成今天。
   * 所以這裡只動 paid,不碰 paid_at;重按時也沿用既有的日期(見 setPeriodPaid)。
   */
  async function rebuildPeriod(chunk: any[]) {
    const m = periodMismatch(chunk);
    if (!m) return;
    const diff = m.expect - m.now;
    if (!confirm(
      `重算這一期的應收\n\n`
      + `契約現值　${m.months} 個月 × $${fmt(m.rent)} = $${fmt(m.expect)}\n`
      + `目前記的　$${fmt(m.now)}\n`
      + `差額　　　${diff > 0 ? '+' : ''}$${fmt(diff)}\n\n`
      + (m.paidCount
        ? `其中 ${m.paidCount} 個月已收款,會退回「未收」並保留原收款日,\n請確認金額後重新按「確認收款」。\n\n`
        : '')
      + `這幾個月的已認列營收會跟著重算,營收報表的數字會變。`
    )) return;
    setBusy(chunk[0].ym);
    const keys = keysOf(chunk);
    patchLocal(keys, { amount: m.rent, paid: false });
    const { error } = await supabase.from('orders')
      .update({ amount: m.rent, paid: false })   // paid_at 不動
      .in('order_key', keys);
    setBusy('');
    if (error) { alert('重算失敗:' + error.message); loadExisting(false); }
  }

  async function setPeriodPaid(chunk: any[], v: boolean) {
    setBusy(chunk[0].ym);
    const keys = chunk.map((mm) => kb + mm.ym);
    // 已經有收款日就沿用,不要覆蓋成今天 ——
    // 「重算應收」會把已收的期別退回未收但留著日期,重按確認時要拿得回來。
    const kept = ordersOf(chunk).find((o: any) => o?.paid_at)?.paid_at;
    const paidAt = v ? (kept ?? today()) : null;

    /*
     * 固定加費要跟租金一起收。
     *
     * 沒有這一段的話,「確認收款」只會標記月租單 —— 管理費那筆永遠停在未收,
     * 而使用者看到整期都變綠了,不會發現底下還掛著一筆。
     *
     * 只帶 imported_via='contract_fee'（固定加費）。手動加費與折讓不碰:
     * 那些是臨時發生的,收款時機不一定跟租金同一天。
     */
    const feeIds = feeRows
      .filter((f: any) => f.imported_via === 'contract_fee' && f.checkin
        && chunk.some((mm: any) => (f.checkin.slice(0, 4) + f.checkin.slice(5, 7)) === mm.ym))
      .map((f: any) => f.id);

    // 先更新畫面,再寫資料庫 —— 按下去立刻有反應,不用等網路來回
    patchLocal(keys, { paid: v, paid_at: paidAt });
    setFeeRows((fs: any[]) => fs.map((f) => (feeIds.includes(f.id) ? { ...f, paid: v } : f)));

    const { error } = await supabase.from('orders').update({ paid: v, paid_at: paidAt }).in('order_key', keys);
    let feeErr = null;
    if (feeIds.length) {
      const r = await supabase.from('orders').update({ paid: v, paid_at: paidAt }).in('id', feeIds);
      feeErr = r.error;
    }
    setBusy('');
    if (error || feeErr) {
      alert('失敗:' + (error?.message ?? feeErr?.message));
      loadExisting(false);   // 寫入失敗才回頭跟資料庫對齊,且不顯示 spinner
      loadFees();
    }
  }
  // 「刪除此期起」已移除:它會一次刪掉該期之後的所有月租單(含已收款者)並回推租期迄,
  // 而 UI 是以「期」呈現,實際刪除範圍卻是「該期及之後全部」,兩者不一致極易誤刪。
  // 需要縮短租期請改在編輯視窗調整「租期迄」,由觸發器安全地移除多餘月份
  // (gen_contract_orders 只刪 imported_via='contract' 且 paid=false 的列)。
  /**
   * 收款日:畫面立即反映,資料庫延遲 600ms 才寫。
   *
   * <input type="date"> 每動一次年/月/日都會觸發 onChange,
   * 原本是每次都立刻寫入 + 整份重載 —— 選一個日期會打三次資料庫、跳三次。
   * 防抖之後只在停止輸入後寫一次。
   */
  const paidAtTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  function setPeriodPaidAt(chunk: any[], date: string) {
    const keys = chunk.map((mm) => kb + mm.ym);
    const id = keys.join('|');
    patchLocal(keys, { paid_at: date || null });
    clearTimeout(paidAtTimers.current[id]);
    paidAtTimers.current[id] = setTimeout(async () => {
      const { error } = await supabase.from('orders').update({ paid_at: date || null }).in('order_key', keys);
      if (error) { alert('失敗:' + error.message); loadExisting(false); }
    }, 600);
  }
  // 視窗關閉時把還沒送出的寫入清掉,避免對已卸載的元件動作
  useEffect(() => {
    const timers = paidAtTimers.current;
    return () => { Object.values(timers).forEach(clearTimeout); };
  }, []);
  const loadFees = useCallback(async () => {
    // imported_via 用來分辨固定加費（contract_fee）與手動加費（manual）——
    // 固定加費不給在期別列上刪,刪了觸發器下次又會長回來。
    // paid 是「與租金一起收」需要的:確認收款要把該期的加費一併標記。
    const { data } = await supabase.from('orders')
      .select('id, checkin, amount, fee_type, item_name, note, imported_via, paid, order_key')
      .eq('contract_id', c.id).eq('source', 'oneoff').order('checkin');
    setFeeRows(data ?? []);
  }, [supabase, c.id]);
  useEffect(() => { loadFees(); }, [loadFees]);
  async function saveFee() {
    if (!feeDraft || !feeDraft.amount || !feeDraft.date) { alert('請填費用日期與金額'); return; }
    const { error } = await supabase.from('orders').insert({ order_key: `CFEE_${String(c.id).slice(0, 8)}_${Date.now()}`, source: 'oneoff', contract_id: c.id, estate_id: c.estate_id, property_raw: c.room, guest_name: c.tenant_name, checkin: feeDraft.date, checkout: feeDraft.date, nights: 0, amount: feeDraft.amount, fee_type: feeDraft.type, note: '契約加費', imported_via: 'manual' });
    if (error) { alert('失敗:' + error.message); return; }
    setFeeDraft(null); loadFees();
  }

  /**
   * 折讓：產生一筆負數的一次性收入，掛在契約下。
   *
   * 不改月租單的金額 —— 那些是 gen_contract_orders() 產生的，
   * 之後編輯契約時未收款的月份會被重新產生，折讓會被蓋回原價且無提示。
   * 獨立一筆負數訂單不會被觸發器動到，而且 oneoff 本來就會流進營收認列，
   * 所以該月營收自動減少。
   *
   * 備註寫明「原應收 − 折讓 = 淨額」，日後對帳看得出這筆是怎麼來的。
   */
  async function saveConcession() {
    if (!concDraft || !concDraft.amount || !concDraft.date) { alert('請填折讓日期與金額'); return; }
    const amt = Math.abs(Number(concDraft.amount));
    // 同一期可能折讓多次。備註要把先前已折讓的也寫進去，否則第二筆的算式會對不起來。
    const prior = Math.abs(Number(concDraft.priorDisc || 0));
    const note = `契約折讓・原應收 $${fmt(concDraft.baseAmount)}`
      + (prior ? ` − 已折讓 $${fmt(prior)}` : '')
      + ` − 本次折讓 $${fmt(amt)} = $${fmt(concDraft.baseAmount - prior - amt)}`
      + (concDraft.note ? `・${concDraft.note}` : '');
    const { error } = await supabase.from('orders').insert({
      order_key: `CDIS_${String(c.id).slice(0, 8)}_${Date.now()}`,
      source: 'oneoff', contract_id: c.id, estate_id: c.estate_id,
      property_raw: c.room, guest_name: c.tenant_name,
      checkin: concDraft.date, checkout: concDraft.date, nights: 0,
      amount: -amt,                 // 負數 —— 營收認列會跟著減少
      fee_type: '折讓', note, imported_via: 'manual',
    });
    if (error) { alert('失敗:' + error.message); return; }
    setConcDraft(null); loadFees();
  }
  async function delFee(id: string) { await supabase.from('orders').delete().eq('id', id); loadFees(); }

  const loadInvoices = useCallback(async () => {
    if (!c.invoice_required) { setInvMap({}); return; }
    const { data } = await supabase.from('invoices').select('*').eq('contract_id', c.id).eq('status', 'issued');
    const m: Record<string, any> = {};
    (data ?? []).forEach((v: any) => { m[v.ym] = v; });
    setInvMap(m);
  }, [supabase, c.id, c.invoice_required]);
  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  async function saveInvoice() {
    if (!invDraft) return;
    const no = invDraft.no.trim().toUpperCase();
    if (!INV_NO_RE.test(no)) { alert('發票號碼格式應為 2 碼英文 + 8 碼數字,例 AB12345678'); return; }
    if (!invDraft.date) { alert('請填開票日期'); return; }
    const o = existing[kb + invDraft.ym];
    const payload = {
      contract_id: c.id, order_id: o?.id ?? null, room: c.room, ym: invDraft.ym,
      amount: Number(o?.amount || 0) || null,
      invoice_no: no, invoice_date: invDraft.date,
      title: c.invoice_title || c.tenant_name || null,
      tax_id: c.invoice_tax_id || null,
      note: invDraft.note || null, status: 'issued',
    };
    const { error } = invDraft.id
      ? await supabase.from('invoices').update(payload).eq('id', invDraft.id)
      : await supabase.from('invoices').insert(payload);
    if (error) {
      alert(error.code === '23505'
        ? `${fmtYm(invDraft.ym)} 已經有一張已開立的發票,請先重新整理確認。`
        : '儲存失敗:' + error.message);
      return;
    }
    setInvDraft(null); loadInvoices();
  }
  async function delInvoice(id: string) {
    if (!confirm('刪除這筆發票記錄?(不會影響已在平台開立的發票)')) return;
    const { error } = await supabase.from('invoices').delete().eq('id', id);
    if (error) { alert('刪除失敗:' + error.message); return; }
    setInvDraft(null); loadInvoices();
  }

  // 發票以「月」為單位:月繳一期一個月,年繳一期 12 個月會展開成 12 列。
  function invRow(mm: any) {
    if (!c.invoice_required) return null;
    const o = existing[kb + mm.ym];
    if (!o) return null;
    const inv = invMap[mm.ym];
    const canIssue = c.invoice_after_paid === false || !!o.paid;
    return (
      <div key={'inv' + mm.ym} className="flex items-center justify-between text-xs py-0.5">
        <span className="text-gray-500">發票 {mm.label}</span>
        {inv ? (
          <span className="flex items-center gap-2">
            <span className="rounded bg-mor-greenlight text-mor-green px-1.5 py-0.5 font-medium">{inv.invoice_no}</span>
            <span className="text-gray-400">{inv.invoice_date}</span>
            <button onClick={() => setInvDraft({ id: inv.id, ym: mm.ym, date: inv.invoice_date, no: inv.invoice_no, note: inv.note ?? '' })} className="text-mor-blue underline">改</button>
          </span>
        ) : canIssue ? (
          <button onClick={() => setInvDraft({ ym: mm.ym, date: today(), no: '', note: c.invoice_note ?? '' })} className="rounded-lg bg-mor-slate text-white px-2.5 py-1 font-medium hover:bg-mor-slatedark">開發票</button>
        ) : (
          <span className="rounded-lg bg-gray-100 text-gray-400 px-2.5 py-1" title="此契約設定為「收費後開」,需先確認入帳">尚未入帳</span>
        )}
      </div>
    );
  }

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
        {c.invoice_required && (
          <div className="px-6 py-2 bg-amber-50/60 border-b border-amber-200/70 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold text-amber-700">開票資訊</span>
            <span className="text-gray-600">抬頭 <span className="font-medium text-gray-800">{c.invoice_title || c.tenant_name || '—'}</span></span>
            <span className="text-gray-600">統編 <span className="font-medium text-gray-800">{c.invoice_tax_id || '—'}</span></span>
            {c.invoice_note && <span className="text-gray-600">備註 <span className="font-medium text-gray-800">{c.invoice_note}</span></span>}
            <span className="text-gray-500">每月 {c.invoice_day ?? '—'} 日・{c.invoice_after_paid === false ? '可先開後收' : '收費後開'}</span>
          </div>
        )}
        <div className="px-6 py-4">
          {/*
            押金的收退搬到「押金管理」頁了(migration_56)。
            這裡只顯示金額 —— 收租視窗管的是每期租金,押金的生命週期跟租期無關,
            混在一起會讓「這個月收了沒」跟「押金收了沒」看起來像同一件事。
          */}
          {!!c.deposit && (
            <div className="mb-4 rounded-xl border border-mor-line px-4 py-3 text-sm flex items-center justify-between">
              <div className="font-medium">押金 ${fmt(c.deposit)}</div>
              <span className="text-xs text-gray-400">收退狀態請到「押金管理」頁</span>
            </div>
          )}
          {/*
            首繳日不在租期內。

            每一期的「應繳 X 月 X 日」是從 first_payment_date 往後推算的,
            那個欄位跟租期是分開存的 —— 改了租期沒改首繳日,應繳日就會整排落在
            幾年前,而畫面上不會有任何跡象(2026-08 就遇到:租期 2026-06 起,
            應繳日卻顯示 2023/6/6)。這裡直接講出來。
          */}
          {c.first_payment_date && c.start_date && c.end_date
            && (c.first_payment_date < c.start_date || c.first_payment_date > c.end_date) && (
            <div className="mb-3 rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs">
              首繳日 <b>{c.first_payment_date}</b> 不在租期 {c.start_date} ~ {c.end_date} 內 ——
              底下每一期的「應繳日」都是從首繳日往後推的,所以會跟著偏掉。
              請到編輯視窗修正首繳日。
            </div>
          )}
          {/*
            固定加費放在期別清單「上面」—— 它是設定,先看設定再看結果。
            放下面的話使用者會先在某一期看到一筆莫名其妙的管理費,再往下捲才知道為什麼。
          */}
          <ContractFees contract={c} canEdit onChanged={() => { loadExisting(false); loadFees(); }} />

          <div className="text-xs font-semibold text-gray-500 mb-2">收款({CAD_LABEL[c.cadence]},每期確認)</div>
          {!c.start_date || !c.end_date ? <div className="text-center text-orange-600 py-8 text-sm">此契約缺租期,請先編輯補上起訖日</div>
          : loading ? <div className="text-center text-gray-400 py-8">載入中…</div>
          : <div className="space-y-2">
            {cadPeriods.map((chunk: any[], i: number) => {
              const os = chunk.map((mm) => existing[kb + mm.ym]).filter(Boolean);
              const amount = os.reduce((a: number, o: any) => a + Number(o.amount || 0), 0);
              const paidAt = os.find((o: any) => o.paid_at)?.paid_at;
              const first = chunk[0], last = chunk[chunk.length - 1];
              const due = c.first_payment_date ? (() => { const base = addMonths(new Date(c.first_payment_date + 'T00:00:00'), i * STEP); const day = c.pay_day || base.getDate(); const dd = new Date(base.getFullYear(), base.getMonth(), day); return `${dd.getFullYear()}/${dd.getMonth() + 1}/${dd.getDate()}`; })() : '';
              const pfees = feeRows.filter((f: any) => f.checkin && chunk.some((mm: any) => (f.checkin.slice(0, 4) + f.checkin.slice(5, 7)) === mm.ym));
              // 折讓是 fee_type='折讓' 的負數列。應收顯示淨額,但保留原始金額供對帳。
              const pdisc = pfees.filter((f: any) => Number(f.amount) < 0);
              const discTotal = pdisc.reduce((a: number, f: any) => a + Math.abs(Number(f.amount) || 0), 0);
              /*
               * 這一期實際要收多少 = 租金 + 加費 − 折讓。
               *
               * 不把加費算進去的話,畫面說要收 $170,000,實際要跟房客收 $173,500 ——
               * 而那 $3,500 就掛在下面幾行,沒有人會把兩個數字自己加起來。
               */
              const feeTotal = pfees.filter((f: any) => Number(f.amount) > 0)
                .reduce((a: number, f: any) => a + Number(f.amount || 0), 0);
              const netAmount = amount + feeTotal - discTotal;
              /*
               * 整期收齊 = 月租單全收 **且** 該期的固定加費也全收。
               * 只看月租單的話,管理費還沒收但整期已經變綠,底下那筆就永遠沒人理。
               * 手動加費不列入 —— 那是臨時發生的,收款時機不一定跟租金同一天。
               */
              const autoFees = pfees.filter((f: any) => f.imported_via === 'contract_fee' && Number(f.amount) > 0);
              const allPaid = os.length > 0 && os.every((o: any) => o.paid)
                && autoFees.every((f: any) => f.paid);
              return (
                <div key={i} className={`rounded-xl border px-4 py-2.5 text-sm ${allPaid ? 'border-mor-greenlight bg-mor-greenlight/30' : 'border-mor-line'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium"><span className="text-mor-blue">第 {i + 1} 期</span> <span className="text-gray-700">{first.label}{STEP > 1 ? `~${last.label}` : ''}</span>{due ? <span className="ml-2 text-xs text-gray-400">應繳 {due}</span> : null}</div>
                      <div className="text-xs text-gray-500">
                        應收 ${fmt(netAmount)}
                        {(feeTotal > 0 || discTotal > 0) && (
                          <span className="ml-1 text-gray-400">
                            （租金 ${fmt(amount)}
                            {feeTotal > 0 && ` ＋ 加費 $${fmt(feeTotal)}`}
                            {discTotal > 0 && ` − 折讓 $${fmt(discTotal)}`}）
                          </span>
                        )}
                      </div>
                      {(() => {
                        const m = periodMismatch(chunk);
                        if (!m) return null;
                        return (
                          <div className="mt-1 rounded-lg bg-amber-50 text-amber-800 px-2 py-1 text-[11px] leading-relaxed">
                            與契約不符：契約現值 {m.months} × ${fmt(m.rent)} = <b>${fmt(m.expect)}</b>，這一期記的是 ${fmt(m.now)}
                            {m.paidCount > 0 && <span className="text-amber-700/70">（{m.paidCount} 個月已收款，所以沒有自動更新）</span>}
                            <button onClick={() => rebuildPeriod(chunk)} disabled={!!busy}
                              className="ml-2 underline font-medium hover:text-amber-900 disabled:opacity-40">重算應收</button>
                          </div>
                        );
                      })()}
                    </div>
                    {os.length > 0 && (allPaid
                      ? <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-600">收款日 <input type="date" value={paidAt || ''} onChange={(e) => setPeriodPaidAt(chunk, e.target.value)} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>
                          <button onClick={() => setPeriodPaid(chunk, false)} disabled={!!busy} className="rounded-lg bg-mor-greenlight text-mor-green px-2.5 py-1.5 text-xs font-medium hover:bg-red-50 hover:text-red-600">取消</button>
                        </div>
                      : <button onClick={() => setPeriodPaid(chunk, true)} disabled={!!busy} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark disabled:opacity-40">{busy === first.ym ? '…' : '確認收款'}</button>)}
                  </div>
                  <div className="mt-2 border-t border-mor-line/50 pt-1.5">
                    {pfees.map((f: any) => {
                      // 固定加費是設定產生的。這裡給「刪」會很誤導 ——
                      // 刪掉之後觸發器下次重產又長回來,使用者會以為系統壞了。
                      // 要停止收費請到上面的「固定加費」按「停止收費」。
                      const auto = f.imported_via === 'contract_fee';
                      return (
                        <div key={f.id} className={`flex items-center justify-between text-xs py-0.5 ${Number(f.amount) < 0 ? 'text-orange-600' : 'text-gray-600'}`}>
                          <span>
                            · {auto ? feeLabel(f.fee_type, f.item_name) : f.fee_type} {Number(f.amount) < 0 ? '−' : ''}${fmt(Math.abs(Number(f.amount) || 0))}
                            <span className="text-gray-400"> ({f.checkin})</span>
                            {auto && <span className="ml-1 text-[10px] text-gray-400">固定</span>}
                          </span>
                          {auto
                            ? <span className="text-[10px] text-gray-400">於上方「固定加費」調整</span>
                            : <button onClick={() => delFee(f.id)} className="text-red-400 underline">刪</button>}
                        </div>
                      );
                    })}
                    {feeDraft?.pi === i ? (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        <select value={feeDraft.type} onChange={(e) => setFeeDraft({ ...feeDraft, type: e.target.value })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">{FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                        <input type="number" placeholder="金額" value={feeDraft.amount || ''} onChange={(e) => setFeeDraft({ ...feeDraft, amount: parseFloat(e.target.value) || 0 })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs w-20" />
                        <input type="date" value={feeDraft.date} onChange={(e) => setFeeDraft({ ...feeDraft, date: e.target.value })} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" />
                        <button onClick={saveFee} className="rounded bg-mor-slate text-white px-2 py-0.5 text-xs">儲存</button>
                        <button onClick={() => setFeeDraft(null)} className="text-gray-400 underline text-xs">取消</button>
                      </div>
                    ) : concDraft?.pi === i ? (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="text-xs text-gray-500">折讓</span>
                        <input type="number" min="0" placeholder="金額" value={concDraft.amount || ''}
                          onChange={(e) => setConcDraft({ ...concDraft, amount: Number(e.target.value) })}
                          className="w-24 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-right" />
                        <input type="date" value={concDraft.date}
                          onChange={(e) => setConcDraft({ ...concDraft, date: e.target.value })}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" />
                        <input placeholder="原因(選填)" value={concDraft.note}
                          onChange={(e) => setConcDraft({ ...concDraft, note: e.target.value })}
                          className="w-28 rounded border border-gray-300 px-1.5 py-0.5 text-xs" />
                        <button onClick={saveConcession} className="rounded bg-mor-slate text-white px-2 py-0.5 text-xs">儲存</button>
                        <button onClick={() => setConcDraft(null)} className="text-gray-400 underline text-xs">取消</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <button onClick={() => setFeeDraft({ pi: i, date: `${first.y}-${String(first.m).padStart(2, '0')}-01`, type: '電費', amount: 0 })} className="text-xs text-mor-blue underline">+ 加費(認列營收)</button>
                        <button onClick={() => setConcDraft({ pi: i, date: `${first.y}-${String(first.m).padStart(2, '0')}-01`, amount: 0, note: '', baseAmount: amount, priorDisc: discTotal })} className="text-xs text-orange-600 underline">− 折讓</button>
                      </div>
                    )}
                  </div>
                  {c.invoice_required && (
                    <div className="mt-1.5 border-t border-amber-200/60 pt-1.5">
                      {chunk.map((mm: any) => invRow(mm))}
                    </div>
                  )}
                </div>
              );
            })}
            {extPeriods.length > 0 && <div className="text-[11px] font-semibold text-mor-blue pt-1 pb-0.5">— 延展期數(每月一期確認)—</div>}
            {extPeriods.map((chunk: any[], j: number) => {
              const mm = chunk[0];
              const o = existing[kb + mm.ym];
              const amount = Number(o?.amount || 0);
              const paid = !!o?.paid;
              const paidAt = o?.paid_at;
              return (
                <div key={'ext' + j} className={`rounded-xl border px-4 py-2.5 text-sm ${paid ? 'border-mor-greenlight bg-mor-greenlight/30' : 'border-dashed border-mor-blue/40'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium"><span className="rounded bg-mor-bluelight text-mor-blue px-1.5 py-0.5 text-[10px]">延展</span> <span className="text-mor-blue">第 {j + 1} 期</span> <span className="text-gray-700">{mm.label}</span></div>
                      <div className="text-xs text-gray-500">應收 ${fmt(amount)}</div>
                      {(() => {
                        const m = periodMismatch(chunk);
                        if (!m) return null;
                        return (
                          <div className="mt-1 rounded-lg bg-amber-50 text-amber-800 px-2 py-1 text-[11px]">
                            與契約不符：應為 ${fmt(m.expect)}
                            <button onClick={() => rebuildPeriod(chunk)} disabled={!!busy}
                              className="ml-2 underline font-medium disabled:opacity-40">重算應收</button>
                          </div>
                        );
                      })()}
                    </div>
                    {o && (paid
                      ? <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-600">收款日 <input type="date" value={paidAt || ''} onChange={(e) => setPeriodPaidAt(chunk, e.target.value)} className="rounded border border-gray-300 px-1.5 py-0.5 text-xs" /></span>
                          <button onClick={() => setPeriodPaid(chunk, false)} disabled={!!busy} className="rounded-lg bg-mor-greenlight text-mor-green px-2.5 py-1.5 text-xs font-medium hover:bg-red-50 hover:text-red-600">取消</button>
                        </div>
                      : <button onClick={() => setPeriodPaid(chunk, true)} disabled={!!busy} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-xs font-medium hover:bg-mor-slatedark disabled:opacity-40">{busy === mm.ym ? '…' : '確認收款'}</button>)}
                  </div>
                  {c.invoice_required && (
                    <div className="mt-1.5 border-t border-amber-200/60 pt-1.5">{invRow(mm)}</div>
                  )}
                </div>
              );
            })}
          </div>}
        </div>
      </div>

      {invDraft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={(e) => { e.stopPropagation(); setInvDraft(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="border-b border-mor-line px-5 py-3 font-bold text-sm flex items-center justify-between">
              {invDraft.id ? '修改發票記錄' : '登錄發票'} — {fmtYm(invDraft.ym)}
              <button onClick={() => setInvDraft(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm">
              <div className="rounded-lg bg-amber-50/60 px-3 py-2 text-xs space-y-0.5">
                <div className="text-gray-600">抬頭 <span className="font-medium text-gray-800">{c.invoice_title || c.tenant_name || '—'}</span></div>
                <div className="text-gray-600">統編 <span className="font-medium text-gray-800">{c.invoice_tax_id || '—'}</span></div>
                <div className="text-gray-600">金額 <span className="font-medium text-gray-800">${fmt(Number(existing[kb + invDraft.ym]?.amount || 0))}</span> <span className="text-gray-400">(參考,實際以平台開立為準)</span></div>
              </div>
              <label className="flex flex-col gap-1 text-xs text-gray-500">開票日期
                <input type="date" value={invDraft.date} onChange={(e) => setInvDraft({ ...invDraft, date: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
              <label className="flex flex-col gap-1 text-xs text-gray-500">發票號碼(2 碼英文 + 8 碼數字)
                <input value={invDraft.no} onChange={(e) => setInvDraft({ ...invDraft, no: e.target.value.toUpperCase() })} placeholder="AB12345678" maxLength={10} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-mono tracking-wide" /></label>
              <label className="flex flex-col gap-1 text-xs text-gray-500">備註
                <input value={invDraft.note} onChange={(e) => setInvDraft({ ...invDraft, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></label>
            </div>
            <div className="border-t border-mor-line px-5 py-3 flex justify-between items-center">
              {invDraft.id
                ? <button onClick={() => delInvoice(invDraft.id!)} className="text-xs text-red-500 underline hover:text-red-700">刪除記錄</button>
                : <span />}
              <div className="flex gap-2">
                <button onClick={() => setInvDraft(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
                <button onClick={saveInvoice} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">儲存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}