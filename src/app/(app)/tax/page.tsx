'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import {
  taxPeriodOf, periodRange, periodLabel, prevPeriod, nextPeriod, recentPeriods,
  activeInvoices, sumTax, sumNet, sumTotal, invoiceCounts,
  settle, periodFigures, carryChainBreaks,
  parseOutUpload, buildItemMap, uploadError, invoiceError, amountMismatch,
  TAX_CATEGORIES, TAX_CODES, TAX_CODE_HINT, TAX_ITEM_NAMES,
  OUT_SHEET, OUT_DETAIL_SHEET,
  type TaxInvoice, type TaxKind, type PeriodRow, type ParsedUpload,
} from '@/lib/tax';
import { useOnce } from '@/lib/once';
import StatCard from '@/components/StatCard';
import { Tabs } from '@/components/Tabs';
import Req, { reqCls } from '@/components/Req';

/**
 * 稅務管理 —— 營業稅的進項、銷項與每期結算。
 *
 * ============================================================
 * 【整頁在做什麼】（2026-09-04 使用者:「多一個稅務管理」）
 *
 * 每兩個月申報一次。流程:
 *
 *   選期別 → 銷項上傳發票 excel（進項手 key）→ 對數字 → 結算
 *                                                    ↓
 *                                          留抵結轉到下一期
 *
 * ★★★ 三個地方最容易錯，程式裡各釘了一次:
 *
 *   1. **作廢不算進申報數**。這份檔 46 張裡 3 張作廢，稅額差 21,429。
 *      每一個加總都先過 `activeInvoices()`。
 *   2. **上期留抵不給手打**。它一律等於上一期的 carry_out ——
 *      手打的話兩期對不起來而沒有地方會叫。
 *   3. **結算＝凍結**。之後補登發票不會動到已申報的數字。
 *
 * 算式全部在 `src/lib/tax.ts`（有測試，含用真檔對出來的 108,628）。
 * 這一頁只負責畫跟存。
 */

/*
 * ★ 目前只做安幸。愛皮（93509086）的資料表欄位留著了，
 *   之後要加只要在這裡多一個選單（2026-09-04 使用者:「安幸的 報稅」）。
 */
const COMPANY = { taxId: '83684417', name: '安幸有限公司' };

type PropRow = { id: string; name: string; estate_id: string | null };
type EstateRow = { id: string; name: string };

const fmt = (n: number) => (Number(n) || 0).toLocaleString('en-US');

export default function TaxPage() {
  const supabase = useMemo(() => createClient(), []);
  const [msg, setMsg] = useState('');
  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3500); }

  /** 目前這一期（今天落在哪一期）。 */
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

  // ── 這一期的數字 ────────────────────────────────────────────
  const outRows = useMemo(() => rows.filter((r) => r.kind === 'out'), [rows]);
  const inRows = useMemo(() => rows.filter((r) => r.kind === 'in'), [rows]);
  const shown = kind === 'out' ? outRows : inRows;
  const counts = useMemo(() => invoiceCounts(shown), [shown]);

  /**
   * 這一期在資料庫裡的那一列。沒有就當成未結算、上期留抵 0。
   *
   * ★ 期初留抵:第一期沒有上一期可接，`carry_in` 手填一次
   *   （2026-09-04 使用者選「手填一次」）。之後每期自動結轉。
   */
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

  /** 期別下拉:最近 12 期 ＋ 資料庫裡已經有的。 */
  const periodOpts = useMemo(() => {
    const s = new Set([...recentPeriods(thisPeriod, 12), ...periodsAll.map((p) => p.period)]);
    return [...s].sort().reverse();
  }, [thisPeriod, periodsAll]);

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
    if (cur.status === 'closed') return flash('這一期已經結算，要匯入請先取消結算');
    setBusy(true);
    try {
      /*
       * ★★★ `onConflict: 'company_tax_id,kind,invoice_no'` ＋ **更新**（不是 ignore）。
       *   同一個檔貼兩次時第二次覆蓋，不會多一整組。
       *
       * ★★ 這裡刻意用 update 而不是 ignoreDuplicates —— 財政部的檔會補開、
       *   會作廢，第二次匯入帶的是**比較新的狀態**。房務那邊是相反的
       *   （已經對過的帳不該無聲變動），兩邊的理由不同。
       */
      const payload = preview.rows
        .filter((r) => keepVoided || !r.voided)
        .map((r) => ({ ...r, company_tax_id: COMPANY.taxId, period }));
      const { data, error } = await supabase.from('tax_invoice')
        .upsert(payload, { onConflict: 'company_tax_id,kind,invoice_no' })
        .select('id');
      if (error) return flash('匯入失敗：' + error.message);
      // ★ 數影響列數 —— RLS 擋下來時回成功且 0 列（CLAUDE.md）
      if (!data?.length) return flash('匯入回成功但一列都沒寫進去 —— 可能是權限，請找管理員');
      setPreview(null);
      await load();
      flash(`已匯入 ${data.length} 張（作廢 ${preview.voidedCount} 張${keepVoided ? '也存了，但不算進申報數' : '沒存'}）`);
    } finally { setBusy(false); }
  }
  const [doImport] = useOnce(importInner);

  /* ══════════ 作廢 ══════════ */
  async function toggleVoid(r: TaxInvoice, v: boolean) {
    if (cur.status === 'closed') return flash('這一期已經結算，要改請先取消結算');
    const { data, error } = await supabase.from('tax_invoice')
      .update({ voided: v }).eq('id', r.id!).select('id');
    if (error) return flash('改不動：' + error.message);
    if (!data?.length) return flash('回成功但一列都沒改到 —— 可能是權限，請找管理員');
    // ★ 成功才動畫面。先樂觀更新又失敗的話，留著假數字比沒改更糟
    setRows((xs) => xs.map((x) => (x.id === r.id ? { ...x, voided: v } : x)));
  }

  /* ══════════ 手 key ══════════ */
  const blank = (): Partial<TaxInvoice> => ({
    kind, period, invoice_date: periodRange(period)[0], invoice_no: '',
    category: kind === 'out' ? '收入' : '費用', tax_code: kind === 'out' ? '21' : '25',
    net_amount: 0, tax_amount: 0, total_amount: 0,
  });
  const [edit, setEdit] = useState<Partial<TaxInvoice> | null>(null);
  const [tried, setTried] = useState(false);
  const editErr = edit ? invoiceError(edit) : null;
  const mismatch = edit ? amountMismatch(edit) : null;

  async function saveInner() {
    if (!edit || busy) return;
    setTried(true);
    if (editErr) return flash(editErr);
    if (cur.status === 'closed') return flash('這一期已經結算，要改請先取消結算');
    setBusy(true);
    try {
      const body = { ...edit, company_tax_id: COMPANY.taxId, period, source: 'manual' as const };
      const q = edit.id
        ? supabase.from('tax_invoice').update(body).eq('id', edit.id).select('id')
        : supabase.from('tax_invoice').insert(body).select('id');
      const { data, error } = await q;
      if (error) return flash('存不進去：' + error.message);
      if (!data?.length) return flash('回成功但沒寫進去 —— 可能是權限，請找管理員');
      setEdit(null); setTried(false);
      await load();
      flash('存好了');
    } finally { setBusy(false); }
  }
  const [doSave] = useOnce(saveInner);

  async function del(r: TaxInvoice) {
    if (cur.status === 'closed') return flash('這一期已經結算，要刪請先取消結算');
    if (!confirm(`刪掉發票 ${r.invoice_no}？\n\n★ 如果只是作廢，請改用「作廢」欄 —— 作廢的列要留著才對得回財政部的檔。`)) return;
    const { data, error } = await supabase.from('tax_invoice').delete().eq('id', r.id!).select('id');
    if (error) return flash('刪不掉：' + error.message);
    if (!data?.length) return flash('回成功但沒刪掉 —— 可能是權限');
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
       * ★★★ 順手把下一期的「上期留抵」建好。
       *   不建的話下一期打開會是 0，而使用者不會發現少了一截 ——
       *   留抵是一條鏈，斷一環後面全錯。
       *
       * ★★ 下一期如果**已經結算過**就不要覆蓋它的 carry_in ——
       *   那會無聲改掉一期已經申報的數字。這種情況要人自己去
       *   取消結算再重算（歷期表的「留抵接不上」會叫）。
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
        // ★ 這一步失敗不算整個結算失敗，但要講 —— 不然下一期的留抵是 0 而沒人知道
        if (e2) flash('本期結算好了，但下一期的上期留抵沒寫進去：' + e2.message);
      }
      await load();
      flash(`已結算。${s.payable > 0 ? `應繳 $${fmt(s.payable)}` : `留抵 $${fmt(s.carryOut)} 結轉下一期`}`);
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

  /** 期初留抵（只有第一期、而且還沒結算時能改）。 */
  async function saveCarryIn(v: number) {
    const { error } = await supabase.from('tax_period').upsert({
      company_tax_id: COMPANY.taxId, period, status: 'open', carry_in: v,
    }, { onConflict: 'company_tax_id,period' });
    if (error) return flash('存不進去：' + error.message);
    await load();
  }

  const closed = cur.status === 'closed';
  const [from, to] = periodRange(period);

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
        <h1 className="text-xl font-semibold text-mor-slate">稅務管理</h1>
        <span className="text-sm text-gray-400">{COMPANY.name}　{COMPANY.taxId}</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="ml-auto rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          {periodOpts.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </select>
        <span className="text-xs text-gray-400">{from} ~ {to}</span>
      </div>

      {msg && (
        <div className="mb-3 rounded-lg bg-mor-bluelight text-mor-slate px-3 py-2 text-sm">{msg}</div>
      )}

      {/*
        ★★★ 讀失敗要講出來。RLS 擋下的查詢回成功、0 列 ——
          不講的話畫面上是一個很正常的「這一期沒有發票」，而稅根本沒算。
      */}
      {loadErr && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          讀不到稅務資料：{loadErr}
          <div className="text-xs mt-1">★ 下面的數字全部不算數，先不要結算。</div>
        </div>
      )}

      {/* ══════════ 卡片 ══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="銷項稅額" value={`$${fmt(fig.outTax)}`}
          sub={`${invoiceCounts(outRows).active} 張${invoiceCounts(outRows).voided ? `・作廢 ${invoiceCounts(outRows).voided} 張不算` : ''}`} />
        <StatCard label="進項稅額" value={`$${fmt(fig.inTax)}`}
          sub={`${invoiceCounts(inRows).active} 筆`} tone="slate" />
        <StatCard label="上期累積留抵" value={`$${fmt(fig.carryIn)}`}
          sub={prevCarry == null ? '沒有上一期 —— 期初手填' : `從 ${periodLabel(prevPeriod(period))} 帶入`} />
        {/*
          ★ 應繳用 amber、留抵用 slate。**不用綠色** ——
            綠在這個系統裡是「已收／通過」的意思（StatCard 的檔頭寫著），
            拿它當留抵會讓人以為那筆錢的狀態是「好的」，
            而留抵只是「還沒抵完」。
          ★★ 應繳加 `accent`:那一張是「等你動作」（要繳錢），
            跟「你正在看這一組」是兩件事。
        */}
        {fig.payable > 0
          ? <StatCard label="本期應繳稅額" value={`$${fmt(fig.payable)}`} sub="要繳出去" tone="amber" accent />
          : <StatCard label="本期累積留抵" value={`$${fmt(fig.carryOut)}`} sub="結轉到下一期" />}
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
              <td className="py-1 pl-4 text-[11px] text-gray-400 hidden md:table-cell" /></tr>
            <tr><td className="py-1">減：上期累積留抵</td>
              <td className="py-1 text-right tabular-nums">
                {/*
                  ★★★ 上期留抵**唯讀** —— 它一律等於上一期的累積留抵。
                    手打的話兩期之間對不起來，而沒有任何地方會叫。
                    只有第一期（沒有上一期）才給填期初。
                */}
                {prevCarry == null && !closed
                  ? (
                    <input type="number" defaultValue={cur.carry_in}
                      onBlur={(e) => void saveCarryIn(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      className="w-28 rounded border border-gray-300 px-1.5 py-0.5 text-right tabular-nums" />
                  )
                  : `(${fmt(fig.carryIn)})`}
              </td>
              <td className="py-1 pl-4 text-[11px] hidden md:table-cell">
                {prevCarry == null
                  ? <span className="text-amber-700">沒有上一期 —— 期初留抵手填一次</span>
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
              <span className="text-[11px] text-gray-500">
                數字已凍結 —— 補登發票不會動到已申報的數
              </span>
            </>
          ) : (
            <>
              <button onClick={() => void doClose()} disabled={busy || !!loadErr}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50">
                結算本期
              </button>
              <span className="text-[11px] text-gray-500">
                結算之後數字凍結，再改發票不會動到已申報的數
              </span>
            </>
          )}
        </div>
      </div>

      {/* ══════════ 分頁 ＋ 動作 ══════════ */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Tabs items={[
          { key: 'out' as TaxKind, label: '銷項', badge: invoiceCounts(outRows).active },
          { key: 'in' as TaxKind, label: '進項', badge: invoiceCounts(inRows).active },
        ]} value={kind} onChange={setKind} />
        <div className="ml-auto flex items-center gap-2">
          {/* ★ 上傳只在銷項 —— 進項是手 key（2026-09-04 使用者選的） */}
          {kind === 'out' && (
            <label className={`rounded-lg border border-mor-line px-3 py-1.5 text-xs cursor-pointer hover:bg-mor-bluelight/40 ${closed ? 'opacity-40 pointer-events-none' : ''}`}>
              ⬆ 上傳發票 excel
              <input type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </label>
          )}
          <button onClick={() => { setEdit(blank()); setTried(false); }} disabled={closed}
            className="rounded-lg border border-mor-line px-3 py-1.5 text-xs disabled:opacity-40">
            ＋ 新增一筆
          </button>
        </div>
      </div>

      {/* ══════════ 上傳預覽 ══════════ */}
      {previewErr && (
        <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
          {previewErr}
        </div>
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
            <button onClick={() => void doImport()} disabled={busy}
              className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs disabled:opacity-50">
              {busy ? '匯入中…' : `確認匯入 ${keepVoided ? preview.rows.length : preview.activeCount} 張`}
            </button>
            <button onClick={() => setPreview(null)} className="rounded-lg border border-mor-line px-3 py-1.5 text-xs">取消</button>
            {/*
              ★ 預設**留著作廢的**（不是排除）—— 留著才對得回財政部的檔，
                發票號碼是連號的，中間少一號會被問。留著也不算進申報數。
            */}
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-900">
              <input type="checkbox" checked={keepVoided} onChange={(e) => setKeepVoided(e.target.checked)} />
              作廢的也存進來（標記起來，不算進申報數）
            </label>
          </div>
        </div>
      )}

      {/* ══════════ 新增／編輯 ══════════ */}
      {edit && (
        <div className="mb-3 rounded-xl bg-white border border-mor-line p-4">
          <div className="text-sm font-medium text-mor-slate mb-3">
            {edit.id ? '編輯' : '新增'}{kind === 'out' ? '銷項' : '進項'}發票
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <label className="flex flex-col gap-1"><span>日期<Req /></span>
              <input type="date" value={edit.invoice_date ?? ''} min={from} max={to}
                onChange={(e) => setEdit({ ...edit, invoice_date: e.target.value })}
                className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !edit.invoice_date)}`} /></label>
            <label className="flex flex-col gap-1"><span>發票號碼<Req /></span>
              <input value={edit.invoice_no ?? ''}
                onChange={(e) => setEdit({ ...edit, invoice_no: e.target.value.toUpperCase() })}
                className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !edit.invoice_no)}`} /></label>
            <label className="flex flex-col gap-1"><span>類型</span>
              <select value={edit.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5">
                {TAX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span>稅碼<Req /></span>
              <select value={edit.tax_code ?? ''} onChange={(e) => setEdit({ ...edit, tax_code: e.target.value })}
                className={`rounded-lg border px-2 py-1.5 ${reqCls(tried && !edit.tax_code)}`}>
                <option value="">—</option>
                {TAX_CODES.map((c) => <option key={c} value={c}>{c}　{TAX_CODE_HINT[c]}</option>)}
              </select></label>

            <label className="flex flex-col gap-1 md:col-span-2">
              <span>{kind === 'out' ? '買方' : '廠商'}</span>
              <input value={edit.counterparty ?? ''}
                onChange={(e) => setEdit({ ...edit, counterparty: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex flex-col gap-1"><span>統編</span>
              <input value={edit.counterparty_tax_id ?? ''}
                onChange={(e) => setEdit({ ...edit, counterparty_tax_id: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex flex-col gap-1"><span>品名</span>
              <input list="tax-items" value={edit.item_name ?? ''}
                onChange={(e) => setEdit({ ...edit, item_name: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" />
              <datalist id="tax-items">
                {TAX_ITEM_NAMES.map((n) => <option key={n} value={n} />)}
              </datalist></label>

            <label className="flex flex-col gap-1"><span>物業</span>
              <select value={edit.estate_id ?? ''}
                onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null, property_id: null })}
                className="rounded-lg border border-gray-300 px-2 py-1.5">
                <option value="">—</option>
                {estates.map((e2) => <option key={e2.id} value={e2.id}>{e2.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span>房源</span>
              <select value={edit.property_id ?? ''}
                onChange={(e) => setEdit({ ...edit, property_id: e.target.value || null })}
                className="rounded-lg border border-gray-300 px-2 py-1.5">
                <option value="">—</option>
                {props.filter((p) => !edit.estate_id || p.estate_id === edit.estate_id)
                  .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span>收支帳</span>
              <input value={edit.voucher_ref ?? ''}
                onChange={(e) => setEdit({ ...edit, voucher_ref: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex flex-col gap-1"><span>摘要</span>
              <input value={edit.summary ?? ''}
                onChange={(e) => setEdit({ ...edit, summary: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

            <label className="flex flex-col gap-1"><span>銷售額<Req /></span>
              <input type="number" value={edit.net_amount ?? 0}
                onChange={(e) => setEdit({ ...edit, net_amount: Number(e.target.value) || 0 })}
                className={`rounded-lg border px-2 py-1.5 text-right tabular-nums ${reqCls(tried && edit.net_amount == null)}`} /></label>
            <label className="flex flex-col gap-1"><span>稅額<Req /></span>
              <input type="number" value={edit.tax_amount ?? 0}
                onChange={(e) => setEdit({ ...edit, tax_amount: Number(e.target.value) || 0 })}
                className={`rounded-lg border px-2 py-1.5 text-right tabular-nums ${reqCls(tried && edit.tax_amount == null)}`} /></label>
            <label className="flex flex-col gap-1"><span>總金額</span>
              <input type="number" value={edit.total_amount ?? 0}
                onChange={(e) => setEdit({ ...edit, total_amount: Number(e.target.value) || 0 })}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-right tabular-nums" /></label>
            <label className="flex flex-col gap-1 md:col-span-1"><span>備註</span>
              <input value={edit.note ?? ''}
                onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          </div>

          {/*
            ★★ 金額對不上只**提醒**不擋 —— 折讓單、零稅率、免稅
              本來就不成立「銷售額 ＋ 稅額 = 總金額」。
          */}
          {mismatch && (
            <div className="mt-2 text-[11px] text-amber-700">⚠ {mismatch}</div>
          )}
          {tried && editErr && (
            <div className="mt-2 text-[11px] text-red-600">{editErr}</div>
          )}
          <div className="flex gap-2 mt-3">
            <button onClick={() => void doSave()} disabled={busy}
              className="rounded-lg bg-mor-blue text-white px-4 py-1.5 text-sm disabled:opacity-50">
              {busy ? '存檔中…' : '儲存'}
            </button>
            <button onClick={() => { setEdit(null); setTried(false); }}
              className="rounded-lg border border-mor-line px-4 py-1.5 text-sm">取消</button>
          </div>
        </div>
      )}

      {/* ══════════ 明細 ══════════ */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="rounded bg-gray-100 text-gray-600 px-2 py-0.5">全部 {counts.all}</span>
        <span className="rounded bg-mor-bluelight text-mor-slate px-2 py-0.5">有效 {counts.active}</span>
        {counts.voided > 0 && (
          <span className="rounded bg-red-50 text-red-600 px-2 py-0.5">作廢 {counts.voided}</span>
        )}
      </div>

      <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1100px]">
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
                <th className="px-2 py-2 w-14 text-center">作廢</th>
                <th className="px-2 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={14} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
              ) : shown.length === 0 ? (
                <tr><td colSpan={14} className="px-4 py-10 text-center text-gray-400">
                  這一期還沒有{kind === 'out' ? '銷項' : '進項'}發票
                </td></tr>
              ) : shown.map((r) => (
                /*
                  ★★★ 作廢的整列標紅、金額加刪除線、不算進合計。
                    列**留著** —— 刪了就對不回財政部的檔，
                    而發票號碼是連號的，中間少一號會被問。
                */
                <tr key={r.id} className={`border-t border-mor-line/60 ${r.voided ? 'bg-red-50/60 text-red-700' : ''}`}>
                  <td className="px-2 py-1.5">{r.category ?? '—'}</td>
                  <td className="px-2 py-1.5">{r.tax_code ?? '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.invoice_date?.slice(5)}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${r.voided ? 'line-through' : ''}`}>{r.invoice_no}</td>
                  <td className="px-2 py-1.5 truncate">{r.counterparty ?? '—'}</td>
                  <td className="px-2 py-1.5 text-gray-500">{r.counterparty_tax_id ?? '—'}</td>
                  <td className="px-2 py-1.5">{r.estate_id ? (estName[r.estate_id] ?? '—') : '—'}</td>
                  <td className="px-2 py-1.5">{r.property_id ? (propName[r.property_id] ?? '—') : '—'}</td>
                  <td className="px-2 py-1.5">{r.item_name ?? '—'}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.net_amount)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.tax_amount)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.voided ? 'line-through' : ''}`}>{fmt(r.total_amount)}</td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={!!r.voided} disabled={closed}
                      onChange={(e) => void toggleVoid(r, e.target.checked)} />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <button onClick={() => { setEdit(r); setTried(false); }} disabled={closed}
                      className="text-mor-blue underline disabled:opacity-40">改</button>
                    <button onClick={() => void del(r)} disabled={closed}
                      className="ml-2 text-gray-400 hover:text-red-600 disabled:opacity-40">刪</button>
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
                  <td className="px-2 py-2" colSpan={2} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-[11px] text-gray-500 mt-2">
        作廢的列標紅、不算進合計。★ 不要用「刪」處理作廢 —— 刪了就對不回財政部的檔，而發票號碼是連號的。
      </div>

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
                  <tr key={p.period}
                    className={`border-t border-mor-line/60 ${p.period === period ? 'bg-mor-bluelight/40' : ''}`}>
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
    </div>
  );
}
