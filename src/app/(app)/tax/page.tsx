'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import {
  taxPeriodOf, periodRange, periodLabel, prevPeriod, nextPeriod, periodOptions,
  sumTax, sumNet, sumTotal, invoiceCounts,
  settle, periodFigures, carryChainBreaks,
  parseOutUpload, buildItemMap, uploadError, invoiceError, amountMismatch,
  TAX_CATEGORIES, TAX_CODES, TAX_CODE_HINT, TAX_ITEM_NAMES,
  OUT_SHEET, OUT_DETAIL_SHEET,
  type TaxInvoice, type TaxKind, type PeriodRow, type ParsedUpload,
} from '@/lib/tax';
import {
  importable, importError, importSummary, toRows, pickedOf, splitTax,
  type ExpenseSrc, type InvoiceDraft,
} from '@/lib/tax-from-expense';
import { useOnce } from '@/lib/once';
import StatCard from '@/components/StatCard';
import { Tabs, TabShell } from '@/components/Tabs';
import { EXPORT_TONE } from '@/components/Actions';
import Req, { reqCls } from '@/components/Req';

/**
 * 稅務管理 —— 營業稅的進項、銷項與每期結算。
 *
 * ============================================================
 * 【整頁在做什麼】（2026-09-04 使用者:「多一個稅務管理」）
 *
 *   選期別 → 銷項上傳發票 excel（進項手 key）→ 對數字 → 結算
 *                                                    ↓
 *                                          留抵結轉到下一期
 *
 * ★★★ 三件事最容易錯，程式裡各釘了一次:
 *
 *   1. **作廢不算進申報數**。這份檔 46 張裡 3 張作廢，稅額差 21,429。
 *      每一個加總都先過 `activeInvoices()`（在 lib 裡）。
 *   2. **上期留抵不給手打**。它一律等於上一期的 carry_out ——
 *      手打的話兩期對不起來而沒有地方會叫。只有第一期例外。
 *   3. **結算＝凍結**。之後補登發票不會動到已申報的數字。
 *
 * 算式全部在 `src/lib/tax.ts`（有測試，含用真檔對出來的 108,628）。
 * 這一頁只負責畫跟存。
 *
 * ============================================================
 * 【★★ 版面照全站的規矩】（2026-09-05 過審）
 *
 *   金額上標題      跟帳戶明細一致（「帳戶明細 $6,485,619」）
 *   Chrome 式分頁   `Tabs variant="browser"` ＋ `TabShell`，不自己刻
 *   一頁一個主要動作 上傳填底、新增外框、下載 Excel 綠色外框
 *   檢視走抽屜      右側滑出，跟契約／清潔記錄同一種
 *   作廢收在編輯裡  表格上一個勾選框就能改掉已申報的數字，手滑就中
 */

/*
 * ★ 目前只做安幸。愛皮（93509086）的資料表欄位留著了，
 *   之後要加只要在這裡多一個選單（2026-09-04 使用者:「安幸的 報稅」）。
 */
const COMPANY = { taxId: '83684417', name: '安幸有限公司' };

/** 主要動作。★ 一頁只有一個 —— 這一頁是「上傳發票 excel」。 */
const PRIMARY = 'bg-mor-slate text-white hover:bg-mor-slatedark';
/** 次要動作。同色系但只有外框 —— 跟主要動作分得開，又看得出是同一組。 */
const SECONDARY = 'border border-mor-slate/50 bg-white text-mor-slate hover:bg-mor-bluelight';
const BTN = 'rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40';

type PropRow = { id: string; name: string; estate_id: string | null };
type EstateRow = { id: string; name: string };

const fmt = (n: number) => (Number(n) || 0).toLocaleString('en-US');

export default function TaxPage() {
  const supabase = useMemo(() => createClient(), []);
  const [msg, setMsg] = useState('');
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3500); }

  const thisPeriod = useMemo(() => taxPeriodOf(new Date().toISOString().slice(0, 10)), []);
  const [period, setPeriod] = useState(thisPeriod);
  const [kind, setKind] = useState<TaxKind>('out');

  const [rows, setRows] = useState<TaxInvoice[]>([]);
  const [periodsAll, setPeriodsAll] = useState<PeriodRow[]>([]);
  const [estates, setEstates] = useState<EstateRow[]>([]);
  const [props, setProps] = useState<PropRow[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * ★★★ 讀失敗要看得見。RLS 擋下來時查詢是回成功、0 列 ——
   *   畫面上就是一個很正常的「這一期沒有發票」，而稅根本沒算
   *   （CLAUDE.md:一個靜默的讀 ＋ 一個靜默的寫 ＝ 一個不存在的功能）。
   */
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [inv, per] = await Promise.all([
      supabase.from('tax_invoice').select('*')
        .eq('company_tax_id', COMPANY.taxId).eq('period', period)
        .order('invoice_date').order('invoice_no'),
      supabase.from('tax_period').select('*')
        .eq('company_tax_id', COMPANY.taxId).order('period'),
    ]);
    setLoading(false);
    if (inv.error || per.error) {
      setLoadErr((inv.error ?? per.error)!.message);
      setRows([]); setPeriodsAll([]);
      return;
    }
    setLoadErr(null);
    setRows((inv.data ?? []) as TaxInvoice[]);
    setPeriodsAll((per.data ?? []) as PeriodRow[]);
  }, [supabase, period]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    supabase.from('estates').select('id, name').eq('active', true).order('sort')
      .then(({ data }) => setEstates((data ?? []) as EstateRow[]));
    supabase.from('properties').select('id, name, estate_id').order('name')
      .then(({ data }) => setProps((data ?? []) as PropRow[]));
  }, [supabase]);

  const estName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const propName = useMemo(
    () => Object.fromEntries(props.map((p) => [p.id, p.name])), [props]);

  const outRows = useMemo(() => rows.filter((r) => r.kind === 'out'), [rows]);
  const inRows = useMemo(() => rows.filter((r) => r.kind === 'in'), [rows]);
  const shown = kind === 'out' ? outRows : inRows;
  const counts = useMemo(() => invoiceCounts(shown), [shown]);
  const outCounts = useMemo(() => invoiceCounts(outRows), [outRows]);
  const inCounts = useMemo(() => invoiceCounts(inRows), [inRows]);

  const cur: PeriodRow = useMemo(
    () => periodsAll.find((p) => p.period === period)
      ?? { period, status: 'open', carry_in: 0 },
    [periodsAll, period]);

  const fig = useMemo(
    () => periodFigures(cur, sumTax(outRows), sumTax(inRows)),
    [cur, outRows, inRows]);

  /** 上一期算出來的留抵 —— 這一期的 carry_in 應該等於它。 */
  const prevCarry = useMemo(() => {
    const p = periodsAll.find((x) => x.period === prevPeriod(period));
    return p?.carry_out == null ? null : Number(p.carry_out);
  }, [periodsAll, period]);

  const breaks = useMemo(() => carryChainBreaks(periodsAll), [periodsAll]);
  const closed = cur.status === 'closed';
  const [from, to] = periodRange(period);

  /*
   * ★★★ 含**未來兩期**（2026-09-05 使用者:「下下一期 11月甚麼時候出現」）。
   *   原本只往回數，所以 11-12 月期根本不在下拉裡 ——
   *   而發票是隨時開的:9 月就可能開出 11 月才要申報的那一張。
   * ★ 資料庫裡已經有的期別也併進來（結算過的舊期可能比 12 期還早）。
   */
  const periodOpts = useMemo(() => {
    const s = new Set([...periodOptions(thisPeriod, 12, 2), ...periodsAll.map((p) => p.period)]);
    return [...s].sort().reverse();
  }, [thisPeriod, periodsAll]);

  /*
   * ══════════ 期初留抵 ══════════
   *
   * ★★★ 這一格本來是 `defaultValue` —— 而 `defaultValue` **只在第一次掛載時讀一次**。
   *   頁面打開時資料還沒回來（是 0），資料回來之後輸入框不會跟著更新:
   *   卡片顯示 37,898、底下輸入框卻是 0（2026-09-05 使用者圈出來的）。
   *
   * ★★ 改成受控 ＋ 一個 `useEffect` 跟著 `cur.carry_in` 同步。
   *   不能只把 `defaultValue` 換成 `value` —— 那樣使用者打字時
   *   每一鍵都會被 `cur.carry_in` 蓋回去。所以要有自己的 state。
   */
  const [carryDraft, setCarryDraft] = useState('0');
  useEffect(() => { setCarryDraft(String(cur.carry_in ?? 0)); }, [cur.carry_in, period]);

  async function saveCarryIn(raw: string) {
    const v = Math.max(0, Math.round(Number(String(raw).replace(/,/g, '')) || 0));
    if (v === Number(cur.carry_in ?? 0)) return;      // 沒改就不要打資料庫
    const { data, error } = await supabase.from('tax_period').upsert({
      company_tax_id: COMPANY.taxId, period, status: 'open', carry_in: v,
    }, { onConflict: 'company_tax_id,period' }).select('id');
    if (error) { flash('期初留抵存不進去：' + error.message); return; }
    if (!data?.length) { flash('回成功但沒存到 —— 可能是權限'); return; }
    await load();
    flash(`期初留抵存好了：$${fmt(v)}`);
  }

  /* ══════════ 上傳 ══════════ */
  const [preview, setPreview] = useState<ParsedUpload | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [keepVoided, setKeepVoided] = useState(true);
  const [busy, setBusy] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    setPreview(null); setPreviewErr(null);
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const ws = wb.Sheets[OUT_SHEET];
      if (!ws) {
        setPreviewErr(`這個檔裡沒有「${OUT_SHEET}」分頁 —— 確認是財政部電子發票平台下載的銷項檔`);
        return;
      }
      const inv = XLSX.utils.sheet_to_json(ws, { defval: null }) as any[];
      const det = wb.Sheets[OUT_DETAIL_SHEET]
        ? XLSX.utils.sheet_to_json(wb.Sheets[OUT_DETAIL_SHEET], { defval: null }) as any[]
        : [];
      const items = buildItemMap(det);
      const p = parseOutUpload(inv, (no) => items[no] ?? '');
      const e = uploadError(p, period, COMPANY.taxId);
      if (e) { setPreviewErr(e); return; }
      setPreview(p);
    } catch (err: any) {
      setPreviewErr('讀不到這個檔：' + (err?.message ?? String(err)));
    }
  }

  async function importInner() {
    if (!preview || busy) return;
    if (closed) return flash('這一期已經結算，要匯入請先取消結算');
    setBusy(true);
    try {
      /*
       * ★★★ `onConflict` ＋ **更新**（不是 ignoreDuplicates）。
       *   同一個檔貼兩次時第二次覆蓋，不會多一整組。
       *   財政部的檔會補開、會作廢 —— 第二次匯入帶的是比較新的狀態。
       *   （房務那邊相反:已經對過的帳不該無聲變動。兩邊的理由不同。）
       */
      const payload = preview.rows
        .filter((r) => keepVoided || !r.voided)
        .map((r) => ({ ...r, company_tax_id: COMPANY.taxId, period }));
      const { data, error } = await supabase.from('tax_invoice')
        .upsert(payload, { onConflict: 'company_tax_id,kind,invoice_no' })
        .select('id');
      if (error) return flash('匯入失敗：' + error.message);
      if (!data?.length) return flash('匯入回成功但一列都沒寫進去 —— 可能是權限，請找管理員');
      setPreview(null);
      await load();
      flash(`已匯入 ${data.length} 張（作廢 ${preview.voidedCount} 張${keepVoided ? '也存了，但不算進申報數' : '沒存'}）`);
    } finally { setBusy(false); }
  }
  const [doImport] = useOnce(importInner);

  /* ══════════════════════════════════════════════════════════
   * 從支出帶入進項（migration_220 / 2026-09-05）
   * ══════════════════════════════════════════════════════════
   *
   * 【★★★ 這是預填，不是答案】
   *
   * `expenses` 沒有稅額欄、沒有未稅欄，所以稅額是用
   * `金額 ÷ 1.05` 反推的 —— 而反推對**免稅**是錯的
   * （房租、保險、薪資、國外服務沒有 5% 進項稅）。
   *
   * 三層緩衝:憑證號碼不合統一發票格式的不預設勾、
   * 每一列的稅額都可以改、`source` 存成 `expense` 之後查得出來源。
   *
   * 規則與測試在 `lib/tax-from-expense.ts`（29 個測試）。
   */
  const [pick, setPick] = useState<InvoiceDraft[] | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);

  async function openFromExpense() {
    if (closed) return flash('這一期已經結算，要帶入請先取消結算');
    setBusy(true);
    setPickErr(null);
    try {
      /*
       * ★ 只撈這一期的（使用者指定「支出轉入要在同月」）。
       *   `importable()` 也會再濾一次期別 —— 這裡先用日期範圍縮小查詢，
       *   那邊才是判定。兩層做的事不一樣:一層省流量，一層保證正確。
       *
       * ★★ 廠商與統編走 `request_id` → `purchase_requests`。
       *   支出表本身沒有這兩欄（2026-09-05 查證）。
       *   接不到的就是 null，畫面留空讓人補。
       */
      const { data, error } = await supabase.from('expenses')
        .select('id, spent_on, item_name, amount, voucher_no, note, estate_id, property_id,'
          + ' purchase_requests(payee_company, payee_tax_id)')
        .gte('spent_on', from).lte('spent_on', to)
        .not('voucher_no', 'is', null)
        .order('spent_on');
      if (error) return flash('讀不到支出：' + error.message);

      const rows: ExpenseSrc[] = (data ?? []).map((e: any) => ({
        id: e.id, spent_on: e.spent_on, item_name: e.item_name,
        amount: Number(e.amount) || 0,
        voucher_no: e.voucher_no, note: e.note,
        estate_id: e.estate_id, property_id: e.property_id,
        payee_company: e.purchase_requests?.payee_company ?? null,
        payee_tax_id: e.purchase_requests?.payee_tax_id ?? null,
      }));

      /*
       * ★★★ 已經帶過的不能再出現。
       *   帶兩次的話進項稅額憑空多一份，而 401 上只會顯示成
       *   「應繳比較少」—— 沒有任何地方會叫。
       * ★ 用**整家公司**的紀錄，不是只有這一期 ——
       *   同一筆支出被帶到別期去過的話，這裡也不該再出現。
       */
      const { data: taken } = await supabase.from('tax_invoice')
        .select('expense_id')
        .eq('company_tax_id', COMPANY.taxId)
        .not('expense_id', 'is', null);

      const ds = importable(rows, period, COMPANY.taxId,
        (taken ?? []).map((t: any) => t.expense_id));
      if (!ds.length) {
        return flash('這一期沒有可以帶入的支出（要有憑證號碼，而且還沒帶過）');
      }
      setPick(ds);
    } finally { setBusy(false); }
  }

  async function importExpenseInner() {
    if (!pick || busy) return;
    const err = importError(pick);
    if (err) { setPickErr(err); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.from('tax_invoice')
        .insert(toRows(pick)).select('id');
      if (error) return flash('帶入失敗：' + error.message);
      /*
       * ★★ 一定要數影響列數。RLS 擋下的 insert 不會這樣回，
       *   但寫少了幾列的話合計就少了幾筆稅額，而畫面看起來很正常。
       */
      if ((data?.length ?? 0) !== toRows(pick).length) {
        return flash(`要帶 ${toRows(pick).length} 筆，實際只進去 ${data?.length ?? 0} 筆`
          + ' —— 先不要結算，找管理員');
      }
      setPick(null);
      await load();
      flash(`已帶入 ${data!.length} 筆進項發票`);
    } finally { setBusy(false); }
  }
  const [doImportExpense] = useOnce(importExpenseInner);

  /* ══════════ 抽屜:檢視 / 編輯 / 新增 ══════════ */
  const [detail, setDetail] = useState<TaxInvoice | null>(null);
  /** 抽屜是不是在編輯模式。新增時一開始就是 true。 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<TaxInvoice> | null>(null);
  const [tried, setTried] = useState(false);
  const draftErr = draft ? invoiceError(draft) : null;
  const mismatch = draft ? amountMismatch(draft) : null;

  function openNew() {
    setDetail(null);
    setDraft({
      kind, period, invoice_date: from, invoice_no: '',
      category: kind === 'out' ? '收入' : '費用',
      tax_code: kind === 'out' ? '21' : '25',
      net_amount: 0, tax_amount: 0, total_amount: 0, voided: false,
    });
    setEditing(true); setTried(false);
  }
  function openView(r: TaxInvoice) {
    setDetail(r); setDraft(null); setEditing(false); setTried(false);
  }
  function closeDrawer() {
    setDetail(null); setDraft(null); setEditing(false); setTried(false);
  }

  async function saveInner() {
    if (!draft || busy) return;
    setTried(true);
    if (draftErr) return flash(draftErr);
    if (closed) return flash('這一期已經結算，要改請先取消結算');
    setBusy(true);
    try {
      const body = { ...draft, company_tax_id: COMPANY.taxId, period, source: draft.source ?? 'manual' };
      const q = draft.id
        ? supabase.from('tax_invoice').update(body).eq('id', draft.id).select('*')
        : supabase.from('tax_invoice').insert(body).select('*');
      const { data, error } = await q;
      if (error) return flash('存不進去：' + error.message);
      // ★ 數影響列數 —— RLS 擋下的 UPDATE 回成功且 0 列（CLAUDE.md）
      if (!data?.length) return flash('回成功但沒寫進去 —— 可能是權限，請找管理員');
      await load();
      // 存完留在抽屜裡看結果，不要直接關掉 —— 使用者常常要接著改下一欄
      setDetail(data[0] as TaxInvoice); setDraft(null); setEditing(false); setTried(false);
      flash('存好了');
    } finally { setBusy(false); }
  }
  const [doSave] = useOnce(saveInner);

  async function del(r: TaxInvoice) {
    if (closed) return flash('這一期已經結算，要刪請先取消結算');
    if (!confirm(
      `刪掉發票 ${r.invoice_no}？\n\n`
      + '★★ 如果只是作廢，請按「編輯」勾「作廢」——\n'
      + '作廢的列要留著才對得回財政部的檔，而發票號碼是連號的，中間少一號會被問。',
    )) return;
    const { data, error } = await supabase.from('tax_invoice').delete().eq('id', r.id!).select('id');
    if (error) return flash('刪不掉：' + error.message);
    if (!data?.length) return flash('回成功但沒刪掉 —— 可能是權限');
    closeDrawer();
    await load(); flash('刪掉了');
  }

  /* ══════════ 結算 ══════════ */
  async function closeInner() {
    if (busy) return;
    const s = settle(sumTax(outRows), sumTax(inRows), cur.carry_in);
    if (!confirm(
      `結算 ${periodLabel(period)}？\n\n`
      + `銷項稅 ${fmt(s.outTax)}\n進項稅 ${fmt(s.inTax)}\n上期留抵 ${fmt(s.carryIn)}\n`
      + `→ ${s.payable > 0 ? `應繳 ${fmt(s.payable)}` : `累積留抵 ${fmt(s.carryOut)}`}\n\n`
      + '★ 結算之後這四個數字凍結，補登發票不會再改到它們。',
    )) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.from('tax_period').upsert({
        company_tax_id: COMPANY.taxId, period,
        status: 'closed', carry_in: cur.carry_in,
        out_tax: s.outTax, in_tax: s.inTax,
        payable: s.payable, carry_out: s.carryOut,
        closed_at: new Date().toISOString(),
      }, { onConflict: 'company_tax_id,period' }).select('id');
      if (error) return flash('結算失敗：' + error.message);
      if (!data?.length) return flash('回成功但沒存到 —— 可能是權限');
      /*
       * ★★★ 順手把下一期的「上期留抵」建好。不建的話下一期打開會是 0，
       *   而使用者不會發現少了一截 —— 留抵是一條鏈，斷一環後面全錯。
       * ★★ 下一期**已經結算過**就不要覆蓋 —— 那會無聲改掉一期已申報的數字。
       */
      const nx = nextPeriod(period);
      const nxRow = periodsAll.find((p) => p.period === nx);
      if (nxRow?.status === 'closed') {
        flash(`已結算。★ 下一期（${periodLabel(nx)}）已經結算過，`
            + '上期留抵沒有自動更新 —— 要重算請先取消它的結算');
      } else {
        const { error: e2 } = await supabase.from('tax_period').upsert({
          company_tax_id: COMPANY.taxId, period: nx,
          status: 'open', carry_in: s.carryOut,
        }, { onConflict: 'company_tax_id,period' });
        if (e2) flash('本期結算好了，但下一期的上期留抵沒寫進去：' + e2.message);
        else flash(`已結算。${s.payable > 0 ? `應繳 $${fmt(s.payable)}` : `留抵 $${fmt(s.carryOut)} 結轉下一期`}`);
      }
      await load();
    } finally { setBusy(false); }
  }
  const [doClose] = useOnce(closeInner);

  async function reopen() {
    if (!confirm(
      `取消 ${periodLabel(period)} 的結算？\n\n`
      + '★★ 後面每一期的「上期留抵」都是從這一期算出來的 ——\n'
      + '取消之後那一串要重新結算一次，不然留抵會對不起來。',
    )) return;
    const { data, error } = await supabase.from('tax_period')
      .update({ status: 'open', out_tax: null, in_tax: null, payable: null, carry_out: null, closed_at: null })
      .eq('company_tax_id', COMPANY.taxId).eq('period', period).select('id');
    if (error) return flash('取消失敗：' + error.message);
    if (!data?.length) return flash('回成功但沒改到 —— 可能是權限');
    await load(); flash('已取消結算。後面幾期記得重新結算一次');
  }

  /* ══════════ 匯出 ══════════ */
  function exportXlsx() {
    // ★ 作廢的**也匯出**，多一欄標記 —— 會計師要對得回財政部的檔
    const body = shown.map((r) => ({
      作廢: r.voided ? 'V' : '',
      類型: r.category ?? '', 稅碼: r.tax_code ?? '',
      日期: r.invoice_date, 發票號碼: r.invoice_no,
      [kind === 'out' ? '買方' : '廠商']: r.counterparty ?? '',
      統編: r.counterparty_tax_id ?? '',
      物業: r.estate_id ? (estName[r.estate_id] ?? '') : '',
      房源: r.property_id ? (propName[r.property_id] ?? '') : '',
      品名: r.item_name ?? '', 摘要: r.summary ?? '',
      銷售額: Number(r.net_amount) || 0,
      稅額: Number(r.tax_amount) || 0,
      總金額: Number(r.total_amount) || 0,
      收支帳: r.voucher_ref ?? '', 備註: r.note ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(body);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === 'out' ? '銷項' : '進項');
    XLSX.writeFile(wb, `${COMPANY.taxId}_${periodLabel(period)}_${kind === 'out' ? '銷項' : '進項'}.xlsx`);
  }

  /* ══════════ 畫面 ══════════ */
  const headline = fig.payable > 0
    ? { amount: fig.payable, label: '本期應繳', cls: 'bg-amber-50 text-amber-700' }
    : { amount: fig.carryOut, label: '本期留抵', cls: 'bg-mor-greenlight text-mor-green' };

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      {/* ★ 金額上標題 —— 跟帳戶明細一致（2026-09-05 使用者指定） */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
        <h1 className="text-xl font-semibold text-mor-slate">
          稅務管理 <span className="ml-1 tabular-nums">${fmt(headline.amount)}</span>
        </h1>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${headline.cls}`}>{headline.label}</span>
        <span className="text-sm text-gray-400">{COMPANY.name}　{COMPANY.taxId}</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="ml-auto rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          {periodOpts.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </select>
        <span className="text-xs text-gray-400">{from} ~ {to}</span>
      </div>

      {msg && <div className="mb-3 rounded-lg bg-mor-bluelight text-mor-slate px-3 py-2 text-sm">{msg}</div>}

      {loadErr && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          讀不到稅務資料：{loadErr}
          <div className="text-xs mt-1">★ 下面的數字全部不算數，先不要結算。</div>
        </div>
      )}

      {/* ══════════ 卡片（三張 —— 本期留抵／應繳已經在標題）══════════ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="銷項稅額" value={`$${fmt(fig.outTax)}`}
          sub={`${outCounts.active} 張${outCounts.voided ? `・作廢 ${outCounts.voided} 張不算` : ''}`} />
        <StatCard label="進項稅額" value={`$${fmt(fig.inTax)}`} sub={`${inCounts.active} 筆`} />
        <StatCard label="上期累積留抵" value={`$${fmt(fig.carryIn)}`}
          sub={prevCarry == null ? '沒有上一期 —— 期初手填' : `從 ${periodLabel(prevPeriod(period))} 帶入`} />
      </div>

      {/* ══════════ 結算 ══════════ */}
      <div className="rounded-xl glass p-4 mb-4">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-sm font-medium text-mor-slate">結算試算</div>
          <div className="text-[11px] text-gray-400">照 401 申報書的順序</div>
        </div>
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="py-1">銷項稅額</td>
              <td className="py-1 w-32 text-right tabular-nums">{fmt(fig.outTax)}</td>
              <td className="py-1 pl-4 text-[11px] text-gray-400 hidden md:table-cell">作廢的不算</td></tr>
            <tr><td className="py-1">減：進項稅額</td>
              <td className="py-1 text-right tabular-nums">({fmt(fig.inTax)})</td>
              <td className="py-1 pl-4 hidden md:table-cell" /></tr>
            <tr><td className="py-1">減：上期累積留抵</td>
              <td className="py-1 text-right tabular-nums">
                {/*
                  ★★★ 上期留抵**唯讀** —— 它一律等於上一期的累積留抵。
                    只有第一期（沒有上一期）才給填期初，而且結算後鎖住。
                */}
                {prevCarry == null && !closed
                  ? (
                    <input value={carryDraft}
                      onChange={(e) => setCarryDraft(e.target.value)}
                      onBlur={() => void saveCarryIn(carryDraft)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-28 rounded border border-gray-300 px-1.5 py-0.5 text-right tabular-nums" />
                  )
                  : `(${fmt(fig.carryIn)})`}
              </td>
              <td className="py-1 pl-4 text-[11px] hidden md:table-cell">
                {prevCarry == null
                  ? <span className="text-amber-700">沒有上一期 —— 期初留抵手填一次，離開欄位就存</span>
                  : <span className="text-mor-blue">唯讀，上期結算帶入</span>}
              </td></tr>
            <tr className="border-t border-mor-line font-medium">
              <td className="py-2">本期應繳稅額</td>
              <td className="py-2 text-right tabular-nums">
                {fig.payable > 0 ? fmt(fig.payable) : <span className="text-gray-300">—</span>}
              </td>
              <td className="py-2 pl-4 text-[11px] text-gray-400 hidden md:table-cell">
                {fig.payable > 0 ? '' : '算出來是負的，沒有要繳'}
              </td></tr>
            <tr className="font-medium text-mor-green">
              <td className="py-1">本期累積留抵稅額</td>
              <td className="py-1 text-right tabular-nums">
                {fig.payable > 0 ? <span className="text-gray-300">—</span> : fmt(fig.carryOut)}
              </td>
              <td className="py-1 pl-4 text-[11px] hidden md:table-cell">
                {fig.payable > 0 ? '' : '結轉下期'}
              </td></tr>
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-mor-line">
          {closed ? (
            <>
              <span className="rounded-full bg-mor-greenlight text-mor-green px-3 py-1 text-xs font-medium">
                已結算{cur.closed_at ? `　${String(cur.closed_at).slice(0, 10)}` : ''}
              </span>
              <button onClick={() => void reopen()} className="text-xs text-gray-500 underline">取消結算</button>
              <span className="text-[11px] text-gray-500">數字已凍結 —— 補登發票不會動到已申報的數</span>
            </>
          ) : (
            <>
              <button onClick={() => void doClose()} disabled={busy || !!loadErr}
                className={`${BTN} ${PRIMARY} px-4 py-2 text-sm`}>結算本期</button>
              <span className="text-[11px] text-gray-500">結算之後數字凍結，再改發票不會動到已申報的數</span>
            </>
          )}
        </div>
      </div>

      {/* ══════════ 從支出帶入 ══════════ */}
      {pick && (
        <div className="mb-3 rounded-lg bg-white border border-mor-line overflow-hidden">
          <div className="px-3 py-2 border-b border-mor-line">
            <div className="text-sm font-medium">從支出帶入進項發票</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              {periodLabel(period)}・有填憑證號碼、還沒帶過的支出
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500 text-left">
                <tr>
                  <th className="px-2 py-1.5 w-8"></th>
                  <th className="px-2 py-1.5 w-20">日期</th>
                  <th className="px-2 py-1.5">項目</th>
                  <th className="px-2 py-1.5 w-28">憑證號碼</th>
                  <th className="px-2 py-1.5 w-14">稅碼</th>
                  <th className="px-2 py-1.5 w-20 text-right">金額</th>
                  <th className="px-2 py-1.5 w-24 text-right">稅額</th>
                </tr>
              </thead>
              <tbody>
                {pick.map((d, i) => (
                  <tr key={d.expense_id} className="border-t border-mor-line/60">
                    <td className="px-2 py-1.5">
                      <input type="checkbox" checked={d.picked}
                        onChange={() => setPick(pick.map((x, n) =>
                          n === i ? { ...x, picked: !x.picked } : x))} />
                    </td>
                    <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{d.invoice_date.slice(5)}</td>
                    <td className="px-2 py-1.5 max-w-0 truncate" title={d.item_name}>{d.item_name}</td>
                    <td className={`px-2 py-1.5 whitespace-nowrap ${d.tax_code === 'X' ? 'text-amber-700' : ''}`}>
                      {d.invoice_no}
                    </td>
                    {/*
                      ★ 稅碼看得到才知道為什麼那一列沒勾。
                        只把勾勾拿掉的話，使用者會以為是系統漏了。
                    */}
                    <td className="px-2 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 ${d.tax_code === 'X'
                        ? 'bg-amber-50 text-amber-700' : 'bg-mor-bluelight text-mor-slate'}`}>
                        {d.tax_code}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmt(d.total_amount)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {/*
                        ★★ 稅額可以改 —— 反推對免稅是錯的（房租、保險、薪資）。
                          銷售額跟著動，讓 net + tax 永遠等於 total，
                          不然資料庫的 amount_chk 會擋下來而訊息看不懂。
                      */}
                      <input type="number" min="0" max={d.total_amount}
                        value={String(d.tax_amount)}
                        onChange={(e) => {
                          const t = Math.max(0, Math.round(Number(e.target.value) || 0));
                          setPick(pick.map((x, n) => n === i
                            ? { ...x, tax_amount: t, net_amount: x.total_amount - t } : x));
                        }}
                        className="w-20 rounded border border-mor-line px-1.5 py-0.5 text-right" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pickErr && (
            <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">{pickErr}</div>
          )}
          {/*
            ★★★ 這一段是這個功能唯一的警語，所以要講清楚代價。
              稅額是反推的 —— 免稅品項（房租、保險、薪資）沒有 5% 進項稅。
          */}
          <div className="px-3 py-1.5 text-[11px] text-gray-500 border-t border-mor-line leading-relaxed">
            稅額是用「金額 ÷ 1.05」反推的，免稅的品項要自己改成 0。
            憑證號碼不是統一發票格式的預設不勾（稅碼 X）。
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-mor-line">
            <span className="text-[11px] text-gray-600">{importSummary(pick)}</span>
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setPick(null); setPickErr(null); }}
                className={`${BTN} ${SECONDARY}`}>取消</button>
              <button onClick={() => void doImportExpense()}
                disabled={busy || !pickedOf(pick).length}
                className={`${BTN} ${PRIMARY} disabled:opacity-40`}>
                {busy ? '帶入中…' : `帶入 ${pickedOf(pick).length} 筆`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ 上傳預覽 ══════════ */}
      {previewErr && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{previewErr}</div>
      )}
      {preview && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <div className="text-sm font-medium text-amber-900">
            上傳預覽　{periodLabel(preview.periods[0] ?? period)}
          </div>
          <table className="w-full text-xs mt-2 text-amber-900">
            <tbody>
              <tr><td className="py-1">開立已確認</td>
                <td className="py-1 text-right">{preview.activeCount} 張</td>
                <td className="py-1 text-right">稅額 ${fmt(preview.activeTax)}</td>
                <td className="py-1 text-right font-medium">會算進申報數</td></tr>
              <tr><td className="py-1">作廢已確認</td>
                <td className="py-1 text-right">{preview.voidedCount} 張</td>
                <td className="py-1 text-right">稅額 ${fmt(preview.voidedTax)}</td>
                <td className="py-1 text-right font-medium">不算</td></tr>
            </tbody>
          </table>
          {preview.voidedCount > 0 && (
            <div className="text-[11px] text-amber-800 mt-1.5 leading-relaxed">
              ★ 作廢的 {preview.voidedCount} 張不算進申報數。全部算進去的話銷項稅會變
              ${fmt(preview.activeTax + preview.voidedTax)} —— 多報 ${fmt(preview.voidedTax)}。
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <button onClick={() => void doImport()} disabled={busy} className={`${BTN} ${PRIMARY}`}>
              {busy ? '匯入中…' : `確認匯入 ${keepVoided ? preview.rows.length : preview.activeCount} 張`}
            </button>
            <button onClick={() => setPreview(null)} className={`${BTN} border border-mor-line bg-white`}>取消</button>
            {/* ★ 預設留著作廢的 —— 留著才對得回財政部的檔，而且不算進申報數 */}
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-900">
              <input type="checkbox" checked={keepVoided} onChange={(e) => setKeepVoided(e.target.checked)} />
              作廢的也存進來（標記起來，不算進申報數）
            </label>
          </div>
        </div>
      )}

      {/* ══════════ Chrome 式分頁 ＋ 明細 ══════════ */}
      <TabShell tabs={
        <Tabs variant="browser" items={[
          { key: 'out' as TaxKind, label: '銷項', badge: outCounts.active },
          { key: 'in' as TaxKind, label: '進項', badge: inCounts.active },
        ]} value={kind} onChange={setKind} />
      }>
        <div className="p-3">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded bg-gray-100 text-gray-600 px-2 py-0.5">全部 {counts.all}</span>
              <span className="rounded bg-mor-bluelight text-mor-slate px-2 py-0.5">有效 {counts.active}</span>
              {counts.voided > 0 && (
                <span className="rounded bg-red-50 text-red-600 px-2 py-0.5">作廢 {counts.voided}</span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/*
                ★ 兩個分頁的第一顆都是「把資料帶進來」，位置一樣。
                  銷項的來源是平台下載的 excel，進項的來源是支出頁 ——
                  進項沒有 excel 可以上傳，而那些資料本來就在系統裡。
              */}
              {kind === 'out' && (
                <label className={`${BTN} ${PRIMARY} cursor-pointer ${closed ? 'opacity-40 pointer-events-none' : ''}`}>
                  ⬆ 上傳發票 excel
                  <input type="file" accept=".xlsx,.xls" className="hidden"
                    onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                </label>
              )}
              {kind === 'in' && (
                <button onClick={() => void openFromExpense()} disabled={closed || busy}
                  className={`${BTN} ${PRIMARY} disabled:opacity-40`}>
                  ⬆ 從支出帶入
                </button>
              )}
              <button onClick={openNew} disabled={closed} className={`${BTN} ${SECONDARY}`}>＋ 新增一筆</button>
              <button onClick={exportXlsx} disabled={shown.length === 0} className={`${BTN} ${EXPORT_TONE}`}>⬇ 下載 Excel</button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[900px]">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-2 py-2 w-14">類型</th>
                  <th className="px-2 py-2 w-12">稅碼</th>
                  <th className="px-2 py-2 w-20">日期</th>
                  <th className="px-2 py-2 w-24">發票號碼</th>
                  <th className="px-2 py-2">{kind === 'out' ? '買方' : '廠商'}</th>
                  <th className="px-2 py-2 w-20">統編</th>
                  <th className="px-2 py-2 w-16">物業</th>
                  <th className="px-2 py-2 w-16">房源</th>
                  <th className="px-2 py-2 w-16">品名</th>
                  <th className="px-2 py-2 w-20 text-right">銷售額</th>
                  <th className="px-2 py-2 w-16 text-right">稅額</th>
                  <th className="px-2 py-2 w-20 text-right">總金額</th>
                  <th className="px-2 py-2 w-14 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={13} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
                ) : shown.length === 0 ? (
                  <tr><td colSpan={13} className="px-4 py-10 text-center text-gray-400">
                    這一期還沒有{kind === 'out' ? '銷項' : '進項'}發票
                  </td></tr>
                ) : shown.map((r) => (
                  /*
                    ★★★ 作廢的整列標紅、金額加刪除線、不算進合計。
                      列**留著** —— 刪了就對不回財政部的檔，發票號碼是連號的。
                  */
                  <tr key={r.id} onClick={() => openView(r)}
                    className={`border-t border-mor-line/60 cursor-pointer hover:bg-mor-bluelight/30
                                ${r.voided ? 'bg-red-50/60 text-red-700' : ''}`}>
                    <td className="px-2 py-1.5">{r.category ?? '—'}</td>
                    <td className="px-2 py-1.5">{r.tax_code ?? '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.invoice_date?.slice(5)}</td>
                    <td className={`px-2 py-1.5 whitespace-nowrap ${r.voided ? 'line-through' : ''}`}>{r.invoice_no}</td>
                    <td className="px-2 py-1.5 truncate">
                      {r.counterparty ?? '—'}
                      {r.voided && <span className="ml-1 rounded bg-red-500 text-white px-1.5 py-0.5 text-[10px]">作廢</span>}
                    </td>
                    <td className="px-2 py-1.5 text-gray-500">{r.counterparty_tax_id ?? '—'}</td>
                    <td className="px-2 py-1.5">{r.estate_id ? (estName[r.estate_id] ?? '—') : '—'}</td>
                    <td className="px-2 py-1.5">{r.property_id ? (propName[r.property_id] ?? '—') : '—'}</td>
                    <td className="px-2 py-1.5">{r.item_name ?? '—'}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.net_amount)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.tax_amount)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.total_amount)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <span className="text-mor-blue underline">檢視</span>
                    </td>
                  </tr>
                ))}
                {shown.length > 0 && (
                  <tr className="border-t border-mor-line bg-gray-50 font-medium">
                    <td className="px-2 py-2" colSpan={9}>
                      合計
                      <span className="ml-2 text-[11px] font-normal text-gray-500">
                        {counts.active} 張{counts.voided ? '，不含作廢' : ''}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(sumNet(shown))}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(sumTax(shown))}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmt(sumTotal(shown))}</td>
                    <td className="px-2 py-2" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </TabShell>

      {/* ══════════ 歷期 ══════════ */}
      <div className="mt-6">
        <div className="text-sm font-medium text-mor-slate mb-2">歷期</div>

        {/*
          ★★ 留抵是一條鏈:每一期的「上期留抵」要等於上一期的「累積留抵」。
            對不上時畫面上只是一個看起來很正常的數字 —— 這裡是唯一會叫的地方。
        */}
        {breaks.length > 0 && (
          <div className="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
            留抵接不上：{breaks.map((b) => `${periodLabel(b.period)} 應該是 ${fmt(b.expected)}、實際 ${fmt(b.actual)}`).join('；')}
            <div className="mt-1">★ 中間那幾期重新結算一次就會接回來。</div>
          </div>
        )}

        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-3 py-2">期別</th>
                  <th className="px-3 py-2 text-right">銷項稅</th>
                  <th className="px-3 py-2 text-right">進項稅</th>
                  <th className="px-3 py-2 text-right">上期留抵</th>
                  <th className="px-3 py-2 text-right">應繳</th>
                  <th className="px-3 py-2 text-right">累積留抵</th>
                  <th className="px-3 py-2 w-20">狀態</th>
                </tr>
              </thead>
              <tbody>
                {periodsAll.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">還沒有結算過任何一期</td></tr>
                ) : [...periodsAll].sort((a, b) => b.period.localeCompare(a.period)).map((p) => (
                  <tr key={p.period} onClick={() => setPeriod(p.period)}
                    className={`border-t border-mor-line/60 cursor-pointer hover:bg-mor-bluelight/30
                                ${p.period === period ? 'bg-mor-bluelight/40' : ''}`}>
                    <td className="px-3 py-1.5">{periodLabel(p.period)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{p.out_tax == null ? '—' : fmt(Number(p.out_tax))}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{p.in_tax == null ? '—' : fmt(Number(p.in_tax))}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmt(Number(p.carry_in))}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{Number(p.payable) > 0 ? fmt(Number(p.payable)) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{p.carry_out == null ? '—' : fmt(Number(p.carry_out))}</td>
                    <td className="px-3 py-1.5">
                      <span className={`rounded px-2 py-0.5 text-[10px] ${p.status === 'closed'
                        ? 'bg-gray-100 text-gray-500' : 'bg-amber-50 text-amber-600'}`}>
                        {p.status === 'closed' ? '已結算' : '未結算'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ══════════ 抽屜：檢視 / 編輯 / 新增 ══════════ */}
      {(detail || draft) && (
        <div className="fixed inset-0 z-50" onClick={closeDrawer}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between z-10"
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              <div className="min-w-0">
                <div className="font-bold truncate">
                  {draft && !draft.id ? `新增${kind === 'out' ? '銷項' : '進項'}發票` : (detail?.invoice_no ?? draft?.invoice_no)}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {detail ? `${detail.counterparty ?? '—'}・${detail.invoice_date}` : periodLabel(period)}
                </div>
              </div>
              <button onClick={closeDrawer} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            {/* ── 檢視（唯讀）── */}
            {detail && !editing && (
              <>
                <div className="px-6 py-4 text-sm">
                  {([
                    ['類型／稅碼', `${detail.category ?? '—'}・${detail.tax_code ?? '—'}${detail.tax_code ? `　${TAX_CODE_HINT[detail.tax_code] ?? ''}` : ''}`],
                    ['統編', detail.counterparty_tax_id ?? '—'],
                    ['物業／房源', `${detail.estate_id ? (estName[detail.estate_id] ?? '—') : '—'}・${detail.property_id ? (propName[detail.property_id] ?? '—') : '—'}`],
                    ['品名', detail.item_name ?? '—'],
                    ['摘要', detail.summary ?? '—'],
                    ['金額', `${fmt(detail.net_amount)} ＋ ${fmt(detail.tax_amount)} ＝ ${fmt(detail.total_amount)}`],
                    ['收支帳', detail.voucher_ref ?? '—'],
                    ['備註', detail.note ?? '—'],
                    ['來源', detail.source === 'upload' ? '發票 excel 匯入' : '手動輸入'],
                  ] as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex gap-3 py-1.5 border-b border-mor-line/40">
                      <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{k}</div>
                      <div className="flex-1 min-w-0">{v}</div>
                    </div>
                  ))}
                  <div className="flex gap-3 py-1.5">
                    <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">狀態</div>
                    <div className="flex-1">
                      {detail.voided
                        ? <span className="rounded bg-red-50 text-red-600 px-2 py-0.5 text-xs">作廢・不算進申報數</span>
                        : <span className="rounded bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs">有效</span>}
                    </div>
                  </div>
                </div>
                <div className="px-6 py-4 border-t border-mor-line flex items-center gap-2">
                  <button onClick={() => { setDraft({ ...detail }); setEditing(true); setTried(false); }}
                    disabled={closed} className={`${BTN} ${SECONDARY}`}>編輯</button>
                  <button onClick={() => void del(detail)} disabled={closed}
                    className={`${BTN} ml-auto border border-red-300 bg-white text-red-600 hover:bg-red-50`}>刪除</button>
                </div>
                {closed && (
                  <div className="px-6 pb-4 text-[11px] text-gray-500">
                    這一期已經結算 —— 要改請先到上面「取消結算」。
                  </div>
                )}
              </>
            )}

            {/* ── 編輯 / 新增 ── */}
            {draft && editing && (
              <>
                <div className="px-6 py-4 grid grid-cols-2 gap-3 text-xs">
                  <label className="flex flex-col gap-1"><span>日期<Req /></span>
                    <input type="date" value={draft.invoice_date ?? ''} min={from} max={to}
                      onChange={(e) => setDraft({ ...draft, invoice_date: e.target.value })}
                      className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !draft.invoice_date)}`} /></label>
                  <label className="flex flex-col gap-1"><span>發票號碼<Req /></span>
                    <input value={draft.invoice_no ?? ''}
                      onChange={(e) => setDraft({ ...draft, invoice_no: e.target.value.toUpperCase() })}
                      className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !draft.invoice_no)}`} /></label>
                  <label className="flex flex-col gap-1"><span>類型</span>
                    <select value={draft.category ?? ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5">
                      {TAX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span>稅碼<Req /></span>
                    <select value={draft.tax_code ?? ''} onChange={(e) => setDraft({ ...draft, tax_code: e.target.value })}
                      className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !draft.tax_code)}`}>
                      <option value="">—</option>
                      {TAX_CODES.map((c) => <option key={c} value={c}>{c}　{TAX_CODE_HINT[c]}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1 col-span-2"><span>{kind === 'out' ? '買方' : '廠商'}</span>
                    <input value={draft.counterparty ?? ''}
                      onChange={(e) => setDraft({ ...draft, counterparty: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span>統編</span>
                    <input value={draft.counterparty_tax_id ?? ''}
                      onChange={(e) => setDraft({ ...draft, counterparty_tax_id: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                  <label className="flex flex-col gap-1"><span>品名</span>
                    <input list="tax-items" value={draft.item_name ?? ''}
                      onChange={(e) => setDraft({ ...draft, item_name: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" />
                    <datalist id="tax-items">{TAX_ITEM_NAMES.map((n) => <option key={n} value={n} />)}</datalist></label>
                  <label className="flex flex-col gap-1"><span>物業</span>
                    <select value={draft.estate_id ?? ''}
                      onChange={(e) => setDraft({ ...draft, estate_id: e.target.value || null, property_id: null })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5">
                      <option value="">—</option>
                      {estates.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span>房源</span>
                    <select value={draft.property_id ?? ''}
                      onChange={(e) => setDraft({ ...draft, property_id: e.target.value || null })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5">
                      <option value="">—</option>
                      {props.filter((p) => !draft.estate_id || p.estate_id === draft.estate_id)
                        .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span>銷售額<Req /></span>
                    <input type="number" value={draft.net_amount ?? 0}
                      onChange={(e) => setDraft({ ...draft, net_amount: Number(e.target.value) || 0 })}
                      className={`rounded-lg border px-2 py-1.5 text-right tabular-nums ${reqCls(tried && draft.net_amount == null)}`} /></label>
                  <label className="flex flex-col gap-1"><span>稅額<Req /></span>
                    <input type="number" value={draft.tax_amount ?? 0}
                      onChange={(e) => setDraft({ ...draft, tax_amount: Number(e.target.value) || 0 })}
                      className={`rounded-lg border px-2 py-1.5 text-right tabular-nums ${reqCls(tried && draft.tax_amount == null)}`} /></label>
                  <label className="flex flex-col gap-1"><span>總金額</span>
                    <input type="number" value={draft.total_amount ?? 0}
                      onChange={(e) => setDraft({ ...draft, total_amount: Number(e.target.value) || 0 })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5 text-right tabular-nums" /></label>
                  <label className="flex flex-col gap-1"><span>收支帳</span>
                    <input value={draft.voucher_ref ?? ''}
                      onChange={(e) => setDraft({ ...draft, voucher_ref: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                  <label className="flex flex-col gap-1 col-span-2"><span>摘要</span>
                    <input value={draft.summary ?? ''}
                      onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                  <label className="flex flex-col gap-1 col-span-2"><span>備註</span>
                    <input value={draft.note ?? ''}
                      onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                      className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                </div>

                {/*
                  ★★★ 作廢在這裡，不在表格上（2026-09-05 使用者指定）。
                    表格上一個勾選框就能改掉已申報的數字 —— 手滑就中。
                  ★★ 用紅底框起來跟一般欄位分開:它不是一個欄位，
                    是一個會改變申報數的動作。
                */}
                <div className="mx-6 mb-4 rounded-lg bg-red-50 border border-red-200 p-3">
                  <label className="flex items-center gap-2 text-sm text-red-800 font-medium">
                    <input type="checkbox" checked={!!draft.voided}
                      onChange={(e) => setDraft({ ...draft, voided: e.target.checked })} />
                    作廢這張發票
                  </label>
                  <div className="text-[11px] text-red-700 mt-1 leading-relaxed">
                    勾了之後不算進申報數，但列會留著 —— 發票號碼是連號的，刪掉就對不回財政部的檔。
                  </div>
                </div>

                {mismatch && <div className="px-6 pb-2 text-[11px] text-amber-700">⚠ {mismatch}</div>}
                {tried && draftErr && <div className="px-6 pb-2 text-[11px] text-red-600">{draftErr}</div>}

                <div className="px-6 py-4 border-t border-mor-line flex items-center gap-2">
                  <button onClick={() => void doSave()} disabled={busy} className={`${BTN} ${PRIMARY}`}>
                    {busy ? '存檔中…' : '儲存'}
                  </button>
                  <button onClick={() => { if (detail) { setDraft(null); setEditing(false); } else closeDrawer(); }}
                    className={`${BTN} border border-mor-line bg-white`}>取消</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
