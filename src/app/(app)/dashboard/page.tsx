'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DASH_TABS, parseTab, pillsApply, whyPillsOff,
  sourcePills, perf,
  COMBO_MODES, parseComboMode, effectiveComboMode, monthsBetween,
  comboRow, occSegments, moneyTop, MONEY_TICKS, axisLabels,
  type ComboMode, type ComboRow, type ComboOcc,
} from '@/lib/dash';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
/*
 * 財務儀錶板只看安幸（migration_159）。
 *
 * ★★ 每一支收入／支出查詢都必須帶 book —— 漏掉一支的話，
 *   愛皮洪鯊的錢會混進安幸的數字裡，而**金額看起來完全正常**。
 *   營收那半邊不用改:它讀的是 revenue_recognitions，
 *   而非安幸的訂單根本不會產生認列（migration_161）。
 */
import { DEFAULT_BOOK } from '@/lib/book';
import { ymOf, ymShow, ymMonth, monthsAgo, todayStr, fmtRange } from '@/lib/period';
// Supabase 一次只回 1000 列且不報錯 —— 這一頁全部是加總,一定要撈完
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, FilterSelect, FilterDateRange, FilterClear } from '@/lib/filters';
import { srcLabel, rentOnly } from '@/lib/revenue-report';
import {
  toWan, pickedLabel, noSrcFilter, toggleSrc, splitBySrc, cardRows,
  applySrcPicks, bySourceOf, ymDash, monthLabel, type BySource,
} from '@/lib/rev-occ';
import { isExcluded, toggleExcl, exclLabel } from '@/lib/exclude';
import {
  type PeriodMode, yearRange, monthRange, prevPeriod, lastYearPeriod,
  yoySameAsPrev, growth, partialMonth, sameMonthRange,
} from '@/lib/compare';
import RangeInput from '@/components/RangeInput';
/*
 * 住房率（2026-09-16 使用者:「財務儀錶板多一個入住率，各房源期間都有入住率」）
 * ★ 2026-09-18 起全站改叫**住房率**（使用者指定）—— 上面那句是當時的原話。。
 *
 * ★★★ 算式在 `lib/occupancy.ts`（28 個測試），差一天的規則沿用
 *   `lib/room-calendar.ts` 的 `occupies()`（59 個測試）——
 *   這一頁只負責排版。在這裡另外寫一份的話，
 *   同一間房會在儀錶板與房源狀態顯示不同的結果。
 */
import {
  occupancyByRoom, occupancyByEstate, totalOccupancy, occupancyByMonth, isPartialMonth,
  subtreeOf, contractOccupiesRoom, type RoomNode,
  fmtPct, occTone, type RoomOcc,
} from '@/lib/occupancy';
import { dropContractOrders, type Stay } from '@/lib/room-calendar';

/**
 * 財務儀表板。
 *
 * 【資料來源刻意分開三條】
 *   營收  revenue_recognitions  —— 已經按月拆好的認列，不是 orders.amount。
 *                                 跨月訂單在 orders 上是一整筆，只有這張表才知道
 *                                 3 萬元裡有多少落在 8 月、多少在 9 月。
 *   支出  expenses              —— 走 spent_on（花錢的日期），不是 created_at。
 *   評價  reviews               —— 走 checkout_date（住宿期間），跟營收同一條時間軸。
 *
 * 三張表的期間篩選用同一組起訖日，數字才對得起來。
 *
 * 【為什麼不用圖表套件】
 * 專案目前零圖表相依。這裡的長條、折線、圓餅都是幾十行 SVG 就夠，
 * 為了它們裝 recharts 會讓 bundle 多幾百 KB，而且多一個要跟著 React 升級的東西。
 */

type Rev = {
  ym: string; source: string; estate_id: string | null; property_id: string | null;
  month_amount: number; fee_type: string | null;
  /**
   * 這一列屬於哪一張訂單。
   *
   * 【為什麼算筆數一定要用它】
   * 一列 = 一個月的認列，一筆跨三個月的訂單就有三列。
   * 直接數列數的話「訂單數」會被長租撐大好幾倍，
   * 而那個數字看起來完全正常 —— 沒有人會發現它算的是月份不是訂單。
   */
  order_id: string | null;
};
type Exp = {
  id: string;
  spent_on: string; amount: number; account_code: string | null;
  estate_id: string | null; property_id: string | null; purpose_type: string;
  item_name: string | null;
  /** 關注支出。遞延母子單會一起亮（migration_89）。 */
  starred?: boolean;
  /** 非營運支出（migration_181）—— 跟出租本業無關的花費。 */
  non_operating?: boolean;
  /** 遞延認列。母單的 amount 是「這一天認列多少」,實付總額在 gross_amount。 */
  deferred?: boolean; gross_amount?: number | null; parent_expense_id?: string | null;
};
type Ord = {
  source: string; checkin: string; estate_id: string | null; property_id: string | null;
  amount: number; paid: boolean;
};
type Rev5 = { checkout_date: string | null; property_id: string | null; overall_rating: number };
type Estate = { id: string; name: string; active: boolean };
type Property = {
  id: string; name: string; estate_id: string | null;
  /*
   * ★★★ 住房率的**分母**靠這兩欄。
   *   停用的、以及沒勾「排房表」的（2B10 那種只用來記支出、
   *   根本沒在出租的房源）留在分母裡，會把整體住房率一路往下拉，
   *   而畫面上完全看不出原因 —— 兩個開關不是一個（migration_255）。
   */
  active?: boolean | null;
  show_in_room_calendar?: boolean | null;
  /*
   * ★★★ 子母房源（migration_287）。整棟／整層是父，底下那幾間是子 ——
   *   兩邊都留在分母裡的話，開封住房率會是 24.4% 而實際是七成。
   *   `units` 是打通房（台1+2 一列算兩間）。
   * ★★ `count_in_occupancy` 跟 `show_in_room_calendar` 是**兩件事**：
   *   開封1F-1 整年有人住但不排房 —— 以前借同一個開關，所以一天都沒算到。
   */
  parent_id?: string | null;
  units?: number | null;
  count_in_occupancy?: boolean | null;
};
type Code = { code: string; name: string };
type Pending = { total_amount: number; planned_transfer_on: string | null };
/**
 * 比較期的原始列。
 *
 * **刻意不在 load 裡就彙總。** 彙總需要 matchScope(物業/房源篩選),
 * 而 matchScope 是從 properties 算出來的、properties 又是 load 設定的 ——
 * 把它放進 load 的相依會變成:
 *     load → setProperties → 新 matchScope → 新 load → 無限迴圈
 * 症狀是右上角「載入中」一直閃。
 *
 * 所以 load 只負責拿資料,篩選與加總都留到 useMemo。
 */
type CmpRaw = {
  /*
   * ★ order_id 是為了**算筆數**（2026-08-25 使用者:「筆數沒有上去 耶」）。
   *
   *   一列 = 一個月的認列，一筆跨三個月的長租有三列。
   *   不用 order_id 去重的話，比較期的筆數會被長租撐大好幾倍 ——
   *   而那個數字看起來完全正常，只是跟本期不是同一種東西。
   */
  rev: { source: string; estate_id: string | null; property_id: string | null; month_amount: number; order_id: string | null }[];
  exp: { estate_id: string | null; property_id: string | null; amount: number; non_operating?: boolean }[];
};
type Cmp = {
  rev: number; exp: number; ordN: number;
  bySource: Record<string, number>;
  /** 依物業的營收。key 與 estKey() 一致（estate_id 或 '(未指定物業)'）。 */
  byEstate: Record<string, number>;
  /** 依來源／依物業的**訂單筆數**（以 order_id 去重，與本期同一套算法） */
  cntBySource: Record<string, number>;
  cntByEstate: Record<string, number>;
};

// 來源標籤改用 @/lib/revenue-report 的 SOURCE_LABEL ——
// 這裡原本自己寫一份,漏了 office 與 company,畫面上就直接吐英文鍵出來。
// 顏色跟系統其他頁一致，讓「藍=一般、綠=好、紅=要注意」這組語言在全站通用
const SRC_COLOR: Record<string, string> = {
  airbnb: '#41689B', agoda: '#4E96D1', longterm: '#3FAE7C', private: '#8FB98A',
  oneoff: '#C9A227', partner: '#9B8BB4', airbnb_cancelled: '#C0563F',
};
const PALETTE = ['#41689B', '#4E96D1', '#3FAE7C', '#8FB98A', '#C9A227', '#9B8BB4', '#C0563F', '#7A8B99', '#B08968', '#6A9FB5'];

const nf = (n: number) => Math.round(n).toLocaleString('en-US');
const money = (n: number) => 'NT$' + nf(n);
/** 大數字縮寫。儀表板上 1,234,567 佔太寬又難讀，123.5 萬一眼就知道量級。 */
const short = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(1) + '億';
  if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '萬';
  return nf(n);
};


export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), []);
  // 角色由 layout 的 ProfileProvider 提供，全站只查一次（lib/profile.tsx）
  const { role } = useProfile();
  const [loading, setLoading] = useState(true);
  /** 資料沒撈完時的警告。這一頁全部是加總,少一列就是錯的,不能靜靜顯示。 */
  const [truncated, setTruncated] = useState('');

  const [revs, setRevs] = useState<Rev[]>([]);
  const [exps, setExps] = useState<Exp[]>([]);
  const [ords, setOrds] = useState<Ord[]>([]);
  const [rvs, setRvs] = useState<Rev5[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  /*
   * 住房率的佔用資料。**自己一條 useEffect**，不併進 `load()`。
   *
   * ★★ 併進去的話，「載入中」要等到最慢那一支才消失，
   *   而住房率不是打開儀錶板第一眼要看的東西（同一頁上面
   *   「兩批」那段註解寫的理由）。它自己顯示「計算中…」。
   *
   * ★ 也不併進 `later`：那個陣列的解構順序有一條白紙黑字的警告，
   *   多插一個位置正是它在講的那種錯。
   */
  const [occStays, setOccStays] = useState<Stay[]>([]);
  const [occLoading, setOccLoading] = useState(true);
  const [occErr, setOccErr] = useState('');

  // ── 篩選：期間 / 物業 / 房源 ────────────────────────
  // 預設近 12 個月 —— 一年的區間才看得出季節性，這是短租最重要的形狀。
  /*
   * 【預設本月，不是近 12 個月】（2026-08-15 使用者指定）
   *
   * 實測打開一次要 3.4 秒，其中一大塊是 12 個月的資料量 ——
   * 訂單與認列都破 1000 列各要多翻一輪分頁，比較期也跟著各撈 12 個月。
   *
   * 12 個月是「偶爾想看」的區間，不該是每次打開都跑的。
   * 想看整年按右上角的快捷鍵。
   */
  const [fromD, setFromD] = useState(monthsAgo(0));
  const [toD, setToD] = useState(todayStr());
  const [estF, setEstF] = useState('');
  const [propF, setPropF] = useState('');
  /*
   * 期間模式。年/月只是「產生 fromD/toD 的捷徑」,底層仍然是同一組起訖日 ——
   * 所有查詢與圖表都不用知道模式的存在。
   *
   * 預設 custom + 近 12 個月:一年的區間才看得出季節性,那是短租最重要的形狀。
   */
  const [mode, setMode] = useState<PeriodMode>('custom');
  const [yearSel, setYearSel] = useState(new Date().getFullYear());
  const [monthSel, setMonthSel] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  /** 比較用的兩組數字。環比=上一期,同比=去年同期。 */
  const [cmpRaw, setCmpRaw] = useState<{ prev: CmpRaw; yoy: CmpRaw } | null>(null);
  /*
   * ══════════════════════════════════════════════════════════
   * 【只算本業】兩顆排除開關（2026-08-29 使用者:
   *   「排除一次性收入也放進來」「做完整張表都會影響 可以看不同的分析」）
   *
   *   exOneoff  排除一次性收入（其他收入、Airbnb 取消）—— 收入側
   *   exNonOp   排除非營運支出（migration_181）—— 支出側
   *
   * ★★★ 作用域是**整頁**，不再只有期間比較那一張表。
   *
   *   `exOneoff` 前身是「只看房租」,2026-08-25 刻意限制成只影響那張表,
   *   理由是「跑去改整頁的話,使用者會看到自己沒動過的數字也變了」。
   *   2026-08-29 推翻:使用者要的是「可以看不同的分析」——
   *   一份完整的營運口徑報表,而不是只有一張表換口徑、其他還是總口徑。
   *
   * ★★ 同一頁兩種口徑比「整頁一起變」更危險:
   *   上面的卡說支出 913 萬、下面的表說 870 萬,兩個數字都對,
   *   而截圖出去的人不知道自己截到哪一種。
   *   所以改成整頁一起變 ＋ 開著的時候在畫面上明講。
   *
   * ★ 不寫進網址也不記憶:這是「我現在想換個角度看」，不是設定。
   *   記住的話下次打開會看到一個扣過的數字而不知道為什麼。
   * ══════════════════════════════════════════════════════════
   */
  /*
   * ══════════════════════════════════════════════════════════
   * 分頁（2026-09-18 使用者:「財務儀錶板 裡面分一下 各種 tab」）
   * ══════════════════════════════════════════════════════════
   * ★★★ 篩選列（期間、物業、房源、只算本業）**在分頁的上面**，
   *   四頁共用 —— 切分頁不會把剛才選的條件清掉
   *   （使用者:「統一 上面有期間 filter 物業 filter」）。
   * ★★ 分頁記在網址的 `?tab=` 上:把「支出分析」傳給會計，
   *   她點開看到的才是支出分析，不是營收分析。
   */
  const [tab, setTabRaw] = useState(() => parseTab(
    typeof window === 'undefined' ? '' : new URLSearchParams(location.search).get('tab')));
  const setTab = useCallback((t: string) => {
    const v = parseTab(t);
    setTabRaw(v);
    if (typeof window !== 'undefined') {
      const u = new URL(location.href);
      u.searchParams.set('tab', v);
      history.replaceState(null, '', u.toString());
    }
  }, []);

  /*
   * 營收來源膠囊（2026-09-18 使用者:「營收來源 膠囊 可以點 計算所有營收」）。
   * ★★★ 2026-09-21 改成**複選**（使用者:「不是 mece 可以複選」）——
   *   來源本來就不是互斥的分類，一次只能看一種答不了「這兩個加起來多少」。
   * ★ 再點一下拿掉;空陣列 ＝ 沒篩。**全部都亮也是沒篩**（`noSrcFilter`）。
   */
  const [srcPicks, setSrcPicks] = useState<string[]>([]);
  /*
   * ★★★ 排除物業（2026-09-21 使用者:「filter 要怎麼排除呢？」）。
   *   跟「選物業」是相反的預設:**預設全部都在**，把不想看的踢出去。
   *   七棟裡不想看一棟，用選的要點六下，用排除的點一下。
   * ★★ 關掉分頁就重置（不存到帳號）—— 要記住的話之後加一支存偏好的 API，
   *   不影響現在這個架構。
   */
  const [exclEst, setExclEst] = useState<string[]>([]);
  const [exclOpen, setExclOpen] = useState(false);
  /*
   * ★★★ 下拉的位置要**量完再夾**，不能用 `absolute left-0`。
   *   篩選列會換行，按鈕的 x 位置跟著視窗寬度跑 ——
   *   `left:0` 在 390px 往右超出 23px、改成 `right:0` 又在 560px 往左跑出畫面。
   *   **沒有一個固定的方向是永遠對的**（兩種我都量過）。
   *   跟營收圖那張卡片同一套做法。
   */
  const exclBtn = useRef<HTMLButtonElement>(null);
  const exclBox = useRef<HTMLDivElement>(null);
  const [exclPos, setExclPos] = useState({ left: -9999, top: -9999 });
  useEffect(() => {
    if (!exclOpen) return;
    const put = () => {
      const b = exclBtn.current?.getBoundingClientRect();
      const n = exclBox.current;
      if (!b || !n) return;
      const w = n.offsetWidth, h = n.offsetHeight, pad = 12;
      let left = b.left, top = b.bottom + 4;
      if (left + w + pad > window.innerWidth) left = window.innerWidth - w - pad;
      if (top + h + pad > window.innerHeight) top = b.top - h - 4;
      setExclPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
    };
    put();
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [exclOpen, exclEst]);

  /*
   * 「營收與住房率」那張圖要畫哪一種。
   * `null` ＝ 使用者還沒按過 —— 這時由區間長度決定（`effectiveComboMode`）。
   */
  const [comboPick, setComboPick] = useState<ComboMode | null>(null);

  const [exOneoff, setExOneoff] = useState(false);
  const [exNonOp, setExNonOp] = useState(false);
  /** 載入編號。比較期是背景補的，回來時要確認自己還是最新那一次 */
  const runRef = useRef(0);

  function applyMode(m: PeriodMode, y = yearSel, ym = monthSel) {
    setMode(m);
    if (m === 'year') { const [f, t] = yearRange(y); setFromD(f); setToD(t); }
    else if (m === 'month') {
      const [f, t] = monthRange(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
      setFromD(f); setToD(t);
    }
  }


  // ── 物業/房源篩選在前端做（資料已按期間縮小）──────
  // 認列與支出的 estate_id 有機會是空的（訂單本身沒歸物業，或匯入時漏帶）。
  // 那種列若直接排除，物業視角的營收就會憑空少一塊而且不會有人發現 ——
  // 所以 estate_id 空的時候用 property_id 回推它屬於哪個物業。
  const estateOfProp = useMemo(
    () => Object.fromEntries(properties.map((p) => [p.id, p.estate_id])), [properties]);

  /**
   * 這一列屬於哪個物業。
   * estate_id 可能是空的（訂單沒歸物業或匯入時漏帶），那時用 property_id 回推 ——
   * 直接排除的話物業視角的營收會憑空少一塊，而且沒有人會發現。
   *
   * **本期與比較期一定要用同一支**，不然兩邊會對到不同的物業。
   */
  const estKey = useCallback((estate_id: string | null, property_id: string | null) =>
    estate_id ?? (property_id ? estateOfProp[property_id] : null) ?? '(未指定物業)', [estateOfProp]);

  const matchScope = useCallback((estate_id: string | null, property_id: string | null) => {
    /*
     * ★★★ 排除也套在這裡，因為這是**唯一的咽喉點** ——
     *   `fRevs`／`fExps`（本期）跟 `roll()`（上一期、去年同期）都走它。
     *   在別的地方各濾一次的話，環比會變成「排除後的本期」對
     *   「沒排除的上一期」，百分比是假的而畫面上完全看不出來
     *   （「只算本業」那兩顆當初就是為了這件事寫在最上游的）。
     */
    const ek = estate_id ?? (property_id ? estateOfProp[property_id] : null);
    if (isExcluded(exclEst, ek ?? '(未指定物業)')) return false;
    if (propF) return property_id === propF;
    if (estF) return ek === estF;
    return true;
  }, [estF, propF, estateOfProp, exclEst]);

  const load = useCallback(async () => {
    /*
     * 【為什麼要編號】
     *
     * 比較期改成背景補上之後，多了一個競態:連續切換期間時，
     * 上一次的比較期可能在這一次之後才回來，把新的數字蓋掉 ——
     * 而畫面上會是「本月的營收」配「上上個月的成長率」，
     * 兩個數字各自都合理，沒有人看得出來。
     *
     * 每次載入拿一個號碼，回來時對不上就整批丟掉。
     */
    const myRun = ++runRef.current;
    setLoading(true);
    setTruncated('');
    /*
     * 比較期資料先清掉。
     *
     * 不清的話，換期間之後成長率會**先顯示上一次的數字**再跳掉 ——
     * 而那個舊數字看起來完全正常，沒有人會發現它是上一個期間的。
     * 清成 null，畫面顯示「—」，等新的補上。
     */
    setCmpRaw(null);
    /*
     * 期間篩選一律在資料庫端做。全撈回來前端篩，資料一多就會卡在瀏覽器。
     *
     * 【每一個都要 fetchAll —— 2026-08 的教訓】
     * Supabase 預設一次只回 1000 列，**超過的靜靜丟掉、不報錯**。
     * 這一頁原本全部沒有分頁，於是：
     *   年模式（12 個月的營收認列，早就破 1000）→ 8 月營收顯示 378 萬
     *   月模式（只撈 8 月，沒破）              → 同一個月顯示 898 萬
     * 兩個畫面互相矛盾，而且沒有任何錯誤訊息。
     * 當時「訂單數」本期與上一期都剛好是 1,000 筆 —— 那個整數是唯一的線索。
     */
    /*
     * 【比較期跟主查詢一起發】（2026-08-15）
     *
     * 原本是「主查詢全部回來 → 再發比較期」。那兩組**沒有任何依賴關係** ——
     * 比較期的區間只由 mode/fromD/toD 算出來，不需要主查詢的任何結果。
     *
     * 實測那一等就是 750ms:主查詢在 2168ms 開始、2427ms 結束，
     * 比較期到 2922ms 才發出去。改成一起發之後那段完全消失。
     */
    const [pf, pt] = prevPeriod(mode, fromD, toD);
    const [yf, yt] = lastYearPeriod(mode, fromD, toD);

    /*
     * 【同一段月份只查一次】
     *
     * 近 12 個月的預設區間下，環比與同比換算成 ym 是同一段 ——
     * 實測 `revenue_recognitions?ym=gte.202409&ym=lte.202508` 跑了兩次，
     * 一模一樣，而且那是全頁最大的一支（要分頁）。
     *
     * 只有認列表能省:支出與訂單是日粒度的，那兩段真的不同。
     */
    const revSameSpan = sameMonthRange([pf, pt], [yf, yt]);

    const cmpRev = (f: string, t: string) =>
      fetchAll<CmpRaw['rev'][number]>((a, b) => supabase.from('revenue_recognitions')
        .select('source, estate_id, property_id, month_amount, order_id')
        .gte('ym', ymOf(f)).lte('ym', ymOf(t)).range(a, b));
    const cmpExp = (f: string, t: string) =>
      fetchAll<CmpRaw['exp'][number]>((a, b) => supabase.from('expenses')
        .select('amount, estate_id, property_id, non_operating')
        // 只算安幸（migration_159）—— 少了它，愛皮洪鯊的錢會混進安幸的數字裡
        .eq('book', DEFAULT_BOOK)
        .gte('spent_on', f).lte('spent_on', t).range(a, b));
    /*
     * ★★ 比較期不再撈 `orders`（2026-08-29）。
     *
     *   訂單數改成從認列去重之後，這兩支查詢（環比 ＋ 同比）就沒有人用了。
     *   留著不會壞，但**留一個撈了卻沒用的欄位比刪掉更危險** ——
     *   下一個人會以為訂單數是從它算的，然後照著它去 debug。
     */

    /*
     * 【兩批：先畫得出來的，後補的】（2026-08-16）
     *
     * 全部 16 支放在同一個 await 裡的話，「載入中」要等到**最慢那一支**
     * 才消失 —— 而其中六支是比較期（成長率）與待付款，那些不是
     * 打開儀表板第一眼要看的東西。
     *
     * 拆成兩批之後：主資料回來就把畫面畫出來，比較期在背景補。
     * 兩批**同時發出**，所以總時間沒有變長，只是不用等齊。
     *
     * 成長率在補上之前顯示「—」，不是先顯示一個錯的再跳掉 ——
     * 數字自己變動比慢一點更讓人不信任。
     */
    const later = Promise.all([
      cmpRev(pf, pt), cmpExp(pf, pt),
      // 同一段月份的話不重發，下面直接沿用環比的結果
      revSameSpan ? Promise.resolve(null) : cmpRev(yf, yt),
      cmpExp(yf, yt),
      // 待付款是側欄的一張小卡，晚幾百毫秒沒有人會發現
      fetchAll<Pending>((f, t) => supabase.from('purchase_requests')
        .select('total_amount, planned_transfer_on')
        .eq('book', DEFAULT_BOOK)
        .eq('status', 'approved').is('purchased_on', null).range(f, t)),
    ]);

    const [
      rv, ex, od, r5, es, pr, cd,
    ] = await Promise.all([
      fetchAll<Rev>((f, t) => supabase.from('revenue_recognitions')
        .select('ym, source, estate_id, property_id, month_amount, fee_type, order_id')
        .gte('ym', ymOf(fromD)).lte('ym', ymOf(toD)).range(f, t)),
      fetchAll<Exp>((f, t) => supabase.from('expenses')
        .select('id, spent_on, amount, account_code, estate_id, property_id, purpose_type, item_name, starred, non_operating, deferred, gross_amount, parent_expense_id')
        .eq('book', DEFAULT_BOOK)
        .gte('spent_on', fromD).lte('spent_on', toD).range(f, t)),
      fetchAll<Ord>((f, t) => supabase.from('orders')
        .select('source, checkin, estate_id, property_id, amount, paid')
        .eq('book', DEFAULT_BOOK)
        .gte('checkin', fromD).lte('checkin', toD).range(f, t)),
      fetchAll<Rev5>((f, t) => supabase.from('reviews')
        .select('checkout_date, property_id, overall_rating')
        // 人工隱藏的不算（migration_178）—— 要跟評價頁與 review_stats 一致,
        // 三個地方有一個沒加,同一段期間就會出現兩種平均星等
        .is('hidden_at', null)
        .gte('checkout_date', fromD).lte('checkout_date', toD).range(f, t)),
      fetchAll<Estate>((f, t) => supabase.from('estates')
        .select('id, name, active').order('sort').order('name').range(f, t)),
      /*
       * 房源也要分頁。它看起來是小主檔，但 estateOfProp 靠它把
       * 「沒有 estate_id 的認列」回推到物業 —— 少撈幾間房，
       * 那些認列就會從物業視角的營收裡整塊消失，而且沒有跡象。
       */
      fetchAll<Property>((f, t) => supabase.from('properties')
        .select('id, name, estate_id, active, show_in_room_calendar, parent_id, units, count_in_occupancy')
        .order('name').range(f, t)),
      fetchAll<Code>((f, t) => supabase.from('account_codes')
        .select('code, name').range(f, t)),
    ]);

    // 撈不完就明講。這一頁的數字全部是加總，少一列就是錯的 ——
    // 靜靜顯示一個偏低的數字比顯示錯誤訊息糟糕得多。
    if (myRun !== runRef.current) return;   // 已經有更新的一次在跑了
    const bad = [rv, ex, od, r5, es, pr, cd].find((r) => r.error);
    if (bad?.error) setTruncated(bad.error);

    setRevs(rv.rows);
    setExps(ex.rows);
    setOrds(od.rows);
    setRvs(r5.rows);
    setEstates(es.rows);
    setProperties(pr.rows);
    setCodes(cd.rows);

    // 主資料到齊 —— 畫面現在就畫得出來，不等比較期
    setLoading(false);

    /*
     * 比較期在背景補上。
     *
     * 環比(上一期)與同比(去年同期)分開查而不是拉一個大區間再切:
     * 2026-08 對 2025-08 中間隔了 11 個月,一次撈會把不需要的月份全部拉回來。
     *
     * 分頁一樣不能省 —— 少了的話「去年同期」會偏低,成長率跟著假,
     * 而那個假的百分比看起來完全正常,不會有人懷疑。
     */
    /*
     * ★★ 解構的順序要跟 `later` 那個陣列**一字不差**。
     *   拿掉 cmpOrd 之後少了兩個位置 —— 忘了同步的話,
     *   `pd`（待付款）會接到 `yExp`（去年支出），
     *   而型別如果剛好相容的話 tsc 也不會抱怨,畫面只是數字不對。
     */
    const [pRev, pExp, yRevMaybe, yExp, pd] = await later;
    if (myRun !== runRef.current) return;
    const badLater = [pRev, pExp, yExp, pd].find((r) => r?.error);
    if (badLater?.error) setTruncated(badLater.error);

    setPending(pd.rows);
    setCmpRaw({
      prev: { rev: pRev.rows, exp: pExp.rows },
      // 同一段月份時沿用環比的認列 —— 上面已經確認過那兩段的 ym 完全相同
      yoy: { rev: (yRevMaybe ?? pRev).rows, exp: yExp.rows },
    });
    // matchScope 不能放進來 —— 見 CmpRaw 的說明,會變成無限迴圈
  }, [supabase, fromD, toD, mode]);

  /*
   * 【不等 role 就開始載】（2026-08-15）
   *
   * 原本是 `if (role) load()` —— 資料查詢排在「查身分 → 查角色」後面，
   * 實測那一等 627ms。
   *
   * 但 role 在這裡的用途只有「要不要渲染這一頁」，**不是安全機制** ——
   * 真正的把關是資料庫的 RLS。前端等 role 才敢查，等的是一個
   * 已經有人在擋的東西。
   */
  useEffect(() => { load(); }, [load]);

  /*
   * ══════════════════════════════════════════════════════════
   * 住房率的佔用資料。
   *
   * ★★★ 撈的條件是「跟這段**有交集**」，不是「起日落在這段裡」——
   *   後者會漏掉跨進來的長住（8/20 住到 9/10 那種），
   *   而那間房會被算成整個月空著。住房率是用來做決定的數字，
   *   偏低的那種錯**看起來完全正常**。
   *
   * ★★ 訂單的 `checkout` 是退房日，所以條件是 `> fromD` 不是 `>=`:
   *   9/1 退房的單最後一晚是 8/31，跟九月沒有交集。
   *
   * ★ 房源狀態那頁同一組條件、同一份 `dropContractOrders()` ——
   *   兩頁講同一件事就不該撈出不同的東西。
   * ══════════════════════════════════════════════════════════
   */
  const loadOcc = useCallback(async () => {
    setOccLoading(true);
    setOccErr('');
    const oq = await fetchAll<any>((a, b) => supabase.from('orders')
      .select('id, property_raw, guest_name, checkin, checkout, source, contract_id')
      .not('source', 'in', '(oneoff,airbnb_cancelled)')
      .lte('checkin', toD).gt('checkout', fromD).range(a, b));
    /*
     * ★★★ 契約也要分頁。Supabase 預設最多回 1000 列而且不報錯 ——
     *   長租契約累積幾年就會超過，而超過之後那幾間房會被算成整段空著，
     *   住房率安靜地變低。
     */
    const cq = await fetchAll<any>((a, b) => supabase.from('contracts')
      .select('id, room, tenant_name, display_name, start_date, end_date, active, type')
      .lte('start_date', toD).gte('end_date', fromD).range(a, b));

    /* 撈不完就明講 —— 少一列就是住房率偏低，而那個數字看起來很正常 */
    if (oq.error) setOccErr('訂單沒有撈完：' + oq.error);
    else if (cq.error) setOccErr('契約沒有撈完：' + cq.error);

    const oStays: Stay[] = ((oq.rows as any[]) ?? [])
      .filter((o) => o.property_raw)
      .map((o) => ({
        id: `o${o.id}`, srcId: o.id as string,
        room: o.property_raw as string, kind: 'order' as const,
        start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
        contractId: o.contract_id as string | null,
      }));
    const cStays: Stay[] = ((cq.rows as any[]) ?? [])
      /* ★★★ 公司登記／辦公室登記只掛物業、沒有房號 —— 不佔房間。
           以前是靠「room 是空字串」偶然擋住的，規則現在寫在 lib 裡。 */
      .filter((c) => c.active !== false && contractOccupiesRoom(c))
      .map((c) => ({
        id: `c${c.id}`, srcId: c.id as string,
        room: c.room as string, kind: 'contract' as const,
        start: c.start_date, end: c.end_date,
        guest: c.display_name || c.tenant_name,
        tone: 'longterm' as const, contractId: c.id as string,
      }));

    /*
     * ★★★ 契約產生的月租單跟契約畫的是同一段期間 —— 兩筆都留的話
     *   是同一件事被算兩次。逐日計算讓它不會把住房率灌爆（同一天只算一次），
     *   但留著它等於讓一份資料有兩個來源，而哪天算法一變就會出事。
     */
    setOccStays(dropContractOrders([...oStays, ...cStays]));
    setOccLoading(false);
  }, [supabase, fromD, toD]);
  useEffect(() => { loadOcc(); }, [loadOcc]);

  // 物業改了就把房源清掉 —— 否則會留著上一個物業的房間，篩出空結果
  function pickEstate(v: string) { setEstF(v); setPropF(''); }
  function clearFilters() {
    setFromD(monthsAgo(0)); setToD(todayStr()); setEstF(''); setPropF('');
    /* ★★ 排除也要清。不清的話「清除篩選」之後還有一個看不見的篩選在作用，
         而使用者會以為自己在看全部（anxing-ui:會篩選的東西消失時，
         它篩出來的狀態要跟著收掉）。 */
    setExclEst([]);
  }

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const propName = useMemo(() => Object.fromEntries(properties.map((p) => [p.id, p.name])), [properties]);
  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const propsOfEstate = useMemo(
    () => properties.filter((p) => !estF || p.estate_id === estF), [properties, estF]);

  /*
   * ══════════════════════════════════════════════════════════
   * 住房率。
   *
   * ★★★ 分母是**房源**，不是有訂單的房源。
   *   從訂單反推的話，「整段期間都空著」的房間根本不會進到分子分母裡 ——
   *   住房率會變成「有客人的房間有多滿」，永遠接近 100%，
   *   而那正是最不想被藏起來的那幾間。
   *
   * ★★ 停用的、沒勾「排房表」的排掉（理由在 `Property` 的註解）。
   *   `active` 欄位讀不到的時候（舊資料 null）當成**有效** ——
   *   預設把房源踢出分母的話，住房率會無聲地變高。
   *
   * ★ 篩選跟著頁面上的物業／房源走，跟其他圖表同一組條件。
   * ══════════════════════════════════════════════════════════
   */
  const occRooms = useMemo<RoomNode[]>(() => {
    /* ★★★ 停用的**物業**底下那些房也要排掉（2026-09-21 使用者：
         「停用物業不用算」）。以前只看房源那兩個開關，物業停用了
         底下的房還在分母裡，而畫面上只是住房率低了一點。 */
    const liveEst = new Set(estates.filter((e) => e.active !== false).map((e) => e.id));
    const nameOf: Record<string, string> = {};
    properties.forEach((p) => { nameOf[p.id] = p.name; });

    const pool: RoomNode[] = properties
      .filter((p) => p.active !== false)
      /* ★★ 用 count_in_occupancy 不是 show_in_room_calendar —— 兩件事 */
      .filter((p) => p.count_in_occupancy !== false)
      .filter((p) => !p.estate_id || liveEst.has(p.estate_id))
      .map((p) => ({
        name: p.name,
        estate: p.estate_id ? (estateName[p.estate_id] ?? null) : null,
        parent: p.parent_id ? (nameOf[p.parent_id] ?? null) : null,
        units: p.units ?? 1,
      }));

    if (!estF && !propF) return pool;
    /* ★ 篩選要連子孫一起帶（選「開封整棟」＝ 看它底下那四間），
         祖先也要帶（選「開封3F」時，記在整棟上的那幾天不能消失）。 */
    const picked = properties
      .filter((p) => (!estF || p.estate_id === estF) && (!propF || p.id === propF))
      .map((p) => p.name);
    return subtreeOf(pool, picked);
  }, [properties, estates, estF, propF, estateName]);

  /*
   * ★ 抽出來是因為「按月」那張圖也要用同一份。
   *   兩邊各自 group 一次的話，遲早會有一邊漏掉某種佔用，
   *   而症狀是「整體 70%、十二個月加起來卻不是 70%」。
   */
  const occByRoom = useMemo(() => {
    const by: Record<string, Stay[]> = {};
    occStays.forEach((s) => { (by[s.room] ??= []).push(s); });
    return by;
  }, [occStays]);

  const occList = useMemo<RoomOcc[]>(
    () => occupancyByRoom(occRooms, occByRoom, { from: fromD, to: toD }),
    [occByRoom, occRooms, fromD, toD]);

  const occAll = useMemo(() => totalOccupancy(occList), [occList]);

  /*
   * ══════════════════════════════════════════════════════════
   * 各物業住房率。（2026-09-16 使用者:「入住率不需要到房源，
   * 需要整體表現，各物業入住率就好 —— 入住天數 / 期間天數」。
   *   ★ 2026-09-18 起叫**住房率**，上面是當時的原話）
   *
   * ★★★ 一個物業的住房率 ＝ **那棟所有房間的入住天數總和**
   *   ÷（那棟幾間房 × 期間天數）。不是各房住房率的平均 ——
   *   兩者在房數天數一樣時剛好相等，所以特別容易寫錯（算式在 lib，有測試）。
   *
   * ★★ 房源那一層還是算，因為它是這個加總的輸入 ——
   *   只是**不畫出來**。123 列房號回答不了「這個月表現如何」，
   *   而那是儀錶板要回答的問題（原本畫了，使用者劃掉）。
   *
   * ★ 排序照側邊選單的物業順序（`estates` 撈回來就是 `sort` 排好的），
   *   不是照名字的筆劃 —— 兩個地方順序不一樣，人會以為是兩份資料。
   * ══════════════════════════════════════════════════════════
   */
  const occByEst = useMemo(() => {
    const ix: Record<string, number> = {};
    estates.forEach((e, i) => { ix[e.name] = i; });
    return occupancyByEstate(occList)
      .sort((a, b) => (ix[a.estate] ?? 9999) - (ix[b.estate] ?? 9999));
  }, [occList, estates]);


  /** 比較期的彙總。篩選在這裡才套,load 只負責拿資料(見 CmpRaw)。 */
  const cmp = useMemo(() => {
    if (!cmpRaw) return null;
    const roll = (c: CmpRaw): Cmp => {
      /*
       * ★★ 「只看房租」要**同時**套在本期與比較期。
       *
       *   只濾本期的話，比較的是「本期房租」對「上期房租＋一次性」——
       *   分母憑空變大，成長率一律偏低，而畫面上完全看不出來。
       */
      const rr = rentOnly(c.rev.filter((x) => matchScope(x.estate_id, x.property_id)), exOneoff);
      const bySource: Record<string, number> = {};
      const byEstate: Record<string, number> = {};
      /*
       * ★★ 筆數要用 order_id 去重，跟本期的 groupCount 同一套規則。
       *
       *   兩邊算法不一樣的話，「86 筆 → 120 筆」這種比較會憑空成長，
       *   而**每一個數字單看都是對的** —— 只是一邊數訂單、一邊數月份。
       *   order_id 是空的（舊資料）就退回用那一列自己當一筆，
       *   寧可多算也不要少算（跟 groupCount 的取捨一致）。
       */
      const seenSrc: Record<string, Set<string>> = {};
      const seenEst: Record<string, Set<string>> = {};
      /*
       * ★★★ 訂單數改成「這一期有營收認列的訂單」（2026-08-29 使用者:「都算阿」）。
       *
       *   舊做法是數 `orders` 表裡 **checkin 落在這一期**的訂單 ——
       *   一張 8/1~10/30 的長租只會算在 8 月,9、10 月都不算。
       *   而使用者要的是「這個月有幾張訂單在跑」:三個月都算 1 筆。
       *
       * ★★ 而且舊做法跟正下方「依來源／依物業」的筆數**不是同一套**:
       *   那幾列數的是「該月有認列的訂單」。截圖那一期是
       *   訂單數 142 對上依來源合計 162 —— 差的 20 筆就是
       *   7 月以前入住、8 月還在認列的長租。
       *   **兩個數字都對，但同一張表上「筆」是兩個意思。**
       */
      const seenAll = new Set<string>();
      rr.forEach((x, i) => {
        const amt = Number(x.month_amount || 0);
        const ek = estKey(x.estate_id, x.property_id);
        bySource[x.source] = (bySource[x.source] ?? 0) + amt;
        // 用同一支 estKey —— 認列的 estate_id 有機會是空的，
        // 那時要用 property_id 回推。兩邊用不同規則的話本期跟上一期會對到不同的物業。
        byEstate[ek] = (byEstate[ek] ?? 0) + amt;
        const oid = x.order_id ?? `__row${i}`;
        (seenSrc[x.source] ??= new Set()).add(oid);
        (seenEst[ek] ??= new Set()).add(oid);
        seenAll.add(oid);
      });
      const sizes = (m: Record<string, Set<string>>) =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.size]));
      return {
        rev: rr.reduce((a, x) => a + Number(x.month_amount || 0), 0),
        /*
         * ★★ 排除非營運要**同時**套在本期與比較期，跟一次性收入同一個道理:
         *   只濾本期的話，比較的是「本期營運支出」對「上期全部支出」——
         *   分母憑空變大，成長率一律偏低，而畫面上完全看不出來。
         */
        exp: c.exp.filter((x) => matchScope(x.estate_id, x.property_id))
          .filter((x) => !(exNonOp && x.non_operating))
          .reduce((a, x) => a + Number(x.amount || 0), 0),
        ordN: seenAll.size,
        bySource,
        byEstate,
        cntBySource: sizes(seenSrc),
        cntByEstate: sizes(seenEst),
      };
    };
    return { prev: roll(cmpRaw.prev), yoy: roll(cmpRaw.yoy) };
  }, [cmpRaw, matchScope, estKey, exOneoff, exNonOp]);

  /*
   * ★★★ 兩個排除在**最上游**就套掉。
   *
   *   下游有十幾個 useMemo（總額、月趨勢、依科目、依物業、關注支出…）
   *   全部從這兩個陣列長出來 —— 在這裡濾一次，它們自動都是同一個口徑。
   *   逐一去改的話，漏掉一個就是「同一頁兩種口徑」，而那不會報錯。
   */
  const fRevs = useMemo(
    () => rentOnly(revs.filter((r) => matchScope(r.estate_id, r.property_id)), exOneoff),
    [revs, matchScope, exOneoff]);
  const fExps = useMemo(
    () => exps.filter((e) => matchScope(e.estate_id, e.property_id))
      .filter((e) => !(exNonOp && e.non_operating)),
    [exps, matchScope, exNonOp]);
  const fOrds = useMemo(() => ords.filter((o) => matchScope(o.estate_id, o.property_id)), [ords, matchScope]);
  const fRvs = useMemo(() => rvs.filter((r) => {
    if (propF) return r.property_id === propF;
    if (estF) return properties.find((p) => p.id === r.property_id)?.estate_id === estF;
    return true;
  }), [rvs, estF, propF, properties]);

  // ── 核心數字 ────────────────────────────────────────
  /*
   * ★★★ 膠囊**只在營收分析那一頁生效**（`lib/dash.ts` 有寫理由，有測試）。
   *   別頁有支出與淨額，而支出沒有「來源」這個欄位 ——
   *   只篩營收的話「淨額 ＝ 營收 − 支出」會變成
   *   「長租的營收 − 全部的支出」，一個看起來很正常的錯數字。
   */
  const pills = useMemo(() => sourcePills(fRevs), [fRevs]);
  /** 全部來源的 key，順序照膠囊（金額大的在前）—— 圖、表、卡片共用同一個順序 */
  const srcKeys = useMemo(() => pills.map((p) => p.key), [pills]);
  const picks = useMemo(() => (pillsApply(tab) ? srcPicks : []), [tab, srcPicks]);
  /** 有沒有真的在篩（一顆都沒亮、或全部都亮，兩種都是沒篩） */
  const srcOn = !noSrcFilter(picks, srcKeys);
  /** 選中的那幾個叫什麼。`max` 小的地方封頂，有一整行可以寫的地方傳大的 */
  const pickName = (max = 3) => pickedLabel(picks.map(srcLabel), srcKeys.length, max);
  const pRevs = useMemo(
    () => applySrcPicks(fRevs, picks, srcKeys), [fRevs, picks, srcKeys]);
  const perfNow = useMemo(() => perf(pRevs, fRevs, srcOn), [pRevs, fRevs, srcOn]);

  const totalRev = useMemo(() => fRevs.reduce((s, r) => s + Number(r.month_amount || 0), 0), [fRevs]);
  const totalExp = useMemo(() => fExps.reduce((s, e) => s + Number(e.amount || 0), 0), [fExps]);
  /*
   * 關注支出。日期新的排前面 —— 要追蹤的通常是最近發生的。
   * 子單也會亮（母子連動),所以一組遞延會出現好幾列 ——
   * 那是對的:每一列是不同月份的認列,本來就該分開看。
   */
  const starred = useMemo(
    () => fExps.filter((e) => e.starred).sort((a, b) => (a.spent_on < b.spent_on ? 1 : -1)),
    [fExps]);
  const starredTotal = useMemo(() => starred.reduce((s, e) => s + Number(e.amount || 0), 0), [starred]);
  const net = totalRev - totalExp;
  const margin = totalRev > 0 ? (net / totalRev) * 100 : 0;
  // 應收未收：訂單已成立但錢還沒收到。這是現金流最直接的風險部位。
  const unpaid = useMemo(
    () => fOrds.filter((o) => !o.paid).reduce((s, o) => s + Number(o.amount || 0), 0), [fOrds]);
  const unpaidCount = useMemo(() => fOrds.filter((o) => !o.paid).length, [fOrds]);
  const toPay = useMemo(() => pending.reduce((s, r) => s + Number(r.total_amount || 0), 0), [pending]);

  /**
   * 認列缺漏警示。
   *
   * 儀表板的營收一律看認列（訂單營收認列制），不是收款日期也不是 orders.amount。
   * 但如果訂單有金額、認列卻是 0，畫面會安靜地顯示「營收 NT$0」——
   * 那看起來像「這個月沒生意」，實際上是資料沒產生。兩者差很多，要講出來。
   */
  const revGap = useMemo(() => {
    const ordAmt = fOrds.reduce((s, o) => s + Number(o.amount || 0), 0);
    if (ordAmt <= 0) return null;
    if (totalRev > 0 && totalRev >= ordAmt * 0.5) return null;   // 跨月拆分本來就會有落差
    return { ordAmt, ordCount: fOrds.length };
  }, [fOrds, totalRev]);

  // ── 月度趨勢（營收 / 支出 / 淨額）────────────────────
  const months = useMemo(() => {
    const set = new Set<string>();
    fRevs.forEach((r) => set.add(r.ym));
    fExps.forEach((e) => set.add(ymOf(e.spent_on)));
    return Array.from(set).sort();
  }, [fRevs, fExps]);

  const trend = useMemo(() => months.map((m) => {
    const rev = fRevs.filter((r) => r.ym === m).reduce((s, r) => s + Number(r.month_amount || 0), 0);
    const exp = fExps.filter((e) => ymOf(e.spent_on) === m).reduce((s, e) => s + Number(e.amount || 0), 0);
    return { m, rev, exp, net: rev - exp };
  }), [months, fRevs, fExps]);

  // 上期比較：把區間對半切，後半跟前半比。
  // 「跟去年同期比」更準，但資料只有一年多，多數月份沒有去年可比。
  const mom = useMemo(() => {
    if (trend.length < 2) return null;
    const half = Math.floor(trend.length / 2);
    const prev = trend.slice(0, half).reduce((s, t) => s + t.rev, 0);
    const cur = trend.slice(half).reduce((s, t) => s + t.rev, 0);
    if (prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  }, [trend]);

  const groupSum = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { const k = key(r); m[k] = (m[k] ?? 0) + val(r); });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  /**
   * 每一組有幾張訂單。
   *
   * **一定要用 order_id 去重**：一列 = 一個月的認列，
   * 一筆跨三個月的長租就有三列。數列數的話那個數字會被長租撐大好幾倍，
   * 而它看起來完全正常 —— 沒有人會發現算的是月份不是訂單。
   *
   * order_id 是空的（舊資料）就退回用那一列自己當一筆，寧可多算也不要少算。
   */
  const groupCount = (rows: Rev[], key: (r: Rev) => string): Record<string, number> => {
    const seen: Record<string, Set<string>> = {};
    rows.forEach((r, i) => {
      const k = key(r);
      (seen[k] ??= new Set()).add(r.order_id ?? `__row${i}`);
    });
    return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]));
  };
  /*
   * 期間比較那張表專用的本期資料。★ 跟 `fRevs` 分開 ——
   * 其他區塊（圖表、明細、待付款）不該受這個勾選框影響。
   */
  /*
   * ★ 期間比較的本期資料。2026-08-29 之後跟 `fRevs` **完全相同** ——
   *   排除已經在上游套掉了。名字留著是因為下面有十幾處在用，
   *   改名的 diff 比留一個別名還大。
   */
  const cRevs = fRevs;
  const cTotalRev = useMemo(
    () => cRevs.reduce((s, r) => s + Number(r.month_amount || 0), 0), [cRevs]);
  const cNet = cTotalRev - totalExp;

  const cntBySource = useMemo(() => groupCount(cRevs, (r) => r.source), [cRevs]);
  /*
   * ★ 本期的訂單數。用 `groupCount` 分成同一組 —— **刻意重用那一支**,
   *   而不是自己寫一次 Set。兩邊的去重規則（含 order_id 為空時的退路）
   *   一定要一模一樣,不然「訂單數」跟「依來源合計」又會對不起來。
   */
  const cntOrders = useMemo(() => groupCount(cRevs, () => 'all').all ?? 0, [cRevs]);
  const cntByEstate = useMemo(
    () => groupCount(cRevs, (r) => estKey(r.estate_id, r.property_id)), [cRevs, estKey]);

  const revBySource = useMemo(
    () => groupSum(cRevs, (r) => r.source, (r) => Number(r.month_amount || 0)), [cRevs]);
  const revByEstate = useMemo(
    () => groupSum(cRevs, (r) => estKey(r.estate_id, r.property_id), (r) => Number(r.month_amount || 0)), [cRevs, estKey]);

  /**
   * 期間比較用的「依物業」。
   *
   * 【只列營運中的物業】（使用者指定）
   * 已停用的物業合約結束之後今年歸零、去年有數字，比出來永遠是 −100% ——
   * 那不是經營上的訊息，只是一個已經結束的事實，而它每一期都會佔掉一整列。
   *
   * 【本期是 0 但比較期有數字的也要列】
   * 只看本期有數字的話，「這一期完全沒收到錢」的物業會直接從表上消失 ——
   * 而那正是最需要被看到的一列。
   */
  const revByEstateCmp = useMemo(() => {
    if (!cmp) return [] as { key: string; name: string; cur: number; prev: number; yoy: number }[];
    const live = new Set(estates.filter((e) => e.active).map((e) => e.id));
    const cur = Object.fromEntries(revByEstate);
    const keys = new Set<string>([
      ...Object.keys(cur), ...Object.keys(cmp.prev.byEstate), ...Object.keys(cmp.yoy.byEstate),
    ]);
    return [...keys]
      .filter((k) => live.has(k))
      .map((k) => ({
        key: k,
        name: estates.find((e) => e.id === k)?.name ?? k,
        cur: cur[k] ?? 0,
        prev: cmp.prev.byEstate[k] ?? 0,
        yoy: cmp.yoy.byEstate[k] ?? 0,
      }))
      // 本期金額大的排前面 —— 佔比大的物業動一點,對總數的影響就比小的動很多還大
      .sort((a, b) => b.cur - a.cur);
  }, [cmp, revByEstate, estates]);

  /*
   * ══════════════════════════════════════════════════════════
   * 營收與住房率　合成一張圖
   *
   * 【使用者 2026-09-18】
   *   「可以看各物業 營收趨勢 然後 住房率 畫一起
   *     營收畫長條圖 住房率畫折線圖　可以合在一起」
   *   「沒有營收與住房率呀　然後這不是 MECE 可以合併的」
   *
   * ★★★ 合併掉的是兩塊:原本的「住房率」與「各物業營收」。
   *   同一個住房率印在兩個地方、同一組物業營收畫兩次 ——
   *   兩塊並排而內容重疊，看的人要自己比對哪個數字對哪個。
   *
   * ★★ x 軸的月份**從區間長出來不是從資料長出來**（`monthsBetween`）——
   *   照資料長的話，沒有營收的月份會從軸上消失，
   *   而那個月的住房率可能很高（長租客那個月沒有認列），
   *   於是折線把不相鄰的兩個月接起來，看起來一路平穩。
   *
   * ★ 長條**跟著膠囊變**（用 `pRevs`），折線不跟 ——
   *   住房率算的是房間有沒有人住，跟錢從哪個通路來的無關。
   *   這件事畫面上要寫出來，不然看的人會以為折線壞了。
   * ══════════════════════════════════════════════════════════
   */
  const comboMonths = useMemo(() => monthsBetween(fromD, toD), [fromD, toD]);
  const comboMode = effectiveComboMode(comboPick, comboMonths.length);

  const occMonths = useMemo(
    () => occupancyByMonth(occRooms, occByRoom, comboMonths, { from: fromD, to: toD }),
    [occRooms, occByRoom, comboMonths, fromD, toD]);

  /*
   * ★★★ 這一份**刻意不套膠囊**。長條的總高度永遠是全部來源，
   *   選中的那幾個只是變深 —— 舊做法「沒選的整段消失」正是讓住房率
   *   看起來壞掉的原因（營收掉一半、住房率沒變，而那不是真的）。
   */
  const revBySrcMonth = useMemo(() => {
    const byYm = new Map<string, { source?: string | null; month_amount: number }[]>();
    fRevs.forEach((r) => {
      /* ★★★ `revenue_recognitions.ym` 是 `YYYYMM`，而住房率那邊的月份是
           `YYYY-MM` —— 不轉的話每一格都查不到，`?? 0` 把它變成一根
           高度 0 的長條，**沒有任何地方會叫**（2026-09-21 踩過:
           十二個月營收全是 0，而住房率那條線好好的）。 */
      const k = ymDash(r.ym);
      const a = byYm.get(k);
      const row = { source: r.source, month_amount: Number(r.month_amount || 0) };
      if (a) a.push(row); else byYm.set(k, [row]);
    });
    const m: Record<string, BySource> = {};
    /* ★ 走 `bySourceOf()` 而不是自己再 group 一次 —— 「沒填 source 當 other」
         這條規則跟膠囊那邊（`sourcePills`）必須是同一套，
         兩邊不一致的話膠囊上的金額跟圖上的加總會對不起來。 */
    byYm.forEach((rs, ym) => { m[ym] = bySourceOf(rs, (r) => r.month_amount); });
    return m;
  }, [fRevs]);

  /** 上下兩張圖要用的每一格：全部來源的錢 ＋ 那一格的住房率 */
  const pairRows = useMemo<PairRow[]>(
    () => occMonths.map((o) => ({
      key: o.m,
      /* ★★ `ymMonth()` 吃的是 `YYYYMM` —— 餵 `YYYY-MM` 進去會回 `'-1'`、
           `'-0'`（`slice(4,6)`），x 軸上就是那幾個看不懂的東西。tsc 不會叫。 */
      label: monthLabel(o.m),
      bySrc: revBySrcMonth[ymDash(o.m)] ?? {},
      occ: o.days > 0 ? o : null,
      partial: isPartialMonth(o.m, { from: fromD, to: toD }),
    })),
    [occMonths, revBySrcMonth, fromD, toD]);

  /* ★ `comboTime` 2026-09-21 刪掉 —— 按月那張改用 `pairRows` 了。
       留著的話就是第二條算同一件事的路，而它身上還帶著
       「`ym` 兩種形狀沒對起來」那個 bug。 */

  const comboEstate = useMemo<ComboRow[]>(() => {
    const rev = groupSum(pRevs, (r) => estKey(r.estate_id, r.property_id),
      (r) => Number(r.month_amount || 0));
    /* 住房率那邊的 key 是**物業名稱**（`occupancyByEstate` 就是這樣分的），
       營收這邊的 key 是 id —— 兩邊靠名字對起來。沒設物業的兩邊都收在 `''`。 */
    const byName: Record<string, { rate: number; days: number; used: number; rooms: number }> = {};
    occByEst.forEach((o) => { byName[o.estate] = o; });
    const seen = new Set<string>();
    const rows = rev.map(([k, v]) => {
      const label = k.startsWith('(') ? k : (estateName[k] ?? propName[k] ?? k);
      const name = k.startsWith('(') ? '' : label;
      seen.add(name);
      return comboRow(k, k.startsWith('(') ? '未指定物業' : label, v, byName[name]);
    });
    /* ★★ 有房間、但這段期間一毛錢都沒有的物業也要列 ——
       那正是最該被看到的一棟，而只看營收的話它會整根消失。 */
    occByEst.forEach((o) => {
      if (seen.has(o.estate)) return;
      rows.push(comboRow(o.estate || '(未指定物業)', o.estate || '未指定物業', 0, o));
    });
    return rows;
  }, [pRevs, occByEst, estKey, estateName, propName]);
  /*
   * ★★★ 「訂單數分布」也改成跟依來源同一套（2026-08-29 使用者:「都算阿」）。
   *
   *   舊做法數 `orders` 表裡 checkin 落在本期的訂單 —— 那是這一頁的
   *   **第三種**筆數口徑,而它就在「營收來源分布」旁邊。
   *   兩張圖並排、一張用 checkin 一張用認列,而標題都只寫「來源」。
   *
   * ★ 直接用 `cntBySource`（依來源的去重筆數），不要再算一次 ——
   *   算兩次就會有兩份規則，而它們遲早會分岔。
   */
  const ordBySource = useMemo(
    () => Object.entries(cntBySource).sort((a, b) => b[1] - a[1]), [cntBySource]);
  const expByCode = useMemo(
    () => groupSum(fExps, (e) => e.account_code ?? '(未分類)', (e) => Number(e.amount || 0)), [fExps]);
  const expByEstate = useMemo(
    () => groupSum(fExps, (e) => e.purpose_type === 'office' ? '(安幸辦公室)' : estKey(e.estate_id, e.property_id),
      (e) => Number(e.amount || 0)), [fExps, estKey]);

  /** 各物業損益 —— 收入鏈與支出鏈第一次接在一起。這張是整個儀表板最有價值的。 */
  const pnl = useMemo(() => {
    const m: Record<string, { rev: number; exp: number }> = {};
    fRevs.forEach((r) => {
      const k = estKey(r.estate_id, r.property_id);
      (m[k] ??= { rev: 0, exp: 0 }).rev += Number(r.month_amount || 0);
    });
    fExps.forEach((e) => {
      if (e.purpose_type === 'office') return;   // 辦公室不屬於任何物業
      const k = estKey(e.estate_id, e.property_id);
      (m[k] ??= { rev: 0, exp: 0 }).exp += Number(e.amount || 0);
    });
    return Object.entries(m)
      .map(([k, v]) => ({ k, ...v, net: v.rev - v.exp }))
      .sort((a, b) => b.net - a.net);
  }, [fRevs, fExps, estKey]);

  const revStats = useMemo(() => {
    if (!fRvs.length) return null;
    const avg = fRvs.reduce((s, r) => s + Number(r.overall_rating || 0), 0) / fRvs.length;
    const low = fRvs.filter((r) => Number(r.overall_rating) <= 3).length;
    const m: Record<string, { n: number; sum: number }> = {};
    fRvs.forEach((r) => {
      const k = r.property_id ?? '(未對應)';
      (m[k] ??= { n: 0, sum: 0 });
      m[k].n++; m[k].sum += Number(r.overall_rating || 0);
    });
    const byProp = Object.entries(m)
      .map(([k, v]) => ({ k, n: v.n, avg: v.sum / v.n }))
      .sort((a, b) => a.avg - b.avg);   // 低分排前面 —— 要處理的是那些
    return { avg, low, total: fRvs.length, byProp };
  }, [fRvs]);

  const nameOf = (k: string) => k.startsWith('(') ? k : (estateName[k] ?? propName[k] ?? k);

  if (role && !['accountant', 'manager', 'super_admin'].includes(role)) {
    return <div className="max-w-3xl"><p className="text-sm text-gray-500">這一頁開放給會計、主管與總經理。</p></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1>財務儀表板</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            營收採<b>訂單營收認列制</b> —— 跨月訂單已按天數拆到各月,與收款日期無關。
          </p>
        </div>
        {loading && <span className="text-sm text-gray-400">載入中…</span>}
      </div>

      {/* ═══ 篩選列 ═══ */}
      {/* 版型比照短租訂單頁（lib/filters）。這頁沒有關鍵字搜尋,
          所以清除直接接在最後一個欄位後面。 */}
      <FilterBar right={<span className="text-xs text-gray-400 pb-1.5">{fmtRange(fromD, toD)}</span>}>
        {/*
          期間分三種模式,不是四顆「往回推 N 個月」的快捷鍵。

          原本的「本月／近3月／近6月／近12月」都是同一種東西 —— 從今天往回推。
          沒有一個能回答「2025 整年多少」或「單看去年 3 月」,
          而那正是要做年度回顧或抓某個月異常時最常問的。
        */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">期間</label>
          {/* 自訂模式下是「起日 ~ 迄日 + 近12月」四個控制項，手機一行放不下 —— 要能換行 */}
          <div className="flex flex-wrap items-center gap-1">
            {([['year', '年'], ['month', '月'], ['custom', '自訂']] as const).map(([m, lb]) => (
              <button key={m} onClick={() => applyMode(m)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                  mode === m ? 'bg-mor-slate text-white border-mor-slate'
                    : 'border-gray-300 hover:bg-mor-sand/60'}`}>{lb}</button>
            ))}
            {mode === 'year' && (
              <select value={yearSel}
                onChange={(e) => { const y = Number(e.target.value); setYearSel(y); applyMode('year', y); }}
                className="rounded-lg border border-gray-300 px-2 py-1.5 ml-1">
                {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i)
                  .map((y) => <option key={y} value={y}>{y} 年</option>)}
              </select>
            )}
            {mode === 'month' && (
              <input type="month" value={monthSel}
                onChange={(e) => { setMonthSel(e.target.value); applyMode('month', yearSel, e.target.value); }}
                className="rounded-lg border border-gray-300 px-2 py-1.5 ml-1" />
            )}
            {mode === 'custom' && (
              <>
                <RangeInput className="ml-1" from={fromD} to={toD}
                  onChange={(f, t) => { setFromD(f); setToD(t); }} />
                <button onClick={() => { setFromD(monthsAgo(11)); setToD(todayStr()); }}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs hover:bg-mor-sand/60">近 12 月</button>
              </>
            )}
          </div>
        </div>
        <FilterSelect label="物業" value={estF} onChange={pickEstate}
          options={estates.map((e) => ({ value: e.id, label: e.name }))} />
        <FilterSelect label="房源" value={propF} onChange={setPropF}
          options={propsOfEstate.map((p2) => ({ value: p2.id, label: p2.name }))} />
        {/*
          ══════════════════════════════════════════════════════
          排除物業（2026-09-21 使用者指定）
          ══════════════════════════════════════════════════════
          ★★★ 放在篩選列**不是放在財報比較那一頁裡面**:它走 `matchScope`，
            所以整頁（含營收分析、支出分析）都會生效。
            只在某一頁看得到、卻在每一頁作用 —— 那是一個看不見的篩選，
            而使用者會拿著一個被動過的數字做決定。
          ★★ 排除中的時候按鈕變色並寫出排除了誰，不是只變個顏色。
        */}
        <div>
          <button ref={exclBtn} type="button" onClick={() => setExclOpen((v) => !v)}
            className={`h-9 rounded-lg border px-3 text-uisub inline-flex items-center gap-1.5
                        transition-colors ${exclEst.length
              ? 'border-amber-400 bg-amber-50 text-amber-800 font-semibold'
              : 'border-mor-line bg-white text-mor-ink hover:border-mor-slate'}`}>
            {exclLabel(exclEst.map((id) => estateName[id] ?? id))}
            <span className="text-xs text-gray-400">{exclOpen ? '▴' : '▾'}</span>
          </button>
          {exclOpen && (
            <>
              {/* ★ 點外面關起來。蓋一層透明的，不要靠 document listener ——
                     那條路在重繪時會抓不到已經離開 DOM 的元素 */}
              <div className="fixed inset-0 z-10" onClick={() => setExclOpen(false)} />
              <div ref={exclBox} style={{ position: 'fixed', left: exclPos.left, top: exclPos.top }}
                className="z-20 w-[min(220px,calc(100vw-24px))] rounded-xl border
                           border-mor-line bg-white p-2 shadow-[0_8px_26px_rgba(46,56,64,.16)]">
                <div className="px-1.5 pb-1.5 text-[11px] text-gray-400">
                  勾起來的不算進去（本期、上一期、去年同期一起扣）
                </div>
                {estates.filter((e) => e.active).map((e) => {
                  const on = isExcluded(exclEst, e.id);
                  /* ★ 會把全部排光的那一顆按不動 —— 而且要說得出為什麼 */
                  const next = toggleExcl(exclEst, e.id, estates.filter((x) => x.active).map((x) => x.id));
                  return (
                    <label key={e.id}
                      title={next === null ? '至少要留一個物業，不然整頁會變成 0' : ''}
                      className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm
                                  ${next === null ? 'opacity-40' : 'cursor-pointer hover:bg-mor-bg'}`}>
                      <input type="checkbox" checked={on} disabled={next === null}
                        onChange={() => { if (next) setExclEst(next); }} />
                      {e.name}
                    </label>
                  );
                })}
                {exclEst.length > 0 && (
                  <button type="button" onClick={() => setExclEst([])}
                    className="mt-1 w-full rounded-lg border border-dashed border-mor-line
                               px-2 py-1 text-xs text-gray-500 hover:border-mor-slate">
                    全部放回來
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {/*
          ══════════════════════════════════════════════════════
          ★★★ 「只算本業」的兩顆開關（2026-08-29 使用者選 B 案:
               放篩選卡、整頁生效、「可以看不同的分析」）。

            它們跟旁邊的物業／房源**是同一類東西**:都在回答
            「這份報表是怎麼算出來的」。所以放在同一張卡裡,
            而不是像支出頁那樣放標題列右上 ——
            那一頁的兩顆是「換個模式看清單」,不改任何金額。

          ★ 分隔線 ＋ 群組標題:它們跟左邊三個欄位都是條件,
            但一個是「篩掉哪幾列」、一個是「哪些錢算數」。
            不分開的話「排除非營運支出」看起來像第四個下拉。
          ══════════════════════════════════════════════════════
        */}
        <div className="flex flex-col gap-1 border-l border-mor-line pl-4 ml-1">
          <span className="block h-5 mb-1 text-uisub leading-5 text-gray-500 whitespace-nowrap">
            只算本業 <span className="text-gray-400">（整頁生效，比較期一起扣）</span>
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 h-12 md:h-10">
            <label className="flex items-center gap-1.5 text-uisub text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={exNonOp} onChange={(e) => setExNonOp(e.target.checked)} />
              排除非營運支出
            </label>
            <label className="flex items-center gap-1.5 text-uisub text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={exOneoff} onChange={(e) => setExOneoff(e.target.checked)} />
              排除一次性收入
            </label>
          </div>
        </div>
        <FilterClear active={!!(estF || propF || exNonOp || exOneoff)}
          onClear={() => { clearFilters(); setExNonOp(false); setExOneoff(false); }} />
      </FilterBar>

      {/*
        ══════════════════════════════════════════════════════
        營收來源膠囊（2026-09-18 使用者:「可以點 計算所有營收，做得像互動式的」）
        ══════════════════════════════════════════════════════
        ★★★ 規矩照 anxing-ui 四-1:**點一下開、再點一下清除**，
          一顆都沒亮就是沒有篩選 —— 不用另外做一顆「全部」。
        ★★ 不能用的那幾頁**整排淡掉並且寫出原因**，不是默默沒反應。
          一個點了沒動靜的東西，使用者的結論是系統壞了（anxing-ui 二-6）。
      */}
      {pills.length > 0 && (
        <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 mr-0.5">營收來源</span>
          {pills.map((pl) => {
            const on = picks.includes(pl.key);
            const dim = (srcOn && !on) || !pillsApply(tab);
            return (
              <button key={pl.key} type="button"
                disabled={!pillsApply(tab)}
                title={whyPillsOff(tab) ?? `加上${srcLabel(pl.key)}（可以複選）`}
                onClick={() => setSrcPicks(toggleSrc(srcPicks, pl.key, srcKeys))}
                className={`h-8 rounded-full border px-3 text-xs inline-flex items-center gap-1.5
                            transition-colors ${dim ? 'opacity-40' : ''} ${
                  on ? 'bg-mor-slate border-mor-slate text-white font-semibold'
                     : 'bg-white border-mor-line hover:border-mor-slate'}`}>
                {srcLabel(pl.key)}
                <span className={`tabular-nums ${on ? 'text-white/75' : 'text-gray-400'}`}>
                  {Math.round(pl.amount / 10000).toLocaleString('en-US')} 萬
                </span>
              </button>
            );
          })}
          {/* ★ 複選之後「再點一下清除」只清得掉一顆 —— 亮了三顆要點三下。
                 所以要有一顆「清掉」（anxing-ui 四-1 那條規矩是寫給單選的）。 */}
          {picks.length > 0 && pillsApply(tab) && (
            <button type="button" onClick={() => setSrcPicks([])}
              className="h-8 rounded-full border border-dashed border-mor-line px-3
                         text-xs text-gray-500 hover:border-mor-slate hover:text-mor-ink">
              清掉
            </button>
          )}
          {whyPillsOff(tab) && (
            <span className="text-xs text-gray-400">—— {whyPillsOff(tab)}</span>
          )}
        </div>
      )}

      {/*
        ══════════════════════════════════════════════════════
        分頁（2026-09-18 使用者過審）
        ══════════════════════════════════════════════════════
        ★ 篩選列與膠囊在**上面**，四頁共用 —— 切分頁不清掉條件。
        ★★ 橫向可捲（手機上四個籤放不下一行）。
      */}
      <div className="mb-4 flex gap-0.5 overflow-x-auto border-b-2 border-mor-line">
        {DASH_TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`-mb-0.5 shrink-0 border-b-[2.5px] px-4 py-2 text-ui transition-colors ${
              tab === t.key
                ? 'border-mor-slate text-mor-slatedark font-bold'
                : 'border-transparent text-gray-500 hover:text-mor-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/*
        ★★★ 開著的時候**在畫面上明講**（2026-08-29）。

          不講的話:上面的卡說支出 913 萬、換個人看是 870 萬,兩個數字都對,
          而截圖出去的人不知道自己截到哪一種口徑。
          這一條在整頁生效之後比原本只影響一張表時更重要。
      */}
      {(exNonOp || exOneoff) && (
        <div className="rounded-xl bg-violet-50 border border-violet-200 text-violet-900
                        px-4 py-2.5 mb-4 text-uisub leading-relaxed">
          <b>這一頁的數字已經排除{[exNonOp && '非營運支出', exOneoff && '一次性收入'].filter(Boolean).join('與')}。</b>
          {' '}營收、支出、淨額、依來源、依物業、月趨勢<b>全部</b>都是排除後的版本，
          本期與比較期都扣。
          {exOneoff && <span className="block mt-0.5 text-xs text-violet-700">
            一次性收入＝其他收入、Airbnb 取消（清潔費、修繕費、取消費那一類）。
          </span>}
          {exNonOp && <span className="block mt-0.5 text-xs text-violet-700">
            非營運支出＝在支出頁勾了「非營運」的那些。
          </span>}
        </div>
      )}

      {truncated && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 mb-4 text-sm text-red-800">
          <b>資料沒有完整載入，下面的數字全部偏低。</b>
          <div className="text-xs mt-1">{truncated}</div>
        </div>
      )}

      {revGap && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 mb-5 text-sm text-amber-800">
          <b>營收看起來偏低,可能是認列沒產生。</b>
          {' '}這個範圍有 {revGap.ordCount} 張訂單、合計 {money(revGap.ordAmt)},但認列只有 {money(totalRev)}。
          <div className="text-xs mt-1 text-amber-700">
            儀表板的營收讀的是<b>訂單營收認列</b>（跨月已按天數拆好）,不是收款日期也不是訂單原始金額。
            認列由訂單的觸發器產生 —— 沒產生的話這裡會偏低。
            跑 <code className="px-1 bg-amber-100 rounded">supabase/audits/查-營收認列健檢.sql</code> 找原因,
            確認是缺漏之後用 <code className="px-1 bg-amber-100 rounded">select rebuild_recognitions();</code> 重算。
            <br />
            （若這個區間本來就有大量跨月訂單,落差是正常的 —— 錢會認列在之後的月份。）
          </div>
        </div>
      )}

      {/* ═══ 環比與同比（分頁:財報比較）═══
        兩個一起看,少一個都會誤判:
          環比(比上一期) 看短期動能
          同比(比去年同期) 避開季節性 —— 短租淡旺季差很多,
                          八月比七月掉 20% 可能完全正常,
                          但比去年八月掉 20% 就是真的在退。
      */}
      {tab === 'compare' && cmp && (() => {
        const part = partialMonth(toD);
        const sameYoY = yoySameAsPrev(mode);
        const [pf, pt] = prevPeriod(mode, fromD, toD);
        const [yf, yt] = lastYearPeriod(mode, fromD, toD);
        const label = (f: string, t: string) =>
          mode === 'month' ? f.slice(0, 7) : mode === 'year' ? f.slice(0, 4) + ' 年' : `${f} ~ ${t}`;

        /** ▲ 12.4% / ▼ 3.1% / — 。比較期是 0 時寫「新增」,不寫 Infinity。 */
        const delta = (cur: number, base: number, goodUp = true) => {
          const g = growth(cur, base);
          if (g === null) return <span className="text-gray-400">{cur ? '新增' : '—'}</span>;
          const up = g >= 0;
          // 支出上升是壞事,營收上升是好事 —— 顏色跟著意義走,不是跟著箭頭
          const good = goodUp ? up : !up;
          return (
            <span className={good ? 'text-mor-green' : 'text-red-600'}>
              {up ? '▲' : '▼'} {Math.abs(g).toFixed(1)}%
            </span>
          );
        };
        /*
          【數字欄一律 tabular-nums】
          預設字型的數字是比例寬度（1 比 8 窄），所以 NT$74,436,080 跟
          NT$6,030,320 上下排在一起時千分位不會對齊，整欄看起來是歪的。
          tabular-nums 讓每個數字等寬,對齊就自己出現了。

          【本期用 semibold，跟下面「依來源」同一個字重】
          原本主要那四列是 font-bold、依來源那幾列是 font-medium ——
          同一欄兩種粗細，看起來像有兩種層級，但它們是同一種東西。
        */
        const row = (name: string, cur: number, p: number, y: number, f: (n: number) => string, goodUp = true) => (
          <tr className="border-b border-mor-line/60 last:border-0">
            <td className="px-3 py-2.5 font-medium whitespace-nowrap">{name}</td>
            <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums">{f(cur)}</td>
            <td className="px-3 py-2.5 text-right text-gray-500 whitespace-nowrap tabular-nums">{f(p)}</td>
            <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{delta(cur, p, goodUp)}</td>
            {!sameYoY && <>
              <td className="px-3 py-2.5 text-right text-gray-500 whitespace-nowrap tabular-nums">{f(y)}</td>
              <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{delta(cur, y, goodUp)}</td>
            </>}
          </tr>
        );
        const cnt = (n: number) => `${nf(n)} 筆`;

        /*
          金額後面接筆數。
          「長租 4,802 萬」一個人回答不了「這是幾張約撐起來的」——
          一張大單跟四十張小單的意義完全不同,而只看金額分不出來。
          筆數用灰色小字,不跟金額搶。

          ★★ 2026-08-25 使用者:「筆數沒有上去 耶」——
             原本**只有本期有筆數**，上一期與去年同期沒有。
             那樣比不出「營收掉了是單價掉還是單數掉」，
             而那正是看這張表要問的問題:
               長租 +0.3%、86 筆 vs 84 筆 → 穩定
               長租 +0.3%、86 筆 vs 40 筆 → 單價腰斬，只是量補回來
             兩種情況金額幾乎一樣，沒有筆數完全分不出來。
        */
        const cell = (v: number, n: number | undefined, strong: boolean) => (
          <td className={`px-3 py-2 text-right whitespace-nowrap tabular-nums ${strong ? '' : 'text-gray-500'}`}>
            <span className={strong ? 'font-semibold' : ''}>{money(v)}</span>
            {n !== undefined && (
              <span className="text-gray-400 font-normal ml-1.5 text-xs">｜{nf(n)} 筆</span>
            )}
          </td>
        );

        /** 明細列（依來源／依物業共用）—— 兩邊長得不一樣的話會被當成兩種東西 */
        const sub = (
          key: string, name: string,
          cur: number, prev: number, yoy: number,
          n?: number, pn?: number, yn?: number,
        ) => (
          <tr key={key} className="border-b border-mor-line/60 last:border-0">
            <td className="px-3 py-2 pl-6 text-gray-600 whitespace-nowrap">{name}</td>
            {cell(cur, n, true)}
            {cell(prev, pn, false)}
            <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{delta(cur, prev)}</td>
            {!sameYoY && <>
              {cell(yoy, yn, false)}
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{delta(cur, yoy)}</td>
            </>}
          </tr>
        );

        return (
          <div className="rounded-xl glass p-4 md:p-5 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-bold">期間比較</h2>
                {/*
                  ★★★ 「只看房租」搬到最上面的篩選卡了（2026-08-29）,
                     改名「排除一次性收入」,而且**整頁生效**。

                    2026-08-25 這裡原本刻意只影響這一張表,理由是
                    「跑去改整頁的話,使用者會看到自己沒動過的數字也變了」。
                    推翻的理由:同一頁兩種口徑比整頁一起變更危險 ——
                    上面的卡跟下面的表講不同的支出,而兩個數字都對。

                  ★ 一次性收入為什麼要能排除:它是清潔費、修繕費、取消費那一類,
                    金額跳很大而且**跟這個月租得好不好無關**。
                    8 月營收掉 15%,其中一次性從 110 萬掉到 4 萬 ——
                    房租根本沒動,是上個月有一筆大修繕費入帳。
                    混在一起時這兩件事分不出來,而每個數字單看都正確。
                */}
              </div>
              <span className="text-xs text-gray-400">
                {sameYoY ? '年度模式下環比與同比是同一段,只顯示一組' : '環比看動能,同比避開季節性'}
              </span>
            </div>
            {/* ★ 「扣掉了什麼」的說明搬到篩選卡下面那條紫色橫幅了 —— 整頁生效，
                  講在這裡的話上面那幾張卡也扣了卻沒有人說 */}
            {/*
              本月還沒走完的警語。認列表是按月存的,沒有日粒度,
              所以沒辦法真的算「8/1~8/6 的營收」來對比 —— 只能把這件事講出來。
            */}
            {part && (
              <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs mb-3">
                本月才過了 <b>{part.passed} / {part.total}</b> 天。下面的比較是
                「不完整的本月」對「完整的上月」,百分比會偏低 —— 看趨勢就好,不要當結論。
              </div>
            )}
            {/*
              六欄在手機上一定放不下，而橫向捲軸自己不會說話 ——
              「去年同期」就這樣被藏在畫面外，使用者以為系統沒算同比。
            */}
            {!sameYoY && <p className="md:hidden text-[11px] text-gray-400 mb-1">← 左右滑動看「去年同期」與「同比」</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-mor-line">
                    <th className="px-3 py-2 text-left">項目</th>
                    <th className="px-3 py-2 text-right">本期<div className="font-normal text-gray-400">{label(fromD, toD)}</div></th>
                    <th className="px-3 py-2 text-right">上一期<div className="font-normal text-gray-400">{label(pf, pt)}</div></th>
                    <th className="px-3 py-2 text-right">環比</th>
                    {!sameYoY && <>
                      <th className="px-3 py-2 text-right">去年同期<div className="font-normal text-gray-400">{label(yf, yt)}</div></th>
                      <th className="px-3 py-2 text-right">同比</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {row(exOneoff ? '房租營收' : '營收', cTotalRev, cmp.prev.rev, cmp.yoy.rev, money)}
                  {/* ★ 標題自己說口徑 —— 這一列被截圖出去時，是唯一還在的線索 */}
                  {row(exNonOp ? '營運支出' : '支出', totalExp, cmp.prev.exp, cmp.yoy.exp, money, false)}
                  {row('淨額', cNet, cmp.prev.rev - cmp.prev.exp, cmp.yoy.rev - cmp.yoy.exp, money)}
                  {row('訂單數', cntOrders, cmp.prev.ordN, cmp.yoy.ordN, cnt)}
                  <tr><td colSpan={sameYoY ? 4 : 6} className="px-3 pt-3 pb-1 text-xs font-semibold text-gray-500">依來源</td></tr>
                  {/* 總營收成長時,要看得出是哪一塊在撐 —— 可能長租在漲而短租在退 */}
                  {revBySource.map(([k, v]) => sub(
                    k, srcLabel(k), v, cmp.prev.bySource[k] ?? 0, cmp.yoy.bySource[k] ?? 0,
                    cntBySource[k] ?? 0, cmp.prev.cntBySource[k] ?? 0, cmp.yoy.cntBySource[k] ?? 0))}

                  {/*
                    【依物業】
                    「總營收掉了 15%」不能行動,「開封掉了 40% 而其他持平」可以。
                    來源看的是通路,物業看的是哪一棟出事 —— 兩個都要有。

                    **已停用的物業不列**（使用者指定）：合約結束之後今年歸零、
                    去年有數字，比出來永遠是 -100%,而那不是經營上的訊息,
                    只是一個已經結束的事實。它會佔掉一整列、而且每一期都佔。
                  */}
                  {!!revByEstateCmp.length && (
                    <tr><td colSpan={sameYoY ? 4 : 6} className="px-3 pt-3 pb-1 text-xs font-semibold text-gray-500">
                      依物業<span className="ml-1.5 font-normal text-gray-400">只列營運中的物業</span>
                    </td></tr>
                  )}
                  {revByEstateCmp.map(({ key, name, cur, prev, yoy }) => sub(
                    key, name, cur, prev, yoy,
                    cntByEstate[key] ?? 0, cmp.prev.cntByEstate[key] ?? 0, cmp.yoy.cntByEstate[key] ?? 0))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/*
        ══════════════════════════════════════════════════════
        營收表現（2026-09-18 新做的，使用者過審）
        ══════════════════════════════════════════════════════
        ★★★ 這一排**跟著膠囊變**:點「長租」就是長租的營收、筆數、單價
          —— 「哪個通路單價高」不用自己拿計算機按。
        ★★ 住房率**不跟著膠囊變** —— 它算的是房間有沒有人住，
          跟這筆錢從哪個通路來的無關。所以它不放在深底那一張。
        ★ 筆數 0 時平均單價是 **0 不是 NaN**（`lib/dash.ts`，有測試）——
          「NT$NaN」在畫面上看起來是壞掉，不是「這段期間沒有東西」。
      */}
      {tab === 'revenue' && (
        <Panel title="營收表現"
          hint={srcOn ? `只看${pickName()}` : '全部來源'}>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
            <div className="rounded-xl bg-mor-ink text-white px-3.5 py-3">
              <div className="text-xs text-gray-400">營收</div>
              <div className="text-[25px] font-bold tabular-nums leading-tight">
                {money(perfNow.revenue)}</div>
              <div className="text-xs text-gray-400 tabular-nums">
                {perfNow.shareRev !== null
                  ? `佔全部 ${(perfNow.shareRev * 100).toFixed(1)}%`
                  : '這段期間的認列營收'}</div>
            </div>
            <div className="rounded-xl border border-mor-line px-3.5 py-3">
              <div className="text-xs text-gray-500">訂單數</div>
              <div className="text-[25px] font-bold tabular-nums leading-tight">
                {nf(perfNow.count)}</div>
              <div className="text-xs text-gray-400 tabular-nums">
                {perfNow.shareCnt !== null
                  ? `佔全部 ${(perfNow.shareCnt * 100).toFixed(1)}%` : '認列筆數'}</div>
            </div>
            <div className="rounded-xl border border-mor-line px-3.5 py-3">
              <div className="text-xs text-gray-500">平均單價</div>
              <div className="text-[25px] font-bold tabular-nums leading-tight">
                {money(perfNow.avg)}</div>
              <div className="text-xs text-gray-400">營收 ÷ 訂單數</div>
            </div>
            <div className="rounded-xl border border-mor-line px-3.5 py-3">
              <div className="text-xs text-gray-500">住房率</div>
              <div className="text-[25px] font-bold tabular-nums leading-tight">
                {/*
                  ★★ `occAll` 是 `totalOccupancy()` 回的物件（rooms/days/used/rate），
                    不是一個數字 —— 直接乘 100 會是型別錯誤（tsc 抓到的）。
                  ★ `days` 是 0 的時候（沒有房源或期間是空的）印「—」，
                    不要印 0.0% —— 0% 的意思是「都沒人住」，那是另一件事。
                */}
                {!occAll || occAll.days === 0 ? '—' : `${(occAll.rate * 100).toFixed(1)}%`}</div>
              {/* ★ 這一格不跟膠囊變 —— 講出來，不然看的人會以為它沒反應 */}
              <div className="text-xs text-gray-400">不分來源</div>
            </div>
          </div>
        </Panel>
      )}

      {/*
        ══════════════════════════════════════════════════════
        營收與住房率（2026-09-18 合併，使用者過審）
        ══════════════════════════════════════════════════════
        ★★★ 這一塊吃掉了原本的「住房率」與「各物業營收」兩塊 ——
          使用者:「這不是 MECE 可以合併的」。
          同一個住房率印在兩個地方、同一組物業營收畫兩次。
        ★★ 長條是錢（左軸）、折線是住房率（右軸，**固定 0~100%**）。
          右軸會跟著資料縮放的話，58% 到 62% 看起來像暴漲 ——
          那是最容易誤導人的一種圖。
      */}
      {tab === 'revenue' && (
      <Panel title="營收與住房率"
        hint={comboMode === 'time'
          ? '上下兩張共用一條 x 軸 —— 滑過去看那個月的營收組成與住房率'
          : '長條＝營收（左軸）・折線＝住房率（右軸，固定 0~100%）'}>
        {occErr && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            ⚠ {occErr}　—— 折線的住房率會<b>偏低</b>，先不要拿它做決定。
          </div>
        )}

        {/* 模式切換。★ 兩顆而已，用分段按鈕不用下拉 —— 下拉要點兩次 */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex gap-1">
            {COMBO_MODES.map((m) => (
              <button key={m.key} type="button"
                onClick={() => setComboPick(parseComboMode(m.key))}
                className={`h-8 px-3 rounded-lg border text-sm transition-colors ${
                  comboMode === m.key
                    ? 'bg-mor-slate border-mor-slate text-white font-semibold'
                    : 'bg-white border-mor-line text-mor-ink hover:bg-mor-bg'}`}>
                {m.label}
              </button>
            ))}
          </div>
          {/* ★ 住房率不跟膠囊走 —— 講出來，不然看的人會以為它壞了 */}
          {srcOn && (
            <span className="text-[11px] text-gray-400">
              深色＝{pickName()}・住房率不分來源
            </span>
          )}
          {/*
            ★★ 選了單一物業之後「各物業比較」只剩一根 ——
              那看起來像圖壞了，而它只是被篩剩一棟。
              **講出來並且給一顆清掉的鈕**，不要只是顯示一根。
          */}
          {comboMode === 'estate' && (estF || propF) && comboEstate.length <= 1 && (
            <span className="text-[11px] text-amber-700">
              只剩一棟　
              <button type="button" onClick={() => { setEstF(''); setPropF(''); }}
                className="underline hover:text-amber-900">清掉物業篩選</button>
              　才比較得出來
            </span>
          )}
        </div>

        {occLoading ? (
          <p className="py-8 text-center text-sm text-gray-400">計算中…</p>
        ) : (comboMode === 'time' ? pairRows : comboEstate).length === 0 ? (
          <Empty />
        ) : comboMode === 'time' ? (
          /*
           * ★★★ 2026-09-21 起按月這張**不再用雙軸**（使用者過審）。
           *   上下兩張、共用一條 x 軸與一條十字線，各有各的軸。
           *   雙軸的問題是右軸範圍由畫圖的人隨便訂 —— 同一份資料，
           *   右軸 0~100% 看起來「沒關係」、44~68% 看起來「完全同步」。
           * ★★ 「各物業比較」那個模式還是舊的雙軸圖，還沒換。
           */
          <RevOccPair rows={pairRows} keys={srcKeys} picks={picks}
            scopeName={pickedLabel(picks.map(srcLabel), srcKeys.length, srcKeys.length)} />
        ) : (
          <RevOccChart rows={comboEstate} />
        )}

        {/*
          整體那一行。★★ 這裡**不再印一次住房率的百分比** ——
            它已經在上面「營收表現」那一排了（使用者:這不是 MECE）。
            這一行回答的是另一個問題:那個百分比的分母是怎麼來的。
        */}
        {!occLoading && occList.length > 0 && (
          <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1
                          rounded-lg bg-mor-sand/40 px-4 py-2.5 text-xs text-gray-500 tabular-nums">
            <span>{occAll.rooms} 間房 × {occAll.rooms ? occAll.days / occAll.rooms : 0} 天
              ＝ 可住 {nf(occAll.days)} 天</span>
            <span>住了 <b className="text-mor-ink">{nf(occAll.used)}</b> 天・
              空著 <b className="text-mor-ink">{nf(occAll.free)}</b> 天</span>
          </div>
        )}
        {!occLoading && occList.length === 0 && (
          <p className="mt-3 text-center text-sm text-gray-400">
            這個篩選條件下沒有房源，所以沒有折線。（停用的、沒勾「排房表」的房源不算）
          </p>
        )}

        <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">
          ★ 一棟的住房率＝<b>那棟所有房間的入住天數總和 ÷（那棟幾間房 × 期間天數）</b>，
          不是各房住房率的平均。逐日計算，重疊的訂單只算一次。<br />
          ★ 訂單的退房日那天<b>不算</b>住（最後一晚是前一天），契約的租期迄那天<b>算</b>。
          兩種來源的邊界不一樣，這是最容易差一格的地方 —— 跟房源狀態走同一份算式。<br />
          ★ 折線<b>斷掉</b>的那一格代表那裡沒有房源可以算，不是住房率 0%。<br />
          ★ <b>按月</b>是上下兩張圖、各有各的軸 —— 兩個軸擠成一張的話，
          右軸的範圍怎麼訂都行，同一份資料可以畫成「完全同步」也可以畫成「毫無關係」。
          <b>「各物業比較」那個模式還是舊的雙軸圖，還沒換。</b><br />
          ★ 長條<b>淡掉</b>的那一格是還沒過完的月份 —— 它只有半個月的錢，
          跟前面幾格比會偏矮，那不是衰退。住房率沒有這個問題（分母也跟著只算到今天）。
        </p>
      </Panel>
      )}

      {/* ═══ 趨勢（分頁:財報比較）═══ */}
      {tab === 'compare' && (
        <Panel title="營收與支出趨勢" hint="營收用已按月拆分的認列金額，跨月訂單已經分好了">
          {trend.length === 0 ? <Empty /> : <TrendChart data={trend} />}
        </Panel>
      )}

      {/* ═══ 營收來源 ＋ 訂單分布（分頁:營收分析）═══ */}
      {tab === 'revenue' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="營收來源" hint="上面那排膠囊也可以篩 —— 被篩掉的淡掉不是消失">
          <BarList rows={revBySource.map(([k, v]) => ({
            label: srcLabel(k), value: v,
            /* ★ 被篩掉的**淡掉不是消失** —— 它們的錢還在總額裡（anxing-ui 四-1） */
            color: (srcOn && !picks.includes(k)) ? '#D6DBE0' : (SRC_COLOR[k] ?? '#7A8B99'),
          }))} fmt={money} />
        </Panel>
        <Panel title="訂單分布" hint="看的是筆數不是金額 —— 跟營收比對得出「哪個通路單價高」">
          <BarList rows={ordBySource.map(([k, v]) => ({
            label: srcLabel(k), value: v,
            color: (srcOn && !picks.includes(k)) ? '#D6DBE0' : (SRC_COLOR[k] ?? '#7A8B99'),
          }))} fmt={(n) => nf(n) + ' 筆'} />
        </Panel>
      </div>
      )}

      {/* ═══ 各物業營收 ═══
        ★★★ 2026-09-18 拿掉 —— 併進上面的「營收與住房率 → 各物業比較」。
          原本它跟「住房率」是兩塊並排，同一組物業各畫一次
          （使用者:「這不是 MECE 可以合併的」）。
          `revByEstate` 本身沒拿掉，財報比較那一頁的「各物業損益」還在用。 */}

      {/* ═══ 各物業支出（分頁:支出分析）═══ */}
      {tab === 'expense' && (
        <Panel title="各物業支出" hint="辦公室的支出不屬於任何物業，另外列">
          <BarList rows={expByEstate.map(([k, v], i) => ({
            label: nameOf(k), value: v, color: PALETTE[(i + 3) % PALETTE.length],
          }))} fmt={money} />
        </Panel>
      )}

      {/* ═══ 各物業損益（分頁:財報比較）═══ */}
      {tab === 'compare' && (
      <Panel
        title="各物業損益"
        hint="營收減去該物業的支出。這是系統裡唯一把收入鏈與支出鏈接在一起的地方">
        {pnl.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead><tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="py-2">物業</th>
                <th className="py-2 text-right">營收</th>
                <th className="py-2 text-right">支出</th>
                <th className="py-2 text-right">淨額</th>
                <th className="py-2 text-right w-24">毛利率</th>
                {/* 佔比是視覺化的長條，手機上只剩十幾 px 寬，看不出任何東西又把數字擠掉 —— 直接不顯示 */}
                <th className="hidden md:table-cell py-2 pl-4 w-[38%]">佔比</th>
              </tr></thead>
              <tbody>
                {pnl.map((r) => {
                  const max = Math.max(...pnl.map((x) => Math.max(x.rev, x.exp)), 1);
                  const mg = r.rev > 0 ? (r.net / r.rev) * 100 : 0;
                  return (
                    <tr key={r.k} className="border-b border-mor-line/50 last:border-0">
                      <td className="py-2 font-medium">{nameOf(r.k)}</td>
                      <td className="py-2 text-right tabular-nums">{nf(r.rev)}</td>
                      <td className="py-2 text-right tabular-nums text-gray-500">{nf(r.exp)}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${r.net >= 0 ? 'text-mor-green' : 'text-red-600'}`}>
                        {nf(r.net)}
                      </td>
                      <td className={`py-2 text-right tabular-nums text-xs ${mg >= 0 ? 'text-gray-500' : 'text-red-500'}`}>
                        {r.rev > 0 ? mg.toFixed(0) + '%' : '—'}
                      </td>
                      <td className="hidden md:table-cell py-2 pl-4">
                        {/* 上綠下灰的雙軌，一眼看出「賺的比花的多多少」 */}
                        <div className="flex flex-col gap-0.5">
                          <div className="h-2 rounded-sm bg-mor-green" style={{ width: `${(r.rev / max) * 100}%` }} />
                          <div className="h-2 rounded-sm bg-gray-300" style={{ width: `${(r.exp / max) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-2">綠＝營收，灰＝支出。支出只算有指定物業的，辦公室的公共費用不分攤。</p>
          </div>
        )}
      </Panel>
      )}

      {/* ═══ 會計科目（分頁:支出分析）═══
        ★ 2026-09-18 使用者指定改叫「會計科目」（原本叫支出科目）。 */}
      {tab === 'expense' && (
        <Panel title="會計科目" hint="錢花在哪些類別。連續幾個月都在同一科目衝高，通常是有東西該修了">
          <BarList rows={expByCode.map(([k, v], i) => ({
            label: codeName[k] ?? k, value: v, color: PALETTE[(i + 1) % PALETTE.length],
          }))} fmt={money} />
        </Panel>
      )}

      {/* ═══ 旅客評價（分頁:其他）═══ */}
      {tab === 'other' && (
      <Panel title="旅客評價" hint="依退房日期計算，跟營收同一條時間軸">
        {!revStats ? <Empty /> : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4 max-w-lg">
              <Kpi label="評價則數" value={nf(revStats.total)} bare />
              <Kpi label="平均星等" value={revStats.avg.toFixed(2)}
                tone={revStats.avg >= 4.8 ? 'good' : revStats.avg >= 4.5 ? undefined : 'warn'} bare />
              <Kpi label="3 星以下" value={nf(revStats.low)} tone={revStats.low > 0 ? 'bad' : 'good'} bare />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                  <th className="py-2">房源</th>
                  <th className="py-2 text-right w-20">則數</th>
                  <th className="py-2 text-right w-24">平均</th>
                  <th className="hidden md:table-cell py-2 pl-4 w-[45%]">分數</th>
                </tr></thead>
                <tbody>
                  {revStats.byProp.map((r) => (
                    <tr key={r.k} className="border-b border-mor-line/50 last:border-0">
                      <td className="py-2">{r.k === '(未對應)' ? <span className="text-gray-400">未對應房源</span> : propName[r.k] ?? r.k}</td>
                      <td className="py-2 text-right tabular-nums text-gray-500">{r.n}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${r.avg >= 4.8 ? 'text-mor-green' : r.avg >= 4.5 ? '' : 'text-amber-600'}`}>
                        {r.avg.toFixed(2)}
                      </td>
                      <td className="hidden md:table-cell py-2 pl-4">
                        {/* 基準線畫在 4.5 —— Airbnb 低於這個數字就會影響曝光 */}
                        <div className="relative h-2.5 rounded-sm bg-gray-100">
                          <div className={`h-2.5 rounded-sm ${r.avg >= 4.8 ? 'bg-mor-green' : r.avg >= 4.5 ? 'bg-mor-blue' : 'bg-amber-400'}`}
                            style={{ width: `${(r.avg / 5) * 100}%` }} />
                          <div className="absolute top-0 h-2.5 w-px bg-gray-400" style={{ left: '90%' }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-400 mt-2">
                低分排前面 —— 要處理的是那些。灰色細線是 4.5 分的基準，低於它 Airbnb 的曝光會受影響。
              </p>
            </div>
          </>
        )}
      </Panel>
      )}

      {/*
        ═══ 清潔記錄（分頁:其他）═══
        ★★★ 這一塊 2026-09-18 使用者要「這段期間的清潔摘要」。
          **還沒接資料** —— 它要的是房務那邊的工單與點數，
          跟這一頁現在載的東西不是同一批。
        ★ 先把位置與入口放出來，而且**明講還沒接** ——
          畫一組假的 0 在那裡的話，看的人會以為這段期間一份工都沒有
          （CLAUDE.md:自檢的母體是空的 → 每一條都回綠，同一種病）。
      */}
      {tab === 'other' && (
        <Panel title="清潔記錄" hint="這段期間的清潔摘要">
          <div className="rounded-xl border border-dashed border-mor-line bg-[#FAFAF9]
                          px-4 py-6 text-center text-uisub text-gray-500">
            <b className="text-mor-ink">這一塊還沒接資料。</b>
            <div className="mt-1 text-xs text-gray-400 leading-relaxed">
              要的是「幾份工、幾間、打掃點數、房務成本」，依物業分組 ——
              那批資料在房務那邊，跟這一頁現在載的不是同一批。
              <br />先不畫假的 0 在這裡：那會讓人以為這段期間一份工都沒有。
            </div>
            <a href="/housekeeping" className="mt-3 inline-flex h-10 items-center rounded-lg border
                       border-mor-slate px-4 text-uisub text-mor-slate hover:bg-mor-bluelight">
              先到房務看 →
            </a>
          </div>
        </Panel>
      )}

      {/*
        關注支出（分頁:支出分析）。放在最後 —— 它是「要追的那幾筆」,不是總覽,
        看完上面的數字之後才會想看細節。

        沒有關注時整塊不出現,不留一個空面板佔位置。
      */}
      {tab === 'expense' && starred.length > 0 && (
        <Panel title={`關注支出（${starred.length} 筆・合計 $${nf(starredTotal)}）`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                  <th className="py-2 pr-3">日期</th>
                  <th className="py-2 pr-3">項目</th>
                  <th className="py-2 pr-3">會計科目</th>
                  <th className="py-2 pr-3 text-right">認列金額</th>
                  <th className="py-2 text-right">實付</th>
                </tr>
              </thead>
              <tbody>
                {starred.map((e) => (
                  <tr key={e.id} className="border-b border-mor-line/50 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-gray-600">{e.spent_on}</td>
                    <td className="py-2 pr-3">
                      {e.item_name ?? '—'}
                      {/* 一組遞延會出現好幾列,標明哪一列是母單、哪些是分攤出去的 */}
                      {e.deferred && <span className="ml-1.5 text-[10px] text-red-500">遞延母單</span>}
                      {e.parent_expense_id && <span className="ml-1.5 text-[10px] text-gray-400">遞延分攤</span>}
                    </td>
                    {/* 存的是 code（repair），要顯示名稱（修繕維護）—— 對不到才退回印 code */}
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">
                      {e.account_code ? codeName[e.account_code] ?? e.account_code : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium tabular-nums">${nf(Number(e.amount) || 0)}</td>
                    <td className="py-2 text-right text-gray-500 tabular-nums">
                      {/* 子單沒有付款事實,留空不印 0 */}
                      {e.parent_expense_id ? '—' : `$${nf(Number(e.gross_amount ?? e.amount) || 0)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            在「支出明細」頁按星星加入。遞延的母子單會一起亮 ——
            所以一筆錢可能出現好幾列，每一列是不同月份的認列。
            <a href="/expenses" className="ml-1 text-mor-blue underline">到支出明細 →</a>
          </p>
        </Panel>
      )}
    </div>
  );
}

/* ══════════ 以下是這一頁自用的小元件 ══════════ */

/**
 * KPI 卡。
 *
 * 【tone 決定整張卡的顏色，不只是數字】
 * 原本只有數字有顏色，卡片本身永遠是白底細框 —— 十張排在一起，
 * 顏色被稀釋成十個小點，掃過去看不出哪一張需要注意。
 * 改成連框線與底色一起淡淡地跟著 tone 走：
 * 有顏色的那幾張自己會浮出來，中性的退到背景。
 *
 * 【標籤字距拉開、字級壓小】
 * 標籤跟數字差不多大時，整張卡看起來就是兩行普通文字，沒有主從。
 */
/*
 * 住房率的顏色。★★ 門檻本身在 `lib/occupancy.ts` 的 `occTone()` ——
 * 這裡只決定「high/mid/low 長什麼樣」，三個地方各寫一次 `> 0.8` 的話，
 * 改門檻時一定會漏掉一個。
 *
 * ★ 綠色用 `mor-greendark`（#217346）當文字:`mor-green` 對白底只有 2.78:1，
 *   達不到 4.5:1（anxing-ui 第五節）。長條是色塊不是文字，可以用亮的那支。
 */
const OCC_CLS: Record<string, string> = {
  high: 'text-mor-greendark', mid: 'text-mor-slate', low: 'text-[#B3423C]',
};
/* ★ OCC_BAR（住房率長條的三段顏色）2026-09-18 拿掉 —— 那張橫條表併進合圖了，
   而合圖的折線是單一深墨色（不借用任何一個既有的語意色）。留著一個沒人用的
   顏色表，下一個人會以為某處還在用它。 */

const KPI_TONE = {
  good: { text: '#3FAE7C', bg: '#3FAE7C0D', border: '#3FAE7C33' },
  bad: { text: '#D0544C', bg: '#D0544C0D', border: '#D0544C33' },
  warn: { text: '#E08A4C', bg: '#E08A4C0D', border: '#E08A4C33' },
  none: { text: '#2E3840', bg: '#fff', border: '#E0DDD5' },
} as const;

function Kpi({ label, value, sub, tone, subTone, hint, bare }: {
  label: string; value: string; sub?: string;
  tone?: 'good' | 'bad' | 'warn'; subTone?: 'good' | 'bad'; hint?: string; bare?: boolean;
}) {
  const t = KPI_TONE[tone ?? 'none'];
  return (
    <div className={bare ? '' : 'rounded-xl border p-3.5 shadow-[0_1px_2px_rgba(46,56,64,0.05)]'}
      style={bare ? undefined : { backgroundColor: t.bg, borderColor: t.border }} title={hint}>
      <div className="text-[10px] tracking-[0.12em] text-gray-500 flex items-center gap-1">
        {label}{hint && <span className="text-gray-300">ⓘ</span>}
      </div>
      <div className="text-xl md:text-2xl font-bold tabular-nums mt-1 leading-none"
        style={{ color: t.text }}>{value}</div>
      {sub && <div className={`text-xs mt-1 ${
        subTone === 'good' ? 'text-mor-green' : subTone === 'bad' ? 'text-red-500' : 'text-gray-400'}`}>{sub}</div>}
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl glass p-4 mb-4">
      <div className="mb-3 flex items-start gap-2">
        {/* 一小段藍色豎線。純文字標題在一整頁白卡裡會被當成內容的一部分，
            加一個記號之後「這裡是一個新區塊」就不用靠留白去猜 */}
        <span aria-hidden className="mt-[3px] w-[3px] h-4 rounded-full bg-mor-slate shrink-0" />
        <div>
          <h2 className="text-sm font-semibold text-gray-700 leading-tight">{title}</h2>
          {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

const Empty = () => <p className="py-10 text-center text-sm text-gray-400">這個區間沒有資料</p>;

/** 橫向長條清單。滑過去會顯示實際數字與佔比。 */
function BarList({ rows, fmt }: { rows: { label: string; value: number; color: string }[]; fmt: (n: number) => string }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <Empty />;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="group" title={`${r.label}　${nf(r.value)}　${total > 0 ? ((r.value / total) * 100).toFixed(1) : 0}%`}>
          <div className="flex items-baseline justify-between text-sm mb-1">
            <span className="font-medium">{r.label}</span>
            <span className="tabular-nums text-gray-600">
              {fmt(r.value)}
              <span className="ml-2 text-xs text-gray-400">
                {total > 0 ? ((r.value / total) * 100).toFixed(1) : 0}%
              </span>
            </span>
          </div>
          <div className="h-2.5 rounded-sm bg-gray-100">
            <div className="h-2.5 rounded-sm transition-all group-hover:opacity-80"
              style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 月度趨勢：營收與支出並排的柱狀，加一條淨額折線。
 *
 * 手寫 SVG 而不是裝套件。
 *
 * 【為什麼要量容器寬度，不用固定 viewBox】
 * 原本是固定 viewBox 1000×260 配 preserveAspectRatio="none"。
 * 桌機看起來沒問題 —— 容器就是 1000 出頭，1 單位差不多 1 px。
 *
 * 但手機只有 375px：整張圖被橫向壓成不到 4 成，
 * 而 preserveAspectRatio="none" 是**非等比**縮放，
 * 月份文字會跟著被壓扁成不可讀的細長條（字高不變、字寬剩三分之一）。
 * 這就是「儀表板在手機上顯示不出來」的真正原因 ——
 * 圖有畫出來，只是文字糊掉了。
 *
 * 解法是讓座標系跟著實際寬度走：**1 個 SVG 單位 = 1 個 CSS px**，
 * 縮放比例永遠是 1，什麼都不會變形。也不必猜斷點。
 */
/** 上下兩張圖的一格 */
type PairRow = {
  key: string; label: string;
  /** 這一格在各來源上的錢（**全部來源**，不套膠囊） */
  bySrc: BySource;
  occ: ComboOcc | null;
  /** 這一格不是完整的一個月（區間切在月中） */
  partial?: boolean;
};

/**
 * 營收（上，長條）＋ 住房率（下，折線），**共用一條 x 軸與一條十字線**。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼不是一張雙軸圖】（2026-09-21 使用者過審）
 *
 * 兩個 Y 軸之間怎麼對齊是**畫圖的人隨便訂的**。同一份資料，
 * 右軸 0~100% 看起來「沒什麼關係」、右軸 44~68% 看起來「幾乎完全同步」——
 * 能證明任何結論的圖，等於什麼都沒證明。
 *
 * 而且舊版還有第二個問題:長條跟著來源膠囊變、折線不跟 ——
 * **兩條線量的不是同一群人**。
 *
 * 【★★ 長條的總高度永遠是全部來源】
 *
 * 選中的那幾個只是變深（貼著基線）。舊做法「沒選的整段消失」
 * 才是讓住房率看起來壞掉的原因。
 *
 * 【★★★ 卡片一定要有「點一下」的版本】
 *
 * 手機沒有 hover。而且 `draw` 會重畫整個 SVG，點到長條時那個 <rect>
 * 會離開 DOM —— React 這邊是用同一份 state 重繪，不會有那個問題，
 * 但「點外面關掉」那條還是要靠座標判斷，不要靠 event.target。
 * ══════════════════════════════════════════════════════════
 */
function RevOccPair({ rows, keys, picks, scopeName }: {
  rows: PairRow[]; keys: readonly string[]; picks: readonly string[]; scopeName: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const [pin, setPin] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const on = !noSrcFilter(picks, keys);
  const splits = rows.map((r) => splitBySrc(r.bySrc, keys, picks));
  /* ★ 兩張圖的左邊界要一樣寬，不然 x 軸對不齊 —— 對不齊的十字線比沒有更糟 */
  const L = 54, R = 16;
  const iw = Math.max(W - L - R, 40);
  const step = iw / Math.max(rows.length, 1);
  const cx = (i: number) => L + step * i + step / 2;
  const top = moneyTop(Math.max(...splits.map((x) => x.total), 0));

  const H1 = 210, T1 = 16, B1 = 20, ih1 = H1 - T1 - B1;
  const H2 = 150, T2 = 10, B2 = 30, ih2 = H2 - T2 - B2;
  const yRev = (v: number) => T1 + ih1 - (Math.max(v, 0) / top) * ih1;
  const yOcc = (r: number) => T2 + ih2 - Math.min(Math.max(r, 0), 1) * ih2;
  const barW = Math.max(Math.min(step * 0.56, 46), 2);
  const { labels: xLabels } = axisLabels(rows, step);
  const segs = occSegments(rows.map((r) => ({ key: r.key, label: r.label, rev: 0, occ: r.occ })));
  const axisMoney = (v: number) =>
    (v === 0 ? '0' : top >= 10000 ? `${Math.round(v / 10000)} 萬` : nf(Math.round(v)));

  /** 滑鼠在哪一格。★ 用座標算，不要靠 event.target —— SVG 內容會重畫 */
  function idxAt(ev: React.MouseEvent<SVGSVGElement>) {
    const b = ev.currentTarget.getBoundingClientRect();
    const x = ((ev.clientX - b.left) / b.width) * W;
    return Math.max(0, Math.min(rows.length - 1, Math.floor((x - L) / step)));
  }
  function move(ev: React.MouseEvent<SVGSVGElement>) {
    if (pin) return;
    setHi(idxAt(ev));
    setTip({ x: ev.clientX, y: ev.clientY });
  }
  function click(ev: React.MouseEvent<SVGSVGElement>) {
    const i = idxAt(ev);
    if (pin && i === hi) { setPin(false); setHi(null); setTip(null); return; }
    setPin(true); setHi(i); setTip({ x: ev.clientX, y: ev.clientY });
  }
  /*
   * ★★★ `onMouseLeave` 掛在**外層容器**上，不是掛在兩張 SVG 與表格上。
   *   掛在各自身上的話，從上圖滑到下圖、或從表格滑到圖上時會先收到
   *   一個 leave —— 而 leave 與新元素的 move 誰先誰後**沒有保證**。
   *   leave 排在後面就把剛標好的那一格清掉，症狀是
   *   「滑過去十字線不見了」，而且只有某一個方向會壞。
   * ★★ 外層包著這三個東西，所以在它們之間移動永遠不算離開。
   */
  function leave() { if (!pin) { setHi(null); setTip(null); } }

  const card = hi == null ? null : cardRows(rows[hi].bySrc, keys, picks, srcLabel);
  const sumSel = splits.reduce((n, x) => n + x.sel, 0);
  const sumAll = splits.reduce((n, x) => n + x.total, 0);
  const occRows = rows.filter((r) => r.occ);
  const avgOcc = occRows.length
    ? occRows.reduce((n, r) => n + (r.occ?.rate ?? 0), 0) / occRows.length : 0;

  return (
    <div ref={box} className="relative" onMouseLeave={leave}>
      {/* ── 上：營收 ── */}
      <svg viewBox={`0 0 ${W} ${H1}`} width="100%" height={H1} style={{ display: 'block' }}
        onMouseMove={move} onClick={click} className="cursor-crosshair">
        {Array.from({ length: MONEY_TICKS + 1 }, (_, g) => {
          const y = T1 + ih1 - (ih1 * g) / MONEY_TICKS;
          return (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y} y2={y} stroke="#EFEEE9" strokeWidth="1" />
              <text x={L - 8} y={y + 4} textAnchor="end" fontSize="10.5" fill="#b6bcc4">
                {axisMoney((top * g) / MONEY_TICKS)}</text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const sp = splits[i];
          const hSel = Math.max(T1 + ih1 - yRev(sp.sel), 0);
          const hAll = Math.max(T1 + ih1 - yRev(sp.total), 0);
          const dim = hi != null && hi !== i ? 0.45 : 1;
          return (
            <g key={`b${r.key}`} opacity={dim}>
              {/* ★ 淡色那段是「其餘來源」—— 疊在選中的上面，總高度不變 */}
              {on && sp.rest > 0 && (
                <rect x={cx(i) - barW / 2} y={yRev(sp.total)} width={barW}
                  height={Math.max(hAll - hSel - 2, 1)} rx="3"
                  fill={r.partial ? '#E7EAEE' : '#C3CCD6'} />
              )}
              {/* ★ 選中的那段**貼著基線** —— 長度要從 0 開始量才比得準 */}
              <rect x={cx(i) - barW / 2} y={yRev(sp.sel)} width={barW}
                height={hSel} rx="3"
                fill={r.partial ? '#A9BCD4' : '#41689B'} />
              <text x={cx(i)} y={yRev(sp.total) - 6} textAnchor="middle" fontSize="10"
                fill={hi === i ? '#2E3840' : '#6b7280'} fontWeight={hi === i ? 700 : 400}>
                {toWan(sp.total)}</text>
            </g>
          );
        })}
        {hi != null && (
          <line x1={cx(hi)} x2={cx(hi)} y1={T1} y2={T1 + ih1}
            stroke="#9AA7B4" strokeDasharray="3 3" />
        )}
      </svg>

      {/* ── 下：住房率。**自己的軸**，跟上面沒有換算關係 ── */}
      <svg viewBox={`0 0 ${W} ${H2}`} width="100%" height={H2} style={{ display: 'block' }}
        onMouseMove={move} onClick={click} className="cursor-crosshair">
        {Array.from({ length: MONEY_TICKS + 1 }, (_, g) => {
          const y = T2 + ih2 - (ih2 * g) / MONEY_TICKS;
          return (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y} y2={y} stroke="#EFEEE9" strokeWidth="1" />
              <text x={L - 8} y={y + 4} textAnchor="end" fontSize="10.5" fill="#b6bcc4">
                {(g * 100) / MONEY_TICKS}%</text>
            </g>
          );
        })}
        {/* ★★ 折線遇到沒有房源可以算的那一格要**斷開**，不要接過去 */}
        {segs.map((seg, k) => (
          <polyline key={`s${k}`} fill="none" stroke="#2E3840" strokeWidth="2.5"
            points={seg.map((i) => `${cx(i)},${yOcc(rows[i].occ?.rate ?? 0)}`).join(' ')} />
        ))}
        {rows.map((r, i) => r.occ && (
          <g key={`o${r.key}`}>
            <circle cx={cx(i)} cy={yOcc(r.occ.rate)} r={hi === i ? 5.5 : 4}
              fill={hi === i ? '#2E3840' : '#fff'} stroke="#2E3840" strokeWidth="2.5" />
            <text x={cx(i)} y={yOcc(r.occ.rate) - 11} textAnchor="middle" fontSize="10"
              fill={hi === i ? '#2E3840' : '#6b7280'} fontWeight={hi === i ? 700 : 400}>
              {fmtPct(r.occ.rate, 0)}</text>
          </g>
        ))}
        {hi != null && (
          <line x1={cx(hi)} x2={cx(hi)} y1={T2} y2={T2 + ih2}
            stroke="#9AA7B4" strokeDasharray="3 3" />
        )}
        {xLabels.map((t, i) => t && (
          <text key={`x${rows[i].key}`} x={cx(i)} y={T2 + ih2 + 19} textAnchor="middle"
            fontSize="11" fill={hi === i ? '#2E3840' : '#8b929a'}
            fontWeight={hi === i ? 700 : 400}>{t}</text>
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-mor-slate" />
          {on ? pickedLabel(picks.map(srcLabel), keys.length) : '全部來源'}
        </span>
        {on && (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-[#C3CCD6]" />其餘來源
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5"
            stroke="#2E3840" strokeWidth="2.5" /></svg>住房率
        </span>
      </div>

      {/*
        ── 圖底下的比較表（使用者 2026-09-21 指定：兩列）──
        ★★★ 來源名字放在**表上方獨立一行**（使用者選的做法 A），
          第一欄因此鎖得住寬度 —— 名字一長就把 12 個月的欄位擠扁，
          那是使用者圈出來的那一個。
        ★★ 「不分來源」四個字**還是留在住房率那一列上**：
          上面那一行看起來像整張表的範圍，不在列上再講一次的話，
          住房率會被讀成也只算選中的來源。
      */}
      <div className="mt-3 text-xs text-gray-500">
        選定來源：<b className="text-mor-slatedark">{scopeName}</b>
        <span className="ml-1.5 text-gray-400">（住房率不分來源）</span>
      </div>
      <div className="mt-1.5 overflow-x-auto rounded-lg border border-mor-line bg-white">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead>
            <tr className="bg-[#FAFAF9] text-gray-500">
              <th className="sticky left-0 z-10 w-[122px] min-w-[122px] bg-[#FAFAF9]
                             px-2 py-1.5 text-left font-semibold"> </th>
              {rows.map((r, i) => (
                <th key={`h${r.key}`} onMouseMove={() => !pin && setHi(i)}
                  className={`px-2 py-1.5 text-right font-semibold whitespace-nowrap
                              ${hi === i ? 'bg-amber-100' : ''}`}>{r.label}</th>
              ))}
              <th className="bg-[#EAF0F7] px-2 py-1.5 text-right font-bold whitespace-nowrap">
                合計／平均</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="sticky left-0 z-10 w-[122px] min-w-[122px] bg-white
                             border-b border-mor-line px-2 py-1.5 text-left">
                <b className="block font-semibold">{on ? '選定營收' : '營收'}</b>
                <span className="block text-[11px] font-normal text-gray-400">單位：萬</span>
              </td>
              {rows.map((r, i) => (
                <td key={`r${r.key}`} onMouseMove={() => !pin && setHi(i)}
                  className={`border-b border-mor-line px-2 py-1.5 text-right font-semibold
                              text-mor-slatedark ${hi === i ? 'bg-amber-100' : ''}`}>
                  {toWan(splits[i].sel)}</td>
              ))}
              <td className="border-b border-mor-line bg-[#F3F6FA] px-2 py-1.5
                             text-right font-bold">{toWan(sumSel)}</td>
            </tr>
            <tr>
              <td className="sticky left-0 z-10 w-[122px] min-w-[122px] bg-white
                             px-2 py-1.5 text-left">
                <b className="block font-semibold">住房率</b>
                <span className="block text-[11px] font-normal text-gray-400">不分來源</span>
              </td>
              {rows.map((r, i) => (
                <td key={`o${r.key}`} onMouseMove={() => !pin && setHi(i)}
                  className={`px-2 py-1.5 text-right ${hi === i ? 'bg-amber-100' : ''}`}>
                  {r.occ ? fmtPct(r.occ.rate, 0) : '—'}</td>
              ))}
              <td className="bg-[#F3F6FA] px-2 py-1.5 text-right font-bold">
                {occRows.length ? fmtPct(avgOcc, 0) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400">
        <b>選定營收那一列跟圖上深色那段是同一個數字</b>；期間合計 {toWan(sumSel)} 萬
        {on && sumAll > 0 && <>，佔全部來源 {((sumSel / sumAll) * 100).toFixed(1)}%</>}。
        住房率那一格是<b>月平均</b>，不跟著來源變。
      </p>

      {/* ── 卡片：六個來源的組成 ＋ 小計 ＋ 合計 ＋ 住房率 ── */}
      {hi != null && tip && card && (
        <TipCard x={tip.x} y={tip.y} pin={pin}>
          <div className="mb-1.5 flex items-center justify-between gap-2.5 text-[13px] font-bold">
            <span>{rows[hi].label}</span>
            {pin && <em className="not-italic text-[11px] font-semibold text-gray-400">
              再點一下關掉</em>}
          </div>
          <table className="w-full border-collapse text-xs tabular-nums">
            <tbody>
              {card.rows.map((r) => (
                <tr key={r.key} className={on && !r.on ? 'text-[#b6bcc4]' : ''}>
                  <td className="py-0.5 whitespace-nowrap">
                    <i className="mr-1.5 inline-block h-2 w-2 rounded-sm align-[1px]"
                      style={{ background: !on || r.on ? '#41689B' : '#C3CCD6' }} />
                    {r.label}</td>
                  <td className="py-0.5 pl-3 text-right whitespace-nowrap">{r.wan} 萬</td>
                  <td className="w-[38px] py-0.5 pl-2 text-right text-gray-400">
                    {(r.share * 100).toFixed(0)}%</td>
                </tr>
              ))}
              {on && (
                <tr className="border-t border-mor-line font-bold">
                  <td className="pt-1 whitespace-nowrap">
                    小計　{pickedLabel(picks.map(srcLabel), keys.length)}</td>
                  <td className="pt-1 pl-3 text-right">{card.selWan} 萬</td>
                  <td className="pt-1 pl-2 text-right">{(card.selShare * 100).toFixed(0)}%</td>
                </tr>
              )}
              <tr className="font-bold">
                <td className="py-0.5">合計</td>
                <td className="py-0.5 pl-3 text-right">{card.totalWan} 萬</td>
                <td className="py-0.5 pl-2 text-right">100%</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-1.5 flex justify-between gap-3 border-t border-mor-line pt-1.5 text-xs">
            <span>住房率 <b>{rows[hi].occ ? fmtPct(rows[hi].occ!.rate, 0) : '—'}</b></span>
            <span className="text-gray-500">
              {rows[hi].occ ? <>每間房 <b>{(splits[hi].total / 10000
                / Math.max(rows[hi].occ!.rooms, 1)).toFixed(2)}</b> 萬</> : null}</span>
          </div>
        </TipCard>
      )}
    </div>
  );
}

/**
 * 跟著滑鼠的卡片。
 *
 * ★★★ 用 `fixed` ＋ **把座標夾在視窗內**。畫在格子裡的話會被
 *   `overflow-auto` 的容器裁掉，而最後一個月與畫面下緣那幾格
 *   正是最常被看的（anxing-ui 三）。
 */
function TipCard({ x, y, pin, children }: {
  x: number; y: number; pin: boolean; children: React.ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 16, top: y + 16 });
  useEffect(() => {
    const n = el.current;
    if (!n) return;
    const w = n.offsetWidth, h = n.offsetHeight, pad = 10;
    let left = x + 16, top = y + 16;
    if (left + w + pad > window.innerWidth) left = x - w - 16;
    if (top + h + pad > window.innerHeight) top = y - h - 16;
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [x, y, children]);
  return (
    <div ref={el} style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 50 }}
      className={`min-w-[232px] rounded-xl border border-mor-line bg-white px-3 py-2.5
                  shadow-[0_8px_26px_rgba(46,56,64,.16)]
                  ${pin ? '' : 'pointer-events-none'}`}>
      {children}
    </div>
  );
}

/**
 * 營收（長條，左軸）＋ 住房率（折線，右軸）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 兩條軸不能共用一個刻度】
 *
 * 營收是幾百萬、住房率是 0~100 —— 擠在同一個刻度上的話，
 * 住房率會變成貼著底線的一條直線，等於沒畫。
 * 所以**左軸是錢、右軸是百分比**。
 *
 * 【★★ 右軸固定 0~100%，不隨資料縮放】
 *
 * 會縮放的話，58% 到 62% 看起來像暴漲。
 * 一張把 4% 畫成兩倍高的圖，比不畫還糟。
 *
 * 【★★★ 折線遇到沒有資料就斷開】
 *
 * `occSegments()` 把有值的格子切成好幾段（`lib/dash.ts`，有測試）。
 * 直接把有值的點連起來的話，中間那幾格會被讀成「平滑地降下來」，
 * 而那幾格根本沒有房源可以算。
 * ══════════════════════════════════════════════════════════
 */
function RevOccChart({ rows }: { rows: ComboRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // 280 是下限 —— 再窄就不是手機而是量測還沒完成，用 0 去除會得到 Infinity
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 300, T = 12, B = 34;
  /*
   * ★★★ 這兩個數字是**量出來的**，不是抓的:
   *   「1000 萬」41.1px ＋ 8px 間距 → 左邊至少 50；
   *   「100%」30px ＋ 7px → 右邊至少 37。
   *   2026-09-18 第一版寫 44／30，手機上左軸印成「.000 萬」、
   *   右軸印成「100」—— 兩邊都被切掉，而 tsc 跟測試都不會叫。
   */
  const L = 54, R = 38;
  const ih = H - T - B, iw = Math.max(W - L - R, 40);

  const top = moneyTop(Math.max(...rows.map((r) => r.rev), 0));
  const step = iw / rows.length;
  const barW = Math.max(Math.min(step * 0.56, 46), 2);
  const cx = (i: number) => L + step * i + step / 2;
  const yRev = (v: number) => T + ih - (Math.max(v, 0) / top) * ih;
  const yOcc = (rate: number) => T + ih - Math.min(Math.max(rate, 0), 1) * ih;

  /*
   * x 軸怎麼印（`axisLabels`，有測試）:物業截短、月份隔一個印一個。
   * ★ 手機上十二個月一格只有 ~20px，而「12月」就 25px 寬。
   */
  const { labels: xLabels, stride } = axisLabels(rows, step);
  const segs = occSegments(rows);
  const anyPartial = rows.some((r) => r.partial);
  /* ★ 底下那一格印「0」不是「0 萬」—— 零就是零，多兩個字只是雜訊 */
  const axisMoney = (v: number) =>
    (v === 0 ? '0' : top >= 10000 ? `${Math.round(v / 10000)} 萬` : nf(Math.round(v)));

  return (
    <div ref={box} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
        {/* 格線 ＋ 左軸（錢）＋ 右軸（%）。四等分之後每一格都是好讀的數字（moneyTop） */}
        {Array.from({ length: MONEY_TICKS + 1 }, (_, g) => {
          const y = T + ih - (ih * g) / MONEY_TICKS;
          return (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y} y2={y} stroke="#EFEEE9" strokeWidth="1" />
              <text x={L - 8} y={y + 4} textAnchor="end" fontSize="10.5" fill="#b6bcc4">
                {axisMoney((top * g) / MONEY_TICKS)}</text>
              <text x={W - R + 7} y={y + 4} fontSize="10.5" fill="#9aa3ac">
                {(g * 100) / MONEY_TICKS}%</text>
            </g>
          );
        })}

        {/* 長條 */}
        {rows.map((r, i) => (
          /* ★ 還沒過完的月份畫淡 —— 它天生就比別人矮，實心的話看起來像衰退 */
          <rect key={`b${r.key}`} x={cx(i) - barW / 2} y={yRev(r.rev)}
            width={barW} height={Math.max(T + ih - yRev(r.rev), 0)} rx="3"
            fill="#41689B" fillOpacity={r.partial ? 0.42 : 1} />
        ))}

        {/* 折線。★ 一段一條 polyline —— 中間斷掉的地方不連 */}
        {segs.map((seg) => (
          <polyline key={`l${seg[0]}`} fill="none" stroke="#2E3840" strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round"
            points={seg.map((i) => `${cx(i)},${yOcc(rows[i].occ!.rate)}`).join(' ')} />
        ))}
        {rows.map((r, i) => (r.occ ? (
          <circle key={`c${r.key}`} cx={cx(i)} cy={yOcc(r.occ.rate)} r={hover === i ? 5 : 3.5}
            fill="#fff" stroke="#2E3840" strokeWidth="2.5" />
        ) : null))}

        {/* x 軸文字 */}
        {rows.map((r, i) => (
          (i % stride === 0 || hover === i) && (
            <text key={`t${r.key}`} x={cx(i)} y={H - 10} textAnchor="middle"
              fontSize="11" fill={hover === i ? '#2E3840' : '#8b929a'}>
              {xLabels[i]}
            </text>
          )
        ))}

        {/*
          感應區畫在最後（蓋在上面）而且是**整欄**不只長條 ——
          長條矮的時候點不到，而矮的那幾格正是要看的。
          手機沒有滑鼠，所以 onTouchStart 一定要有。
        */}
        {rows.map((r, i) => (
          <rect key={`h${r.key}`} x={L + step * i} y={T} width={step} height={ih}
            fill={hover === i ? '#2E3840' : 'transparent'} fillOpacity={hover === i ? 0.04 : 0}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            onTouchStart={() => setHover(i)} />
        ))}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
        <Legend color="#41689B" label="營收（左軸）" />
        <Legend color="#2E3840" label="住房率（右軸）" line />
        {anyPartial && (
          <span className="text-[11px] text-amber-700">淡色的那一格是還沒過完的月份</span>
        )}
        <span className="w-full sm:w-auto sm:ml-auto text-gray-500 tabular-nums">
          {hover != null && rows[hover] ? (
            <>
              {/* ★ 分隔的全形空白要寫成 {'　'} —— 直接打在行尾的話，
                  JSX 會把「含換行的空白」整段吃掉，兩段字就黏在一起
                  （2026-09-18 在無頭瀏覽器裡看到「…4,889,954（這個月還沒過完）住房率」）。 */}
              <b className="text-mor-ink">{rows[hover].label}</b>{'　'}營收 {money(rows[hover].rev)}
              {rows[hover].partial && <span className="text-amber-700">（這個月還沒過完）</span>}
              {'　'}
              {rows[hover].occ ? (
                <>
                  住房率 <span className={`font-semibold ${OCC_CLS[occTone(rows[hover].occ!.rate)]}`}>
                    {fmtPct(rows[hover].occ!.rate)}</span>
                  <span className="text-gray-400">
                    （住 {nf(rows[hover].occ!.used)} / 可住 {nf(rows[hover].occ!.days)} 天）</span>
                </>
              ) : <span className="text-gray-400">這一格沒有房源可以算住房率</span>}
            </>
          ) : (
            <span className="text-gray-400">
              <span className="sm:hidden">點一下看那一格的數字</span>
              <span className="hidden sm:inline">滑過去看那一格的數字</span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function TrendChart({ data }: { data: { m: string; rev: number; exp: number; net: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // 280 是下限 —— 再窄就不是手機而是量測還沒完成，用 0 去除會得到 Infinity
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(...data.map((d) => Math.max(d.rev, d.exp)), 1);
  const minNet = Math.min(...data.map((d) => d.net), 0);
  const H = 260, PAD_B = 26, PAD_T = 10;
  const plotH = H - PAD_B - PAD_T;
  const step = W / data.length;
  const barW = Math.max(Math.min(step * 0.32, 26), 2);
  /*
   * 手機上 12 個月只有 ~31px 的間距，「12月」三個字就 22px ——
   * 全部印會疊在一起變成一團黑。間距不夠時隔一個印一個。
   */
  const labelEvery = Math.max(1, Math.ceil(34 / step));

  // 淨額可能是負的，所以折線的基準要能往下走
  const range = max - Math.min(minNet, 0);
  const yOf = (v: number) => PAD_T + plotH - ((v - Math.min(minNet, 0)) / range) * plotH;

  const netPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${i * step + step / 2} ${yOf(d.net)}`).join(' ');
  const zeroY = yOf(0);

  return (
    <div ref={box}>
      {/* viewBox 的寬度等於容器寬度 → 縮放比 1:1，文字不會被壓扁 */}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
        {/* 零軸。淨額掉到線下就是那個月虧了，這條線比任何數字都直觀 */}
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#E0DDD5" strokeWidth="1" />
        {data.map((d, i) => {
          const cx = i * step + step / 2;
          return (
            // 手機沒有滑鼠 —— 沒有 onTouchStart 的話下面那行明細永遠是「滑過柱子看該月明細」
            <g key={d.m} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              onTouchStart={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={H} fill={hover === i ? '#F1F0EC' : 'transparent'} />
              <rect x={cx - barW - 2} y={yOf(d.rev)} width={barW} height={Math.max(zeroY - yOf(d.rev), 0)} fill="#41689B" rx="2" />
              <rect x={cx + 2} y={yOf(d.exp)} width={barW} height={Math.max(zeroY - yOf(d.exp), 0)} fill="#C5C9C4" rx="2" />
            </g>
          );
        })}
        <path d={netPath} fill="none" stroke="#3FAE7C" strokeWidth="2.5" />
        {data.map((d, i) => (
          <circle key={d.m} cx={i * step + step / 2} cy={yOf(d.net)} r={hover === i ? 5 : 3} fill="#3FAE7C" />
        ))}
        {data.map((d, i) => (
          // 被跳過的月份仍然滑得到（上面那層透明 rect），只是不印字
          (i % labelEvery === 0 || hover === i) && (
            <text key={d.m} x={i * step + step / 2} y={H - 8} textAnchor="middle"
              fontSize="11" fill={hover === i ? '#2E3840' : '#9AA29C'}>
              {ymMonth(d.m)}
            </text>
          )
        ))}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
        <Legend color="#41689B" label="營收" />
        <Legend color="#C5C9C4" label="支出" />
        <Legend color="#3FAE7C" label="淨額" line />
        {/* 手機上換行擺滿整行 —— ml-auto 在窄螢幕會把它擠成一條看不完的字 */}
        <span className="w-full sm:w-auto sm:ml-auto text-gray-500 tabular-nums">
          {hover != null ? (
            <>
              <b>{ymShow(data[hover].m)}</b>　營收 {short(data[hover].rev)}　支出 {short(data[hover].exp)}
              <span className={data[hover].net >= 0 ? 'text-mor-green font-semibold' : 'text-red-600 font-semibold'}>
                　淨額 {short(data[hover].net)}
              </span>
            </>
          ) : (
            <span className="text-gray-400">
              <span className="sm:hidden">點柱子看該月明細</span>
              <span className="hidden sm:inline">滑過柱子看該月明細</span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

const Legend = ({ color, label, line }: { color: string; label: string; line?: boolean }) => (
  <span className="flex items-center gap-1.5 text-gray-600">
    <span className={line ? 'w-4 h-0.5' : 'w-3 h-3 rounded-sm'} style={{ background: color }} />
    {label}
  </span>
);
