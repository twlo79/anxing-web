'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { managerIdOn, type Tenure } from '@/lib/estate-manager';
import FilterToggle from '@/components/FilterToggle';
import { createClient } from '@/lib/supabase';
import * as XLSX from 'xlsx-js-style';
import {
  summarySheet, detailSheet, safeSheetName, xlsxFilename, styleSheet, cellRef,
  SUMMARY_HEADER, DETAIL_HEADER, type DetailRow,
} from '@/lib/manager-xlsx';
import { fetchAll } from '@/lib/fetch-all';
import {
  STAR_BAR_DARK, STAR_BAR_LIGHT, STAR_TRACK_DARK, STAR_TRACK_LIGHT,
  STAR_GLYPH, STAR_GLYPH_EMPTY,
} from '@/lib/star-bar';
import { useProfile } from '@/lib/profile';
import {
  canHideReview, isHidden, hideError, hideReasonText, hideImpactText, HIDE_REASONS,
} from '@/lib/review-hide';
import RangeInput from '@/components/RangeInput';
import { EXPORT_TONE } from '@/components/Actions';

type Estate = { id: string; name: string; manager: string | null; sort: number };
type Property = { id: string; name: string; active: boolean; estate_id: string | null };
type Review = {
  id: string; airbnb_review_id: string; property_id: string | null;
  listing_name_raw: string | null; guest_name: string;
  checkin_date: string | null; checkout_date: string | null; nights: number | null;
  overall_rating: number; comment: string | null; comment_original: string | null;
  comment_language: string | null;
  rating_checkin: number | null; rating_cleanliness: number | null; rating_accuracy: number | null;
  rating_communication: number | null; rating_location: number | null; rating_value: number | null;
  detail_comments: any; host_reply: string | null; source_url: string | null;
  /** 人工隱藏（migration_178）。null = 正常顯示 */
  hidden_at?: string | null; hidden_by?: string | null; hidden_reason?: string | null;
};
/**
 * `active` 是 migration_130 加的。
 *
 * 統計現在**含停用物業** —— 那些住宿真的發生過，停用只表示
 * 「現在不管這棟了」，不該回頭改寫歷史。但畫面要標出來，
 * 不然排行榜上突然多兩棟已經不做的，看起來像資料錯了。
 */
type Stat = { estate_id: string; estate_name: string; manager: string | null; sort: number; review_count: number; avg_rating: number; active?: boolean };
type MgrStat = { manager: string; avg_rating: number; s5: number; s4: number; s3: number; s2: number; s1: number; total: number };

const PAGE_SIZE = 50;
const CAT_LABEL: Record<string, string> = {
  CHECKIN: '入住', CLEANLINESS: '清潔', ACCURACY: '準確',
  COMMUNICATION: '溝通', LOCATION: '位置', VALUE: '性價比',
};

// 星等配色:5=金黃(標準) 4=藍(不佳) 3=橘(差) 2=紅 1=深紅(非常差)
// 星等配色:5=黃 4=橘 3=紅 2=紫 1=黑
const MGR_ORDER = ['芊', '月', '花', '唐'];
function mgrOrder(name: string) {
  if (name === '未指派') return 99;
  const i = MGR_ORDER.indexOf(name);
  return i === -1 ? 50 : i;
}

/**
 * 表格與卡片裡那排 ★ 的顏色。
 *
 * ★ 跟總覽卡的長條**同一條色帶**（使用者:「下面一樣搭配」）——
 *   只是這裡是白底，所以吃 `STAR_BAR_LIGHT`（整組壓深）。
 *   淡色印在白紙上等於沒畫。
 *
 * ★★ 用 style 而不是 Tailwind class:類別是**組出來**的話 Tailwind
 *   靜態掃描不到，畫面會沒有顏色而且不報錯（README 9.3）。
 */
/** 星等 → 索引。5 星是 0、1 星是 4。超出範圍的夾住,不要回 undefined。 */
const starIdx = (n: number) => 5 - Math.min(5, Math.max(1, Math.round(n)));

/**
 * 「N 星」那行**文字**的顏色。要讀，所以用壓深的那組。
 *
 * ★★ 回的是**色碼**，只能放進 `style`。
 *   放進 className 的話會變成一個沒人認得的 class ——
 *   而症狀是那行字沒有顏色、tsc 過、畫面不報錯（README 9.3）。
 *   這個坑我 2026-08-28 當天就踩了一次。
 */
const starTextColor = (n: number) => STAR_BAR_LIGHT[starIdx(n)];

/**
 * 那排 ★。
 *
 * ★★ 星星用鮮豔的 `STAR_GLYPH`，旁邊的「N 星」用壓深的 `STAR_BAR_LIGHT` ——
 *   兩者是同一個色相的深淺,不是兩種顏色。理由見 lib/star-bar.ts:
 *   星星是裝飾（旁邊那行字才是意思），文字要讀。
 */
function Stars({ n }: { n: number }) {
  const filled = Math.round(n);
  return (
    <span className="font-semibold" style={{ color: STAR_GLYPH[starIdx(n)] }}>
      {'\u2605'.repeat(filled)}
      {/* 沒拿到的星星留一個淡痕 —— 全部拿掉的話「3 星」跟「3 顆星滿分」分不出來 */}
      <span style={{ color: STAR_GLYPH_EMPTY }}>{'\u2605'.repeat(Math.max(0, 5 - filled))}</span>
    </span>
  );
}

function hasNegative(r: Review) {
  if (r.overall_rating <= 3) return true;
  const tags = r.detail_comments?.tags;
  if (!tags) return false;
  return Object.values(tags).some((arr: any) => (arr as any[]).some((t) => t.intent === 'NEGATIVE'));
}

// 留言顯示:有中文的欄位優先(不信任 comment_language,因為多筆標記錯誤)
function displayComment(r: Review) {
  const hasCJK = (s?: string | null) => !!s && /[\u4e00-\u9fff]/.test(s);
  if (hasCJK(r.comment)) return r.comment;
  if (hasCJK(r.comment_original)) return r.comment_original;
  return r.comment ?? r.comment_original ?? null;
}

function csvEsc(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r\n/g, '\n');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function ReviewsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  /*
   * 物業查詢**回來了沒**，跟「回來幾筆」是兩件事。
   *
   * 不能用 `estates.length > 0` 代替 —— 查詢失敗時 data 是 null,
   * 存進去也是空陣列，兩種情況長得一模一樣。
   * 而失敗那次的下場是整欄永遠顯示「—」，看起來像資料真的沒有物業。
   */
  const [estatesLoaded, setEstatesLoaded] = useState(false);
  const [estatesErr, setEstatesErr] = useState('');
  const [tenures, setTenures] = useState<Tenure[]>([]);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  /**
   * 這一則評價該算誰的 —— 用**退房日**回查任期。
   *
   * 查不到就是「未指派」（登記任期之前的評價）。刻意不退回現任 ——
   * 那等於把歷史又算到他頭上,而那正是這整件事要解決的問題。
   */
  const mgrOf = (r: { property_id: string | null; checkout_date: string | null }) => {
    const p = r.property_id ? propById[r.property_id] : null;
    const id = managerIdOn(tenures, p?.estate_id ?? null, r.checkout_date);
    return id ? (staffNames[id] ?? '') : '';
  };
  const [properties, setProperties] = useState<Property[]>([]);
  const [rows, setRows] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  /* 只看隱藏的（migration_178）。預設關 —— 隱藏的就是不該出現在日常清單裡 */
  const [showHidden, setShowHidden] = useState(false);
  const { profile } = useProfile();
  const canHide = canHideReview(profile?.role);
  /** 正在填隱藏原因的那一則 */
  const [hiding, setHiding] = useState<Review | null>(null);
  const [hideReason, setHideReason] = useState(HIDE_REASONS[0]);
  const [hideOther, setHideOther] = useState('');
  const [hideBusy, setHideBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Review | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingMgr, setExportingMgr] = useState(false);
  // 表格篩選
  const [estateId, setEstateId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [ratingFilter, setRatingFilter] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');
  // Dashboard 獨立篩選
  /*
   * ★★ 統計區間與清單篩選**合而為一**（2026-08-28 使用者:「這個合併就好」）。
   *
   *   原本是兩組獨立的退房日期:上面一組餵統計（review_stats / manager_stats），
   *   下面一組餵清單。而它們問的是同一件事 —— 使用者只會想到「我要看這段期間」。
   *
   * ★ 兩組分開的實際症狀:上面設了 7 月、下面沒設,
   *   於是**平均星等是 7 月的、底下列表是全部的** ——
   *   兩個數字擺在同一頁而算的不是同一批資料,
   *   而畫面上沒有任何地方說得出這件事。
   *
   *   （原本有一段補丁:點物業卡片時把統計區間複製到篩選。
   *   那個補丁的存在本身就是在說這兩組應該是一組。）
   *
   * ★ 控制項留在**最上面**,不放進篩選列 ——
   *   篩選列在手機會收起來,而它影響的統計卡就在上方看得見。
   *   看得見的數字被看不見的控制項決定,是最難查的那種問題。
   */
  const [stats, setStats] = useState<Stat[]>([]);
  const [mgrStats, setMgrStats] = useState<MgrStat[]>([]);
  const [mgrOpen, setMgrOpen] = useState<MgrStat | null>(null);
  const [listModal, setListModal] = useState<{ title: string; propIds: string[] | null; rating: number | null } | null>(null);

  const propById = useMemo(() => Object.fromEntries(properties.map((p) => [p.id, p])), [properties]);
  /*
   * 主檔（房源／物業）載完了沒。
   *
   * 【為什麼需要這個旗標】（2026-08-17）
   * 這三支查詢跟評價列表是各自獨立發出去的，列表不等它們就先畫。
   * 所以載入的頭一兩秒 `propById` 是空的，畫面把每一列都寫成
   * 「未對應」「—」—— 而那跟「這筆真的對不到房源」長得一模一樣。
   *
   * 使用者看到的是「爬進來的評價都沒有物業」，然後去查爬蟲 ——
   * 而爬蟲是好的，資料也是好的，只是畫面早畫了一步。
   *
   * 這裡不改成「等載完再畫列表」—— 那會讓整頁多空白一秒。
   * 只要把「還沒載完」跟「對不到」分開講就夠了。
   */
  /*
   * ★★ 房源**與物業**都載到才算載完（2026-08-19 修）。
   *
   * 原本只看 properties。四支查詢是各自獨立發出去的，
   * 而 properties 走 fetchAll（可能好幾趟）、estates 是單趟小查詢 ——
   * 桌機幾乎都是 estates 先到，所以看不出問題。
   *
   * 手機上順序會翻過來:properties 先回 → 這個旗標變 true →
   * 物業那一格印出「—」。而「—」的意思是**這筆對不到物業**,
   * 跟「還在載」完全是兩件事。使用者看到的是「手機讀不出物業」。
   *
   * 一個只等一半的「載完了嗎」比沒有這個旗標更糟:
   * 它會用很有把握的語氣講一件還不知道的事。
   */
  const mastersLoaded = properties.length > 0 && estatesLoaded;
  const estateById = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e])), [estates]);
  const visibleProps = useMemo(
    () => (estateId ? properties.filter((p) => p.estate_id === estateId) : properties),
    [properties, estateId]
  );

  useEffect(() => {
    /*
     * ★ 錯誤不可以吞掉。
     *
     * 原本是 `.then(({ data }) => setEstates(data ?? []))` —— 查詢失敗時
     * data 是 null，靜靜地存進一個空陣列，然後整欄物業顯示「—」。
     * 而「—」看起來就是「這筆沒有物業」,沒有任何跡象指向網路失敗。
     * 手機在電梯裡重整一次就會踩到。
     */
    supabase.from('estates').select('id, name, manager, sort').eq('active', true).order('sort')
      .then(({ data, error }) => {
        if (error) setEstatesErr(error.message);
        else setEstates(data ?? []);
        setEstatesLoaded(true);
      });
    /*
     * 管家任期（migration_115）。
     *
     * 【為什麼不再讀 estates.manager】
     * 那一欄沒有時間 —— 換管家之後,過去所有評價的歸屬會跟著一起變:
     * 新接手的人一上任就背著前任的分數,離開的人的貢獻憑空消失。
     *
     * 改成依**退房日**回查任期,歷史就固定了。
     * 表很小（一個物業幾段）,一次載完在前端算。
     */
    supabase.from('estate_managers')
      .select('id, estate_id, staff_id, start_date, end_date')
      .then(({ data }) => setTenures((data ?? []) as Tenure[]));
    supabase.from('staff').select('id, name')
      .then(({ data }) => setStaffNames(Object.fromEntries((data ?? []).map((x: any) => [x.id, x.name]))));
    /*
     * 【一定要分頁】（2026-08-17）
     *
     * Supabase 預設**最多回 1000 列而且不報錯**。房源超過 1000 之後，
     * 撈不到的那些在 `propById` 裡查不到 → 評價列表顯示「未對應」、物業「—」，
     * 而管家是靠物業回查任期的，所以負責人也跟著空。
     *
     * 症狀看起來像「爬蟲沒對到房源」，實際上 reviews.property_id 好好的 ——
     * 1,592 筆全部有值。錯的只是畫面查不到名字。
     */
    fetchAll<Property>((f, t) => supabase.from('properties')
      .select('id, name, active, estate_id')
      .order('active', { ascending: false }).order('name').range(f, t))
      .then(({ rows }) => setProperties(rows));
  }, [supabase]);

  // Dashboard 統計
  useEffect(() => {
    supabase.rpc('review_stats', { p_from: dateFrom || null, p_to: dateTo || null })
      .then(({ data }) => setStats((data as Stat[]) ?? []));
    supabase.rpc('manager_stats', { p_from: dateFrom || null, p_to: dateTo || null })
      .then(({ data }) => setMgrStats((data as MgrStat[]) ?? []));
  }, [supabase, dateFrom, dateTo]);

  const overall = useMemo(() => {
    const cnt = stats.reduce((s, x) => s + Number(x.review_count), 0);
    if (!cnt) return { avg: 0, cnt: 0 };
    const sum = stats.reduce((s, x) => s + Number(x.avg_rating) * Number(x.review_count), 0);
    return { avg: sum / cnt, cnt };
  }, [stats]);

  const overallDist = useMemo(() => {
    const t = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const m of mgrStats) { t.s5 += +m.s5; t.s4 += +m.s4; t.s3 += +m.s3; t.s2 += +m.s2; t.s1 += +m.s1; }
    const total = t.s5 + t.s4 + t.s3 + t.s2 + t.s1;
    return { total, rows: [['5 星', t.s5], ['4 星', t.s4], ['3 星', t.s3], ['2 星', t.s2], ['1 星', t.s1]] as [string, number][] };
  }, [mgrStats]);

  const buildQuery = useCallback((withCount: boolean) => {
    let q = supabase.from('reviews')
      .select('*', withCount ? { count: 'exact' } : undefined)
      .order('checkout_date', { ascending: false, nullsFirst: false });
    /*
     * ★★ 預設看不到隱藏的（migration_178）。
     *
     *   `showHidden` 打開時**改成只看隱藏的**，不是「全部一起顯示」——
     *   混在一起的話那幾則會夾在幾百列中間，
     *   而使用者打開這個開關就是為了找它們。
     */
    q = showHidden ? q.not('hidden_at', 'is', null) : q.is('hidden_at', null);
    if (propertyId) q = q.eq('property_id', propertyId);
    else if (estateId) {
      const ids = properties.filter((p) => p.estate_id === estateId).map((p) => p.id);
      q = q.in('property_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    }
    if (dateFrom) q = q.gte('checkout_date', dateFrom);
    if (dateTo) q = q.lte('checkout_date', dateTo);
    if (ratingFilter === '5') q = q.gte('overall_rating', 5);
    if (ratingFilter === '4') q = q.gte('overall_rating', 4).lt('overall_rating', 5);
    if (ratingFilter === 'low') q = q.lte('overall_rating', 3);
    if (kw) q = q.or(`guest_name.ilike.%${kw}%,comment.ilike.%${kw}%,comment_original.ilike.%${kw}%,listing_name_raw.ilike.%${kw}%`);
    return q;
  }, [supabase, estateId, propertyId, dateFrom, dateTo, ratingFilter, kw, properties, showHidden]);

  /**
   * 隱藏 / 還原。
   *
   * ★★ 一定要看**改到幾列**。RLS 擋下的 UPDATE 會回成功且影響 0 列 ——
   *    畫面上看起來藏好了，重整才發現還在（README 9.1）。
   *    這一頁的 reviews_write 只給 manager / super_admin，
   *    所以權限不足是很可能發生的事，不是理論上的。
   */
  const doHide = useCallback(async (r: Review, reason: string | null) => {
    setHideBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    /* 三欄要嘛都有、要嘛都沒有 —— 資料庫的 rv_hidden_chk 也擋 */
    const patch = reason
      ? { hidden_at: new Date().toISOString(), hidden_by: user?.id ?? null, hidden_reason: reason }
      : { hidden_at: null, hidden_by: null, hidden_reason: null };
    const { data, error } = await supabase.from('reviews').update(patch).eq('id', r.id).select('id');
    setHideBusy(false);
    if (error) { alert((reason ? '隱藏' : '還原') + '失敗：' + error.message); return false; }
    if (!data || data.length === 0) {
      alert('一列都沒有更新 —— 通常是權限（只有經理與總管理員可以隱藏評價）。請重新整理後確認。');
      return false;
    }
    return true;
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, count } = await buildQuery(true).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    setRows((data as any) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [buildQuery, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [estateId, propertyId, dateFrom, dateTo, ratingFilter, kw, showHidden]);
  useEffect(() => { setPropertyId(''); }, [estateId]);

  // CSV 匯出(目前篩選的全部資料)
  async function exportCsv() {
    setExporting(true);
    const all: Review[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      const { data } = await buildQuery(false).range(from, from + 999);
      const batch = (data as any as Review[]) ?? [];
      all.push(...batch);
      if (batch.length < 1000) break;
    }
    /*
     * 【為什麼從 CSV 改成 Excel】
     * 按鈕寫「下載 Excel」而檔案是 .csv 的話，使用者雙擊打開會是記事本，
     * 或是 Excel 把中文吃成亂碼。評價的留言常常很長又帶換行，
     * 那正是 CSV 最容易壞掉的地方 —— 一個沒跳好的換行就會把整份表格切歪。
     */
    const header = ['入住日','退房日','物業','房源','旅客','負責人','總評','留言','原文','語言','入住','清潔','準確','溝通','位置','性價比','私下回饋','房東回覆','review_id'];
    const aoa: (string | number | null)[][] = [header];
    for (const r of all) {
      const p = r.property_id ? propById[r.property_id] : null;
      const e = p?.estate_id ? estateById[p.estate_id] : null;
      aoa.push([
        r.checkin_date, r.checkout_date, e?.name ?? '', p?.name ?? '', r.guest_name, mgrOf(r),
        r.overall_rating, displayComment(r), r.comment_original, r.comment_language,
        r.rating_checkin, r.rating_cleanliness, r.rating_accuracy, r.rating_communication, r.rating_location, r.rating_value,
        r.detail_comments?.private_feedback ?? '', r.host_reply ?? '', r.airbnb_review_id,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 6 },
      { wch: 50 }, { wch: 50 }, { wch: 6 },
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 8 },
      { wch: 40 }, { wch: 40 }, { wch: 14 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '評價');
    XLSX.writeFile(wb, `評價匯出_${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  /**
   * 管家評價 Excel。
   *
   * 【為什麼是 Excel 不是 CSV】
   * CSV 只有一張表。要「總表 ＋ 每位管家的明細」就得下載五個檔案，
   * 或者把所有人混在一張表裡再自己篩 —— 兩個都不是人會做的事。
   *
   * 第一頁總表，之後一位管家一頁，內容是那段期間他名下的每一則評價。
   *
   * 【明細一定要用 fetchAll】
   * 目前光是四位管家就超過 1,000 則。Supabase 預設只回 1,000 列
   * **而且不報錯** —— 直接查的話報表會靜靜地少掉一截，
   * 而少掉的是最舊的那些，沒有人看得出來。
   */
  async function exportMgrXlsx() {
    setExportingMgr(true);
    try {
      const sorted = [...mgrStats].sort((a, b) => mgrOrder(a.manager) - mgrOrder(b.manager));

      // 明細用「統計區間」，不是下面清單的篩選 —— 上面那張表算的是統計區間，
      // 兩者取不同範圍的話總表跟明細對不起來，而那種不一致最難查。
      const { rows: all, error } = await fetchAll<Review>((f, t) => {
        let q = supabase.from('reviews')
          // 隱藏的不算 —— 要跟 review_stats / manager_stats 一致,
          // 不一致的話總表跟明細對不起來,而那種不一致最難查
          .select('property_id, guest_name, overall_rating, comment, comment_original, comment_language, checkout_date')
          .is('hidden_at', null)
          .order('checkout_date', { ascending: false, nullsFirst: false });
        if (dateFrom) q = q.gte('checkout_date', dateFrom);
        if (dateTo) q = q.lte('checkout_date', dateTo);
        return q.range(f, t) as any;
      });
      if (error) { alert('讀取評價明細失敗：' + error); return; }

      // 管家 = 房源所屬物業的負責人。跟 manager_stats 同一條規則，
      // 不同的話總表的筆數會跟明細的列數對不起來。
      const byMgr = new Map<string, DetailRow[]>();
      for (const r of all) {
        const p = r.property_id ? propById[r.property_id] : null;
        const e = p?.estate_id ? estateById[p.estate_id] : null;
        // 依退房日回查任期 —— 跟 manager_stats（SQL 端）同一條規則,
        // 兩邊不一致的話「總表 12 則、明細 9 列」而沒有人查得出差在哪
        const mgr = mgrOf(r) || '未指派';
        (byMgr.get(mgr) ?? byMgr.set(mgr, []).get(mgr)!).push({
          manager: mgr,
          // 房客姓名。管家是分頁名,不用再開一欄
          guest: r.guest_name ?? '',
          estate: e?.name ?? '',
          // 房源對不到時退回爬蟲原始的房源名稱 —— 留空的話那一列看起來像壞掉
          property: p?.name ?? r.listing_name_raw ?? '',
          rating: Number(r.overall_rating) || 0,
          comment: displayComment(r) ?? '',
          checkout: r.checkout_date,
        });
      }

      const wb = XLSX.utils.book_new();
      const used = new Set<string>();

      // ── 總表 ──────────────────────────────────
      const sumRows = summarySheet(sorted, dateFrom, dateTo);
      const ws0 = XLSX.utils.aoa_to_sheet(sumRows);
      ws0['!cols'] = [{ wch: 10 }, { wch: 10 },
        ...Array.from({ length: 10 }, () => ({ wch: 9 })), { wch: 11 }];
      ws0['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 12 } }];
      ws0['!freeze'] = { xSplit: 0, ySplit: 3 };
      ws0['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 24 }];   // 標題高一點、表頭高一點
      /*
        平均評價固定兩位小數。
        4.80 存進去是數字 4.8、5.00 是 5，Excel 預設照數值本身顯示，
        於是同一欄出現「4.8 / 5 / 5 / 4.92」—— 小數點沒對齊，也看不出是評分。
        數值要維持數字型別（才排得了序、算得了平均），所以改的是**顯示格式**。
      */
      const hasTotal = sorted.length > 1;
      const sumLast = sumRows.length - 1;
      for (let r = 3; r <= sumLast; r++) {
        const c = ws0[cellRef(r, 1)];
        if (c && c.t === 'n') c.z = '0.00';
      }
      styleSheet(ws0, {
        headerRow: 2, lastRow: sumLast, cols: SUMMARY_HEADER.length,
        totalRow: hasTotal ? sumLast : -1,
      });
      XLSX.utils.book_append_sheet(wb, ws0, safeSheetName('總表', used));

      // ── 每位管家一頁 ──────────────────────────
      for (const m of sorted) {
        const rows = detailSheet(m.manager, byMgr.get(m.manager) ?? [], dateFrom, dateTo);
        const ws = XLSX.utils.aoa_to_sheet(rows);
        // 留言那欄放寬 —— 不然一則長評會把整列撐到看不完
        ws['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 7 }, { wch: 80 }];
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
        ws['!freeze'] = { xSplit: 0, ySplit: 3 };
        ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 24 }];
        styleSheet(ws, { headerRow: 2, lastRow: rows.length - 1, cols: DETAIL_HEADER.length });
        XLSX.utils.book_append_sheet(wb, ws, safeSheetName(m.manager, used));
      }

      XLSX.writeFile(wb, xlsxFilename(dateFrom, dateTo));
    } finally { setExportingMgr(false); }
  }

  function drillTo(estate: string) {
    setEstateId(estate);
    setPropertyId('');
    /* ★ 原本這裡把統計區間複製到篩選 —— 現在是同一組,不用複製了 */
    setTimeout(() => document.getElementById('review-filters')?.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {/* ===== Dashboard ===== */}
      <div className="mb-6">
        {/*
          ★★ 標題列只放標題（2026-08-28 使用者:「右上角都不用有字」）。

            日期控制項在下面的篩選列,而**現在在看哪一段**寫在左邊那張
            深藍色總覽卡裡（「1,594 筆・區間」那一行）—— 跟數字擺在一起,
            比擺在標題旁邊更接近它在說明的東西。

          ★ 標題列擠著一行灰字,眼睛得先讀完才知道那不是可以點的東西。
        */}
        <div className="mb-3">
          <h1>評價</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
          {/* 總覽 + 星等分布 */}
          <div onClick={() => drillTo('')} title="點擊查看全部評價" className="rounded-xl surf-deep is-clickable text-white p-5 flex flex-col cursor-pointer transition">
            <div className="flex items-center justify-between">
              {/* 「所有」現在是名副其實的 —— migration_130 之前它其實不含停用物業 */}
              <span className="text-xs opacity-75">所有平均評價</span>
              <span className="text-xs opacity-75">{overall.cnt.toLocaleString()} 筆</span>
            </div>
            {/*
              ★ 現在在看哪一段,跟數字擺在一起（2026-08-28）。
                原本在標題列旁邊 —— 那裡離它在說明的東西太遠,
                而且擠著一行灰字會讓人先讀完才知道那不是可以點的。

              ★ 沒設區間時寫「全部期間」,不留白:留白跟「載入中」長得一樣。
            */}
            <div className="text-[11px] opacity-60 mt-0.5">
              退房日 {dateFrom || dateTo ? `${dateFrom || '起始'} ~ ${dateTo || '今'}` : '全部期間'}
            </div>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="text-4xl font-bold tracking-tight">{overall.cnt ? overall.avg.toFixed(2) : '—'}</span>
              {/* ★ 跟 5 星那條 bar 同一個黃 —— 兩個都在講「滿分」，不該是兩種黃 */}
              <span className="text-xl" style={{ color: STAR_BAR_DARK[0] }}>★</span>
            </div>
            <div className="mt-4 space-y-1.5">
              {overallDist.rows.map(([label, n]) => (
                <div key={label} onClick={(e) => { e.stopPropagation(); setListModal({ title: `${label}評價`, propIds: null, rating: parseInt(label) }); }}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:opacity-80" title={`點擊查看${label}評價`}>
                  <span className="w-8 opacity-75">{label}</span>
                  {/*
                    ★★ 軌道是**壓黑**不是提白（lib/star-bar.ts）。
                      舊版 bg-white/15 把軌道推得跟 bar 一樣亮,
                      五條有五條不到 3:1 —— 而畫面只是有點糊,不會報錯。
                  */}
                  <div className="flex-1 h-2 rounded-full overflow-hidden"
                    style={{ background: STAR_TRACK_DARK }}>
                    <div className="h-full" style={{
                      background: STAR_BAR_DARK[overallDist.rows.findIndex(([l]) => l === label)],
                      width: overallDist.total ? `${Math.max((n / overallDist.total) * 100, n ? 1.5 : 0)}%` : '0%',
                    }} />
                  </div>
                  <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right opacity-75">{n.toLocaleString()} ({overallDist.total ? Math.round((n / overallDist.total) * 100) : 0}%)</span>
                </div>
              ))}
            </div>
          </div>

          {/* 物業評分 */}
          <div className="rounded-xl bg-white border border-mor-line flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-white/45">物業評分</div>
            <div className="flex-1">
              {[...stats].filter((x) => Number(x.review_count) > 0).sort((a, b) => Number(a.sort) - Number(b.sort)).map((x, _, arr) => {
                const max = Math.max(...arr.map((y) => Number(y.review_count))) || 1;
                return (
                  <div key={x.estate_id} onClick={() => setListModal({ title: `物業「${x.estate_name}」的評價`, propIds: properties.filter((pp) => pp.estate_id === x.estate_id).map((pp) => pp.id), rating: null })} title="點擊查看該物業評價"
                    className="px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/50">
                    <span className={`w-14 truncate font-medium ${x.active === false ? 'text-gray-400' : ''}`}
                      title={x.active === false ? `${x.estate_name}（已停用）` : x.estate_name}>
                      {x.estate_name}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden">
                      <div className="h-full bg-mor-blue" style={{ width: `${(Number(x.review_count) / max) * 100}%` }} />
                    </div>
                    <span className={`min-w-[4rem] shrink-0 whitespace-nowrap text-right font-semibold ${Number(x.avg_rating) < 4.5 ? 'text-orange-600' : 'text-mor-ink'}`}>
                      {Number(x.avg_rating).toFixed(2)} ★
                    </span>
                    <span className="w-14 shrink-0 whitespace-nowrap text-right text-xs text-gray-400">{Number(x.review_count).toLocaleString()} 筆</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 管家評分 */}
          <div className="rounded-xl bg-white border border-mor-line flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-mor-line bg-white/45">
              <span className="text-sm font-semibold">管家評分</span>
              <button onClick={exportMgrXlsx} disabled={exportingMgr}
                className={`rounded-lg px-2.5 py-0.5 text-xs disabled:opacity-40 ${EXPORT_TONE}`}>
                {exportingMgr ? '產生中…' : '⬇ Excel'}
              </button>
            </div>
            <div className="flex-1">
              {[...mgrStats].sort((a, b) => mgrOrder(a.manager) - mgrOrder(b.manager)).map((m, _, arr) => {
                const max = Math.max(...arr.map((y) => Number(y.total))) || 1;
                return (
                  <button key={m.manager} onClick={() => setMgrOpen(m)}
                    className="w-full px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 hover:bg-mor-bluelight/40 text-left">
                    <span className="w-14 truncate font-medium">{m.manager}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden">
                      <div className="h-full bg-mor-green" style={{ width: `${(Number(m.total) / max) * 100}%` }} />
                    </div>
                    <span className={`min-w-[4rem] shrink-0 whitespace-nowrap text-right font-semibold ${Number(m.avg_rating) < 4.5 ? 'text-orange-600' : 'text-mor-ink'}`}>
                      {Number(m.avg_rating).toFixed(2)} ★
                    </span>
                    <span className="min-w-[4rem] shrink-0 whitespace-nowrap text-right text-xs text-gray-400">{Number(m.total).toLocaleString()} 筆 ›</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 表格篩選 ===== */}
      <FilterToggle />
      <div id="review-filters" className="filter-bar collapsible-filters rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estateId} onChange={(e) => setEstateId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-28">
            <option value="">全部物業</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">房源</label>
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-36">
            <option value="">全部房源</option>
            {visibleProps.map((p) => (
              <option key={p.id} value={p.id}>{p.active ? '' : '〔停用〕'}{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">評分</label>
          <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>
            <option value="5">5 星</option>
            <option value="4">4 星</option>
            <option value="low">3 星以下(需關注)</option>
          </select>
        </div>
        {/* ★ 退房日期搬到最上面了 —— 它同時決定統計與清單,不再是「篩選之一」 */}
        <div>
          {/*
            ★ 標籤寫「退房日期」而不是「日期」—— 評價本身沒有日期,
              是按房客退房的那一天歸期的。不寫清楚的話會被當成評論日期。
          */}
          <label className="block text-xs text-gray-500 mb-1">退房日期</label>
          <RangeInput from={dateFrom} to={dateTo}
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(旅客/留言/房源)</label>
          <div className="flex gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="含舊物業" className="rounded-lg border border-gray-300 px-2 py-1.5 w-32" />
            <button onClick={() => setKw(kwInput.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(estateId || propertyId || dateFrom || dateTo || ratingFilter) && (
          <button onClick={() => { setEstateId(''); setPropertyId(''); setDateFrom(''); setDateTo(''); setRatingFilter(''); }}
            className="text-gray-500 underline pb-1.5">清除篩選</button>
        )}
        <div className="ml-auto flex items-end gap-3">
          {/*
            ★ 只有能隱藏的人看得到這個開關 —— 其他人打開也做不了事,
              而且會以為系統少了幾則評價。
            ★ 打開時是「**只看**隱藏的」不是「全部一起看」:
              混在一起的話那幾則會夾在幾百列中間,
              而打開這個開關的目的就是要找它們。
          */}
          {canHide && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600 pb-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)} />
              只看已隱藏
            </label>
          )}
          <div className="text-xs text-gray-400 pb-1.5">共 {total.toLocaleString()} 筆</div>
          <button onClick={exportCsv} disabled={exporting || total === 0}
            className={`rounded-lg px-4 py-1.5 font-medium disabled:opacity-40 ${EXPORT_TONE}`}>
            {exporting ? '匯出中…' : '⬇ 下載 Excel'}
          </button>
        </div>
      </div>

      {/* ===== 表格 ===== */}
      {/*
        ══════════ 手機卡片（2026-08-22）══════════

        七欄的表在 390px 只能橫向滑（docs/UI體檢-2026-08-19.md 的 P0）。

        ★ 這一頁**今天真的踩到過** —— 使用者在手機上看，
          第一個反應是「讀不出來」。那次的根因是載入時序，
          但「會用手機看這一頁」這件事已經被證實了。

        ★ 卡片以**留言**為主體 —— 那是這一頁真正要讀的東西。
          日期、房源、負責人縮成第二行。
        ★ 需關注的紅點與星等放在同一行，一眼掃得到。
      */}
      <div className="md:hidden space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-xl glass px-6 py-10 text-center text-gray-400">沒有符合條件的評價。</div>
        ) : rows.map((r) => {
          const p = r.property_id ? propById[r.property_id] : null;
          const e = p?.estate_id ? estateById[p.estate_id] : null;
          return (
            <div key={`m-${r.id}`} onClick={() => setSelected(r)}
              className="rounded-xl glass px-3 py-2.5 cursor-pointer active:bg-mor-sand/40">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {hasNegative(r) && (
                    <span className="shrink-0 w-2 h-2 rounded-full bg-red-500" title="需關注" />
                  )}
                  <span className="shrink-0 rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs font-medium">
                    {p?.name ?? (mastersLoaded ? '未對應' : '⋯')}
                  </span>
                  <span className="truncate text-sm">{r.guest_name}</span>
                </div>
                {/* ★ 色碼要放 style。放進 className 會變成沒人認得的 class,而且不報錯 */}
                <span className="shrink-0 text-xs font-medium"
                  style={{ color: r.overall_rating >= 5 ? undefined : starTextColor(r.overall_rating) }}>
                  {r.overall_rating} 星
                </span>
              </div>
              <div className="text-sm text-gray-700 mt-1.5 line-clamp-3">
                {displayComment(r) ?? <span className="text-gray-300">（無留言）</span>}
              </div>
              <div className="text-[11px] text-gray-400 mt-1">
                {r.checkin_date ?? '—'} ~ {r.checkout_date ?? '—'}
                {e?.name && !(p?.name ?? '').includes(e.name) ? `・${e.name}` : ''}
                {mgrOf(r) ? `・${mgrOf(r)}` : ''}
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden md:block rounded-xl glass overflow-x-auto">
        {/*
          物業載不到要講出來。

          不講的話畫面只是每一列的物業都空著 —— 而那看起來就是
          「這些評價沒有物業」,人會去查爬蟲或資料庫，
          問題其實在這一支查詢失敗了（手機訊號不穩時真的會）。
        */}
        {estatesErr && (
          <div className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            ⚠ 物業名稱載入失敗，下面的物業欄會是空的（房源與評價本身沒問題）。
            重新整理通常就好了。<span className="text-amber-600">（{estatesErr}）</span>
          </div>
        )}
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
              <th className="px-3 py-2.5 whitespace-nowrap">入住日</th>
              <th className="px-3 py-2.5 whitespace-nowrap">退房日</th>
              {/*
                物業與房源併成一欄（2026-08-19 使用者指定）。

                分成兩欄的問題是它們**永遠一起看** —— 沒有人只看物業不看房源,
                而兩欄各佔一個標題、各一個色塊，在手機上把後面的旅客與評分擠出畫面。

                併之後房源當主體、物業縮成小字（跟帳戶明細的「交易帳號」同一個作法）:
                真正要認的是 3A3、A13 那些房號，物業是它的歸屬。
              */}
              <th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">旅客</th>
              <th className="px-3 py-2.5">負責人</th>
              <th className="px-3 py-2.5 whitespace-nowrap">總評</th>
              <th className="px-3 py-2.5">留言</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">沒有符合條件的評價</td></tr>
            ) : rows.map((r) => {
              const p = r.property_id ? propById[r.property_id] : null;
              const e = p?.estate_id ? estateById[p.estate_id] : null;
              return (
                <tr key={r.id} onClick={() => setSelected(r)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer align-top">
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{r.checkin_date ?? '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{r.checkout_date ?? '—'}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="inline-block rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs font-medium">
                      {p?.name ?? (mastersLoaded ? '未對應' : '⋯')}
                    </span>
                    {/*
                      物業縮成第二行小字。房源名稱本身常常就含物業（開封4F），
                      那種時候重複兩次是雜訊 —— 所以名稱裡已經有的就不再印一次。
                    */}
                    {e?.name && !(p?.name ?? '').includes(e.name) && (
                      <div className="mt-0.5 text-[11px] text-gray-400">{e.name}</div>
                    )}
                    {!e?.name && !mastersLoaded && (
                      <div className="mt-0.5 text-[11px] text-gray-300">⋯</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{r.guest_name}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{mgrOf(r) || (mastersLoaded ? '—' : '⋯')}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {hasNegative(r) && <span className="mr-1 inline-block w-2 h-2 rounded-full bg-red-500" title="需關注" />}
                    <Stars n={r.overall_rating} />
                    <span className="ml-1 text-xs font-medium"
                      style={{ color: r.overall_rating >= 5 ? undefined : starTextColor(r.overall_rating) }}>{r.overall_rating} 星</span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600 min-w-64">
                    <div className="line-clamp-2">{displayComment(r) ?? <span className="text-gray-300">（無留言）</span>}</div>
                    {/* ★ 理由印出來 —— 「誰藏的」查得到但「為什麼」看不到的話,沒有人敢放回去 */}
                    {isHidden(r) && (
                      <div className="mt-1 text-[11px] text-gray-400">
                        已隱藏{r.hidden_reason ? `・${r.hidden_reason}` : ''}
                        {canHide && (
                          <button
                            onClick={(ev) => { ev.stopPropagation();
                              if (confirm('把這則評價放回清單?\n\n它會重新算進平均星等與管家排行。')) {
                                doHide(r, null).then((ok) => { if (ok) load(); });
                              }}}
                            className="ml-2 text-mor-blue underline">還原</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-500">
          <div>第 {page + 1} / {pages} 頁</div>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}
              className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">上一頁</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}
              className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">下一頁</button>
          </div>
        </div>
      </div>

      {listModal && (
        <ListModal cfg={listModal} onClose={() => setListModal(null)}
          dateFrom={dateFrom} dateTo={dateTo}
          propById={propById} estateById={estateById}
          onSelectReview={(r) => setSelected(r)} />
      )}
      {mgrOpen && (
        <MgrModal m={mgrOpen} onClose={() => setMgrOpen(null)}
          estates={estates} properties={properties}
          dateFrom={dateFrom} dateTo={dateTo}
          propById={propById} estateById={estateById}
          onSelectReview={(r) => setSelected(r)} />
      )}
      {selected && (
        <Drawer review={selected} onClose={() => setSelected(null)}
          property={selected.property_id ? propById[selected.property_id] : null}
          estate={selected.property_id && propById[selected.property_id]?.estate_id ? estateById[propById[selected.property_id].estate_id!] : null}
          manager={mgrOf(selected)}
          canHide={canHide}
          onHide={() => { setHiding(selected); setHideReason(HIDE_REASONS[0]); setHideOther(''); setSelected(null); }}
          onRestore={() => {
            if (!confirm('把這則評價放回清單?\n\n它會重新算進平均星等與管家排行。')) return;
            doHide(selected, null).then((ok) => { if (ok) { setSelected(null); load(); } });
          }} />
      )}

      {/*
        ══════════ 隱藏評價 ══════════

        ★★ 這是一個**填理由**的視窗,不是一句 confirm。

          confirm 問不到理由,而理由是這個功能最重要的欄位:
          三個月後看到一則被藏起來的四星評價,
          「誰藏的」查得到但「為什麼」查不到的話,沒有人敢把它放回去 ——
          於是它永遠留在那裡,而那一棟的平均星等永遠比實際高一點點。
      */}
      {hiding && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
          onClick={() => setHiding(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3 text-sm"
            onClick={(e) => e.stopPropagation()}>
            <div className="font-bold">隱藏這則評價</div>
            <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
              {hiding.guest_name}・{hiding.overall_rating} 星・{hiding.checkout_date ?? '—'}
            </div>

            {/*
              ★ 說出**影響了哪一棟的平均** —— 不講的話使用者只知道「這則不見了」,
                下個月看到那一棟平均漲了 0.1 會找不到原因。
            */}
            <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs">
              {hideImpactText(hiding.overall_rating,
                hiding.property_id && propById[hiding.property_id]?.estate_id
                  ? estateById[propById[hiding.property_id].estate_id!]?.name : null)}
              <div className="mt-1">
                評價不會被刪掉 —— 爬蟲下次同步還是會帶到它,只是不再顯示也不列入統計。隨時可以還原。
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">原因<span className="text-red-500 ml-0.5">*</span></span>
              <select value={hideReason} onChange={(e) => setHideReason(e.target.value)}
                className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5">
                {HIDE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            {hideReason === '其他' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">說明<span className="text-red-500 ml-0.5">*</span></span>
                <input value={hideOther} onChange={(e) => setHideOther(e.target.value)}
                  placeholder="寫給三個月後的自己看"
                  className="h-11 md:h-auto bg-white rounded-lg border border-mor-line px-2 md:py-1.5" />
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setHiding(null)}
                className="rounded-lg border border-gray-300 px-4 py-1.5">取消</button>
              <button disabled={hideBusy}
                onClick={() => {
                  const err = hideError(hideReason, hideOther);
                  if (err) { alert(err); return; }
                  doHide(hiding, hideReasonText(hideReason, hideOther))
                    .then((ok) => { if (ok) { setHiding(null); load(); } });
                }}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium disabled:opacity-40">
                {hideBusy ? '處理中…' : '確認隱藏'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Drawer({ review: r, onClose, property, estate, manager, canHide, onHide, onRestore }: {
  review: Review; onClose: () => void; property: Property | null; estate: Estate | null;
  canHide: boolean; onHide: () => void; onRestore: () => void;
  /**
   * 這一則該算誰的 —— 由外面依**退房日**查任期算好再傳進來。
   * 不在這裡讀 estate.manager：那一欄沒有時間,顯示的會是「現在是誰」
   * 而不是「那次入住是誰在管」。
   */
  manager: string;
}) {
  const cats: [string, number | null][] = [
    ['CHECKIN', r.rating_checkin], ['CLEANLINESS', r.rating_cleanliness], ['ACCURACY', r.rating_accuracy],
    ['COMMUNICATION', r.rating_communication], ['LOCATION', r.rating_location], ['VALUE', r.rating_value],
  ];
  const tags = r.detail_comments?.tags ?? {};
  const privateFb = r.detail_comments?.private_feedback;
  const shown = displayComment(r);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="font-bold">{r.guest_name} 的評價</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {estate?.name ?? '—'}・{property?.name ?? '未對應'}・{r.checkin_date} ~ {r.checkout_date}
              {r.nights ? `・${r.nights} 晚` : ''}
              {manager ? `・負責人 ${manager}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-6 text-sm">
          <div><Stars n={r.overall_rating} /> <span className="ml-1 font-semibold">{r.overall_rating}</span></div>
          <div>
            <div className="text-xs text-gray-500 mb-1.5 font-medium">留言</div>
            <p className="whitespace-pre-wrap leading-relaxed">{shown ?? '（無）'}</p>
            {r.comment_original && r.comment_original !== shown && (
              <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
                <div className="text-xs text-gray-400 mb-1">原文({r.comment_language})</div>
                <p className="whitespace-pre-wrap text-gray-600">{r.comment_original}</p>
              </div>
            )}
            {r.comment && r.comment !== shown && (
              <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 p-3">
                <div className="text-xs text-gray-400 mb-1">翻譯</div>
                <p className="whitespace-pre-wrap text-gray-600">{r.comment}</p>
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-2 font-medium">細節評分</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {cats.map(([cat, v]) => (
                <div key={cat} className="flex items-center justify-between">
                  <span className="text-gray-600">{CAT_LABEL[cat]}</span>
                  <span className={`font-semibold ${v && v <= 3 ? 'text-red-600' : ''}`}>{v ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
          {Object.keys(tags).length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-2 font-medium">分項回饋</div>
              <div className="space-y-2">
                {Object.entries(tags).map(([cat, arr]) => (
                  <div key={cat}>
                    <span className="text-xs text-gray-400 mr-2">{CAT_LABEL[cat] ?? cat}</span>
                    {(arr as any[]).map((t, i) => (
                      <span key={i} className={`inline-block rounded-full px-2.5 py-0.5 text-xs mr-1 mb-1 ${
                        t.intent === 'NEGATIVE' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      }`}>
                        {t.label}{t.comment ? `:${t.comment}` : ''}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {privateFb && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
              <div className="text-xs text-amber-700 mb-1 font-medium">私下回饋(僅房東可見)</div>
              <p className="whitespace-pre-wrap text-amber-900">{privateFb}</p>
            </div>
          )}
          {r.host_reply && (
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
              <div className="text-xs text-gray-500 mb-1 font-medium">房東回覆</div>
              <p className="whitespace-pre-wrap text-gray-700">{r.host_reply}</p>
            </div>
          )}
          {r.source_url && (
            <a href={r.source_url} target="_blank" rel="noreferrer" className="inline-block text-xs text-gray-400 underline">
              在 Airbnb 後台查看
            </a>
          )}

          {/*
            ★ 按鈕上的字是「隱藏」不是「刪除」。

              評價是爬蟲 upsert 進來的,真的刪掉明天就回來了。
              寫「刪除」的話使用者對它的期待是「不見了」,而它其實還在 ——
              然後他會再刪一次,再一次,以為系統壞了。
          */}
          {canHide && (
            <div className="border-t border-mor-line pt-4">
              {isHidden(r) ? (
                <div className="space-y-2">
                  <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                    這則已隱藏{r.hidden_reason ? `・${r.hidden_reason}` : ''}
                    {r.hidden_at ? `・${r.hidden_at.slice(0, 10)}` : ''}
                    <div className="mt-1 text-gray-400">不列入平均星等與管家排行。</div>
                  </div>
                  <button onClick={onRestore}
                    className="h-11 w-full rounded-lg border border-mor-slate text-mor-slate font-medium">
                    還原到清單
                  </button>
                </div>
              ) : (
                <button onClick={onHide}
                  className="h-11 w-full rounded-lg border border-red-300 text-red-600 font-medium">
                  隱藏這則評價
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function MgrModal({ m, onClose, estates, properties, dateFrom, dateTo, propById, estateById, onSelectReview }: {
  m: MgrStat; onClose: () => void;
  estates: Estate[]; properties: Property[];
  dateFrom: string; dateTo: string;
  propById: Record<string, Property>; estateById: Record<string, Estate>;
  onSelectReview: (r: Review) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [list, setList] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const estateIds = estates
      .filter((e) => (m.manager === '未指派' ? !e.manager : e.manager === m.manager))
      .map((e) => e.id);
    const propIds = properties.filter((p) => p.estate_id && estateIds.includes(p.estate_id)).map((p) => p.id);
    /*
     * ⚠️ 這是**統計**用的查詢，撈不全會直接讓平均星等算錯。
     *
     * 原本寫死 .limit(500) 且是按退房日新到舊排序 —— 區間一拉大就只算到
     * 最近 500 則，平均分被最近的評價主導，而且**數字看起來完全正常**。
     * 統計的查詢尤其不能截斷：少幾列不會少一個項目，只會讓每一個數字都偏。
     */
    fetchAll<any>((f, t) => {
      let q = supabase.from('reviews').select('*')
        .in('property_id', propIds.length ? propIds : ['00000000-0000-0000-0000-000000000000'])
        .is('hidden_at', null)   // 統計用,要跟 RPC 一致
        .order('checkout_date', { ascending: false, nullsFirst: false });
      if (dateFrom) q = q.gte('checkout_date', dateFrom);
      if (dateTo) q = q.lte('checkout_date', dateTo);
      return q.range(f, t);
    }).then(({ rows }) => { setList(rows); setLoading(false); });
  }, [supabase, m, estates, properties, dateFrom, dateTo]);

  const total = Number(m.total);
  const dist: [string, number, string][] = [
    ['5 星', Number(m.s5), STAR_BAR_LIGHT[0]],
    ['4 星', Number(m.s4), STAR_BAR_LIGHT[1]],
    ['3 星', Number(m.s3), STAR_BAR_LIGHT[2]],
    ['2 星', Number(m.s2), STAR_BAR_LIGHT[3]],
    ['1 星', Number(m.s1), STAR_BAR_LIGHT[4]],
  ];

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-mor-line flex items-center justify-between">
          <div>
            <div className="font-bold">管家「{m.manager}」的評價</div>
            <div className="text-xs text-gray-500 mt-0.5">
              平均 {Number(m.avg_rating).toFixed(2)} ★・{total.toLocaleString()} 筆
              {(dateFrom || dateTo) && `・${dateFrom || '…'} ~ ${dateTo || '…'}`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-4 border-b border-mor-line space-y-1.5">
          {dist.map(([label, n, color]) => (
            <div key={label} className="flex items-center gap-3 text-xs">
              <span className="w-8 text-gray-500">{label}</span>
              <div className="flex-1 h-3 rounded-full overflow-hidden"
                style={{ background: STAR_TRACK_LIGHT }}>
                <div className="h-full" style={{
                  background: color,
                  width: total ? `${(n / total) * 100}%` : '0%',
                }} />
              </div>
              <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right text-gray-600">{n} ({total ? Math.round((n / total) * 100) : 0}%)</span>
            </div>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center text-gray-400 text-sm">載入中…</div>
          ) : list.map((r) => {
            const p = r.property_id ? propById[r.property_id] : null;
            const e = p?.estate_id ? estateById[p.estate_id] : null;
            return (
              <button key={r.id} onClick={() => onSelectReview(r)}
                className="w-full text-left px-6 py-3 border-b border-mor-line/60 hover:bg-mor-bluelight/40">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.guest_name}</span>
                    <span className="text-xs text-gray-400">{e?.name}・{p?.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stars n={r.overall_rating} />
                    <span className="text-xs text-gray-400">{r.checkout_date}</span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1 line-clamp-1">{displayComment(r)}</div>
              </button>
            );
          })}
          {!loading && list.length >= 500 && (
            <div className="py-3 text-center text-xs text-gray-400">僅顯示最近 500 筆,可縮小統計區間查看更早的評價</div>
          )}
        </div>
      </div>
    </div>
  );
}


function ListModal({ cfg, onClose, dateFrom, dateTo, propById, estateById, onSelectReview }: {
  cfg: { title: string; propIds: string[] | null; rating: number | null };
  onClose: () => void; dateFrom: string; dateTo: string;
  propById: Record<string, Property>; estateById: Record<string, Estate>;
  onSelectReview: (r: Review) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [list, setList] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 這一份也拿掉寫死的 1000 —— 同一頁兩個地方各有自己的上限，
    // 一邊改了另一邊沒改，兩個清單就會對不起來而且沒人說得出為什麼。
    fetchAll<any>((f, t) => {
      let q = supabase.from('reviews').select('*')
        .is('hidden_at', null)   // 統計用,要跟 RPC 一致
        .order('checkout_date', { ascending: false, nullsFirst: false });
      if (cfg.propIds) q = q.in('property_id', cfg.propIds.length ? cfg.propIds : ['00000000-0000-0000-0000-000000000000']);
      if (cfg.rating === 5) q = q.gte('overall_rating', 5);
      else if (cfg.rating != null) q = q.gte('overall_rating', cfg.rating).lt('overall_rating', cfg.rating + 1);
      if (dateFrom) q = q.gte('checkout_date', dateFrom);
      if (dateTo) q = q.lte('checkout_date', dateTo);
      return q.range(f, t);
    }).then(({ rows }) => { setList(rows); setLoading(false); });
  }, [supabase, cfg, dateFrom, dateTo]);

  const dist = useMemo(() => {
    const t = [0, 0, 0, 0, 0]; // index 0=5星 … 4=1星
    for (const r of list) {
      const v = r.overall_rating >= 5 ? 0 : r.overall_rating >= 4 ? 1 : r.overall_rating >= 3 ? 2 : r.overall_rating >= 2 ? 3 : 4;
      t[v]++;
    }
    return t;
  }, [list]);
  const total = list.length;
  const avg = total ? list.reduce((a, r) => a + Number(r.overall_rating), 0) / total : 0;
  const BAR = STAR_BAR_LIGHT;   // 白底 —— 深色卡那組印在白紙上是看不見的
  const LABEL = ['5 星', '4 星', '3 星', '2 星', '1 星'];

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-mor-line flex items-center justify-between">
          <div>
            <div className="font-bold">{cfg.title}</div>
            <div className="text-xs text-gray-500 mt-0.5">
              平均 {avg.toFixed(2)} ★・{total.toLocaleString()} 筆
              {(dateFrom || dateTo) && `・${dateFrom || '…'} ~ ${dateTo || '…'}`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        {cfg.rating == null && (
          <div className="px-6 py-4 border-b border-mor-line space-y-1.5">
            {LABEL.map((label, i) => (
              <div key={label} className="flex items-center gap-3 text-xs">
                <span className="w-8 text-gray-500">{label}</span>
                <div className="flex-1 h-3 rounded-full overflow-hidden"
                  style={{ background: STAR_TRACK_LIGHT }}>
                  <div className="h-full" style={{
                    background: BAR[i],
                    width: total ? `${(dist[i] / total) * 100}%` : '0%',
                  }} />
                </div>
                <span className="min-w-[5rem] shrink-0 whitespace-nowrap text-right text-gray-600">{dist[i]} ({total ? Math.round((dist[i] / total) * 100) : 0}%)</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center text-gray-400 text-sm">載入中…</div>
          ) : list.map((r) => {
            const p = r.property_id ? propById[r.property_id] : null;
            const e = p?.estate_id ? estateById[p.estate_id] : null;
            return (
              <button key={r.id} onClick={() => onSelectReview(r)}
                className="w-full text-left px-6 py-3 border-b border-mor-line/60 hover:bg-mor-bluelight/40">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.guest_name}</span>
                    <span className="text-xs text-gray-400">{e?.name}・{p?.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stars n={r.overall_rating} />
                    <span className="text-xs text-gray-400">{r.checkout_date}</span>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1 line-clamp-1">{displayComment(r)}</div>
              </button>
            );
          })}
          {!loading && list.length >= 1000 && (
            <div className="py-3 text-center text-xs text-gray-400">僅顯示最近 1,000 筆,可用統計區間縮小範圍</div>
          )}
        </div>
      </div>
    </div>
  );
}
