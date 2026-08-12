'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { SortTh, type SortState } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import { FEE_TYPES } from '@/lib/fee-types';
import { ONEOFF_LABEL } from '@/lib/revenue-report';
import RecurringPanel from '@/components/RecurringPanel';
import OrderPayments from '@/components/OrderPayments';
import MoneyLines from '@/components/MoneyLines';
import { toLines, fromLines, totalTwd, validateLines, type Line } from '@/lib/money-lines';
import { payStatus, remaining, isExempt, STATUS_LABEL, STATUS_CLASS, STATUS_FILTER } from '@/lib/order-payment';
import { softDelete } from '@/lib/trash';
import { feeFilterOptions, feeFilterPredicate, ONEOFF_SOURCES, FEE_F_ALL } from '@/lib/order-filter';
import TrashLink from '@/components/TrashLink';

type Order = {
  id: string; order_key: string; source: string; estate_id: string | null; property_id?: string | null; property_raw: string | null;
  guest_name: string | null; checkin: string; checkout: string; nights: number;
  amount: number; deposit: number | null; account: string | null; note: string | null;
  /**
   * 收款。paid_amount 是 order_payments 的合計,由觸發器維護（migration_84）——
   * 前端只讀不寫,狀態一律用 lib/order-payment 的 payStatus() 算,不另外存欄位。
   */
  paid?: boolean; paid_at?: string | null; paid_amount?: number | null;
  /** 需要開發票。打勾之後收款視窗才會出現發票號碼欄位（migration_87）。 */
  invoice_required?: boolean; invoice_title?: string | null; invoice_tax_id?: string | null;
  /** 一次性收入的會計科目。只有 source='oneoff' 用得到,其餘一律 null。 */
  fee_type?: string | null;
  /** 一次性收入的項目(洗衣機/垃圾代收費…)。科目底下再細一層。 */
  item_name?: string | null;
  // 【已淘汰】押金收退改由 deposits 表管理(migration_56),這裡不再讀寫
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
const SRC_LABEL: Record<string, string> = { airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', oneoff: ONEOFF_LABEL, partner: '搭檔收款', airbnb_cancelled: 'Airbnb取消' };
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
  const [feeF, setFeeF] = useState(FEE_F_ALL);
  const [toD, setToD] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'checkin', dir: 'desc' });
  const [collect, setCollect] = useState<Order | null>(null);
  const [payF, setPayF] = useState('');   // '' | unpaid | partial | paid
  const [agg, setAgg] = useState<any[]>([]);
  // 定期收費的設定只有會計/主管/總經理能改 —— 跟 recurring_charges 的 RLS 一致。
  // 前端擋只是少讓人白按一次,真正的把關在資料庫。
  const [role, setRole] = useState('');
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from('profiles').select('role').eq('id', user.id).single()
        .then(({ data }) => setRole(data?.role ?? ''));
    });
  }, [supabase]);

  useEffect(() => { supabase.from('estates').select('id, name, sort, active').order('sort').then(({ data }) => setEstates(data ?? [])); }, [supabase]);
  // 安幸收款帳號改讀主檔,不再寫死。現金與加密貨幣沒有帳號,直接列在選單上。
  const [payAccounts, setPayAccounts] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    supabase.from('payment_accounts').select('code, name')
      .eq('for_income', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
  }, [supabase]);
  /*
   * 收款只有會計/主管/總經理能做 —— 跟 order_payments 的 RLS 一致。
   * 沒有這道的話,其他角色點得到「收款」但視窗裡永遠是空的（RLS 擋掉查詢,
   * 而 RLS 擋掉不會報錯,只會回空陣列）—— 看起來像壞掉,實際上是沒權限。
   */
  const canCollect = useMemo(() => ['accountant', 'manager', 'super_admin'].includes(role), [role]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const [fees, setFees] = useState<Fee[]>([]);
  /*
   * 金額與押金都改成「一列一種幣別」,台幣只是其中一列（見 lib/money-lines）。
   * 資料庫存的東西完全沒變 —— 台幣仍然回到 amount / deposit,
   * 非台幣仍然回到 fx_revenue / fx_deposit。轉換由 toLines / fromLines 負責。
   */
  const [revLines, setRevLines] = useState<Line[]>([]);
  const [depLines, setDepLines] = useState<Line[]>([]);
  /*
   * 表單開啟次數。初始化 effect 綁在這個計數器上,不是綁在 edit.id ——
   * 新訂單的 id 一直是空字串,綁 id 的話「新增 → 取消 → 再新增」
   * 不會重跑初始化,第二張單會帶著第一張單的金額與幣別,而且沒有任何跡象。
   */
  const [formSeq, setFormSeq] = useState(0);
  const openEdit = (o: Order | null) => { setEdit(o); if (o) setFormSeq((n) => n + 1); };
  useEffect(() => {
    setRevLines(toLines(edit?.amount, (edit as any)?.fx_revenue, 'revenue'));
    setDepLines(toLines(edit?.deposit, (edit as any)?.fx_deposit, 'deposit'));
    if (edit?.id) {
      supabase.from('orders').select('id, checkin, amount, fee_type, note').eq('parent_order_id', edit.id).eq('source', 'oneoff').then(({ data }) => setFees((data ?? []).map((f: any) => ({ id: f.id, date: f.checkin ?? '', type: f.fee_type ?? '其他', amount: Number(f.amount) || 0, note: f.note ?? '' }))));
    } else { setFees([]); }
    // formSeq 而不是 edit?.id —— 理由見上面 formSeq 的宣告。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSeq, supabase]);
  const addFee = () => setFees((fs) => [...fs, { date: edit?.checkout || edit?.checkin || '', type: '清潔費', amount: 0, note: '' }]);
  const updFee = (i: number, patch: Partial<Fee>) => setFees((fs) => fs.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  const delFee = (i: number) => setFees((fs) => fs.filter((_, idx) => idx !== i));
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  useEffect(() => { supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? [])); }, [supabase]);
  /**
   * 用過的項目名稱,給 datalist 提示。
   * 只從目前載入的列取 —— 不另外查一次資料庫。提示不完整不會出錯,
   * 使用者照樣可以自己打,而多打一次查詢就是每次開頁都多一趟。
   */
  const usedItems = useMemo(
    () => Array.from(new Set(rows.map((r: any) => r.item_name).filter(Boolean))).sort() as string[],
    [rows]);

  /*
   * 【三個地方要用同一組篩選】
   * 畫面清單、上方合計、匯出 Excel —— 原本各寫一份。
   * 合計那份漏了「收款狀態」，所以篩「未收款」時上方數字仍然是全部的總額，
   * 而且沒有任何跡象顯示它們不一致 —— 使用者只會相信其中一個。
   * 合成一份之後，之後加篩選條件只要改這裡。
   */
  const applyFilters = useCallback((q: any) => {
    if (src) q = q.eq('source', src);
    if (estF) q = q.eq('estate_id', estF);
    if (toD) q = q.lte('checkin', toD);
    if (fromD) q = q.gte('checkout', fromD);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,property_raw.ilike.%${kw}%,note.ilike.%${kw}%`);
    /*
     * 收款狀態。三種狀態都用 paid + paid_amount 兩個實體欄位表達,對應 payStatus():
     *   未收款  paid=false 且 paid_amount<=0
     *   部分    paid=false 且 paid_amount>0
     *   已收款  paid=true
     * 平台代收的來源一律排除 —— 那些不是使用者要追的。
     */
    if (payF) {
      q = q.not('source', 'in', '(airbnb,agoda,airbnb_cancelled)');
      if (payF === 'paid') q = q.eq('paid', true);
      else if (payF === 'partial') q = q.eq('paid', false).gt('paid_amount', 0);
      else if (payF === 'unpaid') q = q.eq('paid', false).lte('paid_amount', 0);
    }
    // 費用類別。房租不是靠「fee_type 是空的」判斷,而是照資料庫
    // order_account_code() 的規則看來源 —— 兩邊用同一條規則,
    // 篩出來的筆數才會跟營收報表對得上。
    const fp = feeFilterPredicate(feeF);
    const oneoffList = `(${ONEOFF_SOURCES.join(',')})`;
    if (fp.kind === 'rent') q = q.not('source', 'in', oneoffList);
    else if (fp.kind === 'oneoffAll') q = q.in('source', ONEOFF_SOURCES);
    else if (fp.kind === 'feeType') q = q.in('source', ONEOFF_SOURCES).eq('fee_type', fp.feeType);
    return q;
  }, [src, estF, fromD, toD, kw, payF, feeF]);

  const load = useCallback(async () => {
    setLoading(true);
    // 伺服器端排序。本頁是伺服器端分頁,若改成前端排序只會排到當前頁的 100 筆。
    // nullsFirst: false —— 空值一律殿後,與另外兩頁的前端排序行為一致。
    const sortCol = SORT_DB_COL[sort?.key ?? 'checkin'] ?? 'checkin';
    // 篩選走伺服器端 —— 本頁是伺服器端分頁,在前端過濾只會篩到當前這 50 筆,
    // 分頁數字還會是錯的。
    const q = applyFilters(
      supabase.from('orders').select('*, properties(name)', { count: 'exact' }).in('source', SRC)
        .order(sortCol, { ascending: sort?.dir === 'asc', nullsFirst: false }));
    const { data, count } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as any) ?? []); setTotal(count ?? 0); setLoading(false);
  }, [supabase, applyFilters, sort, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [src, kw, estF, fromD, toD, sort, payF, feeF]);

  const loadAgg = useCallback(async () => {
    let all: any[] = []; let from = 0;
    while (true) {
      const q = applyFilters(
        supabase.from('orders').select('source, estate_id, amount, deposit, fx_deposit').in('source', SRC));
      const { data } = await q.range(from, from + 999);
      const chunk = (data as any[]) ?? [];
      all = all.concat(chunk);
      if (chunk.length < 1000) break;
      from += 1000;
    }
    setAgg(all);
  }, [supabase, applyFilters]);
  useEffect(() => { loadAgg(); }, [loadAgg]);
  /**
   * 提示訊息。
   *
   * 【為什麼要分成功與失敗】
   * 原本不管什麼訊息都用綠色、2.5 秒後消失 —— 包含資料庫回傳的錯誤。
   * 2026-08 遇到:訂單存不進去,使用者只看到「按了沒反應」,
   * 錯誤訊息用綠色一閃而過,沒人來得及看清楚,更不可能複製下來回報。
   * （實際原因是程式推上去了但 migration 沒跑,少了一個欄位。）
   *
   * 失敗要紅色、要停久一點、而且要能點掉。錯誤訊息是拿來讀的,不是拿來閃的。
   *
   * 靠內容判斷而不是多一個參數 —— 現有的呼叫點都寫成「…失敗:」,
   * 改參數要動十幾處,漏一處就又變成綠色的錯誤訊息。
   */
  const [msgErr, setMsgErr] = useState(false);
  function flash(t: string) {
    const bad = /失敗|錯誤|不能|無法/.test(t);
    setMsg(t); setMsgErr(bad);
    setTimeout(() => setMsg(''), bad ? 15000 : 2500);
  }

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
        // 用同一支 applyFilters —— 匯出跟畫面對不上的話沒有任何跡象,
        // 使用者會以為 Excel 才是對的。
        const q = applyFilters(
          supabase.from('orders').select('*, properties(name)').in('source', SRC)
            .order(sortCol, { ascending: sort?.dir === 'asc', nullsFirst: false }));
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

      const header = ['來源', '物業', '房源', '房客', '入住日', '退房日', '晚數', '金額', '已收', '尚欠', '收款狀態', '押金', '收款方式', '備註'];
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
          T(Math.round(Number(o.paid_amount) || 0), stNum),
          T(remaining(o), stNum),
          T(STATUS_LABEL[payStatus(o)], stCell),
          T(Math.round(Number(o.deposit) || 0), stNum),
          T(o.account ?? '', stCell),
          T(o.note ?? '', stCell),
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 12 }, { wch: 30 }];
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
    // 幣別清單 → 資料庫格式。台幣回 amount / deposit,其餘回 fx_*,格式與改版前一致。
    const revErr = validateLines(revLines, 'revenue');
    if (revErr) return flash('訂單金額:' + revErr);
    const depErr = validateLines(depLines, 'deposit');
    if (depErr) return flash('押金:' + depErr);
    const rev = fromLines(revLines, 'revenue');
    const dep = fromLines(depLines, 'deposit');
    const payload = { source: edit.source, estate_id: edit.estate_id, property_id: edit.property_id ?? null, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: edit.checkin || null, checkout: co || null, nights, amount: rev.twd, deposit: dep.twd, account: edit.account, note: edit.note,
      // 只有一次性收入有會計科目。其他來源一律寫 null,不要留著切換來源前選的值 ——
      // 那會讓一筆 Airbnb 訂單帶著「水費」這種科目跑進營收報表。
      fee_type: edit.source === 'oneoff' ? (edit.fee_type || null) : null,
      item_name: edit.source === 'oneoff' ? (edit.item_name?.trim() || null) : null,
      fx_revenue: rev.fx, fx_deposit: dep.fx,
      // 不需開發票就把抬頭與統編清掉 —— 留著的話取消勾選之後那些值還在資料庫裡,
      // 畫面上看不到卻會被 Excel 匯出帶走。
      invoice_required: !!edit.invoice_required,
      invoice_title: edit.invoice_required ? (edit.invoice_title?.trim() || null) : null,
      invoice_tax_id: edit.invoice_required ? (edit.invoice_tax_id?.trim() || null) : null };
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
    // 硬刪除,不進回收桶 —— 這是「使用者在編輯畫面把某列加費刪掉後存檔」的同步,
    // 屬於這次編輯的一部分。整張訂單的刪除才走 soft_delete。
    if (delIds.length) await supabase.from('orders').delete().in('id', delIds);
    for (const f of fees) {
      if (!f.date || !f.amount) continue;
      const row = { source: 'oneoff', estate_id: edit.estate_id, property_id: edit.property_id ?? null, property_raw: edit.property_raw, guest_name: edit.guest_name, checkin: f.date, checkout: f.date, nights: 0, amount: f.amount, fee_type: f.type, note: f.note || null, parent_order_id: orderId };
      if (f.id) await supabase.from('orders').update(row).eq('id', f.id);
      else await supabase.from('orders').insert({ ...row, order_key: `FEE_${String(orderId).slice(0, 8)}_${Date.now()}${Math.floor(Math.random() * 1000)}`, imported_via: 'manual' });
    }
    flash('已儲存'); setEdit(null); setFees([]); load();
  }
  /**
   * 刪除訂單。
   *
   * order_payments 是 on delete cascade —— 收款紀錄會跟著一起消失，
   * 營收認列也是（revenue_recognitions.order_id 同樣 cascade）。
   * 所以有收過款就要把數字講出來，跟契約刪除的處理一致：不擋，但不能不知情。
   */
  async function del(o: Order) {
    const { data: ps } = await supabase.from('order_payments')
      .select('amount').eq('order_id', o.id);
    const n = (ps ?? []).length;
    const got = (ps ?? []).reduce((a: number, p: any) => a + (Number(p.amount) || 0), 0);
    const msgText = `刪除訂單「${o.guest_name ?? ''} ${o.property_raw ?? ''}」?\n\n`
      + `金額 $${fmt(o.amount)}\n`
      + (n ? `⚠ 已有 ${n} 筆收款紀錄（$${fmt(got)}）會一併刪除。\n` : '')
      + `這筆的營收認列會跟著消失，這段期間的營收會變少。\n\n`
      + `會移到回收桶 —— 復原之後營收也會跟著回來。`;
    if (!confirm(msgText)) return;
    const r = await softDelete(supabase, 'orders', o.id);
    flash(r.message); if (r.ok) load();
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
    /*
     * 【移房會動到收款紀錄，動手前一定要講清楚】
     *
     * 底下的流程是：主段（id = grp）用 update 改掉，其他分段一律 delete 再重建。
     * order_payments 的外鍵是 on delete cascade，所以**被重建的那些分段，
     * 它們身上的收款紀錄會一起消失**，而且不會有任何錯誤訊息。
     *
     * 主段的收款會留著，但金額通常會變小（10,000 拆成 4,000 + 6,000），
     * 觸發器重算之後可能變成「超收」—— 那不是錯，只是要先讓人知道。
     *
     * 不擋，只問一聲 —— 跟契約刪除的處理一致：使用者決定要做就做得到，
     * 但不能在不知情的狀況下把收過的錢弄不見。
     */
    const { data: segIds } = await supabase.from('orders')
      .select('id').eq('move_group', grp).neq('id', grp);
    const doomed = (segIds ?? []).map((x: any) => x.id);
    if (doomed.length) {
      const { data: lost } = await supabase.from('order_payments')
        .select('amount').in('order_id', doomed);
      const n = (lost ?? []).length;
      if (n) {
        const amt = (lost ?? []).reduce((a: number, p: any) => a + (Number(p.amount) || 0), 0);
        if (!confirm(
          `這次移房會重建分段，其中 ${n} 筆收款紀錄（$${fmt(amt)}）會一併刪除。\n\n`
          + `主段的收款會保留，但金額改變後收款狀態會重新計算。\n\n`
          + `確定要繼續嗎？`
        )) return;
      }
    }

    const patch: any = { estate_id: s0.estateId, property_id: s0.propertyId, property_raw: s0.room, checkin: s0.from, checkout: s0.to, nights: s0.nights, amount: s0.amount, move_group: isMulti ? grp : null };
    if (isMulti) patch.note = `移房 ${chain}`;
    const { error: e1 } = await supabase.from('orders').update(patch).eq('id', grp);
    if (e1) return flash('移房失敗:' + e1.message);
    // 硬刪除,不進回收桶 —— 移房是「把舊分段拆掉重組」,下面馬上重建。
    // 中途的分段沒有單獨存在的意義,復原一段反而會讓住宿期間重疊。
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
  function blank(): Order { return { id: '', order_key: '', source: 'private', estate_id: null, property_id: null, property_raw: '', guest_name: '', checkin: '', checkout: '', nights: 0, amount: 0, deposit: 0, account: null, note: '', fx_revenue: [], fx_deposit: [], invoice_required: false, invoice_title: '', invoice_tax_id: '' }; }

  const totRevenue = useMemo(() => agg.reduce((a, o) => a + Number(o.amount || 0), 0), [agg]);
  const bySource = useMemo(() => { const m: Record<string, number> = {}; for (const o of agg) m[o.source] = (m[o.source] || 0) + Number(o.amount || 0); return m; }, [agg]);
  const byEstate = useMemo(() => { const m: Record<string, number> = {}; for (const o of agg) { const k = o.estate_id ? (estateName[o.estate_id] ?? '—') : '—'; m[k] = (m[k] || 0) + Number(o.amount || 0); } return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [agg, estateName]);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1>短租訂單與收款 <span className="text-sm font-normal text-gray-400">Airbnb・Agoda・私下・一次性</span></h1>
        {msg && (msgErr
          ? <button onClick={() => setMsg('')} title="點一下關閉"
              className="text-sm text-left rounded-lg bg-red-50 text-red-700 border border-red-200 px-3 py-1.5 font-medium max-w-2xl">
              {msg}
            </button>
          : <span className="text-sm text-mor-green font-medium">{msg}</span>)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4 items-stretch">
        <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center min-w-0">
          <div className="text-xs opacity-75">當期營收(訂單總額)</div>
          <div className="stat-num-lg font-bold mt-1">${fmt(totRevenue)}</div>
          {/* 暫收款移到「押金管理」頁 —— 那裡才看得到契約押金,只算短租的數字是不完整的 */}
          <div className="text-xs opacity-60 mt-1">{total.toLocaleString()} 筆・押金非營收</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-white/45">依來源</div>
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
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-white/45">依物業</div>
          <div className="max-h-44 overflow-y-auto">
            {byEstate.map(([e, v]) => { const id = estates.find((x) => x.name === e)?.id || ''; return (
              <div key={e} onClick={() => setEstF(estF === id ? '' : id)} className={`px-4 py-1.5 flex items-center justify-between text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${estF && estF === id ? 'bg-mor-bluelight/60' : ''}`}>
                <span className="truncate">{e}</span><span className="font-semibold whitespace-nowrap">${fmt(v as number)}</span>
              </div>); })}
          </div>
        </div>
      </div>

      {/*
        定期收費。收合狀態只有一列,展開才查資料 ——
        它是附屬面板,不該讓每次開短租頁都多兩趟查詢。

        放這裡而不是側邊選單獨立一頁:它跟「其他收入」是同一種東西,
        差別只在「要不要每個月自動長出來」。分兩個頁面會讓人以為是兩件事,
        而且側邊選單每多一項,真正每天要用的功能就被往下擠一格。
      */}
      <RecurringPanel canEdit={['accountant', 'manager', 'super_admin'].includes(role)} />

      <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
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
          {/* 選了收款狀態就自動排除 Airbnb/Agoda —— 平台代收沒有「收款狀態」可言 */}
          <label className="block text-xs text-gray-500 mb-1">收款狀態</label>
          <select value={payF} onChange={(e) => setPayF(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>
            {STATUS_FILTER.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          {/* 房租 vs 一次性費用。個別科目縮排在下面,一眼看得出是它的細項 */}
          <label className="block text-xs text-gray-500 mb-1">費用類別</label>
          <select value={feeF} onChange={(e) => setFeeF(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            {feeFilterOptions(FEE_TYPES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
          <label className="block text-xs text-gray-500 mb-1">關鍵字(房客/房源)</label>
          <div className="flex gap-1">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }} placeholder="搜尋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-36" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(src || kw || estF || fromD || toD || feeF || payF) && <button onClick={() => { setSrc(''); setKw(''); setKwIn(''); setEstF(''); setFromD(''); setToD(''); setFeeF(FEE_F_ALL); setPayF(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {total.toLocaleString()} 筆</div>
          <button onClick={exportXlsx} disabled={exporting || !total} className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 disabled:opacity-40">{exporting ? '匯出中…' : '⬇ 下載 Excel'}</button>
          <button onClick={() => openEdit(blank())} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark">+ 新增訂單</button>
          <TrashLink table="orders" label="訂單" />
        </div>
      </div>

      <div className="rounded-xl glass overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
              <SortTh label="來源" sortKey="source" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="房源" sortKey="property_raw" type="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="房客" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="訂單起訖" sortKey="checkin" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <SortTh label="金額" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <th className="px-3 py-2.5 whitespace-nowrap">收款</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">無訂單</td></tr>
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
                <td className="px-3 py-2 whitespace-nowrap">
                  {(() => {
                    const st = payStatus(o);
                    const rest = remaining(o);
                    return (
                      <>
                        <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[st]}`}>
                          {STATUS_LABEL[st]}
                        </span>
                        {/* 部分收款才顯示尚欠 —— 未收款的尚欠就是金額,那一欄已經有了 */}
                        {st === 'partial' && (
                          <div className="text-[11px] text-gray-400 mt-0.5">尚欠 ${fmt(rest)}</div>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {!isExempt(o.source) && canCollect && (
                    <button onClick={(e) => { e.stopPropagation(); setCollect(o); }}
                      className="text-xs text-mor-green underline hover:opacity-80 mr-3">收款</button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setDetail(o); }} className="text-xs text-mor-slate underline hover:text-mor-blue">檢視</button>
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
                {row('收款', (() => {
                  const st = payStatus(d);
                  const rest = remaining(d);
                  return (
                    <span>
                      <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[st]}`}>
                        {STATUS_LABEL[st]}
                      </span>
                      {!isExempt(d.source) && (
                        <span className="ml-2 text-xs text-gray-500">
                          已收 ${fmt(Number(d.paid_amount) || 0)}
                          {rest > 0 && <span className="text-red-500">・尚欠 ${fmt(rest)}</span>}
                        </span>
                      )}
                    </span>
                  );
                })())}
                {/*
                  收退狀態改看「押金管理」頁,這裡只顯示金額。
                  外幣押金各自是一筆,所以連結帶的是訂單 id 而不是某一筆押金 id ——
                  帶押金 id 只會看到其中一種幣別,而使用者按的是「這張單的押金」。
                */}
                {/* 收退狀態在「押金管理」頁,入口在下面的操作列。這裡只顯示金額。 */}
                {row('押金', (d.deposit || d.fx_deposit?.length) ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>${fmt(d.deposit)}</span>
                    {d.fx_deposit?.filter((f) => f.cur && f.amt).map((f, i) => (
                      <span key={i} className="text-xs text-gray-500">＋{f.cur} {fmt(f.amt)}</span>
                    ))}
                  </span>
                ) : '—')}
                {row('收款方式', d.account ?? '—')}
                {d.fx_revenue?.length ? row('外幣營收', d.fx_revenue.map((f, i) => <div key={i}>{f.cur} {fmt(f.amt)} × {f.rate}</div>)) : null}
                {d.fx_deposit?.length ? row('外幣押金', d.fx_deposit.map((f, i) => <div key={i}>{f.cur} {fmt(f.amt)}</div>)) : null}
                {d.invoice_required ? row('發票',
                  <span>需開立
                    {d.invoice_title ? <span className="text-xs text-gray-500 ml-2">抬頭 {d.invoice_title}</span> : null}
                    {d.invoice_tax_id ? <span className="text-xs text-gray-500 ml-1">・統編 {d.invoice_tax_id}</span> : null}
                    <span className="block text-[11px] text-gray-400 mt-0.5">號碼在「收款」視窗填寫</span>
                  </span>) : null}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}
                {row('訂單編號', <span className="text-xs text-gray-500 break-all">{d.order_key}</span>)}
              </div>

              {/*
                最多五顆按鈕,用 flex-wrap + min-w 讓手機自動折行 ——
                固定一排的話每顆會被壓到 60px 寬,字擠成兩行。
              */}
              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex flex-wrap gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setDetail(null); openEdit(d); }}
                  className="flex-1 min-w-[6rem] h-11 rounded-lg bg-mor-slate text-white text-sm font-medium hover:bg-mor-slatedark">編輯</button>
                {!isExempt(d.source) && canCollect && (
                  <button onClick={() => { setDetail(null); setCollect(d); }}
                    className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-green text-mor-green text-sm font-medium hover:bg-mor-greenlight">收款</button>
                )}
                {canMove && (
                  <button onClick={() => { setDetail(null); openMove(d); }}
                    className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-green text-mor-green text-sm font-medium hover:bg-mor-greenlight">移房</button>
                )}
                {/* 帶訂單 id 而不是押金 id —— 一張訂單可能有台幣與多種外幣好幾筆押金 */}
                <a href={`/deposits?order=${d.id}`}
                  className="flex-1 min-w-[6rem] h-11 rounded-lg border border-mor-blue text-mor-blue text-sm font-medium hover:bg-mor-bluelight flex items-center justify-center">押金</a>
                <button onClick={() => { del(d); setDetail(null); }}
                  className="flex-1 min-w-[6rem] h-11 rounded-lg border border-red-300 text-red-500 text-sm font-medium hover:bg-red-50">刪除</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/*
        收款視窗。合計與狀態由 migration_84 的觸發器維護,
        這裡改完只要重新載入列表,標籤就會跟著變 —— 前端不自己算合計寫回 orders。
      */}
      {collect && (
        <OrderPayments
          order={collect}
          accounts={payAccounts}
          canEdit={canCollect}
          onClose={() => setCollect(null)}
          onChanged={() => { load(); loadAgg(); }}
        />
      )}

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">{edit.id ? '編輯訂單' : '新增訂單(私下/一次性)'}<button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button></div>
            <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">來源<select value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5">{Array.from(new Set([...(edit.id ? [edit.source] : []), ...MANUAL_SRC])).map((s) => <option key={s} value={s}>{SRC_LABEL[s] ?? s}</option>)}</select></label>
              <label className="flex flex-col gap-1">物業<select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null, property_raw: null, property_id: null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option>{estates.map((es) => <option key={es.id} value={es.id}>{es.name}{es.active ? '' : '(停用)'}</option>)}</select></label>
              {/*
                房源非必填。

                原本這裡只列「已選物業底下的房源」,所以物業還沒選時整個下拉是空的 ——
                看起來像不能選。一次性收費常常是先知道房號才想起是哪個物業
                （取消預訂、賠償、修繕代收都是這樣),順序被綁死很難用。

                改成:沒選物業就列出全部(標上物業名),選了房源自動把物業補上。

                【留白 = 整棟】
                空值不是「還沒填」,是明確的意思:這筆錢算在整個物業上,不歸任何一間房。
                公共區域清潔、整棟修繕、管理費分攤都是這種。
                所以空的那個選項寫「整棟」而不是「—」—— 寫「—」的話,
                看的人分不出是刻意留白還是漏填,報表上也解讀不了。
              */}
              <label className="flex flex-col gap-1">
                房源<span className="text-xs text-gray-400 ml-1">(非必填)</span>
                <select value={edit.property_raw ?? ''}
                  onChange={(e) => {
                    const nm = e.target.value;
                    if (!nm) return setEdit({ ...edit, property_raw: null, property_id: null });
                    // 選了房源就以它為準,連帶把物業補上 —— 兩者不一致的資料最難查
                    const pool = edit.estate_id ? properties.filter((x) => x.estate_id === edit.estate_id) : properties;
                    const pr = pool.find((x) => x.name === nm);
                    setEdit({ ...edit, property_raw: nm, property_id: pr?.id ?? null, estate_id: pr?.estate_id ?? edit.estate_id });
                  }}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  <option value="">{edit.estate_id ? '整棟(不指定房源)' : '整棟／尚未指定'}</option>
                  {(edit.estate_id ? properties.filter((x) => x.estate_id === edit.estate_id) : properties)
                    .map((x) => (
                      <option key={x.id} value={x.name}>
                        {x.name}{!edit.estate_id && estates.find((es) => es.id === x.estate_id)
                          ? `（${estates.find((es) => es.id === x.estate_id)!.name}）` : ''}
                      </option>
                    ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">客戶<input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1">{edit.source === 'oneoff' ? '日期(認列月份)' : '起日'}<input type="date" value={edit.checkin} onChange={(e) => setEdit({ ...edit, checkin: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && <label className="flex flex-col gap-1">迄日<input type="date" value={edit.checkout} onChange={(e) => setEdit({ ...edit, checkout: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>}
              {/*
                一次性收入不會有外幣,給一個單純的金額欄就好 ——
                多一個「+ 新增幣別」只是讓最常用的路徑多一個看不懂的東西。
                它一樣寫進 revLines 的台幣列,所以存檔那段不用分兩套。
              */}
              {edit.source === 'oneoff' && (
                <label className="flex flex-col gap-1">金額
                  <input type="number" inputMode="numeric" placeholder="0"
                    value={revLines[0]?.amt || ''}
                    onChange={(e) => setRevLines([{ cur: 'TWD', amt: parseFloat(e.target.value) || 0, rate: 1 }])}
                    className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              )}
              {/*
                一次性收入的會計科目。清單跟契約加費、短租加費共用(@/lib/fee-types)。

                這一欄以前不存在 —— 取消預定之類的只能記成「其他」再把說明寫進備註,
                營收報表按 fee_type 分組時全部擠在同一格,看不出組成。
              */}
              {edit.source === 'oneoff' && (
                <label className="flex flex-col gap-1">會計科目
                  <select value={edit.fee_type ?? ''} onChange={(e) => setEdit({ ...edit, fee_type: e.target.value || null })}
                    className="rounded-lg border border-gray-300 px-2 py-1.5">
                    <option value="">—</option>
                    {FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              )}
              {/*
                項目 —— 會計科目底下再細一層。
                洗衣機、烘衣機、垃圾代收費的科目都是「清潔費」,沒有這一欄的話
                營收報表只會看到一格清潔費,拆不出是哪一項。

                自由輸入但提示用過的 —— 「洗衣機」跟「洗衣機費」會變成報表上兩列,
                那種錯不會報錯,只會讓數字少一截。
              */}
              {edit.source === 'oneoff' && (
                <label className="flex flex-col gap-1">項目<span className="text-xs text-gray-400 ml-1">(非必填)</span>
                  <input list="st-items" value={edit.item_name ?? ''} placeholder="例:洗衣機"
                    onChange={(e) => setEdit({ ...edit, item_name: e.target.value || null })}
                    className="rounded-lg border border-gray-300 px-2 py-1.5" />
                  <datalist id="st-items">{usedItems.map((i) => <option key={i} value={i} />)}</datalist>
                </label>
              )}

              {edit.source !== 'oneoff' && (
                <MoneyLines mode="revenue" label="訂單金額" lines={revLines} onChange={setRevLines}
                  hint="外幣換匯後併入營收。台幣是清單裡的一列,不必另外找欄位。" />
              )}

              {/*
                收退押金的動作搬到「押金管理」頁了(migration_56)。
                這裡只填金額 —— 金額是訂單條件的一部分,收退是之後才發生的事,
                混在同一個表單裡會讓「這張單成立了沒」跟「錢收到了沒」分不清楚。
              */}
              {edit.source !== 'oneoff' && edit.id && (
                <div className="col-span-2 text-xs text-gray-400 bg-mor-sand/30 rounded-lg px-3 py-2">
                  押金的收退日期與入款帳戶請到「押金管理」頁維護,填了金額就會自動出現在那裡。
                </div>
              )}
              {edit.source !== 'oneoff' && (
                <MoneyLines mode="deposit" label="押金" lines={depLines} onChange={setDepLines}
                  /*
                    新單還沒有 id，押金也還沒產生，這時給連結會連到空的清單，
                    所以只有已存檔的訂單才顯示。
                  */
                  action={edit.id ? (
                    <a href={`/deposits?order=${edit.id}`} target="_blank" rel="noreferrer"
                      className="text-xs text-mor-blue underline hover:text-mor-slate">收退狀態 →</a>
                  ) : null}
                  hint="押金原幣退還,不換匯,所以沒有匯率欄。填了金額就會自動出現在押金管理頁,收退日期與帳戶在那裡維護。" />
              )}
              <label className="flex flex-col gap-1">收款方式<select value={edit.account ?? ''} onChange={(e) => setEdit({ ...edit, account: e.target.value || null })} className="rounded-lg border border-gray-300 px-2 py-1.5"><option value="">—</option><option value="現金">現金</option>{payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}<option value="加密貨幣">加密貨幣</option></select></label>
              {/*
                發票。設計比照契約:勾了才會在收款視窗出現號碼欄位。
                抬頭留空時用客戶名稱 —— 大部分情況兩者相同,不該強迫再打一次。
              */}
              <div className="col-span-2 rounded-lg border border-mor-line p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!edit.invoice_required}
                    onChange={(e) => setEdit({ ...edit, invoice_required: e.target.checked })} />
                  需開立發票
                </label>
                {edit.invoice_required && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">發票抬頭<span className="ml-1">（留空用客戶名稱）</span></span>
                      <input value={edit.invoice_title ?? ''} placeholder={edit.guest_name ?? ''}
                        onChange={(e) => setEdit({ ...edit, invoice_title: e.target.value })}
                        className="h-11 md:h-8 rounded-lg border border-gray-300 px-2 text-sm" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">統一編號</span>
                      <input value={edit.invoice_tax_id ?? ''} inputMode="numeric" maxLength={8}
                        onChange={(e) => setEdit({ ...edit, invoice_tax_id: e.target.value.replace(/\D/g, '') })}
                        className="h-11 md:h-8 rounded-lg border border-gray-300 px-2 text-sm" />
                    </label>
                  </div>
                )}
                <div className="text-[11px] text-gray-400 mt-2">
                  {edit.invoice_required
                    ? '發票號碼在「收款」視窗填寫,收到錢的同時記下來。'
                    : '勾選後,收款視窗會出現發票號碼欄位。'}
                </div>
              </div>

              <label className="flex flex-col gap-1 col-span-2">備註<input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              {edit.source !== 'oneoff' && (
                <div className="col-span-2 border-t border-mor-line pt-3 mt-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">加費({ONEOFF_LABEL})</span>
                    <button type="button" onClick={addFee} className="text-xs text-mor-blue underline hover:text-mor-slate">+ 新增加費</button>
                  </div>
                  {fees.length === 0 && <p className="text-xs text-gray-400">尚無加費。清潔費/修繕費等收入,認列在該日期當月,並以「其他收入」計入營收報表。</p>}
                  <div className="flex flex-col gap-2">
                    {fees.map((f, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 bg-mor-sand/30 rounded-lg px-2 py-2">
                        <input type="date" value={f.date} onChange={(e) => updFee(i, { date: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <select value={f.type} onChange={(e) => updFee(i, { type: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-xs">{FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                        <input type="number" value={f.amount || ''} onChange={(e) => updFee(i, { amount: parseFloat(e.target.value) || 0 })} placeholder="費用" className="rounded border border-gray-300 px-2 py-1 text-xs w-24" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center">
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