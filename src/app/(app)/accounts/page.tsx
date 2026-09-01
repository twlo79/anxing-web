'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StatCard, { StatRow } from '@/components/StatCard';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import Toast from '@/components/Toast';
import UploadPanel from './upload-panel';
import StatementsPanel from './statements-panel';
import { totalBalance } from '@/lib/bank-import';
import {
  recalcBalances, changedBalances, validateCash, draftToRow, nextSeq, type CashDraft,
} from '@/lib/cash-txn';
import { filterTxns, hasFilter, sumRows, amountOf, splitRef, type BankFilter } from '@/lib/bank-filter';
import * as XLSX from 'xlsx-js-style';
import { FilterCount, FieldSpacer, FilterClear, FilterSelect, FilterDateRange, FilterSearch } from '@/lib/filters';
import { ExportButton } from '@/components/Actions';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import FilterToggle from '@/components/FilterToggle';
import { Tabs, TabShell } from '@/components/Tabs';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';

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
  account_no_tail: string | null;
  sort: number;
  /**
   * `bank` = 上傳對帳單、只能改摘要；`cash` = 手動 key、全部可改（migration_184）。
   *
   * ★★★ 這一個欄位決定畫面上五件事:
   *   1. 有沒有「上傳對帳單」鈕（現金沒有檔案可傳）
   *   2. 有沒有「＋ 新增一筆」鈕（銀行的資料只能從對帳單來）
   *   3.「交易帳號」欄顯示 `ref_no`（銀行）還是 `counterparty`（現金填人名）
   *   4. 那一列能不能改、能不能刪
   *   5. 沒有對帳單時要不要報「未計入」（現金永遠不會有對帳單）
   *
   * ★ 舊資料沒有這欄時當 bank —— migration 給了 `default 'bank'`,
   *   但前端也要有預設,不然 migration 還沒跑就整頁壞掉。
   */
  kind?: 'bank' | 'cash' | null;
  /**
   * 資料是人手 key 的（migration_192）。
   *
   * ★★★ 跟 `kind` 是**兩件事**（2026-09-01 使用者:「08311 像現金一樣手動建入」）:
   *
   *     kind          這是什麼帳戶   → 決定**顯示**（交易帳號欄放帳號還是人名）
   *     manual_entry  資料怎麼進來的 → 決定**行為**（新增／改／刪、上傳鈕、餘額怎麼算）
   *
   *   現金   kind=cash  manual=true   人名 ／ 手動
   *   08311 kind=bank  manual=true   對方帳號 ／ 手動
   *   其餘三個 kind=bank  manual=false  對方帳號 ／ 上傳對帳單
   *
   * ★ 08311 是**真的銀行帳戶**，只是沒有對帳單可下載。
   *   把它的 kind 改成 cash 一行就好，但那樣「交易帳號」欄會變成填人名 ——
   *   而它的匯款對方是有帳號的。
   */
  manual_entry?: boolean | null;
  /** 現金帳戶的期初餘額。留空當 0（使用者 2026-08-31 選的）。 */
  opening_balance?: number | null;
};
/**
 * 這一列是不是現金帳戶。**只影響顯示** ——
 * 現金沒有對方帳號，所以「交易帳號」欄放的是人名（`counterparty`）。
 *
 * ★ 要判斷「能不能手動新增／改／刪」請用 `isManual`，不是這個。
 */
const isCash = (a?: Account | null) => a?.kind === 'cash';

/**
 * 這個帳戶的資料是不是人手 key 的。**這才是決定行為的那一個。**
 *
 * ★★★ 現金與 08311 都是 true，但它們的 `kind` 不同（cash ／ bank）。
 *   用 `isCash` 判斷行為的話，08311 會少掉新增鈕、多出上傳鈕 ——
 *   而它根本沒有對帳單可傳。
 *
 * ★ `manual_entry` 沒值時看 `kind === 'cash'` —— migration_192 還沒跑時
 *   現金帳戶的行為不會壞掉。跑完之後 DB 裡就有值了，這個 fallback 只是保險。
 */
const isManual = (a?: Account | null) => a?.manual_entry === true || a?.kind === 'cash';

/**
 * 重算餘額時只需要這幾欄。
 *
 * ★ 不用整個 `Txn`:重算會把這個帳戶**全部**的流水撈回來,
 *   而摘要、對方帳號那些欄位一個都用不到 —— 少撈就少一份傳輸與記憶體。
 */
type BalRow = {
  id: string;
  post_date: string;
  seq: number | null;
  debit: number;
  credit: number;
  balance: number;
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

/**
 * 摘要編輯（2026-08-22 使用者指定）。
 *
 * ★ **只有摘要能改。** 金額、日期、餘額、交易帳號是銀行給的事實 ——
 *   改了之後這一頁就不再是對帳單的鏡像，而是一份看起來像對帳單的
 *   自由文字，那比沒有這一頁更危險（對帳的人會相信它）。
 *
 * 資料庫也擋（migration_166 的 trg_bank_txn_memo_only）——
 * 前端擋不住重新整理後的舊畫面，也擋不住直接打 API。
 */
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
  /*
   * ★★ `loadTxns` 的相依只有 `[supabase]` —— 直接讀 `accounts` 的話
   *   它會抓到閉包裡那份**建立當下的**空陣列，而不是現在的。
   *   症狀是「第一次切到現金分頁時回形針全部不見」，重整才會出現。
   *   ref 永遠指向最新的，而且不會讓 useCallback 重新建立。
   */
  const accountsRef = useRef<Account[]>([]);
  const [latest, setLatest] = useState<Record<string, Stmt | undefined>>({});
  /*
   * ══════════════════════════════════════════════════════════
   * ★★★ 每個帳戶最後一筆流水的日期（2026-08-29 使用者:「卡片日期對不上」）。
   *
   *   卡片寫「至 2026-08-25」而表格第一列是 2026/08/21 —— 看起來像 bug,
   *   其實是**兩個不同的日期**:
   *     · 2026-08-25 = 對帳單的期末（`bank_statements.period_to`）
   *     · 2026-08-21 = 最後一筆真的有錢動的日子
   *   中間那四天沒有交易,所以餘額一樣、日期不一樣。
   *
   * ★★ 數字沒錯,錯的是**只寫一個「至」**,而那個字兩種都能讀。
   *   所以兩個日期都印出來,不同的時候才印第二個。
   *
   * ★ 代價是每個帳戶多一次 `limit 1` 的查詢（三個帳戶三次）——
   *   換掉「使用者每次看到都要重新確認一遍」。
   * ══════════════════════════════════════════════════════════
   */
  const [lastTxn, setLastTxn] = useState<Record<string, string | undefined>>({});
  /**
   * 現金帳戶「最後一筆的餘額」——它的期末餘額。
   *
   * ★★★ 銀行帳戶的餘額來自 `bank_statements.closing_balance`（銀行印的），
   *   現金帳戶**沒有對帳單**，所以它的餘額只能是最後一筆流水的 `balance`。
   *   兩個來源不一樣，但意思一樣:「現在這個帳戶有多少錢」。
   *
   * ★ 沒有這個的話現金帳戶會被當成「沒有對帳單，未計入」——
   *   而它是永遠不會有對帳單的，那句警語會一直掛在那裡。
   */
  const [cashBal, setCashBal] = useState<Record<string, number | undefined>>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [tab, setTab] = useState<string>('');
  const [f, setF] = useState<BankFilter>({ from: '', to: '', dir: '', q: '' });
  /*
   * ★★ 關鍵字**按了搜尋才算數**（2026-08-29 使用者:「1. 沒搜尋鈕」）。
   *
   *   這一頁本來是邊打邊篩 —— 資料已經整批在前端了,不花伺服器成本,
   *   所以當初刻意不放按鈕。但**全站其他頁都有那顆按鈕**,
   *   使用者在這頁打完字會停下來找它,找不到就以為欄位壞了。
   *
   * ★ 一致性贏過那點效能:草稿 `qDraft` 是輸入框的內容,
   *   `f.q` 才是真的拿去篩的值。Enter 等同按搜尋。
   */
  const [qDraft, setQDraft] = useState('');
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
  /** 正在編輯摘要的那一筆（id → 草稿文字）。null = 沒有在編輯。 */
  const [memoEdit, setMemoEdit] = useState<{ id: string; text: string } | null>(null);
  const [memoBusy, setMemoBusy] = useState(false);

  /**
   * 存摘要。
   *
   * ★★ 要看改到幾列 —— RLS 或觸發器擋下的 UPDATE 回成功且影響 0 列，
   *   只看 error 的話畫面會說存好了而那一列一動也沒動。
   */
  async function saveMemo() {
    if (!memoEdit) return;
    setMemoBusy(true);
    const { data, error } = await supabase.from('bank_transactions')
      .update({ memo: memoEdit.text.trim() || null })
      .eq('id', memoEdit.id).select('id');
    setMemoBusy(false);
    if (error) { setMsg('存不進去：' + error.message); setErr(true); return; }
    if (!data?.length) {
      setMsg('沒有任何一列被更新，通常是權限問題。請重新整理後再試。'); setErr(true); return;
    }
    // 就地更新，不用重載整頁 —— 這一頁動輒幾百列
    setTxns((prev) => prev.map((t) => (t.id === memoEdit.id
      ? { ...t, memo: memoEdit.text.trim() || null } : t)));
    setMemoEdit(null);
    setMsg('摘要已更新'); setErr(false);
  }
  // 流水 ／ 匯入紀錄。匯入紀錄是「哪一批可以撤銷」的地方
  const [view, setView] = useState<'txn' | 'stmt'>('txn');

  /*
   * ══════════════════════════════════════════════════════════
   * 現金帳戶的手動記帳（2026-08-31 使用者:「現金不會有匯入,都是手動 key」）
   *
   * ★★ 新增與編輯**共用一個表單**。`id` 有值就是編輯,沒有就是新增。
   *   分成兩套 UI 的話,兩邊的檢查規則與欄位順序一定會漂 ——
   *   而漂掉的症狀是「新增擋得住的東西,編輯放它過去」。
   * ══════════════════════════════════════════════════════════
   */
  const [cashForm, setCashForm] = useState<(CashDraft & { id?: string }) | null>(null);
  const [cashErr, setCashErr] = useState('');
  const [cashBusy, setCashBusy] = useState(false);
  /**
   * 收據照片（migration_185）。
   *
   * ★★ 新增時還沒有 id，路徑組不出來 —— 所以 `Receipts` 先把檔案留在瀏覽器裡，
   *   等這一列存好之後由 `flush(id)` 真的上傳。
   *   不採「先建一張草稿再上傳」的做法:使用者按取消就會留下一列空流水，
   *   而那一列會進到餘額裡。
   */
  const receiptsRef = useRef<ReceiptsHandle>(null);
  /**
   * 哪一列的照片區是展開的。null = 都收起來。
   *
   * ★ 一次只開一列。全部展開的話幾百列的表格會變成幾千像素高，
   *   而使用者要的只是「看這一筆的收據」。
   */
  const [attOpen, setAttOpen] = useState<string | null>(null);
  /**
   * 每一列有幾張照片。**一次撈完，不是一列一次查**。
   *
   * ★★ 一列一次查的話，兩百列就是兩百次往返 —— 那一頁會卡住好幾秒，
   *   而且畫面上看起來是「回形針一個一個慢慢亮起來」。
   */
  const [attCount, setAttCount] = useState<Record<string, number>>({});
  /** 目前這個分頁的帳戶。★ 五個地方要判斷是不是現金,查一次就好。 */
  const cur = useMemo(() => accounts.find((a) => a.id === tab), [accounts, tab]);

  /** 空白表單。★ 日期預設今天 —— 現金多半是當天記的,少打一次。 */
  const blankCash = (): CashDraft => ({
    post_date: new Date().toISOString().slice(0, 10),
    counterparty: '', dir: 'credit', amount: '', memo: '',
  });

  /**
   * 存一筆現金流水（新增或編輯），然後**整串重算餘額**。
   *
   * ============================================================
   * 【★★★ 為什麼要整串重算】
   *
   * 補一筆 8/15 的舊帳時，8/18 那一筆的餘額也要跟著往下移 ——
   * 只寫新那一筆的話，8/18 的餘額會停在舊值，而它跟前後兜不攏。
   * 規則寫在 `lib/cash-txn.ts`（有測試），這裡只負責寫回去。
   *
   * 【★★ 為什麼要看 `.select('id')` 的長度】
   *
   * RLS 或觸發器擋下的 UPDATE **回成功且影響 0 列**（CLAUDE.md 的坑表）。
   * 只看 `error` 的話畫面會說存好了，而那一列一動也沒動。
   *
   * 【★ 為什麼不做成一個交易】
   *
   * Supabase 的前端 client 沒有交易。中途失敗的話會留下
   * 「新那一筆進去了，但後面的餘額還沒重算」的狀態 ——
   * **那個狀態是看得出來的**（餘額對不上），而且重新整理後再存一次就好。
   * 相較之下，硬要原子性得寫一支 RPC，而那把規則搬進 SQL 就測不到了。
   */
  async function saveCash() {
    if (!cashForm || !cur) return;
    const bad = validateCash(cashForm, isCash(cur));
    if (bad) { setCashErr(bad); return; }
    setCashErr(''); setCashBusy(true);

    /*
     * ★★★ 新增時要給 `seq`（2026-08-31）。
     *   沒有它的話同一天的幾筆會平手，而平手時的順序**不保證穩定** ——
     *   下次重算可能換順序，每一列的餘額跟著改（見 lib/cash-txn.ts 的 nextSeq）。
     *
     * ★ 編輯時**不給** —— 傳 undefined，那一列的排序維持原樣。
     *   給新號碼的話改個錯字就會讓那一筆跳到最後面。
     */
    const seq = cashForm.id ? undefined : nextSeq(txns);
    const row = draftToRow(cashForm, cur.id, seq, isCash(cur));
    let savedId = cashForm.id;

    if (cashForm.id) {
      const { data, error } = await supabase.from('bank_transactions')
        .update(row).eq('id', cashForm.id).select('id');
      if (error) { setCashBusy(false); setCashErr(`存不進去：${error.message}`); return; }
      if (!data?.length) {
        setCashBusy(false);
        setCashErr('沒有任何一列被更新，通常是權限問題。請重新整理後再試。');
        return;
      }
    } else {
      const { data, error } = await supabase.from('bank_transactions')
        /*
         * ★ `balance` 先給 0 佔位 —— 欄位是 not null,不能不給。
         *   正確的值在下面那一輪重算時補上。
         *   給 null 會直接被資料庫擋下來,而給 0 只是短短一瞬間不準。
         */
        .insert({ ...row, balance: 0 }).select('id');
      if (error) { setCashBusy(false); setCashErr(`存不進去：${error.message}`); return; }
      savedId = (data?.[0] as { id: string } | undefined)?.id;
    }

    /*
     * 重新撈這個帳戶的全部流水再重算。
     * ★ 用剛剛的 `txns` 加上新那一筆去算也可以，但那要自己維護一份影子狀態，
     *   而影子跟真實分岔的時候沒有人會發現。重撈一次是幾百列，便宜。
     */
    const { rows: fresh } = await fetchAll<BalRow>((from, to) =>
      supabase.from('bank_transactions')
        .select('id, post_date, seq, debit, credit, balance')
        .eq('account_id', cur.id).range(from, to),
    );
    const after = recalcBalances(fresh, Number(cur.opening_balance) || 0);
    const diffs = changedBalances(fresh, after);

    for (const d of diffs) {
      const { error } = await supabase.from('bank_transactions')
        .update({ balance: d.balance }).eq('id', d.id);
      if (error) {
        setCashBusy(false);
        setCashErr(`餘額重算寫回失敗：${error.message}。這一筆已經存進去了，重新整理後再存一次即可。`);
        await loadTxns(cur.id); await loadAccounts();
        return;
      }
    }

    /*
     * ★★★ 照片要在**這一列存好之後**才上傳（`flush`）。
     *
     *   路徑是 `cash/{這一列的 id}/xxx.jpg` —— 沒有 id 就組不出路徑，
     *   而 storage 的權限就是讀這個路徑判斷的（migration_51）。
     *
     * ★★ 上傳失敗**不讓整筆失敗**。流水已經進去了、餘額也重算完了，
     *   這時候回報「失敗」會讓人以為那一筆沒存到而再存一次 ——
     *   結果是兩筆一樣的流水。所以照片失敗只提醒「照片沒傳上去」。
     */
    let attMsg = '';
    if (savedId && receiptsRef.current?.hasStaged()) {
      const upErr = await receiptsRef.current.flush(savedId);
      attMsg = upErr ? `　⚠ 但照片沒傳上去：${upErr}` : '';
    }

    setCashBusy(false);
    setCashForm(null);
    await loadTxns(cur.id);
    await loadAccounts();
    setMsg((cashForm.id ? '已更新' : `已新增，同時重算了 ${diffs.length} 筆餘額`) + attMsg);
    setErr(!!attMsg);
  }

  /**
   * 刪掉一筆現金流水，然後整串重算。
   *
   * ★★ 要問過。刪掉之後**後面每一筆的餘額都會變** ——
   *   使用者以為只是拿掉一列，而實際上整段歷史的數字都動了。
   *   所以那句話要說出來，不能只問「確定刪除嗎」。
   */
  async function deleteCash(t: Txn) {
    if (!cur) return;
    const label = `${ymd(t.post_date)}　${t.memo || t.counterparty || '（無摘要）'}`;
    if (!confirm(`刪掉這一筆？\n\n${label}\n\n★ 這一筆之後每一筆的餘額都會跟著重算。`)) return;

    setCashBusy(true);
    const { error } = await supabase.from('bank_transactions').delete().eq('id', t.id);
    if (error) { setCashBusy(false); setMsg(`刪不掉：${error.message}`); setErr(true); return; }

    const { rows: fresh } = await fetchAll<BalRow>((from, to) =>
      supabase.from('bank_transactions')
        .select('id, post_date, seq, debit, credit, balance')
        .eq('account_id', cur.id).range(from, to),
    );
    const after = recalcBalances(fresh, Number(cur.opening_balance) || 0);
    for (const d of changedBalances(fresh, after)) {
      await supabase.from('bank_transactions').update({ balance: d.balance }).eq('id', d.id);
    }

    setCashBusy(false);
    if (cashForm?.id === t.id) setCashForm(null);
    await loadTxns(cur.id);
    await loadAccounts();
    setMsg('已刪除，餘額已重算'); setErr(false);
  }

  /** 把既有的一列讀進表單。★ 金額轉回字串 —— input 的 value 只吃字串。 */
  function editCash(t: Txn) {
    setCashErr('');
    setCashForm({
      id: t.id,
      post_date: t.post_date.slice(0, 10),
      /*
        ★ 讀回來要跟存進去對稱 —— 現金存 counterparty、銀行存 ref_no。
          一律讀 counterparty 的話，08311 的那一格會是空的，
          而使用者按「改」之後不小心存檔，帳號就被清掉了。
      */
      counterparty: (isCash(cur) ? t.counterparty : t.ref_no) ?? '',
      dir: Number(t.debit) > 0 ? 'debit' : 'credit',
      amount: String(Number(t.debit) > 0 ? t.debit : t.credit),
      memo: t.memo ?? '',
    });
  }

  const loadAccounts = useCallback(async () => {
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('id, name, bank, account_no, account_no_tail, sort, kind, manual_entry, opening_balance')
      .eq('active', true)
      .order('sort');
    if (error) {
      setMsg(`讀取帳戶失敗：${error.message}`); setErr(true);
      return [] as Account[];
    }
    const list = (data ?? []) as Account[];
    setAccounts(list);
    accountsRef.current = list;
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

    /*
     * 最後一筆流水。★ 順便把 `balance` 也撈回來 —— 現金帳戶的期末餘額就是它。
     *
     * ★★ 排序要 `post_date desc, seq desc` 兩層。只排日期的話，
     *   同一天有好幾筆時「最後一筆」是哪一筆不確定 ——
     *   而現金帳戶同一天記兩三筆是常態，抓錯就是餘額顯示錯。
     */
    const lt: Record<string, string | undefined> = {};
    const cb: Record<string, number | undefined> = {};
    await Promise.all(
      list.map(async (a) => {
        const { data: t } = await supabase
          .from('bank_transactions')
          .select('post_date, balance')
          .eq('account_id', a.id)
          .order('post_date', { ascending: false })
          .order('seq', { ascending: false })
          .limit(1);
        const row = t?.[0] as { post_date: string; balance: number } | undefined;
        lt[a.id] = row?.post_date;
        if (isManual(a)) cb[a.id] = row ? Number(row.balance) : Number(a.opening_balance) || 0;
      }),
    );
    setLastTxn(lt);
    setCashBal(cb);
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

      /*
       * 每一列有幾張收據照片。
       *
       * ★ 只在現金帳戶撈 —— 銀行流水不接受附件（migration_185），
       *   撈了也永遠是 0，等於白花一次往返。
       *
       * ★★ 一次撈完這個帳戶的全部，前端自己數。
       *   一列一次查的話兩百列就是兩百次往返。
       *
       * ★ 失敗**不擋畫面**:回形針的數字少一個是小事，
       *   流水看不到才是大事。所以這裡不 setErr。
       */
      const acct = accountsRef.current.find((a) => a.id === accountId);
      if (!isManual(acct)) { setAttCount({}); return; }

      const ids = rows.map((r) => r.id);
      if (ids.length === 0) { setAttCount({}); return; }
      const { data: atts } = await supabase
        .from('attachments')
        .select('bank_transaction_id')
        .in('bank_transaction_id', ids);
      const cnt: Record<string, number> = {};
      for (const a of (atts ?? []) as { bank_transaction_id: string }[]) {
        cnt[a.bank_transaction_id] = (cnt[a.bank_transaction_id] ?? 0) + 1;
      }
      setAttCount(cnt);
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

  /*
   * ★★★ 現金帳戶的餘額走另一條路（2026-08-31）。
   *
   *   銀行:`bank_statements.closing_balance` ＋ `period_to`
   *   現金:最後一筆流水的 `balance`，**`asOf` 給 null**
   *
   * ★★ `asOf` 一定要留 null。給日期的話它會被算進標題那句
   *   「對帳單 08/25 ~ 09/30」的區間裡 —— 而現金帳戶根本沒有對帳單，
   *   那句話會因為一個不存在的對帳單而變成區間。
   *   `totalBalance` 對 `balance 有值但 asOf 是 null` 的處理是
   *   「計入總額、不影響日期」，正是要的。
   *
   * ★ 現金**計入總額**。上面那個大數字的意思因此從「銀行裡有多少」
   *   變成「手上有多少錢」—— 那才是看這一頁的人要問的問題。
   */
  const totals = useMemo(
    () =>
      totalBalance(
        accounts.map((a) => ({
          name: a.name,
          /*
            ★ 用 isManual 不是 isCash —— 08311 也沒有對帳單，
              它的餘額同樣要從最後一筆流水來，而且不該進日期區間。
          */
          balance: isManual(a) ? cashBal[a.id] ?? null : latest[a.id]?.closing_balance ?? null,
          asOf: isManual(a) ? null : latest[a.id]?.period_to ?? null,
          dated: !isManual(a),
        })),
      ),
    [accounts, latest, cashBal],
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
    /*
     * 交易帳號。這一欄改成以帳號為主體之後（2026-08-19 使用者指定），
     * 排序也要跟著排帳號 —— 標題寫「交易帳號」卻按銀行名排的話，
     * 點下去會看起來像沒反應（摘要那一欄踩過同一個坑）。
     *
     * 沒有帳號的排最後:空字串會被排到最前面,而那幾列正是最沒有資訊的。
     */
    ref_no: { type: 'text', get: (t) => t.ref_no || '￿' },
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
      /*
       * Excel 兩欄分開，**不跟著畫面合併成一欄**。
       *
       * 畫面上合併是為了省寬度、讓眼睛一次看到一組;
       * Excel 是拿去篩選與樞紐分析的,合在一格就不能單獨按銀行分組。
       * 欄名也刻意不改 —— 已經下載過的檔案還在別人的資料夾裡,
       * 改名只會讓兩份對不起來。
       */
      對方: t.counterparty ?? '',
      /*
       * Excel 裡放**原文**，不切末五碼。
       *
       * 畫面上切是為了眼睛好認；Excel 是拿去跟別的系統比對的
       * （VLOOKUP、貼進網銀查詢），多一個分隔號就對不上，
       * 而那種錯只會表現成「查無此帳號」。兩邊目的不同，格式就該不同。
       */
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
    <div className="mx-auto w-full max-w-[1440px] px-4 py-4">
      <Toast msg={msg} error={err} onClose={() => setMsg('')} />

      {/*
        標題列只剩標題（2026-08-19 使用者指定「下載 上傳 向下移」）。

        那兩顆按鈕搬到底下的分頁列 —— 它們操作的對象是**某一個帳戶的流水**
        （下載是當前分頁的、上傳也是進那個帳戶），放在頁面最上面時
        看起來像是「整頁」的動作，跟實際行為對不起來。
      */}
      {/*
        ══════════════════════════════════════════════════════════
        ★★★ 標題列 ＝ 標題 ＋ 總計 ＋ 對帳單日期（2026-08-29 使用者選 D 案）。

          之前試過兩版都被否掉:
            · 全寬的深藍大卡 —— 一個數字撐一整條，中間全是空的
            · 壓成細橫幅 —— 「一條還是突兀」
            · 總計跟三個帳戶並排成四張等寬 —— 「四個一起又怪」
              （總計跟帳戶不是同一種東西,排在一起看起來像第四個帳戶）

        ★★ 結論是**總計不需要一張卡**。它是這一頁的標題在回答的問題
          （「帳戶明細 —— 總共多少？」），寫在標題旁邊就好。

        ★★★ 對帳單日期**整頁只印一次**。
          三個帳戶的 `period_to` 幾乎永遠是同一天（同一批上傳），
          印在三張卡上就是同一個日期印三遍 —— 而它擠掉的正是
          每張卡真正不一樣的那個資訊:最後異動日。

        ★ 日期不一致時（只補傳了其中一份）要說出來,不能只印最舊的那個 ——
          那會讓人以為三個數字都是那天的。`totals.asOf` 已經取最舊的,
          這裡再加一句「其中 N 個較舊」。
        ══════════════════════════════════════════════════════════
      */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 min-w-0">
          <h1 className="mb-0">帳戶明細</h1>
          <span className="stat-num-lg font-bold tabular-nums">{money(totals.total)}</span>
        </div>
        {/*
          ★★★ 三份對帳單的截止日不一樣時（只補傳了其中一個帳戶）,
            **不可以只印一個日期**:
              · 印最新的 → 合計看起來像現在的現金,而其中兩個是幾個月前的
              · 印最舊的 → 剛上傳完的人會以為自己白傳了
            所以不一致就印區間 ＋ 標黃色,下面那行再點名是哪幾個落後。
        */}
        {totals.asOf && (
          totals.newestAsOf && totals.newestAsOf !== totals.asOf ? (
            <span className="text-uisub text-amber-700 whitespace-nowrap">
              對帳單 {ymd(totals.asOf)} ~ {ymd(totals.newestAsOf)}
            </span>
          ) : (
            <span className="text-uisub text-gray-500 whitespace-nowrap">對帳單至 {ymd(totals.asOf)}</span>
          )
        )}
      </div>

      {(totals.stale.length > 0 || totals.missing.length > 0) && (
        /*
          ★ 警語留在總計附近 —— 它講的是「上面那個數字可不可信」。
            搬到頁尾的話,看數字的人不會滾到那裡。
        */
        <div className="mb-4 text-uisub text-amber-700">
          {totals.stale.length > 0 && <div>⚠ {totals.stale.join('、')} 未更新</div>}
          {totals.missing.length > 0 && <div>⚠ {totals.missing.join('、')} 沒有對帳單，未計入</div>}
        </div>
      )}

      {/* ── 三張卡片 ────────────────────────────── */}
      {/*
        ★★ 選中改成**實心主色**,跟契約與暫收一致（2026-08-25）。

          原本這一頁是「淺藍底 ＋ 外框 ＋ ring」—— 全站第三種選中樣式。
          三個頁面三種做法,使用者每換一頁就要重學一次「哪一張是選中的」。
      */}
      <StatRow cols={3} className="mb-4">
        {accounts.map((a) => {
          const st = latest[a.id];
          /*
            ★★★ 現金帳戶的三個欄位都走另一條路（2026-08-31）:
              · 餘額   → 最後一筆流水的 balance（沒有對帳單可以問）
              · 有資料 → 看有沒有流水,不是看有沒有對帳單
              · 附註   → 「還沒上傳對帳單」對現金是永遠成立的廢話
          */
          const cash = isManual(a);
          const has = cash ? cashBal[a.id] != null : !!st;
          return (
            <StatCard key={a.id}
              label={a.name}
              value={money(cash ? cashBal[a.id] : st?.closing_balance)}
              /*
                ★ 只給一個數字的話,看的人不知道那是今天的還是三個月前的 ——
                  餘額是「最後一次上傳的對帳單的期末」,不是即時的。
                ★ 帳號末幾碼也放這裡:三個帳戶同一家銀行,銀行名幫不上忙,
                  要看的是末五碼。
              */
              /*
                ★ 只印**最後異動**。對帳單日期已經在標題列印過一次了,
                  而三個帳戶的對帳單日期是同一天 —— 印在這裡是同一句話講三遍,
                  還會把這張卡唯一不一樣的資訊擠到第二行。
              */
              sub={cash
                ? (lastTxn[a.id] ? `最後異動 ${ymd(lastTxn[a.id]!).slice(5)}` : '還沒有紀錄')
                : !st ? '還沒上傳對帳單'
                : lastTxn[a.id] ? `最後異動 ${ymd(lastTxn[a.id]!).slice(5)}`
                : '沒有流水'}
              active={tab === a.id}
              muted={!has}
              onClick={() => setTab(a.id)} />
          );
        })}
      </StatRow>

      {/*
        ── 流水 ──────────────────────────────────

        ★★★ 帳戶分頁做成 **Chrome 式分頁,而且是這張卡的一部分**
             （2026-08-29 使用者:「帳號也是 改用 google chrome 的 tab 形式」）。

          第一版讓分頁浮在卡片上方,接縫怪 —— 選中第二個時
          卡片的左上角是圓的,分頁掛在半空中。

        ★ 現在每一頁都有自己的框,選中的那頁是白的 ＋ 主色字 ＋ 下緣一條主色線,
          **選第幾個都對**,不需要底色條去襯。
      */}
      <TabShell tone="paper" tabs={
        <Tabs variant="browser" tone="paper" value={tab} onChange={setTab}
          items={accounts.map((a) => ({ key: a.id, label: a.name }))} />
      }>
        {/*
          ★ 這裡只留「換這張卡的檢視」：流水／匯入紀錄 ＋ 篩選開關。
            它們只影響這張卡，所以留在卡上。

          ★ `rounded-t-xl` 跟著 TabShell 的面板圓角 —— 左上角除外
            （那是第一個分頁接上去的地方）。
        */}
        <div className="flex flex-wrap items-center gap-2 rounded-t-xl rounded-tl-none border-b border-mor-line bg-mor-sand/30 px-3 py-2">
          <Tabs variant="segment" size="sm"
            value={view} onChange={setView}
            items={[{ key: 'txn' as const, label: '流水' },
                    { key: 'stmt' as const, label: '匯入紀錄' }]} />
          <div className="ml-auto flex items-center gap-2">
            {view === 'txn' && <FilterToggle active={hasFilter(f)} />}
            {/*
              ★★ 下載與上傳**不在這一列**（2026-08-29 使用者:「layout 一致耶」）。

                這一列留給「看什麼」:帳戶分頁、流水／匯入紀錄、篩選開關。
                「做什麼」統一搬到篩選列**下面**那一行 —— 全站每一頁都是
                「篩選卡 → 動作列」這個順序,只有這頁反過來的話,
                使用者每次進來都要重新找按鈕在哪。
            */}
          </div>
        </div>

        {/*
          ── 篩選列 ──────────────────────────────

          ★ 這一列**不套白卡** —— 它長在表格卡的上緣，再包一層會變成「卡中卡」。
            但它有 `.filter-bar`，所以欄位高度與標題字級仍然吃
            globals.css 那條全站統一的規則（見「篩選列的統一外觀」）。
        */}
        {view === 'txn' && (
          <div className="filter-bar collapsible-filters flex flex-wrap items-end gap-3 border-b border-mor-line px-4 py-3">
            {/*
              ★★★ 起訖連動（2026-08-29 補）。

                2026-08-27 那次「全站起訖連動」**漏了這一支**,
                跟契約頁的 FilterDateRange 是同一種漏法:
                當時是掃「`type="date"` 靠得很近的成對輸入」,
                而這兩個各自包在 `<label>` 裡,中間隔著標題文字 —— 掃不到。

                ★★ 漏掉的症狀是**安靜的**:起日改到迄日之後,
                  區間變成空的 → 清單一筆都不剩 → 畫面顯示「沒有交易」,
                  跟「這個帳戶這段期間真的沒有交易」長得一模一樣。

                ★ 教訓（README 9.3）:**照形狀掃會漏,要照「誰在用」掃**。
                  現在起訖一律走 `syncFrom` / `syncTo`,
                  `grep -rn "syncFrom"` 一次就找得到全部。
            */}
            {/*
              ★★★ 改用 `lib/filters` 的共用元件（2026-08-29 使用者:
                 「2. 沒按照其它頁統一格式」）。

                原本這一段是**手寫的** —— 標題 `text-xs text-gray-500`、
                欄位 `border-mor-line px-2 py-1.5`,而全站標準是
                標題 `text-uisub`、欄位 `FILTER_CTRL`（h-12/h-10、17px、gray-300）。
                差別小到單看這頁看不出來,跟訂單頁擺在一起就很明顯。

              ★ 起訖連動也一併回到共用元件裡（FilterDateRange 內建
                syncFrom/syncTo），不用再在這裡手接一次。
            */}
            <FilterDateRange label="帳務日"
              from={f.from ?? ''} to={f.to ?? ''}
              onFrom={(v) => set('from', v || undefined)}
              onTo={(v) => set('to', v || undefined)} />
            {/*
              ★ 「方向」改叫「收支」,選項改成「收入／支出」
                （2026-08-29 使用者指定）。

                「方向」是資料庫的講法（debit/credit 的方向）;
                記帳的人腦子裡是「收入」跟「支出」。
                而且原本寫「只看支出／只看存入」—— 一個叫支出、
                一個叫存入,兩邊不對稱,唸起來不像同一組選項。
            */}
            <FilterSelect label="收支"
              value={f.dir ?? ''}
              onChange={(v) => set('dir', v as BankFilter['dir'])}
              options={[{ value: 'credit', label: '收入' }, { value: 'debit', label: '支出' }]} />
            {/*
              ══════════════════════════════════════════════════════
              ★★★ 金額上下限**拿掉了**（2026-08-29 使用者:
                   「不用金額 改在查詢裡 打金額查詢 能查到相似的金額」）。

                兩個數字框佔掉篩選列兩格,而實際上要找一筆錢的時候
                人記得的是「大概七千」不是「6500 到 7500 之間」——
                填區間要先想兩個數字,而想錯了就查不到。

              ★ 關鍵字本來就會比金額,而且是**包含比對**:
                打 `7000` 找得到 7,000 也找得到 17,000、70,000 ——
                那正是「相似的金額」。逗號與錢字號會先去掉,
                所以直接從畫面上複製 `$7,000` 貼進來也查得到。
              ══════════════════════════════════════════════════════
            */}
            <FilterSearch value={qDraft} onChange={setQDraft}
              onSubmit={() => set('q', qDraft)}
              placeholder="摘要／交易帳號／銀行／金額" />
            {/*
              一年可能只出現一次的東西 —— 沒有這個開關就只能一頁一頁翻
            */}
            <FieldSpacer>
              <label className="flex h-12 items-center gap-1.5 text-uisub text-gray-600 md:h-10">
                <input type="checkbox" checked={!!f.onlyNoted}
                  onChange={(e) => set('onlyNoted', e.target.checked)} />
                只看餘額有備註的
              </label>
            </FieldSpacer>
            <FilterClear active={hasFilter(f)}
              onClear={() => { setF({ from: '', to: '', dir: '', q: '' }); setQDraft(''); }} />
          </div>
        )}

        {/*
          動作列 —— 跟全站一致:篩選在上、動作在下，靠右。

          ★ 這兩顆是**針對當前這個帳戶**的:下載的是這個分頁篩出來的流水、
            上傳也是進這個帳戶。所以它們留在卡片內、跟著分頁走,
            不是搬到頁面標題旁邊（那看起來像「整頁」的動作）。
        */}
        <div className="flex flex-wrap items-center justify-end gap-3 border-b border-mor-line px-4 py-3">
          {view === 'txn' && (
            <div className="mr-auto md:mr-0"><FilterCount n={shown.length} unit="筆" /></div>
          )}
          {view === 'txn' && <ExportButton onClick={exportXlsx} disabled={shown.length === 0} />}
          {/*
            ★★★ 現金帳戶換一顆鈕（2026-08-31）。

              「上傳對帳單」對現金帳戶是**沒有東西可以傳**——
              留著它的話,點下去會開一個永遠不該用的視窗,
              而使用者要自己想通「喔原來現金不是這樣加的」。

            ★ 兩顆鈕**位置與樣式一樣**,只有字不同。
              放在不同的地方的話,換分頁時眼睛要重新找。
          */}
          {isManual(cur) ? (
            <button
              onClick={() => { setCashErr(''); setCashForm(blankCash()); }}
              disabled={!!cashForm}
              className="rounded-lg bg-mor-slate px-4 py-1.5 font-medium text-white
                         hover:bg-mor-slatedark whitespace-nowrap disabled:opacity-50"
            >
              ＋ 新增一筆
            </button>
          ) : (
            <button
              onClick={() => setShowUpload(true)}
              className="rounded-lg bg-mor-slate px-4 py-1.5 font-medium text-white hover:bg-mor-slatedark whitespace-nowrap"
            >
              ⬆ 上傳對帳單
            </button>
          )}
        </div>

        {/*
          ── 新增／編輯現金流水 ─────────────────────

          ★★ 開在**表格上方**而不是彈出視窗。
            現金記帳是「看著前幾筆、照樣再記一筆」——
            視窗蓋住清單的話,那個參照就沒了。

          ★ 編輯既有的那一筆時同一個表單,只是標題與按鈕的字不一樣。
            兩套 UI 做同一件事,行為一定會漂。
        */}
        {isManual(cur) && cashForm && (
          <div className="border-b border-mor-line bg-mor-bluelight/50 px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-uisub font-medium text-mor-slate">
                {cashForm.id ? '編輯這一筆' : '新增一筆現金收支'}
              </span>
              {cashErr && <span className="text-uisub text-red-600">{cashErr}</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              <label className="flex flex-col gap-1 text-xs text-gray-600">交易日
                <input type="date" value={cashForm.post_date}
                  onChange={(e) => setCashForm((o) => o && { ...o, post_date: e.target.value })}
                  className="h-9 rounded border border-gray-300 px-2 text-sm" />
              </label>
              {/*
                ★ 交易型態是**唯讀的「現金」**（使用者 2026-08-31 指定）。
                  讓人自由填的話會冒出「現金」「現金交易」「CASH」三種寫法,
                  而依型態分組時它們是三個不同的東西。
                  唯讀但**顯示出來**:留白的話看的人不知道這欄會被填什麼。
              */}
              <label className="flex flex-col gap-1 text-xs text-gray-600">交易型態
                <input value={isCash(cur) ? '現金' : '手動'} readOnly tabIndex={-1}
                  className="h-9 rounded border border-gray-200 bg-gray-50 px-2 text-sm text-gray-500" />
              </label>
              {/*
                ★★ 同一個輸入框，兩種意思（migration_192）:
                  現金 → 填人名，存 counterparty
                  08311 → 填帳號，存 ref_no（它是真的銀行帳戶，對方有帳號）
                標籤與 placeholder 都要跟著換 —— 只換存法不換標籤的話，
                在 08311 上看到「（人名）」的人會填人名進去。
              */}
              <label className="flex flex-col gap-1 text-xs text-gray-600">
                {isCash(cur) ? '交易帳號（人名）' : '交易帳號'}
                <input value={cashForm.counterparty}
                  placeholder={isCash(cur) ? '陳小胖' : '013-0000012345678'}
                  onChange={(e) => setCashForm((o) => o && { ...o, counterparty: e.target.value })}
                  className="h-9 rounded border border-gray-300 px-2 text-sm" />
              </label>
              {/*
                ★★ 方向用下拉,**不是讓人打負號**。
                  打負號的話「−500」跟「-500」跟「(500)」都會出現,
                  而 `Number()` 只認得其中一種 —— 另外兩種變 NaN,
                  存進去是 0,而畫面上那一列看起來只是金額很小。
              */}
              <label className="flex flex-col gap-1 text-xs text-gray-600">收支
                <select value={cashForm.dir}
                  onChange={(e) => setCashForm((o) => o && { ...o, dir: e.target.value as 'credit' | 'debit' })}
                  className="h-9 rounded border border-gray-300 px-2 text-sm">
                  <option value="credit">存入</option>
                  <option value="debit">支出</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-600">金額
                <input value={cashForm.amount} placeholder="8000" inputMode="decimal"
                  onChange={(e) => setCashForm((o) => o && { ...o, amount: e.target.value })}
                  className="h-9 rounded border border-gray-300 px-2 text-sm tabular-nums" />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-xs text-gray-600 md:col-span-1">摘要
                <input value={cashForm.memo} placeholder="開封1F-1 8月租金"
                  onChange={(e) => setCashForm((o) => o && { ...o, memo: e.target.value })}
                  className="h-9 rounded border border-gray-300 px-2 text-sm" />
              </label>
            </div>
            {/*
              ── 收據照片（migration_185）─────────────

              ★★★ 為什麼現金特別需要照片:銀行流水有對帳單當靠山，
                金額對不上時可以回去翻 PDF。**現金沒有。**
                它的唯一來源是那個 key 的人，而三個月後沒有人記得
                「8/18 收陳小胖 8000」是怎麼回事。

              ★ 支出也給，不只存入。現金付出去連對方的入帳紀錄都沒有，
                收據是唯一的東西；收入至少還有房客那邊對得上。

              ★★ 新增時 `parentId` 是 null —— `Receipts` 會把檔案留在
                瀏覽器裡，等這一列存好後由 `flush(id)` 真的上傳。
            */}
            <div className="mt-3 border-t border-mor-slate/15 pt-3">
              <Receipts ref={receiptsRef} kind="cash"
                parentId={cashForm.id ?? null}
                label="收據照片（選填，可多張）" />
            </div>

            <div className="mt-2 flex items-center gap-2">
              <button onClick={saveCash} disabled={cashBusy}
                className="rounded-lg bg-mor-slate px-4 py-1.5 text-sm font-medium text-white
                           hover:bg-mor-slatedark disabled:opacity-50">
                {cashBusy ? '存檔中…' : cashForm.id ? '存檔' : '新增'}
              </button>
              <button onClick={() => { setCashForm(null); setCashErr(''); }}
                className="text-sm text-gray-500 underline">取消</button>
              {/*
                ★ 餘額會怎麼變**先講出來**。存下去才發現後面十筆餘額都跳了,
                  那時已經來不及了 —— 而「先講」的成本是一行字。
              */}
              <span className="ml-auto text-xs text-gray-500">
                餘額自動接上一筆；補舊日期時後面的會一起重算
              </span>
            </div>
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
        <>
        {/*
          ══════════ 手機卡片（2026-08-22）══════════

          七欄的表在 390px 只能橫向滑。而這一頁的用途是**對帳** ——
          橫向滑最糟的地方是「眼睛從日期掃到餘額時跳到隔壁列」，
          而跳錯一列在對帳時就是對到別筆交易。

          ★ 卡片一列一筆，金額用顏色分方向:
            存入綠色、支出紅色。餘額印在下面一行。
          ★ 交易帳號的末五碼要看得到 —— 那是對帳唯一的鑰匙。
        */}
        <div className="md:hidden space-y-2 px-1">
          {!shown.length ? (
            <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-10 text-center text-gray-400">
              沒有符合條件的交易。
            </div>
          ) : shown.map((t) => (
            <div key={`m-${t.id}`} className="rounded-xl border border-mor-line bg-white px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-gray-500 tabular-nums">
                    {ymd(t.txn_date ?? t.post_date)}
                    {t.txn_date && t.txn_date !== t.post_date && (
                      <span className="text-gray-400">・入帳 {ymd(t.post_date)}</span>
                    )}
                  </div>
                  <div className="font-medium mt-0.5 truncate">{t.description ?? ''}</div>
                  {/*
                    摘要可編輯 —— 手機上也是對帳會用到的（同桌機規則），
                    ★ 包含那把鎖（2026-08-31）。手機更容易手滑，這裡的鎖比桌機更需要。

                    ★★ 鎖的點擊面積 `w-7 h-7`（28px）而不是跟桌機一樣的字大小。
                      手指按不準 12px 的圖示 —— 按不到會變成「一直點但沒反應」，
                      而那比沒有鎖更糟。
                  */}
                  {memoEdit?.id === t.id ? (
                    <div className="flex items-center gap-1 mt-1">
                      <span aria-hidden className="shrink-0 text-xs">🔓</span>
                      <input autoFocus value={memoEdit.text}
                        onChange={(e) => setMemoEdit({ id: t.id, text: e.target.value })}
                        className="flex-1 min-w-0 h-9 rounded border border-mor-slate px-2 text-sm" />
                      <button onClick={saveMemo} disabled={memoBusy}
                        className="shrink-0 text-xs text-mor-green underline px-1">存</button>
                      <button onClick={() => setMemoEdit(null)}
                        className="shrink-0 text-xs text-gray-400 underline px-1">取消</button>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1 mt-0.5">
                      <button onClick={() => setMemoEdit({ id: t.id, text: t.memo ?? '' })}
                        aria-label="開鎖編輯摘要"
                        className="shrink-0 w-7 h-7 -ml-1 text-xs opacity-40">🔒</button>
                      <span className="text-[11px] text-gray-600 break-words min-w-0 pt-1">
                        {t.memo || <span className="text-gray-300">還沒有摘要</span>}
                      </span>
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  {Number(t.credit) > 0 && (
                    <div className="font-bold tabular-nums text-mor-green">＋{money(t.credit)}</div>
                  )}
                  {Number(t.debit) > 0 && (
                    <div className="font-bold tabular-nums text-red-600">−{money(t.debit)}</div>
                  )}
                  <div className="text-[11px] text-gray-400 tabular-nums mt-0.5">
                    餘 {money(t.balance)}
                  </div>
                  {/*
                    ★ 手機也要有改／刪。手機是**最常打錯的地方**——
                      螢幕小、鍵盤擋住一半的表單,而現金多半就是在外面用手機記的。
                    ★ 面積比桌機大（`py-1 px-1.5`）—— 手指按不準純文字連結。
                  */}
                  {isManual(cur) && (
                    <div className="mt-1 flex justify-end gap-1">
                      {/*
                        ★★ 手機上收據照片**比桌機更重要** ——
                          現金多半就是在外面收的，人在現場、收據在手上，
                          那一刻拍照最省事。回家再補多半就不會補了。
                      */}
                      <button onClick={() => setAttOpen((v) => (v === t.id ? null : t.id))}
                        aria-expanded={attOpen === t.id}
                        aria-label={attCount[t.id] ? `${attCount[t.id]} 張收據` : '加收據照片'}
                        className={`px-1.5 py-1 text-[11px] ${
                          attCount[t.id] ? 'text-mor-slate' : 'text-gray-400 opacity-50'}`}>
                        📎{attCount[t.id] ? attCount[t.id] : ''}
                      </button>
                      <button onClick={() => editCash(t)} disabled={cashBusy}
                        className="px-1.5 py-1 text-[11px] text-mor-slate underline disabled:opacity-40">改</button>
                      <button onClick={() => deleteCash(t)} disabled={cashBusy}
                        className="px-1.5 py-1 text-[11px] text-red-600 underline disabled:opacity-40">刪</button>
                    </div>
                  )}
                </div>
              </div>
              {/* 展開的收據區。★ 在卡片**內**，不是另一張卡 —— 它屬於這一筆 */}
              {isManual(cur) && attOpen === t.id && (
                <div className="mt-2 border-t border-mor-line pt-2">
                  <Receipts kind="cash" parentId={t.id} label="收據照片"
                    onImages={() => { if (cur) void loadTxns(cur.id); }} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="hidden md:block overflow-x-auto">
          {/*
            ══════════ 欄寬 ══════════

            【為什麼要寫死，不讓瀏覽器自己算】（2026-08-19 使用者指定）

            預設的 table-auto 是「誰的字多誰就寬」—— 摘要那一欄有
            「4010054659 代繳市水 08025 112 TPCW」這種長字串，
            它就把寬度全吃掉，而交易帳號被擠到剩下一點點，
            `013-00000095503-32784` 只好折成兩三行。

            結果剛好相反:**佔最多版面的是最不重要的那一欄**。
            對帳時人在找的是帳號，摘要是輔助。

            所以改成 table-fixed ＋ colgroup:
              摘要     窄，字多就折行（它本來就是自由文字，折行不影響閱讀）
              交易帳號 放得下 21 個字的等寬數字串，不折行

            min-w 是給窄螢幕的 —— 沒有它的話 table-fixed 會等比壓縮，
            帳號又會折回去。寧可讓外層橫向捲動。
          */}
          <table className="w-full min-w-[62rem] table-fixed text-sm">
            <colgroup>
              <col className="w-[7rem]" />     {/* 交易日（含「入帳 ⋯」第二行） */}
              <col className="w-[5.5rem]" />   {/* 交易型態 */}
              <col className="w-[16rem]" />    {/* 摘要 —— 放寬（2026-08-19），字多仍折行 */}
              <col className="w-[13rem]" />    {/* 交易帳號 —— 13px 等寬字一行放得下 21 個字 */}
              <col className="w-[6.5rem]" />   {/* 支出 */}
              <col className="w-[6.5rem]" />   {/* 存入 */}
              <col className="w-[7.5rem]" />   {/* 餘額（可能有備註第二行） */}
              {/*
                ★★ 現金帳戶才有的第八欄:改／刪。
                  銀行帳戶不給這一欄 —— 那些是對帳單的鏡像,
                  要修正只能重新上傳（migration_166 的觸發器也擋著）。
                ★ `w-[5rem]` 放得下「改 刪」兩個連結,不會把前面七欄擠窄。
              */}
              {isManual(cur) && <col className="w-[5rem]" />}
              {/* 收據照片（migration_185）。★ 只放一個回形針與數字，3rem 夠 */}
              {isManual(cur) && <col className="w-[3rem]" />}
            </colgroup>
            {/* ★ 全站標準表頭寫法（14 處都是這個）—— 原本這頁用 bg-mor-sand/40
                  ＋ text-gray-600,是唯一的例外 */}
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
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
                {/*
                  「交易帳號」不是「對方」（使用者指定 2026-08-19）。

                  對帳時人在找的是**帳號** —— 銀行名只有十來種，
                  同一家銀行底下幾十個房客,靠它分不出任何東西。
                  所以帳號當主體，銀行名縮小當註腳。
                */}
                <SortTh label="交易帳號" sortKey="ref_no" state={sort}
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
                <tr><td colSpan={isManual(cur) ? 9 : 7} className="px-3 py-8 text-center text-gray-400">載入中⋯</td></tr>
              )}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={isManual(cur) ? 9 : 7} className="px-3 py-8 text-center text-gray-400">
                    {txns.length === 0
                      ? '這個帳戶還沒有流水 —— 上傳一份對帳單試試'
                      : `沒有符合的資料（全部 ${txns.length} 筆）`}
                  </td>
                </tr>
              )}
              {/*
                ★★ `flatMap` 而不是 `map` —— 現金帳戶的每一筆可能回**兩列**:
                  主列，加上展開的收據照片列。
                  `map` 回巢狀陣列的話 React 會警告 key 重複，
                  而且 `<tbody>` 底下多一層陣列 HTML 是不合法的。
              */}
              {shown.flatMap((t) => [
                /*
                  斑馬紋。**這是這一頁最需要顏色的地方** ——
                  七欄寬的表格，眼睛從左邊的日期掃到右邊的餘額時
                  很容易跳到隔壁列，而跳錯一列在對帳時就是對到別筆交易。
                  隔列淡底可以把視線釘在同一條水平線上。
                */
                <tr key={t.id} className="border-t border-mor-line even:bg-mor-sand/20 hover:bg-mor-sand/60">
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
                  {/*
                    摘要是**唯一可編輯的欄位**（2026-08-22 使用者指定）。

                    全形字原樣顯示（１２月房租、南５）—— 轉半形之後跟 PDF 對不起來。
                    折行:摘要是自由文字，斷在哪裡都讀得懂，
                    而它擠掉帳號的代價比多佔一行高度大得多。

                    ============================================================
                    【★★★ 每一列各自上鎖】（2026-08-31 使用者：
                      「存完自動鎖起來，要先開鎖才能存」，從 A／B／C 選了 B）

                    原本是「點文字就直接變輸入框」。那個設計的代價是
                    **滑過去手滑點到，就把原本的摘要蓋掉**，而摘要是這一頁
                    唯一人工輸入、重新上傳對帳單救不回來的東西。

                    所以拆成兩步：點 🔒 才開，存完 `setMemoEdit(null)` 自動關回去。

                    ★★ 鎖做在**列**上不是頁上（A 案被否）。
                      對帳是一筆接一筆地補註記 —— 開關放頁首的話，
                      每改一筆滑鼠就要跑回頁首一次。
                      鎖在那一格旁邊，開鎖跟編輯是連著的兩下。

                    ★★ 攔在「進入編輯」不是攔在「按存」（C 案被否）。
                      攔在存的話，字都打完了才發現存不進去 —— 白打一次。
                      防手滑要攔在動作**開始前**。

                    ★ 這是畫面上的防手滑，**不是權限**。重新整理就回到鎖上。
                      真正擋非法寫入的是 migration_166 的 trg_bank_txn_memo_only
                      （只准改 memo，其餘欄位改了就拋錯）—— 那一道還在，兩層不同的東西。
                  */}
                  <td className="px-3 py-1.5 text-gray-600 break-words">
                    {memoEdit?.id === t.id ? (
                      <div className="flex items-center gap-1">
                        {/* 開著的鎖:讓人看得出「現在是開的，所以能打字」 */}
                        <span aria-hidden className="shrink-0 text-xs">🔓</span>
                        <input autoFocus value={memoEdit.text}
                          onChange={(e) => setMemoEdit({ id: t.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            // Enter 存、Esc 取消 —— 對帳時手不用離開鍵盤
                            if (e.key === 'Enter') saveMemo();
                            if (e.key === 'Escape') setMemoEdit(null);
                          }}
                          className="flex-1 min-w-0 h-8 rounded border border-mor-slate px-1.5 text-sm" />
                        <button onClick={saveMemo} disabled={memoBusy}
                          className="shrink-0 text-xs text-mor-green underline">存</button>
                        <button onClick={() => setMemoEdit(null)}
                          className="shrink-0 text-xs text-gray-400 underline">取消</button>
                      </div>
                    ) : (
                      <div className="flex items-start gap-1.5">
                        {/*
                          ★ 只有這顆鎖可以點，文字本身不可點 ——
                            文字還可以點的話，鎖就只是裝飾。
                          ★ 空的摘要也要能開鎖，不然「加第一筆註記」沒有入口。
                        */}
                        <button onClick={() => setMemoEdit({ id: t.id, text: t.memo ?? '' })}
                          title="開鎖後編輯摘要（存完自動鎖回去）"
                          aria-label="開鎖編輯摘要"
                          className="shrink-0 text-xs leading-5 opacity-40 hover:opacity-100
                                     transition-opacity rounded px-0.5">
                          🔒
                        </button>
                        <span className="min-w-0">
                          {t.memo || <span className="text-gray-300 text-xs">—</span>}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {/*
                      ★ 帳號是主體，銀行名是註腳（2026-08-19 使用者指定，跟原本相反）。

                      理由是對帳時要找的東西:銀行名只有十來種,
                      「國泰世華」重複出現幾十次,分不出是誰匯的;
                      帳號才是那筆錢唯一的身分。

                      末五碼切出來（splitRef）—— 銀行代號那三碼留在原地,
                      不然看不出是哪家銀行。斷行用 break-all:
                      那是 16–20 位的數字串，不斷行會把整張表撐開。
                    */}
                    {/* 欄寬已經放得下整串（colgroup 12.5rem），break-all 只是萬一
                        遇到更長的號碼時的保險 —— 折行總比溢出去蓋到別欄好 */}
                    {/* 13px（2026-08-19 使用者指定放大）—— 這一欄是對帳時真正在讀的東西,
                        原本 12px 的等寬數字在一堆 14px 中文旁邊看起來像註腳 */}
                    {/*
                      ★★★ 現金帳戶這一欄放的是**人名**（使用者 2026-08-31 指定）。

                        銀行帳戶:主體是 `ref_no`（對方帳號）、註腳是 `counterparty`（銀行名）
                        現金帳戶:`ref_no` 是空的,人名存在 `counterparty` ——
                                 所以它變成主體，而且不用等寬字（人名不是數字串）。

                      ★ 欄位標題兩種情況都叫「交易帳號」,沒有改。
                        使用者要的就是「交易帳號欄填人名」,改標題反而跟他說的不一樣。
                    */}
                    {isCash(cur) ? (
                      t.counterparty && (
                        <div className="truncate text-[14px] font-medium text-gray-800">
                          {t.counterparty}
                        </div>
                      )
                    ) : (
                      <>
                        {t.ref_no && (
                          <div className="break-all font-mono text-[14px] font-medium tracking-tight text-gray-800">
                            {splitRef(t.ref_no)}
                          </div>
                        )}
                        {t.counterparty && (
                          <div className="text-[11px] text-gray-400 mt-0.5 truncate">{t.counterparty}</div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-red-600">
                    {Number(t.debit) ? money(Number(t.debit)) : ''}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-green-700">
                    {Number(t.credit) ? money(Number(t.credit)) : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {/* 金額本身不折行,但底下的餘額備註要折 —— 所以 nowrap 給那一行不給整格 */}
                    <div className="whitespace-nowrap">{money(Number(t.balance))}</div>
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
                  {/*
                    ★★★ 改／刪只有現金帳戶有（使用者 2026-08-31:「key 錯了要可以改、可以刪」）。

                      手動輸入一定會打錯,而現金**沒有對帳單可以重新上傳**——
                      沒有退路的話這個帳戶等於不能用。

                    ★★ 銀行帳戶連這兩個字都不出現。畫出來再擋的話,
                      使用者會以為是權限不足而去找人開權限 ——
                      而那是永遠開不出來的（資料是對帳單的鏡像,本來就不該改）。
                  */}
                  {isManual(cur) && (
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      <button onClick={() => editCash(t)} disabled={cashBusy}
                        className="text-xs text-mor-slate underline disabled:opacity-40">改</button>
                      <button onClick={() => deleteCash(t)} disabled={cashBusy}
                        className="ml-2 text-xs text-red-600 underline disabled:opacity-40">刪</button>
                    </td>
                  )}
                  {/*
                    ★★★ 已經存好的列也要能加照片（2026-08-31 使用者:
                       「已存的可以再上傳嗎」）。

                      ★ **沒有照片的也要能點**（淡色的回形針）。
                        只讓有照片的可點的話,「補第一張」就沒有入口了 ——
                        這跟摘要那個「空的也要能開鎖」是同一條道理。

                      ★★ 一次只展開一列。全部展開的話兩百列的表格會變成
                        幾千像素高,而使用者要的只是「看這一筆的收據」。
                  */}
                  {isManual(cur) && (
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => setAttOpen((v) => (v === t.id ? null : t.id))}
                        aria-expanded={attOpen === t.id}
                        title={attCount[t.id] ? `${attCount[t.id]} 張收據` : '加收據照片'}
                        className={`rounded px-1 text-xs leading-5 transition-opacity ${
                          attCount[t.id] ? 'text-mor-slate' : 'text-gray-400 opacity-40 hover:opacity-100'}`}>
                        📎{attCount[t.id] ? <span className="ml-0.5">{attCount[t.id]}</span> : ''}
                      </button>
                    </td>
                  )}
                </tr>,
                /*
                  展開的照片區。★ 做成**第二個 <tr>** 而不是塞進上面那一列 ——
                  塞進去的話那一格會把整列撐高,而旁邊六格是空的。
                  ★ `key` 要跟主列不同,不然 React 會把兩者當成同一個。
                */
                isManual(cur) && attOpen === t.id ? (
                  <tr key={`att-${t.id}`} className="bg-mor-sand/30">
                    <td colSpan={9} className="px-4 py-3">
                      <Receipts kind="cash" parentId={t.id} label="收據照片"
                        onImages={() => { if (cur) void loadTxns(cur.id); }} />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
            {shown.length > 0 && (
              <tfoot className="border-t border-mor-line bg-mor-sand/30 text-xs">
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
        </>
        )}
      </TabShell>

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
