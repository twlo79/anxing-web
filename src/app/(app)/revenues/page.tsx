'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import * as XLSX from 'xlsx-js-style';
import { SortTh, sortRows, roomKey, type SortState, type SortCols } from '@/lib/sortable';
import {
  isOffice, isCompany, inEstateBlock, estateOf, guestOf, roomOf,
  classOf, skeleton, roomLines, reconcile, SHORT_SOURCES,
} from '@/lib/revenue-report';

type Row = {
  order_id: string; source: string; estate_id: string | null; estate_name: string | null;
  property_raw: string | null; guest_name: string | null; checkin: string; checkout: string;
  period_start: string | null; period_end: string | null; fee_type?: string | null;
  total_amount: number; total_nights: number; month_nights: number; month_amount: number;
};

const SOURCE_LABEL: Record<string, string> = {
  airbnb: 'Airbnb', agoda: 'Agoda', private: '私下', longterm: '長租',
  office: '辦公室租金', company: '公司登記', oneoff: '其他收入', other: '其他',
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
    // 全部月份改讀 recognitions(訂單引擎),不再分界讀快照
    const { data } = await supabase.from('revenue_recognitions').select('*').eq('ym', ym).limit(3000);
    return ((data as any[]) ?? []).map((r) => ({
      order_id: r.id, source: r.source, estate_id: r.estate_id, estate_name: r.estate_name,
      property_raw: r.property_raw, guest_name: r.guest_name, checkin: r.checkin, checkout: r.checkout,
      period_start: r.period_start ?? pstart, period_end: r.period_end ?? pend, fee_type: r.fee_type ?? null,
      total_amount: Number(r.total_amount ?? 0), total_nights: r.total_nights ?? 0,
      month_nights: r.month_nights ?? 0, month_amount: Number(r.month_amount),
    })).filter((r) => r.month_amount !== 0);
  }, [supabase]);

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
    if (roomFilter && (r.property_raw ?? '') !== roomFilter) return false;
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
      A.push(line('一次性費用', (r) => r.source === 'oneoff', stCell, '　'));
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

    // ===== 分頁2:房源月報 =====
    {
      const A: any[][] = [];
      A.push([T('房源月報', stTitle), ...blank(nC + 1)]);
      A.push([T(`${fromM} ~ ${toM}・月份由新到舊`, stSub), ...blank(nC + 1)]);
      A.push([T('物業', stHead), T('房源', stHead), T('分類', stHead),
        ...cols.map((md) => T(md.ym, stHead)), T('合計', stHead)]);

      const nC2 = cols.length + 4;
      const line3 = (a: string, b: string, c: string, f: (r: Row) => boolean, st: any) => {
        const vals = cols.map((md) => SUM(md.rows, f));
        return [T(a, st), T(b, st), T(c, st), ...vals.map((v) => T(v, st)), T(vals.reduce((x, y) => x + y, 0), st)];
      };

      A.push([T('【依房源】不含辦公室出租與公司登記', stGroup), ...Array(nC2 - 1).fill(T('', stGroup))]);
      for (const e of sk.estates) {
        const inEstate = (r: Row) => inEstateBlock(r) && estateOf(r) === e;
        // 列的粒度是 房源 × 分類 —— 一間房同一個月可能同時有長租與一次性,
        // 合成一列就看不出組成。roomLines 有測試釘住這件事。
        const lines = roomLines(allRows, e).sort((x, y) => {
          const kx = roomKey(x.room), ky = roomKey(y.room);
          return kx[0] - ky[0] || (kx[1] < ky[1] ? -1 : kx[1] > ky[1] ? 1 : 0)
            || x.cls.localeCompare(y.cls);
        });
        for (const { room, cls } of lines) {
          A.push(line3(e, room, cls,
            (r) => inEstate(r) && roomOf(r) === room && classOf(r) === cls, stCell));
        }
        A.push(line3(`${e} 小計`, '', '', inEstate, stSubtotal));
      }
      A.push(line3('物業小計', '', '', inEstateBlock, stSubtotal));
      A.push(blank(nC2));

      A.push([T('【辦公室出租】不掛房源', stGroup), ...Array(nC2 - 1).fill(T('', stGroup))]);
      Array.from(new Set(allRows.filter(isOffice).map((r) => r.guest_name ?? '未填客戶'))).sort()
        .forEach((g) => A.push(line3('', '', g, (r) => isOffice(r) && (r.guest_name ?? '未填客戶') === g, stCell)));
      A.push(line3('辦公室小計', '', '', isOffice, stSubtotal));
      A.push(blank(nC2));

      A.push([T('【公司登記】不掛房源', stGroup), ...Array(nC2 - 1).fill(T('', stGroup))]);
      Array.from(new Set(allRows.filter(isCompany).map((r) => r.guest_name ?? '未填客戶'))).sort()
        .forEach((g) => A.push(line3('', '', g, (r) => isCompany(r) && (r.guest_name ?? '未填客戶') === g, stCell)));
      A.push(line3('公司登記小計', '', '', isCompany, stSubtotal));
      A.push(blank(nC2));

      A.push(line3('總營收', '', '', () => true, stTotal));

      const ws = XLSX.utils.aoa_to_sheet(A);
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: nC2 - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: nC2 - 1 } },
      ];
      ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 10 }, ...cols.map(() => ({ wch: 13 })), { wch: 14 }];
      ws['!freeze'] = { xSplit: 3, ySplit: 3 };
      XLSX.utils.book_append_sheet(wb, ws, '房源月報');
    }

    // ===== 各月明細分頁(由新到舊,跟上面兩張表一致)=====
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
      const header = ['姓名', '房源', '來源', '起日', '迄日', '訂單總金額', '當月收入', '當月天數', '總天數', '均價', '負責人', '評價', '入帳', '帳戶', '押金'];
      const sheet: any[][] = [];
      sheet.push([T('收入明細總表', stTitle), ...Array(14).fill(T('', {}))]);
      sheet.push([T(`${md.y - 1911}年${md.m}月1日~${md.y - 1911}年${md.m}月${lastDay}日`, stSub), ...Array(14).fill(T('', {}))]);
      sheet.push(header.map((h) => T(h, stHead)));
      const groups = Array.from(new Set(md.rows.map((r) => r.estate_name ?? '無物業'))).sort(eSort);
      for (const e of groups) {
        const grp = md.rows.filter((r) => (r.estate_name ?? '無物業') === e);
        for (const r of grp) {
          const pn = r.property_raw ?? '';
          const rating = ratingByKey[`${pn}|${r.checkout}`] ?? ratingByGuest[`${pn}|${(r.guest_name || '').split(' ')[0]}`] ?? '';
          sheet.push([
            T(r.guest_name ?? '', stCell), T(pn, stCell), T(r.source === 'oneoff' ? `一次性·${r.fee_type ?? '其他'}` : (SOURCE_LABEL[r.source] ?? r.source), stCell),
            T(r.checkin, stCell), T(r.checkout, stCell), T(Math.round(r.total_amount), stCell), T(Math.round(r.month_amount), stCell),
            T(r.month_nights, stCell), T(r.total_nights, stCell),
            T(r.month_nights ? Math.round(Number(r.month_amount) / r.month_nights) : '', stCell),
            T(managerOf[e] ?? '', stCell), T(rating, stCell), T('', stCell), T('', stCell), T('', stCell),
          ]);
        }
        sheet.push([T(`↑${e}`, stSubtotal), ...Array(5).fill(T('', stSubtotal)), T(Math.round(grp.reduce((a, r) => a + Number(r.month_amount), 0)), stSubtotal), ...Array(8).fill(T('', stSubtotal))]);
        sheet.push([]);
      }
      const wsM = XLSX.utils.aoa_to_sheet(sheet);
      wsM['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 14 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 14 } }];
      wsM['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 6 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
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
        <h1 className="text-xl font-bold">營收</h1>
      </div>

      {/* Dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4 items-stretch">
        <div className="rounded-xl bg-mor-slate text-white p-5 flex flex-col justify-center min-w-0">
          <div className="text-xs opacity-75">當期營收總額</div>
          <div className="stat-num-lg font-bold mt-1">${fmt(total)}</div>
          <div className="text-xs opacity-75 mt-2">{fromM} ~ {toM}・{filtered.length} 筆認列</div>
        </div>
        <div className="rounded-xl bg-white border border-mor-line overflow-hidden">
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依來源</div>
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
          <div className="px-4 py-2.5 text-sm font-semibold border-b border-mor-line bg-mor-sand/40">依物業</div>
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
      <div className="filter-bar bg-white rounded-xl border border-mor-line p-4 mb-4 flex flex-wrap items-end gap-3 text-sm">
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
        <div className="ml-auto flex items-end gap-3">
          <div className="text-xs text-gray-400 pb-1.5">共 {filtered.length} 筆・${fmt(total)}</div>
          <button onClick={exportXlsx} disabled={!filtered.length} className="rounded-lg bg-mor-slate text-white px-4 py-1.5 font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-mor-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-mor-sand/50">
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
            : pageRows.map((r) => (
              <tr key={r.order_id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/30">
                <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[r.source]}`}>{r.source === 'oneoff' ? `一次性·${r.fee_type ?? '其他'}` : (SOURCE_LABEL[r.source] ?? r.source)}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{r.estate_name ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.property_raw ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.guest_name ?? '—'}</td>
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
