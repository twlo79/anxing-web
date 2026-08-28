'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
import { fetchAll } from '@/lib/fetch-all';
import Req from '@/components/Req';
import MoneyInput from '@/components/MoneyInput';
import Toast from '@/components/Toast';
import StatCard, { StatRow } from '@/components/StatCard';
import {
  OTHER_BOOKS, BOOK_LABEL, BOOK_BIZ, OTHER_BIZ_SOURCE, OTHER_BIZ_PURPOSE, type Book,
} from '@/lib/book';
import {
  totals, byMonth, byCode, unsettled, applyFilters, monthRange, prevMonth, pctChange,
  type Entry, type Filters,
} from '@/lib/other-book';

/**
 * 其他收支帳（愛皮 · 洪鯊）。
 *
 * ============================================================
 * 【這一頁跟安幸的報表哪裡不一樣】
 *
 * 安幸的營收表讀 `revenue_recognitions`（一筆長租拆成每個月認列多少）。
 * **這裡直接加總 `orders` / `expenses`** —— 兩家都是一次性收入，
 * 沒有跨月這回事（使用者確認）。
 *
 * ★ 所以**兩邊的數字不能互相對照**。安幸看的是「這個月認列多少」，
 *   這裡看的是「這個月實際收多少」。畫面上有標，不標的話
 *   會有人把兩個數字相加然後問為什麼跟銀行對不起來。
 *
 *
 * ============================================================
 * 【三個新增入口，為什麼支出有兩種】
 *
 *   ＋ 收入    直接寫進 orders —— 錢收到了就是事實，不用審核
 *   ＋ 請款    導到請款頁 —— 還沒付的錢要總經理核可（愛皮洪鯊免主管票）
 *   ＋ 支出    直接寫進 expenses —— 已經付掉、只是補記的帳
 *
 * 「請款」與「支出」的差別是**錢出去了沒**:
 * 請款是「要付」，支出是「付過了」。混成一個入口的話，
 * 會出現「已經付掉的錢還在等核可」這種卡住的單。
 */

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
const thisYm = () => new Date().toISOString().slice(0, 7);
const CTRL = 'h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm';

type Code = { code: string; name: string; kind?: string; book?: string };

type IncomeDraft = {
  date: string; party: string; code: string; item: string;
  amount: number; account: string; paid: boolean; note: string;
};
type ExpenseDraft = {
  date: string; item: string; code: string; amount: number;
  method: string; account: string; voucher: string; note: string;
};

export default function OtherBooksPage() {
  const supabase = useMemo(() => createClient(), []);
  const { role } = useProfile();
  /*
   * 會計 ＋ 總經理（使用者指定）。
   *
   * ★ 不渲染而不是灰掉 —— 灰掉的分頁會讓人一直去點然後問
   *   「為什麼我不能用」。跟權限管理頁同樣的處理。
   */
  const canSee = role === 'accountant' || role === 'super_admin';

  const [book, setBook] = useState<Book>('aipi');
  const [tab, setTab] = useState<'ledger' | 'dash'>('ledger');
  const [ym, setYm] = useState(thisYm());
  const [rows, setRows] = useState<Entry[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [accounts, setAccounts] = useState<{ code: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [f, setF] = useState<Filters>({});
  const [inc, setInc] = useState<IncomeDraft | null>(null);
  const [exp, setExp] = useState<ExpenseDraft | null>(null);
  const [busy, setBusy] = useState(false);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  /*
   * 撈**近 13 個月**而不是只撈當月。
   *
   * 儀錶板要畫近 12 個月的趨勢，再多一個月是為了算「跟上月比」。
   * 只撈當月的話切到儀錶板要再查一次 —— 而那一次的等待
   * 剛好落在使用者已經以為載完了的時候。
   */
  const load = useCallback(async () => {
    if (!canSee) { setLoading(false); return; }
    setLoading(true);
    setErr('');
    const [y, m] = ym.split('-').map(Number);
    const from = `${new Date(Date.UTC(y, m - 13, 1)).toISOString().slice(0, 7)}-01`;
    const { to } = monthRange(ym);

    const [ordRes, expRes] = await Promise.all([
      fetchAll<Record<string, unknown>>((a, b) => supabase.from('orders')
        .select('id, checkin, guest_name, account_code, item_name, fee_type, amount, note, paid')
        .eq('book', book).eq('source', OTHER_BIZ_SOURCE)
        .gte('checkin', from).lte('checkin', to).range(a, b)),
      fetchAll<Record<string, unknown>>((a, b) => supabase.from('expenses')
        .select('id, spent_on, item_name, account_code, amount, note')
        .eq('book', book)
        .gte('spent_on', from).lte('spent_on', to).range(a, b)),
    ]);

    /*
     * ★★ 撈失敗要講出來，不能只顯示空清單。
     *   空的清單跟「這個月沒有生意」長得一模一樣 ——
     *   而那正是最不該搞錯的兩件事。
     */
    if (ordRes.error || expRes.error) {
      setErr('載入失敗：' + (ordRes.error ?? expRes.error ?? ''));
      setLoading(false);
      return;
    }

    const ent: Entry[] = [
      ...ordRes.rows.map((o) => ({
        id: String(o.id), kind: 'income' as const,
        date: (o.checkin as string) ?? null,
        name: (o.item_name as string) || (o.fee_type as string) || '收入',
        account_code: (o.account_code as string) ?? null,
        party: (o.guest_name as string) ?? null,
        amount: Number(o.amount) || 0,
        note: (o.note as string) ?? null,
        settled: !!o.paid,
      })),
      ...expRes.rows.map((e) => ({
        id: String(e.id), kind: 'expense' as const,
        date: (e.spent_on as string) ?? null,
        name: (e.item_name as string) || '支出',
        account_code: (e.account_code as string) ?? null,
        party: null,
        amount: Number(e.amount) || 0,
        note: (e.note as string) ?? null,
        // 支出是錢已經出去才產生的紀錄，沒有「還沒付」這回事
        settled: true,
      })),
    ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

    setRows(ent);
    setLoading(false);
  }, [supabase, book, ym, canSee]);

  useEffect(() => { load(); }, [load]);

  // 科目與收款帳戶。切帳本要重查 —— 兩家的科目完全不同
  useEffect(() => {
    if (!canSee) return;
    supabase.from('account_codes').select('code, name, kind, book')
      .eq('book', book).eq('active', true).order('sort')
      .then(({ data }) => setCodes((data ?? []) as Code[]));
  }, [supabase, book, canSee]);
  useEffect(() => {
    if (!canSee) return;
    supabase.from('payment_accounts').select('code, name').eq('active', true).order('sort')
      .then(({ data }) => setAccounts((data ?? []) as { code: string; name: string }[]));
  }, [supabase, canSee]);

  const codeName = useMemo(
    () => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const incomeCodes = useMemo(() => codes.filter((c) => c.kind !== 'expense'), [codes]);
  const expenseCodes = useMemo(() => codes.filter((c) => c.kind !== 'income'), [codes]);
  const nameOf = useCallback(
    (c: string | null) => (c ? codeName[c] ?? c : '未分類'), [codeName]);

  /** 這個月的（列表與儀錶板都用它）。 */
  const cur = useMemo(() => {
    const { from, to } = monthRange(ym);
    return rows.filter((e) => (e.date ?? '') >= from && (e.date ?? '') <= to);
  }, [rows, ym]);

  const shown = useMemo(() => applyFilters(cur, f), [cur, f]);
  const sum = useMemo(() => totals(shown), [shown]);

  /* ══════════════ 新增 ══════════════ */

  async function saveIncome() {
    if (!inc) return;
    if (!inc.date) return setErr('請填日期');
    if (!inc.code) return setErr('請選會計科目');
    if (!(Number(inc.amount) > 0)) return setErr('請填金額');
    setBusy(true); setErr('');
    /*
     * ★★ 要看寫進去幾列。RLS 或觸發器擋下的 insert 回成功且影響 0 列 ——
     *   只看 error 的話畫面會說「已新增」而那筆根本沒進去。
     */
    const { data, error } = await supabase.from('orders').insert({
      source: OTHER_BIZ_SOURCE, book,
      order_key: `OB_${book}_${Date.now()}${Math.floor(Math.random() * 1000)}`,
      imported_via: 'manual',
      guest_name: inc.party.trim() || null,
      // 一次性收入:入住＝退房＝那一天。營收按這天分月
      checkin: inc.date, checkout: inc.date, nights: 0,
      amount: Math.round(Number(inc.amount) || 0),
      account_code: inc.code,
      item_name: inc.item.trim() || null,
      account: inc.account || null,
      paid: inc.paid,
      paid_at: inc.paid ? inc.date : null,
      note: inc.note.trim() || null,
    }).select('id');
    setBusy(false);
    if (error) return setErr('存不進去：' + error.message);
    if (!data?.length) return setErr('沒有任何一列被寫入，通常是權限問題。請重新整理後再試。');
    setInc(null); flash('已新增收入'); load();
  }

  async function saveExpense() {
    if (!exp) return;
    if (!exp.date) return setErr('請填日期');
    if (!exp.item.trim()) return setErr('請填項目名稱');
    if (!exp.code) return setErr('請選會計科目');
    if (!(Number(exp.amount) > 0)) return setErr('請填金額');
    setBusy(true); setErr('');
    const { data, error } = await supabase.from('expenses').insert({
      book, spent_on: exp.date,
      item_name: exp.item.trim(),
      amount: Math.round(Number(exp.amount) || 0),
      amount_original: Math.round(Number(exp.amount) || 0),
      account_code: exp.code,
      // 兩家沒有房子 —— 用途一律 other_biz，物業與房源都是 null
      purpose_type: OTHER_BIZ_PURPOSE, estate_id: null, property_id: null,
      payment_method: exp.method || null,
      pay_account: exp.account || null,
      voucher_no: exp.voucher.trim() || null,
      note: exp.note.trim() || null,
      created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    }).select('id');
    setBusy(false);
    if (error) return setErr('存不進去：' + error.message);
    if (!data?.length) return setErr('沒有任何一列被寫入，通常是權限問題。請重新整理後再試。');
    setExp(null); flash('已新增支出'); load();
  }

  if (!canSee) {
    return (
      <div className="p-6">
        <h1 className="text-xl md:text-2xl font-semibold mb-3">其他收支帳</h1>
        <div className="rounded-xl border border-mor-line bg-white px-6 py-16 text-center text-gray-400">
          這一頁只有會計與總經理看得到。
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <Toast msg={msg} />

      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h1 className="text-xl md:text-2xl font-semibold">其他收支帳</h1>
        <span className="text-xs text-gray-400">
          {BOOK_LABEL[book]}・{BOOK_BIZ[book]}
        </span>
      </div>

      {/*
        帳本切換。用膠囊而不是分頁 ——
        底下還有一層分頁（收支帳／儀錶板），兩層都做成底線式的話分不出階層。
      */}
      <div className="flex gap-1.5 mb-3">
        {OTHER_BOOKS.map((b) => (
          <button key={b} onClick={() => { setBook(b); setF({}); }}
            className={`px-5 h-10 md:h-9 rounded-full text-sm font-medium transition-colors ${
              book === b
                ? 'bg-mor-slate text-white'
                : 'bg-white border border-mor-line text-gray-600 hover:bg-mor-sand/50'}`}>
            {BOOK_LABEL[b]}
          </button>
        ))}
      </div>

      {/* 分頁樣式以權限管理頁為準（底線式，不是膠囊） */}
      <div className="flex gap-1 border-b border-mor-line mb-4">
        {([['ledger', '收支帳'], ['dash', '儀錶板']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2.5 md:py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === k
                ? 'border-mor-slate text-mor-slate font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 mb-3">{err}</div>
      )}

      {/* 月份 ＋ 三個新增入口 */}
      {/*
        手機上月份自己一行、三顆新增按鈕平分寬度。
        用 flex-wrap 讓它們自然折行的話，會變成「兩顆一行、一顆掉下來」——
        那個落單的按鈕看起來像壞掉。
      */}
      <div className="flex flex-wrap items-center gap-2 mb-2 md:mb-4">
        <input type="month" value={ym} onChange={(e) => setYm(e.target.value || thisYm())}
          className="h-10 md:h-9 rounded-lg border border-mor-line bg-white px-2 text-sm" />
        <div className="mr-auto text-xs text-gray-400">
          {loading ? '載入中…' : `共 ${shown.length} 筆`}
        </div>
        {tab === 'ledger' && (
          <div className="w-full md:w-auto grid grid-cols-3 md:flex gap-2">
            <button onClick={() => { setErr(''); setInc({ date: today(), party: '', code: '', item: '', amount: 0, account: '', paid: true, note: '' }); }}
              className="h-11 md:h-9 rounded-lg bg-mor-slate text-white px-2 md:px-4 text-sm font-medium hover:bg-mor-slatedark">
              ＋ 收入
            </button>
            {/*
              請款要走審核（愛皮洪鯊只要總經理一票）—— 導到請款頁，
              不在這裡做一套。兩套審核流程遲早會不一致。
            */}
            <a href="/purchases"
              className="h-11 md:h-9 flex items-center justify-center rounded-lg border border-mor-line bg-white px-2 md:px-4 text-sm font-medium hover:bg-mor-sand/60">
              ＋ 請款
            </a>
            <button onClick={() => { setErr(''); setExp({ date: today(), item: '', code: '', amount: 0, method: 'cash', account: '', voucher: '', note: '' }); }}
              className="h-11 md:h-9 rounded-lg border border-mor-line bg-white px-2 md:px-4 text-sm font-medium hover:bg-mor-sand/60">
              ＋ 支出
            </button>
          </div>
        )}
      </div>

      {tab === 'ledger' ? (
        <>
          {/* 篩選 */}
          {/* 手機:兩個下拉並排一行、關鍵字自己一行。三個擠一行的話每個只剩 110px */}
          <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2 mb-3">
            <select value={f.kind ?? ''} onChange={(e) => setF({ ...f, kind: e.target.value as Filters['kind'] })}
              className="h-10 md:h-9 rounded-lg border border-mor-line bg-white px-2 text-sm">
              <option value="">收入與支出</option>
              <option value="income">只看收入</option>
              <option value="expense">只看支出</option>
            </select>
            <select value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })}
              className="h-10 md:h-9 rounded-lg border border-mor-line bg-white px-2 text-sm">
              <option value="">全部科目</option>
              {codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <input value={f.kw ?? ''} onChange={(e) => setF({ ...f, kw: e.target.value })}
              placeholder="項目／對象／備註"
              className="col-span-2 md:col-span-1 h-10 md:h-9 rounded-lg border border-mor-line bg-white px-2 text-sm md:flex-1 md:min-w-[10rem]" />
            {(f.kind || f.code || f.kw) && (
              <button onClick={() => setF({})} className="col-span-2 md:col-span-1 h-10 md:h-9 px-3 text-sm text-mor-blue underline">清除</button>
            )}
          </div>

          {/*
            小計。篩選之後也要更新 —— 不然篩了半天上面還是全月的數字。

            ★★ 改用共用的 StatCard（2026-08-25）。原本是 `bg-mor-sand/30` 的
              小方塊 —— 全站第 4 種統計卡的長相,而它跟旁邊那些卡是同一種東西。

            ★ 顏色留著:收入綠、支出紅、淨額負數才紅。
              這裡的紅**不是**警示,是會計上的借貸方向,
              所以由呼叫端決定,不進 StatCard 的 tone。
          */}
          <StatRow cols={3} className="mb-3">
            {([['收入', sum.income, 'text-mor-green'], ['支出', sum.expense, 'text-red-600'],
              ['淨額', sum.net, sum.net < 0 ? 'text-red-600' : '']] as const).map(([l, v, cls]) => (
              <StatCard key={l} label={l} value={<span className={cls}>{fmt(v)}</span>} />
            ))}
          </StatRow>

          {loading ? (
            <div className="text-center text-gray-400 py-16">載入中…</div>
          ) : !shown.length ? (
            <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center text-gray-400">
              {cur.length ? '沒有符合篩選的紀錄。' : `${BOOK_LABEL[book]}這個月還沒有收支紀錄。`}
            </div>
          ) : (
            <>
            {/*
              ══════════ 手機卡片 ══════════

              表格在 390px 寬只能橫向滑 —— 看得到但用不了
              （docs/UI體檢-2026-08-19.md 的 P0 就是這件事）。

              ★ 卡片的排法是「錢在右邊、事在左邊」:
                金額靠右對齊在同一條垂直線上，用眼睛掃就能比大小。
                塞在文字中間的話每一列的位置都不一樣，得一個一個讀。
            */}
            <div className="md:hidden space-y-2">
              {shown.map((e) => (
                <div key={`m-${e.kind}-${e.id}`} className="rounded-xl border border-mor-line bg-white px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          e.kind === 'income' ? 'bg-mor-greenlight text-mor-green' : 'bg-red-50 text-red-600'}`}>
                          {e.kind === 'income' ? '收' : '支'}
                        </span>
                        <span className="font-medium truncate">{e.name}</span>
                        {e.kind === 'income' && !e.settled && (
                          <span className="shrink-0 rounded bg-amber-50 text-amber-700 px-1.5 py-0.5 text-[11px]">未收</span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        {e.date}・{nameOf(e.account_code)}
                        {e.party ? `・${e.party}` : ''}
                      </div>
                      {e.note && <div className="text-[11px] text-gray-400 mt-0.5 truncate">{e.note}</div>}
                    </div>
                    <div className={`shrink-0 text-right font-bold tabular-nums ${
                      e.kind === 'income' ? '' : 'text-red-600'}`}>
                      {e.kind === 'income' ? '' : '−'}{fmt(e.amount)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 桌機表格 */}
            <div className="hidden md:block rounded-xl border border-mor-line bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-mor-sand/40 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left whitespace-nowrap">日期</th>
                    <th className="px-3 py-2 text-left">項目</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap">會計科目</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap">對象</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">金額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-mor-line/40">
                  {shown.map((e) => (
                    <tr key={`${e.kind}-${e.id}`} className="even:bg-mor-sand/20 hover:bg-mor-sand/60">
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">{e.date}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            e.kind === 'income' ? 'bg-mor-greenlight text-mor-green' : 'bg-red-50 text-red-600'}`}>
                            {e.kind === 'income' ? '收' : '支'}
                          </span>
                          <span className="truncate">{e.name}</span>
                          {/* 還沒收的錢要標出來 —— 那是唯一會讓人今天做一件事的資訊 */}
                          {e.kind === 'income' && !e.settled && (
                            <span className="shrink-0 rounded bg-amber-50 text-amber-700 px-1.5 py-0.5 text-[11px]">未收</span>
                          )}
                        </div>
                        {e.note && <div className="text-[11px] text-gray-400 truncate">{e.note}</div>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{nameOf(e.account_code)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{e.party ?? '—'}</td>
                      <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                        e.kind === 'income' ? '' : 'text-red-600'}`}>
                        {e.kind === 'income' ? '' : '−'}{fmt(e.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      ) : (
        <Dashboard rows={rows} cur={cur} ym={ym} nameOf={nameOf} loading={loading} book={book} />
      )}

      {/* ══════════════ 新增收入 ══════════════ */}
      {inc && (
        <Modal title={`新增收入・${BOOK_LABEL[book]}`} onClose={() => setInc(null)}
          onSave={saveIncome} busy={busy} err={err}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">日期<Req /></span>
              <input type="date" value={inc.date} onChange={(e) => setInc({ ...inc, date: e.target.value })} className={CTRL} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">會計科目<Req /></span>
              <select value={inc.code} onChange={(e) => setInc({ ...inc, code: e.target.value })} className={CTRL}>
                <option value="">—</option>
                {incomeCodes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">客戶／對象</span>
              <input value={inc.party} onChange={(e) => setInc({ ...inc, party: e.target.value })}
                placeholder={book === 'aipi' ? '團體名稱、客戶' : '標的、券商'} className={CTRL} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">金額<Req /></span>
              <MoneyInput value={inc.amount} onChange={(n) => setInc({ ...inc, amount: n })}
                className={CTRL + ' text-right'} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">項目說明</span>
              <input value={inc.item} onChange={(e) => setInc({ ...inc, item: e.target.value })}
                placeholder="例：8月東京團" className={CTRL} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">收款方式</span>
              <select value={inc.account} onChange={(e) => setInc({ ...inc, account: e.target.value })} className={CTRL}>
                <option value="">—</option>
                <option value="現金">現金</option>
                {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
              </select>
            </label>
          </div>
          {/*
            「已收款」預設打勾 —— 大部分是收到錢才記帳。
            取消勾選的會進儀錶板的「還沒收的錢」。
          */}
          <label className="flex items-center gap-2 text-sm mt-3">
            <input type="checkbox" checked={inc.paid} onChange={(e) => setInc({ ...inc, paid: e.target.checked })} />
            已收款
            <span className="text-xs text-gray-400">取消勾選的會出現在儀錶板的「還沒收的錢」</span>
          </label>
          <label className="flex flex-col gap-1 mt-3">
            <span className="text-xs text-gray-500">備註</span>
            <textarea value={inc.note} onChange={(e) => setInc({ ...inc, note: e.target.value })}
              className="bg-white rounded-lg border border-mor-line px-2 py-2 h-16 text-sm" />
          </label>
        </Modal>
      )}

      {/* ══════════════ 新增支出 ══════════════ */}
      {exp && (
        <Modal title={`新增支出・${BOOK_LABEL[book]}`} onClose={() => setExp(null)}
          onSave={saveExpense} busy={busy} err={err}>
          {/*
            ★ 這裡是「已經付掉、只是補記」的支出。
              還沒付的錢請走請款單 —— 那條要總經理核可。
              混成一個入口的話會出現「已經付掉的錢還在等核可」這種卡住的單。
          */}
          <div className="rounded-lg bg-mor-bluelight text-mor-slate px-3 py-2 text-xs mb-3">
            這裡記的是<b>已經付掉</b>的錢。還沒付的請走「＋ 請款」，那條要總經理核可。
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">支出日期<Req /></span>
              <input type="date" value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} className={CTRL} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">會計科目<Req /></span>
              <select value={exp.code} onChange={(e) => setExp({ ...exp, code: e.target.value })} className={CTRL}>
                <option value="">—</option>
                {expenseCodes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">項目名稱<Req /></span>
              <input value={exp.item} onChange={(e) => setExp({ ...exp, item: e.target.value })}
                placeholder={book === 'aipi' ? '例：東京團機票' : '例：券商手續費'} className={CTRL} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 flex items-center">金額<Req /></span>
              <MoneyInput value={exp.amount} onChange={(n) => setExp({ ...exp, amount: n })}
                className={CTRL + ' text-right'} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">支出方式</span>
              <select value={exp.method} onChange={(e) => setExp({ ...exp, method: e.target.value })} className={CTRL}>
                <option value="cash">現金</option>
                <option value="transfer">匯款</option>
                <option value="credit_card">信用卡</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">付款帳號</span>
              <select value={exp.account} onChange={(e) => setExp({ ...exp, account: e.target.value })} className={CTRL}>
                <option value="">—（現金）</option>
                {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">憑證號碼</span>
              <input value={exp.voucher} onChange={(e) => setExp({ ...exp, voucher: e.target.value })}
                placeholder="發票／收據號碼" className={CTRL} />
            </label>
          </div>
          <label className="flex flex-col gap-1 mt-3">
            <span className="text-xs text-gray-500">備註</span>
            <textarea value={exp.note} onChange={(e) => setExp({ ...exp, note: e.target.value })}
              className="bg-white rounded-lg border border-mor-line px-2 py-2 h-16 text-sm" />
          </label>
        </Modal>
      )}
    </div>
  );
}

/* ══════════════ 儀錶板 ══════════════ */

function Dashboard({
  rows, cur, ym, nameOf, loading, book,
}: {
  rows: Entry[]; cur: Entry[]; ym: string;
  nameOf: (c: string | null) => string; loading: boolean; book: Book;
}) {
  const now = useMemo(() => totals(cur), [cur]);
  const prev = useMemo(() => {
    const { from, to } = monthRange(prevMonth(ym));
    return totals(rows.filter((e) => (e.date ?? '') >= from && (e.date ?? '') <= to));
  }, [rows, ym]);
  const months = useMemo(() => byMonth(rows, ym, 12), [rows, ym]);
  const incTop = useMemo(() => byCode(cur, 'income', nameOf), [cur, nameOf]);
  const expTop = useMemo(() => byCode(cur, 'expense', nameOf), [cur, nameOf]);
  const owed = useMemo(() => unsettled(cur), [cur]);

  const peak = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));

  if (loading) return <div className="text-center text-gray-400 py-16">載入中…</div>;

  const delta = (n: number | null) =>
    (n == null
      ? <span className="text-gray-300">—</span>
      : <span className={n >= 0 ? 'text-mor-green' : 'text-red-600'}>{n >= 0 ? '▲' : '▼'} {Math.abs(n)}%</span>);

  return (
    <div className="space-y-4">
      {/*
        ★ 這一行一定要在。安幸的營收表是「認列」，這裡是「發生」——
          兩個數字不能相加，也不能互相對照。不寫的話遲早有人拿去對銀行。
      */}
      <div className="rounded-lg bg-mor-sand/40 px-3 py-2 text-xs text-gray-600">
        這裡的數字是<b>當月實際發生</b>的收支（不是認列）。
        跟安幸營收表的算法不同，兩邊不能互相對照。
      </div>

      {/*
        ★★ 改用共用的 StatCard（2026-08-25）。

        ★ 「vs 上月」四個字**拿掉了** —— 這一列只有一個比較基準,
          三張卡各寫一次等於同一句話印三遍。三角形與百分比自己說得完。
          （StatCard 的 sub 只放數字,不放句子。）
      */}
      <StatRow cols={3}>
        {([['收入', now.income, prev.income], ['支出', now.expense, prev.expense],
          ['淨額', now.net, prev.net]] as const).map(([l, v, p]) => (
          <StatCard key={l} label={l} sub={delta(pctChange(v, p))}
            value={<span className={l === '淨額' && v < 0 ? 'text-red-600' : ''}>{fmt(v)}</span>} />
        ))}
      </StatRow>

      {/* 近 12 個月 */}
      <div className="rounded-xl border border-mor-line bg-white p-3">
        <div className="text-xs text-gray-500 mb-2">近 12 個月</div>
        <div className="flex items-end gap-1 h-28">
          {months.map((m) => (
            <div key={m.ym} className="flex-1 flex flex-col justify-end items-center gap-0.5" title={`${m.ym}　收 ${fmt(m.income)}／支 ${fmt(m.expense)}`}>
              <div className="w-full flex items-end gap-px h-24">
                <div className="flex-1 bg-mor-green/70 rounded-t" style={{ height: `${(m.income / peak) * 100}%` }} />
                <div className="flex-1 bg-red-400/70 rounded-t" style={{ height: `${(m.expense / peak) * 100}%` }} />
              </div>
              {/*
                手機上 12 個標籤擠在 390px 裡會疊在一起 ——
                只印偶數月（2/4/6…），趨勢還是看得出來。
                桌機全部印。
              */}
              <div className={`text-[9px] text-gray-400 ${
                Number(m.ym.slice(5)) % 2 ? 'hidden md:block' : ''}`}>{m.ym.slice(5)}</div>
            </div>
          ))}
        </div>
        <div className="flex gap-3 text-[11px] text-gray-500 mt-2">
          <span><span className="inline-block w-2 h-2 bg-mor-green/70 rounded-sm mr-1" />收入</span>
          <span><span className="inline-block w-2 h-2 bg-red-400/70 rounded-sm mr-1" />支出</span>
        </div>
      </div>

      {/* by 科目 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {([['本月收入 by 科目', incTop], ['本月支出 by 科目', expTop]] as const).map(([l, list]) => (
          <div key={l} className="rounded-xl border border-mor-line bg-white p-3">
            <div className="text-xs text-gray-500 mb-2">{l}</div>
            {!list.length ? (
              <div className="text-xs text-gray-400 py-4 text-center">這個月沒有紀錄</div>
            ) : list.map((r) => (
              <div key={r.name} className="flex justify-between text-sm py-1">
                <span className="truncate text-gray-700">{r.name}</span>
                <span className="tabular-nums shrink-0 ml-2">{fmt(r.amount)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/*
        ★ 「還沒收的錢」是這張表上**唯一會讓人今天做一件事**的一格。
          其餘三塊是回顧，所以它不藏在底下。
      */}
      <div className="rounded-xl border border-mor-line bg-white p-3">
        <div className="text-xs text-gray-500 mb-1">還沒收的錢</div>
        {owed.n ? (
          <div className="text-lg font-bold text-amber-700 tabular-nums">
            {owed.n} 筆・{fmt(owed.amount)}
          </div>
        ) : (
          <div className="text-sm text-gray-400">
            {BOOK_LABEL[book]}這個月的收入都收齊了。
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════ 共用的視窗殼 ══════════════ */

function Modal({
  title, children, onClose, onSave, busy, err,
}: {
  title: string; children: React.ReactNode;
  onClose: () => void; onSave: () => void; busy: boolean; err: string;
}) {
  /*
   * 外層不捲、內容自己捲 —— 外層 overflow ＋ 標題 sticky 會讓標題飄
   * （2026-08-19 使用者回報「版面會跑」，見 DepositPayments 的長註解）。
   */
  return (
    <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-center justify-center md:py-10 z-50"
      onClick={onClose}>
      <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl
          flex flex-col h-full md:h-auto md:max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 flex items-center justify-between"
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <span className="font-bold">{title}</span>
          <button onClick={onClose} aria-label="關閉"
            className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6 text-sm">
          {children}
          {/* 錯誤在視窗裡 —— flash 會渲染在視窗後面而且幾秒就消失 */}
          {err && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 mt-3">{err}</div>
          )}
        </div>
        <div className="shrink-0 border-t border-mor-line px-4 md:px-6 py-3 flex gap-2"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose} disabled={busy}
            className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
          <button onClick={onSave} disabled={busy}
            className="flex-1 h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium disabled:opacity-40">
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </div>
  );
}
