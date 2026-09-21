'use client';
/**
 * 暫付分頁 —— 公司付出去、之後要收回來的押金與保證金（migration_196）。
 *
 * ============================================================
 * 【★★★ 為什麼拆成 hook ＋ 兩個元件】（2026-09-01 使用者:「tab 位置被移動」）
 *
 * 這一頁的版面順序是**固定的**:
 *
 *     總計 ＋ 統計卡  →  分頁籤  →  篩選 ＋ 清單
 *
 * 分頁籤夾在中間。所以暫付的卡片必須放在分頁籤**之前**、清單放在**之後** ——
 * 一個元件包全部的話，它只能整塊放在分頁籤下面，
 * 於是切到暫付時分頁籤會從畫面中間跳到最上面。
 *
 * ★ 第一版就是那樣做的，而使用者一眼就看到了。**版面順序不是實作細節**:
 *   使用者在頁面上找東西靠的是位置記憶，換一個分頁就換一個位置
 *   等於每次都要重新找。
 *
 * ★★ 拆開之後兩邊要共用同一份資料 —— 所以資料抓取提成 `useAdvance()`，
 *   由 page 呼叫一次，把結果分別傳給兩個元件。
 *   兩個元件各自抓一次的話，數字會有一瞬間對不上，
 *   而且新增一筆之後只有其中一邊會更新。
 *
 * ============================================================
 * 【為什麼不塞進 deposits/page.tsx】
 *
 * 那一頁已經 2,300 行，而暫付跟暫收**只有版面像**:
 *
 *   暫收   錢是別人的，退款要走兩票核可（主管＋總經理）
 *   暫付   錢是我們的，收回是錢進來，不需要核可
 *
 * 混在同一個元件裡的話，每一個判斷式都要先問「這是哪一種」——
 * 而那正是 CLAUDE.md 說的「以後每次都要多想一次」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import StatCard, { StatRow, StatGroup, StatTotal } from '@/components/StatCard';
import MoneyInput from '@/components/MoneyInput';
import Req from '@/components/Req';
import { submitGate, gateCls } from '@/lib/required';
import { useOnce } from '@/lib/once';
import {
  statusOf, STATUS_LABEL, forfeitedOf, statsOf, validateAdvance, advanceMissing,
  defaultRefundAccount, refundAccountWarning, needsForfeitExpense,
  CATEGORIES, MANUAL_CATEGORIES, type Advance, type AdvanceStatus,
  purposeFromSelect, purposeToSelect, purposeLabel, PURPOSE_OFFICE, OFFICE_LABEL,
  canBatch, batchDisabled, lockedParty, batchSelectable, remainingOf,
} from '@/lib/advance';
import {
  allocate, validateRepay, owedTotal, isOpen as repayOpen, type RepayRow,
} from '@/lib/advance-repay';
import { accountsForBook } from '@/lib/purchase-pay';
import { todayStr } from '@/lib/period';

const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

/*
 * 狀態的顏色。★ 照站上既有的語意（記在 ToggleInfo）:
 *   琥珀＝還沒定案的錢（錢在外面，等它回來）
 *   綠＝已收（收回來了）
 *   紅＝警示（被扣了，那是真的損失）
 */
const STATUS_CLASS: Record<AdvanceStatus, string> = {
  draft:     'bg-gray-100 text-gray-500',
  paid:      'bg-amber-50 text-amber-700',
  /* ★★ 部分收回是**還在外面**（錢會回來），所以跟「待收回」同一個琥珀，
       不是紅的 —— 紅是「這筆真的損失了」，而那是下面那一個 */
  partial:   'bg-amber-50 text-amber-700',
  refunded:  'bg-mor-greenlight text-mor-greendark',
  shortfall: 'bg-red-50 text-red-600',
};

const CAT_CLASS: Record<string, string> = {
  押金:   'bg-mor-bluelight text-mor-slate',
  保證金: 'bg-purple-50 text-purple-700',
  // ★ 零用金給琥珀（migration_212）。少了這一列不會報錯，只是變成沒有底色的白字
  零用金: 'bg-amber-50 text-amber-700',
  其他:   'bg-gray-100 text-gray-600',
};

/** 收付款帳號。★ `book` 決定它屬於哪一本帳（migration_284） */
type PayAcct = { code: string; name: string; book?: string | null };

/** 對象（愛皮／洪鯊）對到哪一本帳。★ 一份定義,畫面兩個下拉都走它 */
const BOOK_OF: Record<string, string> = { 愛皮: 'aipi', 洪鯊: 'hongsha' };

const CTRL = 'h-11 md:h-9 rounded-lg border border-gray-300 px-2 text-sm bg-white';

/**
 * 必填欄位的標題（2026-09-03 使用者:「必填 打*」）。
 *
 * ★★ 只有**真的會擋下存檔**的四個欄位可以用這個 ——
 *   類別、對象、項目、暫付款（`validateAdvance` 擋的就是這四個）。
 *   標了星卻不擋、或擋了卻沒標，兩種都會讓人不信任那顆星。
 *
 * ★ 星號是紅的而且在字後面 —— 表單慣例，不用另外解釋。
 */
/**
 * 標籤 ＋ 紅星。
 *
 * ★★★ 2026-09-10:這裡原本自己寫了一份**同名**的 `Req`，沒有 import
 *   共用元件，而且簽名相反（吃 children）。兩個後果:
 *
 *   ① 它**沒有 `sr-only` 的「必填」** —— 讀螢幕的人只聽到「星號」，
 *      而那正是共用元件的註解特別解決掉的問題。
 *   ② 誰哪天把它換成共用的 `Req`，這四個標籤文字會**整個消失**
 *      （共用版不吃 children），而 tsc 只會抱怨型別、
 *      不會告訴你畫面上少了四個字。
 *
 * 現在改成薄薄一層包住共用元件 —— 用法不變，但星號是全站同一顆。
 */
function ReqLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs text-gray-500 flex items-center">
      {children}<Req />
    </span>
  );
}

type Row = Advance & { id: string; estate_id: string | null; purpose_type?: string | null; created_at?: string };

const blank = (): Advance => ({
  category: '押金', counterparty: '', usage: '', amount: 0,
  paid_on: '', refunded_on: null, refunded_amount: null, note: '',
});

/* ══════════════════════════════════════════════════════════
 * 資料 —— 卡片與清單共用同一份
 * ══════════════════════════════════════════════════════════ */

export type AdvanceState = ReturnType<typeof useAdvance>;

/**
 * @param enabled 只有在暫付分頁時才去查。
 *
 * ★ 不加這個旗標的話，每次打開暫收付管理都會多一次查詢 ——
 *   而使用者九成的時間待在暫收那三頁。
 */
export function useAdvance(enabled: boolean) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [statusF, setStatusF] = useState<'all' | AdvanceStatus>('all');
  const [estateF, setEstateF] = useState('');
  const [edit, setEdit] = useState<Advance | null>(null);

  /*
   * 收款帳戶與會計科目的選單資料。
   *
   * ★ 在這支 hook 裡查，不從 deposits/page.tsx 傳進來 —— 那一頁的四個分頁
   *   只有暫付需要它們，往上提就變成每個分頁都要背著兩份用不到的資料。
   */
  const [payAccounts, setPayAccounts] = useState<PayAcct[]>([]);
  const [accountCodes, setAccountCodes] = useState<{ code: string; name: string }[]>([]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    /*
     * ★★★ 第二排序鍵不能省（2026-09-21）。原本只有 `paid_on` 一個鍵 ——
     *   愛皮 9/09 那批有 7 列同一天，順序是 Postgres 隨便給的，
     *   **每次重新整理都可能不一樣**。清單順序會跳，而攤還的預覽
     *   （從最舊的一筆扣）看起來就會像在亂扣。
     * ★ 扣款順序本身不靠這裡 —— 那是 `repayOrder()` 的事（舊的先）。
     *   這裡只負責讓畫面穩定。
     */
    const { data, error } = await supabase.from('advance_payments')
      .select('*')
      .order('paid_on', { ascending: false, nullsFirst: true })
      .order('created_at', { ascending: false });
    if (error) setMsg('讀取失敗：' + error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [supabase, enabled]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!enabled) return;
    /*
     * ★ 表名是 `payment_accounts` 不是 `pay_accounts`（purchases/page.tsx:355）。
     *   寫錯的話 PostgREST 回 404、這裡沒有檢查 error，
     *   結果是下拉**靜靜地空著** —— 而使用者只會覺得「怎麼沒有帳戶可選」。
     */
    /* ★ 要 `book`:還入帳號只能選安幸的、出帳帳號只能選對方那一本的（migration_284） */
    supabase.from('payment_accounts').select('code, name, book').order('code')
      .then(({ data, error }) => {
        if (error) setMsg('讀不到收款帳戶：' + error.message);
        setPayAccounts((data ?? []) as PayAcct[]);
      });
    /*
     * ★ 只要能記支出的科目。`kind` 是 income 的（房租收入那些）出現在
     *   「被扣的差額」下拉裡沒有意義 —— 而選下去會產生一筆科目是收入的支出，
     *   那在報表上是查不出來的（migration_90 定義了這個 kind）。
     */
    supabase.from('account_codes').select('code, name, kind, active').order('sort')
      .then(({ data, error }) => {
        if (error) setMsg('讀不到會計科目：' + error.message);
        setAccountCodes(((data ?? []) as any[])
          .filter((c) => c.active !== false && c.kind !== 'income')
          .map((c) => ({ code: c.code, name: c.name })));
      });
  }, [supabase, enabled]);

  const shown = useMemo(() => rows.filter((r) => {
    if (estateF && r.estate_id !== estateF) return false;
    if (statusF !== 'all' && statusOf(r) !== statusF) return false;
    return true;
  }), [rows, statusF, estateF]);

  /*
   * ★ 統計算在**篩選前**的全部資料上（`rows` 不是 `shown`）——
   *   卡片是總覽，不是當前清單的重複。切到「已收回」之後
   *   「錢還在外面」那個數字還在，才看得出比例。
   *   跟暫收那邊同一條規則（那裡的註解寫著「筆數算在 base 上」）。
   */
  const st = useMemo(() => statsOf(rows), [rows]);

  return {
    supabase, rows, shown, st, loading, msg, setMsg,
    statusF, setStatusF, estateF, setEstateF, edit, setEdit, load,
    payAccounts, accountCodes,
  };
}

/* ══════════════════════════════════════════════════════════
 * 上半：總計 ＋ 統計卡（放在分頁籤**之前**）
 * ══════════════════════════════════════════════════════════ */

export function AdvanceStats({ a }: { a: AdvanceState }) {
  const { st, statusF, setStatusF } = a;
  return (
    <div>
      {/*
        ★ 總計回答的是「我們現在有多少錢在別人那裡」——
          跟暫收那句「錢在我們手上」正好相反，所以標籤要講清楚方向。
          只寫「暫付總計」會被讀成「所有暫付加起來」，而它不含已收回的。
      */}
      <StatTotal
        label="暫付款總計"
        value={`NT$ ${fmt(st.paid.amt)}`}
        sub={`${st.paid.n} 筆・錢在別人手上`} />

      <StatGroup label="暫付" tone="slate" />
      <StatRow className="mb-4">
        {([
          /*
           * ★★ 標題讀 `STATUS_LABEL`，不要再手寫一次字串。
           *   2026-09-18 改名（已付款 → 待收回）時，寫死的那一份
           *   會留在原地 —— 於是卡片叫「已付款」、底下那一列叫「待收回」，
           *   而使用者會以為那是兩群不同的資料。
           */
          /*
           * ★★★ 「待收回」那一格印的是**剩餘款**（代墊 − 累計已還），
           *   不是暫付原價。還了 6,000 之後還印 13,209 的話，
           *   那張卡會永遠說欠原價（2026-09-21）。
           * ★ 筆數含「部分收回」—— 那幾列還有錢在外面。
           */
          { k: 'paid'      as const, title: STATUS_LABEL.paid,     s: st.paid,      sub: '剩餘款' },
          { k: 'refunded'  as const, title: STATUS_LABEL.refunded, s: st.refunded,  sub: '累計已還' },
          { k: 'forfeited' as const, title: '被扣',                s: st.forfeited, sub: '已轉支出' },
        ]).map((t) => (
          <StatCard key={t.k}
            label={t.title}
            value={`NT$ ${fmt(t.s.amt)}`}
            sub={`${t.s.n} 筆・${t.sub}`}
            muted={t.s.n === 0}
            /*
             * ★ 「被扣」點下去篩「部分收回」—— 那兩者是同一群列。
             *   分開命名是因為卡片問的是「損失多少」，
             *   而狀態問的是「這一列走到哪了」。
             */
            /*
             * ★★★ 「被扣」點下去篩 `shortfall`（已結清但沒收足），
             *   **不是** `partial` —— 2026-09-21 之後 partial 是「還在攤」，
             *   那幾列一毛都還沒被扣。篩錯的話這張卡會列出一堆
             *   根本沒有損失的列，而數字看起來很正常。
             */
            active={statusF === (t.k === 'forfeited' ? 'shortfall' : t.k)}
            onClick={() => setStatusF(t.k === 'forfeited' ? 'shortfall' : t.k)} />
        ))}
      </StatRow>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
 * 下半：篩選 ＋ 清單 ＋ 新增／編輯（放在分頁籤**之後**）
 * ══════════════════════════════════════════════════════════ */

export function AdvanceList({
  a, estates,
}: {
  a: AdvanceState;
  estates: { id: string; name: string }[];
}) {
  const {
    supabase, rows, shown, loading, msg, setMsg,
    statusF, setStatusF, estateF, setEstateF, edit, setEdit, load,
    payAccounts, accountCodes,
  } = a;

  const estateName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  /* ══════════════════════════════════════════════════════════
   * 批次收回（2026-09-18・migration_274）
   *
   * 愛皮 9/09 那一批是 8 列。一列一列開抽屜填收回日的話要開 8 次，
   * 而那 8 次是**同一筆匯款** —— 中間停下來就會有幾列還躺在待收回，
   * 於是愛皮那一頁的實支變成「還了 5 筆的金額」，
   * 而每一列自己都合法，沒有地方會叫。
   *
   * ★ 所以寫入走 RPC:一個交易，要嘛 8 列全好，要嘛一列都沒動。
   * ══════════════════════════════════════════════════════════ */
  const [picked, setPicked] = useState<Record<string, true>>({});
  const [bOn, setBOn] = useState(todayStr());
  /** 還款金額。★ 字串不是數字 —— 空字串（還沒填）跟 0（填了 0）是兩件事 */
  const [bPay, setBPay] = useState('');
  /** 還入哪個安幸帳戶 */
  const [bIn, setBIn] = useState('');
  /** 從對方哪個帳戶出去 */
  const [bOut, setBOut] = useState('');
  /** 一列都沒勾時要收誰的。勾了的話以勾選為準 */
  const [bParty, setBParty] = useState('');
  /** 沒勾也想還款時,按「代墊還款」把這條 bar 叫出來 */
  const [bOpen, setBOpen] = useState(false);
  /*
   * ★★★ 還款方式（2026-09-21 使用者指定，下拉兩個選項）:
   *
   *     'each'  逐筆還款 —— 勾完要還的那幾列，金額**必須剛好**等於它們的剩餘款
   *     'sum'   金額還款 —— 不用勾，直接填總數，**不得超過**總欠款
   *
   * ★★ 用下拉而不是「有沒有勾」去推，是因為**剛好把全部勾起來**的時候
   *   兩條路長得一模一樣，而規則不同 —— 推出來的那個會是錯的。
   *   （這個布林一路傳到 `validateRepay()` 與 RPC 的 `p_picked`。）
   */
  const [bMode, setBMode] = useState<'each' | 'sum'>('each');
  /*
   * ★★ 批次的錯誤留在批次那一條 bar 裡，不要丟到頁面最上方的 `msg`。
   *   那個面板在畫面上半部，而使用者按的按鈕在清單旁邊 ——
   *   他會看到「按了沒反應」（CLAUDE.md 2026-09-02 踩過的那條）。
   */
  const [bMsg, setBMsg] = useState<string | null>(null);

  /*
   * ★★★ 從 `rows`（全部）撈，不是從 `shown`（篩過的）——
   *   勾完之後切換篩選的話，被篩掉的那幾列還在 `picked` 裡，
   *   而 bar 上的「已選 N 列」必須講真話。
   *   同時換篩選就清空選取（下面那個 effect），兩件事一起才不會出現
   *   「畫面上看不到，但會被收回」的列。
   */
  const pickedRows = useMemo(() => rows.filter((r) => picked[r.id]), [rows, picked]);
  const party = lockedParty(pickedRows);

  useEffect(() => { setPicked({}); setBMsg(null); }, [statusF, estateF]);

  /** 這個篩選底下，跟現在鎖定的對象同一家、而且勾得動的列。算式在 lib，有測試。 */
  const selectable = useMemo(() => batchSelectable(shown, pickedRows) as Row[], [shown, pickedRows]);
  const allPicked = selectable.length > 0 && selectable.every((r) => picked[r.id]);

  function toggleOne(r: Row) {
    setBMsg(null);
    setPicked((prev) => {
      const next = { ...prev };
      if (next[r.id]) delete next[r.id]; else next[r.id] = true;
      return next;
    });
  }
  function toggleAll() {
    setBMsg(null);
    setPicked(allPicked ? {} : Object.fromEntries(selectable.map((r) => [r.id, true as const])));
  }

  /*
   * ══════════════════════════════════════════════════════════
   * 攤還（2026-09-21・migration_286）
   *
   * ★★★ 範圍就是勾選,不另外開一個模式開關（使用者指定）:
   *     勾了列 → 只扣那幾列,而且金額必須**剛好等於**它們的剩餘款
   *     沒勾   → 這個對象全部待收回的,金額不得超過總欠款
   *
   * ★★ 算式與那兩條擋都在 `lib/advance-repay.ts`（有測試）——
   *   這裡只負責把結果畫出來。RPC 裡有同一組規則擋第二次。
   * ══════════════════════════════════════════════════════════ */

  /** 這一頁還收得回來的代墊（照對象分組用） */
  const openLent = useMemo(
    () => rows.filter((r) => r.category === '代墊' && !!r.paid_on && repayOpen(r as RepayRow)),
    [rows]);

  /** 有哪些對象還欠錢。★ 只有一個的時候下拉不出現,直接用它 */
  const parties = useMemo(
    () => Array.from(new Set(openLent.map((r) => r.counterparty ?? ''))).filter(Boolean).sort(),
    [openLent]);

  /** 逐筆還款 ＝ 以勾選為範圍 */
  const byEach = bMode === 'each';

  /* 對象:逐筆時以勾起來的那幾列為準;金額還款用下拉（預設第一個） */
  const rParty = byEach && pickedRows.length
    ? (lockedParty(pickedRows) ?? '')
    : (bParty || parties[0] || '');

  /** 這一次要扣的範圍 */
  const scope = useMemo<Row[]>(
    () => (byEach
      ? pickedRows.filter((r) => repayOpen(r as RepayRow))
      : openLent.filter((r) => (r.counterparty ?? '') === rParty)),
    [byEach, pickedRows, openLent, rParty]);

  const scopeOwed = useMemo(() => owedTotal(scope as RepayRow[]), [scope]);

  /*
   * ★ 勾選變動時把金額填成「剛好還完」——
   *   人就不用自己把那幾列加一遍（而加錯會撞下面那條擋,然後他得自己找哪裡錯）。
   */
  useEffect(() => {
    if (bMode === 'each' && pickedRows.length) {
      setBPay(String(owedTotal(pickedRows as RepayRow[])));
    }
  }, [bMode, pickedRows]);

  /** 這一次每一列扣多少（畫在清單的「這次扣」欄）*/
  const plan = useMemo(
    () => allocate(scope as RepayRow[], Number(bPay) || 0), [scope, bPay]);

  /** 存檔前的擋。★ 回 null 才按得下去 */
  const repayErr = useMemo(() => (byEach && !pickedRows.length
    ? '逐筆還款要先勾起要還的那幾列 —— 不想勾的話改用「金額還款」'
    : validateRepay(scope as RepayRow[], {
      on: bOn, pay: bPay, inAccount: bIn, outAccount: bOut, picked: byEach,
    })), [byEach, pickedRows.length, scope, bOn, bPay, bIn, bOut]);

  /** id → 這次扣多少。被擋住時整個空的 —— 不要畫一個不會發生的預覽 */
  const cutBy = useMemo(() => {
    const m: Record<string, number> = {};
    if (!repayErr) for (const l of plan.lines) if (l.cut > 0) m[l.id] = l.cut;
    return m;
  }, [plan, repayErr]);

  /**
   * 「這次扣」那一欄要不要畫。
   *
   * ★ 只有真的算出東西才畫 —— 平常一欄全是「—」只是噪音，
   *   而且會把右邊的欄位往外推，表格在手機上就開始橫向捲。
   */
  const showCut = Object.keys(cutBy).length > 0;

  /* 還入＝安幸的帳戶;出帳＝對方那一本的帳戶（migration_284 的 book） */
  const inAccts  = useMemo(() => accountsForBook(payAccounts, 'anxing'), [payAccounts]);
  const outAccts = useMemo(
    () => accountsForBook(payAccounts, BOOK_OF[rParty] ?? ''), [payAccounts, rParty]);

  async function recoverInner() {
    setBMsg(null);
    if (repayErr) { setBMsg(repayErr); return; }

    const { error } = await supabase.rpc('repay_advances', {
      p_ids: scope.map((r) => r.id),
      p_on: bOn,
      p_pay: Number(bPay),
      p_in: bIn,
      p_out: bOut,
      p_picked: byEach,
    });
    /*
     * ★★ RPC 裡會比「分配出去的總額 vs 還款金額」，對不上就 raise ——
     *   所以收到 error 就是**真的一列都沒寫進去**（交易回滾），
     *   不會有「成功了一半」這種狀態。
     */
    if (error) { setBMsg('還款失敗：' + error.message); return; }

    const n = plan.lines.filter((l) => l.cut > 0).length;
    setPicked({}); setBPay(''); setBOpen(false);
    setMsg(`${rParty} 還款 ${fmt(Number(bPay))}・扣了 ${n} 列・其中 ${plan.cleared} 列還完`);
    await load();
  }
  const [recover, recovering] = useOnce(recoverInner);

  /*
   * 空狀態那一列要橫跨幾欄。
   * ★ 跟表頭算在同一個地方 —— 寫死 10 的話，2026-09-18 拿掉「實收回」
   *   之後那一列會多跨一欄，而畫面上只是「置中偏了一點」，沒有人會報。
   */
  /*
   * 欄數。★ 少算一欄的話「讀取中⋯」與空狀態那一列的 colSpan 會short，
   *   表格最右邊會缺一格 —— 看起來像壞掉。
   *   9 原本的 ＋ 已還 ＋ 剩餘 ＝ 11，再加勾選欄與「這次扣」。
   */
  const cols = 11 + (selectable.length > 0 ? 1 : 0) + (showCut ? 1 : 0);

  async function saveInner() {
    if (!edit) return;
    // ★★ 先打開紅框再擋 —— 按下去的意思就是「我覺得我填完了」
    setTried(true);
    const err = validateAdvance(edit);
    if (err) { setMsg(err); return; }

    const payload = {
      category: edit.category,
      counterparty: edit.counterparty.trim(),
      usage: edit.usage.trim(),
      /*
       * ★★ 用途是**兩個欄位**（purpose_type ＋ estate_id），一定要一起寫。
       *   分開設會出現 office 卻掛著物業的矛盾列（`ap_purpose_chk` 會擋，
       *   但擋下來的錯誤訊息使用者看不懂）。算式在 lib，有測試。
       */
      ...purposeFromSelect(purposeToSelect(edit.purpose_type, edit.estate_id)),
      amount: Number(edit.amount),
      /*
       * ★ 空字串要轉成 null。日期欄留空時 input 給的是 ''，
       *   而 `''` 寫進 date 欄位會被 PostgREST 當成錯誤 ——
       *   症狀是「按了儲存沒反應」，因為錯誤訊息在 console 裡。
       */
      paid_on: edit.paid_on || null,
      refunded_on: edit.refunded_on || null,
      refunded_amount: edit.refunded_on ? Number(edit.refunded_amount ?? 0) : null,
      /*
       * ★ 收款帳戶只在真的收回時才寫。沒收回卻留著帳戶的話，
       *   `refundAccountWarning` 會拿它跟出款帳戶比而跳出提醒 ——
       *   而那時根本還沒有人決定要收到哪裡。
       */
      refund_account: edit.refunded_on ? (edit.refund_account || null) : null,
      note: edit.note?.trim() || null,
    };

    const q = edit.id
      ? supabase.from('advance_payments').update(payload).eq('id', edit.id).select('id')
      : supabase.from('advance_payments').insert(payload).select('id');
    const { data, error } = await q;
    if (error) { setMsg('存不進去：' + error.message); return; }
    /*
     * ★★ RLS 擋下的 UPDATE 會**回成功而且影響 0 列**（CLAUDE.md 的坑）。
     *   不檢查長度的話，沒有權限的人按儲存會看到「已儲存」而什麼都沒變。
     */
    if (!data || data.length === 0) {
      setMsg('沒有寫入任何資料 —— 可能是權限不足（暫付限會計以上）');
      return;
    }
    setEdit(null);
    setMsg('已儲存');
    await load();
  }
  const [save, saveBusy] = useOnce(saveInner);

  /** 按過儲存了沒 —— 紅框只在他表達「我填完了」之後才出現 */
  const [tried, setTried] = useState(false);
  /*
   * 這一列的「已還」是不是由還款明細算出來的（＝不能在抽屜裡改）。
   *
   * ★★★ 判準是「代墊 ＋ 已還 > 0」，不是「有沒有還款單」——
   *   抽屜這一層沒有明細那份資料，而資料庫那邊
   *   `trg_ap_guard_refunded` 才是真正擋的人。這裡只負責**先講**，
   *   不要讓人打完一個數字才被一句約束錯誤擋回來。
   * ★ 押金／保證金沒有還款明細，照舊自己填。
   */
  const lockedGot = !!edit && edit.category === '代墊' && Number(edit.refunded_amount ?? 0) > 0;
  /** 缺哪幾欄。紅框、送出鈕提示、擋下來的訊息用同一份答案 */
  const advMissing = edit ? advanceMissing(edit) : [];
  /** 這一格要不要畫紅框 */
  const aErr = (f: string) => tried && advMissing.includes(f);
  /**
   * 送出鈕的樣子。★★★ 灰掉但**按得下去** —— 真的 disabled 的話
   * `tried` 打不開、紅框永遠不出現（見 lib/required.ts 的 submitGate）。
   */
  const gate = submitGate(advMissing, saveBusy);

  async function delOne(r: Row) {
    if (!confirm(`刪除「${r.counterparty}・${r.usage}」的 ${fmt(r.amount)}？`)) return;
    const { data, error } = await supabase.from('advance_payments')
      .delete().eq('id', r.id).select('id');
    if (error) { setMsg('刪不掉：' + error.message); return; }
    if (!data || data.length === 0) { setMsg('沒有刪掉任何資料 —— 可能是權限不足'); return; }
    await load();
  }

  return (
    <div>
      {msg && (
        <div className="mb-3 rounded-lg border border-mor-line bg-white px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} className="text-xs text-gray-400 underline">關閉</button>
        </div>
      )}

      <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={CTRL}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} className={CTRL}>
            <option value="all">全部</option>
            {/* ★ 五個狀態都要在。漏掉的那個就再也篩不到,而畫面不會說為什麼 */}
            {(['draft', 'paid', 'partial', 'refunded', 'shortfall'] as const).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select></label>
        <div className="ml-auto flex items-center gap-2">
          {/*
            ★★ 沒有代墊可還的時候整顆不出現 —— 灰掉一顆按鈕而不解釋，
              使用者會以為系統壞了而一直點（anxing-ui）。
          */}
          {openLent.length > 0 && (
            <button onClick={() => { setBOpen(true); setBMsg(null); }}
              className="h-11 md:h-9 rounded-lg border border-mor-greendark bg-white text-mor-greendark
                         px-3 text-ui font-medium hover:bg-mor-greenlight">
              代墊還款
            </button>
          )}
          <button onClick={() => setEdit(blank())}
            className="h-11 md:h-9 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium hover:bg-mor-slatedark">
            + 新增暫付
          </button>
        </div>
      </div>

      {/*
        ══════════ 代墊還款（2026-09-18 批次收回 → 2026-09-21 改成攤還）══════════
        ★ 一列都沒勾就整條不出現 —— 沒有東西可做的時候不要佔版面。
      */}
      {(pickedRows.length > 0 || bOpen) && openLent.length > 0 && (
        <div className={`mb-3 rounded-xl border px-3 py-2.5 ${
          repayErr && bPay ? 'border-red-400 bg-red-50' : 'border-mor-slate bg-mor-bluelight'}`}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-sm font-medium">
              {byEach
                ? `已選 ${scope.length} 列`
                : `${rParty} 全部待收回 ${scope.length} 列`}
              　剩餘 NT$ {fmt(scopeOwed)}
            </div>
            {/*
              ★★★ 還款方式（2026-09-21 使用者指定）。
                兩條路的規則不一樣,所以要明講,不要用「有沒有勾」去猜 ——
                剛好把全部勾起來時,兩條路長得一模一樣而答案不同。
            */}
            <label className="flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-600">還款方式<Req /></span>
              <select value={bMode}
                onChange={(e) => {
                  setBMode(e.target.value as 'each' | 'sum');
                  setBPay(''); setBMsg(null);
                }}
                className={CTRL}>
                <option value="each">逐筆還款（勾哪幾列，就剛好還完那幾列）</option>
                <option value="sum">金額還款（填總數，從最舊的一筆開始扣）</option>
              </select></label>
            {/* ★ 對象只有一個時不畫下拉 —— 一個選項的下拉是噪音 */}
            {!byEach && parties.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-600">對象</span>
                <select value={rParty} onChange={(e) => { setBParty(e.target.value); setBOut(''); }}
                  className={CTRL}>
                  {parties.map((n) => <option key={n} value={n}>{n}</option>)}
                </select></label>
            )}
            <label className="flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-600">還款日<Req /></span>
              <input type="date" value={bOn} onChange={(e) => { setBOn(e.target.value); setBMsg(null); }}
                className={CTRL} /></label>
            <label className="flex flex-col gap-1">
              {/*
                ★★ 勾了的時候把「要剛好多少」寫在標籤上 ——
                  只說「配不上」的話，人得自己把那幾列加一遍才知道差多少。
              */}
              <span className="flex items-center text-xs text-gray-600">
                還款金額{byEach
                  ? `（要剛好 ${fmt(scopeOwed)}）`
                  : `（最多 ${fmt(scopeOwed)}）`}<Req /></span>
              <input type="number" inputMode="decimal" value={bPay} min="0"
                onChange={(e) => { setBPay(e.target.value); setBMsg(null); }}
                className={`${CTRL} w-36 text-right tabular-nums ${
                  bPay && repayErr ? 'border-red-400 bg-red-50' : ''}`} /></label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-600">還入帳號（安幸）<Req /></span>
              <select value={bIn} onChange={(e) => setBIn(e.target.value)} className={CTRL}>
                <option value="">請選擇</option>
                {inAccts.map((p) => <option key={p.code} value={p.code}>{p.code} {p.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-600">出帳帳號（{rParty}）<Req /></span>
              <select value={bOut} onChange={(e) => setBOut(e.target.value)} className={CTRL}>
                <option value="">請選擇</option>
                {outAccts.map((p) => <option key={p.code} value={p.code}>{p.code} {p.name}</option>)}
              </select></label>
            {/*
              ★★ 灰掉的按鈕要說得出為什麼（anxing-ui）——
                一顆灰掉而不解釋的按鈕，使用者會以為是系統壞了而一直點。
            */}
            <button onClick={recover} disabled={recovering || !!repayErr}
              title={repayErr ?? ''}
              className="h-11 md:h-9 rounded-lg bg-mor-greendark text-white px-4 text-ui font-medium
                         hover:opacity-90 disabled:opacity-50">
              {recovering ? '還款中⋯' : `確認還款${!repayErr && bPay ? ' ' + fmt(Number(bPay)) : ''}`}
            </button>
            <button onClick={() => { setPicked({}); setBMsg(null); setBOpen(false); setBPay(''); }}
              className="h-11 md:h-9 rounded-lg border border-mor-line bg-white px-3 text-ui">取消</button>
          </div>
          {/*
            ★★ 錯誤留在這條 bar 裡 —— 丟到頁面最上方的話，
              在清單旁邊按鈕的人看不到，結論會是「按鈕壞了」。
            ★ 金額還沒填之前不要先罵人:一打開就整片紅那不是提示是指責。
          */}
          {(bMsg || (bPay && repayErr)) && (
            <div className="mt-2 text-sm text-red-600">{bMsg ?? repayErr}</div>
          )}
          {/* ★ 一句話講完,寫給不知道前因後果的人看（CLAUDE.md） */}
          <div className="mt-1.5 text-xs text-gray-500">
            {byEach
              ? '勾起來的那幾列要剛好還完，金額對不上會擋 —— 想留零頭就改用「金額還款」。'
              : '從最舊的一筆開始扣，扣完才輪到下一筆。清單的「這次扣」會先畫出來。'}
          </div>
        </div>
      )}

      <div className="rounded-xl glass overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
              {/*
                ══════════ 欄序跟支出頁一致（2026-09-03 使用者指定）══════════

                支出頁是「支出日 → 項目 → 金額 → 會計科目 → 用途」，
                這裡是「出款日 → 項目 → 金額 → 類別 → 用途」——
                前五欄同一個閱讀順序。

                ★ 改版前是「對象」開頭，兩張表切過去要重新找一次欄位。
                ★★ 「對象」往後移，不是拿掉 —— 它是暫付才有的
                  （錢放在誰那裡），支出頁沒有對應欄。
              */}
              {/*
                ★ 勾選欄。整欄只在「有東西勾得動」時出現 —— 全部都是押金
                  或全部已收回的話，畫一排永遠灰掉的框只是噪音。
              */}
              {selectable.length > 0 && (
                <th className="px-3 py-2.5 w-10 text-center">
                  <input type="checkbox" checked={allPicked} onChange={toggleAll}
                    aria-label="全選" className="align-middle" />
                </th>
              )}
              <th className="px-3 py-2.5">出款日</th>
              <th className="px-3 py-2.5">項目</th>
              <th className="px-3 py-2.5 text-right">金額</th>
              {/*
                ══════════ 已還／剩餘（2026-09-21 使用者：「也要能看出剩餘款」）══════════
                ★ 剩餘 ＝ 金額 − 已還，**算出來的**不存欄位。
                ★★ 「這次扣」只在還款那條 bar 有算出東西時才出現 ——
                  平常那一欄整個不畫，不要讓人看著一欄永遠是「—」。
              */}
              <th className="px-3 py-2.5 text-right">已還</th>
              <th className="px-3 py-2.5 text-right">剩餘</th>
              {showCut && <th className="px-3 py-2.5 text-right text-mor-slate">這次扣</th>}
              <th className="px-3 py-2.5">類別</th>
              <th className="px-3 py-2.5">用途</th>
              <th className="px-3 py-2.5">對象</th>
              {/*
                ══════════ 2026-09-18:「實收回」整欄拿掉 ══════════

                使用者圈起這兩欄問「收回 實收回日 是甚麼，只有一個吧」——
                他讀成了兩個日期，而那是我把名字取成兄弟的錯
                （一個是日期、一個是金額）。

                ★★★ 而且他說得對:收回一律全額（2026-09-18 選「讓人挑哪幾筆」），
                  所以「實收回」永遠等於左邊的「金額」——
                  **同一個數字寫第二次**。短收的時候才在金額底下多一行紅字。

                ══════════ 2026-09-21：「已還」欄回來了，意思不一樣 ══════════

                ★★★ 上面那段的前提是「收回一律全額」。攤還之後不再成立 ——
                  一列可以還一半，所以「已還」跟「金額」是兩個數字了。
                ★ 這一欄現在是**結清日**（有值＝這列結束了，不再追），
                  不是「收回日」。跟抽屜裡那一格同一個名字。
              */}
              <th className="px-3 py-2.5">結清日</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={cols} className="px-3 py-6 text-center text-gray-400">讀取中⋯</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={cols} className="px-3 py-6 text-center text-gray-400">
                {rows.length === 0
                  ? '還沒有暫付。請款單填完在下方勾「這是暫支款」，確認出款後會出現在這裡。'
                  : '這個篩選沒有資料'}
              </td></tr>
            )}
            {!loading && shown.map((r) => {
              const s = statusOf(r);
              const lost = forfeitedOf(r);
              return (
                <tr key={r.id} className={`border-b border-mor-line/40 last:border-0 ${
                  picked[r.id] ? 'bg-mor-bluelight/50' : ''}`}>
                  {selectable.length > 0 && (
                    <td className="px-3 py-2.5 text-center">
                      {/*
                        ★★ 勾不動的列畫一個灰掉的框（不是空白）——
                          空白的話使用者會以為那一列漏畫了，
                          而 title 說得出為什麼勾不動。
                      */}
                      <input type="checkbox" checked={!!picked[r.id]}
                        disabled={batchDisabled(r, pickedRows)}
                        onChange={() => toggleOne(r)}
                        title={
                          !canBatch(r)
                            ? (r.category === '代墊' ? '這一列已經收回過了' : '批次收回只處理代墊')
                            : batchDisabled(r, pickedRows)
                              ? `已經選了${party}的，一次只能收同一個對象`
                              : ''
                        }
                        className="align-middle disabled:opacity-30" />
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{r.paid_on ?? '—'}</td>
                  {/* ★ 物業不再擠在項目後面當灰字 —— 它有自己的「用途」欄了 */}
                  <td className="px-3 py-2.5">{r.usage}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {fmt(r.amount)}
                    {/*
                      ★★★ 差額搬到金額底下（2026-09-18）。原本它掛在「實收回」欄，
                        而那一欄整個拿掉了 —— 沒搬的話這一行字會跟著消失，
                        於是一筆收不回來的錢在畫面上**完全看不出來**。
                      ★ 只有差額 > 0 才出現。全額收回的列什麼都不多。
                    */}
                    {/*
                      ★★★ 只有**已結清而且沒收足**才印這一行紅字。
                        還在攤的差額是應收不是被扣（`forfeitedOf` 已經回 0），
                        印成紅的話畫面會說一筆會回來的錢損失了。
                    */}
                    {lost > 0 && (
                      <div className="text-xs text-red-500">被扣 {fmt(lost)}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                    {Number(r.refunded_amount ?? 0) > 0 ? fmt(r.refunded_amount ?? 0) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                    {remainingOf(r) > 0 ? fmt(remainingOf(r)) : '—'}
                  </td>
                  {showCut && (
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-mor-slate">
                      {cutBy[r.id] ? fmt(cutBy[r.id]) : '—'}
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${CAT_CLASS[r.category] ?? ''}`}>
                      {r.category}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                    {purposeLabel(r.purpose_type, r.estate_id, (id) => estateName[id])}
                  </td>
                  <td className="px-3 py-2.5">{r.counterparty}</td>
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{r.refunded_on ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[s]}`}>
                      {STATUS_LABEL[s]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => setEdit(r)} className="text-xs text-mor-blue underline">改</button>
                    <button onClick={() => delOne(r)} className="ml-2 text-xs text-red-500 underline">刪</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {/*
            ══════════ 合計（2026-09-21：「也要能看出剩餘款」）══════════
            ★★ 算在 `shown`（篩過的）上,不是 `rows` —— 表格底下的合計
              要跟上面看得到的那幾列對得起來。總覽是上面那三張卡的事。
            ★ 一列都沒有時整個 tfoot 不畫,不要印一排 0。
          */}
          {!loading && shown.length > 0 && (
            <tfoot>
              <tr className="border-t border-mor-line bg-white/45 font-medium">
                {selectable.length > 0 && <td />}
                <td className="px-3 py-2.5" colSpan={2}>合計（{shown.length} 列）</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {fmt(shown.reduce((n, r) => n + (Number(r.amount) || 0), 0))}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                  {fmt(shown.reduce((n, r) => n + (Number(r.refunded_amount) || 0), 0))}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {fmt(shown.reduce((n, r) => n + remainingOf(r), 0))}
                </td>
                {showCut && (
                  <td className="px-3 py-2.5 text-right tabular-nums text-mor-slate">
                    {fmt(shown.reduce((n, r) => n + (cutBy[r.id] ?? 0), 0))}
                  </td>
                )}
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {edit && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => setEdit(null)}>
          <div className="bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-lg max-h-[90vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-ui font-medium mb-3">{edit.id ? '編輯暫付' : '新增暫付'}</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/*
                ══════════ 項目排第一（2026-09-03 使用者指定）══════════

                ★ 這是「這筆錢在做什麼」—— 填表的人腦中第一個念頭，
                  而且是之後**唯一認得出這筆是什麼**的欄位。
                  類別（押金/保證金/零用金）是分類，分類要先有東西才分得了。

                ★★ 跟支出頁一致:那邊也是「項目」在最上面。
              */}
              <label className="flex flex-col gap-1 sm:col-span-2"><ReqLabel>項目</ReqLabel>
                {/*
                    ★★ 紅框只在按過儲存之後才出現 —— 空表單一打開就整片紅
                      那不是提示是指責（見 components/Req.tsx）。
                */}
                <input value={edit.usage} autoFocus
                  onChange={(e) => setEdit({ ...edit, usage: e.target.value })}
                  placeholder="辦公室租賃／零用金撥補／114 年清潔標案"
                  className={`${CTRL} ${aErr('項目') ? 'border-red-400 bg-red-50' : ''}`} /></label>

              <label className="flex flex-col gap-1"><ReqLabel>類別</ReqLabel>
                <select value={edit.category}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value as Advance['category'] })}
                  className={`${CTRL} ${aErr('類別') ? 'border-red-400 bg-red-50' : ''}`}>
                  {/*
                    ★★★ 「代墊」不在可選清單裡 —— 它只由請款單的觸發器產生。
                      手動建一筆代墊的話，那筆錢對不到任何一張請款單、
                      `advance_id` 是空的，沖銷時找不到要沖哪一筆支出。

                    ★★ **但已經是代墊的那一列要把它顯示出來**。
                      少了這個 option，`<select>` 會顯示成**空白** ——
                      使用者隨手選一個，那一列就從代墊變成押金，
                      而**存檔成功，沒有任何東西會叫**。
                  */}
                  {MANUAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  {edit.category === '代墊' && (
                    <option value="代墊">代墊（請款單產生，不要改）</option>
                  )}
                </select></label>

              <label className="flex flex-col gap-1"><ReqLabel>對象（錢付給誰）</ReqLabel>
                <input value={edit.counterparty}
                  onChange={(e) => setEdit({ ...edit, counterparty: e.target.value })}
                  placeholder="王大明／台北市政府"
                  className={`${CTRL} ${aErr('對象') ? 'border-red-400 bg-red-50' : ''}`} /></label>

              {/*
                用途（migration_212）。★ 安幸辦公室**不是物業** ——
                `estates` 裡沒有它，所以用 purpose_type 分辨，跟支出頁同一套。
              */}
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">用途（選填）</span>
                <select value={purposeToSelect(edit.purpose_type, edit.estate_id)}
                  onChange={(e) => setEdit({ ...edit, ...purposeFromSelect(e.target.value) })}
                  className={CTRL}>
                  <option value="">—</option>
                  <option value={PURPOSE_OFFICE}>{OFFICE_LABEL}</option>
                  {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select></label>

              <label className="flex flex-col gap-1"><ReqLabel>暫付款</ReqLabel>
                <MoneyInput value={edit.amount} onChange={(n) => setEdit({ ...edit, amount: n })}
                  className={`${CTRL} text-right ${
                    aErr('暫付款') ? 'border-red-400 bg-red-50' : ''}`} /></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">出款日</span>
                <input type="date" value={edit.paid_on ?? ''}
                  onChange={(e) => setEdit({ ...edit, paid_on: e.target.value })}
                  className={CTRL} /></label>

              <div className="sm:col-span-2 border-t border-mor-line pt-3 mt-1">
                {/*
                  ══════════ 結清（2026-09-21・migration_286）══════════

                  ★★★ 這一段的意思變了。以前是「收回」，現在是「**結清**」——
                    填了結清日就代表**這一列結束了，不再追**。

                  ★★ 有還款明細的代墊（已經按過「代墊還款」的），
                    「已還」是**算出來的**（明細加總），不能在這裡改 ——
                    資料庫的 `trg_ap_guard_refunded` 會擋。所以那一格鎖起來，
                    而且底下講一句為什麼。押金與保證金沒有明細，照舊自己填。

                  ★ 還在攤、還想繼續收的列**不要填這裡** —— 填了就結清了，
                    剩下沒收到的會變成安幸的費用。
                */}
                <div className="text-xs text-gray-500 mb-2">
                  結清（還要繼續收就留空）
                  {lockedGot && <span className="ml-1 text-gray-400">・已還由還款明細算出來</span>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">結清日</span>
                    <input type="date" value={edit.refunded_on ?? ''}
                      onChange={(e) => setEdit({
                        ...edit,
                        refunded_on: e.target.value || null,
                        /*
                         * ★★ 一填收回日就把**原出款帳戶**帶進來
                         *   （2026-09-02 使用者:「暫支要回到原支出帳戶」）。
                         *   已經選過的不覆蓋 —— 使用者改成別的之後，
                         *   改一次日期就被打回去是最惱人的那種 bug。
                         */
                        refund_account: edit.refund_account
                          || (e.target.value ? defaultRefundAccount(edit) : null),
                      })}
                      className={CTRL} /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">已還</span>
                    <MoneyInput value={Number(edit.refunded_amount ?? 0)}
                      onChange={(n) => setEdit({ ...edit, refunded_amount: n })}
                      disabled={lockedGot || !edit.refunded_on}
                      className={`${CTRL} text-right ${
                        lockedGot || !edit.refunded_on ? 'bg-gray-100 text-gray-400' : ''}`} /></label>
                </div>
                {/*
                  ★★ 灰掉的欄位要說得出為什麼 —— 一格灰掉而不解釋，
                    使用者會以為是系統壞了（anxing-ui）。
                */}
                {lockedGot && (
                  <div className="mt-1.5 text-xs text-gray-500">
                    這一列有還款明細，已還 {fmt(Number(edit.refunded_amount ?? 0))} 是加總出來的 ——
                    要改金額請改那張還款單。
                  </div>
                )}
                {/* ★ 還欠多少要看得到,不然「該不該結清」沒有依據 */}
                {!edit.refunded_on && Number(edit.refunded_amount ?? 0) > 0 && (
                  <div className="mt-1.5 text-xs text-amber-700">
                    還欠 {fmt(remainingOf(edit))} —— 填結清日就是**不再追**，
                    那筆差額會轉成一筆支出。
                  </div>
                )}
                {/*
                  ★★ 這一句要在**填的當下**看得到，不是存檔被擋才說。
                    全額被扣填 0 是合法的，而沒有這句話的人會以為要留空 ——
                    留空的話那筆押金會永遠躺在「錢還在外面」的清單裡。
                */}
                {/*
                  收款帳戶。★★ 預設是**原出款帳戶**（2026-09-02 使用者指定）。
                    可以改，但改了會在底下講一句 —— 錢確實有可能回到別的帳戶
                    （換帳戶、對方匯錯），硬鎖住的話那筆錢就記不進系統。
                    系統負責看見，人負責決定。
                */}
                {edit.refunded_on && (
                  <label className="flex flex-col gap-1 mt-3">
                    <span className="text-xs text-gray-500">收款帳戶</span>
                    <select value={edit.refund_account ?? ''}
                      onChange={(e) => setEdit({ ...edit, refund_account: e.target.value || null })}
                      className={CTRL}>
                      <option value="">（未選）</option>
                      {payAccounts.map((p) => (
                        <option key={p.code} value={p.code}>{p.code} {p.name}</option>
                      ))}
                    </select>
                    {refundAccountWarning(edit) && (
                      <span className="text-xs text-amber-700">{refundAccountWarning(edit)}</span>
                    )}
                  </label>
                )}
                <div className="text-xs text-gray-400 mt-2 leading-relaxed">
                  全額被扣就填 <b>0</b>，不要留空 —— 留空代表「還沒收回」，那一筆會一直等一個不會來的退款。
                  {Number(edit.refunded_amount ?? 0) < Number(edit.amount) && edit.refunded_on && (
                    <div className="text-red-500 mt-1">
                      差額 {fmt(Number(edit.amount) - Number(edit.refunded_amount ?? 0))} 會轉成一筆支出。
                    </div>
                  )}
                </div>
                {/*
                  ★★★ 被扣的差額要選會計科目（2026-09-02 使用者:「可選會計科目」）。

                    不強制的話那筆支出會落進空科目 —— 而三個月後看到一筆
                    2,000 的支出，沒有人查得出它是哪一筆押金被扣的。
                    `validateRefund` 也擋，這裡只是先讓他看到要填什麼。

                  ★ 只在**這一次要產生**時出現。已經產生過的（forfeit_expense_id
                    有值）不再問 —— 那筆支出早就存在，科目在它自己身上。
                */}
                {needsForfeitExpense(edit) && (
                  <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
                    <div className="text-sm text-amber-900">
                      沒收回的 <b>{fmt(forfeitedOf(edit))}</b> 要記成一筆支出
                    </div>
                    <label className="flex flex-col gap-1 mt-2">
                      <span className="text-xs text-amber-800">會計科目</span>
                      <select value={edit.forfeit_account_code ?? ''}
                        onChange={(e) => setEdit({ ...edit, forfeit_account_code: e.target.value || null })}
                        className={CTRL}>
                        <option value="">（請選）</option>
                        {accountCodes.map((c) => (
                          <option key={c.code} value={c.code}>{c.code} {c.name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="text-xs text-amber-800 mt-2">
                      科目沒選就不給存 —— 落在空科目的錢三個月後沒有人查得出是什麼
                    </div>
                  </div>
                )}
              </div>

              <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-xs text-gray-500">備註</span>
                <input value={edit.note ?? ''}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })} className={CTRL} /></label>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEdit(null)}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
{/* ★ aria-disabled 不是 disabled —— 點得下去，點下去把紅框亮起來 */}
                            <button onClick={save} aria-disabled={gate.blocked} title={gate.title}
                className={`rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark  ${gateCls(gate.dim)}`}>
                {saveBusy ? '儲存中⋯' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
