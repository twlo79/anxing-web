'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddButton, ExportButton, ActionBar } from '@/components/Actions';
import Req, { ReqMark } from '@/components/Req';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
import { fetchAll } from '@/lib/fetch-all';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import RefundFields, { METHOD_LABEL as DEP_METHOD } from '@/components/RefundFields';
import { shareDeposit, shareRequest } from '@/lib/share';
import { softDelete } from '@/lib/trash';
import TrashLink from '@/components/TrashLink';
// 憑證是共同還是逐項、這一項最後套用哪個號碼 —— 判斷全在這裡（migration_155）
import { resolveVoucher, voucherText, voucherSummary, missingVouchers } from '@/lib/voucher';
// 押金抽屜要看得到「為什麼只退 99,719」—— 加費明細與應退小計（migration_157）
import DepositFees from '@/components/DepositFees';

type Item = {
  id?: string; request_id?: string; item_name: string; amount: number;
  account_code: string | null; purpose_type: string; estate_id: string | null;
  /** 選填。用途是物業層級,這欄再細到房間 —— 之後要追單一房源的花費才有依據。 */
  property_id?: string | null;
  note: string | null; sort: number;
  amount_original?: number | null;   // 原幣別金額。amount 一律是換算後的台幣。
  /**
   * 這個項目自己的憑證（migration_155）。
   * 請款單勾了 shared_voucher 時不使用 —— 但**留著**，取消勾選就回來。
   */
  voucher_no?: string | null; no_voucher?: boolean;
};
type Req = {
  id: string; req_no: string; requester_id: string; status: string; total_amount: number;
  payment_method: string | null; payee_bank_code: string | null; payee_account: string | null;
  payee_company: string | null; payee_tax_id: string | null; note: string | null;
  submitted_at: string | null;
  manager_approved_by: string | null; manager_approved_at: string | null;
  admin_approved_by: string | null; admin_approved_at: string | null;
  rejected_by: string | null; rejected_at: string | null; reject_reason: string | null;
  purchased_on: string | null; expense_generated_at: string | null; created_at: string;
  planned_transfer_on: string | null; payout_account: string | null;
  voucher_no?: string | null; no_voucher?: boolean;
  /**
   * true = 整張單共用上面那一個號碼;false = 每個項目各自填（migration_155）。
   * 既有的 59 張全部回填成 true，所以舊單的畫面完全沒變。
   */
  shared_voucher?: boolean;
  /**
   * 匯款手續費。
   *   included 內扣   受款人吸收 —— 我方支出就是請款金額,帳上不多記
   *   extra    不內扣 我方負擔 —— 確認出款後自動產生一筆「郵電費」支出
   * 詳細規則（含多房源時歸辦公室）在 migration_83。
   */
  fee_mode?: string; fee_amount?: number | null;
  currency: string; fx_rate: number;
  purchase_request_items?: Item[];
};
/**
 * 押金退款。**不是**這一頁的資料表,是 deposits 那張表。
 *
 * 為什麼放進請款頁：兩件事的流程一模一樣 —— 送審 → 主管一票 → 總經理一票 →
 * 填出款日 → 錢匯出去。審核的人不該因為「這筆錢的來源不同」就要開兩個頁面找單。
 *
 * 這裡只讀取與投票,不複製資料。押金從頭到尾只有 deposits 裡那一列,
 * 在這頁核可等於直接改那一列 —— 所以「同步回押金管理」不是同步,是根本沒有第二份。
 */
type Dep = {
  id: string; estate_id: string | null; room: string | null; guest_name: string | null;
  currency: string; amount: number;
  refund_status: 'none' | 'pending' | 'approved' | 'rejected' | null;
  payee_bank_code: string | null; payee_name: string | null; payee_account: string | null;
  planned_refund_on: string | null;
  received_on: string | null;
  returned_on: string | null; returned_method: string | null; returned_account: string | null;
  manager_approved_by: string | null; manager_approved_at: string | null;
  admin_approved_by: string | null; admin_approved_at: string | null;
  refund_requested_by: string | null;
  reject_reason: string | null; note: string | null; created_at: string;
  /** 送審當下的應退金額 = 押金 − 加費（migration_157）。null = 還沒送審，視為全額。 */
  refund_amount?: number | null;
  /** 加費區塊要用 —— 它自己去查 orders where deposit_id。 */
  order_id?: string | null; contract_id?: string | null; property_id?: string | null;
};
/** kind：expense=只用於支出 / income=只用於收入 / both=兩邊都用（migration_90） */
type AccountCode = { code: string; name: string; kind?: string; active?: boolean };
/** 常用收款對象（migration_96）。請款單不掛外鍵 —— 填完就脫鉤,見該 migration 的說明。 */
type Payee = { id: string; label: string; bank_code: string | null; account: string;
               company: string | null; tax_id: string | null };
type Estate = { id: string; name: string };
type PayAccount = { code: string; name: string; method: string };
type Profile = { id: string; name: string; role: string };

const FREE_THRESHOLD = 3000;   // 與 migration 的 pr_apply_status() 一致
const PAY_LABEL: Record<string, string> = { cash: '現金', transfer: '匯款', credit_card: '信用卡' };
const PAY_OPTS = ['cash', 'transfer', 'credit_card'];
// 信用卡是「刷」不是「匯」，同一個欄位在兩種付款方式下要用不同說法
const dateWord = (m?: string | null) => (m === 'credit_card' ? '刷卡日' : '付款日');
const acctWord = (m?: string | null) => (m === 'credit_card' ? '刷卡卡片' : '安幸付款帳號');
const CURRENCIES = ['TWD', 'USD', 'JPY', 'CNY', 'EUR'];
const PURCHASE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc3ZE8jE6dIDTzrrDDeYYL6EcMKUniPRhhhKXCRbWddGt4bbw/viewform';
const ST_LABEL: Record<string, string> = { draft: '草稿', pending: '待核可', approved: '已核可', rejected: '已駁回' };
const ST_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-mor-greenlight text-mor-green', rejected: 'bg-red-50 text-red-600',
};
const fmt = (n: number | null | undefined) => (n == null ? '' : Math.round(n).toLocaleString());
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function PurchasesPage() {
  const supabase = useMemo(() => createClient(), []);
  // 身分與角色由 layout 的 ProfileProvider 提供（lib/profile.tsx）——
  // 這一頁原本自己再查一次 auth ＋ profiles，那是兩次多餘的往返
  const prof = useProfile();
  const me = prof.profile ? { id: prof.profile.id, role: prof.profile.role ?? 'housekeeper' } : null;
  const [rows, setRows] = useState<Req[]>([]);
  const [codes, setCodes] = useState<AccountCode[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<{ id: string; name: string; estate_id: string | null }[]>([]);
  const [payAccounts, setPayAccounts] = useState<PayAccount[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [edit, setEdit] = useState<Req | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [rejecting, setRejecting] = useState<Req | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [dating, setDating] = useState<Req | null>(null);
  const [dateVal, setDateVal] = useState('');
  const [dateAcct, setDateAcct] = useState('');
  const [planning, setPlanning] = useState<Req | null>(null);
  const [planDate, setPlanDate] = useState('');
  const [planAcct, setPlanAcct] = useState('');

  const [stF, setStF] = useState('');
  const [reqF, setReqF] = useState('');
  // 月份是主要的時間軸(依建立日)。空字串 = 全部期間。
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [estateF, setEstateF] = useState('');
  const [methodF, setMethodF] = useState('');
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'created_at', dir: 'desc' });
  // 匯款排程獨立查詢:它看的是「預定付款日」,跟列表的「建立日」是兩條時間軸。
  // 上個月建的單可能排在這個月付,混在同一個查詢裡會漏掉。
  const [schedule, setSchedule] = useState<Req[]>([]);
  const [detail, setDetail] = useState<Req | null>(null);
  /*
   * 分頁。這一頁原本把三件事疊在同一個畫面上:
   *   審核（主管、總經理）／管理與對帳（會計）／送單（管家）
   * 三種人都得滾過另外兩種人的東西才找得到自己要的。
   *
   * 待核可刻意排第一個,而且是唯一把請款與押金合在一起的地方 ——
   * 核可的人只關心「有什麼等我」,那筆錢的來源是採購還是退押金,對投票這個動作沒差別。
   */
  const [tab, setTab] = useState<'approve' | 'pr'>('pr');
  // 待核可的請款單:獨立於列表的查詢,不受月份/狀態/申請人篩選影響(見 load)
  const [pendRows, setPendRows] = useState<Req[]>([]);
  /** 角色預設分頁只挑一次。分享連結進來時會先把它設成 true,免得預設把分頁搶走。 */
  const tabPicked = useRef(false);
  // 押金退款:未結案的(送審中 + 已核可未匯出)。跟請款單的資料完全分開放,
  // 混進 rows 的話筆數、金額卡、篩選、Excel 全都要多一層判斷,遲早有一處漏改。
  const [deps, setDeps] = useState<Dep[]>([]);
  const [depRejecting, setDepRejecting] = useState<Dep | null>(null);
  const [depReason, setDepReason] = useState('');
  /** 押金抽屜。跟請款單一樣:列上只留最高頻的動作,其餘都在抽屜裡。 */
  const [depDetail, setDepDetail] = useState<Dep | null>(null);
  /**
   * 押金抽屜在編輯模式嗎（2026-08-22）。
   *
   * ★ 預設 false —— 這頁叫「請款審核」，來的人是要投票的。
   *   而已核可的押金**改任何一個字都會清掉兩張核可票、退回重新送審**。
   *   直接可編輯的話，一個只想看清楚再按核可的人很可能在捲動時
   *   洗掉別人的票，而畫面上只會說「已重新送審」。
   *
   *   支出頁 8/19 修的是同一件事（使用者:「檢視是直接編輯阿」）。
   */
  const [depEditing, setDepEditing] = useState(false);
  /**
   * 開／關押金抽屜。**一律走這支，不要直接 setDepDetail。**
   *
   * 忘記重設 depEditing 的話，上一筆按過「編輯」之後，
   * 下一筆會直接開在可編輯狀態 —— 而使用者不會知道自己進了編輯模式。
   */
  const openDep = useCallback((d: Dep | null) => { setDepDetail(d); setDepEditing(false); }, []);
  /** 從分享連結進來時要標記哪一筆 */
  const [depHi, setDepHi] = useState<string | null>(null);
  // 新單還沒有 id，憑證要等母單建立後才傳得上去 —— 存檔時呼叫 flush()
  const receiptsRef = useRef<ReceiptsHandle>(null);

  /*
   * 兩種訊息，處理方式完全不同。
   *
   * 【2026-08 的教訓】
   * 原本只有一種 flash：綠底、渲染在**頁面最上方**、3 秒消失。
   * 但「送出審核」按鈕在**抽屜裡** —— 按下去被擋，訊息出現在抽屜後面的
   * 頁面頂端，使用者完全看不到，而且就算看到了，綠色也像是成功。
   * PR-202608-050 卡了很久沒人知道原因，就是這樣。
   *
   *   flash    成功回饋 —— 綠色，3 秒自動消失
   *   flashErr 擋下動作 —— 紅色，**不自動消失**，而且抽屜裡也會顯示一份
   *
   * 擋阻訊息不該自動消失：使用者可能正在看別的地方，回頭時訊息已經不見了，
   * 剩下的只有「按了沒反應」。
   */
  function flash(t: string) { setMsg({ t }); setTimeout(() => setMsg(null), 3000); }
  function flashErr(t: string) { setMsg({ t, err: true }); }

  useEffect(() => {
    supabase.from('account_codes').select('code, name, kind, active').order('sort').then(({ data }) => setCodes(data ?? []));
    supabase.from('payee_presets').select('id, label, bank_code, account, company, tax_id')
      .eq('active', true).order('sort').order('label')
      .then(({ data }) => setPayees((data ?? []) as Payee[]));
    supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name').then(({ data }) => setEstates(data ?? []));
    // 停用的房源不出現在下拉,但既有項目仍要顯示得出名字,所以不篩 active
    supabase.from('properties').select('id, name, estate_id').order('name').then(({ data }) => setProperties(data ?? []));
    supabase.from('payment_accounts').select('code, name, method')
      .eq('for_payment', true).eq('active', true).order('sort')
      .then(({ data }) => setPayAccounts(data ?? []));
  }, [supabase]);

  /*
   * ══════════ 請款者名字：要等身分載到才查 ══════════
   *
   * ★★ profiles 的 RLS 是 `id = auth.uid() OR current_role_of() = 'super_admin'`。
   *
   * 跟其他主檔放在同一個 useEffect 裡的話，它會在**元件掛載當下**就發出去 ——
   * 而那時 Supabase 的 session 可能還沒還原完，`auth.uid()` 是 null，
   * RLS 一列都不放行。回來的是空陣列、沒有 error，
   * 於是「請款者」整欄永遠是「—」，而且**不會重試**。
   *
   * 症狀跟房源評價那個物業欄一模一樣（2026-08-19 也是這樣）:
   * 看起來像資料沒有請款者，實際上是查詢早跑了一步。
   *
   * 改成等 useProfile 把身分載到（prof.profile 有值）才查。
   * 錯誤也不再吞掉 —— 空白跟失敗要分得出來。
   */
  const [peopleErr, setPeopleErr] = useState('');
  useEffect(() => {
    if (!prof.profile) return;          // 身分還沒到，先不查
    supabase.from('profiles').select('id, name, role')
      .then(({ data, error }) => {
        if (error) setPeopleErr(error.message);
        else setPeople(data ?? []);
      });
  }, [supabase, prof.profile]);

  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  /*
   * 請款是花錢，下拉不該出現收入科目。
   * codeName 保留全部 —— 過濾只影響「可以選什麼」，不影響「怎麼顯示」。
   */
  const expenseCodes = useMemo(
    // 停用的科目也濾掉（migration_91 停用了「水電瓦斯」）
    () => codes.filter((c) => c.kind !== 'income' && c.active !== false), [codes]);
  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const personName = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);
  // 資料庫存的是 code（如 8088），畫面上要顯示可讀的名稱（如 元大 8088）
  const acctName = useMemo(() => Object.fromEntries(payAccounts.map((a) => [a.code, a.name])), [payAccounts]);

  const role = me?.role ?? '';
  const isManager = role === 'manager';
  const isAdmin = role === 'super_admin';
  const isAccountant = role === 'accountant';
  const canSeeAll = isManager || isAdmin || isAccountant;
  // 排匯款與匯出:主管、總經理、會計都能操作。會計不能核可,但能安排與執行付款。
  const canSetDate = isManager || isAdmin || isAccountant;

  /** 月份字串 YYYY-MM → [起, 迄) 兩個日期字串 */
  function monthRange(m: string): [string, string] {
    const [y, mo] = m.split('-').map(Number);
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    return [`${m}-01`, next];
  }

  const load = useCallback(async () => {
    setLoading(true);
    /*
     * 分頁撈完。不選月份時這是「全部的請款單」—— 沒有上界,只會越來越多。
     * Supabase 一次只回 1000 列且不報錯,撈不全的症狀是「舊的單不見了」,
     * 而使用者只會以為是自己記錯。
     */
    const { rows: data, error } = await fetchAll<Req>((f, t) => {
      let q = supabase.from('purchase_requests')
        .select('*, purchase_request_items(*)')
        .order('created_at', { ascending: false });
      if (stF) q = q.eq('status', stF);
      if (reqF) q = q.eq('requester_id', reqF);
      if (month) {
        const [from, to] = monthRange(month);
        q = q.gte('created_at', from).lt('created_at', to);
      }
      return q.range(f, t);
    });
    if (error) flash('載入失敗:' + error);
    setRows(data);

    // 匯款排程:該月要付出去、但還沒付的單。不受列表其他篩選影響 ——
    // 它回答的是「這個月還要準備多少錢」,那跟你正在看誰的單無關。
    if (month) {
      const [from, to] = monthRange(month);
      const { data: sc } = await supabase.from('purchase_requests')
        .select('*, purchase_request_items(*)')
        .eq('status', 'approved').is('purchased_on', null)
        .gte('planned_transfer_on', from).lt('planned_transfer_on', to)
        .order('planned_transfer_on');
      setSchedule((sc as Req[]) ?? []);
    } else setSchedule([]);

    /*
     * 待核可的請款單:獨立查詢,**不套任何篩選**。
     *
     * 不能重用上面的 rows —— 那個查詢帶了月份(預設本月)、狀態、申請人。
     * 上個月送出、到現在還卡著沒審的單,正是最該被看到的那一筆,
     * 卻會因為預設月份而完全不出現在待核可清單裡,而且沒有任何跡象。
     */
    /*
     * 撈「還沒付」與「本月已付」兩種。
     *
     * 為什麼已付的也要:未滿 3,000 的單是自動核可的,會計常常當下就把付款日填掉。
     * 只撈未付款的話,那些單一產生就結案,主管永遠不知道有哪些錢沒經過他就出去了。
     *
     * 為什麼只留本月:不設界線的話這份清單會一直長,幾個月後幾百筆,
     * 手機上滾不完,反而把真正要動作的那幾筆蓋掉。
     */
    const monthStart = new Date();
    monthStart.setDate(1);
    const mStart = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`;
    const { data: pd } = await supabase.from('purchase_requests')
      .select('*, purchase_request_items(*)')
      .in('status', ['pending', 'approved'])
      .or(`purchased_on.is.null,purchased_on.gte.${mStart}`)
      .order('submitted_at', { nullsFirst: false });
    setPendRows((pd as Req[]) ?? []);

    /*
     * 押金退款的待辦。**刻意不套月份篩選** ——
     * 這一區回答的是「還有什麼卡著沒處理」,一筆卡了三個月的退款正是最該被看見的,
     * 用建立月份把它藏起來剛好相反。請款單那邊有月份是因為它同時是流水帳,押金這區不是。
     *
     * returned_on 有值 = 錢已經匯出去了,那是結案,不必再出現在待辦。
     * RLS(migration_56)本來就只開給會計/主管/總經理,管家撈這張表會得到空的,
     * 但還是先用 canSeeAll 擋一次 —— 靠 RLS 回空值來隱藏 UI 會讓畫面閃一下空區塊。
     */
    if (canSeeAll) {
      // select 一定要寫成單一字串字面量。用 + 串成多行的話 supabase-js 推不出回傳型別
      // （它是靠字面量做型別解析的），會變成 GenericStringError[],型別轉換就過不了。
      const { data: dp } = await supabase.from('deposits')
        // refund_amount / order_id / contract_id / property_id 是加費那套要的（migration_157）——
        // 少撈任何一個，抽屜的應退金額或加費清單就會是空的，而且不會報錯
        .select('id, estate_id, room, guest_name, currency, amount, refund_status, payee_bank_code, payee_name, payee_account, planned_refund_on, received_on, returned_on, returned_method, returned_account, manager_approved_by, manager_approved_at, admin_approved_by, admin_approved_at, refund_requested_by, reject_reason, note, created_at, refund_amount, order_id, contract_id, property_id')
        .in('refund_status', ['pending', 'approved'])
        // 跟請款單同一條規則:還沒退的全部,加上本月已退的
        .or(`returned_on.is.null,returned_on.gte.${mStart}`)
        .order('planned_refund_on', { nullsFirst: false });
      setDeps((dp as Dep[]) ?? []);
    } else setDeps([]);
    setLoading(false);
  }, [supabase, stF, reqF, month, canSeeAll]);
  useEffect(() => { load(); }, [load]);

  // 從分享連結進來(?req=PR-YYYYMM-NNN)時,自動打開那張單的抽屜。
  // 月份預設是本月,若該單不在本月會找不到,所以先把月份篩選清掉。
  const [pendingReqNo, setPendingReqNo] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    // 押金分享連結(?dep=id)。押金那一區不看月份,所以不用清篩選,只要標記哪一筆。
    const dq = sp.get('dep');
    if (dq) {
      setDepHi(dq);
      setTab('approve');
      tabPicked.current = true;   // 別讓角色預設把分頁搶回去
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    const q = sp.get('req');
    if (!q) return;
    setPendingReqNo(q);
    setMonth('');
    // 網址列留著 ?req= 會讓重新整理又跳出抽屜,處理完就清掉
    window.history.replaceState({}, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (!pendingReqNo || loading) return;
    const hit = rows.find((r) => r.req_no === pendingReqNo);
    if (hit) { setDetail(hit); setPendingReqNo(null); }
    else if (rows.length) { flash(`找不到單號 ${pendingReqNo}`); setPendingReqNo(null); }
  }, [pendingReqNo, rows, loading]);

  const SORT_COLS: SortCols<Req> = useMemo(() => ({
    req_no:       { type: 'text',   get: (r) => r.req_no },
    created_at:   { type: 'date',   get: (r) => r.created_at },
    total_amount: { type: 'number', get: (r) => r.total_amount },
    purchased_on: { type: 'date',   get: (r) => r.purchased_on },
    planned_transfer_on: { type: 'date', get: (r) => r.planned_transfer_on },
    status:       { type: 'text',   get: (r) => ST_LABEL[r.status] ?? r.status },
  }), []);
  // 物業與關鍵字要看子項目,做不成 Supabase 的欄位條件,改在前端篩。
  // 請款單數量不大(一個月幾十張),不需要為此改成伺服器端分頁。
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return rows.filter((r) => {
      if (methodF && r.payment_method !== methodF) return false;
      const its = r.purchase_request_items ?? [];
      if (estateF && !its.some((i) => i.estate_id === estateF)) return false;
      if (k) {
        const hay = [
          r.req_no, r.note, r.payee_company, r.payee_account,
          ...its.map((i) => i.item_name), ...its.map((i) => i.note),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(k)) return false;
      }
      return true;
    });
  }, [rows, methodF, estateF, kw]);

  const sorted = useMemo(() => sortRows(filtered, sort, SORT_COLS), [filtered, sort, SORT_COLS]);

  // 待辦佇列:兩票獨立,各自列出「還缺這一票」的單
  const waitManager = useMemo(() => filtered.filter((r) => r.status === 'pending' && !r.manager_approved_at), [filtered]);
  const waitAdmin = useMemo(() => filtered.filter((r) => r.status === 'pending' && !r.admin_approved_at), [filtered]);
  // 待排付款:匯款/信用卡且還沒排。現金沒有這個階段,所以排除。
  const waitPlan = useMemo(() => filtered.filter((r) =>
    r.status === 'approved' && !r.purchased_on && !r.planned_transfer_on
    && (r.payment_method === 'transfer' || r.payment_method === 'credit_card')), [filtered]);
  // 待支付:現金核可後即可付;匯款/信用卡要排過才算
  const waitDate = useMemo(() => filtered.filter((r) =>
    r.status === 'approved' && !r.purchased_on
    && (r.payment_method === 'cash' || !!r.planned_transfer_on)), [filtered]);
  const sum = (xs: Req[]) => xs.reduce((a, r) => a + (Number(r.total_amount) || 0), 0);

  /* ══════════════════════════════════════════════════════
   * 待核可佇列 —— 請款單與押金退款合成同一份清單
   *
   * 【為什麼要正規化成同一個型別】
   * 之前兩種單各畫各的:請款的手機卡片是「申請人 → 項目 → 底部整排大按鈕」,
   * 押金是「房源房客 → 房客收款帳號 → 右下小連結」。同一個動作(核可)在兩個地方
   * 長得不一樣、按鈕大小不一樣、位置也不一樣。
   *
   * 統一的做法不是把兩邊的樣式各自調到看起來像,那下次改一邊又會歪。
   * 是先把兩種單攤平成同一個形狀(Pend),再只寫一份畫面。
   *
   * 【欄位怎麼對應】
   *   who    兩種都是**送出這張單的人**（請款=申請人，押金=送審退款的人）
   *   what   請款=項目名稱     押金=房源・物業・房客
   *   meta   請款=送出日・支付方式・項目數   押金=預計匯款日
   *   since  排序用的「等多久了」
   */
  type Pend = {
    kind: 'pr' | 'dep';
    /** pending = 還在等票;approved = 兩票到齊,等著把錢付出去 */
    stage: 'pending' | 'approved';
    id: string; who: string; what: string; meta: string;
    amount: number; since: string;
    mgrAt: string | null; admAt: string | null;
    mine: boolean;              // 這一筆缺的正好是我這一票
    /**
     * 已核可但兩張票都空的 = 未滿 3,000 自動放行的單。
     * 沒有這個旗標的話畫面會畫成「○ 主管 ○ 總經理」,看起來像沒人審過,
     * 主管會去追一張根本不需要他簽的單。
     */
    freePass: boolean;
    /** 錢已經出去了。已核可那一段裡混著待付與已付,不標的話分不出來。 */
    paid: boolean;
    pr?: Req; dep?: Dep;
  };

  const pendings = useMemo<Pend[]>(() => {
    const out: Pend[] = [];
    // pendRows 是獨立查詢的結果,不受列表篩選影響 —— 見 load() 裡的說明
    for (const r of pendRows) {
      const its = r.purchase_request_items ?? [];
      out.push({
        kind: 'pr', id: r.id,
        stage: r.status === 'approved' ? 'approved' : 'pending',
        who: personName[r.requester_id] ?? '—',
        what: its.map((i) => i.item_name).filter(Boolean).join('、') || '—',
        meta: [
          r.purchased_on
            ? `${r.purchased_on.slice(5).replace('-', '/')} 已付款`
            : (r.submitted_at ? r.submitted_at.slice(5, 10).replace('-', '/') + ' 送出' : ''),
          r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '',
          its.length ? `${its.length} 個項目` : '',
        ].filter(Boolean).join('・'),
        amount: Number(r.total_amount) || 0,
        since: r.submitted_at ?? r.created_at,
        mgrAt: r.manager_approved_at, admAt: r.admin_approved_at,
        // status 一定要一起檢查:未滿 3,000 的單是自動核可的,狀態已經是 approved
        // 但兩張票都是空的。只看票的話,已經通過的單上會冒出「核可」按鈕。
        mine: r.status === 'pending'
          && ((isManager && !r.manager_approved_at) || (isAdmin && !r.admin_approved_at)),
        freePass: r.status === 'approved' && !r.manager_approved_at && !r.admin_approved_at,
        paid: !!r.purchased_on,
        pr: r,
      });
    }
    // deps 撈的就是未結案的(pending + approved 且尚未匯出),不用再篩
    for (const d of deps) {
      out.push({
        kind: 'dep', id: d.id,
        stage: d.refund_status === 'approved' ? 'approved' : 'pending',
        // 送審的人,跟請款單的「申請人」是同一個意思。
        // 房客改放到 what —— 他是錢要退去的人,不是請款者
        who: (d.refund_requested_by ? personName[d.refund_requested_by] : '') || '—',
        what: [d.room, d.estate_id ? estateName[d.estate_id] : '', d.guest_name]
          .filter(Boolean).join('・') || '—',
        meta: [
          d.returned_on
            ? `${d.returned_on.slice(5).replace('-', '/')} 已退款`
            : (d.planned_refund_on ? `預計 ${d.planned_refund_on.slice(5).replace('-', '/')} 匯出` : ''),
          d.payee_name ? `退至 ${d.payee_name}` : '',
          d.returned_method ? DEP_METHOD[d.returned_method] ?? d.returned_method : '',
        ].filter(Boolean).join('・'),
        amount: Number(d.amount) || 0,
        since: d.created_at,
        mgrAt: d.manager_approved_at, admAt: d.admin_approved_at,
        mine: d.refund_status === 'pending'
          && ((isManager && !d.manager_approved_at) || (isAdmin && !d.admin_approved_at)),
        // 押金沒有免核門檻,一律兩票。留著同一條判斷是為了「將來加了門檻也不用回來改這裡」
        freePass: d.refund_status === 'approved' && !d.manager_approved_at && !d.admin_approved_at,
        paid: !!d.returned_on,
        dep: d,
      });
    }
    /*
     * 排序三層:
     *   1. 等我投票的最前面
     *   2. 還沒付款的排在已付款的前面 —— 已付的是紀錄,沒事要做
     *   3. 依「等多久」由久到新
     * 不用金額排:小額的單會永遠沉在最底下,放到沒人記得。
     */
    return out.sort((a, b) =>
      (a.mine === b.mine ? 0 : a.mine ? -1 : 1)
      || (a.paid === b.paid ? 0 : a.paid ? 1 : -1)
      || (a.since ?? '').localeCompare(b.since ?? ''));
  }, [pendRows, deps, personName, estateName, isManager, isAdmin]);

  /*
   * 分兩段:上面是還在等票的,下面是已核可等著付錢的。
   *
   * 已核可的放同一個分頁但**分開一段**,不是混進去按時間排 ——
   * 兩者要做的事完全不同:上面等的是投票,下面等的是把錢匯出去。
   * 混在一起的話,主管會一直滑過不需要他動作的列。
   */
  const pendWait = useMemo(() => pendings.filter((p) => p.stage === 'pending'), [pendings]);
  const pendDone = useMemo(() => pendings.filter((p) => p.stage === 'approved'), [pendings]);
  const pendMine = useMemo(() => pendings.filter((p) => p.mine), [pendings]);

  /** 待核可分頁的兩段。手機卡片與桌機表格共用這份定義,不會有一邊漏改。 */
  const GROUPS = useMemo(() => {
    const unpaid = pendDone.filter((p) => !p.paid).length;
    return ([
      ['wait', '未核可', '等主管與總經理投票', pendWait],
      ['done', '已核可',
        unpaid > 0 ? `${unpaid} 筆等會計付款,其餘是本月已付` : '本月已付款', pendDone],
    ] as const);
  }, [pendWait, pendDone]);

  /*
   * 進頁面時停在哪一個分頁,依角色決定 ——
   *   主管 / 總經理  → 待核可。他們來這一頁基本上只有這件事。
   *                   就算是空的也停在這裡,「都審完了」本身就是他們要的答案。
   *   會計 / 管家    → 請款單。會計要編輯與確認帳款(排匯款、填出款日),
   *                   那些操作都在請款單列表上;管家是來看自己送的單。
   *
   * 只判斷一次(tabPicked)。之後使用者切到哪就留在哪 ——
   * 不然投完最後一票、清單變空,畫面會自己跳走,會以為是按錯了。
   */
  useEffect(() => {
    if (tabPicked.current || !me) return;
    tabPicked.current = true;
    if (isManager || isAdmin) setTab('approve');
  }, [me, isManager, isAdmin]);

  /** 一鍵核可,兩種單走各自的表 */
  const pendVote = (p: Pend) => (p.kind === 'pr' ? vote(p.pr!) : depVote(p.dep!));
  const pendReject = (p: Pend) => (p.kind === 'pr' ? setRejecting(p.pr!) : setDepRejecting(p.dep!));
  const pendShare = (p: Pend) => (p.kind === 'pr' ? shareReq(p.pr!) : shareDep(p.dep!));

  // 從分享連結(?dep=)進來時直接打開那一筆的抽屜。
  // 等載入完才做 —— deps 還是空的時候找不到人。
  useEffect(() => {
    if (!depHi || loading || !deps.length) return;
    const hit = deps.find((d) => d.id === depHi);
    if (hit) openDep(hit);
    else flash('這筆押金退款已經結案或找不到');
    setDepHi(null);   // 只做一次,否則關掉抽屜又會被打開
  }, [depHi, loading, deps]);

  // 金額卡:依目前篩選結果,排除草稿與已駁回(那些不算數)
  const counted = useMemo(() => filtered.filter((r) => r.status === 'pending' || r.status === 'approved'), [filtered]);
  const byMethod = useMemo(() => ({
    cash: counted.filter((r) => r.payment_method === 'cash'),
    transfer: counted.filter((r) => r.payment_method === 'transfer'),
    credit_card: counted.filter((r) => r.payment_method === 'credit_card'),
  }), [counted]);

  // 匯款排程:日期 × 帳號 分組
  const scheduleRows = useMemo(() => {
    const m: Record<string, { date: string; acct: string; n: number; amt: number }> = {};
    schedule.forEach((r) => {
      const key = `${r.planned_transfer_on}|${r.payout_account ?? '—'}`;
      if (!m[key]) m[key] = { date: r.planned_transfer_on ?? '', acct: r.payout_account ?? '—', n: 0, amt: 0 };
      m[key].n += 1;
      m[key].amt += Number(r.total_amount) || 0;
    });
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date) || a.acct.localeCompare(b.acct));
  }, [schedule]);

  function blankItem(): Item {
    return { item_name: '', amount: 0, amount_original: 0, account_code: null, purpose_type: 'estate', estate_id: null, property_id: null, note: null, sort: 0, voucher_no: null, no_voucher: false };
  }

  function openNew() {
    setEdit({
      id: '', req_no: '', requester_id: me?.id ?? '', status: 'draft', total_amount: 0,
      payment_method: 'cash', payee_bank_code: null, payee_account: null, payee_company: null, payee_tax_id: null,
      note: null, submitted_at: null, manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null, rejected_by: null, rejected_at: null, reject_reason: null,
      purchased_on: null, expense_generated_at: null, created_at: '',
      planned_transfer_on: null, payout_account: null,
      voucher_no: null, no_voucher: false,
      // 新單預設**逐項**憑證（migration_155）。既有的 59 張則回填成 true，
      // 所以舊單打開來還是跟以前一樣的單一欄位。
      shared_voucher: false,
      fee_mode: 'included', fee_amount: 0,
      currency: 'TWD', fx_rate: 1,
    });
    setItems([blankItem()]);
  }

  function openEdit(r: Req) {
    setEdit(r);
    const its = (r.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
    setItems(its.length ? its : [blankItem()]);
  }

  // 使用者輸入的是原幣別金額,台幣總額 = 原幣合計 × 匯率。
  // 台幣單的匯率是 1,所以兩者相等,不用寫兩套邏輯。
  const fxRate = Number(edit?.fx_rate) || 1;
  const editSubtotal = useMemo(() => items.reduce((a, i) => a + (Number(i.amount_original) || 0), 0), [items]);
  const editTotal = useMemo(() => Math.round(editSubtotal * fxRate), [editSubtotal, fxRate]);

  async function save(submit: boolean) {
    if (!edit || !me) return;
    const clean = items.filter((i) => i.item_name.trim() || Number(i.amount_original) > 0);
    if (!clean.length) return flashErr('至少要有一個請款項目');
    for (const i of clean) {
      if (!i.item_name.trim()) return flashErr('每個項目都要填名稱');
      if (!(Number(i.amount_original) > 0)) return flashErr(`「${i.item_name}」請填金額`);
      if (i.purpose_type === 'estate' && !i.estate_id) return flashErr(`「${i.item_name}」請選擇用途`);
    }
    if (edit.payment_method === 'transfer' && !edit.payee_account) return flashErr('匯款需填廠商收款帳號');
    if (edit.currency !== 'TWD' && !(fxRate > 0)) return flashErr('請填匯率');

    /*
     * 憑證沒填的提醒（migration_155）。
     *
     * ★ **不擋送審** —— 憑證選填是使用者 8/19 訂的。
     *   這裡只負責讓人看見:系統負責看見，人負責決定。
     *
     * ★ 要唸出是**哪幾項**。十七個項目的單子上，
     *   「有項目沒填憑證」等於沒說 —— 使用者得自己一個一個找，
     *   而找的過程中很容易就放棄，然後直接按確定。
     *
     * ★ 只在送審時問，存草稿不問。
     *   草稿本來就是還沒填完的狀態，每次存都跳一次會被學會無視 ——
     *   而被無視的提醒比沒有提醒更糟，因為它讓人以為系統有在把關。
     */
    if (submit) {
      const miss = missingVouchers(edit, clean);
      if (miss.length && !confirm(
        `這 ${miss.length} 項還沒填憑證：\n\n${miss.map((m) => `・${m}`).join('\n')}\n\n`
        + `憑證是選填，還是要送審嗎？\n`
        + `（沒有單據的項目請勾「無憑證」，跟「還沒填」在帳上是兩件事）`
      )) return;
    }
    // 手續費只在匯款時成立。非匯款就算 fee_mode 還留著舊值也一律當成內扣。
    const feeApplies = edit.payment_method === 'transfer' && edit.fee_mode === 'extra';
    /*
     * 草稿可以先不填金額（送單當下未必問得到銀行實收多少），送審就要填。
     * 不內扣卻是 0 等於沒有手續費，那該勾內扣 —— 否則出款後不會產生任何郵電費支出，
     * 那筆錢就永遠沒有入帳。
     *
     * 【為什麼用 alert 不用 flash】
     * flash 只顯示 2.5 秒，而且出現在畫面角落。使用者按了送出、畫面沒動、
     * 訊息閃過去了 —— 看到的是「送不出去」而不知道原因
     * （2026-08 PR-202608-050 就是這樣卡住的）。
     * 擋阻一定要看得見，這跟契約日期那邊是同一條原則。
     */
    if (submit && feeApplies && !(Number(edit.fee_amount) > 0)) {
      /*
       * 這條**同時**用 alert 與抽屜紅字。
       *
       * 其他驗證（沒填名稱、沒選用途）看一眼欄位就知道哪裡錯，紅字就夠。
       * 這條不一樣：「不內扣填 0」在畫面上看起來是**填好的**，
       * 使用者不會覺得那裡有問題 —— 規則本身要解釋一次才懂。
       */
      flashErr('手續費選了「不內扣」但金額是 0。\n'
        + '知道銀行扣多少就填進去（同行約 15、跨行約 30）；沒有手續費請改選「內扣」。');
      alert('手續費選了「不內扣」，但金額是 0，所以送不出去。\n\n'
        + '兩個選擇：\n'
        + '　• 知道銀行扣多少 → 填進去（同行通常 15、跨行 30）\n'
        + '　• 這筆沒有手續費或已內含 → 改選「內扣」\n\n'
        + '不內扣代表「手續費我方另外付」，出款後會自動產生一筆郵電費支出；\n'
        + '金額 0 的話那筆支出不會產生，等於這筆錢沒有入帳。');
      return;
    }
    const needsPayout = edit.payment_method === 'transfer' || edit.payment_method === 'credit_card';
    // 送審中或已核可的單被改動,既有的票就不算數了 —— 有人投過票的話先問一聲。
    // 不清票的話,「核可後改金額」就等於繞過審核,兩票白審。
    const wasSubmitted = !!edit.id && (edit.status === 'pending' || edit.status === 'approved');
    const hadVotes = !!edit.manager_approved_at || !!edit.admin_approved_at;
    if (wasSubmitted && hadVotes) {
      /*
       * ★★ 按「取消」之後一定要說一句話（2026-08-19 修）。
       *
       * 原本是 `if (... && !confirm(...)) return;` —— 取消就靜靜結束，
       * 畫面一點反應都沒有。使用者的體驗是「我改了、我按了存檔、沒有用」,
       * 而真相是他自己按掉了那個確認框。
       *
       * PR-202608-064 就是這樣卡了半天:會計改廠商收款帳號改不動,
       * 查遍 RLS、權限、觸發器都是通的 —— 因為那次存檔根本沒送出去。
       *
       * 靜默的中止跟「壞掉」在使用者眼裡是同一件事。
       */
      const ok = confirm(
        (edit.status === 'approved'
          ? '這張單已經核可通過。存檔會清掉核可票、退回重新送審。'
          : '這張單已經有人核可。存檔會清掉既有核可票並重新送審。')
        + '\n\n按「確定」才會存檔；按「取消」的話這次的修改不會生效。'
      );
      if (!ok) {
        flashErr('已取消，這次的修改沒有存檔。'
          + '要改就得重新送審（既有的核可票會被清掉），請再按一次存檔並選「確定」。');
        return;
      }
    }
    setSaving(true);
    try {
      const header: any = {
        payment_method: edit.payment_method || null,
        payee_bank_code: edit.payee_bank_code || null,
        payee_account: edit.payee_account || null,
        payee_company: edit.payee_company || null,
        payee_tax_id: edit.payee_tax_id || null,
        note: edit.note || null,
        currency: edit.currency || 'TWD',
        fx_rate: edit.currency === 'TWD' ? 1 : fxRate,
        // 現金沒有安幸付款帳號，換了付款方式要把舊值清掉，否則會違反 pr_planned_chk。
        // 預定付款日則三種付款方式都有，不受限制。
        //
        // payout_account 有三個寫入點：這裡（填單）、savePlan（排付款）、doSetDate（確認出款）。
        // 三者都只在自己那個階段跑，狀態機保證不會互相蓋掉 ——
        // 但改動前務必確認這個前提還成立。押金頁就是因為兩處寫入規則不一致，
        // 「儲存」把退款流程剛填的安幸付款帳號清成 null，看起來像存不進去。
        payout_account: needsPayout ? (edit.payout_account || null) : null,
        planned_transfer_on: edit.planned_transfer_on || null,
        // 互斥,見 pr_voucher_chk
        no_voucher: !!edit.no_voucher,
        voucher_no: edit.no_voucher ? null : (edit.voucher_no?.trim() || null),
        // 共同憑證 / 逐項的開關（migration_155）。
        // 上面那兩欄不管開關是什麼都照存 —— 跟項目層級同一個道理:
        // 切回來的時候號碼要還在。
        shared_voucher: !!edit.shared_voucher,
        // 只有匯款會有手續費。非匯款一律歸零 —— 這裡是最後一道,
        // 因為 payment_method 有可能被別的路徑改掉而沒經過上面那個 onChange。
        // pr_fee_chk 會擋「內扣卻有金額」與「非匯款卻不內扣」,
        // 但約束擋下來的錯誤訊息是約束名稱,沒人看得懂,所以前端先對齊。
        fee_mode: feeApplies ? 'extra' : 'included',
        fee_amount: feeApplies ? (Number(edit.fee_amount) || 0) : 0,
        /*
         * 送審中或已核可被編輯:退回草稿。
         * 退回 draft 有兩個作用 —— 項目的 pri_write policy 只認 draft/rejected,
         * 而且之後再送 pending 會走既有狀態機,免核門檻依「新金額」重算。
         *
         * ★★ **這裡不清核可票**（2026-08-19 修，migration_149）。
         *
         * 原本連 manager_approved_* / admin_approved_* 四欄一起送 null。
         * 但 pr_guard_votes 那支觸發器規定「會計不得動核可欄位」,
         * 而對它來說「11:12 → null」也算動 —— 於是會計編輯自己送的單時
         * 會噴「儲存失敗：會計不得核可請款單」。
         *
         * 她根本沒在核可,所以那句話跟她做的事完全對不起來,
         * 回報回來是「編輯沒有用」，查了很久。
         *
         * 清票改由 pr_apply_status 在狀態轉成 draft 時做（跟「駁回」同一套）。
         * 那支是 SECURITY DEFINER,不受角色守衛限制 ——
         * 而且變成**一定**會清:前端漏送那四欄就繞過清票的路，反而是原本才有的。
         */
        ...(wasSubmitted ? { status: 'draft' } : {}),
      };
      let reqId = edit.id;
      let newReqNo = '';
      const isCreate = !reqId;
      if (!reqId) {
        const { data: no, error: ne } = await supabase.rpc('next_req_no');
        if (ne) { flash('取單號失敗:' + ne.message); return; }
        const { data, error } = await supabase.from('purchase_requests')
          .insert({ ...header, req_no: no, requester_id: me.id, status: 'draft' }).select('id, req_no').single();
        if (error) { flash('建立失敗:' + error.message); return; }
        reqId = data.id;
        newReqNo = data.req_no;
      } else {
        /*
         * ★★ 一定要看「改到幾列」，不能只看 error。
         *
         * RLS 擋下的 UPDATE **會回成功且影響 0 列**（CLAUDE.md 的第二條坑）。
         * 只檢查 error 的話，畫面會說「已重新送審」而資料一個字都沒變 ——
         * 2026-08-19 就發生過：會計改廠商收款帳號，畫面說成功，
         * 資料庫裡還是舊帳號，而沒有任何線索指向權限。
         *
         * 更糟的是後面還有「刪項目 → 重寫項目」。母單沒改成 draft 的話，
         * 刪除會被 pri_write 擋下（它只認 draft/rejected），
         * 而插入若沒被擋就會多寫一份 —— 那時總金額會直接變兩倍。
         * 所以這裡擋不住就必須**當場中止**，不能往下走。
         */
        const { data: upd, error } = await supabase.from('purchase_requests')
          .update(header).eq('id', reqId).select('id');
        if (error) { flash('儲存失敗:' + error.message); return; }
        if (!upd || upd.length === 0) {
          flash('存不進去：沒有任何一列被更新。'
            + '通常是權限（這張單目前的狀態不允許你修改），請重新整理後再試，'
            + '或請總管理員處理。');
          return;
        }
        // 硬刪除,不進回收桶 —— 這是「項目重存」（全刪再全寫）,每次存檔都會跑。
        // 撤銷整張請款單才是使用者的刪除動作,那條走 soft_delete。
        await supabase.from('purchase_request_items').delete().eq('request_id', reqId);
      }
      // amount 一律存台幣,amount_original 存使用者輸入的原幣別金額。
      // 換算在這裡一次做完,資料庫不會有「一半換過一半沒換」的中間狀態。
      const payload = clean.map((i, idx) => ({
        request_id: reqId, item_name: i.item_name.trim(),
        amount_original: Number(i.amount_original) || 0,
        amount: Math.round((Number(i.amount_original) || 0) * (edit.currency === 'TWD' ? 1 : fxRate)),
        account_code: i.account_code || null, purpose_type: i.purpose_type,
        estate_id: i.purpose_type === 'office' ? null : i.estate_id,
        // 辦公室沒有房源可言,清成 null;跟支出頁同一套規則
        property_id: i.purpose_type === 'office' ? null : (i.property_id || null),
        note: i.note || null, sort: idx,
        /*
         * 逐項憑證（migration_155）。
         *
         * ★ 即使勾了共同憑證也照存 —— 使用者指定「留著但不使用」。
         *   存檔時清成 null 的話,取消勾選之後號碼就回不來了,
         *   而使用者不會知道是自己勾那一下弄掉的。
         *
         * ★ 兩欄互斥（資料庫的 pri_voucher_chk 會擋）。
         *   有號碼就以號碼為準,no_voucher 一律清成 false ——
         *   讓約束去擋會變成一句看不懂的 SQL 錯誤訊息。
         */
        voucher_no: (i.voucher_no ?? '').trim() || null,
        no_voucher: (i.voucher_no ?? '').trim() ? false : !!i.no_voucher,
      }));
      const { error: ie } = await supabase.from('purchase_request_items').insert(payload);
      if (ie) { flash('項目儲存失敗:' + ie.message); return; }

      // 填表時選的憑證留在瀏覽器裡，母單有 id 了才真正上傳
      const fe = await receiptsRef.current?.flush(reqId);
      if (fe) { flash('憑證' + fe); return; }

      if (submit) {
        // 狀態一律送 'pending'。免核門檻由資料庫觸發器判斷後自行翻成 approved,
        // 前端不自己算 —— 否則改前端就能繞過門檻。
        //
        // 這裡也要看筆數。擋下來卻報成功的話,單會卡在 draft 而畫面說已送審 ——
        // 那張單就從所有人的待辦清單上消失了。
        const { data: sub, error: se } = await supabase.from('purchase_requests')
          .update({ status: 'pending' }).eq('id', reqId).select('id');
        if (se) { flash('送出失敗:' + se.message); return; }
        if (!sub || sub.length === 0) {
          flash('內容已存成草稿，但送審沒有成功（沒有任何一列被更新，通常是權限）。'
            + '請重新整理後再送出一次。');
          setEdit(null); load(); return;
        }
        const head = wasSubmitted ? '已重新送審' : '已送出';
        flash(editTotal < FREE_THRESHOLD ? `${head}・未達 $${fmt(FREE_THRESHOLD)},自動核可` : `${head},等待主管與總經理核可`);
        setEdit(null); load();
      } else {
        flash(wasSubmitted ? '已存為草稿・原本的核可已清空,記得再送出審核' : '已儲存草稿');
        // 新建的草稿存完留在原地,讓人可以接著補憑證或直接送審
        if (isCreate) setEdit({ ...edit, id: reqId, req_no: newReqNo, status: 'draft' });
        else setEdit(null);
        load();
      }
    } finally { setSaving(false); }
  }

  async function vote(r: Req) {
    if (!me) return;
    const patch: any = {};
    if (isManager) { patch.manager_approved_by = me.id; patch.manager_approved_at = new Date().toISOString(); }
    else if (isAdmin) { patch.admin_approved_by = me.id; patch.admin_approved_at = new Date().toISOString(); }
    else return flashErr('你的角色不能核可');
    const { error } = await supabase.from('purchase_requests').update(patch).eq('id', r.id);
    if (error) return flash('核可失敗:' + error.message);
    flash('已核可'); load();
  }

  async function doReject() {
    if (!rejecting || !me) return;
    if (!rejectReason.trim()) return flashErr('請填駁回原因');
    const { error } = await supabase.from('purchase_requests')
      .update({ status: 'rejected', rejected_by: me.id, reject_reason: rejectReason.trim() })
      .eq('id', rejecting.id);
    if (error) return flash('駁回失敗:' + error.message);
    setRejecting(null); setRejectReason(''); flash('已駁回'); load();
  }

  /*
   * ── 押金退款的動作 ────────────────────────────────────
   * 全部直接寫 deposits 表。押金管理頁讀的是同一列,所以那邊不用做任何事就會同步。
   * 兩票到齊翻成 approved 是資料庫觸發器做的(migration_61),前端不自己算狀態 ——
   * 兩個頁面各算一次遲早會不一致。
   */
  async function depVote(d: Dep) {
    if (!me) return;
    const patch: any = {};
    if (isManager) { patch.manager_approved_by = me.id; patch.manager_approved_at = new Date().toISOString(); }
    else if (isAdmin) { patch.admin_approved_by = me.id; patch.admin_approved_at = new Date().toISOString(); }
    else return flashErr('你的角色不能核可');
    const { error } = await supabase.from('deposits').update(patch).eq('id', d.id);
    if (error) return flash('核可失敗:' + error.message);
    flash('已核可押金退款'); load();
  }

  async function depDoReject() {
    if (!depRejecting || !me) return;
    if (!depReason.trim()) return flashErr('請填駁回原因');
    const { error } = await supabase.from('deposits')
      .update({ refund_status: 'rejected', rejected_by: me.id, reject_reason: depReason.trim() })
      .eq('id', depRejecting.id);
    if (error) return flash('駁回失敗:' + error.message);
    setDepRejecting(null); setDepReason(''); flash('已駁回'); load();
  }

  /**
   * 抽屜裡改完退款資訊 → 存檔並重新送審。
   *
   * **一定會清掉既有的核可票。** 不清的話,「改收款帳號」就能在核可後把錢導到別的地方,
   * 兩票等於白審。這條規則跟押金管理頁與請款單完全一致 —— 三個地方同一個道理,
   * 只要有一處放寬,整套審核就失去意義。
   *
   * 錢真的匯出去之後(returned_on)就不能再改,那種情況這個抽屜不會給編輯欄位。
   */
  async function depSaveResubmit() {
    if (!depDetail || !me) return;
    const d = depDetail;
    if (!d.payee_account?.trim()) return flashErr('請填房客收款帳號');
    if (!d.payee_name?.trim()) return flashErr('請填戶名');
    if (!d.planned_refund_on) return flashErr('請填預計匯款日');
    if (!d.returned_method) return flashErr('請選安幸付款方式');
    const hadVotes = !!d.manager_approved_at || !!d.admin_approved_at;
    if (hadVotes && !confirm(
      d.refund_status === 'approved'
        ? '這筆退款已經核可通過。更新資訊會清掉核可票、退回重新送審,確定嗎?'
        : '這筆退款已經有人核可。更新資訊會清掉既有核可票並重新送審,確定嗎?'
    )) return;
    setSaving(true);
    const { error } = await supabase.from('deposits').update({
      refund_status: 'pending',
      payee_bank_code: d.payee_bank_code?.trim() || null,
      payee_name: d.payee_name.trim(),
      payee_account: d.payee_account.trim(),
      planned_refund_on: d.planned_refund_on,
      returned_method: d.returned_method,
      returned_account: d.returned_method !== 'cash' ? (d.returned_account || null) : null,
      refund_requested_by: me.id,
      note: d.note || null,
      manager_approved_by: null, manager_approved_at: null,
      admin_approved_by: null, admin_approved_at: null,
    }).eq('id', d.id);
    setSaving(false);
    if (error) return flash('儲存失敗:' + error.message);
    openDep(null);
    flash(hadVotes ? '已更新並重新送審' : '已更新'); load();
  }

  /**
   * 分享押金退款。實作在 @/lib/share —— 押金管理頁用同一支,訊息格式永遠一致。
   *
   * 請款單的連結帶單號(?req=),押金沒有單號,所以帶 id(?dep=)。
   * id 是 uuid,看起來不好看,但押金本來就沒有對外的編號可用,
   * 硬編一組出來只是為了好看,反而多一個要維護的東西。
   */
  const shareDep = (d: Dep) =>
    shareDeposit(d, d.refund_requested_by ? personName[d.refund_requested_by] : undefined);

  /**
   * 「確認付款日」彈窗**自己的**錯誤訊息。
   *
   * ★★ 為什麼不能用 flashErr（2026-08-19 修）
   *
   * flash 的訊息印在頁面上，而這個彈窗蓋在頁面之上 ——
   * 訊息出現在**彈窗後面**，使用者完全看不到。
   * 症狀就是「按了確認，沒反應」。
   *
   * 這個檔案第 163 行早就記過同一件事（送出審核那顆按鈕），
   * 但只修了那一處。彈窗裡的擋門一律要把訊息印在彈窗裡。
   */
  const [dateErr, setDateErr] = useState('');

  async function doSetDate() {
    if (!dating) return;
    setDateErr('');
    // 前端按鈕已經藏起來,這裡再擋一次 —— 按鈕藏起來擋不住重新整理後的舊畫面
    if (dating.purchased_on) return setDateErr('出款日已經填過，不能再改。要調整請撤銷整張單，或到支出頁修改。');
    if (!dateVal) return setDateErr('請選擇日期');
    // 匯款/信用卡一定要記錄從哪個帳戶付出去。
    // 這個檢查放在「匯出」而不是「排匯款」—— 排匯款可以跳過,匯出不行,
    // 把必填綁在可跳過的步驟上,等於沒綁。
    const needAcct = dating.payment_method === 'transfer' || dating.payment_method === 'credit_card';
    if (needAcct && !dateAcct) return setDateErr(`請選擇${acctWord(dating.payment_method)}（我方）—— 沒有它就不知道錢從哪個帳戶出去。`);
    const patch: Record<string, unknown> = { purchased_on: dateVal };
    if (needAcct) patch.payout_account = dateAcct;
    /*
     * ★★ 要看改到幾列。RLS 擋下的 UPDATE 回成功且影響 0 列 ——
     * 只看 error 的話畫面會說「已確認出款」而那張單一動也沒動。
     */
    const { data: upd, error } = await supabase.from('purchase_requests')
      .update(patch).eq('id', dating.id).select('id');
    if (error) return setDateErr('儲存失敗：' + error.message);
    if (!upd || upd.length === 0) {
      return setDateErr('沒有任何一列被更新，通常是權限或這張單的狀態已經變了。'
        + '請關掉重新整理後再試一次。');
    }
    setDating(null);
    flash('已確認出款,費用已連動到支出');
    load();
  }

  // 排匯款:只寫計畫欄位,不碰 purchased_on —— 錢還沒出去,不該產生支出
  async function savePlan() {
    if (!planning) return;
    if (!planDate) return flashErr('請選擇預定匯款日');
    if (!planAcct) return flashErr('請選擇安幸付款帳號');
    const { error } = await supabase.from('purchase_requests')
      .update({ planned_transfer_on: planDate, payout_account: planAcct }).eq('id', planning.id);
    if (error) return flash('儲存失敗:' + error.message);
    setPlanning(null); flash('已排定匯款'); load();
  }

  // 撤銷 = 移到回收桶（連同底下的請款項目）。已產生支出的單一律擋下 ——
  // 支出是錢真的花掉的紀錄,連動刪除會讓請款單與支出兩邊對不上,而且
  // gen_expenses_from_pr() 只在採購日「從無到有」時建立,復原也不會重新產生。
  // 這條同時寫在 RLS 裡,不只靠前端藏按鈕。
  async function cancel(r: Req) {
    if (r.expense_generated_at) return flashErr('已產生支出,不能撤銷。請到支出頁處理。');
    if (!confirm(`確定撤銷請款單 ${r.req_no}?\n\n會移到回收桶,可以復原。`)) return;
    const res = await softDelete(supabase, 'purchase_requests', r.id, '撤銷請款單');
    if (!res.ok) return flash(res.message.replace('刪除', '撤銷'));
    flash('已撤銷,可到刪除紀錄復原'); load();
  }

  function exportXlsx() {
    // 押金也算 —— 有可能請款單被篩到空的,但還有押金退款要匯出去
    if (!sorted.length && !deps.length) return flashErr('沒有符合條件的資料');
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stCell = { border: BORD };
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    const T = (v: any, st: any) => ({ v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s: st, z: typeof v === 'number' ? '#,##0' : undefined });

    // 一列一個請款項目,單頭資訊重複帶上 —— 這樣才能在 Excel 裡對科目或房源做樞紐分析。
    // 銀行代號與戶名排在收款帳號前面 —— 匯款時就是照這個順序填,
    // 欄位順序跟實際操作一致,複製貼上才不用左右跳。
    // 單據總額拿掉:一張單拆成多列時那個數字每列重複,做樞紐分析會被重複加總。
    // 欄位順序刻意分成三段:單據基本 → 項目明細 → 錢怎麼走。
    // 錢那一段先「我方安幸付款帳號」再「對方收款資訊」,跟實際匯款時填的順序一致。
    // 類型放第一欄:會計拿這份去網銀匯款,押金退款跟請款單的錢一起出去,
    // 但一個是公司的費用、一個是退還代收的錢,對帳時必須分得出來。
    const header = ['類型', '單號', '申請人', '狀態', '送出日', '採購日', '項目', '金額', '會計科目',
      '用途', '房源', '支付方式', '預定付款日', '安幸付款帳號',
      '銀行代號', '戶名', '廠商收款帳號', '項目備註'];
    const aoa: any[][] = [header.map((h) => T(h, stHead))];
    for (const r of sorted) {
      const TYPE = T('請款', stCell);
      const its = (r.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
      const list = its.length ? its : [null];
      for (const i of list) {
        aoa.push([
          TYPE,
          T(r.req_no, stCell),
          T(personName[r.requester_id] ?? '', stCell),
          T(ST_LABEL[r.status] ?? r.status, stCell),
          T(r.submitted_at ? r.submitted_at.slice(0, 10) : '', stCell),
          T(r.purchased_on ?? '', stCell),
          T(i?.item_name ?? '', stCell),
          T(Math.round(Number(i?.amount) || 0), stNum),
          T(i?.account_code ? codeName[i.account_code] ?? i.account_code : '', stCell),
          T(i ? (i.purpose_type === 'office' ? '安幸辦公室' : (i.estate_id ? estateName[i.estate_id] ?? '' : '')) : '', stCell),
          T(i?.property_id ? properties.find((pp) => pp.id === i.property_id)?.name ?? '' : '', stCell),
          T(r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '', stCell),
          T(r.planned_transfer_on ?? '', stCell),
          // 安幸付款帳號 = 錢從我方哪個帳戶出去。對帳時要靠它跟銀行對單。
          // 現金沒有帳號,那一格就會是空的。
          T(r.payout_account ? (acctName[r.payout_account] ?? r.payout_account) : '', stCell),
          T(r.payee_bank_code ?? '', stCell),
          T(r.payee_company ?? '', stCell),
          // 帳號一律當文字。當數字的話 Excel 會吃掉開頭的 0,而且長帳號會變科學記號
          T(r.payee_account ?? '', stCell),
          T(i?.note ?? '', stCell),
        ]);
      }
    }

    /*
     * 押金退款接在請款單後面。同一份檔案就是會計那天要匯出去的所有款項,
     * 不放進來的話得同時開兩個檔對,漏掉一筆的機會就在那裡。
     *
     * 只跟著「狀態」篩選走 —— 申請人、物業、支出方式、月份這幾個條件在押金上不存在,
     * 硬套會變成「篩了物業結果押金全不見」那種讓人以為壞掉的行為。
     */
    const depOut = deps.filter((d) => !stF || d.refund_status === stF);
    for (const d of depOut) {
      aoa.push([
        T('押金退款', stCell),
        T('', stCell),                                        // 押金沒有單號
        T(d.refund_requested_by ? personName[d.refund_requested_by] ?? '' : '', stCell),
        // 已退款要排在已核可前面 —— 退款後 refund_status 仍然是 approved
        T(d.returned_on ? '已退款' : d.refund_status === 'approved' ? '已核可' : '待核可', stCell),
        T('', stCell),                                        // 押金沒有送出日欄位
        // 「採購日」這一欄對請款單來說是實際出款日,押金的對應欄位就是退款日
        T(d.returned_on ?? '', stCell),
        T(`押金退還・${d.guest_name ?? ''}`.trim(), stCell),
        T(Math.round(Number(d.amount) || 0), stNum),
        // 會計科目留空是對的:押金是代收款,退還它不是公司的費用,不該掛任何費用科目。
        T('', stCell),
        T(d.estate_id ? estateName[d.estate_id] ?? '' : '', stCell),
        T(d.room ?? '', stCell),
        T(d.returned_method ? DEP_METHOD[d.returned_method] ?? d.returned_method : '', stCell),
        T(d.planned_refund_on ?? '', stCell),
        T(d.returned_account ? acctName[d.returned_account] ?? d.returned_account : '', stCell),
        T(d.payee_bank_code ?? '', stCell),
        T(d.payee_name ?? '', stCell),
        T(d.payee_account ?? '', stCell),
        T(d.note ?? '', stCell),
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 欄寬要跟 header 一樣長。原本只有 13 個對 14 欄,最後一欄一直是預設寬度。
    ws['!cols'] = [
      { wch: 10 },  // 類型
      { wch: 15 },  // 單號
      { wch: 10 },  // 申請人
      { wch: 9 },   // 狀態
      { wch: 12 },  // 送出日
      { wch: 12 },  // 採購日
      { wch: 22 },  // 項目
      { wch: 11 },  // 金額
      { wch: 11 },  // 會計科目
      { wch: 12 },  // 用途
      { wch: 10 },  // 房源
      { wch: 10 },  // 支付方式
      { wch: 12 },  // 預定付款日
      { wch: 18 },  // 安幸付款帳號
      { wch: 10 },  // 銀行代號
      { wch: 18 },  // 戶名
      { wch: 20 },  // 廠商收款帳號
      { wch: 24 },  // 項目備註
    ];
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '請款單');
    const tag = [ST_LABEL[stF] ?? '', reqF ? personName[reqF] ?? '' : '',
      estateF ? estateName[estateF] ?? '' : '', methodF ? PAY_LABEL[methodF] ?? '' : '',
      month, kw].filter(Boolean).join('_');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `請款單${tag ? '_' + tag : ''}_${stamp}.xlsx`);
  }

  // 桌機表格與手機卡片共用同一份權限判斷 —— 分開寫遲早會有一邊漏改
  function perms(r: Req) {
    const mine = r.requester_id === me?.id;
    return {
      mine,
      // 錢還沒出去之前都能改,包含已核可的單 —— 但存檔會清掉既有核可票、退回重新送審。
      // 這樣「改內容」跟「重新被審一次」永遠綁在一起,改了就不可能繞過審核。
      //
      // 真正的紅線是 purchased_on / expense_generated_at:
      // 出款日一填,支出就產生了,那是錢真的花掉的紀錄,不能再回頭改。
      // 那種情況要撤銷重開一張,或直接到支出頁調整。
      canEdit: (mine || isAdmin)
        && ['draft', 'rejected', 'pending', 'approved'].includes(r.status)
        && !r.purchased_on && !r.expense_generated_at,
      // 開放自核:主管送的單那一票由他自己投,不再要求第二人。
      canVoteMgr: isManager && r.status === 'pending' && !r.manager_approved_at,
      canVoteAdm: isAdmin && r.status === 'pending' && !r.admin_approved_at,
      canRej: (isManager || isAdmin) && r.status === 'pending',
      // 匯款與信用卡一定要先排付款(選日期與帳號/卡別)才能確認支付。
      // 順序不強制的話,可以跳過排付款直接確認,結果是付了錢卻不知道從哪個帳戶出去。
      needPlan: r.payment_method === 'transfer' || r.payment_method === 'credit_card',
      canPlan: canSetDate && r.status === 'approved' && !r.purchased_on
               && (r.payment_method === 'transfer' || r.payment_method === 'credit_card'),
      /*
       * 出款日填了就鎖住 —— 不再出現「改出款日」。
       *
       * 【為什麼】
       * 出款日一改,gen_expenses_from_pr 以前會連動改支出的日期。
       * 有遞延認列時,母單日期被改而子單留在原地,母子單就散了
       * （migration_88 已經把那段連動拿掉,這裡是同一條規則的前端面）。
       *
       * 填錯了怎麼辦:撤銷整張單重來,或直接到支出頁改那一筆 ——
       * 支出才是錢的最終紀錄。
       */
      canDate: canSetDate && r.status === 'approved' && !r.purchased_on
               && (r.payment_method === 'cash' || !!r.planned_transfer_on),
      // 撤銷:提交者本人 / 主管 / 會計 / 總經理,任何狀態皆可,已產生支出除外
      canCancel: (mine || isManager || isAccountant || isAdmin) && !r.expense_generated_at,
    };
  }

  // 不要寫成三元運算子回傳 fragment —— `: <>` 會被 SWC 當成型別註記開頭而解析失敗
  function voteLine(r: Req) {
    if (r.status === 'approved' && !r.manager_approved_at && !r.admin_approved_at) {
      return <span className="text-gray-400">未達門檻免核</span>;
    }
    return (
      <>
        <div className={r.manager_approved_at ? 'text-mor-green' : 'text-gray-400'}>
          {r.manager_approved_at ? '✓' : '○'} 主管{r.manager_approved_by ? `・${personName[r.manager_approved_by] ?? ''}` : ''}
        </div>
        <div className={r.admin_approved_at ? 'text-mor-green' : 'text-gray-400'}>
          {r.admin_approved_at ? '✓' : '○'} 總經理{r.admin_approved_by ? `・${personName[r.admin_approved_by] ?? ''}` : ''}
        </div>
      </>
    );
  }

  /**
   * 分享請款單到 LINE,讓主管直接點連結進來核可。
   * 連結帶 ?req=單號,對方開啟後會自動跳到那張單並展開抽屜 ——
   * 只給網址的話對方還要自己找,單號一多就找不到。
   */
  function shareReq(r: Req) {
    shareRequest(r, {
      requester: personName[r.requester_id],
      items: (r.purchase_request_items ?? []).map((i) => i.item_name).filter(Boolean).join('、'),
      payment: r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '',
    });
  }

  const card = (title: string, list: Req[], hint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-left rounded-xl border border-mor-line bg-white/85 p-2.5 md:p-4 min-w-0 hover:bg-white/45 transition-colors">
      <div className="text-xs md:text-sm font-medium leading-tight">{title}</div>
      <div className="stat-num font-bold mt-1">{list.length}<span className="text-xs md:text-sm font-normal text-gray-400 ml-1">筆</span></div>
      <div className="text-[11px] md:text-xs text-gray-500 mt-0.5 md:mt-1">${fmt(sum(list))}</div>
      <div className="hidden md:block text-[11px] text-gray-400 mt-1">{hint}</div>
    </button>
  );

  return (
    <div>
      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-2 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}>
          <span className="flex-1 whitespace-pre-line">{msg.t}</span>
          {msg.err && <button onClick={() => setMsg(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>}
        </div>
      )}
      {/* 手機上標題由頂列顯示,這裡只留桌機用 */}
      <h1 className="hidden md:block mb-4">請款填寫</h1>

      {/* 通知開關搬到 /notifications 集中管理（migration_92）—— 四種通知不該散在各頁 */}

      {/* 手機:主要動作放最上面,一按就能送單 */}
      <div className="md:hidden flex gap-2 mb-3">
        <button onClick={openNew}
          className="flex-1 h-12 rounded-xl bg-mor-slate text-white font-medium active:bg-mor-slatedark">
          + 填寫請款
        </button>
        <a href={PURCHASE_FORM_URL} target="_blank" rel="noreferrer"
          className="flex-1 h-12 rounded-xl border border-mor-line bg-white/85 font-medium flex items-center justify-center active:bg-mor-sand/60">
          + 採購單
        </a>
      </div>

      {/*
        分頁。全站的分頁樣式以權限管理頁為準（底線式,不是膠囊）。
        數字徽章只在「有東西要做」時出現 —— 顯示 0 等於每次都在報告沒事發生。
      */}
      {canSeeAll && (
        <div className="flex flex-wrap gap-1 mb-4 border-b border-mor-line">
          {/* 徽章只算「未核可」—— 已核可的那一段不是催人投票用的 */}
          {([
            // 「請款審核」而不是「待核可」—— 這個分頁裡有請款單也有押金退款，
            // 而且它是「要你去審」的動作清單，名字要講出那是什麼事情
            ['approve', '請款審核', pendWait.length],
            ['pr', '請款單', 0],
          ] as const).map(([k, label, n]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
                tab === k ? 'border-mor-slate text-mor-slate' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {label}
              {n > 0 && (
                <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[11px] ${
                  k === 'approve' && pendMine.length > 0
                    ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                  {k === 'approve' && pendMine.length > 0 ? pendMine.length : n}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ══════════ 待核可 ══════════
        請款單與押金退款用**同一份版面**。核可這個動作跟錢的來源無關,
        兩種單各畫一套的話,同一顆按鈕會在兩個地方長得不一樣、位置也不同。

        手機版是主要場景 —— 主管與總經理多半是在 LINE 收到連結後用手機投票,
        所以按鈕是滿版高 48px,不是右下角的小連結。
      */}
      {canSeeAll && tab === 'approve' && (
        pendings.length === 0 ? (
          <div className="rounded-xl glass py-16 text-center">
            <div className="text-gray-400 text-sm">目前沒有待處理的單</div>
            <div className="text-gray-300 text-xs mt-1">請款單與押金退款都審完也付完了</div>
          </div>
        ) : (
          <>
            {pendMine.length > 0 && (
              <div className="mb-3 rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-sm">
                有 <span className="font-bold">{pendMine.length}</span> 筆等你這一票
                {pendWait.length > pendMine.length &&
                  <span className="text-amber-700/70">・另外 {pendWait.length - pendMine.length} 筆在等其他人</span>}
              </div>
            )}

            {/* 手機:卡片。上下兩段,中間一條分隔標題 */}
            <div className="md:hidden space-y-2">
              {GROUPS.map(([gk, glabel, ghint, glist]) => glist.length === 0 ? null : (
                <div key={gk} className="space-y-2 pt-1">
                  <div className="flex items-baseline gap-2 px-1 pt-2">
                    <span className="text-sm font-semibold">{glabel}</span>
                    <span className="text-xs text-gray-400">{glist.length} 筆・{ghint}</span>
                  </div>
              {glist.map((p) => (
                <div key={p.kind + p.id}
                  className={`rounded-xl border p-3 ${
                    p.mine ? 'border-amber-300 bg-white'
                      : p.paid ? 'border-mor-line bg-gray-50/70' : 'border-mor-line bg-white'}`}>
                  {/* 兩種單都點得開抽屜,各自走各自的 —— 使用者不該記得哪一種才能點 */}
                  <div onClick={() => (p.kind === 'pr' ? setDetail(p.pr!) : openDep(p.dep!))}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            p.kind === 'pr' ? 'bg-mor-bluelight text-mor-slate' : 'bg-purple-50 text-purple-700'}`}>
                            {p.kind === 'pr' ? '請款' : '押金'}
                          </span>
                          <span className="font-medium truncate">{p.who}</span>
                        </div>
                        <div className="text-sm text-gray-600 mt-1 line-clamp-2">{p.what}</div>
                        <div className="text-xs text-gray-400 mt-0.5">{p.meta || '—'}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-bold">${fmt(p.amount)}</div>
                        <div className="text-[11px] text-gray-400 mt-1">
                          {p.freePass ? <div>未達門檻免核</div> : (<>
                            <div className={p.mgrAt ? 'text-mor-green' : ''}>{p.mgrAt ? '✓' : '○'} 主管</div>
                            <div className={p.admAt ? 'text-mor-green' : ''}>{p.admAt ? '✓' : '○'} 總經理</div>
                          </>)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex gap-2">
                    {p.mine && (
                      <button onClick={() => pendVote(p)}
                        className="flex-1 h-12 rounded-lg bg-mor-green text-white text-sm font-medium active:opacity-80">核可</button>
                    )}
                    {/* 已核可的不給駁回 —— 要退回重審得先改內容,那是抽屜裡的事 */}
                    {(isManager || isAdmin) && p.stage === 'pending' && (
                      <button onClick={() => pendReject(p)}
                        className="h-12 px-4 rounded-lg border border-red-200 text-red-500 text-sm font-medium active:bg-red-50">駁回</button>
                    )}
                    <button onClick={() => pendShare(p)}
                      className={`h-12 px-4 rounded-lg border border-mor-line text-sm font-medium active:bg-mor-sand/60 ${p.mine ? '' : 'flex-1'}`}>↗ 分享</button>
                  </div>
                </div>
              ))}
                </div>
              ))}
            </div>

            {/* 桌機:表格。欄位跟手機卡片是同一組資訊,只是排法不同 */}
            <div className="hidden md:block rounded-xl glass overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-mor-line bg-white/45 text-left">
                    <th className="px-3 py-2.5">類型</th>
                    {/*
                      「請款者」而不是「對象」—— 這一欄兩種單放的是同一件事：
                      **是誰把這張單送出來的**。改版前押金放的是房客姓名，
                      而房客不是請款者，他是錢要退去的人 ——
                      同一欄兩種意思，看的人得先分辨這列是哪一種單才讀得懂。
                    */}
                    <th className="px-3 py-2.5">請款者</th>
                    <th className="px-3 py-2.5">內容</th>
                    <th className="px-3 py-2.5 text-right">金額</th>
                    <th className="px-3 py-2.5">核可進度</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map(([gk, glabel, ghint, glist]) => glist.length === 0 ? null : (
                    <Fragment key={gk}>
                      <tr className="bg-mor-sand/60 border-b border-mor-line/60">
                        <td colSpan={6} className="px-3 py-1.5">
                          <span className="text-xs font-semibold text-gray-700">{glabel}</span>
                          <span className="text-xs text-gray-400 ml-2">{glist.length} 筆・{ghint}</span>
                        </td>
                      </tr>
                  {glist.map((p) => (
                    <tr key={p.kind + p.id}
                      className={`border-b border-mor-line/60 last:border-0 ${
                        p.mine ? 'bg-amber-50/40' : p.paid ? 'bg-gray-50/70 text-gray-500' : ''
                      } cursor-pointer hover:bg-mor-sand/30`}
                      onClick={() => (p.kind === 'pr' ? setDetail(p.pr!) : openDep(p.dep!))}>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          p.kind === 'pr' ? 'bg-mor-bluelight text-mor-slate' : 'bg-purple-50 text-purple-700'}`}>
                          {p.kind === 'pr' ? '請款' : '押金'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-medium">{p.who}</td>
                      <td className="px-3 py-2.5">
                        <div className="max-w-md truncate">{p.what}</div>
                        <div className="text-[11px] text-gray-400">{p.meta}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium whitespace-nowrap">${fmt(p.amount)}</td>
                      <td className="px-3 py-2.5 text-[11px] whitespace-nowrap">
                        {p.freePass ? <span className="text-gray-400">未達門檻免核</span> : (<>
                          <div className={p.mgrAt ? 'text-mor-green' : 'text-gray-400'}>{p.mgrAt ? '✓' : '○'} 主管</div>
                          <div className={p.admAt ? 'text-mor-green' : 'text-gray-400'}>{p.admAt ? '✓' : '○'} 總經理</div>
                        </>)}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-2" onClick={(e) => e.stopPropagation()}>
                        {p.mine && <button onClick={() => pendVote(p)} className="text-xs text-mor-green underline hover:text-mor-slate font-medium">核可</button>}
                        {(isManager || isAdmin) && p.stage === 'pending' &&
                          <button onClick={() => pendReject(p)} className="text-xs text-red-500 underline">駁回</button>}
                        <button onClick={() => pendShare(p)} className="text-xs text-mor-slate underline hover:text-mor-blue">分享</button>
                      </td>
                    </tr>
                  ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {canSeeAll && tab === 'pr' && (
        <>
          {/* 上排:該做什麼 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 mb-2 md:mb-3">
            {card('待主管核可', waitManager, isManager ? '你可以核可' : '等待主管投票', () => setStF('pending'))}
            {card('待總經理核可', waitAdmin, isAdmin ? '你可以核可' : '等待總經理投票', () => setStF('pending'))}
            {card('待排付款', waitPlan, '選日期與帳號', () => setStF('approved'))}
            {card('待支付', waitDate, '支付後才會產生支出', () => setStF('approved'))}
          </div>

          {/* 下排:多少錢。依建立日所屬月份 + 目前篩選,不含草稿與已駁回。 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 mb-4 md:mb-5">
            {card(`申請總額${month ? `・${month}` : ''}`, counted, '依建立日', () => {})}
            {card('現金', byMethod.cash, '', () => setMethodF('cash'))}
            {card('匯款', byMethod.transfer, '', () => setMethodF('transfer'))}
            {card('信用卡', byMethod.credit_card, '', () => setMethodF('credit_card'))}
          </div>

          {/* 匯款排程:依預定付款日,獨立於上面的篩選 */}
          {scheduleRows.length > 0 && (
            <div className="rounded-xl glass mb-4 md:mb-5 overflow-hidden">
              <div className="px-4 py-2.5 text-sm font-medium border-b border-mor-line bg-white/45 flex items-center justify-between">
                <span>{month} 付款排程</span>
                <span className="text-xs font-normal text-gray-500">
                  依預定付款日・尚未支付・共 NT$ {fmt(scheduleRows.reduce((a, s) => a + s.amt, 0))}
                </span>
              </div>
              {/* 手機放不下這幾欄 —— 沒有這層捲軸容器，欄位會被壓到只剩幾個 px 而不是可以滑動 */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-mor-line/60">
                      <th className="px-4 py-2">預定付款日</th>
                      <th className="px-4 py-2">帳號 / 卡別</th>
                      <th className="px-4 py-2 text-right">筆數</th>
                      <th className="px-4 py-2 text-right">金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduleRows.map((s) => (
                      <tr key={s.date + s.acct} className="border-b border-mor-line/40 last:border-0">
                        <td className="px-4 py-2 whitespace-nowrap">{s.date}</td>
                        <td className="px-4 py-2">{s.acct}</td>
                        <td className="px-4 py-2 text-right text-gray-500">{s.n}</td>
                        <td className="px-4 py-2 text-right font-medium">NT$ {fmt(s.amt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/*
        以下是「請款單」分頁的內容:篩選列 + 列表。
        管家看不到分頁列(那是 canSeeAll 才有的),所以對他們來說永遠顯示 ——
        他們只有一件事要做:看自己送的單。
      */}
      {(!canSeeAll || tab === 'pr') && (<>

      {/* 工具列 —— 手機只留狀態篩選,其餘收在 details 裡 */}
      <details className="md:hidden mb-3 rounded-xl glass">
        <summary className="px-4 py-3 text-sm text-gray-600 cursor-pointer select-none">
          篩選{(stF || reqF || estateF || methodF || kw) ? '（已套用）' : ''}・共 {sorted.length.toLocaleString()} 筆
        </summary>
        <div className="px-4 pb-4 flex flex-col gap-3 text-sm border-t border-mor-line pt-3">
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
            <select value={stF} onChange={(e) => setStF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部狀態</option>
              {Object.entries(ST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {canSeeAll && (
            <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">申請人</span>
              <select value={reqF} onChange={(e) => setReqF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
                <option value="">全部</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          )}
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
            <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部物業</option>
              {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
            <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2">
              <option value="">全部方式</option>
              {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
            </select></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">月份(建立日)</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-12 rounded-lg border border-mor-line px-2" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字</span>
            <div className="flex gap-1">
              <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }}
                placeholder="單號/項目/備註/廠商" className="flex-1 min-w-0 h-12 rounded-lg border border-mor-line px-2" />
              <button onClick={() => setKw(kwIn.trim())} className="h-12 px-4 rounded-lg bg-mor-slate text-white">搜尋</button>
            </div></label>
          <div className="flex gap-2">
            {(stF || reqF || estateF || methodF || kw) &&
              <button onClick={() => { setStF(''); setReqF(''); setEstateF(''); setMethodF(''); setKw(''); setKwIn(''); }}
                className="flex-1 h-12 rounded-lg border border-mor-line text-gray-600">清除篩選</button>}
            <button onClick={exportXlsx} disabled={!sorted.length && !deps.length}
              className="flex-1 h-12 rounded-lg border border-mor-line disabled:opacity-40">⬇ 下載 Excel</button>
          </div>
        </div>
      </details>

      {/* 工具列 —— 桌機 */}
      <div className="hidden md:flex flex-wrap items-end gap-2 mb-3 text-sm">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={stF} onChange={(e) => setStF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部狀態</option>
            {Object.entries(ST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        {canSeeAll && (
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">申請人</span>
            <select value={reqF} onChange={(e) => setReqF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
              <option value="">全部</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5 max-w-32">
            <option value="">全部物業</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
          <select value={methodF} onChange={(e) => setMethodF(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5">
            <option value="">全部方式</option>
            {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">月份(建立日)</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">關鍵字</span>
          <div className="flex">
            <input value={kwIn} onChange={(e) => setKwIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwIn.trim()); }}
              placeholder="單號/項目/備註/廠商" className="rounded-l-lg border border-mor-line px-2 py-1.5 w-40" />
            <button onClick={() => setKw(kwIn.trim())} className="rounded-r-lg bg-mor-slate text-white px-3">搜尋</button>
          </div></label>
        {(stF || reqF || estateF || methodF || kw) &&
          <button onClick={() => { setStF(''); setReqF(''); setEstateF(''); setMethodF(''); setKw(''); setKwIn(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        <div className="ml-auto flex items-end gap-2">
          <div className="text-xs text-gray-400 pb-1.5">共 {sorted.length.toLocaleString()} 筆</div>
          <AddButton onClick={openNew}>填寫請款</AddButton>
          {/* 採購單是外部表單,不是本站的新增 —— 用次要樣式,不跟「填寫請款」搶 */}
          <a href={PURCHASE_FORM_URL} target="_blank" rel="noreferrer"
            className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 whitespace-nowrap">+ 採購單</a>
          <ExportButton onClick={exportXlsx} disabled={!rows.length && !deps.length} />
          <TrashLink table="purchase_requests" label="請款單" />
        </div>
      </div>

      {/* 列表 —— 手機卡片版 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">載入中…</div>
        : sorted.length === 0 ? <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">無請款單</div>
        : sorted.map((r) => {
          const { canVoteMgr, canVoteAdm } = perms(r);
          return (
            // 卡片本體可點開抽屜,底下只留核可與分享,其餘操作都在抽屜內
            <div key={r.id} className="rounded-xl glass p-3">
              <div onClick={() => setDetail(r)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{personName[r.requester_id] ?? '—'}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.created_at ? r.created_at.slice(0, 10) : ''}・{(r.purchase_request_items ?? []).length} 個項目
                      {r.payment_method ? `・${PAY_LABEL[r.payment_method] ?? r.payment_method}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold">${fmt(r.total_amount)}</div>
                    <span className={`inline-block mt-1 rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[r.status]}`}>
                      {ST_LABEL[r.status] ?? r.status}
                    </span>
                  </div>
                </div>

                <div className="mt-2 text-sm text-gray-600 line-clamp-2">
                  {(r.purchase_request_items ?? []).map((i) => i.item_name).join('、') || '—'}
                </div>

                {r.status === 'rejected' && r.reject_reason &&
                  <div className="mt-2 rounded-lg bg-red-50 text-red-600 px-2 py-1.5 text-xs">駁回原因:{r.reject_reason}</div>}

                <div className="mt-2 flex items-center justify-between text-xs">
                  <div>{voteLine(r)}</div>
                  <div className="text-gray-500 shrink-0 text-right">
                    {r.purchased_on
                      ? <>付款日 {r.purchased_on}</>
                      : r.planned_transfer_on
                        ? <span className="text-mor-blue">預定 {r.planned_transfer_on}{r.payout_account ? `・${acctName[r.payout_account] ?? r.payout_account}` : ''}</span>
                        : null}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                {(canVoteMgr || canVoteAdm) && (
                  <button onClick={() => vote(r)}
                    className="flex-1 h-12 rounded-lg bg-mor-green text-white text-sm font-medium active:opacity-80">核可</button>
                )}
                <button onClick={() => shareReq(r)}
                  className="flex-1 h-12 rounded-lg border border-mor-line text-sm font-medium active:bg-mor-sand/60">↗ 分享</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 列表 —— 桌機表格版 */}
      <div className="hidden md:block rounded-xl glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
              <SortTh label="建立日" sortKey="created_at" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5">申請人</th>
              <th className="px-3 py-2.5">項目</th>
              <SortTh label="總額" sortKey="total_amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <th className="px-3 py-2.5">支出方式</th>
              <SortTh label="狀態" sortKey="status" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="付款日" sortKey="purchased_on" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : sorted.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-400">無請款單</td></tr>
            : sorted.map((r) => {
              const { canVoteMgr, canVoteAdm } = perms(r);
              return (
                // 整列可點開抽屜。列上只留「核可」與「分享」——
                // 核可是最高頻的動作,分享是要拉主管進來的動作,其餘都在抽屜裡。
                <tr key={r.id} onClick={() => setDetail(r)}
                  className="border-b border-mor-line/60 hover:bg-mor-bluelight/30 align-top cursor-pointer">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.created_at ? r.created_at.slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{personName[r.requester_id] ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-64">
                    <div className="truncate" title={(r.purchase_request_items ?? []).map((i) => i.item_name).join('、')}>
                      {(r.purchase_request_items ?? []).map((i) => i.item_name).join('、') || '—'}
                    </div>
                    <div className="text-[11px] text-gray-400">{(r.purchase_request_items ?? []).length} 個項目</div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    ${fmt(r.total_amount)}
                    {r.currency && r.currency !== 'TWD' && (
                      <div className="text-[11px] font-normal text-gray-400">{r.currency} × {r.fx_rate}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.payment_method ? PAY_LABEL[r.payment_method] ?? r.payment_method : '—'}
                    {r.payout_account && <div className="text-[11px] text-gray-400">{r.payout_account}</div>}
                  </td>
                  {/* 狀態與核可進度合併成一欄 */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[r.status]}`}>{ST_LABEL[r.status] ?? r.status}</span>
                    <div className="text-[11px] mt-1">{voteLine(r)}</div>
                    {r.status === 'rejected' && r.reject_reason &&
                      <div className="text-[11px] text-red-500 mt-1 max-w-40 truncate" title={r.reject_reason}>{r.reject_reason}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.purchased_on ?? (r.planned_transfer_on
                      ? <span className="text-mor-blue text-xs">預定 {r.planned_transfer_on}</span>
                      : '—')}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-2" onClick={(e) => e.stopPropagation()}>
                    {(canVoteMgr || canVoteAdm) && <button onClick={() => vote(r)} className="text-xs text-mor-green underline hover:text-mor-slate font-medium">核可</button>}
                    <button onClick={() => shareReq(r)} className="text-xs text-mor-slate underline hover:text-mor-blue">分享</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      </>)}

      {/*
        押金抽屜 —— 版型跟請款單的抽屜一致（滿版進場、標題吸頂、動作列吸底）。
        列上只留核可與分享,其餘都在這裡,跟請款單同一個原則。

        可編輯的只有退款那一段。金額、房源、收押金日屬於押金本身,
        來源是訂單或契約,要改得到押金管理頁 —— 在核可的畫面上開放改金額,
        等於讓審核者自己改自己要審的數字。
      */}
      {depDetail && (() => {
        const d = depDetail;
        const canVote = d.refund_status === 'pending'
          && ((isManager && !d.manager_approved_at) || (isAdmin && !d.admin_approved_at));
        const editable = !d.returned_on;
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-500 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value}</div>
          </div>
        );
        return (
          <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50">
            <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
              onClick={(e) => e.stopPropagation()}>
              <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between z-10"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-purple-50 text-purple-700 shrink-0">押金</span>
                  <span className="truncate">{d.room ?? '—'}・{d.guest_name ?? '—'}</span>
                </span>
                <button onClick={() => openDep(null)} aria-label="關閉"
                  className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>

              <div className="p-4 md:p-6 space-y-4 text-sm">
                {/*
                  ★★ 頭一行印的是**實際要退多少**，不是押金原額（migration_157）。

                  有加費時押金 100,000 但只退 99,719。核可的人看到 100,000
                  就會以為要匯 100,000 —— 而他核的其實是 99,719。
                  refund_amount 是送審當下記下來的數字，null = 舊資料或沒走審核。
                */}
                <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
                  {d.refund_amount != null && Math.round(d.refund_amount) !== Math.round(d.amount) ? (
                    <>
                      應退 <span className="font-bold text-base">{d.currency === 'TWD' ? 'NT$' : d.currency} {fmt(d.refund_amount)}</span>
                      <div className="text-gray-500 mt-0.5">
                        押金 {fmt(d.amount)}，加費扣除 {fmt(Math.round(d.amount) - Math.round(d.refund_amount))}（轉一次性收入）
                      </div>
                    </>
                  ) : (
                    <>
                      押金 <span className="font-bold text-base">{d.currency === 'TWD' ? 'NT$' : d.currency} {fmt(d.amount)}</span>
                      <span className="text-gray-400 ml-1">(金額與房源請到押金管理頁修改)</span>
                    </>
                  )}
                </div>

                <div>
                  {row('物業', d.estate_id ? estateName[d.estate_id] ?? '—' : '—')}
                  {row('房源', d.room ?? '—')}
                  {row('房客', d.guest_name ?? '—')}
                  {row('收押金日', d.received_on ?? '—')}
                  {/*
                    退押金日 = 錢真的匯出去的那天,是這張單的紅線:
                    有值就代表結案,底下的退款欄位會整組變成唯讀。
                    放在摘要區而不是只在退款那段裡 —— 一打開就要看得到,
                    不然會有人往下拉去改帳號,才發現改不了。
                  */}
                  {row('退押金日', d.returned_on
                    ? <span className="text-mor-green font-medium">{d.returned_on}　已退款</span>
                    : <span className="text-gray-400">尚未退款{d.planned_refund_on ? `（預計 ${d.planned_refund_on}）` : ''}</span>)}
                  {row('核可進度', (
                    <span className="text-xs">
                      <span className={d.manager_approved_at ? 'text-mor-green' : 'text-gray-400'}>
                        {d.manager_approved_at ? '✓' : '○'} 主管
                        {d.manager_approved_by ? `・${personName[d.manager_approved_by] ?? ''}` : ''}
                      </span>
                      <span className="mx-2 text-gray-300">|</span>
                      <span className={d.admin_approved_at ? 'text-mor-green' : 'text-gray-400'}>
                        {d.admin_approved_at ? '✓' : '○'} 總經理
                        {d.admin_approved_by ? `・${personName[d.admin_approved_by] ?? ''}` : ''}
                      </span>
                    </span>
                  ))}
                </div>

                {d.refund_status === 'rejected' && d.reject_reason && (
                  <div className="rounded-lg bg-red-50 text-red-600 px-3 py-2 text-xs">駁回原因:{d.reject_reason}</div>
                )}
                {/*
                  錢已經匯出去之後 refund_status 仍然是 'approved' —— 它記的是「審過了」,
                  不是「還在等」。只看它就會對一筆早就退完的押金說「等待匯款」。
                  紅線一律是 returned_on,這一頁其他地方也都是用它判斷。
                */}
                {d.refund_status === 'approved' && !d.returned_on && (
                  <div className="rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-xs">
                    已核可,等待匯款。在這裡改內容會清掉核可票、退回重新送審。
                  </div>
                )}
                {d.returned_on && (
                  <div className="rounded-lg bg-gray-100 text-gray-500 px-3 py-2 text-xs">
                    這筆押金已經退還完畢,內容不能再修改。
                  </div>
                )}

                {/*
                  加費（從押金扣除，migration_157）。
                  唯讀 —— 這裡是審核的地方，改加費要按「編輯」進去。
                  審的人要看得到「為什麼只退 99,719 而不是 100,000」。
                */}
                <DepositFees
                  dep={{
                    id: d.id, amount: d.amount, returned_on: d.returned_on,
                    planned_refund_on: d.planned_refund_on,
                    order_id: d.order_id, contract_id: d.contract_id,
                    estate_id: d.estate_id, property_id: d.property_id,
                    room: d.room, guest_name: d.guest_name,
                    approved_amount: d.refund_amount,
                  }}
                  canEdit={false} />

                {/*
                  ══════════ 唯讀優先 ══════════
                  （2026-08-22 使用者:「押金也造請款設計」）

                  原本這一段是**直接可編輯的表單**。問題是這頁叫「請款審核」——
                  來的人是要投票的，不是要改內容的。而這筆已核可的話，
                  改任何一個字都會清掉兩張核可票、退回重新送審。

                  也就是說:一個只想看清楚再按核可的人，很可能在捲動時
                  不小心改掉一個欄位，把別人的票洗掉 —— 而畫面上只會說「已重新送審」。

                  支出頁 8/19 修的是同一件事（「檢視是直接編輯阿」）。
                  這裡照請款單抽屜的樣子:預設唯讀，編輯是一個要按下去的動作。
                */}
                <div className="border-t border-mor-line pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-500">退押金</span>
                    {editable && !depEditing && (
                      <button onClick={() => setDepEditing(true)}
                        className="text-xs text-mor-blue underline">編輯</button>
                    )}
                  </div>

                  {!editable ? (
                    <div className="text-xs text-gray-500">
                      已於 {d.returned_on} 退還・{d.returned_method ? DEP_METHOD[d.returned_method] : ''}
                      {d.returned_account ? `・${acctName[d.returned_account] ?? d.returned_account}` : ''}
                    </div>
                  ) : depEditing ? (
                    <>
                      {/* 跟押金管理頁共用同一支元件 —— 兩邊的欄位永遠一樣 */}
                      <RefundFields v={d} payAccounts={payAccounts.map((a) => ({ ...a }))} currency={d.currency}
                        onChange={(patch) => setDepDetail({ ...d, ...patch })} />
                      <label className="flex flex-col gap-1 mt-3"><span className="text-xs text-gray-500">備註</span>
                        <textarea value={d.note ?? ''} onChange={(e) => setDepDetail({ ...d, note: e.target.value })}
                          className="bg-white rounded-lg border border-mor-line px-2 py-2 h-20" /></label>
                    </>
                  ) : (
                    <div>
                      {row('房客收款帳號', d.payee_account
                        ? <span className="text-xs">
                          {d.payee_name ?? ''}　{d.payee_bank_code ?? ''}
                          <div className="tabular-nums">{d.payee_account}</div>
                        </span>
                        : <span className="text-gray-400">—</span>)}
                      {row('預計匯款日', d.planned_refund_on ?? <span className="text-gray-400">—</span>)}
                      {row('安幸付款', d.returned_method
                        ? <span>
                          {DEP_METHOD[d.returned_method] ?? d.returned_method}
                          {d.returned_account && (
                            <span className="text-gray-500 ml-1">・{acctName[d.returned_account] ?? d.returned_account}</span>
                          )}
                        </span>
                        : <span className="text-gray-400">—</span>)}
                      {row('備註', d.note
                        ? <span className="whitespace-pre-wrap">{d.note}</span>
                        : <span className="text-gray-400">—</span>)}
                    </div>
                  )}
                </div>

                {/*
                  匯款水單、房客提供的帳戶截圖。
                  唯讀模式下也不給上傳 —— 審核的人不該在投票的畫面裡改附件。
                */}
                <Receipts kind="dep" parentId={d.id} canEdit={editable && depEditing} label="憑證圖片" />
              </div>

              <div className="sticky bottom-0 md:static bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex flex-wrap gap-2 md:justify-end"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => shareDep(d)}
                  className="h-12 md:h-auto rounded-lg border border-mor-line px-4 md:py-1.5 text-sm">↗ 分享</button>
                {(isManager || isAdmin) && d.refund_status === 'pending' && (
                  <button onClick={() => { openDep(null); setDepRejecting(d); }}
                    className="h-12 md:h-auto rounded-lg border border-red-300 text-red-500 px-4 md:py-1.5 text-sm">駁回</button>
                )}
                {/*
                  ★ 「儲存並重新送審」只在**編輯模式**出現。
                    唯讀時放著的話，等於那顆會清掉核可票的按鈕一直在旁邊，
                    而按下去的人未必知道自己什麼都沒改也會退回重審。
                */}
                {editable && depEditing && (
                  <>
                    <button onClick={() => { setDepEditing(false); load(); }} disabled={saving}
                      className="h-12 md:h-auto rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">取消編輯</button>
                    <button onClick={depSaveResubmit} disabled={saving}
                      className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-mor-line px-4 md:py-1.5 text-sm hover:bg-mor-sand/60 disabled:opacity-40">
                      {saving ? '儲存中…' : '儲存並重新送審'}</button>
                  </>
                )}
                {/*
                  核可只在唯讀模式出現 —— 一邊改內容一邊投票，
                  投的是改前還是改後的版本沒有人說得準。
                */}
                {canVote && !depEditing && (
                  <button onClick={() => { depVote(d); openDep(null); }}
                    className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-green text-white px-4 md:py-1.5 text-sm font-medium active:opacity-80">
                    核可</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 押金駁回 */}
      {depRejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="font-bold mb-1">駁回押金退款</div>
            <div className="text-xs text-gray-500 mb-3">
              {depRejecting.room ?? ''} {depRejecting.guest_name ?? ''}・NT$ {fmt(depRejecting.amount)}
            </div>
            <textarea value={depReason} onChange={(e) => setDepReason(e.target.value)} rows={3}
              placeholder="駁回原因(會顯示在押金管理頁)"
              className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setDepRejecting(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={depDoReject} className="rounded-lg bg-red-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-red-600">駁回</button>
            </div>
          </div>
        </div>
      )}

      {/* 詳細資訊抽屜 —— 列表精簡掉的欄位與所有操作都在這裡 */}
      {detail && (() => {
        const d = detail;
        const p = perms(d);
        const row = (label: string, value: React.ReactNode) => (
          <div className="flex gap-3 py-1.5 border-b border-mor-line/40 last:border-0">
            <div className="w-24 shrink-0 text-xs text-gray-400 pt-0.5">{label}</div>
            <div className="flex-1 min-w-0 text-sm">{value ?? '—'}</div>
          </div>
        );
        const its = (d.purchase_request_items ?? []).slice().sort((a, b) => a.sort - b.sort);
        const btn = 'flex-1 min-w-[5rem] h-11 rounded-lg text-sm font-medium';
        return (
          <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
            <div className="absolute inset-0 bg-black/30" />
            <div onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-start justify-between"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                <div className="min-w-0">
                  <div className="font-bold">{d.req_no}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {personName[d.requester_id] ?? '—'}・{d.created_at ? d.created_at.slice(0, 10) : ''}
                  </div>
                </div>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>

              <div className="px-6 py-4">
                {row('狀態', (
                  <span>
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${ST_COLOR[d.status]}`}>{ST_LABEL[d.status] ?? d.status}</span>
                    <div className="text-xs mt-1">{voteLine(d)}</div>
                    {d.status === 'rejected' && d.reject_reason && <div className="text-xs text-red-500 mt-1">駁回原因:{d.reject_reason}</div>}
                  </span>
                ))}
                {row('總額', (
                  <span>
                    <span className="font-medium">NT$ {fmt(d.total_amount)}</span>
                    {d.currency !== 'TWD' && <div className="text-xs text-gray-400">{d.currency} × 匯率 {d.fx_rate}</div>}
                  </span>
                ))}
                {row('支出方式', (
                  <span>
                    {d.payment_method ? PAY_LABEL[d.payment_method] ?? d.payment_method : '—'}
                    {d.payout_account && <span className="text-gray-500 ml-1">・{acctName[d.payout_account] ?? d.payout_account}</span>}
                  </span>
                ))}
                {d.payee_account ? row('收款方', (
                  <span className="text-xs">
                    {d.payee_company ?? ''} {d.payee_bank_code ?? ''} {d.payee_account}
                    {d.payee_tax_id ? <div>統編 {d.payee_tax_id}</div> : null}
                  </span>
                )) : null}
                {/*
                  憑證（migration_155）。

                  共同憑證  只印一個號碼 —— 舊單全部走這條，畫面跟以前一樣
                  逐項      印「幾項填好 / 共幾項」，號碼在下面的項目清單裡

                  ★ 沒填完要標紅。印一個「3 / 17」而不標色的話，
                    跟填好的長得太像 —— 看的人不會停下來。
                */}
                {row('憑證', (() => {
                  const s = voucherSummary(d, d.purchase_request_items ?? []);
                  return (
                    <span title={s.full}>
                      <span className={s.warn ? 'text-amber-600' : ''}>{s.text}</span>
                      <span className="block text-xs text-gray-400 mt-0.5">
                        {d.shared_voucher ? '整張單共用一個憑證' : '每個項目各自的憑證，見下方清單'}
                      </span>
                    </span>
                  );
                })())}
                {d.payment_method === 'transfer' && row('手續費', d.fee_mode === 'extra'
                  ? <span>不內扣 ${fmt(Number(d.fee_amount) || 0)}
                      <span className="text-gray-400 text-xs ml-1">
                        {d.purchased_on ? '・已產生郵電費支出' : '・出款後產生郵電費支出'}
                      </span>
                    </span>
                  : <span className="text-gray-400 text-xs">內扣</span>)}
                {row(`預定${dateWord(d.payment_method)}`, d.planned_transfer_on ?? '—')}
                {row(`確認${dateWord(d.payment_method)}`, d.purchased_on ?? '—')}
                {row('備註', d.note ? <span className="whitespace-pre-wrap">{d.note}</span> : '—')}

                {/* 審核者最需要的就是看發票,放在項目上方 */}
                <div className="mt-3"><Receipts kind="pr" parentId={d.id} canEdit={p.canEdit} label="憑證圖片" /></div>

                <div className="mt-4 text-xs text-gray-400 mb-1">請款項目（{its.length}）</div>
                <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40">
                  {its.map((i, idx) => (
                    <div key={idx} className="px-3 py-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{i.item_name}</span>
                        <span className="shrink-0">
                          {d.currency !== 'TWD' && <span className="text-xs text-gray-400 mr-1">{d.currency} {fmt(i.amount_original ?? 0)}</span>}
                          NT$ {fmt(i.amount)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {i.account_code ? codeName[i.account_code] ?? i.account_code : '未分類'}
                        ・{i.purpose_type === 'office' ? '安幸辦公室' : (i.estate_id ? estateName[i.estate_id] ?? '' : '')}
                        {i.property_id && `／${properties.find((pp) => pp.id === i.property_id)?.name ?? ''}`}
                        {i.note ? `・${i.note}` : ''}
                      </div>
                      {/*
                        這一項實際套用的憑證（migration_155）。

                        ★ 共同憑證時**不重複印**號碼 —— 上面已經有了。
                          每一項都印一次同一個號碼，看起來會像有十七張發票，
                          而那正是這次要修掉的誤會。

                        ★ 沒填的印「憑證未填」而不是留白 ——
                          留白跟「這一列沒有憑證欄」長得一樣。
                      */}
                      {!d.shared_voucher && (() => {
                        const st = resolveVoucher(d, i);
                        return (
                          <div className={`text-xs mt-0.5 ${st.kind === 'blank' ? 'text-amber-600' : 'text-gray-500'}`}>
                            {st.kind === 'blank' ? '憑證未填' : `憑證 ${voucherText(st)}`}
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>

              <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex flex-wrap gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setDetail(null); openEdit(d); }}
                  className={`${btn} border border-mor-line`}>{p.canEdit ? '編輯' : '檢視內容'}</button>
                {(p.canVoteMgr || p.canVoteAdm) && (
                  <button onClick={() => { vote(d); setDetail(null); }} className={`${btn} bg-mor-green text-white`}>核可</button>
                )}
                {p.canRej && (
                  <button onClick={() => { setDetail(null); setRejecting(d); setRejectReason(''); }}
                    className={`${btn} border border-amber-400 text-amber-700`}>駁回</button>
                )}
                {p.canPlan && (
                  <button onClick={() => { setDetail(null); setPlanning(d); setPlanDate(d.planned_transfer_on ?? todayStr()); setPlanAcct(d.payout_account ?? ''); }}
                    className={`${btn} border border-mor-slate text-mor-slate`}>{d.planned_transfer_on ? '改付款計畫' : `排${dateWord(d.payment_method)}`}</button>
                )}
                {p.canDate && (
                  <button onClick={() => { setDetail(null); setDating(d); setDateVal(d.purchased_on ?? d.planned_transfer_on ?? todayStr()); setDateAcct(d.payout_account ?? ''); setDateErr(''); }}
                    className={`${btn} border border-mor-blue text-mor-blue`}>{d.purchased_on ? `改${dateWord(d.payment_method)}` : `確認${dateWord(d.payment_method)}`}</button>
                )}
                {p.canCancel && (
                  <button onClick={() => { cancel(d); setDetail(null); }} className={`${btn} border border-red-300 text-red-500`}>撤銷</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 請款單表單 */}
      {edit && (() => {
        // pending 與 approved 都開放編輯。存檔會清票重送審 ——
        // 判斷邏輯必須跟 perms().canEdit 一致,不然會出現「列上能點編輯、抽屜裡卻是唯讀」。
        const readOnly = !((edit.requester_id === me?.id || isAdmin)
          && (!edit.id || (['draft', 'rejected', 'pending', 'approved'].includes(edit.status)
                           && !edit.purchased_on && !edit.expense_generated_at)));
        // 已經有票的單被改動 —— 存檔會清票重送
        const editingApproved = !readOnly && (edit.status === 'pending' || edit.status === 'approved');
        // 手機:整頁式(貼齊上下邊)。桌機:置中對話框
        return (
          <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50">
            <div className="bg-white w-full md:w-[760px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0" onClick={(e) => e.stopPropagation()}>
              <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 font-bold flex items-center justify-between z-10"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
                {edit.id ? `請款單 ${edit.req_no}` : '填寫請款'}
                <button onClick={() => setEdit(null)} aria-label="關閉"
                  className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
              </div>
              <div className="p-4 md:p-6 space-y-4 text-sm">
                {editingApproved && (
                  <div className="rounded-lg bg-amber-50 text-amber-700 px-3 py-2 text-xs">
                    {edit.status === 'approved'
                      ? '這張單已經核可通過。存檔後核可會被清空、退回重新送審。'
                      : '這張單審核中。存檔後既有的核可會被清空,需要重新走一次審核。'}
                    {edit.requester_id !== me?.id && `（申請人:${personName[edit.requester_id] ?? '—'}）`}
                  </div>
                )}
                {readOnly && edit.id && (
                  <div className="rounded-lg bg-mor-sand/60 text-gray-600 px-3 py-2 text-xs">
                    {edit.purchased_on || edit.expense_generated_at
                      ? '已經填了出款日、支出也產生了,不能再編輯。要調整請到支出頁,或撤銷後重開一張。'
                      : '此單目前不可編輯。'}
                  </div>
                )}
                {edit.status === 'rejected' && edit.reject_reason && (
                  <div className="rounded-lg bg-red-50 text-red-600 px-3 py-2 text-xs">駁回原因:{edit.reject_reason}</div>
                )}

                {/* 項目 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium">請款項目</div>
                    {!readOnly && <button onClick={() => setItems([...items, blankItem()])} className="text-xs text-mor-blue underline">+ 增加項目</button>}
                  </div>
                  <div className="space-y-2">
                    {items.map((it, idx) => (
                      <div key={idx} className="rounded-lg border border-mor-line p-3 space-y-2">
                        <div className="flex gap-2">
                          {/* 提示字在 placeholder 裡,塞不進紅星元件 —— 改成貼在框線左上角 */}
                          <div className="relative flex-1 min-w-0">
                            {!readOnly && <ReqMark />}
                            <input disabled={readOnly} value={it.item_name} placeholder="項目名稱"
                              onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, item_name: e.target.value } : x))}
                              className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" />
                          </div>
                          <div className="relative w-28 md:w-32 shrink-0">
                            {!readOnly && <ReqMark />}
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                              {edit.currency === 'TWD' ? 'NT$' : edit.currency}
                            </span>
                            {/* 值用字串保存,不是 Number(0) —— 否則欄位永遠顯示 0,
                                打字時新數字會接在 0 後面變成 0500。空字串才能被直接取代。 */}
                            <input disabled={readOnly} type="number" inputMode="decimal" min="0"
                              value={it.amount_original === 0 || it.amount_original == null ? '' : it.amount_original}
                              placeholder="金額"
                              onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, amount_original: e.target.value === '' ? 0 : Number(e.target.value) } : x))}
                              className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line pl-9 pr-2 md:py-1.5 text-right disabled:bg-gray-50" />
                          </div>
                          {!readOnly && items.length > 1 &&
                            <button onClick={() => setItems(items.filter((_, i) => i !== idx))} aria-label="刪除項目"
                              className="w-10 shrink-0 text-red-400 hover:text-red-600">✕</button>}
                        </div>
                        <div className="flex flex-col md:flex-row gap-2">
                          <select disabled={readOnly} value={it.account_code ?? ''}
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, account_code: e.target.value || null } : x))}
                            className="w-full md:w-36 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                            <option value="">會計科目</option>
                            {expenseCodes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                          </select>
                          <div className="relative w-full md:w-auto md:flex-1">
                          {!readOnly && <ReqMark />}
                          <select disabled={readOnly}
                            value={it.purpose_type === 'office' ? 'office' : (it.estate_id ?? '')}
                            onChange={(e) => {
                              const v = e.target.value;
                              setItems(items.map((x, i) => i === idx
                                // 換用途時一定要清掉房源 —— 否則會留著上一個物業的房間
                                ? (v === 'office'
                                    ? { ...x, purpose_type: 'office', estate_id: null, property_id: null }
                                    : { ...x, purpose_type: 'estate', estate_id: v || null, property_id: null })
                                : x));
                            }}
                            className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                            <option value="">用途</option>
                            <option value="office">安幸辦公室</option>
                            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          </div>
                          {/* 房源選填。跟支出頁同一套:選了物業才出現 ——
                              沒有物業就篩不出房源清單。 */}
                          {it.purpose_type === 'estate' && it.estate_id && (
                            <select disabled={readOnly} value={it.property_id ?? ''}
                              onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, property_id: e.target.value || null } : x))}
                              className="w-full md:w-auto md:flex-1 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                              <option value="">整個物業（房源選填）</option>
                              {properties.filter((pp) => pp.estate_id === it.estate_id)
                                .map((pp) => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                            </select>
                          )}
                          <input disabled={readOnly} value={it.note ?? ''} placeholder="備註"
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, note: e.target.value } : x))}
                            className="w-full md:w-auto md:flex-1 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" />
                        </div>

                        {/*
                          這個項目自己的憑證（migration_155）。

                          ★ 勾了共同憑證就整排灰掉,但**內容留著也不清空** ——
                            使用者指定「留著但不使用」。取消勾選之後號碼要還在,
                            不然他不會知道是自己勾那一下弄掉的。

                          ★「無憑證」與留空白是兩件事:
                            前者是查過了確定沒單據,後者是還沒填。
                            只有一個空白欄的話,三個月後沒有人知道該不該去追。
                        */}
                        <div className={`mt-2 flex flex-col md:flex-row md:items-center gap-2
                          ${edit.shared_voucher ? 'opacity-40' : ''}`}>
                          <span className="text-xs text-gray-500 md:w-16 shrink-0">憑證</span>
                          <input
                            disabled={readOnly || !!edit.shared_voucher || !!it.no_voucher}
                            value={it.voucher_no ?? ''}
                            placeholder={edit.shared_voucher ? '使用共同憑證' : it.no_voucher ? '已註記無憑證' : '發票／收據號碼'}
                            onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, voucher_no: e.target.value } : x))}
                            className="w-full md:w-auto md:flex-1 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-100 disabled:text-gray-400" />
                          <label className={`flex items-center gap-2 text-sm shrink-0
                            ${(it.voucher_no ?? '').trim() || edit.shared_voucher ? 'text-gray-300' : 'text-gray-600'}`}>
                            <input type="checkbox"
                              disabled={readOnly || !!edit.shared_voucher || !!(it.voucher_no ?? '').trim()}
                              checked={!!it.no_voucher}
                              onChange={(e) => setItems(items.map((x, i) => i === idx
                                ? { ...x, no_voucher: e.target.checked, voucher_no: e.target.checked ? null : x.voucher_no }
                                : x))} />
                            無憑證
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* 幣別與匯率 */}
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">幣別</span>
                      <select disabled={readOnly} value={edit.currency ?? 'TWD'}
                        onChange={(e) => setEdit({ ...edit, currency: e.target.value, fx_rate: e.target.value === 'TWD' ? 1 : (edit.fx_rate || 0) })}
                        className="w-full md:w-auto h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></label>
                    {edit.currency !== 'TWD' && (
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">匯率 * (1 {edit.currency} = ? NTD)</span>
                        <input disabled={readOnly} type="number" inputMode="decimal" step="0.0001" min="0"
                          value={edit.fx_rate ? edit.fx_rate : ''} placeholder="例 31.5"
                          onChange={(e) => setEdit({ ...edit, fx_rate: e.target.value === '' ? 0 : Number(e.target.value) })}
                          className="w-full md:w-32 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-right disabled:bg-gray-50" /></label>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between text-sm">
                    <div className={editTotal < FREE_THRESHOLD ? 'text-mor-green text-xs' : 'text-amber-600 text-xs'}>
                      {editTotal < FREE_THRESHOLD
                        ? `未達 NT$${fmt(FREE_THRESHOLD)},送出後直接核可`
                        : `達 NT$${fmt(FREE_THRESHOLD)} 以上,需主管與總經理各核可一次`}
                    </div>
                    <div className="text-right">
                      {edit.currency !== 'TWD' && (
                        <div className="text-xs text-gray-500">{edit.currency} {fmt(editSubtotal)} × {fxRate || '—'}</div>
                      )}
                      <div className="font-bold">總額 NT$ {fmt(editTotal)}</div>
                    </div>
                  </div>
                </div>

                {/* 付款 */}
                <div className="border-t border-mor-line pt-3 space-y-3">
                  {/*
                    換成非匯款要把手續費清乾淨 —— 現金與信用卡沒有匯款手續費。
                    只藏欄位不清值的話，舊值會留在資料庫繼續產生郵電費支出，
                    而畫面上完全看不到它（pr_fee_chk 也會擋，但錯誤訊息是約束名稱，沒人看得懂）。
                  */}
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">支出方式</span>
                    <select disabled={readOnly} value={edit.payment_method ?? 'cash'}
                      onChange={(e) => setEdit({
                        ...edit, payment_method: e.target.value,
                        ...(e.target.value === 'transfer' ? {} : { fee_mode: 'included', fee_amount: 0 }),
                      })}
                      className="w-full md:w-40 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                      {PAY_OPTS.map((p) => <option key={p} value={p}>{PAY_LABEL[p]}</option>)}
                    </select></label>
                  {edit.payment_method === 'transfer' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 [&_input]:h-12 md:[&_input]:h-auto [&_input]:bg-white">
                      {/*
                        常用帳號：選一次自動帶入下面四欄。
                        重打四個欄位的代價是「錢匯到別的帳戶」，而且不會有任何跡象 ——
                        要等對方說沒收到才知道，那時候錢已經出去了。

                        帶入之後四欄仍然可以手改：這一次要匯到不同分行、或臨時換帳號
                        都還是常見的，主檔只負責少打幾個字，不是強制。
                      */}
                      {/*
                        **一直顯示，即使主檔是空的。**
                        原本寫成「有資料才顯示」—— 但主檔是空的時候，
                        使用者根本看不到這個功能存在，也就永遠不會去建第一筆。
                        空的時候顯示成停用狀態並指出去哪裡建。
                      */}
                      {!readOnly && (
                        <label className="flex flex-col gap-1 md:col-span-2">
                          <span className="text-xs text-gray-500">常用帳號（選了自動帶入下面四欄）</span>
                          <select value="" disabled={!payees.length}
                            onChange={(e) => {
                              const p = payees.find((x) => x.id === e.target.value);
                              if (!p) return;
                              setEdit({
                                ...edit,
                                payee_bank_code: p.bank_code ?? '',
                                payee_account: p.account ?? '',
                                payee_company: p.company ?? '',
                                payee_tax_id: p.tax_id ?? '',
                              });
                            }}
                            className="rounded-lg border border-mor-line px-2 py-1.5 h-12 md:h-auto bg-white disabled:bg-gray-50 disabled:text-gray-400">
                            <option value="">
                              {payees.length ? '— 選擇常用帳號 —' : '— 尚未建立常用帳號 —'}
                            </option>
                            {payees.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}{p.account ? `・${p.account}` : ''}
                              </option>
                            ))}
                          </select>
                          {!payees.length && (
                            <span className="text-[11px] text-gray-400">
                              到「權限管理 → 常用帳號」新增，之後填匯款單就能一鍵帶入四個欄位。
                            </span>
                          )}
                        </label>
                      )}
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">銀行代碼</span>
                        <input disabled={readOnly} value={edit.payee_bank_code ?? ''} onChange={(e) => setEdit({ ...edit, payee_bank_code: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500 flex items-center">廠商收款帳號<Req /></span>
                        <input disabled={readOnly} value={edit.payee_account ?? ''} onChange={(e) => setEdit({ ...edit, payee_account: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">公司名／戶名</span>
                        <input disabled={readOnly} value={edit.payee_company ?? ''} onChange={(e) => setEdit({ ...edit, payee_company: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                      <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">統編</span>
                        <input disabled={readOnly} value={edit.payee_tax_id ?? ''} onChange={(e) => setEdit({ ...edit, payee_tax_id: e.target.value })}
                          className="rounded-lg border border-mor-line px-2 py-1.5 disabled:bg-gray-50" /></label>
                    </div>
                  )}

                  {/*
                    安幸付款帳號與預定日期：申請時就能填，但都是選填。
                    會計在核可後可以覆寫 —— 這裡填的是「打算」，不是「已付」。
                    現金沒有安幸付款帳號可言，所以只在匯款／信用卡時出現。
                  */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* 現金沒有帳號可選，但一樣有「打算哪天付」 */}
                    {(edit.payment_method === 'transfer' || edit.payment_method === 'credit_card') && (
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500">
                          {acctWord(edit.payment_method)}<span className="text-gray-400">（選填）</span>
                        </span>
                        <select disabled={readOnly} value={edit.payout_account ?? ''}
                          onChange={(e) => setEdit({ ...edit, payout_account: e.target.value || null })}
                          className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50">
                          <option value="">未指定</option>
                          {payAccounts.filter((a) => a.method === edit.payment_method)
                            .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                        </select></label>
                    )}
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-gray-500">
                        預定{dateWord(edit.payment_method)}<span className="text-gray-400">（選填）</span>
                      </span>
                      <input disabled={readOnly} type="date" value={edit.planned_transfer_on ?? ''}
                        onChange={(e) => setEdit({ ...edit, planned_transfer_on: e.target.value || null })}
                        className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-50" /></label>
                    <div className="md:col-span-2 text-xs text-gray-400">
                      核可後由會計確認實際{dateWord(edit.payment_method)}，這裡填的只是預定。
                    </div>
                  </div>

                  {/*
                    ══════════ 憑證 ══════════

                    憑證號碼與「無憑證」互斥。
                    分成兩件事是為了讓「還沒填」和「本來就沒有」在帳上分得出來 ——
                    只留一個空白欄位的話，會計永遠不知道還要不要追這張發票。

                    【共同憑證】（migration_155，2026-08-21）
                    預設是**每個項目各自填**（欄位在上面的項目列裡）。
                    這裡的開關只在「真的只有一張發票、拆成多個項目報帳」時勾。

                    原本沒有這個開關,號碼只有單張層級一個欄位 ——
                    十七張不同的收據沒地方放,填單的人就用頓號串成一串,
                    而 gen_expenses_from_pr 把整串複製給每一筆支出。
                    結果計程車那筆的憑證號碼裡混著住宿的發票號。
                  */}
                  <div className="rounded-lg border border-mor-line bg-mor-sand/20 p-3 space-y-3">
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input type="checkbox" disabled={readOnly} className="mt-0.5"
                        checked={!!edit.shared_voucher}
                        onChange={(e) => setEdit({ ...edit, shared_voucher: e.target.checked })} />
                      <span>
                        共同憑證
                        <span className="block text-xs text-gray-500 mt-0.5">
                          {edit.shared_voucher
                            ? '整張單共用下面這一個號碼。項目各自的憑證欄會灰掉，但內容留著。'
                            : '每個項目各自填憑證（欄位在上面每一列裡）。只有一張發票時才勾這裡。'}
                        </span>
                      </span>
                    </label>

                    {/*
                      沒勾的時候整區灰掉但**不隱藏**。
                      藏起來的話,舊單切成逐項之後那個號碼就從畫面上消失了 ——
                      使用者會以為被刪掉。
                    */}
                    <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 items-end
                      ${edit.shared_voucher ? '' : 'opacity-50'}`}>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500">憑證號碼<span className="text-gray-400">（發票/收據號碼）</span></span>
                        <input disabled={readOnly || !edit.shared_voucher || !!edit.no_voucher} value={edit.voucher_no ?? ''}
                          onChange={(e) => setEdit({ ...edit, voucher_no: e.target.value })}
                          placeholder={!edit.shared_voucher ? '未使用（改用逐項憑證）' : edit.no_voucher ? '已註記無憑證' : ''}
                          className="w-full h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 disabled:bg-gray-100 disabled:text-gray-400" /></label>
                      <label className={`flex items-center gap-2 text-sm h-12 md:h-auto md:pb-1.5
                        ${(edit.voucher_no ?? '').trim() || !edit.shared_voucher ? 'text-gray-300' : 'text-gray-600'}`}>
                        <input type="checkbox" disabled={readOnly || !edit.shared_voucher || !!(edit.voucher_no ?? '').trim()}
                          checked={!!edit.no_voucher}
                          onChange={(e) => setEdit({ ...edit, no_voucher: e.target.checked, voucher_no: e.target.checked ? null : edit.voucher_no })} />
                        無憑證
                      </label>
                    </div>
                  </div>
                  {/*
                    匯款手續費。

                    內扣   = 受款人吸收。我方支出就是請款金額,帳上不用多記什麼。
                    不內扣 = 我方額外負擔。我方總支出 = 請款金額 + 手續費,
                             那筆手續費要單獨記帳,否則帳上永遠少那幾十塊。

                    所以只有「不內扣」會產生東西:確認出款後自動多一筆郵電費支出,
                    日期用出款日,物業/房源跟這張單走。實際產生的邏輯在 migration_83,
                    這裡只負責讓人把意圖表達清楚。
                  */}
                  {edit.payment_method === 'transfer' && (
                  <div className="rounded-lg border border-mor-line p-3">
                    <div className="text-xs text-gray-500 mb-2">匯款手續費</div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                      {[['included', '內扣'], ['extra', '不內扣']].map(([v, label]) => (
                        <label key={v} className="flex items-center gap-2 text-sm">
                          <input type="radio" name="feeMode" disabled={readOnly}
                            checked={(edit.fee_mode ?? 'included') === v}
                            onChange={() => setEdit({ ...edit, fee_mode: v, fee_amount: v === 'extra' ? edit.fee_amount : 0 })} />
                          {label}
                        </label>
                      ))}
                      {edit.fee_mode === 'extra' && (
                        <label className="flex items-center gap-2 text-sm">
                          <span className="text-gray-500">金額</span>
                          <input disabled={readOnly} type="number" inputMode="numeric" min={0}
                            value={edit.fee_amount ? String(edit.fee_amount) : ''}
                            onChange={(e) => setEdit({ ...edit, fee_amount: e.target.value === '' ? 0 : Number(e.target.value) })}
                            placeholder="0"
                            className="w-28 h-12 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5 text-right disabled:bg-gray-50" />
                          <span className="text-gray-500">NTD</span>
                        </label>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-2 leading-relaxed">
                      {edit.fee_mode === 'extra'
                        ? '確認出款後會自動產生一筆支出:日期為出款日、會計科目「郵電費」、金額為上方手續費。物業／房源跟這張單走（項目分屬多個房源時歸辦公室）。'
                        : '內扣由受款人吸收,我方支出就是請款金額,不會另外產生支出。'}
                    </div>
                  </div>
                  )}

                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
                    <textarea disabled={readOnly} value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                      className="bg-white rounded-lg border border-mor-line px-2 py-2 h-24 md:h-16 disabled:bg-gray-50" /></label>
                  <Receipts ref={receiptsRef} kind="pr" parentId={edit.id || null} canEdit={!readOnly} label="憑證圖片" />
                </div>
              </div>
              {/*
                擋阻訊息**在抽屜裡也顯示一份**，就在按鈕正上方。
                只渲染在頁面頂端的話，抽屜蓋住了它，使用者看到的是「按了沒反應」。
              */}
              {msg?.err && (
                <div className="sticky bottom-0 md:static bg-red-50 border-t border-red-200 px-4 md:px-6 py-3 text-sm text-red-700 flex items-start gap-2">
                  <span className="shrink-0">⚠</span>
                  <span className="flex-1 whitespace-pre-line">{msg.t}</span>
                  <button onClick={() => setMsg(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
                </div>
              )}
              {/* 手機:按鈕列吸在畫面底部,捲到哪都按得到 */}
              <div className="sticky bottom-0 md:static bg-white border-t border-mor-line px-4 md:px-6 py-3 md:py-4 flex gap-2 md:justify-end"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
                <button onClick={() => setEdit(null)}
                  className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-gray-300 px-4 md:py-1.5 text-sm">關閉</button>
                {!readOnly && <>
                  <button onClick={() => save(false)} disabled={saving}
                    className="h-12 md:h-auto flex-1 md:flex-none rounded-lg border border-mor-line px-4 md:py-1.5 text-sm hover:bg-mor-sand/60 disabled:opacity-40">儲存草稿</button>
                  <button onClick={() => save(true)} disabled={saving}
                    className="h-12 md:h-auto flex-1 md:flex-none rounded-lg bg-mor-slate text-white px-4 md:py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                    {saving ? '處理中…' : (editingApproved ? '重新送審' : '送出審核')}</button>
                </>}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 駁回 */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">駁回 {rejecting.req_no}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">駁回後單子回到申請人手上,可修改後重新送審。已投的票會一併清空。</div>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="駁回原因(必填)"
                className="w-full rounded-lg border border-mor-line px-2 py-1.5 h-24" />
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setRejecting(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doReject} className="rounded-lg bg-amber-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-amber-700">確認駁回</button>
            </div>
          </div>
        </div>
      )}

      {/* 採購日 */}
      {dating && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">{dating.purchased_on ? `修改${dateWord(dating.payment_method)}` : `確認${dateWord(dating.payment_method)}`} · {dating.req_no}</div>
            <div className="p-6 text-sm space-y-2">
              <div className="text-xs text-gray-500">
                {dating.purchased_on
                  ? '改日期只會同步既有支出的日期,不會重複產生新的支出。'
                  : `確認後,這張單的 ${(dating.purchase_request_items ?? []).length} 個項目會各自產生一筆支出,而且這張單就不能再撤銷。`}
              </div>
              {!dating.purchased_on && dating.planned_transfer_on && (
                <div className="text-xs text-mor-blue">預定{dateWord(dating.payment_method)} {dating.planned_transfer_on} —— 已帶入,實際日期不同請自行修改。</div>
              )}
              <label className="block text-xs text-gray-500 pt-1">確認{dateWord(dating.payment_method)}</label>
              <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
                className="w-full rounded-lg border border-mor-line px-2 py-1.5" />
              {/* 擋門的訊息一定要印在**彈窗裡**。印在頁面上的話會被這個彈窗蓋住,
                  使用者看到的是「按了沒反應」（2026-08-19） */}
              {dateErr && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
                  {dateErr}
                </div>
              )}
              {/* 匯款與信用卡必須記錄從哪個帳戶付出去,現金沒有帳戶所以不問 */}
              {(dating.payment_method === 'transfer' || dating.payment_method === 'credit_card') && (
                <>
                  <label className="block text-xs text-gray-500 pt-1">{acctWord(dating.payment_method)}(我方)<Req /></label>
                  <select value={dateAcct} onChange={(e) => setDateAcct(e.target.value)}
                    className="w-full rounded-lg border border-mor-line px-2 py-1.5">
                    <option value="">請選擇</option>
                    {payAccounts.filter((a) => a.method === dating.payment_method)
                      .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select>
                </>
              )}
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setDating(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doSetDate} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">確認</button>
            </div>
          </div>
        </div>
      )}

      {/* 排匯款:只寫計畫,不產生支出 */}
      {planning && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-mor-line px-6 py-4 font-bold">
              {planning.planned_transfer_on ? '修改付款計畫' : `排${dateWord(planning.payment_method)}`} · {planning.req_no}
            </div>
            <div className="p-6 text-sm space-y-3">
              <div className="text-xs text-gray-500">
                這裡只是排定計畫,不會產生支出。實際出款後再按「確認{dateWord(planning.payment_method)}」,那時才會記帳。
              </div>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">預定{dateWord(planning.payment_method)}</span>
                <input type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)}
                  className="rounded-lg border border-mor-line px-2 py-1.5" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">{acctWord(planning.payment_method)}(我方)</span>
                <select value={planAcct} onChange={(e) => setPlanAcct(e.target.value)}
                  className="rounded-lg border border-mor-line px-2 py-1.5">
                  <option value="">請選擇</option>
                  {payAccounts.filter((a) => a.method === planning.payment_method)
                    .map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                </select></label>
              <div className="text-xs text-gray-400">
                金額 ${fmt(planning.total_amount)}
                {planning.payee_account ? `・匯給 ${planning.payee_company ?? ''} ${planning.payee_account}` : ''}
              </div>
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setPlanning(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={savePlan} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">儲存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
