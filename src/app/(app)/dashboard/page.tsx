'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
import { ymOf, ymShow, ymMonth, monthsAgo, todayStr, fmtRange } from '@/lib/period';
// Supabase 一次只回 1000 列且不報錯 —— 這一頁全部是加總,一定要撈完
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, FilterSelect, FilterDateRange, FilterClear } from '@/lib/filters';
import { srcLabel } from '@/lib/revenue-report';
import {
  type PeriodMode, yearRange, monthRange, prevPeriod, lastYearPeriod,
  yoySameAsPrev, growth, partialMonth, sameMonthRange,
} from '@/lib/compare';

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
  /** 遞延認列。母單的 amount 是「這一天認列多少」,實付總額在 gross_amount。 */
  deferred?: boolean; gross_amount?: number | null; parent_expense_id?: string | null;
};
type Ord = {
  source: string; checkin: string; estate_id: string | null; property_id: string | null;
  amount: number; paid: boolean;
};
type Rev5 = { checkout_date: string | null; property_id: string | null; overall_rating: number };
type Estate = { id: string; name: string; active: boolean };
type Property = { id: string; name: string; estate_id: string | null };
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
  rev: { source: string; estate_id: string | null; property_id: string | null; month_amount: number }[];
  exp: { estate_id: string | null; property_id: string | null; amount: number }[];
  ord: { estate_id: string | null; property_id: string | null }[];
};
type Cmp = {
  rev: number; exp: number; ordN: number;
  bySource: Record<string, number>;
  /** 依物業的營收。key 與 estKey() 一致（estate_id 或 '(未指定物業)'）。 */
  byEstate: Record<string, number>;
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
    if (propF) return property_id === propF;
    if (estF) return (estate_id ?? (property_id ? estateOfProp[property_id] : null)) === estF;
    return true;
  }, [estF, propF, estateOfProp]);

  const load = useCallback(async () => {
    setLoading(true);
    setTruncated('');
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
        .select('source, estate_id, property_id, month_amount')
        .gte('ym', ymOf(f)).lte('ym', ymOf(t)).range(a, b));
    const cmpExp = (f: string, t: string) =>
      fetchAll<CmpRaw['exp'][number]>((a, b) => supabase.from('expenses')
        .select('amount, estate_id, property_id')
        .gte('spent_on', f).lte('spent_on', t).range(a, b));
    const cmpOrd = (f: string, t: string) =>
      fetchAll<CmpRaw['ord'][number]>((a, b) => supabase.from('orders')
        .select('estate_id, property_id')
        .gte('checkin', f).lte('checkin', t).range(a, b));

    const [
      rv, ex, od, r5, es, pr, cd, pd,
      pRev, pExp, pOrd, yRevMaybe, yExp, yOrd,
    ] = await Promise.all([
      fetchAll<Rev>((f, t) => supabase.from('revenue_recognitions')
        .select('ym, source, estate_id, property_id, month_amount, fee_type, order_id')
        .gte('ym', ymOf(fromD)).lte('ym', ymOf(toD)).range(f, t)),
      fetchAll<Exp>((f, t) => supabase.from('expenses')
        .select('id, spent_on, amount, account_code, estate_id, property_id, purpose_type, item_name, starred, deferred, gross_amount, parent_expense_id')
        .gte('spent_on', fromD).lte('spent_on', toD).range(f, t)),
      fetchAll<Ord>((f, t) => supabase.from('orders')
        .select('source, checkin, estate_id, property_id, amount, paid')
        .gte('checkin', fromD).lte('checkin', toD).range(f, t)),
      fetchAll<Rev5>((f, t) => supabase.from('reviews')
        .select('checkout_date, property_id, overall_rating')
        .gte('checkout_date', fromD).lte('checkout_date', toD).range(f, t)),
      fetchAll<Estate>((f, t) => supabase.from('estates')
        .select('id, name, active').order('sort').order('name').range(f, t)),
      /*
       * 房源也要分頁。它看起來是小主檔，但 estateOfProp 靠它把
       * 「沒有 estate_id 的認列」回推到物業 —— 少撈幾間房，
       * 那些認列就會從物業視角的營收裡整塊消失，而且沒有跡象。
       */
      fetchAll<Property>((f, t) => supabase.from('properties')
        .select('id, name, estate_id').order('name').range(f, t)),
      fetchAll<Code>((f, t) => supabase.from('account_codes')
        .select('code, name').range(f, t)),
      // 待付款：已核可但還沒填出款日 —— 這是「錢還沒出去但已經承諾要出」的部位
      fetchAll<Pending>((f, t) => supabase.from('purchase_requests')
        .select('total_amount, planned_transfer_on')
        .eq('status', 'approved').is('purchased_on', null).range(f, t)),

      // ── 比較期（跟上面同時發，不排隊）────────────
      cmpRev(pf, pt), cmpExp(pf, pt), cmpOrd(pf, pt),
      // 同一段月份的話不重發，下面直接沿用環比的結果
      revSameSpan ? Promise.resolve(null) : cmpRev(yf, yt),
      cmpExp(yf, yt), cmpOrd(yf, yt),
    ]);

    // 撈不完就明講。這一頁的數字全部是加總，少一列就是錯的 ——
    // 靜靜顯示一個偏低的數字比顯示錯誤訊息糟糕得多。
    const bad = [rv, ex, od, r5, es, pr, cd, pd,
      pRev, pExp, pOrd, yExp, yOrd].find((r) => r.error);
    if (bad?.error) setTruncated(bad.error);

    setRevs(rv.rows);
    setExps(ex.rows);
    setOrds(od.rows);
    setRvs(r5.rows);
    setEstates(es.rows);
    setProperties(pr.rows);
    setCodes(cd.rows);
    setPending(pd.rows);

    /*
     * 比較期的結果組裝。查詢已經在上面跟主查詢一起發完了。
     *
     * 環比(上一期)與同比(去年同期)分開查而不是拉一個大區間再切:
     * 2026-08 對 2025-08 中間隔了 11 個月,一次撈會把不需要的月份全部拉回來。
     *
     * 分頁一樣不能省 —— 少了的話「去年同期」會偏低,成長率跟著假,
     * 而那個假的百分比看起來完全正常,不會有人懷疑。
     */
    setCmpRaw({
      prev: { rev: pRev.rows, exp: pExp.rows, ord: pOrd.rows },
      // 同一段月份時沿用環比的認列 —— 上面已經確認過那兩段的 ym 完全相同
      yoy: { rev: (yRevMaybe ?? pRev).rows, exp: yExp.rows, ord: yOrd.rows },
    });

    setLoading(false);
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

  // 物業改了就把房源清掉 —— 否則會留著上一個物業的房間，篩出空結果
  function pickEstate(v: string) { setEstF(v); setPropF(''); }
  function clearFilters() {
    setFromD(monthsAgo(0)); setToD(todayStr()); setEstF(''); setPropF('');
  }

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  const propName = useMemo(() => Object.fromEntries(properties.map((p) => [p.id, p.name])), [properties]);
  const codeName = useMemo(() => Object.fromEntries(codes.map((c) => [c.code, c.name])), [codes]);
  const propsOfEstate = useMemo(
    () => properties.filter((p) => !estF || p.estate_id === estF), [properties, estF]);


  /** 比較期的彙總。篩選在這裡才套,load 只負責拿資料(見 CmpRaw)。 */
  const cmp = useMemo(() => {
    if (!cmpRaw) return null;
    const roll = (c: CmpRaw): Cmp => {
      const rr = c.rev.filter((x) => matchScope(x.estate_id, x.property_id));
      const bySource: Record<string, number> = {};
      const byEstate: Record<string, number> = {};
      rr.forEach((x) => {
        const amt = Number(x.month_amount || 0);
        bySource[x.source] = (bySource[x.source] ?? 0) + amt;
        // 用同一支 estKey —— 認列的 estate_id 有機會是空的，
        // 那時要用 property_id 回推。兩邊用不同規則的話本期跟上一期會對到不同的物業。
        byEstate[estKey(x.estate_id, x.property_id)] = (byEstate[estKey(x.estate_id, x.property_id)] ?? 0) + amt;
      });
      return {
        rev: rr.reduce((a, x) => a + Number(x.month_amount || 0), 0),
        exp: c.exp.filter((x) => matchScope(x.estate_id, x.property_id))
          .reduce((a, x) => a + Number(x.amount || 0), 0),
        ordN: c.ord.filter((x) => matchScope(x.estate_id, x.property_id)).length,
        bySource,
        byEstate,
      };
    };
    return { prev: roll(cmpRaw.prev), yoy: roll(cmpRaw.yoy) };
  }, [cmpRaw, matchScope, estKey]);

  const fRevs = useMemo(() => revs.filter((r) => matchScope(r.estate_id, r.property_id)), [revs, matchScope]);
  const fExps = useMemo(() => exps.filter((e) => matchScope(e.estate_id, e.property_id)), [exps, matchScope]);
  const fOrds = useMemo(() => ords.filter((o) => matchScope(o.estate_id, o.property_id)), [ords, matchScope]);
  const fRvs = useMemo(() => rvs.filter((r) => {
    if (propF) return r.property_id === propF;
    if (estF) return properties.find((p) => p.id === r.property_id)?.estate_id === estF;
    return true;
  }), [rvs, estF, propF, properties]);

  // ── 核心數字 ────────────────────────────────────────
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
  const cntBySource = useMemo(() => groupCount(fRevs, (r) => r.source), [fRevs]);
  const cntByEstate = useMemo(
    () => groupCount(fRevs, (r) => estKey(r.estate_id, r.property_id)), [fRevs, estKey]);

  const revBySource = useMemo(
    () => groupSum(fRevs, (r) => r.source, (r) => Number(r.month_amount || 0)), [fRevs]);
  const revByEstate = useMemo(
    () => groupSum(fRevs, (r) => estKey(r.estate_id, r.property_id), (r) => Number(r.month_amount || 0)), [fRevs, estKey]);

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
  const ordBySource = useMemo(() => {
    const m: Record<string, number> = {};
    fOrds.forEach((o) => { m[o.source] = (m[o.source] ?? 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [fOrds]);
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
    <div className="max-w-[1400px]">
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
                <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 ml-1" />
                <span className="text-gray-400">~</span>
                <input type="date" value={toD} onChange={(e) => setToD(e.target.value)}
                  className="rounded-lg border border-gray-300 px-2 py-1.5" />
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
        <FilterClear active={!!(estF || propF)} onClear={clearFilters} />
      </FilterBar>

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
            跑 <code className="px-1 bg-amber-100 rounded">supabase/查-營收認列為何是零.sql</code> 找原因,
            確認是缺漏之後用 <code className="px-1 bg-amber-100 rounded">select rebuild_recognitions();</code> 重算。
            <br />
            （若這個區間本來就有大量跨月訂單,落差是正常的 —— 錢會認列在之後的月份。）
          </div>
        </div>
      )}

      {/* ═══ 環比與同比 ═══
        兩個一起看,少一個都會誤判:
          環比(比上一期) 看短期動能
          同比(比去年同期) 避開季節性 —— 短租淡旺季差很多,
                          八月比七月掉 20% 可能完全正常,
                          但比去年八月掉 20% 就是真的在退。
      */}
      {cmp && (() => {
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

        /** 明細列（依來源／依物業共用）—— 兩邊長得不一樣的話會被當成兩種東西 */
        const sub = (key: string, name: string, cur: number, prev: number, yoy: number, n?: number) => (
          <tr key={key} className="border-b border-mor-line/60 last:border-0">
            <td className="px-3 py-2 pl-6 text-gray-600 whitespace-nowrap">{name}</td>
            {/*
              金額後面接筆數。
              「長租 4,802 萬」一個人回答不了「這是幾張約撐起來的」——
              一張大單跟四十張小單的意義完全不同,而只看金額分不出來。
              筆數用灰色小字,不跟金額搶。
            */}
            <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
              <span className="font-semibold">{money(cur)}</span>
              {n !== undefined && (
                <span className="text-gray-400 font-normal ml-1.5 text-xs">｜{nf(n)} 筆</span>
              )}
            </td>
            <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap tabular-nums">{money(prev)}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{delta(cur, prev)}</td>
            {!sameYoY && <>
              <td className="px-3 py-2 text-right text-gray-500 whitespace-nowrap tabular-nums">{money(yoy)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{delta(cur, yoy)}</td>
            </>}
          </tr>
        );

        return (
          <div className="rounded-xl glass p-4 md:p-5 mb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
              <h2 className="font-bold">期間比較</h2>
              <span className="text-xs text-gray-400">
                {sameYoY ? '年度模式下環比與同比是同一段,只顯示一組' : '環比看動能,同比避開季節性'}
              </span>
            </div>
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
                  {row('營收', totalRev, cmp.prev.rev, cmp.yoy.rev, money)}
                  {row('支出', totalExp, cmp.prev.exp, cmp.yoy.exp, money, false)}
                  {row('淨額', net, cmp.prev.rev - cmp.prev.exp, cmp.yoy.rev - cmp.yoy.exp, money)}
                  {row('訂單數', fOrds.length, cmp.prev.ordN, cmp.yoy.ordN, cnt)}
                  <tr><td colSpan={sameYoY ? 4 : 6} className="px-3 pt-3 pb-1 text-xs font-semibold text-gray-500">依來源</td></tr>
                  {/* 總營收成長時,要看得出是哪一塊在撐 —— 可能長租在漲而短租在退 */}
                  {revBySource.map(([k, v]) => sub(k, srcLabel(k), v, cmp.prev.bySource[k] ?? 0, cmp.yoy.bySource[k] ?? 0, cntBySource[k] ?? 0))}

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
                  {revByEstateCmp.map(({ key, name, cur, prev, yoy }) => sub(key, name, cur, prev, yoy, cntByEstate[key] ?? 0))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ═══ 趨勢 ═══ */}
      <Panel title="營收與支出趨勢" hint="營收用已按月拆分的認列金額，跨月訂單已經分好了">
        {trend.length === 0 ? <Empty /> : <TrendChart data={trend} />}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="營收來源" hint="點圖例可以只看單一來源的佔比">
          <BarList rows={revBySource.map(([k, v]) => ({
            label: srcLabel(k), value: v, color: SRC_COLOR[k] ?? '#7A8B99',
          }))} fmt={money} />
        </Panel>
        <Panel title="訂單數分布" hint="看的是筆數不是金額 —— 跟營收比對得出「哪個通路單價高」">
          <BarList rows={ordBySource.map(([k, v]) => ({
            label: srcLabel(k), value: v, color: SRC_COLOR[k] ?? '#7A8B99',
          }))} fmt={(n) => nf(n) + ' 筆'} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="各物業營收">
          <BarList rows={revByEstate.map(([k, v], i) => ({
            label: nameOf(k), value: v, color: PALETTE[i % PALETTE.length],
          }))} fmt={money} />
        </Panel>
        <Panel title="各物業支出" hint="辦公室的支出不屬於任何物業，另外列">
          <BarList rows={expByEstate.map(([k, v], i) => ({
            label: nameOf(k), value: v, color: PALETTE[(i + 3) % PALETTE.length],
          }))} fmt={money} />
        </Panel>
      </div>

      {/* ═══ 各物業損益 ═══ */}
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

      {/* ═══ 支出科目 ═══ */}
      <Panel title="支出科目" hint="錢花在哪些類別。連續幾個月都在同一科目衝高，通常是有東西該修了">
        <BarList rows={expByCode.map(([k, v], i) => ({
          label: codeName[k] ?? k, value: v, color: PALETTE[(i + 1) % PALETTE.length],
        }))} fmt={money} />
      </Panel>

      {/* ═══ 評價 ═══ */}
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

      {/*
        關注支出。放在最後 —— 它是「要追的那幾筆」,不是總覽,
        看完上面的數字之後才會想看細節。

        沒有關注時整塊不出現,不留一個空面板佔位置。
      */}
      {starred.length > 0 && (
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
