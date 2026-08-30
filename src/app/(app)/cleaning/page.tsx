'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import RangeInput from '@/components/RangeInput';
import { EXPORT_TONE, ExportButton } from '@/components/Actions';
import {
  ActionRow, FILTER_BTN_H, FieldSpacer, FilterCount, FilterSearch,
} from '@/lib/filters';
import { BarPanel, BarRow, BarEmpty } from '@/components/BarList';
import StatHero from '@/components/StatHero';

type Estate = { id: string; name: string; sort: number };
type StaffStat = { staff_name: string; staff_type: string; active: boolean; total: number; rated: number; avg_rating: number | null; low_count: number };
type Rec = {
  id: string; record_key: string; record_date: string; staff_name: string; staff_type: string | null;
  property_id: string | null; property_raw: string | null; estate_name: string | null;
  overall_rating: number | null; note: string | null; doc_url: string | null;
};

const PAGE_SIZE = 50;
const FORM_HOUSEKEEPER = 'https://docs.google.com/forms/d/e/1FAIpQLSeTR203A1Q3rvyngaN0TJYadt7_Es_DoRsby_Xz5MKVVobeaw/viewform';
const FORM_ROOMSERVICE = 'https://docs.google.com/forms/d/e/1FAIpQLSeS-lhGwtUjhZWHUSlxyTS9gygQdVA4y_HoWYEjAmdsXB6mZQ/viewform';
const TYPE_LABEL: Record<string, string> = { housekeeper: '管家', roomservice: '房務', manager: '主管', accountant: '會計', other: '其他' };

function csvEsc(v: unknown) {
  if (v == null) return '';
  const s = String(v).replace(/\r\n/g, '\n');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function CleaningPage() {
  const supabase = useMemo(() => createClient(), []);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [exporting, setExporting] = useState(false);
  // filters
  const [estate, setEstate] = useState('');
  const [staff, setStaff] = useState('');
  const [staffType, setStaffType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [kw, setKw] = useState('');
  const [kwInput, setKwInput] = useState('');
  // stats
  /*
   * ★★ 統計區間與清單篩選**合而為一**（2026-08-28 使用者:「日期統一在 filter」）。
   *
   *   原本是兩組獨立的日期:上面一組餵 cleaning_staff_stats,
   *   下面一組餵清單。而它們問的是同一件事 ——
   *   使用者只會想到「我要看這段期間」。
   *
   * ★ 兩組分開的實際症狀:上面設了 7 月、下面沒設,
   *   於是**統計是 7 月的、底下列表是全部的** —— 兩個數字擺在同一頁
   *   而算的不是同一批資料,畫面上沒有任何地方說得出這件事。
   *   跟評價頁那次是同一個病。
   */
  const [stats, setStats] = useState<StaffStat[]>([]);
  const [minDate, setMinDate] = useState('');

  useEffect(() => {
    supabase.from('estates').select('id, name, sort').eq('active', true).order('sort').then(({ data }) => setEstates(data ?? []));
    supabase.from('cleaning_records').select('record_date').order('record_date', { ascending: true }).limit(1)
      .then(({ data }) => { if (data && data[0]) setMinDate(data[0].record_date); });
  }, [supabase]);
  useEffect(() => {
    supabase.rpc('cleaning_staff_stats', { p_from: dateFrom || null, p_to: dateTo || null })
      .then(({ data }) => setStats((data as StaffStat[]) ?? []));
  }, [supabase, dateFrom, dateTo]);

  const visibleStats = useMemo(() => stats.filter((s) => s.active).sort((a, b) => Number(b.total) - Number(a.total)), [stats]);
  const totalCount = useMemo(() => stats.reduce((s, x) => s + Number(x.total), 0), [stats]);

  const buildQuery = useCallback((count: boolean) => {
    let q = supabase.from('cleaning_records').select('*', count ? { count: 'exact' } : undefined)
      .order('record_date', { ascending: false });
    if (estate) q = q.eq('estate_name', estate);
    if (staff) q = q.eq('staff_name', staff);
    if (staffType) q = q.eq('staff_type', staffType);
    if (dateFrom) q = q.gte('record_date', dateFrom);
    if (dateTo) q = q.lte('record_date', dateTo);
    if (kw) q = q.or(`note.ilike.%${kw}%,property_raw.ilike.%${kw}%`);
    return q;
  }, [supabase, estate, staff, staffType, dateFrom, dateTo, kw]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, count } = await buildQuery(true).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    setRows((data as any) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [buildQuery, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [estate, staff, staffType, dateFrom, dateTo, kw]);

  const staffNames = useMemo(() => visibleStats.map((s) => s.staff_name), [visibleStats]);

  async function exportCsv() {
    setExporting(true);
    const all: Rec[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      const { data } = await buildQuery(false).range(from, from + 999);
      const b = (data as any as Rec[]) ?? [];
      all.push(...b);
      if (b.length < 1000) break;
    }
    /*
     * 【為什麼從 CSV 改成 Excel】
     * 按鈕寫「下載 Excel」而檔案是 .csv 的話，使用者雙擊打開會是記事本，
     * 或是 Excel 把中文吃成亂碼 —— 名字對不上檔案是最沒必要的困惑。
     * 全站的匯出統一成 .xlsx，格式與其他頁一致。
     */
    const header = ['記錄日', '物業', '房源', '填寫人', '身分', '備註', '表單'];
    const aoa = [header, ...all.map((r) => [
      r.record_date, r.estate_name, r.property_raw, r.staff_name,
      TYPE_LABEL[r.staff_type || 'other'], r.note ?? '', r.doc_url ?? '',
    ])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 40 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '清潔紀錄');
    XLSX.writeFile(wb, `清潔紀錄_${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /**
   * 分享單筆記錄到 LINE。
   *
   * 版型依填寫人的職位自動切換,對齊 Make 那兩張 Flex 卡片的欄位：
   *   管家 → 👩 管家檢查結果通知 / 檢查日 / 管家
   *   房務 → 🧹 清潔檢查表填寫通知 / 清潔日 / 房務員
   *
   * ⚠️ 這裡送出的是純文字,不是 Flex 卡片。
   * Flex 只有 Messaging API 推播才送得出去,而推播的收件人必須寫死在程式裡;
   * 「人工選收件人」+「Flex」要同時成立,只能靠 LIFF 的 shareTargetPicker,
   * 那需要另外註冊 LINE Login channel 與 LIFF App,且網站要從 LINE 內開啟。
   * 目前用全形空白對齊欄位,視覺上盡量接近卡片。
   */
  function shareRec(r: Rec) {
    const isHk = r.staff_type === 'housekeeper';
    const head = isHk ? '👩 管家檢查結果通知' : '🧹 清潔檢查表填寫通知';
    const dateLabel = isHk ? '檢查日' : '清潔日';
    const whoLabel = isHk ? '管家　' : '房務員';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const submitted = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const text = [
      head,
      '',
      `${r.estate_name ?? ''}${r.property_raw ?? ''}`.trim(),
      '',
      `${dateLabel}　${r.record_date}`,
      `${whoLabel}　${r.staff_name}`,
      `備註　　${r.note || '—'}`,
      `提交時間　${submitted}`,
      ...(r.doc_url ? ['', '完整檔案', r.doc_url] : []),
    ].join('\n');

    // 手機(含加到主畫面的 PWA)走系統分享面板,選單裡就有 LINE。
    // 桌機沒有 navigator.share,退回 LINE 的分享網址。
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: head, text }).catch(() => {});
      return;
    }
    window.open('https://line.me/R/msg/text/?' + encodeURIComponent(text), '_blank', 'noopener');
  }

  return (
    <div>
      {/* 手機:填表是現場人員的主要動作,放最上面全寬 */}
      <div className="md:hidden grid grid-cols-2 gap-2 mb-3">
        <a href={FORM_HOUSEKEEPER} target="_blank" rel="noreferrer"
          className="h-12 rounded-xl bg-mor-slate text-white font-medium flex items-center justify-center active:bg-mor-slatedark">📋 管家檢查表</a>
        <a href={FORM_ROOMSERVICE} target="_blank" rel="noreferrer"
          className="h-12 rounded-xl bg-mor-slate text-white font-medium flex items-center justify-center active:bg-mor-slatedark">🧹 房務清潔表</a>
      </div>

      {/* Dashboard */}
      <div className="mb-4 md:mb-6">
        {/*
          ★ 日期控制項在下面的篩選列。這裡不放輸入框 ——
            同一件事有兩個地方可以改的話,使用者不確定改哪個才算數。

          ★ 現在在看哪一段,寫在下面那張卡的第三行（「共 N 位・區間」）。
        */}
        <div className="mb-3">
          <h1 className="hidden md:block">清潔記錄</h1>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
          <StatHero title="總清潔次數" count={`共 ${visibleStats.length} 位`}
            value={totalCount.toLocaleString()}
            sub={(dateFrom || dateTo)
              ? `${dateFrom || minDate || '起始'} ~ ${dateTo || '今'}`
              : (minDate ? `${minDate} ~ 今` : '全部期間')} />
          {/*
            ★★ 改用共用的 BarPanel/BarRow（2026-08-29）。
              捲軸拿掉 —— 原本 `max-h-56` 一次只露五位填寫人,
              而這張卡的用途正是「誰做得多」,捲軸裡的人等於沒被看到。
          */}
          <BarPanel className="lg:col-span-2" title="依填寫人統計">
            {visibleStats.length === 0 ? <BarEmpty /> : visibleStats.map((m) => {
              const max = Math.max(...visibleStats.map((x) => Number(x.total))) || 1;
              return (
                <BarRow key={m.staff_name} tone="green"
                  label={<>{m.staff_name}<span className="ml-1 text-xs text-gray-400">{TYPE_LABEL[m.staff_type]}</span></>}
                  title={`${m.staff_name}（${TYPE_LABEL[m.staff_type]}）`}
                  pct={(Number(m.total) / max) * 100}
                  value={`${Number(m.total)} 次`} />
              );
            })}
          </BarPanel>
        </div>
      </div>

      {/* Filters —— 手機收在可展開區塊,預設收合 */}
      <details className="md:hidden mb-3 rounded-xl glass">
        <summary className="px-4 py-3 text-sm text-gray-600 cursor-pointer select-none">
          篩選{(estate || staff || staffType || dateFrom || dateTo || kw) ? '（已套用）' : ''}・共 {total.toLocaleString()} 筆
        </summary>
        <div className="px-4 pb-4 pt-3 flex flex-col gap-3 text-sm border-t border-mor-line">
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
            <select value={estate} onChange={(e) => setEstate(e.target.value)} className="h-12 rounded-lg border border-gray-300 px-2">
              <option value="">全部</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
            </select></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">填寫人</span>
              <select value={staff} onChange={(e) => setStaff(e.target.value)} className="h-12 rounded-lg border border-gray-300 px-2">
                <option value="">全部</option>{staffNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">職位</span>
              <select value={staffType} onChange={(e) => setStaffType(e.target.value)} className="h-12 rounded-lg border border-gray-300 px-2">
                <option value="">全部</option>
                <option value="housekeeper">管家</option>
                <option value="roomservice">房務</option>
              </select></label>
          </div>
          {/* ★ 兩個獨立欄位併成一組區間 —— 起訖本來就是一件事 */}
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">日期</span>
            <RangeInput inputClass="h-12 flex-1" from={dateFrom} to={dateTo}
              onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} /></label>
          <FilterSearch value={kwInput} onChange={setKwInput}
            onSubmit={() => setKw(kwInput.trim())} placeholder="備註／房號" />
          <div className="flex gap-2">
            {(estate || staff || staffType || dateFrom || dateTo || kw) && (
              <button onClick={() => { setEstate(''); setStaff(''); setStaffType(''); setDateFrom(''); setDateTo(''); setKw(''); setKwInput(''); }}
                className="flex-1 h-12 rounded-lg border border-mor-line text-gray-600">清除篩選</button>
            )}
            <button onClick={exportCsv} disabled={exporting || total === 0}
              className={`flex-1 h-12 rounded-lg disabled:opacity-40 ${EXPORT_TONE}`}>{exporting ? '匯出中…' : '⬇ 下載 Excel'}</button>
          </div>
        </div>
      </details>

      {/* Filters —— 桌機 */}
      {/* ★ 加上 `filter-bar` —— 欄位高度與標題字級才吃得到 globals.css
            那條全站統一的規則（「篩選列的統一外觀」）。
            這一頁的手機版是另一塊 JSX,所以這裡維持 `hidden md:flex`,
            不加 `collapsible-filters`。 */}
      <div className="filter-bar hidden md:flex rounded-xl glass p-4 mb-4 flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">物業</label>
          <select value={estate} onChange={(e) => setEstate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-24">
            <option value="">全部</option>{estates.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">填寫人</label>
          <select value={staff} onChange={(e) => setStaff(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-20">
            <option value="">全部</option>{staffNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">職位</label>
          <select value={staffType} onChange={(e) => setStaffType(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 min-w-20">
            <option value="">全部</option>
            <option value="housekeeper">管家</option>
            <option value="roomservice">房務</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">日期</label>
          <RangeInput from={dateFrom} to={dateTo}
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        </div>
        <FilterSearch value={kwInput} onChange={setKwInput}
          onSubmit={() => setKw(kwInput.trim())} placeholder="備註／房號" />
        {/* 清除的字統一叫「清除」（全站一致）—— 「清除篩選」四個字只有這一頁在用 */}
        <FieldSpacer>
          {(estate || staff || staffType || dateFrom || dateTo || kw) && (
            <button onClick={() => { setEstate(''); setStaff(''); setStaffType(''); setDateFrom(''); setDateTo(''); setKw(''); setKwInput(''); }}
              className={`${FILTER_BTN_H} px-2 text-uisub text-gray-500 underline`}>清除</button>
          )}
        </FieldSpacer>
      </div>

      {/*
        ★★ 動作列**在篩選卡外面**（2026-08-29 使用者:「沒改掉阿」）。

          原本這三顆按鈕跟筆數塞在篩選卡裡、靠 `ml-auto` 推到右邊 ——
          於是它們排在六個下拉的同一行,看起來像第七、八、九個篩選欄位。

        ★ 篩選是「我要看哪些」,動作是「我要做什麼」—— 兩件事,兩行。
      */}
      <ActionRow>
        <div className="mr-auto md:mr-0"><FilterCount n={total} /></div>
        <a href={FORM_HOUSEKEEPER} target="_blank" rel="noreferrer"
          className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 whitespace-nowrap">📋 管家檢查表</a>
        <a href={FORM_ROOMSERVICE} target="_blank" rel="noreferrer"
          className="rounded-lg border border-mor-line bg-white px-4 py-1.5 font-medium hover:bg-mor-sand/60 whitespace-nowrap">🧹 房務清潔表</a>
        <ExportButton onClick={exportCsv} disabled={exporting || total === 0} busy={exporting} />
      </ActionRow>

      {/* 手機卡片版 */}
      <div className="md:hidden space-y-2">
        {loading ? <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">載入中…</div>
        : rows.length === 0 ? <div className="rounded-xl glass py-10 text-center text-gray-400 text-sm">沒有符合條件的紀錄</div>
        : rows.map((r) => (
          <div key={r.id} className="rounded-xl glass p-3">
            <div className="flex items-start justify-between gap-2" onClick={() => setDetail(r)}>
              <div className="min-w-0">
                <div className="font-medium">
                  <span className="inline-block rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs mr-1.5">{r.estate_name ?? '—'}</span>
                  {r.property_raw ?? '—'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {r.record_date}・{r.staff_name}
                  <span className="ml-1 text-gray-400">{TYPE_LABEL[r.staff_type || 'other']}</span>
                </div>
              </div>
            </div>
            <div className="mt-2 text-sm text-gray-600 line-clamp-3" onClick={() => setDetail(r)}>
              {r.note || <span className="text-gray-300">（無備註）</span>}
            </div>
            <div className="mt-3 flex gap-2">
              {r.doc_url && (
                <a href={r.doc_url} target="_blank" rel="noreferrer"
                  className="flex-1 h-12 rounded-lg border border-mor-line text-sm font-medium flex items-center justify-center active:bg-mor-sand/60">📄 詳細內容</a>
              )}
              <button onClick={() => shareRec(r)}
                className="flex-1 h-12 rounded-lg border border-mor-line text-sm font-medium active:bg-mor-sand/60">↗ 分享</button>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between px-1 py-2 text-sm text-gray-500">
          <div>第 {page + 1} / {pages} 頁</div>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="h-12 px-4 rounded-lg border border-gray-300 disabled:opacity-40">上一頁</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="h-12 px-4 rounded-lg border border-gray-300 disabled:opacity-40">下一頁</button>
          </div>
        </div>
      </div>

      {/* 桌機表格版 */}
      <div className="hidden md:block rounded-xl glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
              <th className="px-3 py-2.5 whitespace-nowrap">記錄日</th>
              <th className="px-3 py-2.5">物業</th>
              <th className="px-3 py-2.5">房源</th>
              <th className="px-3 py-2.5">填寫人</th>
              <th className="px-3 py-2.5">備註</th>
              <th className="px-3 py-2.5 whitespace-nowrap">表單</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">載入中…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">沒有符合條件的紀錄</td></tr>
            : rows.map((r) => (
              <tr key={r.id} className="border-b border-mor-line/60 hover:bg-mor-bluelight/40 align-top">
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 cursor-pointer" onClick={() => setDetail(r)}>{r.record_date}</td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}><span className="inline-block rounded-md bg-mor-bluelight text-mor-slate px-2 py-0.5 text-xs font-medium">{r.estate_name ?? '—'}</span></td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}>{r.property_raw ?? '—'}</td>
                <td className="px-3 py-2.5 whitespace-nowrap cursor-pointer" onClick={() => setDetail(r)}>{r.staff_name}<span className="ml-1 text-xs text-gray-400">{TYPE_LABEL[r.staff_type || 'other']}</span></td>
                <td className="px-3 py-2.5 text-gray-600 min-w-64 cursor-pointer" onClick={() => setDetail(r)}><div className="line-clamp-2">{r.note ?? <span className="text-gray-300">（無備註）</span>}</div></td>
                <td className="px-3 py-2.5 whitespace-nowrap space-x-3">
                  {r.doc_url ? <a href={r.doc_url} target="_blank" rel="noreferrer" className="text-mor-slate underline hover:text-mor-blue" onClick={(e) => e.stopPropagation()}>📄 詳細內容</a> : <span className="text-gray-300">—</span>}
                  <button onClick={(e) => { e.stopPropagation(); shareRec(r); }}
                    className="text-mor-slate underline hover:text-mor-blue">↗ 分享</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 text-sm text-gray-500">
          <div>第 {page + 1} / {pages} 頁</div>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">上一頁</button>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded-lg border border-gray-300 px-3 py-1 disabled:opacity-40">下一頁</button>
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-50" onClick={() => setDetail(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 flex items-center justify-between">
              <div>
                <div className="font-bold">{detail.estate_name} ・ {detail.property_raw}</div>
                <div className="text-xs text-gray-500 mt-0.5">{detail.record_date}・{detail.staff_name}({TYPE_LABEL[detail.staff_type || 'other']})</div>
              </div>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="px-6 py-5 space-y-5 text-sm">
              <div>
                <div className="text-xs text-gray-500 mb-1.5 font-medium">備註</div>
                <p className="whitespace-pre-wrap leading-relaxed">{detail.note ?? '（無）'}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {detail.doc_url && <a href={detail.doc_url} target="_blank" rel="noreferrer" className="inline-block rounded-lg bg-mor-bluelight text-mor-slate px-4 py-2 font-medium hover:bg-mor-blue hover:text-white">📄 開啟詳細記錄</a>}
                <button onClick={() => shareRec(detail)} className="inline-block rounded-lg border border-mor-line px-4 py-2 font-medium hover:bg-mor-sand/60">↗ 分享</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
