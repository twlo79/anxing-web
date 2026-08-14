'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddButton, ExportButton, ActionBar } from '@/components/Actions';
import { AuditButton, AuditBadges, AuditSummary } from '@/components/Audit';
import { auditOrders, type AuditOrder } from '@/lib/audit-orders';
import FilterToggle from '@/components/FilterToggle';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, roomKey, type SortState, type SortCols } from '@/lib/sortable';
import {
  isOffice, isCompany, inEstateBlock, estateOf, guestOf, roomOf,
  itemLabel, oneoffItems, oneoffLabel, skeleton, reconcile, SHORT_SOURCES, ROOM_NONE, ONEOFF_LABEL,
} from '@/lib/revenue-report';

type Row = {
  /** 這一列的 id（認列列，不是訂單）—— 一筆訂單跨三個月就有三列 */
  order_id: string;
  /**
   * 真正的訂單 id。
   *
   * 【為什麼要另外帶】
   * 防呆檢查是以「訂單」為單位的。用認列列去檢查的話，
   * 一筆跨三個月的訂單會變成三列相同房源、相同起訖的資料 ——
   * 期間重疊的檢查會抓到它跟自己重疊，每一筆長租都會被標紅。
   */
  oid: string | null;
  source: string; estate_id: string | null; estate_name: string | null;
  property_raw: string | null; guest_name: string | null; checkin: string; checkout: string;
  period_start: string | null; period_end: string | null; fee_type?: string | null;
  /** 一次性收入的項目(洗衣機/垃圾代收費…)。會計科目底下再細一層。 */
  item_name?: string | null;
  total_amount: number; total_nights: number; month_nights: number; month_amount: number;
};

const SOURCE_LABEL: Record<string, string> = {
  airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', longterm: '長租',
  office: '辦公室租金', company: '公司登記', oneoff: ONEOFF_LABEL, other: '其他',
  partner: '搭檔收款', airbnb_cancelled: 'Airbnb取消',
};
const SOURCE_COLOR: Record<string, string> = {
  airbnb: 'bg-mor-bluelight text-mor-slate', agoda: 'bg-purple-50 text-purple-700',
  private: 'bg-mor-greenlight text-mor-green', longterm: 'bg-amber-50 text-amber-700',
  office: 'bg-orange-50 text-orange-700', company: 'bg-gray-100 text-gray-600',
  oneoff: 'bg-rose-50 text-rose-600', other: 'bg-gray-100 text-gray-500',
  partner: 'bg-teal-50 text-teal-700', airbnb_cancelled: 'bg-red-50 text-red-600',
};
const SOURCE_ORDER = ['airbnb', 'agoda', 'private', 'longterm', 'office', 'company', 'oneoff', 'other'];

// 表頭排序:key 對應欄位型別與取值。
// 「認列起訖」沿用原本 period_start 缺值時退回 checkin 的邏輯,避免舊資料被當成空值排到最後。
const SORT_COLS: SortCols<Row> = {
  source: { type: 'text', get: (r) => SOURCE_LABEL[r.source] ?? r.source },
  estate_name: { type: 'text', get: (r) => r.estate_name },
  property_raw: { type: 'room', get: (r) => r.property_raw },
  guest_name: { type: 'text', get: (r) => r.guest_name },
  checkin: { type: 'date', get: (r) => r.checkin },
  period_start: { type: 'date', get: (r) => r.period_start || r.checkin || '' },
  total_amount: { type: 'number', get: (r) => r.total_amount },
  month_nights: { type: 'number', get: (r) => r.month_nights },
  month_amount: { type: 'number', get: (r) => r.month_amount },
};

const fmt = (n: number) => Math.round(n).toLocaleString();
const minus1 = (d: string) => { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); };
function monthsInRange(from: string, to: string) {
  const [fy, fm] = (from || '').split('-').map(Number);
  const [ty, tm] = (to || '').split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return [];
  const out: [number, number][] = [];
  let y = fy, m = fm, guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard < 600) { out.push([y, m]); m++; if (m > 12) { m = 1; y++; } guard++; }
  return out;
}
function csvEsc(v: unknown) { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default function RevenuesPage() {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastYm = `${lastM.getFullYear()}-${String(lastM.getMonth() + 1).padStart(2, '0')}`;
  const [fromM, setFromM] = useState(lastYm);
  const [toM, setToM] = useState(lastYm);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [estateFilter, setEstateFilter] = useState('');
  const [roomFilter, setRoomFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'period_start', dir: 'desc' });
  const [contracts, setContracts] = useState<{ estate: string; room: string; start: string; end: string }[]>([]);
  useEffect(() => { (async () => {
    const { data } = await supabase.from('contracts').select('room, start_date, end_date, estates(name)');
    setContracts(((data as any[]) ?? []).map((c) => ({ estate: (c.estates as any)?.name ?? '', room: c.room ?? '', start: c.start_date, end: c.end_date })).filter((c) => c.room && c.start && c.end));
  })(); }, [supabase]);

  const fetchMonthRows = useCallback(async (y: number, m: number): Promise<Row[]> => {
    const ym = `${y}${String(m).padStart(2, '0')}`;
    const pstart = `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
    const pend = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10);
    /*
     * 全部月份改讀 recognitions(訂單引擎),不再分界讀快照。
     *
     * 【為什麼不是 .limit(3000)】
     * 原本寫死 3000。目前一個月約 143 筆,看起來很安全 ——
     * 但那是一道**無聲的懸崖**:哪天某個月破了 3000,營收表就會少一截,
     * 沒有錯誤訊息,只是數字變小。而「哪天」不會有人記得這個數字存在。
     *
     * 分頁撈完就沒有懸崖,不管一個月幾筆都對。
     */
    const { rows: data } = await fetchAll<any>((f, t) =>
      supabase.from('revenue_recognitions').select('*').eq('ym', ym).range(f, t));
    return (data ?? []).map((r) => ({
      order_id: r.id, oid: r.order_id ?? null, source: r.source, estate_id: r.estate_id, estate_name: r.estate_name,
      property_raw: r.property_raw, guest_name: r.guest_name, checkin: r.checkin, checkout: r.checkout,
      period_start: r.period_start ?? pstart, period_end: r.period_end ?? pend, fee_type: r.fee_type ?? null, item_name: r.item_name ?? null,
      total_amount: Number(r.total_amount ?? 0), total_nights: r.total_nights ?? 0,
      month_nights: r.month_nights ?? 0, month_amount: Number(r.month_amount),
    })).filter((r) => r.month_amount !== 0);
  }, [supabase]);

  /*
   * 防呆模式。按下去才檢查，按回去標記全部消失。
   *
   * 這一頁的資料本來就全部在前端（不是伺服器分頁），所以不用再抓一次。
   */
  const [audit, setAudit] = useState(false);
  /**
   * 房源名 → 它所有上層房源的名稱（開封2-1 → ['開封2F','開封整棟']）。
   *
   * 防呆要靠它抓「同一塊空間被賣了兩次」—— 那些是不同的房源名稱，
   * 一般的期間重疊看不出它們是同一塊空間。
   *
   * 只在防呆打開時才撈 —— 這一頁平常不需要房源資料。
   */
  const [roomAncestors, setRoomAncestors] = useState<Record<string, string[]>>({});
  const ancestorsLoaded = useRef(false);
  useEffect(() => {
    if (!audit || ancestorsLoaded.current) return;
    ancestorsLoaded.current = true;
    supabase.from('properties').select('id, name, parent_property_id').then(({ data }) => {
      const rows = data ?? [];
      const byId = new Map(rows.map((p) => [p.id, p]));
      const out: Record<string, string[]> = {};
      for (const p of rows) {
        const names: string[] = [];
        let cur = p.parent_property_id as string | null;
        // 上限 20 層是保險絲:資料成環時不要卡死畫面(資料庫也擋,這是第二道)
        for (let i = 0; cur && i < 20; i++) {
          const up = byId.get(cur);
          if (!up) break;
          names.push(up.name);
          cur = up.parent_property_id as string | null;
        }
        if (names.length) out[p.name] = names;
      }
      setRoomAncestors(out);
    });
  }, [audit, supabase]);
  const [onlyBad, setOnlyBad] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const months = monthsInRange(fromM, toM).slice(0, 24);
    const all: Row[] = [];
    for (const [y, m] of months) {
      const list = await fetchMonthRows(y, m);
      for (const r of list) all.push({ ...r, order_id: `${r.order_id}_${y}${m}` });
    }
    setRows(all);
    setLoading(false);
  }, [supabase, fromM, toM, fetchMonthRows]);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (estateFilter && (r.estate_name ?? '無') !== estateFilter) return false;
    // 房源篩選只作用在物業段。辦公室與公司登記不掛房源,選了房號就不該出現
    if (roomFilter && (isOffice(r) || isCompany(r) || (r.property_raw ?? '') !== roomFilter)) return false;
    if (sourceFilter && r.source !== sourceFilter) return false;
    if (kw) { const s = `${r.guest_name ?? ''}${r.property_raw ?? ''}${r.estate_name ?? ''}`; if (!s.includes(kw)) return false; }
    return true;
  }), [rows, estateFilter, roomFilter, sourceFilter, kw]);

  const total = useMemo(() => filtered.reduce((s, r) => s + Number(r.month_amount), 0), [filtered]);
  const sorted = useMemo(() => sortRows(filtered, sort, SORT_COLS), [filtered, sort]);
  const ROWS = 100;
  const [rowPage, setRowPage] = useState(0);
  useEffect(() => { setRowPage(0); }, [fromM, toM, estateFilter, roomFilter, sourceFilter, kw, sort]);
  // 換物業時清掉房源篩選 —— 否則會留著上一個物業的房號,結果一筆都篩不出來
  useEffect(() => { setRoomFilter(''); }, [estateFilter]);
  const rowPages = Math.max(1, Math.ceil(sorted.length / ROWS));
  const pageRows = sorted.slice(rowPage * ROWS, rowPage * ROWS + ROWS);

  /*
   * 防呆檢查。
   *
   * 【一定要先按訂單去重】
   * 這一頁一列 = 一個月的認列，一筆跨三個月的訂單就有三列。
   * 直接拿去檢查的話，那三列同房源、同起訖 —— 期間重疊會抓到它跟自己重疊，
   * 每一筆長租都會被標紅，而那會讓整個功能變成噪音。
   *
   * 金額用 total_amount（整筆訂單的金額）而不是 month_amount，
   * 房價才比得對 —— 拿一個月的攤提去比整筆的均價，長租一定被判過低。
   */
  const auditResult = useMemo(() => {
    if (!audit) return null;
    const seen = new Set<string>();
    const uniq: AuditOrder[] = [];
    for (const r of filtered) {
      const key = r.oid ?? r.order_id;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push({
        id: key, source: r.source, property_raw: r.property_raw,
        estate_id: r.estate_id, guest_name: r.guest_name,
        checkin: r.checkin || null, checkout: r.checkout || null,
        nights: r.total_nights, amount: r.total_amount,
      });
    }
    return auditOrders(uniq, {}, {
      roomAncestors,
      today: new Date().toISOString().slice(0, 10),
    });
  }, [audit, filtered, roomAncestors]);

  /** 這一列（認列列）對應的訂單有沒有問題 */
  const entryOf = (r: Row) => auditResult?.byId[r.oid ?? r.order_id];
  const bySource = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) m[r.source] = (m[r.source] || 0) + Number(r.month_amount);
    const CORE = ['airbnb', 'agoda', 'private', 'oneoff'];
    return SOURCE_ORDER.filter((s) => m[s] || CORE.includes(s)).map((s) => [s, m[s] || 0] as [string, number]);
  }, [filtered]);
  const byEstate = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) {
      const k = r.estate_name ?? (r.source === 'company' ? '公司登記(無物業)' : r.source === 'other' ? '其他' : '無物業');
      m[k] = (m[k] || 0) + Number(r.month_amount);
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [filtered]);
  const estateOptions = useMemo(() => Array.from(new Set(rows.map((r) => r.estate_name ?? "無"))).sort(), [rows]);
  // 房源選項跟著物業篩選連動 —— 選了物業就只列該物業的房源,
  // 否則 200 多間全部列出來根本找不到。
  const roomOptions = useMemo(() => Array.from(new Set(
    rows.filter((r) => !estateFilter || (r.estate_name ?? '無') === estateFilter)
        // 辦公室與公司登記的房號不列進下拉 —— 表格上不顯示,篩選卻篩得到會很奇怪
        .filter((r) => !isOffice(r) && !isCompany(r))
        .map((r) => r.property_raw ?? '').filter(Boolean)
  )).sort(), [rows, estateFilter]);

  async function exportXlsx() {
    const months = monthsInRange(fromM, toM).slice(0, 24);
    const { data: estateRows } = await supabase.from('estates').select('name, manager, sort').order('sort');
    const managerOf: Record<string, string> = {};
    const estateSort: Record<string, number> = {};
    (estateRows ?? []).forEach((e: any, i: number) => { if (e.manager) managerOf[e.name] = e.manager; estateSort[e.name] = i; });

    const monthData: { ym: string; y: number; m: number; rows: Row[] }[] = [];
    for (const [y, m] of months) {
      monthData.push({ ym: `${y}${String(m).padStart(2, '0')}`, y, m, rows: await fetchMonthRows(y, m) });
    }

    // ===== 樣式 =====
    const BR = { style: 'thin', color: { rgb: 'C9C6BE' } };
    const BORD = { top: BR, bottom: BR, left: BR, right: BR };
    const stTitle = { font: { bold: true, sz: 14 }, alignment: { horizontal: 'center' } };
    const stSub = { font: { sz: 11, color: { rgb: '777777' } }, alignment: { horizontal: 'center' } };
    const stHead = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: 'E7E4DC' } }, border: BORD, alignment: { horizontal: 'center' } };
    const stTotal = { font: { bold: true }, fill: { fgColor: { rgb: 'F9CBAD' } }, border: BORD };
    const stGroup = { font: { bold: true }, fill: { fgColor: { rgb: 'FFF2CC' } }, border: BORD };
    const stCell = { border: BORD };
    const stSubtotal = { font: { bold: true }, fill: { fgColor: { rgb: 'E2EFDA' } }, border: BORD };
    const T = (v: any, s: any) => ({ v, t: typeof v === 'number' ? 'n' : 's', s, z: typeof v === 'number' ? '#,##0' : undefined });

    const wb = XLSX.utils.book_new();
    const eSort = (a: string, b: string) => (estateSort[a] ?? 99) - (estateSort[b] ?? 99);

    /* ═══════════════════════════════════════════════════════════════
     * 【總表與房源月報的共同原則】
     *
     * 1. 一列一個科目,一欄一個月。
     *    舊版是「每個月各佔兩欄(標籤+金額)」,而且每個月的標籤是各自長出來的
     *    (有值才 push 一列)。8 月的 AIRBNB 底下有 5 個物業、7 月有 6 個,
     *    兩邊的列從那裡開始錯開 —— 同一列左右兩個數字根本不是同一個科目,
     *    橫著讀是錯的。這一版先掃過所有月份取聯集,建出固定的列骨架。
     *
     * 2. 零就寫 0,不讓列消失。
     *    某個科目這個月掛零,本身就是要看見的資訊;讓它消失會把下面全部推上來。
     *
     * 3. 月份由新到舊。最新的月份最常看,放最左邊。
     *
     * 4. 辦公室出租與公司登記不掛物業房源,各自獨立一段。
     *    它們不是租金收入,混進物業會讓「這個物業帶進多少錢」失真。
     *    兩個分頁用同一個結構,所以兩邊的物業小計必然相同 ——
     *    那是內建的對帳點,對不上就代表有資料掉了。
     *
     * 5. 沒有任何寫死的物業名稱。
     *    舊版有 `estate_name !== '正隆'` 這種判斷,新增或改名一個物業
     *    就會靜靜地算錯而不報錯。
     * ═══════════════════════════════════════════════════════════════ */

    // 由新到舊。monthsInRange 給的是由舊到新。
    const cols = [...monthData].reverse();
    const SUM = (rs: Row[], f: (r: Row) => boolean) =>
      Math.round(rs.filter(f).reduce((a, r) => a + Number(r.month_amount), 0));
    /** 一列:標籤 + 每月金額 + 合計 */
    const line = (label: string, f: (r: Row) => boolean, st: any, indent = '') => {
      const vals = cols.map((md) => SUM(md.rows, f));
      return [T(indent + label, st), ...vals.map((v) => T(v, st)), T(vals.reduce((a, b) => a + b, 0), st)];
    };
    const blank = (n: number) => Array(n).fill(T('', {}));
    const headRow = (first: string) =>
      [T(first, stHead), ...cols.map((md) => T(md.ym, stHead)), T('合計', stHead)];
    const nC = cols.length + 2;   // 標籤 + 各月 + 合計

    // 三段的歸屬與骨架都走 lib/revenue-report —— 那支有測試(revenue-report.test.ts),
    // 釘住「三段相加等於總營收」與「骨架取所有月份的聯集」這兩件事。
    const allRows = monthData.flatMap((md) => md.rows);
    const sk = skeleton(allRows, eSort);

    // ===== 分頁1:營收總表 =====
    {
      const A: any[][] = [];
      A.push([T('營收總表', stTitle), ...blank(nC - 1)]);
      A.push([T(`${fromM} ~ ${toM}・月份由新到舊`, stSub), ...blank(nC - 1)]);
      // 三段相加對不上總營收就把差額寫在最上面。
      // 正常情況這一列不存在 —— 出現了就代表有來源沒被任何一段收進去。
      const bad = reconcile(allRows);
      if (bad) {
        A.push([T(`⚠ 對帳不符:總營收 ${bad.total},三段相加 ${bad.parts},差 ${bad.diff}`,
          { font: { bold: true, color: { rgb: 'C00000' } } }), ...blank(nC - 1)]);
      }
      A.push(headRow('項目'));

      // ── 依營收分類 ──
      A.push([T('【依營收分類】', stGroup), ...Array(nC - 1).fill(T('', stGroup))]);
      A.push(line('Airbnb', (r) => r.source === 'airbnb', stCell, '　'));
      A.push(line('Agoda', (r) => r.source === 'agoda', stCell, '　'));
      A.push(line('私下', (r) => r.source === 'private', stCell, '　'));
      // 短租 = 那三個平台的小計。搭檔收款(partner)在寫入認列時已經歸到 airbnb。
      A.push(line('短租小計', (r) => SHORT_SOURCES.includes(r.source), stSubtotal, '　'));
      A.push(line('長租', (r) => r.source === 'longterm', stCell, '　'));
      // 叫「收入」不叫「費用」—— 這是我們收進來的錢。
      // 在營收報表裡寫「費用」會讓人以為那是要扣掉的成本。
      A.push(line(ONEOFF_LABEL, (r) => r.source === 'oneoff', stCell, '　'));
      // 一次性底下再依項目拆。洗衣機/烘衣機/垃圾代收費的會計科目都是清潔費,
      // 只看科目會併成一格 —— 這幾列就是為了看得出組成。
      // 篩選條件要跟 oneoffItems 用同一支 oneoffLabel() 產生標籤 ——
      // 兩邊各自拼字串的話,標籤格式一改就永遠比不中,而且不會報錯,只會全部顯示 0。
      oneoffItems(allRows).forEach(({ item }) =>
        A.push(line(item, (r) => r.source === 'oneoff' && oneoffLabel(r) === item, stCell, '　　')));
      A.push(line('辦公室租金', isOffice, stCell, '　'));
      A.push(line('公司登記', isCompany, stCell, '　'));
      A.push(line('其他', (r) => r.source === 'other', stCell, '　'));
      A.push(line('總營收', () => true, stTotal));
      A.push(blank(nC));

      // ── 依物業(不含辦公室與公司登記)──
      A.push([T('【依物業】不含辦公室出租與公司登記', stGroup), ...Array(nC - 1).fill(T('', stGroup))]);
      sk.estates.forEach((e) => A.push(line(e, (r) => inEstateBlock(r) && estateOf(r) === e, stCell, '　')));
      A.push(line('物業小計', inEstateBlock, stSubtotal));
      A.push(blank(nC));

      // ── 辦公室出租 ──
      A.push([T('【辦公室出租】不掛物業房源', stGroup), ...Array(nC - 1).fill(T('', stGroup))]);
      sk.offices.forEach((g) => A.push(line(g, (r) => isOffice(r) && guestOf(r) === g, stCell, '　')));
      A.push(line('辦公室小計', isOffice, stSubtotal));
      A.push(blank(nC));

      // ── 公司登記 ──
      A.push([T('【公司登記】不掛物業房源', stGroup), ...Array(nC - 1).fill(T('', stGroup))]);
      sk.companies.forEach((g) => A.push(line(g, (r) => isCompany(r) && guestOf(r) === g, stCell, '　')));
      A.push(line('公司登記小計', isCompany, stSubtotal));
      A.push(blank(nC));

      // 收尾再放一次總營收:上面兩個分法各自加總都要等於它。
      // 對不起來就代表有列被漏掉,不用另外寫檢查程式。
      A.push(line('總營收', () => true, stTotal));

      const ws = XLSX.utils.aoa_to_sheet(A);
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: nC - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: nC - 1 } },
      ];
      ws['!cols'] = [{ wch: 30 }, ...cols.map(() => ({ wch: 13 })), { wch: 14 }];
      // 標籤欄與表頭凍住 —— 月份多的時候橫向捲動,不凍會不知道自己在看哪一列。
      // ySplit 要跟著算,對帳警告列出現時表頭會往下移一格。
      ws['!freeze'] = { xSplit: 1, ySplit: bad ? 4 : 3 };
      XLSX.utils.book_append_sheet(wb, ws, '營收總表');
    }

    /* ═══════════════════════════════════════════════════════════
     * 每個月一張分頁,分頁名就是 YYYYMM。
     *
     * 版面跟營收總表同一個骨架:
     *   【依房源】物業 → 房源 → 分類   ← 一次性收入排在所屬房源裡,不另立一區
     *   【辦公室出租】依客戶
     *   【公司登記】依客戶
     *   總營收
     *
     * 一次性收入不再獨立一段,而是照房號混在房源列表裡 ——
     * 「這間房這個月帶進多少錢」才是完整的,租金與清潔費分兩處看是拼不起來的。
     * 分類欄看得出它是一次性以及科目、項目(一次性・清潔費・洗衣機)。
     *
     * 房源空的一律寫破折號。空值有兩種來源(刻意算整棟 / 真的漏填),
     * 分不出來就不要替使用者解釋,只陳述「這一格沒有值」。
     * ═══════════════════════════════════════════════════════════ */
    // 金額右對齊 —— 明細列很多,靠左的話位數對不齊,掃不出量級
    const stNum = { border: BORD, alignment: { horizontal: 'right' } };
    /*
     * 訂單起訖與認列起訖**都要有**,那是兩件事。
     *
     * 3A3 首安那筆:訂單是 2026-06-22~2026-08-15(整張單),
     * 認列是 2026-07-01~2026-07-31(這個月分到的那一段)。
     * 只寫訂單起訖的話,看的人會問「這是七月的表,為什麼日期是六月」。
     */
    const MHEAD = ['物業', '房源', '分類', '客戶',
      '訂單起日', '訂單迄日', '認列起日', '認列迄日',
      '訂單總額', '當月收入', '當月天數', '總天數', '均價', '負責人', '評價', '入帳', '帳戶', '押金'];
    const MC = MHEAD.length;

    for (const md of cols) {
      const ms = `${md.y}-${String(md.m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(md.m === 12 ? md.y + 1 : md.y, md.m === 12 ? 0 : md.m, 0)).getUTCDate();
      const me = new Date(Date.UTC(md.m === 12 ? md.y + 1 : md.y, md.m === 12 ? 0 : md.m, 1)).toISOString().slice(0, 10);
      const { data: revs } = await supabase.from('reviews')
        .select('guest_name, checkout_date, overall_rating, properties(name)')
        .gte('checkout_date', ms).lt('checkout_date', me);
      const ratingByKey: Record<string, number> = {};
      const ratingByGuest: Record<string, number> = {};
      for (const rv of (revs as any[]) ?? []) {
        const pn = rv.properties?.name ?? '';
        ratingByKey[`${pn}|${rv.checkout_date}`] = rv.overall_rating;
        ratingByGuest[`${pn}|${(rv.guest_name || '').split(' ')[0]}`] = rv.overall_rating;
      }

      const S: any[][] = [];
      const mblank = (n: number) => Array(n).fill(T('', {}));
      S.push([T('收入明細', stTitle), ...mblank(MC - 1)]);
      S.push([T(`${md.y - 1911}年${md.m}月1日~${md.y - 1911}年${md.m}月${lastDay}日`, stSub), ...mblank(MC - 1)]);
      S.push(MHEAD.map((h) => T(h, stHead)));

      /** 明細列。訂單層級,一列一筆認列。 */
      const detail = (r: Row, est: string, room: string, cls: string) => {
        const pn = r.property_raw ?? '';
        const rating = ratingByKey[`${pn}|${r.checkout}`]
          ?? ratingByGuest[`${pn}|${(r.guest_name || '').split(' ')[0]}`] ?? '';
        return [
          T(est, stCell), T(room, stCell), T(cls, stCell), T(r.guest_name ?? '', stCell),
          T(r.checkin ?? '', stCell), T(r.checkout ?? '', stCell),
          // 認列迄日存的是「下個月一號」(半開區間),顯示要減一天,
          // 否則七月的表上會出現 8/1,看起來像跨月了
          T(r.period_start ?? '', stCell), T(r.period_end ? minus1(r.period_end) : '', stCell),
          T(Math.round(r.total_amount), stCell), T(Math.round(r.month_amount), stNum),
          T(r.month_nights, stCell), T(r.total_nights, stCell),
          // 一次性收入沒有天數,均價除下去會是 Infinity —— 沒有天數就留空
          T(r.month_nights ? Math.round(Number(r.month_amount) / r.month_nights) : '', stCell),
          T(managerOf[est] ?? '', stCell), T(rating, stCell),
          T('', stCell), T('', stCell), T('', stCell),   // 入帳 / 帳戶 / 押金:留白給人手填
        ];
      };
      /** 小計列。金額對齊「當月收入」那一欄(索引 7)。 */
      const sub = (label: string, rs: Row[], st: any) => {
        const row = Array(MC).fill(T('', st));
        row[0] = T(label, st);
        // 索引 9 是「當月收入」。欄位順序一改這裡就要跟著改,
        // 忘了改的話小計會出現在別的欄位底下而沒人發現。
        row[MHEAD.indexOf('當月收入')] = T(Math.round(rs.reduce((a, r) => a + Number(r.month_amount || 0), 0)), st);
        return row;
      };

      const inEst = md.rows.filter(inEstateBlock);
      const offs0 = md.rows.filter(isOffice);
      const coms0 = md.rows.filter(isCompany);
      const estList = Array.from(new Set(inEst.map(estateOf))).sort(eSort);

      /*
       * ── 結算 ──
       *
       * 放在最上面。明細有兩百多列,物業小計散在中間,
       * 「這個月各棟各賺多少」得滾很久才拼得出來 —— 那是最常被問的問題,
       * 應該一開表就看得到。
       *
       * 下面的明細是同一批數字的展開,兩邊必然相等。
       */
      S.push([T('【結算】', stGroup), ...Array(MC - 1).fill(T('', stGroup))]);
      estList.forEach((e) =>
        S.push(sub(`　${e}`, inEst.filter((r) => estateOf(r) === e), stCell)));
      S.push(sub('物業小計', inEst, stSubtotal));
      S.push(sub('　租辦公室', offs0, stCell));
      S.push(sub('　公司登記', coms0, stCell));
      // 其他收入(清潔費、取消費、垃圾代收…)已經含在物業小計裡,
      // 這一列是「其中有多少」,不是另外加上去的 —— 標題寫清楚免得被重複加總。
      S.push(sub('　其中:其他收入', md.rows.filter((r) => r.source === 'oneoff'), stCell));
      S.push(sub('總營收', md.rows, stTotal));
      S.push(mblank(MC));

      // ── 依房源 ──
      S.push([T('【依房源】不含辦公室出租與公司登記', stGroup), ...Array(MC - 1).fill(T('', stGroup))]);
      for (const e of estList) {
        const grp = inEst.filter((r) => estateOf(r) === e);
        // 房號自然排序,空的排最後 —— 那些是整棟或漏填,不該卡在房號中間
        const rooms = Array.from(new Set(grp.map(roomOf))).sort((a, b) => {
          if (a === ROOM_NONE) return 1;
          if (b === ROOM_NONE) return -1;
          const ka = roomKey(a), kb = roomKey(b);
          return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
        });
        for (const room of rooms) {
          const rr = grp.filter((r) => roomOf(r) === room)
            .sort((a, b) => itemLabel(a).localeCompare(itemLabel(b))
              || (a.checkin ?? '').localeCompare(b.checkin ?? ''));
          rr.forEach((r) => S.push(detail(r, e, room, itemLabel(r))));
          /*
           * 不做房源小計。
           *
           * 一間房兩三筆的小計沒有回答任何問題 —— 兩個數字加起來心算就有了,
           * 而插進來的那一列會把明細切碎:掃過去看短租週轉時,視線每兩三列就被打斷一次。
           *
           * 真正要看「各房源多少錢」的時候,篩選房源或用樞紐分析比小計列好用,
           * 因為那能跨月比較,小計列只有當月。
           */
        }
        S.push(sub(`↑ ${e} 小計`, grp, stSubtotal));
        S.push(mblank(MC));
      }
      S.push(sub('物業小計', inEst, stSubtotal));
      S.push(mblank(MC));

      // ── 辦公室出租 ──
      const offs = offs0;
      S.push([T('【辦公室出租】不掛物業房源', stGroup), ...Array(MC - 1).fill(T('', stGroup))]);
      // 辦公室出租與公司登記不掛物業房源,那兩欄留空 ——
      // 寫破折號會讓人以為「有房源但沒填」,實際上是這類收入本來就沒有房源。
      offs.forEach((r) => S.push(detail(r, '', '', '辦公室租金')));
      S.push(sub('辦公室小計', offs, stSubtotal));
      S.push(mblank(MC));

      // ── 公司登記 ──
      const coms = coms0;
      S.push([T('【公司登記】不掛物業房源', stGroup), ...Array(MC - 1).fill(T('', stGroup))]);
      coms.forEach((r) => S.push(detail(r, '', '', '公司登記')));
      S.push(sub('公司登記小計', coms, stSubtotal));
      S.push(mblank(MC));

      // 三段相加要等於總營收。對不起來就代表有列被漏掉,不用另外寫檢查。
      S.push(sub('總營收', md.rows, stTotal));

      const wsM = XLSX.utils.aoa_to_sheet(S);
      wsM['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: MC - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: MC - 1 } },
      ];
      wsM['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 18 },
        { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 11 },
        { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 6 },
        { wch: 10 }, { wch: 8 }, { wch: 10 }];
      wsM['!freeze'] = { xSplit: 4, ySplit: 3 };
      XLSX.utils.book_append_sheet(wb, wsM, md.ym);
    }
    XLSX.writeFile(wb, `營收_${fromM}_${toM}.xlsx`);
  }

  const orderRange = (r: Row) => {
    if (r.source === 'longterm') {
      const cands = contracts.filter((c) => c.room === r.property_raw && (!r.estate_name || c.estate === r.estate_name));
      const c = cands.find((c) => !r.period_start || (c.start <= r.period_start && r.period_start <= c.end)) ?? cands[0];
      if (c) return `${c.start}~${c.end}`;
    }
    return r.checkin && r.checkout ? `${r.checkin}~${r.checkout}` : '—';
  };
  const recogRange = (r: Row) => (r.period_start && r.period_end ? `${r.period_start}~${minus1(r.period_end)}` : '—');

  return (
    <div>
      <div className="mb-4">
        <h1>營收</h1>
      </div>

      {/* Dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4 items-stretch">
        <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center min-w-0">
          <div className="text-xs opacity-75">當期營收總額</div>
          <div className="stat-num-lg font-bold mt-1">${fmt(total)}</div>
          <div className="text-xs opacity-75 mt-2">{fromM} ~ {toM}・{filtered.length} 筆認列</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-white/45">依來源</div>
          <div>
            {bySource.map(([s, v]) => (
              <div key={s} onClick={() => setSourceFilter(sourceFilter === s ? '' : s)}
                className={`px-4 py-2 flex items-center justify-between text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${sourceFilter === s ? 'bg-mor-bluelight/60' : ''}`}>
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[s]}`}>{SOURCE_LABEL[s] ?? s}</span>
                <span className="font-semibold">${fmt(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-white/45">依物業</div>
          <div>
            {byEstate.map(([e, v]) => {
              const max = byEstate[0]?.[1] || 1;
              return (
                <div key={e} onClick={() => setEstateFilter(estateFilter === e ? '' : e)}
                  className={`px-4 py-2 flex items-center gap-3 text-sm border-b border-mor-line/50 last:border-0 cursor-pointer hover:bg-mor-bluelight/40 ${estateFilter === e ? 'bg-mor-bluelight/60' : ''}`}>
                  <span className="w-16 truncate">{e}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-mor-sand overflow-hidden"><div className="h-full bg-mor-blue" style={{ width: `${(v / max) * 100}%` }} /></div>
                  <span className="min-w-[6rem] shrink-0 whitespace-nowrap text-right font-semibold">${fmt(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filters */}
      <FilterToggle active={!!(estateFilter || roomFilter || sourceFilter || kw)} />
      <div className="filter-bar collapsible-filters rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estateFilter} onChange={(e) => setEstateFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-24">
            <option value="">全部</option>{estateOptions.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">房源</label>
          <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-24 max-w-40">
            <option value="">全部</option>{roomOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">全部</option>{SOURCE_ORDER.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">期間(認列月份)</label>
          <div className="flex items-center gap-1">
            <input type="month" value={fromM} onChange={(e) => setFromM(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
            <span className="text-gray-400">~</span>
            <input type="month" value={toM} onChange={(e) => setToM(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">關鍵字(客戶/房源)</label>
          <div className="flex gap-1">
            <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setKw(kwInput.trim()); }}
              placeholder="搜尋" className="rounded-lg border border-gray-300 px-2 py-1.5 w-28" />
            <button onClick={() => setKw(kwInput.trim())} className="rounded-lg bg-mor-slate text-white px-3 hover:bg-mor-slatedark">搜尋</button>
          </div>
        </div>
        {(estateFilter || roomFilter || sourceFilter || kw) && <button onClick={() => { setEstateFilter(''); setRoomFilter(''); setSourceFilter(''); setKw(''); setKwInput(''); }} className="text-gray-500 underline pb-1.5">清除</button>}
        {/* 防呆放在動作那一組的最左邊,跟訂單頁同一個位置 ——
            同一個功能在兩頁要在同一個地方,不然每換一頁就要重新找 */}
        <div className="ml-auto flex items-end gap-3">
          <AuditButton on={audit}
            onToggle={() => { setAudit((v) => !v); setOnlyBad(false); }} />
          <div className="text-xs text-gray-400 pb-1.5">共 {filtered.length} 筆・${fmt(total)}</div>
          <ExportButton onClick={exportXlsx} disabled={!filtered.length} />
        </div>
      </div>

      {/* Table */}
      {audit && auditResult && (
        <AuditSummary result={auditResult} onlyBad={onlyBad}
          onToggleOnly={() => setOnlyBad((v) => !v)} />
      )}

      <div className="rounded-xl glass overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
              <SortTh label="來源" sortKey="source" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="物業" sortKey="estate_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="房源" sortKey="property_raw" type="room" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="客戶" sortKey="guest_name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
              <SortTh label="訂單起訖" sortKey="checkin" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <SortTh label="認列起訖" sortKey="period_start" type="date" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="whitespace-nowrap" />
              <SortTh label="訂單總額" sortKey="total_amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
              <SortTh label="認列天數" sortKey="month_nights" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right whitespace-nowrap" align="right" />
              <SortTh label="當期認列" sortKey="month_amount" type="number" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} className="text-right" align="right" />
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">此期間無認列營收</td></tr>
            : (audit && onlyBad && auditResult
                ? sorted.filter((r) => entryOf(r))
                : pageRows).map((r) => (
              <tr key={r.order_id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30">
                <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[r.source]}`}>{r.source === 'oneoff' ? `${ONEOFF_LABEL}・${oneoffLabel(r)}` : (SOURCE_LABEL[r.source] ?? r.source)}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{r.estate_name ?? '—'}</td>
                {/*
                  辦公室出租與公司登記不顯示房源。

                  資料上 property_raw 是有值的 —— 契約產生月租單時會帶 contracts.room,
                  而那些契約確實填了房號(公司登記在 2F-28)。那個資訊本身有用,
                  所以不清資料,只是不在營收報表上顯示。

                  理由:這兩類不是租金收入,報表上依物業房源分組時它們本來就不參與
                  (見 lib/revenue-report 的三段分法)。顯示房號會讓人以為
                  「這間房這個月有這筆收入」,然後拿去跟房源營收對帳,對不起來。
                */}
                <td className="px-3 py-2 whitespace-nowrap">{isOffice(r) || isCompany(r) ? '—' : (r.property_raw ?? '—')}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.guest_name ?? '—'}
                  {audit && <div className="mt-0.5"><AuditBadges entry={entryOf(r)} /></div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{orderRange(r)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{recogRange(r)}</td>
                <td className="px-3 py-2 text-right text-gray-500">${fmt(r.total_amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500 text-xs">{r.month_nights}/{r.total_nights}</td>
                <td className="px-3 py-2 text-right font-semibold">${fmt(r.month_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length > ROWS && (
          <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-500 border-t border-mor-line">
            <div>{sorted.length.toLocaleString()} 筆・第 {rowPage + 1} / {rowPages} 頁</div>
            <div className="flex gap-2">
              <button disabled={rowPage === 0} onClick={() => setRowPage(rowPage - 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">上一頁</button>
              <button disabled={rowPage >= rowPages - 1} onClick={() => setRowPage(rowPage + 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">下一頁</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
