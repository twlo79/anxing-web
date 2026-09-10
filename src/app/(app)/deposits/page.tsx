'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddButton, ExportButton, ActionBar } from '@/components/Actions';
import Req from '@/components/Req';
import MoneyInput from '@/components/MoneyInput';
import { missingFields, missingMessage, submitGate, gateCls } from '@/lib/required';
import Toast from '@/components/Toast';
import FilterToggle from '@/components/FilterToggle';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import { titleCaseName } from '@/lib/name-format';
import { manualDepositError, manualDepositMissingAll } from '@/lib/manual-deposit';
import { totalBuckets } from '@/lib/deposit-summary';
import StatCard, { StatRow, StatTotal, StatGroup } from '@/components/StatCard';
import { useAdvance, AdvanceStats, AdvanceList } from './advance-tab';
import { exitBlockedReason, forfeitOrder, earnestStatus, convertPlan, type EarnestDep } from '@/lib/earnest';
import { useProfile } from '@/lib/profile';
// 收款只有會計與總管理員（2026-09-02）—— 規則寫在 lib，三頁共用同一支
import { canCollect, collectDeniedMsg } from '@/lib/collect-perm';
import { fetchAll } from '@/lib/fetch-all';
import Receipts from '@/components/Receipts';
import RefundFields, { METHOD_LABEL, METHOD_OPTS } from '@/components/RefundFields';
import {
  depLines, primaryText, extraLines, summaryText, hasDetail, sumByCurrency,
  lineText, lineKey, type DepLine,
} from '@/lib/deposit-lines';
import {
  canBeSource, canBeTarget, canTransfer, transferCandidates, transferTargets,
  transferChip, roleCanTransfer, depName, isTransfer, depBadges, DEP_BADGE_LABEL, type TransferDep,
} from '@/lib/deposit-transfer';
import DepositPayments from '@/components/DepositPayments';
// 加費從押金扣（migration_157）—— 應退小計由它算，送審送的是小計不是押金原額
import DepositFees from '@/components/DepositFees';
// 排匯款／確認退款日 —— 請款審核頁用同一支，兩邊的規則不會漂走
import DepositRefundStep, { type StepMode } from '@/components/DepositRefundStep';
import { cancelPatch } from '@/lib/deposit-refund';
import { depPayStatus, remainingDep, DEP_STATUS_LABEL, DEP_STATUS_CLASS } from '@/lib/deposit-payment';
import { shareDeposit } from '@/lib/share';
import { softDelete } from '@/lib/trash';
import TrashLink from '@/components/TrashLink';
import RangeInput from '@/components/RangeInput';
import { Tabs } from '@/components/Tabs';
import { FilterSearch } from '@/lib/filters';

/**
 * 暫收付管理（原「押金管理」→ 2026-08-24「暫收管理」→ 2026-09-01 加上暫付，migration_196）。
 *
 * 含**兩種**暫收，靠 `deposits.kind` 分：
 *
 *   deposit  押金 —— 收了要退，退款走兩票審核
 *   earnest  訂金 —— 收了之後三選一：**沒收 / 退款 / 轉押金**
 *
 * 兩者生命週期一樣，所以共用這一頁與同一套退款流程。
 *
 * 金額不在這裡改 —— 那是契約條件的一部分,來源在 orders / contracts,
 * 由觸發器同步過來(migration_56 押金、migration_176 訂金)。
 * 這一頁只管「錢什麼時候收、什麼時候退、走哪個帳戶」。
 *
 * 暫收 = 有 received_on 且沒有 returned_on。
 */

type Dep = {
  id: string;
  /**
   * 押金 / 訂金（migration_174）。
   *
   * ★ 可選 —— 這一頁的 select 是 `*`，所以跑過 migration 就會有值。
   *   但型別寫成必填的話，任何一個舊的 mock 或測試資料都會編譯不過，
   *   而那個錯誤跟這次的改動一點關係都沒有。
   */
  kind?: 'deposit' | 'earnest' | null;
  /** 訂金才有的兩種出路（migration_174） */
  forfeited_on?: string | null;
  /** 沒收產生的那筆收入。★ 冪等靠它 —— 有值就不再產生第二筆 */
  forfeit_order_id?: string | null;
  converted_to_deposit_id?: string | null;
  order_id: string | null; contract_id: string | null;
  estate_id: string | null; property_id: string | null;
  room: string | null; guest_name: string | null;
  currency: string; amount: number;
  /**
   * 幣別明細（migration_87）。多幣別是一起收、一起退的,所以一筆押金一列。
   * amount 只有台幣那部分 —— 要看全部幣別一律走 lib/deposit-lines。
   */
  lines?: DepLine[] | null;
  received_on: string | null; received_method: string | null; received_account: string | null;
  /**
   * 實收合計，由 deposit_payments 的觸發器維護（migration_147）。
   *
   * ★ 大於 0 而小於 amount = **部分收款**。舊模型記不下這個狀態,
   *   所以「收了一半」跟「一毛沒收」以前在畫面上長得一模一樣。
   */
  received_amount?: number | null;
  /**
   * 送審當下的應退金額 = 押金 − 加費合計（migration_157）。
   *
   * ★ null = 還沒送審 → 視為全額。回填成 amount 的話，
   *   「沒送過審」跟「核可全額」就分不出來了。
   */
  refund_amount?: number | null;
  returned_on: string | null; returned_method: string | null; returned_account: string | null;
  note: string | null; orphaned: boolean; is_manual?: boolean; created_at: string;
  // 退款審核流程（migration_61）
  refund_status?: 'none' | 'pending' | 'approved' | 'rejected';
  payee_bank_code?: string | null; payee_name?: string | null; payee_account?: string | null;
  planned_refund_on?: string | null;
  manager_approved_at?: string | null; admin_approved_at?: string | null;
  /** 送審退款的人。分享訊息與請款頁的「請款者」欄位都用這一個。 */
  refund_requested_by?: string | null;
  reject_reason?: string | null;
  /*
   * 押金移房（migration_146）。A 房收過的押金轉到 B 房的新訂單。
   *
   * ★ 有值就代表這一筆的 received_on / returned_on **不是真的收付** ——
   *   錢從頭到尾沒有離開公司,只是換了名目。
   *   押金收退報表要靠這兩欄把移轉排除,不然那個月會憑空多一收一退。
   */
  transfer_to_id?: string | null;
  transfer_from_id?: string | null;
  transferred_by?: string | null;
  transferred_at?: string | null;
};
type Estate = { id: string; name: string };
type PayAccount = { code: string; name: string; method: string };

// METHOD_LABEL / METHOD_OPTS 的定義搬到 @/components/RefundFields —— 只留一份

/**
 * 押金狀態。all 是「不分類」,pending/held/returned 三類互斥。
 *
 * orphan 與兩個 refund_* 都是**跨類別**的:一筆退款審核中的押金,
 * 錢還在我們手上,所以它同時也是 held。它們是「這筆押金現在卡在什麼事情上」,
 * 不是「錢在誰手上」,兩個問題不同,不能塞進同一組互斥分類。
 */
type Status = 'all' | 'pending' | 'held' | 'returned' | 'orphan' | 'refund_pending' | 'refund_approved';
const STATUS_LABEL: Record<Status, string> = {
  /*
   * ★ 用詞跟卡片對齊（2026-08-25）。這個下拉**跨兩種暫收**，
   *   所以不能寫「未付訂金」也不能寫「未付押金」——
   *   用不帶種類的說法，句型維持一致（未付／已收／已結案）。
   *
   *   舊的「已收款(暫收中)」括號裡那三個字是舊名字的殘留，
   *   現在整頁都叫暫收付管理了，寫在這裡反而像另一種狀態。
   */
  all: '全部', pending: '未付款', held: '已收款', returned: '已結案', orphan: '孤兒',
  refund_pending: '退款審核中', refund_approved: '已核可待匯款',
};

const fmt = (n: number | null) => (n == null ? '0' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

const COLS: SortCols<Dep> = {
  room: { type: 'text', get: (d) => d.room },
  guest_name: { type: 'text', get: (d) => d.guest_name },
  amount: { type: 'number', get: (d) => d.amount },
  received_on: { type: 'date', get: (d) => d.received_on },
  returned_on: { type: 'date', get: (d) => d.returned_on },
};

export default function DepositsPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Dep[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // 篩選
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [estateF, setEstateF] = useState('');
  const [roomF, setRoomF] = useState('');
  const [methodF, setMethodF] = useState('');
  const [acctF, setAcctF] = useState('');
  // 分頁籤:一筆押金一定屬於其中一類,不會同時出現在兩個頁籤
  const [statusF, setStatusF] = useState<Status>('held');
  /*
   * 訂金 / 押金（migration_174）。
   *
   * ★ 預設 'all' —— 大部分時候使用者要看的是「錢在我們手上的所有東西」，
   *   而不是先決定看哪一種。押金 101 筆、訂金剛開始只有幾筆，
   *   預設分開的話訂金那一頁會長期是空的。
   */
  /*
   * ★ 多一個 'advance'（暫付，migration_196）。它跟另外三個**不是同一種東西**:
   *   前三個篩的是 `deposits` 這張表的 kind，暫付篩的是另一張表。
   *   所以每一處用到 kindF 的地方都要先確認「不是暫付」——
   *   混在一起的話，切到暫付會拿暫收的資料去比對，而結果是空清單，不是錯誤。
   */
  const [kindF, setKindF] = useState<'all' | 'deposit' | 'earnest' | 'advance'>('all');
  /*
   * 暫付的資料。★ 卡片與清單**共用同一份** ——
   *   兩邊各抓一次的話數字會有一瞬間對不上，
   *   而且新增一筆之後只有其中一邊會更新。
   *
   * ★★ 只有在暫付分頁時才真的去查（`enabled`）——
   *   使用者九成的時間待在暫收那三頁，不該每次進來都多一次查詢。
   */
  const adv = useAdvance(kindF === 'advance');
  /*
   * 目前這個頁籤在講哪一種錢。**只用在句子裡**，表頭不用。
   *
   * ============================================================
   * 【表頭固定叫「暫收款／收款日／退款日」】（2026-08-24 使用者指定）
   *
   * 我第一版讓表頭跟著頁籤換（訂金→「訂金／收訂金日」）。
   * 使用者的決定更好:**欄名跟著切換會跳動**，
   * 而人在掃一份清單時是靠「第四欄是金額」這種位置記憶在讀的 ——
   * 名稱一直變，每次切頁籤都要重新對一次欄位。
   *
   * 而且「暫收款」對兩種都成立，不會說謊。
   * 要知道這一列是訂金還是押金，看房源旁邊那個徽章。
   *
   * ★ 句子裡還是要用具體的詞:「這一類目前沒有**訂金**紀錄」
   *   比「沒有暫收紀錄」精確 —— 那句話是在描述你現在的篩選。
   */
  const kindWord = kindF === 'earnest' ? '訂金' : kindF === 'deposit' ? '押金' : kindF === 'advance' ? '暫付' : '暫收';
  /**
   * 從訂單／契約跳過來時只顯示那一筆的押金。
   *
   * 一張訂單可能有好幾筆押金（台幣一筆、每種外幣各一筆），所以帶的是
   * 母體的 id 而不是押金 id —— 帶押金 id 只會看到其中一種幣別，
   * 而使用者按的是「看這張訂單的押金」。
   */
  const [focus, setFocus] = useState<{ kind: 'order' | 'contract'; id: string } | null>(null);
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');

  const [sort, setSort] = useState<SortState>({ key: 'received_on', dir: 'desc' });
  const [detail, setDetail] = useState<Dep | null>(null);
  const [edit, setEdit] = useState<Dep | null>(null);
  /**
   * 正在移轉哪一筆。null = 沒有在移轉。
   *
   * `side` 是「使用者點進去的那一筆扮演什麼角色」：
   *   'to'   他站在目的（B，尚未收）→ 清單列出可以當來源的
   *   'from' 他站在來源（A，暫收中）→ 清單列出可以移過去的
   *
   * ★ 兩個方向都要有。原本只放目的那一邊，實際操作時人手上先有的是
   *   **要移走的那筆押金**，點進去卻什麼按鈕都沒有（2026-08-19）。
   */
  const [moving, setMoving] = useState<{ dep: Dep; side: 'to' | 'from' } | null>(null);
  /** 開著收押金視窗的那一筆。收款明細在那裡增刪（migration_147）。 */
  const [paying, setPaying] = useState<Dep | null>(null);
  /**
   * 扣掉加費之後的應退金額（migration_157）。
   *
   * ★ 退款審核送的是**這個數字**，不是 deposits.amount。
   *   送押金原額的話，主管核 10,000、實際該退 9,900 —— 多退 100 出去，
   *   而兩張單上的數字看起來都很正常。
   *
   * null = 加費區塊還沒回報（還沒載入完，或這筆還沒存檔）。
   * 這時候一律退回 amount，不要拿 0 去算。
   */
  const [feeRefund, setFeeRefund] = useState<number | null>(null);
  /*
   * 「確認退款日」的視窗（2026-08-19 使用者指定「比照請款單」）。
   *
   * 原本是 window.prompt 問一個日期字串 —— 那有三個問題:
   *   · 沒辦法在匯出當下改安幸付款帳號（實務上常常跟預定的不同）
   *   · 格式打錯只能靠 regex 擋，訊息還印在 prompt 外面
   *   · 手機上 prompt 的體驗很差,而退款動輒十幾萬
   *
   * 請款單的「確認付款日」早就是正式的視窗（日期＋我方帳號＋擋門訊息），
   * 這裡照抄同一套 —— 兩個流程長得一樣，做帳的人不用學兩種。
   */
  const [depStep, setDepStep] = useState<{ mode: StepMode; dep: Dep } | null>(null);
  const [moveKw, setMoveKw] = useState('');
  const [moveOn, setMoveOn] = useState('');
  /** 要不要連「條件不符」的也列出來。預設不列 —— 見移轉視窗裡的說明。 */
  const [showBad, setShowBad] = useState(false);
  const [saving, setSaving] = useState(false);
  // 同 purchases：身分與角色來自 ProfileProvider，不再自己查一次
  const prof = useProfile();
  const me = prof.profile ? { id: prof.profile.id, role: prof.profile.role ?? '' } : null;
  const [people, setPeople] = useState<{ id: string; name: string | null }[]>([]);
  const [rejecting, setRejecting] = useState<Dep | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }

  const load = useCallback(async () => {
    setLoading(true);
    /*
     * 押金全撈。原本寫死 .limit(5000) —— 那是一道無聲的懸崖：
     * 押金只增不減（每張契約、每筆有押金的短租訂單都有一列），
     * 破了 5000 之後畫面會少一截，而「還在保管中的押金總額」就會偏低。
     * 沒有錯誤訊息，只是數字變小。
     */
    const { rows: data } = await fetchAll<Dep>((f, t) =>
      supabase.from('deposits').select('*').range(f, t));
    setRows(data);
    setLoading(false);
  }, [supabase]);

  /*
   * 從短租訂單／契約的抽屜按「押金」跳過來:?order=<id> 或 ?contract=<id>。
   *
   * 分頁籤一併切到「全部」—— 預設是「已收款(暫收中)」,
   * 而使用者要看的那筆很可能還沒收款,不切的話會看到空清單,像是壞掉。
   *
   * 網址處理完就清掉,否則重新整理又會套用一次,使用者不知道為什麼清單一直被鎖住。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const oid = sp.get('order');
    const cid = sp.get('contract');
    if (!oid && !cid) return;
    setFocus(oid ? { kind: 'order', id: oid } : { kind: 'contract', id: cid! });
    setStatusF('all');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    load();
    supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name')
      .then(({ data }) => setEstates(data ?? []));
    supabase.from('payment_accounts').select('code, name, method').eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
    // 分享訊息裡要寫「請款者」—— 資料庫存的是 uuid,要換成名字。
    // 請款頁的「請款者」欄位用的是同一個人,兩邊不一致的話收到訊息的人
    // 會以為訊息講的是另一筆
    supabase.from('profiles').select('id, name')
      .then(({ data }) => setPeople(data ?? []));
  }, [load, supabase]);

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);
  const personName = useMemo(
    () => Object.fromEntries(people.map((p) => [p.id, p.name ?? ''])), [people]);
  /**
   * 收款方式的顯示文字。
   *
   * ★ 觸發器只在**單筆收款**時填 received_method（migration_147）——
   *   多筆時是 null，因為挑哪一筆都會讓另一半的錢看起來走錯管道。
   *
   *   但 null 直接顯示成「—」會讓人以為沒收到錢。所以這裡分開講:
   *   真的沒收 → 「—」；收了但有多筆 → 「多筆」，要看明細。
   */
  const recvMethodText = (d: Dep) => {
    if (d.received_method) {
      return `${METHOD_LABEL[d.received_method] ?? d.received_method}`
        + (d.received_account ? `・${acctName[d.received_account] ?? d.received_account}` : '');
    }
    return Number(d.received_amount) > 0 ? '多筆（看明細）' : '—';
  };

  /** 分享時一併帶上送審的人 —— 兩個呼叫點都走這裡,不會有一邊漏帶 */
  const shareDep = useCallback((d: Dep) => shareDeposit(
    d, d.refund_requested_by ? personName[d.refund_requested_by] : undefined,
  ), [personName]);
  const rooms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.room).filter(Boolean) as string[])).sort(),
    [rows]);

  // base 是「除了分頁籤以外」都套用的結果。
  // 卡片的數字要算在 base 上,不是 filtered —— 否則點進「未收款」之後,
  // 其他兩張卡片會全部歸零,那就不是總覽而是同一個數字抄三遍。
  const base = useMemo(() => rows.filter((r) => {
    // 訂單／契約聚焦。放在最前面 —— 這是使用者當下唯一想看的東西,
    // 其他篩選條件（日期、物業…）不該把它篩掉。
    if (focus) {
      if (focus.kind === 'order' && r.order_id !== focus.id) return false;
      if (focus.kind === 'contract' && r.contract_id !== focus.id) return false;
    }
    // 日期區間比對「這筆押金最近一次動作」的日期:退了看退款日,否則看收款日。
    // 還沒收的沒有日期可比,設了區間就不顯示 —— 區間問的是「這段期間發生了什麼」,
    // 還沒發生的事不該混進來。未收款頁籤會另外提示。
    if (fromD || toD) {
      const d = r.returned_on ?? r.received_on;
      if (!d) return false;
      if (fromD && d < fromD) return false;
      if (toD && d > toD) return false;
    }
    if (estateF && r.estate_id !== estateF) return false;
    if (roomF && r.room !== roomF) return false;
    if (methodF && r.received_method !== methodF) return false;
    if (acctF && r.received_account !== acctF) return false;
    if (kw) {
      const hay = `${r.room ?? ''} ${r.guest_name ?? ''} ${r.note ?? ''}`.toLowerCase();
      if (!hay.includes(kw.toLowerCase())) return false;
    }
    return true;
  }), [rows, fromD, toD, estateF, roomF, methodF, acctF, kw, focus]);

  /** 一筆押金必定落在三類的其中一類,順序不能顛倒:退了就是已退,不管收款日 */
  /*
   * 三分類。**訂金的「結案」不只 returned_on**（migration_174）。
   *
   * ★★ 沒收與轉押的 returned_on 是 null —— 只看 returned_on 的話，
   *    那些訂金會被算進「已收訂金」，而它們早就處理完了。
   *    症狀是「已收訂金」那一格的金額一直不會降，
   *    而每一筆單看都很正常。
   */
  /**
   * 這一列是訂金還是押金（2026-08-24 使用者:「標記暫收款是訂金還是押金」）。
   *
   * ★ **兩種都標**，不是只標訂金。
   *
   *   我第一版只標訂金，理由是「押金是多數，標了整欄都是徽章」。
   *   但那一欄現在叫「暫收款」—— 它問的就是「這是什麼款」，
   *   而只標其中一種的話，沒有徽章的那些等於在說「不知道」。
   *
   * ★ 標在金額那一格底下，不是房源旁邊:
   *   欄名是「暫收款」，答案就該貼在那個數字下面。
   */
  /**
   * 這一列該叫什麼（2026-08-25 使用者:「訂金 不是押金」）。
   *
   * ★ 跟頁面上方的 `kindWord` 不一樣 —— 那一個看的是**頁籤**
   *   （現在在看哪一類），這一個看的是**這一列本身**。
   *
   *   檢視面板是從清單點進來的，在「全部」頁籤下 `kindWord` 會是「暫收」，
   *   而使用者眼前明明是一筆訂金。所以面板裡一律用這一個。
   */
  const wordOf = (r: Dep) => (r.kind === 'earnest' ? '訂金' : '押金');

  const kindChip = (r: Dep) => {
    const earnest = r.kind === 'earnest';
    return (
      /*
       * ★ 押金從灰改成藍（2026-08-25）。
       *
       *   灰色在這個系統裡是「停用／不適用」的顏色,而押金是**最正常的狀態**——
       *   用最像失效的顏色標最常見的東西,看久了會覺得那一欄沒有意義。
       *
       *   現在卡片、群組標題、列表徽章三個地方講同一件事用同一個顏色。
       */
      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
        earnest ? 'bg-amber-100 text-amber-800' : 'bg-mor-bluelight text-mor-slate'}`}>
        {earnest ? '訂金' : '押金'}
      </span>
    );
  };

  const bucketOf = (r: Dep) =>
    (r.returned_on || r.forfeited_on || r.converted_to_deposit_id) ? 'returned'
      : r.received_on ? 'held' : 'pending';

  /** 退款流程走到哪。returned_on 有值就是結案了,不再算在流程裡。 */
  const refundStage = (r: Dep) =>
    (r.returned_on ? 'done' : (r.refund_status ?? 'none'));

  const filtered = useMemo(() => base.filter((r) => {
    // 訂金 / 押金。★ 篩在這一層而不是 base —— base 要留給卡片當總覽，
    // 篩在 base 的話切到訂金時押金那一列的數字會全部歸零
    // ★ 暫付是另一張表，這裡的列一筆都不該通過（畫面上也不會渲染這份清單）
    if (kindF === 'advance') return false;
    if (kindF !== 'all' && (r.kind ?? 'deposit') !== kindF) return false;
    if (statusF === 'all') return true;
    if (statusF === 'orphan') return r.orphaned;
    if (statusF === 'refund_pending') return refundStage(r) === 'pending';
    if (statusF === 'refund_approved') return refundStage(r) === 'approved';
    return bucketOf(r) === statusF;
  }), [base, statusF, kindF]);

  const sorted = useMemo(() => sortRows(filtered, sort, COLS), [filtered, sort]);

  /**
   * 各分頁籤的金額與筆數。依幣別分開 —— 外幣原幣退還不換匯,加總沒有意義。
   *
   * **一定要走 depLines(),不能只加 r.amount** —— amount 只有台幣那部分,
   * 外幣全在 lines 裡。只加 amount 的話統計會少掉所有外幣,
   * 而且數字看起來很正常,沒有人會發現少了（migration_87）。
   */
  /*
   * ★★ 卡片分兩列:一列訂金、一列押金（2026-08-24 使用者指定）。
   *
   *   **不是同一組數字分兩行** —— 訂金有「已沒收」與「轉押」，押金沒有；
   *   押金有「孤兒」，訂金沒有（契約刪掉時未收的訂金跟著刪）。
   *   硬做成同一組欄位的話會有一半的格子永遠是 0，
   *   而永遠是 0 的格子會讓人以為那個功能壞了。
   */
  const statsOf = useCallback((kind: 'deposit' | 'earnest') => {
    const mk = () => ({ n: 0, cur: {} as Record<string, number> });
    const s = {
      pending: mk(), held: mk(), returned: mk(), orphan: mk(),
      refund_pending: mk(), refund_approved: mk(),
      /*
       * ★★ 「已退款」裡有一部分**錢根本沒有出去** —— 那是移房（migration_146）。
       *
       * 不分開列的話,「這段期間退了多少押金」這個數字會被灌水,
       * 而且灌得非常合理:每一筆單看都是一筆已退的押金。
       * 所以卡片上要把移轉的金額寫出來,讓人自己扣。
       */
      moved: mk(),
      // 訂金才有的兩種出路（migration_174）
      forfeited: mk(), converted: mk(),
    };
    const add = (t: { n: number; cur: Record<string, number> }, r: Dep) => {
      t.n++;
      for (const l of depLines(r)) t.cur[l.cur] = (t.cur[l.cur] ?? 0) + l.amt;
    };
    for (const r of base) {
      if ((r.kind ?? 'deposit') !== kind) continue;
      add(s[bucketOf(r) as 'pending' | 'held' | 'returned'], r);
      if (r.forfeited_on) add(s.forfeited, r);
      if (r.converted_to_deposit_id) add(s.converted, r);
      // 以下兩組跟上面三類重疊,是故意的 —— 見 Status 的說明
      if (r.orphaned) add(s.orphan, r);
      if (r.transfer_to_id) add(s.moved, r);
      const rs = refundStage(r);
      if (rs === 'pending' || rs === 'approved') {
        add(s[rs === 'pending' ? 'refund_pending' : 'refund_approved'], r);
      }
    }
    return s;
  }, [base]);

  const depStats  = useMemo(() => statsOf('deposit'), [statsOf]);
  const earnStats = useMemo(() => statsOf('earnest'), [statsOf]);
  /** 舊的呼叫端還在用 `stats` —— 指到押金那一份，行為跟改之前一樣 */
  const stats = depStats;

  /*
   * 訂金 ＋ 押金的總計（2026-08-25）。
   *
   * ★ 從已經算好的兩份合併，不是再掃一次 base ——
   *   掃兩次的話「什麼算 held」這個判斷會有兩份，
   *   改了其中一份時總計和卡片就對不起來，而兩邊各自看都合理。
   */
  const allStats = useMemo(() => totalBuckets(earnStats, depStats), [earnStats, depStats]);

  const fxLine = (cur: Record<string, number>) =>
    Object.entries(cur).filter(([c]) => c !== 'TWD').map(([c, v]) => `${c} ${fmt(v)}`).join('・');

  /*
   * 有沒有套用任何篩選。
   *
   * **狀態要跟預設值比，不是跟空字串比** —— `statusF` 預設是 'held'，
   * 拿它是不是空的來判斷,那顆「清除」就會永遠不出現。
   */
  const hasFilter = !!(fromD || toD || estateF || roomF || methodF || acctF || kw)
    || statusF !== 'held';

  function clearFilters() {
    setFromD(''); setToD(''); setEstateF(''); setRoomF('');
    setMethodF(''); setAcctF(''); setKwInput(''); setKw('');
    setStatusF('held');   // 狀態也一起回到預設,否則「清除」之後還是看不到全部
  }

  /** 手動押金:不掛在任何訂單/契約下,金額與房源姓名可以直接填 */
  function blankManual(): Dep {
    return {
      id: '', order_id: null, contract_id: null, estate_id: null, property_id: null,
      room: '', guest_name: '', currency: 'TWD', amount: 0,
      received_on: null, received_method: null, received_account: null, received_amount: 0,
      returned_on: null, returned_method: null, returned_account: null,
      note: null, orphaned: false, is_manual: true, created_at: '',
      refund_status: 'none', payee_bank_code: null, payee_name: null, payee_account: null,
      planned_refund_on: null,
      /*
       * 手動新增預設是押金 —— 那是多數（101 筆押金 / 訂金從契約來）。
       * 但可以改成訂金（2026-08-24 使用者:「可選 訂金 押金」）:
       * 舊約的訂金、還沒開契約就先收的訂金，都得手動記。
       */
      kind: 'deposit',
    };
  }

  const role = me?.role ?? '';
  const isManager = role === 'manager';
  const isAdmin = role === 'super_admin';
  const canRequest = ['accountant', 'manager', 'super_admin'].includes(role);
  /*
   * 能不能改押金。**管家（與房務）只能看**（2026-08-17 使用者指定）。
   *
   * 資料庫那邊已經擋住了（migration_139 只加 select policy），
   * 這裡藏按鈕是為了不要讓人按下去才發現不行 ——
   * RLS 擋下的 UPDATE **會回成功且影響 0 列**，
   * 畫面上看起來像存好了，重整才發現沒變。
   */
  const canEdit = ['accountant', 'manager', 'super_admin'].includes(role);

  /** 退款流程的權限判斷,集中一處 —— 分散寫遲早有一邊漏改 */
  function refundPerms(d: Dep) {
    const st = d.refund_status ?? 'none';
    return {
      st,
      // 還沒收到錢就沒有錢可以退。
      // pending 與 approved 也開放編輯 —— 存檔會清票重新送審(見 submitRefund),
      // 所以「改內容」跟「重新被審一次」永遠綁在一起,不可能繞過審核。
      // 真正的紅線是 returned_on:錢已經匯出去了就不能再改。
      canRequest: canRequest && !!d.received_on && !d.returned_on
        && ['none', 'rejected', 'pending', 'approved'].includes(st),
      canVoteMgr: isManager && st === 'pending' && !d.manager_approved_at,
      canVoteAdm: isAdmin && st === 'pending' && !d.admin_approved_at,
      canReject: (isManager || isAdmin) && st === 'pending',
      // 核可後才填實際退款日。這條也寫在 CHECK 約束裡,不是只靠前端。
      canSettle: canRequest && st === 'approved' && !d.returned_on,
      /*
       * 排匯款（2026-08-22，比照請款單）。
       * 跟 canSettle 同樣的條件 —— 兩顆並排，一顆按得到一顆按不到會很怪。
       */
      canPlan: canRequest && st === 'approved' && !d.returned_on,
      /*
       * 撤銷退款申請。送錯了以前只能請人下 SQL，或放著卡在待核可裡 ——
       * 而卡著的那幾筆會一直出現在每個人的待辦清單上。
       *
       * ★ 錢匯出去之後不能撤 —— 那不是「取消申請」，是「退款沒發生過」，
       *   而錢已經在對方帳戶裡了。
       */
      canCancel: canRequest && !d.returned_on && ['pending', 'approved'].includes(st),
    };
  }

  /**
   * 撤銷退款申請。
   *
   * ★ 只把退款申請退回未送審，**押金那一列留著** ——
   *   它是訂單/契約同步過來的，刪掉隔天又會長回來。
   *
   * ★ 要清哪些欄位寫在 lib/deposit-refund 的 cancelPatch()，
   *   請款審核頁用同一份。兩票一定要清 ——
   *   不清的話下次重新送審會帶著舊的兩票進來:看起來已經核可，
   *   而根本沒有人重新看過。
   */
  /**
   * 沒收訂金 → 產生一筆「取消入住」的一次性收入（migration_174）。
   *
   * ============================================================
   * 【★★ 這是三條出路裡唯一會產生營收的】
   *
   * 退款與轉押都不動營收 —— 錢還他、或換個名目留著。
   * 沒收不一樣:那筆錢從負債變成**當月收入**。
   *
   * 所以確認視窗要說出**金額與科目**，按錯的後果是當月數字多一筆，
   * 而報表看起來完全正常。
   *
   * 【冪等靠 forfeit_order_id】
   * 先寫訂單、再回寫 deposits。中間斷掉的話會留下一筆孤兒收入 ——
   * 那比「訂金標成已沒收卻沒有收入」好:前者看得到、查得出來,
   * 後者是一筆憑空消失的負債。
   */
  async function forfeitEarnest(d: Dep) {
    const blocked = exitBlockedReason(d as EarnestDep, 'forfeit');
    if (blocked) return flash(blocked);

    // ★ 已經沒收過就不要再產生第二筆 —— 重複按就是重複收入
    if (d.forfeit_order_id) return flash('這筆訂金已經沒收過了。');

    const on = todayStr();
    if (!confirm(
      `沒收這筆訂金？\n\n${depName(d)}・NT$ ${fmt(d.amount)}\n\n`
      + `會變成一筆「取消入住」的一次性收入（會計科目：其他），計入 ${on.slice(0, 7)} 的營收。\n\n`
      + `★ 這個動作不能復原 —— 產生的那筆收入之後也改不動、刪不掉。`
    )) return;

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();

    // ① 先產生收入
    const payload = forfeitOrder(
      { id: d.id, amount: d.amount, estate_id: d.estate_id,
        property_id: d.property_id, room: d.room, guest_name: d.guest_name },
      on,
    );
    const { data: ord, error: oe } = await supabase.from('orders')
      .insert({
        ...payload,
        nights: 0,
        order_key: `FEIT_${d.id.slice(0, 8)}_${Date.now()}`,
        imported_via: 'manual',
      })
      .select('id').single();
    if (oe || !ord) { setSaving(false); return flash('沒收失敗:' + (oe?.message ?? '')); }

    // ② 再回寫訂金
    const { data, error } = await supabase.from('deposits')
      .update({ forfeited_on: on, forfeit_order_id: (ord as any).id, forfeited_by: user?.id ?? null })
      .eq('id', d.id).select('id');
    setSaving(false);

    if (error) return flash('收入建好了，但訂金狀態沒更新:' + error.message);
    if (!data || data.length === 0) {
      return flash('收入建好了，但訂金一列都沒更新 —— 通常是權限。請重新整理後檢查。');
    }
    flash(`已沒收，並產生一筆 NT$ ${fmt(d.amount)} 的「取消入住」收入`);
    setDetail(null); load();
  }

  /**
   * 訂金轉押金（migration_174）。
   *
   * ============================================================
   * 【跟押金移房不同：金額幾乎一定不一樣】
   *
   * migration_146 的移房是「金額不同就擋掉」—— 那是對的，
   * 因為移房前後是**同一筆押金**。
   *
   * 訂金轉押金不一樣:訂金 10,000、押金 30,000 是常態。
   * 照移房那樣擋的話這個功能永遠用不了。
   *
   * 所以轉過去當「**已收一部分**」（使用者指定），
   * 差額用押金既有的分筆收款再收。
   *
   * ============================================================
   * 【★★ 不能改押金的 amount】
   *
   * `deposits.amount` 是 `sync_contract_deposits` 從 `contracts.deposit`
   * 同步過來的 —— 改小的話下次契約一存檔就被蓋回去（migration_146 的教訓）。
   *
   * 所以「已收多少」走 `deposit_payments`，
   * 合計由觸發器寫回 `received_amount`，**前端不自己算**。
   */
  async function convertEarnest(d: Dep) {
    const blocked = exitBlockedReason(d as EarnestDep, 'convert');
    if (blocked) return flash(blocked);
    if (!d.contract_id) return flash('這筆訂金沒有掛在契約上，無法轉押金。');

    // 找同一張契約的押金那一列
    const { data: deps, error: qe } = await supabase.from('deposits')
      .select('id, amount, received_amount, received_on, currency')
      .eq('contract_id', d.contract_id).eq('kind', 'deposit')
      .eq('currency', d.currency).limit(1);
    if (qe) return flash('查押金失敗:' + qe.message);

    const target = (deps ?? [])[0] as
      { id: string; amount: number; received_amount: number | null; received_on: string | null } | undefined;
    if (!target) {
      return flash('這張契約還沒有押金 —— 請先回契約把押金金額填上，再回來轉。');
    }

    const plan = convertPlan(d.amount, target.amount, Number(target.received_amount) || 0);
    const on = todayStr();

    if (!confirm(
      `把訂金轉成押金？\n\n`
      + `${depName(d)}\n`
      + `訂金 NT$ ${fmt(plan.transfer)} → 押金 NT$ ${fmt(plan.depositAmount)}\n\n`
      /*
       * ★ 這裡**不能用 `**粗體**`** —— `confirm()` 是純文字，
       *   星號會原封不動印出來（「＊＊尚欠 NT$ 125,000＊＊」）。
       *   想強調就換行、加空格，或用符號。
       */
      + (plan.settled
        ? `轉完之後押金收齊了。\n`
        : `轉完之後押金已收 NT$ ${fmt(plan.depositAmount - plan.remaining)}\n`
          + `　　　　　尚欠 NT$ ${fmt(plan.remaining)}（之後用收款明細再收）\n`)
      + (plan.excess > 0
        ? `\n⚠ 訂金比押金多 NT$ ${fmt(plan.excess)}\n　 多的部分不會自動退，要另外處理。\n`
        : '')
      + `\n訂金那一列會變成「已退｜轉押」。錢沒有離開公司，不算退款也不算收款。`
    )) return;

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();

    /*
     * ① 押金那邊記一筆收款。
     *
     *   ★ `method = 'earnest_in'`（訂金轉入），**不是 `internal`**。
     *     `internal` 的標籤是「押金移轉」——那是 A 房搬到 B 房。
     *     訂金轉入是同一張契約內的事，混用的話對帳時會去找另一間房，
     *     而那間房根本不存在。
     *
     *   兩者共同點是「錢沒有實際進出」，報表要靠它們把轉入
     *   排除在「本月收款」之外。
     */
    const { error: pe } = await supabase.from('deposit_payments').insert({
      deposit_id: target.id, paid_on: on, amount: plan.transfer,
      method: 'earnest_in', note: `訂金轉入（${depName(d)}）`, created_by: user?.id ?? null,
    });
    if (pe) { setSaving(false); return flash('轉押失敗:' + pe.message); }

    /*
     * ② 押金那一列補 received_on。
     *
     *   ★ 卡片的分類看的是 `received_on`（`bucketOf`），不是 received_amount。
     *     不補的話這筆押金會留在「未收款」那一格 —— 而它已經收了一部分。
     *   ★ 已經有值就不覆蓋:那是真的第一次收款的日期。
     */
    if (!target.received_on) {
      await supabase.from('deposits')
        .update({ received_on: on }).eq('id', target.id);
    }
    await supabase.from('deposits')
      .update({ converted_from_earnest_id: d.id }).eq('id', target.id);

    // ③ 訂金那一列結案
    const { data, error } = await supabase.from('deposits')
      .update({
        converted_to_deposit_id: target.id,
        converted_by: user?.id ?? null,
        converted_at: new Date().toISOString(),
      })
      .eq('id', d.id).select('id');
    setSaving(false);

    if (error) return flash('押金那邊記好了，但訂金狀態沒更新:' + error.message);
    if (!data || data.length === 0) {
      return flash('押金那邊記好了，但訂金一列都沒更新 —— 通常是權限。請重新整理後檢查。');
    }
    flash(plan.settled
      ? `已轉押金，押金收齊了`
      : `已轉押金，押金尚欠 NT$ ${fmt(plan.remaining)}`);
    setDetail(null); load();
  }

  async function cancelRefund(d: Dep) {
    if (!confirm(
      `撤銷這筆退款申請？\n\n${depName(d)}・NT$ ${fmt(d.refund_amount ?? d.amount)}\n\n`
      + `會退回「未送審」，已投的核可票會一起清掉。\n`
      + `押金本身不會刪除，房客的收款帳號也留著。`
    )) return;
    setSaving(true);
    /*
     * ★★ 要看改到幾列。RLS 擋下的 UPDATE 回成功且影響 0 列 ——
     * 只看 error 的話畫面會說「已撤銷」而那筆一動也沒動。
     */
    const { data, error } = await supabase.from('deposits')
      .update(cancelPatch()).eq('id', d.id).select('id');
    setSaving(false);
    if (error) return flash('撤銷失敗:' + error.message);
    if (!data || data.length === 0) {
      return flash('沒有任何一列被更新，通常是權限或這筆的狀態已經變了。請重新整理後再試。');
    }
    setDetail(null); setEdit(null); flash('已撤銷退款申請'); load();
  }

  /**
   * 送出／更新退款申請。房客帳戶與預計匯款日在這一步就要填齊,審核者才有東西可看。
   *
   * 審核中或已核可改內容,都會清掉既有的票並退回重新送審 ——
   * 不清的話,「改收款帳號」就能在核可後把錢導到別的地方,兩票等於白審。
   * 跟請款單同一個道理。錢真的匯出去之後(returned_on)才不能再改。
   */
  /** 按過「送出退款申請」了沒 —— 紅框只在他表達「我填完了」之後才出現 */
  const [triedRefund, setTriedRefund] = useState(false);
  /**
   * 手動暫收款那張表單按過儲存了沒。
   *
   * ★★★ 2026-09-10 補上。原本只有退款那一區有 `tried`，
   *   手動暫收款這一段五個欄位都標了紅星、也擋得住，
   *   **但一格都不會變紅** —— 按下去只跳一句話，
   *   五格之中是哪一格漏了要自己數。
   */
  const [triedManual, setTriedManual] = useState(false);
  /** 退款申請缺哪些欄位。訊息與紅框用同一份答案 */
  /*
   * ★ 預計匯款日與安幸付款帳號**不在送審必填裡**（2026-08-22，比照請款單）。
   *
   * 送審當下常常還不知道會從哪個戶頭出、哪天出。以前是必填，
   * 所以大家隨便填一個再回來改 —— 而改動會清掉核可票、退回重審。
   * 那兩個移到核可後的「排匯款」那一步。
   *
   * 審核者要看的是「錢退給誰」，不是「我方哪天從哪個戶頭出」。
   */
  const refundMissing = edit ? missingFields([
    { label: '戶名', value: edit.payee_name },
    { label: '房客收款帳號', value: edit.payee_account },
    { label: '安幸付款方式', value: edit.returned_method },
  ]) : [];

  /**
   * 手動暫收款缺哪幾欄。★ 跟 `manualDepositError()` 同一份答案 ——
   * 紅框、送出鈕提示、擋下來的訊息三個地方各算一次的話一定會漂。
   */
  const manualMissing = (edit && edit.is_manual)
    ? manualDepositMissingAll({ ...edit, kind: edit.kind ?? 'deposit' })
    : [];
  /** 這一格要不要畫紅框 */
  const mErr = (f: string) => triedManual && manualMissing.includes(f);
  /**
   * 「儲存」鈕的樣子。★★★ 灰掉但**按得下去** ——
   * 真的 disabled 的話 `triedManual` 打不開、紅框永遠不出現
   * （見 lib/required.ts 的 submitGate）。
   */
  const saveGate = submitGate(manualMissing, saving);

  async function submitRefund() {
    if (!edit) return;
    const wasSubmitted = edit.refund_status === 'pending' || edit.refund_status === 'approved';
    const hadVotes = !!edit.manager_approved_at || !!edit.admin_approved_at;
    if (wasSubmitted && hadVotes && !confirm(
      edit.refund_status === 'approved'
        ? '這筆退款已經核可通過。更新資訊會清掉核可票、退回重新送審,確定嗎?'
        : '這筆退款已經有人核可。更新資訊會清掉既有核可票並重新送審,確定嗎?'
    )) return;
    setTriedRefund(true);
    if (refundMissing.length) return flash(missingMessage(refundMissing));
    setSaving(true);
    const { error } = await supabase.from('deposits').update({
      refund_status: 'pending',
      /*
       * ★★ 記下這次要退多少（migration_157）。
       *
       * 加費從押金扣之後，應退不再等於 amount。
       * 不記的話主管核完就查不到他核了什麼數字 ——
       * 而確認退款時只能當場再算一次，算式一改兩邊就對不上。
       *
       * feeRefund 還沒回報（加費區塊沒載完）時退回 amount，
       * 不要拿 0 去寫 —— 寫 0 的話那筆會變成「核可退 0 元」。
       */
      refund_amount: feeRefund ?? edit.amount,
      payee_bank_code: edit.payee_bank_code?.trim() || null,
      payee_name: (edit.payee_name ?? '').trim(),
      payee_account: (edit.payee_account ?? '').trim(),
      planned_refund_on: edit.planned_refund_on,
      returned_method: edit.returned_method,
      returned_account: edit.returned_method !== 'cash' ? (edit.returned_account || null) : null,
      refund_requested_by: me?.id ?? null,
      note: edit.note || null,
      // 內容變了,既有的票就不算數
      manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null,
    }).eq('id', edit.id);
    setSaving(false);
    if (error) return flash('送審失敗:' + error.message);
    setEdit(null); setTriedRefund(false); flash(wasSubmitted ? '已更新並重新送審' : '已送出退款審核'); load();
  }

  /** 投票。兩票到齊由觸發器翻成 approved,前端不自己算狀態。 */
  async function vote(d: Dep) {
    if (!me) return;
    const patch: any = {};
    if (isManager) { patch.manager_approved_by = me.id; patch.manager_approved_at = new Date().toISOString(); }
    else if (isAdmin) { patch.admin_approved_by = me.id; patch.admin_approved_at = new Date().toISOString(); }
    else return flash('你的角色不能核可');
    const { error } = await supabase.from('deposits').update(patch).eq('id', d.id);
    if (error) return flash('核可失敗:' + error.message);
    setDetail(null); flash('已核可'); load();
  }

  async function doReject() {
    if (!rejecting || !me) return;
    if (!rejectReason.trim()) return flash('請填駁回原因');
    const { error } = await supabase.from('deposits').update({
      refund_status: 'rejected', rejected_by: me.id, reject_reason: rejectReason.trim(),
    }).eq('id', rejecting.id);
    if (error) return flash('駁回失敗:' + error.message);
    setRejecting(null); setRejectReason(''); flash('已駁回'); load();
  }


  /* ══════════════ 押金移房（migration_146）══════════════ */

  /** id → 那筆押金，給移轉標籤查對方叫什麼名字用。 */
  const depById = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r])) as Record<string, Dep>, [rows]);
  const nameOfDep = useCallback(
    (id: string) => (depById[id] ? depName(depById[id]) : null), [depById]);

  /*
   * 只有會計與總管理員能移（2026-08-19 使用者指定）——
   * **經理不在內**,他能改押金、能投退款票,但不能移房。
   *
   * 這裡藏按鈕只是為了不讓人白按:真正說了算的是 RPC 裡的同一條檢查。
   */
  const canMove = roleCanTransfer(role);

  /**
   * 把來源那筆的押金移到 `moving`（目的）。
   *
   * 走 RPC 而不是前端兩次 update —— ★★ RLS 擋下的 UPDATE 會回成功且影響 0 列,
   * 分兩句寫的話第二句被擋掉時畫面會說「移轉成功」,
   * 實際上 A 已退、B 還是未收,那筆錢在系統裡人間蒸發而且沒有錯誤訊息。
   */
  async function doTransfer(other: Dep) {
    if (!moving) return;
    // 使用者站在哪一邊，另一邊就是 other —— 兩個方向共用同一支
    const from = moving.side === 'from' ? moving.dep : other;
    const to = moving.side === 'from' ? other : moving.dep;
    const v = canTransfer(from as TransferDep, to as TransferDep);
    if (!v.ok) return flash(v.reason + (v.hint ? `：${v.hint}` : ''));
    const on = /^\d{4}-\d{2}-\d{2}$/.test(moveOn) ? moveOn : todayStr();
    if (!confirm(
      `把 ${depName(from)} 的押金 NT$ ${fmt(from.amount)} 移轉到 ${depName(to)}？\n\n`
      + `・${depName(from)} → 已退押金（移轉，錢沒有實際匯出）\n`
      + `・${depName(to)} → 已收押金\n`
      + `・移轉日 ${on}\n\n兩邊備註都會自動註記，移錯了可以撤銷。`
    )) return;
    setSaving(true);
    const { data, error } = await supabase.rpc('transfer_deposit', {
      p_from: from.id, p_to: to.id, p_on: on,
    });
    setSaving(false);
    if (error) return flash('移轉失敗：' + error.message);
    // RPC 回 ok 布林。靠字串比對判斷成功與否的話,訊息改一個字就會變成「失敗也顯示成功」
    const r = (data ?? [])[0] as { ok: boolean; item: string; detail: string } | undefined;
    if (!r?.ok) return flash(`${r?.item ?? '移轉失敗'}${r?.detail ? '：' + r.detail : ''}`);
    setMoving(null); setMoveKw(''); setDetail(null);
    flash(`${r.item}・${r.detail}`);
    load();
  }

  /**
   * 撤銷移轉。兩列一起復原。
   *
   * 【為什麼一定要有】選錯 A 或選錯 B 之後,前端**沒有任何地方能清掉 returned_on**——
   * settle() 只填日期不會清,編輯視窗刻意不碰 returned_*。
   * 沒有這顆按鈕,移錯一次就只能請人去改資料庫,而那通常等於沒有人會去改。
   */
  async function undoTransfer(d: Dep) {
    const other = d.transfer_to_id ?? d.transfer_from_id;
    if (!confirm(
      `撤銷這筆押金移轉？\n\n`
      + `${depName(d)} 與 ${other ? nameOfDep(other) ?? '對應那筆' : '對應那筆'} 都會回到移轉前的狀態。\n`
      + `備註不會刪掉，會再加一行撤銷紀錄。`
    )) return;
    setSaving(true);
    const { data, error } = await supabase.rpc('undo_deposit_transfer', { p_id: d.id });
    setSaving(false);
    if (error) return flash('撤銷失敗：' + error.message);
    const r = (data ?? [])[0] as { ok: boolean; item: string; detail: string } | undefined;
    if (!r?.ok) return flash(`${r?.item ?? '撤銷失敗'}${r?.detail ? '：' + r.detail : ''}`);
    setDetail(null); flash(`${r.item}・${r.detail}`); load();
  }

  /**
   * 儲存「收押金」那一段與備註。
   *
   * 刻意不碰 returned_* —— 那三欄屬於退款流程,由 submitRefund() 與 settle() 管。
   * 早期版本這裡也一併寫,結果是:退款申請填好安幸付款帳號後按「儲存」,
   * 因為 returned_on 還是空的,就把 returned_method / returned_account 清成 null,
   * 看起來像「存不進去」,實際上是存進去了但把值洗掉。
   * 一個欄位只該有一個地方負責寫。
   */
  async function save() {
    if (!edit) return;
    // ★ 按鈕沒有 disabled 了（aria-disabled 點得下去）—— 防連點在這裡
    if (saving) return;
    const manual = !!edit.is_manual;
    if (manual) {
      // ★★ 先打開紅框再擋。按下去的意思就是「我覺得我填完了」
      setTriedManual(true);
      const err = manualDepositError({ ...edit, kind: edit.kind ?? 'deposit' });
      if (err) return flash(err);
    }
    setSaving(true);
    /*
     * ★★ 這裡**不再寫 received_on / received_method / received_account**（migration_147）。
     *
     * 那三欄現在由 deposit_payments 的觸發器維護。前端也寫的話：
     *   · 存檔會把觸發器算出來的收滿日蓋成手填的值
     *   · 下一次任何一筆收款異動，觸發器又蓋回去
     *
     * 結果是同一個欄位有兩個主人，而**兩次寫入都會成功** ——
     * 你只會看到「收款日有時候會自己變」，查不到原因。
     * 一個欄位只該有一個地方負責寫。
     */
    const payload: any = {
      note: edit.note || null,
    };
    // 連動列的這幾欄是來源的快照,改了下次同步就被蓋回去,所以只有手動列能改
    if (manual) {
      Object.assign(payload, {
        is_manual: true,
        estate_id: edit.estate_id || null,
        room: edit.room?.trim() || null,
        guest_name: edit.guest_name?.trim() || null,
        currency: edit.currency || 'TWD',
        amount: Number(edit.amount) || 0,
      });
      /*
       * ★★ kind 只在**新增**時寫（2026-08-25 補上，原本整個漏掉）。
       *
       *   漏掉的症狀:下拉選了「訂金」，存檔成功，然後那一列是押金 ——
       *   因為 deposits.kind 的預設值就是 'deposit'（migration_174）。
       *   不報錯、不提示，只有回頭看列表才發現種類不對。
       *
       *   更新時不寫是刻意的:畫面上那個下拉已經 disabled，
       *   而已經走過的痕跡（forfeited_on / converted_to_deposit_id）
       *   會跟新種類的規則對不上。要換種類就刪掉重建。
       */
      if (!edit.id) payload.kind = edit.kind === 'earnest' ? 'earnest' : 'deposit';
    }
    const { error } = edit.id
      ? await supabase.from('deposits').update(payload).eq('id', edit.id)
      : await supabase.from('deposits').insert(payload);
    setSaving(false);
    if (error) return flash('儲存失敗:' + error.message);
    setEdit(null); setTriedRefund(false); setTriedManual(false); flash('已儲存'); load();
  }

  async function del(d: Dep) {
    if (!confirm(`刪除這筆押金紀錄（${d.room ?? ''} ${d.guest_name ?? ''}）?\n\n會移到回收桶,可以復原。`)) return;
    const r = await softDelete(supabase, 'deposits', d.id);
    flash(r.message);
    if (r.ok) { setEdit(null); setTriedRefund(false); setDetail(null); load(); }
  }

  /**
   * 下載 Excel。格式與請款單那份一致 —— 同一個人同一天可能兩份都要下載,
   * 長得不一樣只會讓對帳的人多花時間適應。
   *
   * 【欄位順序刻意分成四段】
   *   基本      物業 → 房源 → 姓名 → 幣別 → 押金
   *   收進來    收押金日 → 收款方式 → 安幸收款帳號        ← 我方收在哪個帳戶
   *   退出去    預定退款日 → 退押金日 → 退款方式 → 退款帳號   ← 我方從哪個帳戶付
   *   對方      銀行代號 → 戶名 → 收款帳號            ← 錢要匯去哪
   *
   * 「我方帳號」在前、「對方資訊」在後,跟請款單同一個順序,
   * 也跟實際操作網銀時填的順序一致,複製貼上不用左右跳。
   *
   * 預定退款日與實際退押金日並排 —— 差幾天一眼就看得出來,
   * 那是「核可了但還沒匯」的積壓,分開放就沒人會去比。
   */
  function exportXlsx() {
    if (!sorted.length) return flash('沒有符合條件的押金紀錄');
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    const header = ['物業', '房源', '姓名', '幣別', '押金',
      // ★ 實收獨立一欄（migration_147）。應收那一欄現在可能只收了一半 ——
      //   不列出來的話 Excel 上「押金 2,800」看起來就是收齊了
      '實收', '收押金日', '收款方式', '安幸收款帳號',
      '預定退款日', '退押金日', '退款方式', '退款帳號',
      '銀行代號', '戶名', '房客收款帳號',
      // ★ 移轉獨立一欄。狀態欄寫「已退」的那幾筆裡，有些錢根本沒出去 ——
      //   對帳的人要能一眼把它們挑掉，不然當月的退款金額會多算
      '押金移房', '狀態', '備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      aoa.push([
        T(r.estate_id ? estateName[r.estate_id] ?? '' : '', stCell),
        T(r.room ?? '', stCell),
        T(r.guest_name ?? '', stCell),
        // 多幣別的押金是一筆,幣別欄放完整摘要,只印 currency 會漏掉外幣
        T(summaryText(r), stCell),
        T(Math.round(Number(r.amount) || 0), stNum),
        T(Math.round(Number(r.received_amount) || 0), stNum),
        T(r.received_on ?? '', stCell),
        T(r.received_method ? METHOD_LABEL[r.received_method] ?? r.received_method
          : (Number(r.received_amount) > 0 ? '多筆' : ''), stCell),
        // 安幸收款帳號 = 押金收進我方哪個帳戶。跟銀行對帳要靠它。現金收的就是空的。
        T(r.received_account ? acctName[r.received_account] ?? r.received_account : '', stCell),
        T(r.planned_refund_on ?? '', stCell),
        T(r.returned_on ?? '', stCell),
        T(r.returned_method ? METHOD_LABEL[r.returned_method] ?? r.returned_method : '', stCell),
        // 退款帳號 = 錢從我方哪個帳戶出去
        T(r.returned_account ? acctName[r.returned_account] ?? r.returned_account : '', stCell),
        // 以下三欄是對方(房客)的收款資訊,退款申請核可時填的
        T(r.payee_bank_code ?? '', stCell),
        T(r.payee_name ?? '', stCell),
        // 帳號一律當文字。當數字的話 Excel 會吃掉開頭的 0,長帳號還會變科學記號
        T(r.payee_account ?? '', stCell),
        T(transferChip(r, nameOfDep)?.text ?? '', stCell),
        // ★ 跟畫面同一支 depBadges —— 匯出原本自己寫一條鏈,而且漏了「收部分」
        T(DEP_BADGE_LABEL[depBadges(r as any).pay], stCell),
        T(r.note ?? '', stCell),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 12 },  // 物業
      { wch: 10 },  // 房源
      { wch: 12 },  // 姓名
      { wch: 6 },   // 幣別
      { wch: 11 },  // 押金
      { wch: 11 },  // 實收
      { wch: 12 },  // 收押金日
      { wch: 10 },  // 收款方式
      { wch: 18 },  // 安幸收款帳號
      { wch: 12 },  // 預定退款日
      { wch: 12 },  // 退押金日
      { wch: 10 },  // 退款方式
      { wch: 18 },  // 退款帳號
      { wch: 10 },  // 銀行代號
      { wch: 18 },  // 戶名
      { wch: 20 },  // 房客收款帳號
      { wch: 18 },  // 押金移房
      { wch: 10 },  // 狀態
      { wch: 24 },  // 備註
    ];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '押金');
    // 檔名帶上當下的篩選條件 —— 下載三份不同條件的檔案放在同一個資料夾時,
    // 只靠日期分不出哪份是哪份。
    const tag = [statusF === 'all' ? '' : STATUS_LABEL[statusF],
      estateF ? estateName[estateF] ?? '' : '', roomF,
      methodF ? METHOD_LABEL[methodF] ?? '' : '',
      acctF ? acctName[acctF] ?? '' : '', kw].filter(Boolean).join('_');
    // 用本地日期,不用 toISOString() —— 那是 UTC,台灣凌晨下載會標成前一天
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `押金${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  /**
   * 核可票。○ 未投、✓ 已投 —— 一眼看得出卡在誰身上。
   * 只在審核中顯示;核可完了兩個都是 ✓,再顯示只是佔位置。
   */
  const voteLine = (r: Dep) => {
    if (r.refund_status !== 'pending') return null;
    return (
      <div className="text-[11px] text-gray-400 mt-0.5 whitespace-nowrap">
        <span className={r.manager_approved_at ? 'text-mor-green' : ''}>{r.manager_approved_at ? '✓' : '○'} 主管</span>
        <span className="mx-1">·</span>
        <span className={r.admin_approved_at ? 'text-mor-green' : ''}>{r.admin_approved_at ? '✓' : '○'} 總經理</span>
      </div>
    );
  };

  /** 退款流程的狀態標籤。跟押金本身的狀態（暫收/已退）是兩回事。 */
  const refundChip = (r: Dep) => {
    const st = r.refund_status ?? 'none';
    /*
     * ★★ 訂金的說法跟押金不一樣（migration_174）。
     *
     *   訂金有三條出路，其中兩條**錢沒有退給房客**:
     *     沒收   → 錢留下來變成營收
     *     轉押金 → 錢換一個名目，還在我們手上
     *
     *   共用「已退款」那個灰色標籤的話，看清單的人會以為錢退出去了 ——
     *   而暫收總額其實一毛都沒少。這跟移房那次是同一個問題
     *   （同一個欄位兩種意思）。
     */
    if (r.kind === 'earnest') {
      const es = earnestStatus(r as EarnestDep);
      if (es === '已沒收') {
        return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-red-50 text-red-700">已沒收</span>;
      }
      if (es === '已退｜轉押') {
        return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-violet-50 text-violet-700">已退｜轉押</span>;
      }
      if (es === '已退訂金') {
        return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">已退訂金</span>;
      }
      // 其餘（未付/已收/審核中）跟押金講法一樣,往下走共用的那幾行
    }
    if (r.returned_on) return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-500">已退款</span>;
    if (st === 'approved') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-mor-greenlight text-mor-green">已核可・待匯款</span>;
    if (st === 'pending') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-amber-50 text-amber-700">退款審核中</span>;
    if (st === 'rejected') return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] bg-red-50 text-red-600">已駁回</span>;
    return null;
  };

  /**
   * ★★ 移轉的標籤要跟「已退／已收」分開。
   *
   * 同一個 returned_on 兩種意思:一個是錢匯給房客了,一個是錢還在我們手上
   * 只是換了名目。共用一個灰色「已退」的話,看清單的人會以為錢退出去了 ——
   * 而押金總額其實一毛都沒少。
   */
  const moveChip = (r: Dep) => {
    const c = transferChip(r, nameOfDep);
    if (!c) return null;
    return (
      <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${
        c.dir === 'out' ? 'bg-violet-50 text-violet-700' : 'bg-mor-greenlight text-mor-green'}`}>
        {c.text}
      </span>
    );
  };

  /*
   * ══════════ 押金狀態 ＋ 移房狀態，同一欄兩個標籤（2026-09-02 使用者:「和一起就可以了」）══════════
   *
   * ★★★ 舊版是一條**優先序鏈**（孤兒 → 移轉出 → 已退 → 移轉入 → 收部分 → …），
   *   只回一個標籤。於是兩件事會互相蓋掉:
   *
   *     移轉進來又沒收滿  顯示「移轉自 5B2」，**收部分被蓋掉**
   *                        （移房加押金就是這個情況，正是使用者這次要修的）
   *     移轉進來又退掉    顯示「已退」，**移轉自被蓋掉**，看不出錢的來歷
   *
   * ★ 那本來就是**兩個維度**:錢收到什麼程度、這筆是不是移房來的。
   *   擠成一個標籤就一定有一個要被犧牲。
   *
   * ★★ 判斷寫在 `lib/deposit-transfer` 的 `depBadges()`（有測試）——
   *   這裡只負責挑顏色。
   */
  const PAY_CHIP: Record<string, { text: string; cls: string }> = {
    orphan:      { text: DEP_BADGE_LABEL.orphan,      cls: 'bg-red-50 text-red-600' },
    transferred: { text: DEP_BADGE_LABEL.transferred, cls: 'bg-violet-50 text-violet-700' },
    returned:    { text: DEP_BADGE_LABEL.returned,    cls: 'bg-gray-100 text-gray-500' },
    paid:        { text: DEP_BADGE_LABEL.paid,        cls: 'bg-mor-greenlight text-mor-green' },
    partial:     { text: DEP_BADGE_LABEL.partial,     cls: 'bg-amber-50 text-amber-700' },
    unpaid:      { text: DEP_BADGE_LABEL.unpaid,      cls: 'bg-amber-50 text-amber-600' },
  };

  const statusChip = (r: Dep) => {
    const b = depBadges(r as any);
    const move = moveChip(r);
    const pc = PAY_CHIP[b.pay];

    /*
     * ★ 退款流程進行中的優先顯示流程狀態 —— 「全收」看不出有人正在等核可，
     *   而那是現在有人要動作的事（既有行為，不動）。
     */
    const rc = b.pay === 'paid' ? refundChip(r) : null;

    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {rc ?? (
          <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${pc.cls}`}
            title={b.pay === 'partial'
              ? `已收 ${fmt(r.received_amount ?? 0)} / ${fmt(r.amount)}`
              : (b.pay === 'transferred' ? '錢沒有退給房客，只是換了名目' : undefined)}>
            {pc.text}
          </span>
        )}
        {/*
          ★ 移轉**出去**的不再掛第二個標籤 —— 上面那個「已移轉」
            已經把方向講完了，`moveChip` 會再寫一次「已移轉 → 9A5」。
        */}
        {b.showFrom && move}
        {b.pay === 'transferred' && move}
      </span>
    );
  };

  const inp = 'rounded-lg border border-gray-300 px-2 py-1.5';

  // 未收款的列沒有任何日期,設了區間必然全空。直接說明,不要讓人以為資料不見了。
  const emptyHint = (statusF === 'pending' || statusF === 'all') && (fromD || toD)
    ? `未付的${kindWord}還沒有收退日期,設了日期區間就不會出現。清除日期才看得到。`
    : `這一類目前沒有${kindWord}紀錄`;

  return (
    <div>
      <Toast msg={msg} />

      {/*
        聚焦提示。**一定要有** —— 沒有這一列的話,使用者看到的是一個
        「莫名其妙只有兩筆」的押金頁,而且找不到原因。
      */}
      {focus && (
        <div className="mb-3 rounded-lg bg-mor-bluelight border border-mor-line px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span className="min-w-0">
            只顯示這張{focus.kind === 'order' ? '訂單' : '契約'}的押金
            <span className="text-gray-500 ml-2 text-xs">
              （{base.length} 筆{base.length === 0 ? '：這張單還沒有押金紀錄' : ''}）
            </span>
          </span>
          <button onClick={() => setFocus(null)}
            className="shrink-0 text-xs text-mor-slate underline hover:text-mor-blue">顯示全部</button>
        </div>
      )}

      {/*
          ★★ 訂金那一列（2026-08-24 使用者:「卡片有兩列」「看板要分訂金與押金啊」）。

          【我第一版寫錯了】
          原本的條件是「只在真的有訂金時才出現」，理由是
          「一列永遠是 0 的卡片會讓人以為功能壞了」。

          實際跑起來訂金是 0 筆，所以整列不見 —— 而使用者要的正是
          **一眼看到這裡有兩種錢**。看板的結構要穩定:
          今天有沒有訂金是資料的事，不該讓版面長得不一樣。

          0 筆的那一列寫「0 筆」就好,那是資訊不是故障。
      */}
      {/*
          ★ 暫收款總計（2026-08-25 使用者:「要有總共 暫收款」）。

          底下兩列各自回答「訂金在哪個階段」「押金在哪個階段」，
          少的是最上面那一句:**我們手上總共有多少別人的錢**。
          那正是「暫收付管理」的暫收那半在問的事。

          ★ 做成一條窄的橫幅而不是第三列大卡片 ——
            三列大卡片會把清單推到第一屏之外，
            而總計是拿來瞄一眼的，不是拿來點的。

          ★ 不可點。它不是分頁籤:底下每一格點下去都會同時決定
            「訂金還是押金」，總計沒有這個答案。
            做成看起來可點卻篩不出東西的話，比不做更糟。
      */}
      {/*
          ★ 2026-08-25 使用者:「版面太複雜」「上方 總計 ____ 大字就好」。

            原本一行擠了三個數字（在我們手上／尚未收到／已結案）加一行說明 ——
            而那三個數字底下兩列卡片已經各自寫了一遍。
            總計要回答的只有一句:**我們手上現在有多少別人的錢**。

          ★★ 標籤寫「錢在我們手上」而不只是「總計」。

            只寫「暫收款總計」的話，這個數字會被讀成「所有暫收款加起來」——
            而它不含未收的 135 萬、也不含已退的 47 萬。
            差了一百多萬，而且**兩種讀法看起來都合理**，
            對不出來的人只會覺得自己算錯。
      */}
      {/*
        ★★★ 統計卡區。**分頁籤在它下面**（這一頁的版面順序是
          「總計＋卡片 → 分頁籤 → 篩選＋清單」）。

          ★ 暫付的卡片一定要放在這裡，不能跟清單綁在一起放到分頁籤下面 ——
            那樣切到暫付時分頁籤會從畫面中間跳到最上面
            （2026-09-01 使用者:「tab 位置被移動」）。
            使用者靠位置記憶找東西，換一個分頁就換一個位置等於每次重新找。
      */}
      {kindF === 'advance' && <AdvanceStats a={adv} />}
      {kindF !== 'advance' && (<>
      <StatTotal
        label="暫收款總計"
        value={`NT$ ${fmt(allStats.held.cur['TWD'] ?? 0)}`}
        sub={`${allStats.held.n} 筆・錢在我們手上${
          fxLine(allStats.held.cur) ? `・${fxLine(allStats.held.cur)}` : ''}`} />

      <div className="mb-3">
          <StatGroup label="訂金" tone="amber" />
          {/*
              ★ 三格，不是五格（2026-08-24 使用者:「這三個可以放一起嗎？」）。

              「已退訂金 / 已沒收 / 轉押金」三者的共同點是**這筆處理完了**，
              差別只在錢去了哪裡。分成三格的話:

                · 每一格都很窄，數字擠在一起
                · 而使用者在看板上真正要問的是「還有幾筆要處理」——
                  那是前兩格的事，第三格只要一個總數

              細分寫在第三格的小字裡，要看得到、但不佔一整格。
          */}
          <StatRow>
            {([
              /* ★ 標題不再重複「訂金」—— 群組標題已經說了,每一列再寫一次是三次雜訊 */
              { k: 'pending',  title: '未付',   s: earnStats.pending,  sub: null },
              { k: 'held',     title: '已收',   s: earnStats.held,     sub: null },
              { k: 'returned', title: '已結案', s: earnStats.returned,
                sub: [
                  earnStats.returned.n - earnStats.forfeited.n - earnStats.converted.n > 0
                    ? `退 ${earnStats.returned.n - earnStats.forfeited.n - earnStats.converted.n}` : '',
                  earnStats.forfeited.n > 0 ? `沒收 ${earnStats.forfeited.n}` : '',
                  earnStats.converted.n > 0 ? `轉押 ${earnStats.converted.n}` : '',
                ].filter(Boolean).join('・') || null },
            ] as const).map((t) => (
              <StatCard key={t.k}
                label={t.title}
                value={`NT$ ${fmt(t.s.cur['TWD'] ?? 0)}`}
                sub={`${t.s.n} 筆${t.sub ? `・${t.sub}` : ''}`}
                tone="amber"
                active={kindF === 'earnest' && statusF === t.k}
                muted={t.s.n === 0}
                onClick={() => { setKindF('earnest'); setStatusF(t.k); }} />
            ))}
          </StatRow>
      </div>

      {/*
        三張卡片同時是分頁籤。數字算在 base 上(不含分頁籤本身的篩選),
        所以切到哪一類,另外兩類的數字都還在 —— 卡片是總覽,不是當前清單的重複。

        ★ 這一列是**押金**（migration_174 之後）。點下去會一併把
          訂金/押金切到「押金」—— 不然按了「已收款」卻看到訂金混在裡面。
      */}
      <StatGroup label="押金" tone="slate" />
      {/*
        ★ 跟訂金那一列**用同一個元件、同一種尺寸**（2026-08-25）。
          改版前這一列是 p-5 的大卡、訂金那列是 px-3 py-2 的小卡 ——
          並排時看起來像兩種不同的東西,其實是同一種。
      */}
      <StatRow className="mb-4">
        {([
          { k: 'pending',  title: '未付' },
          { k: 'held',     title: '已收' },
          { k: 'returned', title: '已退' },
        ] as const).map((t) => {
          const st = stats[t.k];
          const fx = fxLine(st.cur);
          /* ★ 已退押金裡混著移房 —— 那幾筆錢沒有出去。只留筆數,金額拿掉 */
          const moved = t.k === 'returned' && stats.moved.n > 0 ? `其中移房 ${stats.moved.n} 筆` : '';
          return (
            <StatCard key={t.k}
              label={t.title}
              value={`NT$ ${fmt(st.cur['TWD'] ?? 0)}`}
              sub={[`${st.n} 筆`, fx, moved].filter(Boolean).join('・')}
              active={statusF === t.k && kindF !== 'earnest'}
              muted={st.n === 0}
              onClick={() => { setKindF('deposit'); setStatusF(t.k); }} />
          );
        })}
      </StatRow>

      {/*
        退款流程指標。

        上面三張卡回答「錢在誰手上」,這一列回答「有什麼卡著等人動作」——
        兩者刻意分開:一筆已核可待匯款的押金,錢還在我們手上,它同時算在「暫收中」裡。
        把它從暫收中扣掉的話,「我們現在保管多少錢」這個數字就不對了。

        這一列存在的理由很具體:核可已經搬到請款頁做了,
        會計回到這一頁時必須看得到「有幾筆等我匯出去」,否則那些單會安靜地卡著。

        沒有東西時整列不顯示 —— 兩個 0 只是視覺雜訊。
      */}
      {(stats.refund_pending.n > 0 || stats.refund_approved.n > 0) && (
        <div className="flex flex-wrap gap-2 mb-4">
          {stats.refund_pending.n > 0 && (
            <button onClick={() => setStatusF('refund_pending')}
              className={`rounded-lg px-3 py-2 text-xs border text-left transition
                ${statusF === 'refund_pending'
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-400'}`}>
              退款審核中 {stats.refund_pending.n} 筆・NT$ {fmt(stats.refund_pending.cur['TWD'] ?? 0)}
              <span className={`ml-2 ${statusF === 'refund_pending' ? 'opacity-80' : 'text-amber-600/70'}`}>等主管或總經理核可</span>
            </button>
          )}
          {stats.refund_approved.n > 0 && (
            <button onClick={() => setStatusF('refund_approved')}
              className={`rounded-lg px-3 py-2 text-xs border text-left transition
                ${statusF === 'refund_approved'
                  ? 'bg-mor-green text-white border-mor-green'
                  : 'bg-mor-greenlight text-mor-green border-mor-green/30 hover:border-mor-green/60'}`}>
              已核可待匯款 {stats.refund_approved.n} 筆・NT$ {fmt(stats.refund_approved.cur['TWD'] ?? 0)}
              <span className={`ml-2 ${statusF === 'refund_approved' ? 'opacity-80' : 'opacity-70'}`}>匯出後回來填退款日</span>
            </button>
          )}
        </div>
      )}

      {/* 孤兒是跨類別的狀態(可能未收也可能已收),沒有東西時完全不顯示 */}
      {stats.orphan.n > 0 && (
        <button onClick={() => setStatusF('orphan')}
          className={`mb-4 rounded-lg px-3 py-2 text-xs border w-full md:w-auto text-left
            ${statusF === 'orphan' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-600 border-red-200'}`}>
          ⚠ 孤兒 {stats.orphan.n} 筆・NT$ {fmt(stats.orphan.cur['TWD'] ?? 0)} —— 來源訂單或契約已刪除,但錢還在
        </button>
      )}

      {/*
          ★★ 訂金 / 押金分頁籤（2026-08-24 使用者:「表單也分訂金與押金，做兩個 tab」）。

          【為什麼一定要有這個 tab】
          `kindF` 這個篩選在上面的卡片點下去時會被改到 —— 但那是**副作用**。
          使用者沒辦法主動說「我只要看訂金」，也看不出自己現在在看哪一種。
          一個摸不到的篩選等於沒有那個篩選。

          【為什麼是頁籤不是下拉】
          訂金與押金是兩件不同的錢，會計對帳時是分開對的。
          下拉選單會讓人以為「預設看到的是全部」，而它確實是 ——
          但那個「全部」是三個選項之一，不是狀態。頁籤把當前位置畫出來。
      */}
      {/*
        ★ 筆數算在 `base` 上（不含 kind 篩選本身）—— 切到訂金之後
          押金那個數字還在，頁籤才是總覽而不是當前清單的重複。
      */}
      </>)}
      <Tabs variant="browser" tone="page" className="mb-3" value={kindF} onChange={setKindF}
        items={([
          /*
            ★ 「全部暫收」而不是「全部」（2026-09-01 使用者指定）。
              多了暫付這個分頁之後，「全部」會被讀成「四個分頁的全部」——
              而它其實**不含暫付**（收進來與付出去的錢加總沒有意義）。
              名字寫清楚範圍，比在旁邊補一句說明有效。
          */
          { k: 'all' as const,     label: '全部暫收' },
          { k: 'earnest' as const, label: '訂金' },
          { k: 'deposit' as const, label: '押金' },
          /*
            ★ 暫付（migration_196）。**「全部」不含它** ——
              收進來與付出去的錢放同一個清單、共用一個金額欄，加總就沒有意義了。
          */
          { k: 'advance' as const, label: '暫付' },
        ]).map((t) => ({
          key: t.k,
          label: t.label,
          badge: t.k === 'all' ? base.length
            : t.k === 'advance' ? adv.rows.length
            : base.filter((r) => (r.kind ?? 'deposit') === t.k).length,
        }))} />

      {/*
        ★★★ 切到暫付 → **整個內容區換掉**（卡片、篩選、表格都是暫付自己的）。
          暫收那三頁的卡片問「錢在我們手上多少」，暫付問「錢在別人那裡多少」——
          兩組並排的話要多一條分隔線與一套配色去區分，
          而使用者 2026-09-01 選的是換掉:「點暫付 後卡片換成 暫付的狀態」。
      */}
      {kindF === 'advance' && <AdvanceList a={adv} estates={estates} />}

      {/* ★ 暫收的篩選與清單。暫付有自己的一套（AdvanceList）。 */}
      {kindF !== 'advance' && (<>
      {/* 篩選 */}
      <FilterToggle />
      <div className="filter-bar collapsible-filters rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">日期區間(收/退款日)</span>
          <RangeInput from={fromD} to={toD}
            onChange={(f, t) => { setFromD(f); setToD(t); }} /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={`${inp} min-w-24`}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源</span>
          <select value={roomF} onChange={(e) => setRoomF(e.target.value)} className={`${inp} min-w-24 max-w-40`}>
            <option value="">全部</option>
            {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收款方式</span>
          <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className={inp}>
            <option value="">全部</option>
            {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">安幸收款帳號</span>
          <select value={acctF} onChange={(e) => setAcctF(e.target.value)} className={`${inp} min-w-28`}>
            <option value="">全部</option>
            {payAccounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          {/*
            跟上方的卡片是同一個狀態,點卡片或用這裡都行。
            卡片沒有「全部」—— 它們是三類的總覽,多一張「全部」卡片只是把三個數字再加一次。
            要跨類別看就用這個下拉。
          */}
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as Status)} className={`${inp} min-w-28`}>
            {(['all', 'pending', 'held', 'returned'] as Status[]).map((k) => (
              <option key={k} value={k}>{STATUS_LABEL[k]}</option>
            ))}
            {stats.orphan.n > 0 && <option value="orphan">孤兒</option>}
          </select></label>
        <FilterSearch value={kwInput} onChange={setKwInput}
          onSubmit={() => setKw(kwInput.trim())} placeholder="房源／姓名／備註" />
        {/*
          清除只在真的有篩選時出現，樣式改成底線文字 —— 跟訂單頁一致。
          常駐一顆有邊框的按鈕會讓人以為那是主要動作之一,
          而它其實只在「我剛才篩過」的時候才有意義。
        */}
        {hasFilter && (
          <button onClick={clearFilters}
            className="text-gray-500 underline pb-1.5">清除</button>
        )}
      </div>

      {/*
        動作鈕自成一行，跟訂單頁同一個排法（2026-08-17 使用者指定）。
        篩選欄位一多就會把它們擠到第二行，而擠出來的那一行是一整片空白
        配右邊一小撮按鈕。
      */}
      <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
        <div className="text-xs text-gray-400 whitespace-nowrap mr-auto md:mr-0">
          共 {sorted.length.toLocaleString()} 筆
          {!canEdit && <span className="ml-2 text-gray-400">・檢視模式</span>}
        </div>
        {/* 下載留給所有人 —— 看得到就帶得走,藏它只是讓人改用截圖 */}
        {/* 新增時可以選訂金或押金,所以按鈕不叫「新增押金」 */}
        {canEdit && <AddButton onClick={() => setEdit(blankManual())}>新增暫收款</AddButton>}
        <ExportButton onClick={exportXlsx} disabled={!sorted.length} />
        {canEdit && <TrashLink table="deposits" label="暫收款" />}
      </div>

      {/* 手機卡片 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="text-center text-gray-400 py-10">載入中…</div>
        : sorted.length === 0 ? <div className="text-center text-gray-400 py-10 px-6 text-sm">{emptyHint}</div>
        : sorted.map((r) => (
          <div key={r.id} onClick={() => setDetail(r)}
            className="rounded-xl glass p-4 active:bg-white/45">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium truncate">{r.room ?? '—'}</div>
                <div className="text-xs text-gray-500 truncate">{r.guest_name ?? '—'}</div>
              </div>
              <div className="text-right shrink-0">
                {/* 多幣別是一起收退的一筆押金,主要金額大字、其餘小字列在下面 */}
                <div className="stat-num font-bold">{primaryText(r)}</div>
                <div className="mt-0.5">{kindChip(r)}</div>
                {extraLines(r).map((l, i) => (
                  <div key={lineKey(l, i)} className="text-[11px] text-gray-500">＋{lineText(l)}</div>
                ))}
                <div className="mt-1">{statusChip(r)}{voteLine(r)}</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              收 {r.received_on ?? '—'}
              {r.returned_on ? `・退 ${r.returned_on}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 桌機表格 */}
      <div className="hidden md:block rounded-xl glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
              <th className="px-3 py-2.5">物業</th>
              <SortTh label="房源" sortKey="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="姓名" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="暫收款" sortKey="amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="收款日" sortKey="received_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">收款方式</th>
              <SortTh label="退款日" sortKey="returned_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">退款方式</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={10} className="px-4 py-10 text-center text-gray-400 text-sm">{emptyHint}</td></tr>
            : sorted.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 last:border-0 hover:bg-mor-sand/30">
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.estate_id ? estateName[r.estate_id] ?? '—' : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap font-medium">
                  {/* 種類徽章移到「暫收款」那一欄底下了 —— 兩邊都標會重複 */}
                  {r.room ?? '—'}
                  {r.is_manual && <span className="ml-1 text-[10px] text-gray-400">手動</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.guest_name ?? '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <div>{primaryText(r)}</div>
                  <div className="mt-0.5">{kindChip(r)}</div>
                  {extraLines(r).map((l, i) => (
                    <div key={lineKey(l, i)} className="text-[11px] text-gray-500 font-normal">＋{lineText(l)}</div>
                  ))}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.received_on ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {recvMethodText(r)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {/*
                    比照請款單列表:還沒退款時顯示**預定退款日**，藍字。
                    只顯示「—」的話，一批已核可待匯的押金在畫面上
                    跟「完全沒進退款流程」的長得一模一樣 ——
                    而那正是會計每天要挑出來匯的那幾筆。
                  */}
                  {r.returned_on
                    ? r.returned_on
                    : r.planned_refund_on
                      ? <span className="text-mor-blue text-xs">預定 {r.planned_refund_on}</span>
                      : '—'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                  {r.returned_method ? METHOD_LABEL[r.returned_method] ?? r.returned_method : '—'}
                  {r.returned_account && <div className="text-gray-400">{acctName[r.returned_account] ?? r.returned_account}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{statusChip(r)}{voteLine(r)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => setDetail(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">檢視</button>
                  {/* 只有進了退款流程的才給分享 —— 還沒送審的單分享出去,對方點進待核可也看不到 */}
                  {(r.refund_status === 'pending' || r.refund_status === 'approved') && !r.returned_on && (
                    <button onClick={(e) => { e.stopPropagation(); shareDep(r); }}
                      className="text-xs text-mor-slate underline hover:text-mor-blue">分享</button>
                  )}
                  {/*
                    「確認退款」直接放在列上（比照請款單）——
                    會計每天要匯的那幾筆，不該每一筆都先點進詳情才按得到。
                  */}
                  {refundPerms(r).canSettle && !isTransfer(r) && (
                    <button onClick={(e) => { e.stopPropagation(); setDepStep({ mode: 'settle', dep: r }); }}
                      className="text-xs text-mor-blue underline hover:text-mor-slate">確認退款</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>)}

      {/* 詳細抽屜 */}
      {detail && (() => {
        const d = detail;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold">{d.room ?? '—'}・{d.guest_name ?? '—'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {d.is_manual ? `手動建立・${wordOf(d)}` : `${d.contract_id ? '契約' : '短租'}${wordOf(d)}`}
                    {d.orphaned && <span className="text-red-600 ml-1">・來源已刪除</span>}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('狀態', statusChip(d))}
                {row('物業', d.estate_id ? estateName[d.estate_id] ?? '—' : '—')}
                {/* ★ 欄名跟著這一列的種類走,不是一律寫「押金」（2026-08-25） */}
                {row(wordOf(d), (
                  <span>
                    <span className="font-bold">{primaryText(d)}</span>
                    {extraLines(d).map((l, i) => (
                      <span key={lineKey(l, i)} className="ml-2 text-xs text-gray-500">＋{lineText(l)}</span>
                    ))}
                  </span>
                ))}
                {row(`收${wordOf(d)}`, (
                  <span className="tabular-nums">
                    {fmt(d.received_amount ?? 0)} / {fmt(d.amount)}
                    {remainingDep(d) > 0 && (
                      <span className="text-amber-700 ml-1 text-xs">尚欠 {fmt(remainingDep(d))}</span>
                    )}
                  </span>
                ))}
                {row('收滿日', d.received_on ?? '—')}
                {row('收款方式', recvMethodText(d))}
                {/*
                  移轉的來龍去脈。**要在退款狀態上面** ——
                  移轉的 A 那筆 refund_status 是 approved（dep_refund_chk 逼的）,
                  先看到「已核可」會以為它走過兩票審核。
                */}
                {isTransfer(d) && (() => {
                  const otherId = d.transfer_to_id ?? d.transfer_from_id!;
                  const other = depById[otherId];
                  const out = !!d.transfer_to_id;
                  return <>
                    {row('押金移房', (
                      <span className="space-x-2">
                        {moveChip(d)}
                        {other && (
                          <button onClick={() => setDetail(other)}
                            className="text-xs text-mor-blue underline">看那一筆</button>
                        )}
                      </span>
                    ))}
                    {row(out ? '移轉出去' : '移轉進來', (
                      <span className="text-xs text-gray-500">
                        {d.transferred_at ? d.transferred_at.slice(0, 10) : '—'}
                        {d.transferred_by ? `・${personName[d.transferred_by] ?? ''}` : ''}
                        <span className="ml-1">・錢沒有實際進出</span>
                      </span>
                    ))}
                  </>;
                })()}
                {(d.refund_status ?? 'none') !== 'none' && !isTransfer(d) && <>
                  {row('退款狀態', <span className="space-x-1">
                    {refundChip(d)}
                    {d.refund_status === 'pending' && (
                      <span className="text-xs text-gray-400">
                        主管 {d.manager_approved_at ? '✓' : '○'}・總經理 {d.admin_approved_at ? '✓' : '○'}
                      </span>
                    )}
                  </span>)}
                  {row('退到', d.payee_account
                    ? <span className="text-xs">{d.payee_name ?? ''} {d.payee_bank_code ?? ''} {d.payee_account}</span>
                    : '—')}
                  {row('預計匯款日', d.planned_refund_on ?? '—')}
                  {d.reject_reason ? row('駁回原因', <span className="text-red-600 text-xs">{d.reject_reason}</span>) : null}
                </>}
                {row('退款日', d.returned_on ?? '—')}
                {row('退款方式', d.returned_method
                  ? `${METHOD_LABEL[d.returned_method] ?? d.returned_method}${d.returned_account ? `・${acctName[d.returned_account] ?? d.returned_account}` : ''}`
                  : '—')}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}

                <div className="mt-3"><Receipts kind="dep" parentId={d.id} label="憑證圖片" /></div>

                {!d.is_manual && (
                  <div className="mt-3 rounded-lg bg-mor-sand/60 text-gray-500 px-3 py-2 text-xs">
                    {wordOf(d)}金額不在這裡改 —— 那是契約條件的一部分,請到
                    {d.contract_id ? '契約' : '短租訂單'}頁修改,這裡會自動同步。
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex flex-wrap gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                {(() => {
                  const p = refundPerms(d);
                  const btn = 'flex-1 min-w-[5rem] h-11 rounded-lg text-sm font-medium';
                  const earnest = d.kind === 'earnest';
                  return <>
                    {/*
                      ══════════ 按鈕順序（2026-08-25 使用者逐顆指定）══════════

                        訂金：收款 → 明細 → 轉押金 → 沒收 → 分享 → 關閉
                        押金：收款 → 明細 → 押金移房 →         分享 → 關閉

                      ★ 順序就是**流程的順序**:先把錢收進來，再看細節，
                        然後才是「這筆錢最後去哪」。分享與關閉一律墊底 ——
                        那兩顆跟這筆錢的狀態無關，位置固定才按得順手。

                      ★ 退款流程那幾顆（核可／駁回／排匯款／確認退款日／撤銷）
                        **不在這份清單裡**，因為它們是條件出現的。
                        插在「明細」後面 —— 它們是當下最該做的事，
                        排到分享後面的話會被誤認為次要動作。

                      ★★ 管家只能看:藏起來而不是按了才擋。
                         RLS 擋下的 UPDATE 會回成功且影響 0 列，
                         畫面上看起來像存好了，重整才發現沒變。
                    */}

                    {/* ① 收款 —— 一筆一列（migration_147）。
                           **沒退款之前都開得起來**:已經收滿了還是要看得到
                           明細與收款證明照片。 */}
                    {/*
                      ★★★ 2026-09-02:收款收成「只有會計與總管理員」
                        （使用者:「把管家與主管的權限關掉」）。

                      ★ 按鈕**不藏起來** —— 藏了主管不知道這件事做得到，
                        只會改用 LINE 問。留著、點了說要找誰。

                      ★★ `canEdit` 那一段不動:主管照樣改得了備註、
                        申請退款、看收款證明。收回來的只有「收錢」。
                    */}
                    {canEdit && !d.returned_on && (
                      <button onClick={() => {
                        if (!canCollect(role)) return flash(collectDeniedMsg('押金'));
                        setPaying(d); setDetail(null);
                      }}
                        className={`${btn} border border-mor-slate text-mor-slate`}>收款</button>
                    )}

                    {/* ② 明細 —— 退款申請、加費扣抵、備註與憑證。
                           手動列還多一件事（改物業房源姓名金額），所以那種列叫「編輯內容」。 */}
                    {canEdit && (
                      <button onClick={() => { setEdit({ ...d }); setDetail(null); }}
                        className={`${btn} border border-mor-line`}>
                        {d.is_manual ? '編輯內容' : '明細'}
                      </button>
                    )}

                    {/* 退款流程（條件出現）—— 見上面的說明 */}
                    {(p.canVoteMgr || p.canVoteAdm) && (
                      <button onClick={() => vote(d)} className={`${btn} bg-mor-green text-white`}>核可退款</button>
                    )}
                    {p.canReject && (
                      <button onClick={() => { setDetail(null); setRejecting(d); setRejectReason(''); }}
                        className={`${btn} border border-amber-400 text-amber-700`}>駁回</button>
                    )}
                    {p.canPlan && !isTransfer(d) && (
                      <button onClick={() => setDepStep({ mode: 'plan', dep: d })}
                        className={`${btn} border border-mor-slate text-mor-slate`}>
                        {d.planned_refund_on ? '改匯款計畫' : '排匯款'}</button>
                    )}
                    {/* 移轉來的那筆不給「確認已退款」—— 那是移轉，不是退給房客,
                        真的要退錢請先撤銷移轉,回到正常的退款流程 */}
                    {p.canSettle && !isTransfer(d) && (
                      <button onClick={() => setDepStep({ mode: 'settle', dep: d })}
                        className={`${btn} bg-mor-slate text-white`}>確認退款日</button>
                    )}
                    {p.canCancel && !isTransfer(d) && (
                      <button onClick={() => cancelRefund(d)} disabled={saving}
                        className={`${btn} border border-red-300 text-red-500 disabled:opacity-50`}>撤銷</button>
                    )}

                    {/*
                      ③-訂金 轉押金。

                      ★ 走過一條出路之後**不藏起來，變灰 ＋ 寫出原因**（hover 看得到）——
                        藏掉的話使用者會問「轉押金去哪了」，
                        而答案（已經沒收了）畫面上一個字都沒有。
                    */}
                    {canEdit && earnest && (() => {
                      const noConvert = exitBlockedReason(d as EarnestDep, 'convert');
                      return noConvert ? (
                        <span title={noConvert}
                          className={`${btn} border border-mor-line bg-gray-50 text-gray-400
                                      flex items-center justify-center cursor-not-allowed`}>
                          🔒 轉押金
                        </span>
                      ) : (
                        <button onClick={() => convertEarnest(d)} disabled={saving}
                          className={`${btn} border border-violet-300 text-violet-700 disabled:opacity-50`}>
                          轉押金
                        </button>
                      );
                    })()}

                    {/* ④-訂金 沒收 */}
                    {canEdit && earnest && (() => {
                      const noForfeit = exitBlockedReason(d as EarnestDep, 'forfeit');
                      return noForfeit ? (
                        <span title={noForfeit}
                          className={`${btn} border border-mor-line bg-gray-50 text-gray-400
                                      flex items-center justify-center cursor-not-allowed`}>
                          🔒 沒收
                        </span>
                      ) : (
                        <button onClick={() => forfeitEarnest(d)} disabled={saving}
                          className={`${btn} border border-red-300 text-red-600 disabled:opacity-50`}>
                          沒收
                        </button>
                      );
                    })()}

                    {/*
                      ③-押金 押金移房。**訂金沒有這顆** ——
                      `canBeTarget` / `canBeSource` 已經先擋掉訂金了（deposit-transfer.ts），
                      這裡不用再判斷一次。

                      ★ 兩個方向共用「押金移房」這一個名字（2026-08-25 使用者指定）。
                        方向由打開的視窗說 —— 兩顆不會同時出現:
                        當目的要「還沒收」，當來源要「已經收了」，互斥。
                    */}
                    {canMove && canBeTarget(d as TransferDep).ok && (
                      <button onClick={() => { setMoving({ dep: d, side: 'to' }); setMoveKw(''); setMoveOn(todayStr()); setShowBad(false); }}
                        className={`${btn} border border-violet-300 text-violet-700`}>押金移房</button>
                    )}
                    {canMove && canBeSource(d as TransferDep).ok && (
                      <button onClick={() => { setMoving({ dep: d, side: 'from' }); setMoveKw(''); setMoveOn(todayStr()); setShowBad(false); }}
                        className={`${btn} border border-violet-300 text-violet-700`}>押金移房</button>
                    )}
                    {canMove && isTransfer(d) && (
                      <button onClick={() => undoTransfer(d)} disabled={saving}
                        className={`${btn} border border-amber-400 text-amber-700 disabled:opacity-50`}>撤銷移轉</button>
                    )}

                    {/* ⑤ 分享 —— 連結指向請款頁的待核可分頁,不是這一頁。
                           核可統一在那裡做,主管點進去就能直接投票,不用自己找那一筆。 */}
                    <button onClick={() => shareDep(d)}
                      className={`${btn} border border-mor-line`}>↗ 分享</button>

                    {/* ⑥ 關閉 */}
                    <button onClick={() => setDetail(null)}
                      className={`${btn} border border-gray-300`}>關閉</button>
                  </>;
                })()}
              </div>
            </div>
          </div>
        );
      })()}

      {/*
        ══════════ 確認退款日（比照請款單的「確認付款日」）══════════

        日期與安幸付款帳號一起確認 —— 實務上真正匯出去的帳戶
        常常跟送審時預定的不同，而那一欄是之後跟銀行對帳的依據。

        ★ 擋門訊息印在**視窗裡**。印在頁面上會被這個視窗蓋住，
          使用者看到的是「按了沒反應」（2026-08-19 在請款單那邊卡了一整天）。
      */}
      {/*
        排匯款／確認退款日。**跟請款審核頁共用同一支元件**
        （2026-08-22 使用者選「抽成共用元件」）。

        以前這裡自己寫一份、請款審核頁根本沒有 —— 於是會計核完押金
        得換一頁才按得到確認退款。各寫一份的話下次改規則一定漏改一邊，
        而漏改不會報錯，只會有一頁的行為跟另一頁不同。
      */}
      {depStep && (
        <DepositRefundStep
          mode={depStep.mode}
          dep={depStep.dep}
          accounts={payAccounts.map((a) => ({ code: a.code, name: a.name }))}
          onClose={() => setDepStep(null)}
          onDone={(msg) => { setDepStep(null); setDetail(null); flash(msg); load(); }} />
      )}

      {/* 收押金：一筆一列（migration_147） */}
      {paying && (
        <DepositPayments
          dep={paying}
          accounts={payAccounts}
          canEdit={canEdit}
          onClose={() => setPaying(null)}
          onChanged={load}
        />
      )}

      {/*
        ══════════ 押金移房：挑來源 ══════════

        清單列出**全部**暫收中的押金,不用房客姓名自動比對 ——
        換房常常也換人（原本兩人住、剩一人續租）,照名字猜會漏掉一半,
        而漏掉的那半使用者只會看到「找不到」,不會知道是被條件濾掉的。

        不能移的也留在清單上並寫出原因（金額差多少）,直接消失的話
        使用者會一直找那筆押金,不知道它就在眼前只是不合條件。
      */}
      {moving && (
        /* 外層不捲、內容自己捲 —— 兩層都可捲時捲哪一層要看手指落在哪，
           而使用者只會覺得「這個視窗有時候捲不動」 */
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-center justify-center md:py-10 z-50"
          onClick={() => setMoving(null)}>
          <div className="bg-white w-full md:w-[620px] md:max-w-[95vw] md:rounded-xl shadow-xl flex flex-col h-full md:h-auto md:max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-4 md:px-6 py-4"
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              <div className="font-bold">
                押金移房・{moving.side === 'to' ? '移轉到' : '從'} {depName(moving.dep)}
                {moving.side === 'from' ? ' 移出' : ''}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {moving.side === 'to'
                  ? <>這筆需要 <b>NT$ {fmt(moving.dep.amount)}</b>（{moving.dep.currency}）。
                      選一筆同金額、同幣別的暫收中押金移過來 —— 錢不會實際進出。</>
                  : <>這筆有 <b>NT$ {fmt(moving.dep.amount)}</b>（{moving.dep.currency}）在我們手上。
                      選一筆同金額、同幣別的未收押金移過去 —— 錢不會實際進出。</>}
              </div>
            </div>

            {(() => {
              const all = moving.side === 'to'
                ? transferCandidates(rows as TransferDep[], moving.dep as TransferDep, moveKw)
                : transferTargets(rows as TransferDep[], moving.dep as TransferDep, moveKw);
              const good = all.filter((x) => x.verdict.ok);
              const bad = all.filter((x) => !x.verdict.ok);
              /*
               * ★★ 預設**只列可以移的**（2026-08-19，David 實測時找不到那一筆）。
               *
               * 原本把不能移的也一起列出來,理由是「直接消失的話使用者會一直找」。
               * 那個理由對，但實際跑起來的比例完全不是我想的:
               * 目的要 100,000，而暫收中的押金是 288,000 / 284,800 / 240,000…
               * **一筆能移的被十一筆紅字埋掉**，畫面看起來像「全部都不行」。
               *
               * 所以改成:能移的先列，不能的收在「另有 N 筆條件不符」後面。
               * 兩個需求都要顧 —— 藏起來但**說出有幾筆被藏了**，
               * 而不是讓人以為那些押金不存在。
               */
              const list = showBad ? [...good, ...bad] : good;
              const rowOf = ({ dep, verdict }: typeof all[number]) => (
                <div key={dep.id}
                  className={`flex items-center gap-3 py-2.5 border-b border-mor-line last:border-0
                    ${verdict.ok ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {depName(dep)}
                      <span className="ml-2 text-xs text-gray-500 font-normal">{dep.guest_name ?? ''}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      NT$ {fmt(dep.amount)}
                      {(dep.currency || 'TWD') !== 'TWD' && <span className="ml-1">（{dep.currency}）</span>}
                      {dep.received_on ? `・收 ${dep.received_on}` : '・尚未收'}
                    </div>
                    {/* 不能移的只留一行原因。三行說明乘以十幾筆就是一面紅牆,
                        而真正該被看到的那一筆就在裡面 —— 詳細的怎麼辦寫在下面那條提示 */}
                    {!verdict.ok && (
                      <div className="text-xs text-amber-700 mt-0.5 truncate">{verdict.reason}</div>
                    )}
                  </div>
                  <button disabled={!verdict.ok || saving}
                    onClick={() => doTransfer(depById[dep.id])}
                    className="shrink-0 h-9 px-3 rounded-lg text-sm font-medium bg-violet-600 text-white
                      disabled:bg-gray-200 disabled:text-gray-400">
                    {moving.side === 'to' ? '移過來' : '移過去'}
                  </button>
                </div>
              );

              return <>
                <div className="px-4 md:px-6 py-3 border-b border-mor-line flex flex-wrap gap-2 items-center text-sm">
                  <input value={moveKw} onChange={(e) => setMoveKw(e.target.value)}
                    placeholder="搜房號、房客、金額" className={`${inp} flex-1 min-w-[10rem]`} />
                  <label className="text-xs text-gray-500">移轉日</label>
                  <input type="date" value={moveOn} onChange={(e) => setMoveOn(e.target.value)} className={inp} />
                </div>

                {/* 筆數一定要寫出來 —— 「金額對得上的有幾筆」是這個視窗唯一重要的數字 */}
                <div className="px-4 md:px-6 py-2 border-b border-mor-line text-xs flex flex-wrap items-center gap-2">
                  <span className={good.length ? 'text-mor-green font-medium' : 'text-gray-400'}>
                    金額相符 {good.length} 筆
                  </span>
                  {bad.length > 0 && (
                    <button onClick={() => setShowBad(!showBad)} className="text-gray-500 underline">
                      另有 {bad.length} 筆條件不符（{showBad ? '收起來' : '也顯示'}）
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain px-4 md:px-6 py-2">
                  {list.length ? list.map(rowOf) : (
                    <div className="py-10 text-center text-sm text-gray-400 px-4">
                      {all.length === 0
                        ? <>
                            {moving.side === 'to' ? '沒有暫收中的押金可以移轉' : '沒有還沒收押金的訂單可以移過去'}
                            {moveKw
                              ? <div className="mt-1 text-xs">（正在搜「{moveKw}」，清掉看全部）</div>
                              : moving.side === 'from' && (
                                <div className="mt-1 text-xs">
                                  新房間要先有訂單、訂單上要填押金金額 —— 那一筆「尚未收」長出來之後才移得過去
                                </div>
                              )}
                          </>
                        : <>
                            <div>沒有金額相符的押金</div>
                            {/*
                              這是最常見的情況,所以要把「該怎麼辦」寫完整。
                              金額不同不能放行的原因:deposits.amount 由觸發器從訂單同步,
                              移轉時改不動 —— 硬移的話這一筆會顯示一個從來沒收到的數字。
                            */}
                            <div className="mt-2 text-xs leading-relaxed">
                              {depName(moving.dep)} 是 <b>NT$ {fmt(moving.dep.amount)}</b>。
                              先到{moving.dep.order_id ? '訂單' : '契約'}把兩邊的押金金額改成一致，再回來移轉。
                              <br />上面的「另有 {bad.length} 筆條件不符」點開可以看每一筆差多少。
                            </div>
                          </>}
                    </div>
                  )}
                </div>
              </>;
            })()}

            <div className="border-t border-mor-line px-4 md:px-6 py-3 flex justify-between items-center gap-2"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              <span className="text-xs text-gray-400">移錯了可以在押金詳情裡撤銷</span>
              <button onClick={() => setMoving(null)}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 駁回 */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">駁回退款・{rejecting.room ?? ''}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">駁回後退回申請人,可修改後重新送審。已投的票會一併清空。</div>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                placeholder="駁回原因(必填)" className="w-full rounded-lg border border-mor-line px-2 py-1.5 h-24" />
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setRejecting(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doReject} className="rounded-lg bg-amber-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-amber-700">確認駁回</button>
            </div>
          </div>
        </div>
      )}

      {/* 管理押金 */}
      {edit && (
        /*
         * 外層不捲、內容自己捲（2026-08-19 修）。
         *
         * 原本外層 `overflow-auto` ＋ 標題 `sticky top-0` ——
         * sticky 的定位基準是最近的捲動祖先，而那一層自己也在動，
         * 於是標題會飄到內容中間。使用者看到的是「版面會跑」。
         */
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-center justify-center md:py-10 z-50">
          <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl flex flex-col h-full md:h-auto md:max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}>
            <div className="shrink-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between"
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              {edit.id
                ? `管理${edit.kind === 'earnest' ? '訂金' : '押金'}・${edit.room ?? '—'}`
                : '手動新增暫收款'}
              <button onClick={() => setEdit(null)} aria-label="關閉"
                className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6 space-y-4 text-sm">
              {edit.is_manual ? (
                /* 手動列沒有來源可同步,這幾欄就在這裡填 */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {!edit.id && (
                    <div className="md:col-span-2 rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs">
                      手動暫收款不掛在任何訂單或契約下,適合舊約押金、代收、還沒開契約就先收的訂金。
                    </div>
                  )}
                  {/*
                      ★ 物業／房源／姓名都是必填（2026-08-25 使用者指定）。
                        舊規則「房源與姓名至少填一個」會讓帳上長出對不上人的錢 ——
                        判斷與理由都在 lib/manual-deposit.ts。
                  */}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業<Req /></span>
                    {/*
                        ★★ 紅框用 `reqCls()` 的同一組顏色（border-red-400 bg-red-50）。
                          `mErr()` 只在按過儲存之後才為真 —— 空表單一打開就整片紅
                          那不是提示是指責（見 components/Req.tsx）。
                    */}
                    <select value={edit.estate_id ?? ''} onChange={(e) => setEdit({ ...edit, estate_id: e.target.value || null })}
                      className={`h-12 md:h-auto bg-white rounded-lg border px-2 md:py-1.5 ${
                        mErr('物業') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`}>
                      <option value="">請選擇</option>
                      {estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">房源<Req /></span>
                    <input value={edit.room ?? ''} onChange={(e) => setEdit({ ...edit, room: e.target.value })}
                      placeholder="例:14B5"
                      className={`h-12 md:h-auto bg-white rounded-lg border px-2 md:py-1.5 ${
                        mErr('房源') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">姓名<Req /></span>
                    <input value={edit.guest_name ?? ''} onChange={(e) => setEdit({ ...edit, guest_name: e.target.value })}
                      /* 離開欄位才正規化 —— 見 shortterm 那邊的說明（migration_173） */
                      onBlur={(e) => setEdit({ ...edit, guest_name: titleCaseName(e.target.value) })}
                      className={`h-12 md:h-auto bg-white rounded-lg border px-2 md:py-1.5 ${
                        mErr('姓名') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                  <div className="flex gap-2">
                    <label className="flex flex-col gap-1 w-24"><span className="text-xs text-gray-500">幣別</span>
                      <select value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                        className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                        {['TWD', 'USD', 'JPY', 'CNY', 'EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></label>
                    <label className="flex flex-col gap-1 flex-1 min-w-0"><span className="text-xs text-gray-500">金額<Req /></span>
                      <MoneyInput value={edit.amount || 0}
                        onChange={(n) => setEdit({ ...edit, amount: n })}
                        className={`h-12 md:h-auto bg-white rounded-lg border px-2 md:py-1.5 text-right ${
                          mErr('金額') ? 'border-red-400 bg-red-50' : 'border-mor-line'}`} /></label>
                  </div>

                  {/*
                      ★ 種類（2026-08-24 使用者:「可選 訂金 押金」）。

                      ★ **只有新增時能選** —— 已經存在的那一列改種類的話，
                        訂金的三條出路（沒收/退款/轉押）與押金的規則會對不上，
                        而已經走過的那些痕跡（forfeited_on…）還留在上面。
                        真的要換就刪掉重建。
                  */}
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-xs text-gray-500">種類<Req /></span>
                    <select value={edit.kind ?? 'deposit'} disabled={!!edit.id}
                      onChange={(e) => setEdit({ ...edit, kind: e.target.value as 'deposit' | 'earnest' })}
                      className="h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5
                                 disabled:bg-gray-100 disabled:text-gray-500">
                      <option value="deposit">押金</option>
                      <option value="earnest">訂金</option>
                    </select>
                    <span className="text-xs text-gray-400">
                      {edit.id
                        ? '種類存檔後不能改 —— 兩種的後續流程不一樣。要換請刪掉重建。'
                        : '訂金收了之後可以沒收、退款；押金只有退款。'}
                    </span>
                  </label>
                </div>
              ) : (
                <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
                  {/*
                    多幣別逐列列出來。擠在同一行的話「NT$160,000＋JPY10,000」
                    會讓人以為那是加起來的一個數字。
                    底下的收退款只有一組 —— 錢放在同一個保險箱,一次收、一次退。
                  */}
                  {edit.guest_name ?? '—'}・{wordOf(edit)}
                  {hasDetail(edit) ? (
                    <span className="block mt-1 font-bold">
                      {depLines(edit).map((l, i) => (
                        <span key={lineKey(l, i)} className="block">{lineText(l)}</span>
                      ))}
                    </span>
                  ) : <span className="font-bold"> {primaryText(edit)}</span>}
                  <span className="text-gray-400 ml-1">(金額請到來源頁修改)</span>
                </div>
              )}

              {/*
                ══════════ 收押金 ══════════

                ★★ 這裡**不再直接填收款日與方式**（migration_147）。

                那三個欄位（received_on / received_method / received_account）
                現在是 deposit_payments 的觸發器維護的。手動填的話:
                  · received_on 有值但 received_amount 還是 0 → 狀態自相矛盾
                  · 下一次任何一筆收款有異動，觸發器就把手填的值蓋掉

                兩個症狀都**不會報錯**，只會讓那筆押金的數字慢慢變得沒人看得懂。
                所以入口收斂成一個:開收款視窗，一筆一列地記。
              */}
              {/*
                ★ 新增時整段不顯示（2026-08-25 使用者:「下面不用顯示吧」）。

                  還沒存檔的那一列 id 是空的,收款與退款都做不了 ——
                  原本顯示的是「先存檔,才能記收款」這種只能看不能按的東西。
                  空殼區塊會讓人以為漏填了什麼。
              */}
              {edit.id && (
              <div className="border-t border-mor-line pt-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">收款</div>
                {(() => {
                  const st = depPayStatus(edit);
                  const rest = remainingDep(edit);
                  return (
                    <div className="rounded-lg border border-mor-line bg-mor-sand/30 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${DEP_STATUS_CLASS[st]}`}>
                          {DEP_STATUS_LABEL[st]}
                        </span>
                        <span className="text-xs text-gray-600 tabular-nums">
                          已收 {fmt(edit.received_amount ?? 0)} / {fmt(edit.amount)}
                          {rest > 0 && <span className="text-amber-700 ml-1">（尚欠 {fmt(rest)}）</span>}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1.5">
                        收款日與收款方式由收款明細算出來 —— 收兩次就記兩筆。
                      </div>
                      <button
                        onClick={() => { setPaying(edit); setEdit(null); setTriedRefund(false); }}
                        className="mt-2 h-9 w-full rounded-lg border border-mor-slate text-mor-slate text-sm font-medium">
                        開啟收款明細
                      </button>
                    </div>
                  );
                })()}
              </div>
              )}

              {/*
                加費（從押金扣除）。migration_157。

                放在「收押金」與「退押金」中間 —— 那正是它在流程上的位置:
                錢收進來了、還沒退出去，這段期間才扣得到。

                應退小計會透過 onChanged 回報給母層，
                送退款審核時送的是**小計**不是押金原額。
              */}
              {edit.id && (
                <DepositFees
                  dep={{
                    id: edit.id, amount: edit.amount, returned_on: edit.returned_on,
                    planned_refund_on: edit.planned_refund_on,
                    order_id: edit.order_id, contract_id: edit.contract_id,
                    estate_id: edit.estate_id, property_id: edit.property_id,
                    room: edit.room, guest_name: edit.guest_name,
                    approved_amount: edit.refund_amount,
                  }}
                  canEdit={canEdit}
                  onChanged={setFeeRefund} />
              )}

              {/*
                退押金是一條審核流,不是填個日期就好。
                押金動輒十幾二十萬,退錯追不回來 —— 這裡的關卡跟請款單同一套。

                兩個帳戶方向相反,命名沿用請款單:
                  payee_*          = 房客收款帳號（錢退到哪）
                  returned_account = 安幸付款帳號（錢從哪出）
              */}
              {edit.id && (
              <div className="border-t border-mor-line pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-500">退款</span>
                  {refundChip(edit)}
                </div>

                {/*
                  分支順序很重要:**已退款一定要排在已核可前面**。
                  錢匯出去之後 refund_status 仍然是 'approved' —— 那一欄記的是「審過了」,
                  不是「還在等」。反過來排的話,一筆早就退完的押金會顯示「等待匯款」。
                */}
                {!edit.received_on ? (
                  <div className="text-xs text-gray-400">還沒收到款,先到收款明細記一筆。</div>
                ) : edit.returned_on ? (
                  <div className="text-xs text-gray-500">
                    已於 {edit.returned_on} 退還・
                    {edit.returned_method ? METHOD_LABEL[edit.returned_method] : ''}
                    {edit.returned_account ? `・${acctName[edit.returned_account] ?? edit.returned_account}` : ''}
                  </div>
                ) : edit.refund_status === 'approved' ? (
                  /* 核可後鎖住。錢要出去了,改收款帳號等於繞過審核 —— 要改就先駁回。 */
                  <div className="space-y-1 text-xs text-gray-600">
                    <div className="rounded-lg bg-mor-greenlight text-mor-green px-3 py-2">
                      已核可,等待匯款。要修改內容請先請主管或總經理駁回。
                    </div>
                    <div className="pt-1">退到:{edit.payee_name} {edit.payee_bank_code} {edit.payee_account}</div>
                    <div>預計匯款日:{edit.planned_refund_on}</div>
                    <div>
                      安幸付款:{edit.returned_method ? METHOD_LABEL[edit.returned_method] : '—'}
                      {edit.returned_account ? `・${acctName[edit.returned_account] ?? edit.returned_account}` : ''}
                    </div>
                  </div>
                ) : (
                  <>
                    {edit.refund_status === 'rejected' && edit.reject_reason && (
                      <div className="rounded-lg bg-red-50 text-red-600 px-3 py-2 text-xs mb-3">
                        駁回原因:{edit.reject_reason}
                      </div>
                    )}
                    {edit.refund_status === 'pending' && (
                      <div className="rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs mb-3">
                        審核中,等待主管與總經理核可。這期間仍可修改後重新送審。
                      </div>
                    )}

                    {/* 欄位跟請款頁的押金抽屜共用同一支元件,不會各自演化 */}
                    <RefundFields v={edit} payAccounts={payAccounts} currency={edit.currency}
                      missing={triedRefund ? refundMissing : []}
                      onChange={(patch) => setEdit({ ...edit, ...patch })} />

                    <p className="text-xs text-gray-400 mt-2">
                      送出後由主管與總經理各核可一次,核可後才能填實際退款日。
                    </p>
                  </>
                )}
              </div>
              )}

              {/* 匯款水單、房客提供的帳戶截圖都放這裡 */}
              {edit.id && <Receipts kind="dep" parentId={edit.id} label="憑證圖片" />}

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                <textarea value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  className="bg-white rounded-lg border border-mor-line px-2 py-2 h-24 md:h-16" /></label>
            </div>

            <div className="shrink-0 bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex gap-2 md:justify-end"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              {/* 連動列不能刪 —— 刪了下次來源同步又會長回來,只會讓人以為壞掉 */}
              {edit.id && (edit.is_manual || edit.orphaned) && (
                <button onClick={() => del(edit)}
                  className="h-12 md:h-auto rounded-lg border border-red-300 text-red-600 px-4 md:py-1.5 text-sm">刪除</button>
              )}
              <button onClick={() => setEdit(null)}
                className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">取消</button>
              {/* ★ aria-disabled 不是 disabled —— 點得下去，點下去把紅框亮起來 */}
              <button onClick={save} aria-disabled={saveGate.blocked} title={saveGate.title}
                className={`h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-mor-line
                            px-4 md:py-1.5 text-sm hover:bg-mor-sand/60 ${gateCls(saveGate.dim)}`}>
                {saving ? '儲存中…' : '儲存'}</button>
              {/* 送審是獨立動作 —— 「儲存」只是留著待辦,不該悄悄啟動審核流程 */}
              {edit.id && refundPerms(edit).canRequest && (
                <button onClick={submitRefund} disabled={saving}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                  送出退款審核</button>
              )}
              {edit.id && edit.refund_status === 'pending' && (
                <button onClick={submitRefund} disabled={saving}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                  更新退款資訊</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
