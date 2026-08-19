'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import Toast from '@/components/Toast';
import UploadPanel from './upload-panel';
import StatementsPanel from './statements-panel';
import { totalBalance } from '@/lib/bank-import';
import { filterTxns, hasFilter, sumRows, amountOf, splitTail, type BankFilter } from '@/lib/bank-filter';
import * as XLSX from 'xlsx-js-style';
import { ExportButton } from '@/components/Actions';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import FilterToggle from '@/components/FilterToggle';

/**
 * 帳戶明細 —— 三個銀行帳戶的流水鏡像。
 *
 * ============================================================
 * 【餘額不是算出來的，是銀行說的】
 *
 * 卡片上的數字讀 `bank_statements.closing_balance`，
 * 不是把 `bank_transactions` 加總、也不是存在帳戶主檔的快取欄位。
 *
 * 快取欄位會**慢慢跟真實對不上**：補匯一份舊對帳單、刪掉一筆重複、
 * 任何一次順序沒照預期，那一欄就錯了 —— 而且不會報錯。
 *
 * 對帳單本身就寫著期末餘額。代價是沒上傳就沒有數字，
 * 而那是誠實的 —— 本來就不知道。
 */

type Account = {
  id: string;
  name: string;
  bank: string;
  account_no: string | null;
  account_no_tail: string;
  sort: number;
};
type Stmt = {
  id: string;
  account_id: string;
  period_from: string;
  period_to: string;
  closing_balance: number | null;
  parsed_count: number;
  inserted_count: number;
  skipped_count: number;
  file_name: string | null;
  uploaded_at: string;
};
type Txn = {
  id: string;
  account_id: string;
  txn_date: string | null;
  post_date: string;
  txn_time: string | null;
  description: string | null;
  counterparty: string | null;
  debit: number;
  credit: number;
  balance: number;
  bank_balance: number | null;
  balance_note: string | null;
  memo: string | null;
  ref_no: string | null;
  seq: number | null;
};

const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
/*
 * 日期一律帶年份。
 *
 * 一個帳戶的流水橫跨 2025 與 2026 —— 只印「08/18」的話，
 * 排序或篩選之後根本看不出那是哪一年的 08/18，
 * 而**兩年的同一天會長得一模一樣**。
 */
const ymd = (d: string | null) => (d ? d.slice(0, 10).replace(/-/g, '/') : '—');

export default function AccountsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [latest, setLatest] = useState<Record<string, Stmt | undefined>>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [tab, setTab] = useState<string>('');
  const [f, setF] = useState<BankFilter>({ from: '', to: '', dir: '', min: '', max: '', q: '' });
  const set = <K extends keyof BankFilter>(k: K, v: BankFilter[K]) => setF((o) => ({ ...o, [k]: v }));
  /*
   * 預設帳務日新到舊。**null 不是「沒排序」** ——
   * 這裡給明確的初值,因為流水沒有排序等於沒辦法看。
   */
  const [sort, setSort] = useState<SortState>({ key: 'post_date', dir: 'desc' });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  // 流水 ／ 匯入紀錄。匯入紀錄是「哪一批可以撤銷」的地方
  const [view, setView] = useState<'txn' | 'stmt'>('txn');

  const loadAccounts = useCallback(async () => {
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('id, name, bank, account_no, account_no_tail, sort')
      .eq('active', true)
      .order('sort');
    if (error) {
      setMsg(`讀取帳戶失敗：${error.message}`); setErr(true);
      return [] as Account[];
    }
    const list = (data ?? []) as Account[];
    setAccounts(list);
    setTab((t) => t || list[0]?.id || '');

    /*
     * 每個帳戶最新的那一份對帳單。三個帳戶就三次查詢 ——
     * 用一次查詢再自己挑最新的也行，但那要撈回所有對帳單，
     * 而那個清單會一直長。
     */
    const map: Record<string, Stmt | undefined> = {};
    await Promise.all(
      list.map(async (a) => {
        const { data: s } = await supabase
          .from('bank_statements')
          .select('*')
          .eq('account_id', a.id)
          .order('period_to', { ascending: false })
          .limit(1);
        map[a.id] = (s?.[0] as Stmt) ?? undefined;
      }),
    );
    setLatest(map);
    return list;
  }, [supabase]);

  const loadTxns = useCallback(
    async (accountId: string) => {
      if (!accountId) return;
      /*
       * **一定要分頁** —— Supabase 預設最多回 1000 列且不報錯。
       * 一個帳戶累積兩年就會破,而症狀是「舊的流水不見了」,
       * 沒有錯誤訊息。
       */
      const { rows, error } = await fetchAll<Txn>((f, t) =>
        supabase
          .from('bank_transactions')
          .select('id, account_id, txn_date, post_date, txn_time, description, counterparty, debit, credit, balance, bank_balance, balance_note, memo, ref_no, seq')
          .eq('account_id', accountId)
          .order('post_date', { ascending: false })
          .order('seq', { ascending: false })
          .range(f, t),
      );
      // 撈到一半失敗要說出來 —— 少一截而不報的話，
      // 畫面上看起來只是「這個帳戶流水比較少」
      if (error) { setMsg(`讀取流水失敗：${error}`); setErr(true); }
      setTxns(rows);
    },
    [supabase],
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      const list = await loadAccounts();
      if (list[0]) await loadTxns(list[0].id);
      setLoading(false);
    })();
  }, [loadAccounts, loadTxns]);

  useEffect(() => {
    if (tab) loadTxns(tab);
  }, [tab, loadTxns]);

  const totals = useMemo(
    () =>
      totalBalance(
        accounts.map((a) => ({
          name: a.name,
          balance: latest[a.id]?.closing_balance ?? null,
          asOf: latest[a.id]?.period_to ?? null,
        })),
      ),
    [accounts, latest],
  );

  /*
   * 篩選與排序都在前端做 —— 一個帳戶的流水已經整批撈回來了
   * （`fetchAll` 分頁撈完），再打一次伺服器只是多一趟來回。
   *
   * 篩選的規則寫在 `lib/bank-filter.ts`,不寫在這裡:
   * `.tsx` 裡的判斷式測不到,而篩錯只會「少幾筆」,不會報錯。
   */
  const SORT_COLS: SortCols<Txn> = {
    post_date: { type: 'date', get: (t) => t.post_date },
    description: { type: 'text', get: (t) => t.description ?? '' },
    memo: { type: 'text', get: (t) => t.memo ?? '' },
    counterparty: { type: 'text', get: (t) => t.counterparty ?? '' },
    debit: { type: 'number', get: (t) => Number(t.debit) || 0 },
    credit: { type: 'number', get: (t) => Number(t.credit) || 0 },
    amount: { type: 'number', get: (t) => amountOf(t) },
    balance: { type: 'number', get: (t) => Number(t.balance) || 0 },
  };

  const shown = useMemo(() => {
    const hit = filterTxns(txns, f);
    /*
     * 同一天有好幾筆時，日期排序分不出先後 —— 用 seq 當第二順位。
     * 不加的話同一天那幾筆的順序每次重新整理都可能不一樣。
     */
    if (sort?.key === 'post_date') {
      const sign = sort.dir === 'asc' ? 1 : -1;
      return [...hit].sort(
        (a, b) =>
          (a.post_date < b.post_date ? -1 : a.post_date > b.post_date ? 1 : 0) * sign ||
          ((a.seq ?? 0) - (b.seq ?? 0)) * sign,
      );
    }
    return sortRows(hit, sort, SORT_COLS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, f, sort]);

  const sums = useMemo(() => sumRows(shown), [shown]);

  /*
   * 下載 Excel。
   *
   * **下載的是「畫面上這幾筆」而不是全部** —— 篩了日期或方向之後
   * 按下載，拿到的檔案要跟眼前看到的一致。
   * 下載全部的話,人會以為篩選沒生效,或更糟:拿去對帳才發現多了幾百筆。
   *
   * 檔名帶帳戶與日期範圍,不然下載三次會變成三個同名檔案。
   */
  function exportXlsx() {
    const acc = accounts.find((a) => a.id === tab);
    const rows = shown.map((t) => ({
      交易日: t.txn_date ?? t.post_date,
      帳務日: t.post_date,
      時間: t.txn_time ?? '',
      交易型態: t.description ?? '',
      摘要: t.memo ?? '',
      對方: t.counterparty ?? '',
      對方帳號: t.ref_no ?? '',
      // Excel 裡放數字不放字串 —— 放字串就不能加總,而那正是下載的目的
      支出: Number(t.debit) || 0,
      存入: Number(t.credit) || 0,
      餘額: Number(t.balance) || 0,
      // 只有銀行印錯的那幾筆才有值
      餘額備註: t.balance_note ?? '',
    }));
    if (rows.length === 0) { setMsg('沒有資料可以下載'); setErr(true); return; }

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 11 }, { wch: 11 }, { wch: 9 }, { wch: 10 }, { wch: 22 },
      { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 30 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '流水');
    const span = shown.length
      ? `${shown[shown.length - 1].post_date}_${shown[0].post_date}`.replace(/-/g, '')
      : '';
    XLSX.writeFile(wb, `帳戶明細_${acc?.name ?? ''}_${span}.xlsx`);
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-4">
      <Toast msg={msg} error={err} onClose={() => setMsg('')} />

      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">帳戶明細</h1>
        <div className="flex items-center gap-2">
          {/* 只有在看流水時才給下載 —— 匯入紀錄那一頁下載什麼並不清楚 */}
          {view === 'txn' && <ExportButton onClick={exportXlsx} disabled={shown.length === 0} />}
          <button
            onClick={() => setShowUpload(true)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            ⬆ 上傳對帳單
          </button>
        </div>
      </div>

      {/* ── 合計 ────────────────────────────────── */}
      {/*
        【為什麼合計要標日期】
        三份對帳單的截止日可能不一樣。只上傳了兩份新的就顯示一個數字,
        那是「兩個新的 ＋ 一個舊的」—— 看起來像現在的現金,其實不是。
      */}
      <div className="mb-3 rounded-lg border bg-white px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-gray-500">總計</span>
          <span className="text-2xl font-semibold tabular-nums">{money(totals.total)}</span>
          {totals.asOf && <span className="text-sm text-gray-500">至 {totals.asOf}</span>}
        </div>
        {(totals.stale.length > 0 || totals.missing.length > 0) && (
          <div className="mt-1 text-xs text-amber-700">
            {totals.stale.length > 0 && <>⚠ {totals.stale.join('、')} 的對帳單較舊，合計不是最新狀態。</>}
            {totals.missing.length > 0 && <>⚠ {totals.missing.join('、')} 還沒上傳過對帳單，沒有算進合計。</>}
          </div>
        )}
      </div>

      {/* ── 三張卡片 ────────────────────────────── */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((a) => {
          const s = latest[a.id];
          const on = tab === a.id;
          return (
            <button
              key={a.id}
              onClick={() => setTab(a.id)}
              className={`rounded-lg border bg-white p-4 text-left transition ${
                on ? 'border-blue-500 ring-1 ring-blue-500' : 'hover:border-gray-400'
              }`}
            >
              <div className="text-sm text-gray-600">{a.name}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {money(s?.closing_balance)}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {/*
                  只給一個數字的話,看的人不知道那是今天的還是三個月前的。
                  而餘額是「最後一次上傳的對帳單的期末」,不是即時的。
                */}
                {s ? `至 ${s.period_to}` : '還沒上傳對帳單'}
              </div>
              {/*
                銀行名縮小、帳號放大（2026-08-19 使用者指定）。

                三個帳戶都是同一家銀行 —— 銀行名對「這是哪一個帳戶」
                完全沒有幫助,佔的視覺重量卻跟帳號一樣。
                真正要看的是末五碼,所以帳號放大並切出來。
              */}
              <div className="mt-2 text-[10px] text-gray-400">{a.bank}</div>
              <div className="font-mono text-[13px] tracking-tight text-gray-600">
                {splitTail(a.account_no) || `…${a.account_no_tail}`}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── 流水 ────────────────────────────────── */}
      <div className="rounded-lg border bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => setTab(a.id)}
                className={`rounded px-2.5 py-1 text-sm ${
                  tab === a.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {a.name}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* 流水 ／ 匯入紀錄 */}
            <div className="flex rounded-md border text-sm">
              <button
                onClick={() => setView('txn')}
                className={`px-2.5 py-1 ${view === 'txn' ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}
              >
                流水
              </button>
              <button
                onClick={() => setView('stmt')}
                className={`border-l px-2.5 py-1 ${view === 'stmt' ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}
              >
                匯入紀錄
              </button>
            </div>
            {view === 'txn' && <FilterToggle active={hasFilter(f)} />}
          </div>
        </div>

        {/* ── 篩選列 ────────────────────────────── */}
        {view === 'txn' && (
          <div className="filter-bar collapsible-filters flex flex-wrap items-end gap-2 border-b px-3 py-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">帳務日(起)</span>
              <input type="date" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)}
                className="rounded-lg border border-mor-line px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">帳務日(迄)</span>
              <input type="date" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)}
                className="rounded-lg border border-mor-line px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">方向</span>
              <select value={f.dir ?? ''} onChange={(e) => set('dir', e.target.value as BankFilter['dir'])}
                className="rounded-lg border border-mor-line px-2 py-1.5">
                <option value="">全部</option>
                <option value="debit">只看支出</option>
                <option value="credit">只看存入</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">金額(最少)</span>
              <input type="number" value={String(f.min ?? '')} onChange={(e) => set('min', e.target.value)}
                placeholder="不限" className="w-24 rounded-lg border border-mor-line px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">金額(最多)</span>
              <input type="number" value={String(f.max ?? '')} onChange={(e) => set('max', e.target.value)}
                placeholder="不限" className="w-24 rounded-lg border border-mor-line px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">關鍵字</span>
              <input value={f.q ?? ''} onChange={(e) => set('q', e.target.value)}
                placeholder="摘要、對方、帳號、金額…"
                className="w-52 rounded-lg border border-mor-line px-2 py-1.5" />
            </label>
            {/*
              一年可能只出現一次的東西 —— 沒有這個開關就只能一頁一頁翻
            */}
            <label className="flex items-center gap-1.5 pb-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={!!f.onlyNoted}
                onChange={(e) => set('onlyNoted', e.target.checked)} />
              只看餘額有備註的
            </label>
            {hasFilter(f) && (
              <button
                onClick={() => setF({ from: '', to: '', dir: '', min: '', max: '', q: '' })}
                className="pb-1.5 text-sm text-gray-500 underline"
              >
                清除
              </button>
            )}
          </div>
        )}

        {view === 'stmt' ? (
          <StatementsPanel
            accountId={tab}
            onChanged={async (text) => {
              setMsg(text); setErr(false);
              // 撤銷會影響卡片上的餘額（那份可能是最新的一份）
              await loadAccounts();
              await loadTxns(tab);
            }}
            onError={(text) => { setMsg(text); setErr(true); }}
          />
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                {/*
                  排序鍵是**帳務日**，標題卻寫「交易日」—— 這是刻意的。

                  顯示交易日是因為對帳時人看的是那一天（使用者指定 2026-08-18）。
                  但**餘額的順序跟著帳務日走** —— 用交易日排的話，
                  交易日與帳務日差一天的那幾筆會插進別的位置，
                  餘額欄就不再是連續遞增，而那看起來像資料壞了。

                  兩者差距通常只有一兩天，排出來的順序幾乎相同。
                */}
                <SortTh label="交易日" sortKey="post_date" type="date" state={sort}
                  onSort={(key, dir) => setSort({ key, dir })} className="text-left font-medium" />
                <SortTh label="交易型態" sortKey="description" state={sort}
                  onSort={(key, dir) => setSort({ key, dir })} className="text-left font-medium" />
                <SortTh label="摘要" sortKey="memo" state={sort}
                  onSort={(key, dir) => setSort({ key, dir })} className="text-left font-medium" />
                <SortTh label="對方" sortKey="counterparty" state={sort}
                  onSort={(key, dir) => setSort({ key, dir })} className="text-left font-medium" />
                <SortTh label="支出" sortKey="debit" type="number" state={sort} align="right"
                  onSort={(key, dir) => setSort({ key, dir })} className="text-right font-medium" />
                <SortTh label="存入" sortKey="credit" type="number" state={sort} align="right"
                  onSort={(key, dir) => setSort({ key, dir })} className="text-right font-medium" />
                <SortTh label="餘額" sortKey="balance" type="number" state={sort} align="right"
                  onSort={(key, dir) => setSort({ key, dir })} className="text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">載入中⋯</td></tr>
              )}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                    {txns.length === 0
                      ? '這個帳戶還沒有流水 —— 上傳一份對帳單試試'
                      : `沒有符合的資料（全部 ${txns.length} 筆）`}
                  </td>
                </tr>
              )}
              {shown.map((t) => (
                <tr key={t.id} className="border-t hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                    {/* 交易日為主 —— 對帳時人看的是那一天 */}
                    <div>{ymd(t.txn_date ?? t.post_date)}</div>
                    {/*
                      帳務日不同時才印第二行。相同的話那一行沒有多講任何事,
                      而九成以上的交易兩者相同 —— 每列都印會讓表格多一倍高度
                      卻沒有多給任何資訊。
                    */}
                    {t.txn_date && t.txn_date !== t.post_date && (
                      <div className="text-[11px] text-gray-400">入帳 {ymd(t.post_date)}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">{t.description ?? ''}</td>
                  {/*
                    摘要獨立一欄（使用者指定 2026-08-18）。

                    原本跟交易型態擠在同一格,黑字一行灰字一行 ——
                    那樣「摘要」這一欄排序時排的其實是交易型態,
                    而點下去看起來沒反應。
                  */}
                  <td className="px-3 py-1.5 text-gray-600">
                    {/* 全形字原樣顯示（１２月房租、南５）—— 轉半形之後跟 PDF 對不起來 */}
                    {t.memo ?? ''}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">
                    <div>{t.counterparty ?? ''}</div>
                    {/*
                      對方帳號／票據號碼。PDF 的「備註票據號碼」欄裡
                      純數字的那部分 —— 存了卻不顯示等於沒存。
                      斷行用 break-all:那是 16–20 位的數字串,
                      不斷行會把整張表撐開。
                    */}
                    {t.ref_no && (
                      <div className="break-all font-mono text-[11px] text-gray-400">{t.ref_no}</div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-red-600">
                    {Number(t.debit) ? money(Number(t.debit)) : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-green-700">
                    {Number(t.credit) ? money(Number(t.credit)) : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {money(Number(t.balance))}
                    {/*
                      銀行印的跟我們算的不一樣時要看得見。
                      存了卻不顯示等於沒存 —— 那一格是「為什麼跟網銀對不起來」
                      唯一的線索，而它一年可能只出現一次。
                    */}
                    {t.balance_note && (
                      <div
                        className="text-[11px] font-normal text-amber-700"
                        title="銀行印的餘額跟依交易金額推算的不一致。餘額以我們算的為準。"
                      >
                        ⚠ {t.balance_note}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {shown.length > 0 && (
              <tfoot className="border-t bg-gray-50 text-xs">
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-gray-600">
                    {shown.length} 筆
                    {/* 有篩的時候一定要講「總共幾筆」—— 不然「為什麼只有 3 筆」查不到原因 */}
                    {hasFilter(f) && `（全部 ${txns.length} 筆）`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(sums.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(sums.credit)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        )}
      </div>

      {showUpload && (
        <UploadPanel
          onClose={() => setShowUpload(false)}
          onDone={async (text) => {
            setMsg(text); setErr(false);
            await loadAccounts();
            if (tab) await loadTxns(tab);
          }}
        />
      )}
    </div>
  );
}
