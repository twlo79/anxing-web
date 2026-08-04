'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import { parseRows, cleanCounts, splitAssignees, staffLookup, type HkStaff, type HkProperty } from '@/lib/hkParse';

/**
 * 房務排班統計。
 *
 * 兩種計數方式並存,這是整頁的核心:
 *   間數     = 某人某日的工作項數。兩人合掃 → 各 +1
 *   打掃次數 = Σ_日期 MAX_over_人(該人當日在該房源的筆數)。兩人合掃 → 只算 1
 *
 * 次數要乘上「幾床」推算床單,用人頭計次會讓布巾量翻倍。
 */

type Ev = {
  id: string; period: string; event_date: string; title: string;
  assignees: string[]; parsed_code: string | null; work_type: string | null;
  excluded: string | null;
};
type Wi = {
  id: string; period: string; work_date: string; property_code: string | null;
  work_type: string; staff_id: string; source?: string; note?: string | null;
};
type Day = { period: string; work_date: string; staff_id: string; status: string | null; hours: number | null; rooms_override?: number | null };
type MP = { period: string; property_code: string; count_override: number | null; linen_taken: number };
/** 工作類型主檔。兩個開關獨立:計間數影響個人工作量,計布巾影響床單推算。 */
type WType = { code: string; name: string; count_workload: boolean; count_linen: boolean; active: boolean };
type Setting = { key: string; value: string | null };

// ab 原本叫「A、B 系」,改成棟別「時兆」—— A1~A18 與 B1~B8 全在時兆,
// 用棟別命名之後加新房號不用改標題（migration_64）
const GROUP_LABEL: Record<string, string> = { kai: '房源（開整棟系）', ab: '時兆', zl: '正隆', other: '其他（未列於三表）' };
const GROUPS = ['kai', 'ab', 'zl', 'other'] as const;
const WORK_TYPES = ['退房清潔', '入住清潔', '換房清潔', '細清', '公區清潔', '贈品補充', '點交', '拆備品', '清潔', '其他工時'];
const LEAVE_OPTS = ['', '休', '特休', '請假', '颱風假', '報到'];

const ymOf = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const daysIn = (period: string) => {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(4, 6));
  return new Date(y, m, 0).getDate();
};
const dateStr = (period: string, d: number) =>
  `${period.slice(0, 4)}-${period.slice(4, 6)}-${String(d).padStart(2, '0')}`;

export default function HousekeepingPage() {
  const supabase = createClient();
  const [period, setPeriod] = useState(ymOf(new Date()));
  // 排班與布巾放在同一頁 —— 改一格房源要能立刻看到布巾跟著動,分頁會讓人來回切
  const [tab, setTab] = useState<'sheet' | 'exception'>('sheet');
  const [staff, setStaff] = useState<HkStaff[]>([]);
  const [props, setProps] = useState<HkProperty[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [items, setItems] = useState<Wi[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [mps, setMps] = useState<MP[]>([]);
  const [wtypes, setWtypes] = useState<WType[]>([]);
  const [settings, setSettings] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ it: Wi; until: number } | null>(null);
  /** 正在新增房源格的儲存格 */
  const [adding, setAdding] = useState<{ date: string; staffId: string; code: string; type: string } | null>(null);
  /** 就地編輯某個房源格 */
  const [editItem, setEditItem] = useState<{ id: string; staffId: string; code: string; type: string } | null>(null);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const loadMaster = useCallback(async () => {
    const [s, p, w, st] = await Promise.all([
      supabase.from('hk_staff').select('*').eq('active', true).order('sort'),
      supabase.from('hk_property').select('*').eq('active', true).order('sort'),
      supabase.from('hk_work_type').select('*'),
      supabase.from('hk_setting').select('key, value'),
    ]);
    setStaff((s.data ?? []) as HkStaff[]);
    setProps((p.data ?? []) as HkProperty[]);
    setWtypes((w.data ?? []) as WType[]);
    setSettings(Object.fromEntries(((st.data ?? []) as Setting[]).map((x) => [x.key, x.value])));
  }, [supabase]);

  const loadPeriod = useCallback(async () => {
    setLoading(true);
    const [e, w, d, m] = await Promise.all([
      supabase.from('hk_event').select('*').eq('period', period).order('event_date'),
      supabase.from('hk_work_item').select('*').eq('period', period).order('work_date'),
      supabase.from('hk_day').select('*').eq('period', period),
      supabase.from('hk_month_property').select('*').eq('period', period),
    ]);
    setEvents((e.data ?? []) as Ev[]);
    setItems((w.data ?? []) as Wi[]);
    setDays((d.data ?? []) as Day[]);
    setMps((m.data ?? []) as MP[]);
    setLoading(false);
  }, [supabase, period]);

  useEffect(() => { loadMaster(); }, [loadMaster]);
  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  const staffById = useMemo(() => Object.fromEntries(staff.map((s) => [s.id, s as any])), [staff]);
  const roomStaff = useMemo(() => staff.filter((s) => s.count_mode === 'rooms'), [staff]);
  const hourStaff = useMemo(() => staff.filter((s) => s.count_mode === 'hours'), [staff]);
  const propByCode = useMemo(() => Object.fromEntries(props.map((p) => [p.code, p])), [props]);

  // ── 設定（hk_setting / hk_work_type） ───────────────────────
  // 這些開關以前是寫死的，設定頁按了沒反應。現在真的接上計算。
  const countMode = (settings['count_mode'] === 'headcount' ? 'headcount' : 'clean') as 'clean' | 'headcount';
  const includeGift = settings['include_gift'] !== 'false';

  const wtMap = useMemo(() => Object.fromEntries(wtypes.map((w) => [w.code, w])), [wtypes]);
  /** 主檔沒有這個類型時預設兩個開關都開 —— 不能因為漏建檔就讓資料靜靜消失 */
  const wt = useCallback((code: string) => wtMap[code] ?? { count_workload: true, count_linen: true }, [wtMap]);

  /**
   * 計間數用的工作項。
   * 「贈品補充」若被設定成不計，或該工作類型的「計間數」被關掉，就不算進個人工作量。
   */
  const roomItems = useMemo(() => items.filter((i) => {
    if (!includeGift && i.work_type === '贈品補充') return false;
    return wt(i.work_type).count_workload !== false;
  }), [items, includeGift, wt]);

  /**
   * 計布巾用的工作項。條件比間數多一層：
   *   工作類型要計布巾（點交、拆備品、公區清潔預設不計）
   *   而且該房源本身也要計布巾（hk_property.count_linen）
   * 兩個都通過才會進入打掃次數 → 床數 → 床單。
   */
  const linenItems = useMemo(() => items.filter((i) => {
    if (!includeGift && i.work_type === '贈品補充') return false;
    if (wt(i.work_type).count_linen === false) return false;
    if (i.property_code && propByCode[i.property_code]?.count_linen === false) return false;
    return true;
  }), [items, includeGift, wt, propByCode]);

  /** 每人每日間數（由房源格推導的自動值） */
  const autoRooms = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of roomItems) m[`${i.work_date}|${i.staff_id}`] = (m[`${i.work_date}|${i.staff_id}`] ?? 0) + 1;
    return m;
  }, [roomItems]);

  const dayMap = useMemo(
    () => Object.fromEntries(days.map((d) => [`${d.work_date}|${d.staff_id}`, d])), [days]);

  /**
   * 實際採用的間數:手動覆寫優先,否則用自動值。
   * 兩個數字並存,不互相覆蓋 —— 月底發現數字不對才查得出是哪裡多出來的。
   */
  const roomCount = useMemo(() => {
    const m: Record<string, number> = { ...autoRooms };
    for (const d of days) {
      if (d.rooms_override != null) m[`${d.work_date}|${d.staff_id}`] = d.rooms_override;
    }
    return m;
  }, [autoRooms, days]);

  /** 打掃次數（自動值）。計法由 hk_setting.count_mode 決定，手動覆寫在 mpMap。 */
  const autoCounts = useMemo(() => cleanCounts(linenItems, countMode), [linenItems, countMode]);
  const mpMap = useMemo(() => Object.fromEntries(mps.map((m) => [m.property_code, m])), [mps]);
  const countOf = (code: string) => mpMap[code]?.count_override ?? autoCounts[code] ?? 0;
  const linenOf = (code: string) => mpMap[code]?.linen_taken ?? 0;

  const dayList = useMemo(() => {
    const n = daysIn(period);
    return Array.from({ length: n }, (_, i) => dateStr(period, i + 1));
  }, [period]);

  /** 某日的工作項,依人分組並保持「先 Una 後庭玉」的順序 */
  const itemsOfDay = useCallback((date: string) => {
    const out: Wi[] = [];
    for (const s of staff) for (const i of items) {
      if (i.work_date === date && i.staff_id === s.id) out.push(i);
    }
    return out;
  }, [items, staff]);

  // ── 匯入 ───────────────────────────────────────────
  const preview = useMemo(() => {
    if (!raw.trim() || !staff.length) return null;
    const rows = raw.trim().split('\n').map((l) => {
      const parts = l.split(/[,\t]/).map((x) => x.trim());
      return { date: parts[0], title: parts[1] ?? '', assignees: parts.slice(2).join(',') };
    }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    const parsed = parseRows(rows, staff, props, { includeGift });
    const unknownNames = new Set<string>();
    for (const r of rows) {
      for (const n of splitAssignees(r.assignees)) {
        if (!staffLookup(staff).has(n)) unknownNames.add(n);
      }
    }
    return { rows, parsed, unknownNames: Array.from(unknownNames) };
  }, [raw, staff, props, includeGift]);

  async function doImport() {
    if (!preview) return;
    const { parsed } = preview;
    const per = parsed[0]?.date.slice(0, 7).replace('-', '') ?? period;
    if (!confirm(`匯入 ${parsed.length} 筆到 ${per}?\n\n同月份的既有資料會先清空再重建。`)) return;
    setBusy(true);
    try {
      // 全刪重建。解析規則會改,增量更新會讓新舊規則的結果混在同一個月裡。
      await supabase.from('hk_work_item').delete().eq('period', per);
      await supabase.from('hk_event').delete().eq('period', per);

      const byName = staffLookup(staff);
      for (const e of parsed) {
        // 入住準備組完全不匯入
        const known = e.assigneeNames.map((n) => byName.get(n)).filter(Boolean) as HkStaff[];
        if (e.excluded === 'not_counted' && !known.some((s) => s.count_mode !== 'none')) continue;

        const { data: ev, error } = await supabase.from('hk_event').insert({
          period: per, event_date: e.date, title: e.title,
          assignees: e.assigneeNames, parsed_code: e.propertyCode,
          work_type: e.workType, excluded: e.excluded,
        }).select('id').single();
        if (error) { flash('匯入失敗:' + error.message); return; }

        // 休假寫進 hk_day,不產生工作項
        if (e.excluded === 'leave') {
          const s = staff.find((x) => x.code === e.leaveStaffCode);
          if (s) {
            const status = e.title.includes('颱風') ? '颱風假' : '休';
            await supabase.from('hk_day').upsert({
              period: per, work_date: e.date, staff_id: s.id, status,
            }, { onConflict: 'work_date,staff_id' });
          }
          continue;
        }
        if (e.excluded) continue;

        const rows = known.filter((s) => s.count_mode !== 'none').map((s) => ({
          event_id: ev.id, period: per, work_date: e.date,
          property_code: e.propertyCode, work_type: e.workType, staff_id: s.id,
        }));
        if (rows.length) await supabase.from('hk_work_item').insert(rows);
      }
      setPeriod(per); setImportOpen(false); setRaw('');
      flash('匯入完成'); loadPeriod();
    } finally { setBusy(false); }
  }

  // ── 編輯 ───────────────────────────────────────────
  /**
   * 出勤狀態機（附錄 A A0.1）。規則只有兩條:
   *   有房源就不能設休假 / 設了休假就不能加房源
   * 所有 UI 行為都由這裡推導,不在各處各寫一份判斷。
   */
  function canAddItem(date: string, staffId: string) {
    return !dayMap[`${date}|${staffId}`]?.status;
  }
  function blockLeaveReason(date: string, staffId: string) {
    const n = roomCount[`${date}|${staffId}`] ?? 0;
    if (!n) return null;
    const codes = items.filter((i) => i.work_date === date && i.staff_id === staffId)
      .map((i) => i.property_code ?? i.work_type);
    return `當日已有 ${n} 個房源（${codes.join('、')}）,要先移除才能設休假。`;
  }

  /** 手動新增的工作項。source='manual' —— 下次同步永不刪除它。 */
  async function addItem(date: string, staffId: string, code: string, type: string) {
    if (!canAddItem(date, staffId)) return flash('休假日不能新增房源');
    const row = {
      period, work_date: date, property_code: code || null,
      work_type: type, staff_id: staffId, source: 'manual',
    };
    const { data, error } = await supabase.from('hk_work_item').insert(row).select('*').single();
    if (error) return flash('新增失敗:' + error.message);
    setItems((xs) => [...xs, data as Wi]);
  }

  /**
   * 改房源格。同步來的項目被改過要標記 timetree_edited ——
   * 下次同步才知道這筆使用者動過,不能直接覆蓋。
   */
  async function saveItem() {
    if (!editItem) return;
    const cur = items.find((x) => x.id === editItem.id);
    const patch: any = {
      property_code: editItem.code || null,
      work_type: editItem.type,
      staff_id: editItem.staffId,
      source: cur?.source === 'manual' ? 'manual' : 'timetree_edited',
    };
    setItems((xs) => xs.map((x) => (x.id === editItem.id ? { ...x, ...patch } : x)));
    setEditItem(null);
    const { error } = await supabase.from('hk_work_item').update(patch).eq('id', editItem.id);
    if (error) { flash('儲存失敗:' + error.message); loadPeriod(); }
  }

  async function delItem(it: Wi) {
    setItems((xs) => xs.filter((x) => x.id !== it.id));
    const { error } = await supabase.from('hk_work_item').delete().eq('id', it.id);
    if (error) { flash('刪除失敗:' + error.message); loadPeriod(); return; }
    // 5 秒內可復原。刪一格不該跳確認彈窗 —— 一天要刪十幾格的話會很煩,
    // 但誤刪又不能沒救,所以用 undo 而不是 confirm。
    setUndo({ it, until: Date.now() + 5000 });
    setTimeout(() => setUndo((u) => (u && u.it.id === it.id ? null : u)), 5000);
  }

  async function doUndo() {
    if (!undo) return;
    const { id, ...rest } = undo.it as any;
    const { data, error } = await supabase.from('hk_work_item').insert(rest).select('*').single();
    if (error) return flash('復原失敗:' + error.message);
    setItems((xs) => [...xs, data as Wi]);
    setUndo(null);
  }

  async function setDay(date: string, staffId: string, patch: Partial<Day>) {
    if (patch.status) {
      const reason = blockLeaveReason(date, staffId);
      if (reason) return flash(reason);
    }
    const cur = dayMap[`${date}|${staffId}`];
    const next = { period, work_date: date, staff_id: staffId, status: cur?.status ?? null, hours: cur?.hours ?? null, ...patch };
    setDays((ds) => {
      const rest = ds.filter((d) => !(d.work_date === date && d.staff_id === staffId));
      return [...rest, next as Day];
    });
    await supabase.from('hk_day').upsert(next, { onConflict: 'work_date,staff_id' });
  }

  /** 幾床是房源主檔的屬性,不是月份的。改了會影響所有月份的重算。 */
  async function setBeds(code: string, beds: number | null) {
    setProps((ps) => ps.map((p) => (p.code === code ? { ...p, beds } : p)));
    const { error } = await supabase.from('hk_property').update({ beds }).eq('code', code);
    if (error) { flash('儲存失敗:' + error.message); loadMaster(); }
  }

  async function setMp(code: string, patch: Partial<MP>) {
    const cur = mpMap[code];
    const next = { period, property_code: code, count_override: cur?.count_override ?? null, linen_taken: cur?.linen_taken ?? 0, ...patch };
    setMps((ms) => [...ms.filter((m) => m.property_code !== code), next as MP]);
    await supabase.from('hk_month_property').upsert(next, { onConflict: 'period,property_code' });
  }

  // ── 匯出 ───────────────────────────────────────────
  function exportXlsx() {
    const head: any[] = ['日期', ...roomStaff.map((s) => `${s.name}/間數`), ...hourStaff.map((s) => `${s.name}/時數`), '房源'];
    const body = dayList.map((d) => {
      const row: any[] = [d];
      for (const s of roomStaff) {
        const st = dayMap[`${d}|${s.id}`]?.status;
        row.push(st ? st : (roomCount[`${d}|${s.id}`] ?? ''));
      }
      for (const s of hourStaff) row.push(dayMap[`${d}|${s.id}`]?.hours ?? '');
      for (const it of itemsOfDay(d)) row.push(it.work_type === '贈品補充' ? `${it.property_code ?? ''}-贈` : (it.property_code ?? it.work_type));
      return row;
    });
    const sheet = [head, ...body, []];

    for (const g of GROUPS) {
      const list = props.filter((p) => p.linen_group === g);
      if (!list.length) continue;
      sheet.push([GROUP_LABEL[g], '次數', '幾床', '床數', '拿床單', '小計']);
      let sub = 0;
      for (const p of list) {
        const c = countOf(p.code), b = p.beds ?? 0, lt = linenOf(p.code);
        sheet.push([p.code, c, p.beds ?? '', c * b, lt, c * b + lt]);
        sub += c * b + lt;
      }
      sheet.push(['小計', '', '', '', '', sub]);
      sheet.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(sheet);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, period);
    XLSX.writeFile(wb, `${period}_房務排班統計.xlsx`);
  }

  const exceptions = useMemo(() => ({
    noAssignee: events.filter((e) => e.excluded === 'no_assignee'),
    unknownProp: events.filter((e) => !e.excluded && !e.parsed_code
      && !['協助行政', '洗烘折毛巾'].some((k) => e.title.includes(k))),
    noBeds: Array.from(new Set(items.map((i) => i.property_code).filter(Boolean) as string[]))
      .filter((c) => propByCode[c]?.beds == null),
    heavy: Object.entries(autoCounts).filter(([, n]) => n >= 3),
  }), [events, items, propByCode, autoCounts]);

  const totalLinen = useMemo(() => {
    let t = 0;
    for (const p of props) t += countOf(p.code) * (p.beds ?? 0) + linenOf(p.code);
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, mpMap, autoCounts]);

  const inp = 'rounded border border-gray-300 px-1.5 py-1 text-xs';
  const tabBtn = (k: typeof tab, label: string) => (
    <button onClick={() => setTab(k)}
      className={`px-4 h-10 rounded-lg text-sm font-medium ${tab === k ? 'bg-mor-slate text-white' : 'bg-white border border-mor-line text-gray-600'}`}>
      {label}
    </button>
  );

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-3 py-2 text-sm">{msg}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input type="month" value={`${period.slice(0, 4)}-${period.slice(4, 6)}`}
          onChange={(e) => setPeriod(e.target.value.replace('-', ''))}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        <div className="ml-auto flex gap-2">
          <Link href="/housekeeping/settings"
            className="rounded-lg border border-mor-line px-3 py-1.5 text-sm text-gray-600 hover:bg-mor-sand/60">⚙ 設定</Link>
          <button onClick={() => setImportOpen(true)}
            className="rounded-lg border border-mor-slate text-mor-slate px-3 py-1.5 text-sm font-medium hover:bg-mor-sand/60">⬆ 匯入排班</button>
          <button onClick={exportXlsx} disabled={!items.length}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">⬇ 下載 Excel</button>
        </div>
      </div>

      {/* 摘要 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {roomStaff.map((s) => {
          const total = dayList.reduce((a, d) => a + (roomCount[`${d}|${s.id}`] ?? 0), 0);
          const leave = dayList.filter((d) => dayMap[`${d}|${s.id}`]?.status).length;
          return (
            <div key={s.id} className="rounded-xl bg-white border border-mor-line p-4 min-w-0">
              <div className="text-xs text-gray-500">{s.name}</div>
              <div className="stat-num font-bold mt-1">{total} <span className="text-sm font-normal text-gray-400">間</span></div>
              <div className="text-xs text-gray-400 mt-0.5">休假 {leave} 天</div>
            </div>
          );
        })}
        {hourStaff.map((s) => {
          const total = dayList.reduce((a, d) => a + Number(dayMap[`${d}|${s.id}`]?.hours ?? 0), 0);
          return (
            <div key={s.id} className="rounded-xl bg-white border border-mor-line p-4 min-w-0">
              <div className="text-xs text-gray-500">{s.name}</div>
              <div className="stat-num font-bold mt-1">{total} <span className="text-sm font-normal text-gray-400">小時</span></div>
              <div className="text-xs text-gray-400 mt-0.5">手動填寫</div>
            </div>
          );
        })}
        <div className="rounded-xl bg-mor-slate text-white p-4 min-w-0">
          <div className="text-xs opacity-80">床單總計</div>
          <div className="stat-num font-bold mt-1">{totalLinen}</div>
          <div className="text-xs opacity-70 mt-0.5">床數 + 拿床單</div>
        </div>
      </div>

      {/* 分頁放在摘要卡片之後 —— 卡片是整月總覽,不該被分頁切掉 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {tabBtn('sheet', '房務排班與床單')}
        {tabBtn('exception', `例外 ${exceptions.noAssignee.length + exceptions.unknownProp.length + exceptions.noBeds.length}`)}
      </div>

      {loading ? <div className="text-center text-gray-400 py-16">載入中…</div>
      : !items.length && !events.length ? (
        <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center">
          <div className="text-gray-500 text-sm">{period.slice(0, 4)} 年 {Number(period.slice(4, 6))} 月還沒有排班資料</div>
          <div className="text-xs text-gray-400 mt-2 max-w-md mx-auto leading-relaxed">
            按右上角「匯入排班」貼上排班紀錄。系統會解析出每個人負責哪些房源,
            再由房源的清掃次數乘上幾床,推算床單用量。
          </div>
          <button onClick={() => setImportOpen(true)}
            className="mt-4 rounded-lg bg-mor-slate text-white px-5 py-2 text-sm font-medium hover:bg-mor-slatedark">
            匯入排班
          </button>
        </div>
      ) : tab === 'sheet' ? (
        // 左排班、右布巾。寬螢幕並排,窄螢幕上下疊 ——
        // 改一格房源要能立刻看到布巾跟著動,分開兩頁會逼人來回切。
        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_560px] gap-4 items-start">
        <div className="rounded-xl border border-mor-line bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-mor-line bg-mor-sand/40 text-left">
                <th className="px-3 py-2.5 whitespace-nowrap">日期</th>
                {roomStaff.map((s) => <th key={s.id} className="px-3 py-2.5 whitespace-nowrap">{s.name}/間數</th>)}
                {hourStaff.map((s) => <th key={s.id} className="px-3 py-2.5 whitespace-nowrap">{s.name}/時數</th>)}
                <th className="px-3 py-2.5">房源</th>
              </tr>
            </thead>
            <tbody>
              {dayList.map((d) => {
                const its = itemsOfDay(d);
                return (
                  <tr key={d} className="border-b border-mor-line/60 last:border-0">
                    <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{d.slice(5)}</td>
                    {roomStaff.map((s) => {
                      const st = dayMap[`${d}|${s.id}`]?.status ?? '';
                      const n = roomCount[`${d}|${s.id}`] ?? 0;
                      const auto = autoRooms[`${d}|${s.id}`] ?? 0;
                      const ov = dayMap[`${d}|${s.id}`]?.rooms_override;
                      return (
                        <td key={s.id} className="px-3 py-1.5 whitespace-nowrap">
                          {/* 休假是狀態不是數字,兩者互斥 */}
                          <span className="inline-flex items-center gap-1.5">
                            {st ? (
                              <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700 min-w-10 text-center">{st}</span>
                            ) : (
                              /*
                                可以直接改數字 —— 有些工作不值得為了記數而去建一個房源格。
                                但改了是「另存」不是「覆蓋」:自動值還在,tooltip 看得到,
                                清空就還原。直接改掉自動值的話,月底發現不對就查不出多在哪。
                                注意這只影響間數,不影響布巾 —— 沒有房源就沒有床單可算。
                              */
                              <input type="number" min="0" value={n || ''}
                                onChange={(e) => setDay(d, s.id, {
                                  rooms_override: e.target.value === '' ? null : Number(e.target.value),
                                })}
                                title={ov != null ? `手動覆寫（自動值 ${auto}）,清空可還原` : '由房源格自動計算,可直接改'}
                                className={`${inp} w-12 text-center font-medium ${ov != null ? 'bg-amber-50 text-amber-700 border-amber-300' : ''}`} />
                            )}
                            <select value={st} onChange={(e) => setDay(d, s.id, { status: e.target.value || null })}
                              title="標記休假"
                              className={`${inp} w-14 ${st ? 'text-amber-700' : 'text-gray-300'}`}>
                              {LEAVE_OPTS.map((o) => <option key={o} value={o}>{o || '上班'}</option>)}
                            </select>
                          </span>
                        </td>
                      );
                    })}
                    {hourStaff.map((s) => (
                      <td key={s.id} className="px-3 py-1.5">
                        <input type="number" step="0.5" min="0" value={dayMap[`${d}|${s.id}`]?.hours ?? ''}
                          onChange={(e) => setDay(d, s.id, { hours: e.target.value === '' ? null : Number(e.target.value) })}
                          className={`${inp} w-16 text-right`} />
                      </td>
                    ))}
                    {/*
                      房源格是唯一真實來源。間數、打掃次數、床單全部由這裡推導,
                      所以這裡是唯一可以新增/刪除的輸入點。
                    */}
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {its.map((it) => {
                          const s = staffById[it.staff_id];
                          const manual = it.source === 'manual';

                          // 就地編輯:點標籤展開,可以改負責人、房源、工作類型
                          if (editItem?.id === it.id) {
                            return (
                              <span key={it.id} className="inline-flex items-center gap-1 rounded bg-mor-sand/60 px-1 py-0.5">
                                <select value={editItem.staffId} onChange={(e) => setEditItem({ ...editItem, staffId: e.target.value })}
                                  className={`${inp} w-20`}>
                                  {staff.filter((x) => x.count_mode !== 'none').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                                </select>
                                <input list="hk-props" value={editItem.code} autoFocus
                                  onChange={(e) => setEditItem({ ...editItem, code: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === 'Enter') saveItem(); if (e.key === 'Escape') setEditItem(null); }}
                                  placeholder="房源" className={`${inp} w-24`} />
                                <select value={editItem.type} onChange={(e) => setEditItem({ ...editItem, type: e.target.value })}
                                  className={`${inp} w-24`}>
                                  {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button onClick={saveItem} className="text-xs text-mor-blue underline">存</button>
                                <button onClick={() => setEditItem(null)} className="text-xs text-gray-400 underline">取消</button>
                                <button onClick={() => { setEditItem(null); delItem(it); }} className="text-xs text-red-500 underline">刪除</button>
                              </span>
                            );
                          }

                          return (
                            <span key={it.id}
                              onClick={() => setEditItem({ id: it.id, staffId: it.staff_id, code: it.property_code ?? '', type: it.work_type })}
                              className="group inline-flex items-center rounded text-xs pl-1.5 pr-0.5 py-0.5 border-l-4 cursor-pointer hover:brightness-95"
                              style={{
                                backgroundColor: s?.color ? `#${s.color}` : '#f3f4f6',
                                color: s?.color_text ? `#${s.color_text}` : undefined,
                                borderLeftColor: s?.color_bar ? `#${s.color_bar}` : '#d1d5db',
                                // 虛線外框 = 手動新增,一眼看得出哪些不是同步來的
                                outline: manual ? '1px dashed #9ca3af' : undefined,
                                outlineOffset: manual ? '-1px' : undefined,
                              }}
                              title={`${s?.name ?? ''}・${it.work_type}${manual ? '・手動新增' : it.source === 'timetree_edited' ? '・已編輯' : ''}　點擊可編輯`}>
                              <span className="opacity-60 mr-0.5">{s?.name}</span>
                              {it.work_type === '贈品補充' ? `${it.property_code ?? ''}-贈` : (it.property_code ?? it.work_type)}
                              {it.source === 'timetree_edited' && <span className="ml-0.5 opacity-50" title="同步後被改過">✎</span>}
                              {/* stopPropagation:不然點刪除會先觸發外層的編輯 */}
                              <button onClick={(e) => { e.stopPropagation(); delItem(it); }}
                                className="ml-1 w-4 h-4 rounded-full opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-black/10 leading-none"
                                aria-label="刪除">×</button>
                            </span>
                          );
                        })}

                        {adding?.date === d ? (
                          <span className="inline-flex items-center gap-1">
                            <select value={adding.staffId} onChange={(e) => setAdding({ ...adding, staffId: e.target.value })} className={`${inp} w-20`}>
                              {staff.filter((s) => s.count_mode !== 'none').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <input list="hk-props" value={adding.code} autoFocus
                              onChange={(e) => setAdding({ ...adding, code: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && adding.code) {
                                  addItem(d, adding.staffId, adding.code, adding.type);
                                  setAdding({ ...adding, code: '' });   // 連續新增:存檔後停在輸入器
                                }
                                if (e.key === 'Escape') setAdding(null);
                              }}
                              placeholder="房源" className={`${inp} w-24`} />
                            <select value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value })} className={`${inp} w-24`}>
                              {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                            <button onClick={() => { if (adding.code) { addItem(d, adding.staffId, adding.code, adding.type); setAdding({ ...adding, code: '' }); } }}
                              className="text-xs text-mor-blue underline">加入</button>
                            <button onClick={() => setAdding(null)} className="text-xs text-gray-400 underline">完成</button>
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              const s = staff.find((x) => x.count_mode === 'rooms' && canAddItem(d, x.id));
                              if (!s) return flash('當日所有人員都是休假狀態,要先清除休假才能新增房源');
                              setAdding({ date: d, staffId: s.id, code: '', type: '退房清潔' });
                            }}
                            className="w-5 h-5 rounded border border-dashed border-gray-300 text-gray-400 text-xs leading-none hover:border-mor-blue hover:text-mor-blue"
                            title="新增房源">+</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-4 2xl:sticky 2xl:top-4">
          {GROUPS.map((g) => {
            const list = props.filter((p) => p.linen_group === g);
            if (!list.length) return null;
            const sub = list.reduce((a, p) => a + countOf(p.code) * (p.beds ?? 0) + linenOf(p.code), 0);
            return (
              <div key={g} className="rounded-xl border border-mor-line bg-white overflow-x-auto">
                <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40 font-medium text-sm">{GROUP_LABEL[g]}</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-mor-line/60 text-left text-xs text-gray-500">
                      <th className="px-3 py-2">房源</th>
                      <th className="px-3 py-2 text-right">次數</th>
                      <th className="px-3 py-2 text-right">幾床</th>
                      <th className="px-3 py-2 text-right">床數</th>
                      <th className="px-3 py-2 text-right">拿床單</th>
                      <th className="px-3 py-2 text-right">小計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => {
                      const auto = autoCounts[p.code] ?? 0;
                      const c = countOf(p.code);
                      const beds = p.beds ?? 0;
                      const lt = linenOf(p.code);
                      const over = mpMap[p.code]?.count_override != null;
                      return (
                        <tr key={p.code} className={`border-b border-mor-line/40 last:border-0 ${c === 0 ? 'text-gray-300' : ''}`}>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {p.code}
                            {p.beds == null && <span className="ml-1 text-[10px] text-amber-600">待補幾床</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <span className="inline-flex items-center gap-1 justify-end">
                              <input type="number" min="0" value={c}
                                onChange={(e) => setMp(p.code, { count_override: e.target.value === '' ? null : Number(e.target.value) })}
                                className={`${inp} w-14 text-right ${over ? 'bg-amber-50 text-amber-700 border-amber-300' : ''}`}
                                title={over ? `手動覆寫。房源格算出來的是 ${auto},清空可還原` : '由房源格自動計算'} />
                              {/*
                                覆寫值跟自動值不一致時要講出來。
                                不講的話,改了房源格卻看不到次數變動,會以為連動壞掉 ——
                                實際上是覆寫值一直贏過自動值,而且贏得很安靜。
                              */}
                              {over && auto !== c && (
                                <button onClick={() => setMp(p.code, { count_override: null })}
                                  title={`房源格現在算出 ${auto} 次,但這裡被手動改成 ${c}。點一下改回 ${auto}。`}
                                  className="text-[10px] text-amber-600 underline whitespace-nowrap">≠{auto}</button>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            {/* 幾床是房源主檔的屬性,改了會影響所有月份 —— 但不改就永遠算不出床單 */}
                            <input type="number" min="0" value={p.beds ?? ''}
                              onChange={(e) => setBeds(p.code, e.target.value === '' ? null : Number(e.target.value))}
                              placeholder="—"
                              title={p.beds == null ? '尚未建檔,填了才算得出床數' : '房源主檔的幾床,改了影響所有月份'}
                              className={`${inp} w-12 text-right ${p.beds == null ? 'bg-amber-50 border-amber-300' : ''}`} />
                          </td>
                          <td className="px-3 py-1.5 text-right">{c * beds}</td>
                          <td className="px-3 py-1.5 text-right">
                            <input type="number" min="0" value={lt || ''}
                              onChange={(e) => setMp(p.code, { linen_taken: Number(e.target.value) || 0 })}
                              title="額外領用的床單,跟清掃次數無關。改房源格不會把這個數字搬走。"
                              className={`${inp} w-14 text-right`} />
                          </td>
                          <td className="px-3 py-1.5 text-right font-medium">{c * beds + lt}</td>
                        </tr>
                      );
                    })}
                    <tr className="bg-mor-sand/30 font-medium">
                      <td className="px-3 py-2" colSpan={5}>小計</td>
                      <td className="px-3 py-2 text-right">{sub}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
        </div>
      ) : (
        <div className="space-y-4">
          {[
            { title: '未指派負責人', rows: exceptions.noAssignee.map((e) => `${e.event_date}　${e.title}`), hint: '這些事件沒有人負責,不計入任何統計。' },
            { title: '房源無法解析', rows: exceptions.unknownProp.map((e) => `${e.event_date}　${e.title}`), hint: '標題裡抽不出對得上主檔的房源。到設定加別名,或建立新房源後重新匯入。' },
            { title: '尚未建檔「幾床」', rows: exceptions.noBeds, hint: '這些房源有清掃紀錄但沒有床數,床單推算會少算。' },
            { title: '同月清掃 3 次以上', rows: exceptions.heavy.map(([c, n]) => `${c}　${n} 次`), hint: '可能是重複建立的事件,值得看一眼。' },
          ].map((sec) => (
            <div key={sec.title} className="rounded-xl border border-mor-line bg-white">
              <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40 flex items-center justify-between">
                <span className="font-medium text-sm">{sec.title}</span>
                <span className={`text-xs ${sec.rows.length ? 'text-amber-600' : 'text-gray-400'}`}>{sec.rows.length} 筆</span>
              </div>
              <div className="px-4 py-3 text-sm">
                <div className="text-xs text-gray-400 mb-2">{sec.hint}</div>
                {sec.rows.length === 0 ? <div className="text-gray-300 text-xs">無</div>
                : <ul className="space-y-1">{sec.rows.map((r, i) => <li key={i} className="text-gray-700">{r}</li>)}</ul>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 房源自動完成:代碼與別名都能搜 */}
      <datalist id="hk-props">
        {props.map((p) => <option key={p.code} value={p.code}>{(p.aliases ?? []).join('・')}</option>)}
      </datalist>

      {/* 刪除用 undo 不用 confirm —— 一天要刪十幾格的話彈窗會很煩,但誤刪不能沒救 */}
      {undo && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-gray-900 text-white px-4 py-2.5 text-sm shadow-lg flex items-center gap-3">
          <span>已刪除 {undo.it.property_code ?? undo.it.work_type}</span>
          <button onClick={doUndo} className="underline font-medium">復原</button>
        </div>
      )}

      {/* 匯入 */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50"
          onClick={() => setImportOpen(false)}>
          <div className="bg-white w-full md:w-[860px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
            onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between z-10">
              匯入排班
              <button onClick={() => setImportOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="p-6 space-y-3 text-sm">
              <div className="text-xs text-gray-500">
                每行一筆,格式 <code className="bg-gray-100 px-1">日期,事項,負責人</code>。
                多位負責人用 <code className="bg-gray-100 px-1">+</code> 分隔。可直接從 Excel 複製貼上。
              </div>
              <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
                placeholder={'2026-07-01,17B5-細清（不用鋪床）,SHAO-YING HSIEH + Ayu\n2026-07-02,贈-4B1*2,SHAO-YING HSIEH + Ayu'}
                className="w-full h-48 rounded-lg border border-mor-line px-2 py-2 font-mono text-xs" />

              {preview && (
                <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40 text-xs">
                  <div className="px-3 py-2 flex flex-wrap gap-4">
                    <span>共 <b>{preview.parsed.length}</b> 筆</span>
                    <span className="text-mor-green">採計 {preview.parsed.filter((p) => !p.excluded).length}</span>
                    <span className="text-amber-600">休假 {preview.parsed.filter((p) => p.excluded === 'leave').length}</span>
                    <span className="text-gray-400">不計 {preview.parsed.filter((p) => p.excluded === 'not_counted').length}</span>
                    <span className="text-red-600">未指派 {preview.parsed.filter((p) => p.excluded === 'no_assignee').length}</span>
                  </div>
                  {preview.parsed.some((p) => !p.excluded && p.unknownToken) && (
                    <div className="px-3 py-2 text-red-600">
                      未識別房源:{Array.from(new Set(preview.parsed.filter((p) => !p.excluded && p.unknownToken).map((p) => p.unknownToken))).join('、')}
                      <div className="text-gray-400 mt-0.5">仍會匯入,但不會計入打掃次數。建議先到設定補建房源或別名。</div>
                    </div>
                  )}
                  {preview.unknownNames.length > 0 && (
                    <div className="px-3 py-2 text-red-600">
                      未知人員:{preview.unknownNames.join('、')}
                      <div className="text-gray-400 mt-0.5">不在人員主檔內,這些人的工作項會被略過。</div>
                    </div>
                  )}
                  <div className="px-3 py-2 max-h-40 overflow-auto">
                    {preview.parsed.slice(0, 12).map((p, i) => (
                      <div key={i} className="flex gap-2 py-0.5">
                        <span className="text-gray-400 w-20 shrink-0">{p.date.slice(5)}</span>
                        <span className="flex-1 min-w-0 truncate">{p.title}</span>
                        <span className={`w-24 shrink-0 text-right ${p.excluded ? 'text-gray-400' : 'text-mor-blue'}`}>
                          {p.excluded === 'leave' ? '休假' : p.excluded === 'no_assignee' ? '未指派'
                            : p.excluded ? '不計' : (p.propertyCode ?? '無房源')}
                        </span>
                      </div>
                    ))}
                    {preview.parsed.length > 12 && <div className="text-gray-400 pt-1">…另有 {preview.parsed.length - 12} 筆</div>}
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
              <button onClick={() => setImportOpen(false)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={doImport} disabled={!preview || busy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {busy ? '匯入中…' : '確認匯入'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
