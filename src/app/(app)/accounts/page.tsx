'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import Toast from '@/components/Toast';
import UploadPanel from './upload-panel';
import { totalBalance } from '@/lib/bank-import';

/**
 * 帳戶管理 —— 三個銀行帳戶的流水鏡像。
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
const md = (d: string | null) => (d ? d.slice(5).replace('-', '/') : '—');

export default function AccountsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [latest, setLatest] = useState<Record<string, Stmt | undefined>>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [tab, setTab] = useState<string>('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

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

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return txns;
    return txns.filter((t) =>
      [t.description, t.counterparty, t.memo, t.ref_no, t.post_date, String(t.debit || t.credit)]
        .some((v) => (v ?? '').toString().toLowerCase().includes(k)),
    );
  }, [txns, q]);

  const sums = useMemo(
    () => ({
      debit: shown.reduce((a, t) => a + Number(t.debit || 0), 0),
      credit: shown.reduce((a, t) => a + Number(t.credit || 0), 0),
    }),
    [shown],
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-4">
      <Toast msg={msg} error={err} onClose={() => setMsg('')} />

      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">帳戶管理</h1>
        <button
          onClick={() => setShowUpload(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          ⬆ 上傳對帳單
        </button>
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
              <div className="mt-2 text-[11px] text-gray-400">
                {a.bank}　{a.account_no ?? `…${a.account_no_tail}`}
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
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="找摘要、對方、金額…"
              className="w-48 rounded-md border px-2 py-1 text-sm"
            />
            {q && (
              <button onClick={() => setQ('')} className="text-sm text-gray-500 underline">
                清除
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">日期</th>
                <th className="px-3 py-2 text-left font-medium">摘要</th>
                <th className="px-3 py-2 text-left font-medium">對方</th>
                <th className="px-3 py-2 text-right font-medium">支出</th>
                <th className="px-3 py-2 text-right font-medium">存入</th>
                <th className="px-3 py-2 text-right font-medium">餘額</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">載入中⋯</td></tr>
              )}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                    {txns.length === 0 ? '這個帳戶還沒有流水 —— 上傳一份對帳單試試' : '沒有符合的資料'}
                  </td>
                </tr>
              )}
              {shown.map((t) => (
                <tr key={t.id} className="border-t hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                    <div>{md(t.post_date)}</div>
                    {/* 交易日跟帳務日不同時才印第二行 —— 相同的話那一行沒有多講任何事 */}
                    {t.txn_date && t.txn_date !== t.post_date && (
                      <div className="text-[11px] text-gray-400">交易 {md(t.txn_date)}</div>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <div>{t.description ?? ''}</div>
                    {/* 摘要是全形的（１２月房租、南５）—— 原樣顯示,不要轉半形 */}
                    {t.memo && <div className="text-[11px] text-gray-500">{t.memo}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">{t.counterparty ?? ''}</td>
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
                  <td colSpan={3} className="px-3 py-2 text-gray-600">
                    {shown.length} 筆{q && `（共 ${txns.length} 筆）`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(sums.debit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(sums.credit)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
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
