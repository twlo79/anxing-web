'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase';
import { cleanCounts, filterItems, buildLookup, matchProperty, type HkStaff, type HkProperty } from '@/lib/hkParse';
import { payroll, byEstate, estateLog, dailyUnits, fmtUnits } from '@/lib/hk-payroll';
import {
  cleaningCosts, laborCosts, lastDayOf, costTotal, cleanItemName, LABOR_ITEM_NAME,
} from '@/lib/hk-cost';
import { TAG_NON_CASH } from '@/lib/expense-tags';
// ★ useRef 的同步閘門 —— useState 是非同步的,連點兩下會兩筆都送出去
import { useOnce } from '@/lib/once';
import { sharePreview, previewText } from '@/lib/hk-crew';
import {
  reparsePreview, visibleRows, dismissedCount, prefillFromEvent,
  reasonOf, exceptionEvents, exAddError, canSubmitExAdd, inPeriod,
  type Reparse, type ExEvent,
} from '@/lib/hk-exception';
import { softDelete, restoreTrash } from '@/lib/trash';
import { EXPORT_TONE } from '@/components/Actions';
import StatHero from '@/components/StatHero';

/**
 * 房務排班統計（「房務管理」的一個分頁）。
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
  /**
   * 被按掉的時間（migration_188）。null = 還在例外清單上。
   *
   * ★★ 按掉是「我看過了，這筆不算」，**不是刪掉** ——
   *   三個月後有人問「八月那筆聚餐怎麼沒進統計」，要查得到是誰按的。
   */
  dismissed_at?: string | null; dismissed_by?: string | null;
};
type Wi = {
  id: string; period: string; work_date: string; property_code: string | null;
  work_type: string; staff_id: string; source?: string; note?: string | null;
  /**
   * 一筆算幾間／幾點（migration_198）。null = 照原本算。
   *
   * ★ 給「一筆等於好幾間」的工作用 —— 行事曆只寫「正隆」，
   *   實際上那天在正隆掃了四間，而使用者未必知道是哪四間房號。
   */
  units_override?: number | null; points_override?: number | null;
  /**
   * 這一列是從哪個行事曆事件長出來的（migration_188）。
   *
   * ★★★ 重新解析要靠它把房源補回工作項目 —— 只改 hk_event.parsed_code
   *   的話，事件對上了房源，但**排班表上那一格還是空的**，
   *   而間數照算、點數算不出來（2026-09-01 使用者:「沒登記進去」）。
   */
  event_id?: string | null;
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

/**
 * 匯入搬到「行事曆」分頁了（2026-08-14 使用者指定：「排班統計不匯入資料了」）。
 *
 * 匯入改變的是行事曆上的格子 —— 在統計頁按下去，畫面上只有數字跳動，
 * 看不出「誰被排到哪一天」有沒有進去。放在它會產生效果的那一頁，
 * 按完當場就看得見。
 *
 * 這一頁的空狀態因此改成把人送去行事曆，而不是留一個死路。
 */
export default function StatsTab({ onGoCalendar }: { onGoCalendar: () => void }) {
  const supabase = createClient();
  const [period, setPeriod] = useState(ymOf(new Date()));
  // 排班與布巾放在同一頁 —— 改一格房源要能立刻看到布巾跟著動,分頁會讓人來回切
  const [tab, setTab] = useState<'sheet' | 'exception'>('sheet');
  /* ── 例外清單（migration_188 的 dismissed_at 終於有人用了）── */
  const [showDismissed, setShowDismissed] = useState(false);
  /** 重新解析的預覽。null = 還沒按。★ 先看再寫（CLAUDE.md：建議，不自動） */
  const [reparse, setReparse] = useState<Reparse[] | null>(null);
  /** 「手動補」的表單。跟排班表那張是同一組欄位，只是多一個日期。 */
  const [exAdd, setExAdd] = useState<
    { evId: string; date: string; code: string; type: string; staffIds: string[];
      /** 空字串 = 沒填，照原本算。**不要用 0 當沒填** —— 0 是合法輸入 */
      units: string; points: string } | null>(null);
  /*
   * 這一輪已經補了什麼。
   *
   * ★ 連補幾筆時要看得到補過什麼 —— 沒有這個的話第三筆會忘記前兩筆，
   *   而重複的工作項目在畫面上看不出來（同一天、同一間、同一個人，只是多一列）。
   */
  const [exAdded, setExAdded] = useState<string[]>([]);
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
  const [undo, setUndo] = useState<{ it: Wi; trashId?: string; until: number } | null>(null);
  /** 正在新增房源格的儲存格 */
  /*
   * 正在新增的那一列。
   *
   * ★★★ `staffIds` 是**陣列**（2026-09-01 使用者:「不要單間計入」）。
   *   原本是單選,合掃要按兩次「加入」,而中間手滑改到房源的話
   *   兩筆就不是同一份工了 —— 各算 1 間,那個房間憑空變成兩間。
   */
  const [adding, setAdding] = useState<
    { date: string; staffIds: string[]; code: string; type: string } | null>(null);
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
  /**
   * 可以被指派房源工作的人 —— **「不統計」以外的都算**
   * （2026-09-01 使用者:「不統計的人不該能選」）。
   *
   * ★★★ 這條規則有**三個**地方在用，先前有兩份寫法:
   *
   *     解析器      hkParse.ts:341   `s.count_mode !== 'none'`   ✔
   *     排班表新增  這一頁 inline     同上（但自己寫了一次）      ✔
   *     例外補登    這一頁            `=== 'rooms'`               ✘
   *
   *   於是劉姐（計時數）匯入時會被建房源工作，手動補卻選不到她 ——
   *   兩條路對同一個人給出不同答案，而畫面上完全看不出來。
   *
   * ★ 「不統計」的（綠庭清潔、月 Dianne、Carol芊芊…）不出現:
   *   那些人補進去也不會算，給選只會讓人以為補好了。
   */
  const assignableStaff = useMemo(
    () => staff.filter((s) => s.count_mode !== 'none'), [staff]);
  const hourStaff = useMemo(() => staff.filter((s) => s.count_mode === 'hours'), [staff]);
  const propByCode = useMemo(() => Object.fromEntries(props.map((p) => [p.code, p])), [props]);


  // ── 設定（hk_setting / hk_work_type） ───────────────────────
  // 這些開關以前是寫死的，設定頁按了沒反應。現在真的接上計算。
  const countMode = (settings['count_mode'] === 'headcount' ? 'headcount' : 'clean') as 'clean' | 'headcount';
  const includeGift = settings['include_gift'] !== 'false';

  // 過濾規則放在 hkParse 而不是這裡 —— 那樣才測得到。
  // 之前把邏輯散在頁面裡，改一次就得靠肉眼比對數字。
  const { rooms: roomItems, linen: linenItems } = useMemo(
    () => filterItems(items, { workTypes: wtypes, properties: props, includeGift }),
    [items, wtypes, props, includeGift]);

  /*
   * ERP 房源的打掃點數。`hk_property.property_id` → `properties.clean_points`
   * （那座橋是 migration_124 建的）。
   *
   * 【為什麼不寫在 hk_property 上】
   * 點數是房子的性質，而 ERP 那邊已經有一份（含整棟／分層的加總規則）。
   * 房務再存一份就會有兩個真相,而漏改的那一份不會報錯 ——
   * 只會讓那個人那個月的點數少一截。
   */
  const [pointsById, setPointsById] = useState<Record<string, number>>({});
  /*
   * 房源 → 物業名稱。同一趟查回來 —— 物業是 ERP 那邊的分類
   * （`properties.estate_id` → `estates.name`），房務這邊不另存一份。
   */
  const [estateById, setEstateById] = useState<Record<string, string>>({});
  /** 房源 → 清潔費公訂價（`properties.clean_price`，migration_206）。 */
  const [priceById, setPriceById] = useState<Record<string, number>>({});
  /**
   * 物業 id → 物業名稱。
   *
   * ★ 從同一趟 properties 查詢裡順手組出來，不另外查 estates ——
   *   人事費的預覽要寫「正隆 整個物業」，而 estateById 是
   *   **房源** id → 物業名，鍵不一樣。
   */
  const [estNameById, setEstNameById] = useState<Record<string, string>>({});
  /** `properties.id` → ERP 房源名。預覽的「房源」欄。 */
  const [propNameById, setPropNameById] = useState<Record<string, string>>({});
  /**
   * `properties.id` → `estate_id`。
   *
   * ★★★ 注意跟 `estateById` 不一樣 —— 那一支存的是物業**名字**，
   *   這一支是 **uuid**。寫進 `expenses.estate_id` 要的是這一支。
   *   （2026-09-03:清潔支出一直沒寫 estate_id，支出頁的「用途」欄整欄空白）
   */
  const [estIdByProp, setEstIdByProp] = useState<Record<string, string>>({});
  /** 人事費設定（月固定）。 */
  const [labor, setLabor] = useState<any[]>([]);
  const [genOpen, setGenOpen] = useState(false);
  /** 預覽裡「支出長什麼樣子」那一段展開了沒。 */
  const [genRowsOpen, setGenRowsOpen] = useState(false);
  /**
   * 使用者在預覽裡改過的項目名稱。key 是那一列的 `hk_job_key` / `hk_labor_key`。
   *
   * ★ 只活在對話框打開的期間 —— 關掉就回到預設名字。改了名要**馬上按產生**。
   *   存起來的話又是一份要跟主檔同步的資料，而它只用一次。
   */
  const [nameBy, setNameBy] = useState<Record<string, string>>({});
  /**
   * ★★★ 這個月**已經產生過**的那些 key。
   *
   * 產生是 `upsert` ＋ `ignoreDuplicates` —— 已經在的那筆**不會被覆蓋**。
   * 所以在預覽裡改已產生那列的名字，按下去會說成功，資料庫裡還是舊名字
   * （CLAUDE.md:「RLS 擋下的 UPDATE 回成功且影響 0 列」同一種病:
   *   沒有錯誤、沒有紅字、就是沒改到）。
   *
   * 所以那幾列鎖起來標「已產生」，改名請到支出頁。
   */
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [doneLoading, setDoneLoading] = useState(false);
  useEffect(() => {
    supabase.from('properties').select('id, name, clean_points, clean_price, estate_id, estates(name)')
      .then(({ data }) => {
        const m: Record<string, number> = {};
        const pz: Record<string, number> = {};
        const e: Record<string, string> = {};
        const en: Record<string, string> = {};
        // ★ ERP 的房源名。預覽的「房源」欄要它 —— 房務代碼（亞曼尼）
        //   跟 ERP 房源（804）不是同一個字，而對不上的地方正是要看的地方
        const pn: Record<string, string> = {};
        const ei: Record<string, string> = {};
        for (const r of (data ?? []) as any[]) {
          if (r.estate_id) ei[r.id] = r.estate_id;
          if (r.clean_points != null) m[r.id] = Number(r.clean_points);
          if (r.clean_price != null) pz[r.id] = Number(r.clean_price);
          if (r.name) pn[r.id] = r.name;
          const nm = Array.isArray(r.estates) ? r.estates[0]?.name : r.estates?.name;
          if (nm) e[r.id] = nm;
          if (nm && r.estate_id) en[r.estate_id] = nm;
        }
        setPointsById(m); setPriceById(pz); setEstateById(e); setEstNameById(en);
        setPropNameById(pn); setEstIdByProp(ei);
      });
  }, [supabase]);

  /*
   * 人事費設定（migration_206）。月固定，跟清潔次數無關。
   * ★ estate_id 與 property_id 擇一 —— 開封是每個房源一個金額，
   *   正隆是整個物業 200,000（正隆沒有「整棟」那個房源，塞不進 properties）。
   */
  useEffect(() => {
    supabase.from('hk_labor_cost').select('*').eq('active', true)
      .then(({ data }) => setLabor((data ?? []) as any[]));
  }, [supabase]);



  /*
   * 每人的打掃量與報酬點數。算法在 lib/hk-payroll（有測試）——
   * 合掃各 0.5、點數 = 打掃量 × 該房源點數、算不出點數的另外報。
   *
   * **不要在這裡重寫一份。** 上方卡片、每日表格、Excel 三處都讀這一份,
   * 各算各的就會出現「卡片說 28 間、表格加起來 26.5」。
   */
  const payRows = useMemo(() => roomItems.map((i) => ({
    work_date: i.work_date,
    property_id: propByCode[i.property_code ?? '']?.property_id ?? null,
    work_type: i.work_type,
    staff_id: i.staff_id,
    // ★★★ 這兩行少了的話 migration_198 等於沒做:欄位存進去了，但算的時候看不到
    units_override: i.units_override ?? null,
    points_override: i.points_override ?? null,
    // ★ 只給日誌顯示用,不參與計算 —— 主檔對不到的房源沒有 property_id,
    //   但日誌上要看得到使用者當初打了什麼
    label: i.property_code ?? '',
  })), [roomItems, propByCode]);

  const pay = useMemo(
    () => payroll(payRows, (pid) => (pid ? pointsById[pid] : null)),
    [payRows, pointsById]);

  /*
   * 各物業的間數與點數。**跟每人卡片吃同一份 `payRows`** ——
   * 兩個數字會並排出現在畫面上，各算各的就會對不起來
   * （byEstate 有一條測試專門盯這個恆等式）。
   */
  const estateLines = useMemo(
    () => byEstate(payRows,
      (pid) => (pid ? pointsById[pid] : null),
      (pid) => (pid ? estateById[pid] : null)),
    [payRows, pointsById, estateById]);
  const estateLogs = useMemo(
    () => estateLog(payRows,
      (pid) => (pid ? pointsById[pid] : null),
      (pid) => (pid ? estateById[pid] : null)),
    [payRows, pointsById, estateById]);
  /*
   * 展開哪一個物業。**一次只開一個** —— 全部展開的話這張卡會把
   * 下面的排班表整個推出畫面，而它本來是「一眼看完」的摘要。
   */
  const [openEstate, setOpenEstate] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  /**
   * 產生本月的房務支出。
   *
   * ============================================================
   * 【★★★ 冪等靠資料庫，不靠這裡記得】
   *
   * `expenses.hk_job_key` 與 `hk_labor_key` 各有一個唯一索引
   * （migration_206）。所以按兩次只會有一份帳 ——
   * 沒有它的話重複的支出**在帳上看起來完全正常**，沒有任何地方會叫。
   *
   * ★ 用 `upsert` ＋ `ignoreDuplicates` 而不是先查再寫:
   *   先查再寫中間有空窗，兩個人同時按就會各寫一筆。
   *
   * ★★ 已經產生過的**不會被更新**。改了單價之後重按，舊那筆維持原金額 ——
   *   要改請到支出頁。自動改的話，上個月已經對過的帳會無聲變動。
   */
  /**
   * 預覽裡的「項目」格。可以直接改名 —— **但已經產生過的鎖住**。
   *
   * ★★★ 鎖的理由不是權限，是**改了沒有用**:
   *   產生走 `upsert` ＋ `ignoreDuplicates`，既有的那筆不會被覆蓋。
   *   不鎖的話使用者改完按產生，畫面說成功，資料庫裡還是舊名字 ——
   *   而這種「回成功但沒改到」正是最難查的一種
   *   （CLAUDE.md 那條 RLS 影響 0 列）。
   *
   * ★ 已產生的那列直接寫「已產生」並指出去哪裡改，
   *   不是只把輸入框變灰 —— 灰掉的欄位不會告訴人要找誰。
   */
  function nameCell(key: string, def: string) {
    if (doneKeys.has(key)) {
      return (
        <td className="px-2 py-1 text-gray-400">
          <span className="truncate align-middle">{def}</span>
          <span className="ml-1 rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 whitespace-nowrap">已產生</span>
        </td>
      );
    }
    return (
      <td className="px-2 py-1">
        <input
          value={nameBy[key] ?? def}
          onChange={(e) => setNameBy({ ...nameBy, [key]: e.target.value })}
          className="w-full rounded border border-gray-300 px-1.5 py-0.5 text-[11px]"
        />
      </td>
    );
  }

  async function generateInner() {
    if (!gen.rows.length && !gen.lab.length) return flash('沒有可以產生的支出');
    setGenBusy(true);
    try {
      const mk = (r: any) => ({
        spent_on: r.spent_on ?? r.work_date,
        item_name: r.item_name,
        amount: r.amount,
        account_code: 'hk_cleaning',
        purpose_type: 'estate',
        property_id: r.property_id ?? null,
        estate_id: r.estate_id ?? null,
        // ★ 使用者指定「付款方式 無」—— 這幾筆是內部成本認列,錢還沒真的匯出去
        payment_method: null,
        tags: [TAG_NON_CASH],
        no_voucher: true,
        hk_job_key: r.key_job ?? null,
        hk_labor_key: r.key_labor ?? null,
      });

      const cleanRows = gen.rows.map((r) => mk({
        work_date: r.work_date, amount: r.amount, property_id: r.property_id,
        // ★★ 物業要一起寫。只給 property_id 的話支出頁的「用途」欄是空的
        //   —— 那一欄讀的是 estate_id（2026-09-03）
        estate_id: estIdByProp[r.property_id] ?? null,
        // ★ 使用者在預覽裡改過就用他的。空字串當成沒改 —— 不讓項目變空白
        item_name: nameBy[r.key]?.trim() || cleanItemName(r.label, r.units),
        key_job: r.key,
      }));
      const laborRows = gen.lab.map((r) => mk({
        spent_on: r.spent_on, amount: r.amount,
        property_id: r.property_id, estate_id: r.estate_id,
        item_name: nameBy[r.key]?.trim() || LABOR_ITEM_NAME,
        key_labor: r.key,
      }));

      let made = 0;
      for (const [rows, conflict] of [
        [cleanRows, 'hk_job_key'], [laborRows, 'hk_labor_key'],
      ] as const) {
        if (!rows.length) continue;
        const { data, error } = await supabase.from('expenses')
          .upsert(rows, { onConflict: conflict, ignoreDuplicates: true })
          .select('id');
        if (error) { flash('產生失敗：' + error.message); return; }
        made += data?.length ?? 0;
      }
      /*
       * ★★ `made` 是**真的新增**的筆數。全部都已經產生過的話會是 0 ——
       *   那不是失敗，要講清楚，不然使用者會一直按。
       */
      flash(made === 0
        ? '這個月的支出都已經產生過了，沒有新增任何一筆'
        : `已產生 ${made} 筆支出（共 $${costTotal([...cleanRows, ...laborRows]).toLocaleString('en-US')}）`);
      setGenOpen(false);
    } finally { setGenBusy(false); }
  }
  const [doGenerate] = useOnce(generateInner);

  /*
   * ★★★ 產生預覽 —— **按下去之前先看到錢**。
   *
   *   清潔費吃的是 `estateLog` 攤平後的 job（一份工一列，合掃已經合併）。
   *   合掃付一份不是兩份（2026-09-02 使用者確認）——
   *   用打掃量那套的話，正隆一間合掃就付 18,000。
   */
  /*
   * 開預覽時查一次「這個月已經產生過哪些」。
   *
   * ★ 只查 key 兩欄，不撈整列 —— 這是用來鎖畫面的，不是拿來對帳的。
   * ★★ 不分頁。key 的數量 ＝ 這個月的清潔次數 ＋ 人事費筆數，
   *   離 Supabase 那 1000 列的天花板還很遠（八月是 17 筆）。
   *   真的破千的話這裡會安靜漏掉 —— 所以順手把筆數也記下來檢查。
   */
  useEffect(() => {
    if (!genOpen) return;
    let alive = true;
    setDoneLoading(true);
    supabase.from('expenses')
      .select('hk_job_key, hk_labor_key')
      .or('hk_job_key.not.is.null,hk_labor_key.not.is.null')
      .limit(2000)
      .then(({ data, error }) => {
        if (!alive) return;
        setDoneLoading(false);
        // ★ 查不到就當作「都還沒產生」—— 寧可讓人能編，也不要無聲鎖住整張表
        if (error) return setDoneKeys(new Set());
        const k = new Set<string>();
        for (const r of (data ?? []) as any[]) {
          if (r.hk_job_key) k.add(r.hk_job_key);
          if (r.hk_labor_key) k.add(r.hk_labor_key);
        }
        setDoneKeys(k);
      });
    return () => { alive = false; };
  }, [genOpen, supabase]);

  const gen = useMemo(() => {
    const jobs = [...estateLogs.values()].flat();
    const { rows, unpriced } = cleaningCosts(jobs, (pid) => priceById[pid]);
    const lab = laborCosts(labor as any, period);
    return { rows, unpriced, lab,
             total: costTotal(rows) + costTotal(lab) };
  }, [estateLogs, priceById, labor, period]);
  /** 這次預覽裡有幾筆是已經產生過的。 */
  const doneNum = useMemo(
    () => [...gen.rows, ...gen.lab].filter((r) => doneKeys.has(r.key)).length,
    [gen, doneKeys]);

  const estateMax = Math.max(1, ...estateLines.map((e) => e.points));
  const estateTotal = estateLines.reduce(
    (a, e) => ({ units: a.units + e.units, points: a.points + e.points }), { units: 0, points: 0 });
  /*
   * ★★★ 時薪人員（劉姐）做的間數也在各物業裡，但**上面的人員卡片不會顯示**
   *   —— `roomStaff` 只挑 count_mode === 'rooms' 的人（第 168 行）。
   *
   *   結果是同一個畫面上兩個總數對不起來:各物業合計 65.5，
   *   而 Una ＋ 庭玉只有 52.5。使用者去對帳時會以為系統算錯
   *   （2026-09-02 驗算時發現，使用者選「留著，但卡片要講明」）。
   *
   * ★ 房子確實被掃了，所以物業統計含它是對的 —— 要修的是**說出來**。
   *   用 `pay`（每人合計）取，跟卡片同一份資料，不另外算一次。
   */
  const hoursUnits = hourStaff.reduce((a, s) => a + (pay.get(s.id)?.units ?? 0), 0);

  /**
   * 每人每日間數（由房源格推導的自動值）。
   *
   * 【合掃各 0.5】（2026-08-17 使用者指定）
   * 原本是「一筆算一間」—— 07-01 Una 與庭玉一起清 17B5，兩邊都算 1，
   * 那一間就被算成兩間。
   *
   * 改用 lib/hk-payroll 的 dailyUnits，跟上方卡片同一套規則 ——
   * 各算各的就會出現「表格逐日加起來 40、卡片說 34.5」。
   */
  const autoRooms = useMemo(() => {
    const d = dailyUnits(roomItems.map((i) => ({
      work_date: i.work_date,
      property_id: propByCode[i.property_code ?? '']?.property_id ?? i.property_code ?? null,
      work_type: i.work_type,
      staff_id: i.staff_id,
    })));
    return Object.fromEntries(d);
  }, [roomItems, propByCode]);

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

  /**
   * 手動新增的工作項。source='manual' —— 下次同步永不刪除它
   * （route.ts 的 delete 帶了 `.eq('source','timetree')`，2026-09-01 補上的）。
   *
   * ============================================================
   * 【★★★ 一次收好幾個人】（2026-09-01 使用者:「不要單間計入」）
   *
   * 合掃是常態，而分攤的分母是「同一天、同一間、同一種工作的全部人」。
   * 一個一個加的話中間會經過「只有一個人」的狀態 —— 那本身沒問題
   * （每次加完都會重算），但**操作上很容易加完第一個就跑掉**，
   * 結果那個人被記成掃了一整間。
   *
   * ★ 一次寫進去，就不會有「只加到一半」的中間狀態。
   *
   * ★★ 休假的人**個別跳過**，不是整批失敗 ——
   *   勾了三個人其中一個休假就全部不給加的話，
   *   使用者得自己回去看是誰，而畫面沒說。
   */
  /**
   * @returns 真的寫進去了沒有。
   *
   * ★★★ 一定要回報（2026-09-01 使用者:「登完一筆無法登第二筆」）。
   *   原本三條失敗路徑都 `return flash(...)`，也就是回 `undefined` ——
   *   而呼叫端沒有檢查，於是「休假擋下來」「RLS 擋下來」的時候
   *   照樣把那筆記成「已補」並且把來源事件按掉。
   *   結果是:例外清單少一筆、統計沒有多一筆，**兩邊都沒有錯誤訊息**。
   */
  async function addItems(
    date: string, staffIds: string[], code: string, type: string,
    /**
     * 一筆算幾間／幾點（migration_198）。null = 照原本算。
     * ★ **不要用 0 當「沒填」** —— 0 是合法輸入（「這一筆不算間數，只記點數」）。
     */
    unitsOv: number | null = null, pointsOv: number | null = null,
  ): Promise<boolean> {
    const ok = staffIds.filter((id) => canAddItem(date, id));
    const skipped = staffIds.length - ok.length;
    if (ok.length === 0) { flash('這幾位當天都是休假,要先清除休假才能新增房源'); return false; }

    /*
     * ★★ 日期不在這個月的話 `period` 會對不上 —— 那筆寫得進去，
     *   但它屬於另一個月份，這個月的統計看不到它，
     *   而使用者以為補好了（補登表單的日期是可以改的）。
     */
    // ★★★ 用 inPeriod 不要用 startsWith —— 日期有橫線、period 沒有,
    //   `'2026-08-20'.startsWith('202608')` 永遠是 false,
    //   於是這個守衛把每一次補登都擋掉（2026-09-02 踩過,見 hk-exception.ts）
    if (!inPeriod(date, period)) {
      flash(`${date} 不在 ${period} 這個月，請先切換月份再補`);
      return false;
    }

    const rows = ok.map((staff_id) => ({
      period, work_date: date, property_code: code || null,
      work_type: type, staff_id, source: 'manual',
      units_override: unitsOv, points_override: pointsOv,
    }));
    const { data, error } = await supabase.from('hk_work_item').insert(rows).select('*');
    if (error) { flash('新增失敗:' + error.message); return false; }
    // ★ RLS 擋下的 insert 會回成功而且 0 列（CLAUDE.md 的坑）
    if (!data || data.length === 0) { flash('沒有寫入任何資料 —— 可能是權限不足'); return false; }
    setItems((xs) => [...xs, ...(data as Wi[])]);
    if (skipped > 0) flash(`已加入 ${ok.length} 筆，另外 ${skipped} 位當天休假已跳過`);
    return true;
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
    const r = await softDelete(supabase, 'hk_work_item', it.id, '房務排班刪除');
    if (!r.ok) { flash(r.message); loadPeriod(); return; }
    // 5 秒內可復原。刪一格不該跳確認彈窗 —— 一天要刪十幾格的話會很煩,
    // 但誤刪又不能沒救,所以用 undo 而不是 confirm。
    // 過了 5 秒也還救得回來,只是要去回收桶找。
    setUndo({ it, trashId: r.trashId, until: Date.now() + 5000 });
    setTimeout(() => setUndo((u) => (u && u.it.id === it.id ? null : u)), 5000);
  }

  async function doUndo() {
    if (!undo) return;
    // 走回收桶復原而不是重新 insert —— 這樣 id 跟原本一樣,
    // 排班表上其他地方引用到這格的話不會突然指到一筆不存在的資料。
    if (!undo.trashId) return flash('復原失敗:找不到回收紀錄,請到刪除紀錄頁處理。');
    const r = await restoreTrash(supabase, undo.trashId);
    if (!r.ok) return flash(r.message);
    setItems((xs) => [...xs, undo.it]);
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
      // 跟畫面同一條規則:本月沒排到、也沒手動填拿床單的不匯出
      const list = props.filter((p) => p.linen_group === g
        && (countOf(p.code) > 0 || linenOf(p.code) > 0));
      if (!list.length) continue;
      sheet.push([GROUP_LABEL[g], '次數', '床數', '更換床數', '拿床單', '小計']);
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

  /* ══════════════════════════════════════════════════════════
   * 例外清單的三個動作（2026-09-01 使用者:「還是沒有按掉的功能阿」）
   * ══════════════════════════════════════════════════════════ */

  /**
   * 用**現在**的房源主檔重新解析。
   *
   * ★★★ 為什麼需要這個:`hk_event.parsed_code` 是匯入當下算好存起來的
   *   （見 import-panel.tsx 與 api/import/housekeeping/route.ts）——
   *   後來才補的別名不會回頭修既有資料。
   *   八月匯入時還沒有 J1→JPR1F，那幾筆就永遠躺在例外清單裡，
   *   而看的人會以為別名沒生效，跑去再加一次。
   */
  const lookup = useMemo(() => buildLookup(props), [props]);
  function previewReparse() {
    const list = reparsePreview(events as ExEvent[], (t) => matchProperty(t, lookup).code);
    setReparse(list);
    if (!list.length) flash('用現在的別名重對一次，沒有任何一筆對得上');
  }

  /**
   * 確認寫入。
   *
   * ★★★ **兩張表都要寫**（2026-09-01 使用者:「沒登記進去」）。
   *
   *   hk_event.parsed_code       事件對到哪個房源
   *   hk_work_item.property_code 排班表那一格顯示什麼、點數算哪一間
   *
   *   只寫前者的話:事件離開例外清單、間數照算，
   *   但**排班表那一格是空的**（畫面上是「庭玉 清潔」而不是「庭玉 JPR2F」），
   *   而且打掃點數算不出來 —— 也就是卡片上那個「⚠ N 筆未計」。
   *   使用者看到的是「按了重新解析，但沒登記進去」。
   *
   * ★★ 只補**還是空的**那些格（`property_code is null`）——
   *   有人手動填過的不覆蓋。人填的優先於推導的。
   */
  async function applyReparse() {
    if (!reparse?.length) return;
    let ok = 0;
    let cells = 0;
    for (const r of reparse) {
      const { data, error } = await supabase.from('hk_event')
        .update({ parsed_code: r.code }).eq('id', r.id).select('id');
      if (error) return flash('重新解析失敗:' + error.message);
      /*
       * ★★ RLS 擋下的 UPDATE 會回成功而且影響 0 列（CLAUDE.md 的坑）。
       *   不數的話，沒有權限的人會看到「已更新 5 筆」而一筆都沒變。
       */
      if (!data?.length) continue;
      ok += 1;

      const { data: wi, error: we } = await supabase.from('hk_work_item')
        .update({ property_code: r.code })
        .eq('event_id', r.id).is('property_code', null).select('id');
      if (we) return flash('房源補進排班表時失敗:' + we.message);
      cells += wi?.length ?? 0;
    }
    setEvents((xs) => xs.map((e) => {
      const hit = reparse.find((r) => r.id === e.id);
      return hit ? { ...e, parsed_code: hit.code } : e;
    }));
    setItems((xs) => xs.map((w) => {
      const hit = w.event_id && !w.property_code
        ? reparse.find((r) => r.id === w.event_id) : null;
      return hit ? { ...w, property_code: hit.code } : w;
    }));
    setReparse(null);
    /*
     * ★ 要講出「它們離開了這份清單」——
     *   對上房源之後就不是例外了，畫面上會少幾列。
     *   只說「已重新對上 5 筆」的話，使用者會問剛剛那幾筆去哪了。
     */
    /*
     * ★ 兩個數字都要講。「事件 5 筆」與「排班表 4 格」不一樣是正常的
     *   （有些格子本來就填過房源），但差很多就值得看一眼。
     */
    flash(ok === reparse.length
      ? `已重新對上 ${ok} 筆，排班表補了 ${cells} 格房源`
      : `只更新了 ${ok} / ${reparse.length} 筆 —— 其餘可能是權限不足`);
  }

  /**
   * 按掉／還原。
   *
   * ★ 不是刪除。按掉的列還在資料庫裡，打開「顯示已按掉的」就看得到，
   *   而且記著是誰在什麼時候按的。
   */
  async function toggleDismiss(e: Ev) {
    const on = !e.dismissed_at;
    const { data: { user } } = await supabase.auth.getUser();
    const patch = on
      ? { dismissed_at: new Date().toISOString(), dismissed_by: user?.id ?? null }
      : { dismissed_at: null, dismissed_by: null };
    const { data, error } = await supabase.from('hk_event')
      .update(patch).eq('id', e.id).select('id');
    if (error) return flash((on ? '按掉' : '還原') + '失敗:' + error.message);
    if (!data?.length) return flash('沒有寫入任何資料 —— 可能是權限不足');
    setEvents((xs) => xs.map((x) => (x.id === e.id ? { ...x, ...patch } : x)));
  }

  /**
   * 手動加入完成之後，把那個事件一併按掉。
   *
   * ★★★ 兩件事要一起做。只加不按掉的話，那一筆同時
   *   **出現在統計裡、也還躺在例外清單上** —— 下次有人看到又加一次，
   *   而重複的工作項目在畫面上看不出來（同一天、同一間、同一個人，
   *   只是多了一列）。
   */
  async function submitExAdd(again: boolean) {
    if (!exAdd) return;
    /*
     * ★★★ 判斷寫在 hk-exception 的 `exAddError`，按鈕的 disabled 讀同一支。
     *
     *   原本這裡允許房源留空（只要有間數或點數），但按鈕寫的是
     *   `!exAdd.code` —— 嚴的那邊贏，於是 migration_198 的間數／點數
     *   **永遠按不下去**，而下面這句原因使用者一輩子看不到。
     *   （2026-09-02 使用者:「現在 不能留空白耶」）
     */
    const err = exAddError(exAdd);
    if (err) return flash(err);
    // ★★★ 沒寫進去就**什麼都不做** —— 不記「已補」、不按掉來源事件。
    //   原本沒檢查，休假或權限擋下來時例外清單會少一筆而統計沒有多一筆。
    const ok = await addItems(exAdd.date, exAdd.staffIds, exAdd.code, exAdd.type,
      exAdd.units.trim() === '' ? null : Number(exAdd.units),
      exAdd.points.trim() === '' ? null : Number(exAdd.points));
    if (!ok) return;
    setExAdded((xs) => [...xs,
      `${exAdd.code} ${exAdd.staffIds.map((i) => staff.find((x) => x.id === i)?.name ?? '?').join('＋')}`]);

    /*
     * ★★★ 補完就把那個事件按掉。兩件事**一定要一起** ——
     *   只補不按掉的話，那一筆同時出現在統計裡、也還躺在例外清單上，
     *   下次有人看到又補一次。而重複的工作項目在畫面上看不出來:
     *   同一天、同一間、同一個人，只是多了一列。
     */
    const ev = events.find((e) => e.id === exAdd.evId);
    if (ev && !ev.dismissed_at) await toggleDismiss(ev);

    // ★ 連補時只清房源，日期與人員留著 —— 同一天常常是同一組人掃好幾間
    // ★ 連補時間數與點數也清掉 —— 下一間未必是同樣的量
    if (again) setExAdd({ ...exAdd, code: '', units: '', points: '' });
    else { setExAdd(null); setExAdded([]); }
  }

  /** 沒進系統的事件（未指派 ＋ 房源對不到合成一份）。 */
  const exEvents = useMemo(() => exceptionEvents(events as ExEvent[]) as unknown as Ev[], [events]);
  const exShown = useMemo(
    () => visibleRows(exEvents as unknown as ExEvent[], showDismissed) as unknown as Ev[],
    [exEvents, showDismissed]);

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
          <button onClick={exportXlsx} disabled={!items.length}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-40 ${EXPORT_TONE}`}>⬇ 下載 Excel</button>
          {/*
            ★★★ 產生房務支出（migration_206）。**先預覽再寫** ——
              錢的事不自動（CLAUDE.md 的判斷原則）。

            ★ 這個分頁本身就只有 canEdit 進得來（housekeeping/page.tsx:155），
              所以這裡不用再判斷一次 —— 判斷兩次的話，哪天上面改了下面沒改，
              就會出現「看得到但按了沒用」。
          */}
          <button onClick={() => setGenOpen(true)}
            className="rounded-lg border border-mor-line px-3 py-1.5 text-sm text-gray-600 hover:bg-mor-sand/60">
            產生本月支出
          </button>
        </div>
      </div>

      {/* 摘要 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {roomStaff.map((s) => {
          const line = pay.get(s.id);
          const leave = dayList.filter((d) => dayMap[`${d}|${s.id}`]?.status).length;
          /*
           * 間數改用 lib/hk-payroll 的打掃量 —— **合掃各 0.5**。
           * 原本是「一筆算一間」,兩個人合掃一間會變成兩間,
           * 而那個差直接進報酬點數。
           */
          const units = line?.units ?? 0;
          return (
            <div key={s.id} className="rounded-xl bg-white border border-mor-line p-4 min-w-0">
              <div className="text-xs text-gray-500">{s.name}</div>
              <div className="stat-num font-bold mt-1">{fmtUnits(units)} <span className="text-sm font-normal text-gray-400">間</span></div>
              <div className="text-xs text-mor-slate font-medium mt-0.5">
                清潔點數 {fmtUnits(line?.points ?? 0)}
                {/*
                  算不出點數的要講出來,不能靜靜地少算。
                  那個人會少領,而他要自己對帳才發現。
                */}
                {!!line?.unknownPoints && (
                  <span className="ml-1 text-[11px] text-amber-600 font-normal"
                    title="這些房源還沒設打掃點數,或還沒對到 ERP 房源">
                    ⚠ {line.unknownPoints} 筆未計
                  </span>
                )}
              </div>
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
        {/* ★ 這張沒有「筆數」可放 —— 它只有一個總數，右上角就留空 */}
        <StatHero title="床單總計" value={totalLinen} sub="床數 + 拿床單" />
      </div>

      {/*
        各物業的清潔間數與點數（2026-09-02 使用者指定，A 案:上方一張寬卡）。

        ★★ 合計刻意寫出來 —— 它必須等於上面每個人的間數相加。
          兩個數字並排出現而對不起來的話，使用者不會知道該信哪一個。
      */}
      {estateLines.length > 0 && (
        <div className="rounded-xl bg-white border border-mor-line p-4 mb-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-xs text-gray-500">各物業</div>
            <div className="text-xs text-gray-400">
              合計 {fmtUnits(estateTotal.units)} 間・{fmtUnits(estateTotal.points)} 點
              {hoursUnits > 0 && (
                <span className="ml-1 text-amber-600"
                  title="時薪人員的間數不會出現在上面的人員卡片上，所以這個合計會比卡片相加多">
                  含時薪 {fmtUnits(hoursUnits)} 間
                </span>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            {estateLines.map((e) => {
              const none = e.estate === null;
              const key = e.estate ?? '';
              const open = openEstate === key;
              const log = estateLogs.get(key) ?? [];
              return (
                <div key={e.estate ?? '__none'}>
                <div className="flex items-center gap-2.5 text-xs">
                  {/*
                    ★ 點物業名稱展開日誌（2026-09-02 使用者:「間數點數可以點開
                      toggle 看各物業裡面的清潔日誌」）。整列都可以點的話，
                      使用者會不小心在拖曳長條時展開。
                  */}
                  <button type="button" onClick={() => setOpenEstate(open ? null : key)}
                    className={`w-16 shrink-0 truncate text-left hover:underline ${
                      none ? 'text-amber-700' : ''} ${open ? 'font-medium' : ''}`}
                    title={none ? '這些工作算不進任何物業。展開看每一筆的原因' : (e.estate ?? '')}>
                    {open ? '▾ ' : '▸ '}{none ? '⚠ 未歸物業' : e.estate}
                  </button>
                  <div className="flex-1 h-4 rounded bg-gray-100 min-w-0">
                    <div className={`h-4 rounded ${none ? 'bg-amber-400' : 'bg-mor-slate'}`}
                      style={{ width: `${Math.round((e.points / estateMax) * 100)}%` }} />
                  </div>
                  <div className="w-32 shrink-0 text-right text-gray-500 tabular-nums">
                    {/*
                      ★ 沒有間數時寫「—」不寫 0 —— 只手填點數的那種工作
                        本來就不算間數（migration_198），寫 0 會被當成「漏填」
                    */}
                    {e.units > 0 ? `${fmtUnits(e.units)} 間・` : '— 間・'}
                    {fmtUnits(e.points)} 點
                    {!!e.unknownPoints && (
                      <span className="ml-1 text-amber-600" title="這些房源還沒設打掃點數">
                        ⚠{e.unknownPoints}
                      </span>
                    )}
                  </div>
                </div>
                {/*
                  清潔日誌 —— **一份工一列**，不是一筆資料一列。
                  合掃的兩筆在 `estateLog` 裡就合起來了（人員收成一欄、
                  間數把兩個 0.5 加回 1），所以這裡加總會等於左邊那個數字。
                */}
                {open && (
                  <div className="mt-1 mb-2 ml-[4.5rem] rounded-lg bg-gray-50 px-3 py-2">
                    {log.length === 0 ? (
                      <div className="text-[11px] text-gray-400">這個月沒有明細</div>
                    ) : (
                      <table className="w-full text-[11px] table-fixed">
                        <tbody>
                          <tr className="text-gray-400">
                            <td className="py-1 w-12">日期</td>
                            <td className="py-1 w-28">誰做的</td>
                            <td className="py-1">房源</td>
                            <td className="py-1 w-14 text-right">間數</td>
                            <td className="py-1 w-14 text-right">點數</td>
                          </tr>
                          {log.map((r, li) => (
                            <tr key={li} className="border-t border-gray-200">
                              <td className="py-1 text-gray-500">{r.work_date.slice(5)}</td>
                              <td className="py-1 text-gray-600 truncate">
                                {r.staffIds.map((id) => staff.find((x) => x.id === id)?.name ?? '?').join('・')}
                              </td>
                              {/*
                                ★★★ 算不進物業有**三種**原因，要分開講
                                  （2026-09-02 使用者:「這些有房源耶」——
                                  他看到亞曼尼、時兆公區、開3 被歸進「無房源」，
                                  而那三個確實有房源也在主檔裡）。

                                    沒填房源        使用者自己留空的
                                    主檔沒有        他自己打的字，房務主檔查不到
                                    沒接上 ERP      房務主檔有，但沒連到 ERP 房源
                                                    （hk_property.property_id 是空的）
                                    房源沒有物業    連上了，但那個 ERP 房源沒設物業

                                ★ 用一個「無房源」蓋掉四種的話，看的人不知道
                                  該去補什麼 —— 而前兩種要改補登、後兩種要改主檔。
                              */}
                              <td className="py-1 text-gray-600 truncate">
                                {r.label || <span className="text-amber-600">（沒填房源）</span>}
                                {(() => {
                                  if (!r.label) return null;
                                  const hp = propByCode[r.label];
                                  if (!hp) return <span className="ml-1 text-amber-600">主檔沒有</span>;
                                  if (!hp.property_id) return <span className="ml-1 text-amber-600">沒接上 ERP</span>;
                                  if (!estateById[hp.property_id]) return <span className="ml-1 text-amber-600">房源沒有物業</span>;
                                  return null;
                                })()}
                              </td>
                              <td className="py-1 text-right tabular-nums">{fmtUnits(r.units)}</td>
                              <td className="py-1 text-right tabular-nums">
                                {r.unknownPoints ? <span className="text-amber-600">—</span> : fmtUnits(r.points)}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t border-gray-300 font-medium">
                            <td className="py-1" colSpan={3}>{none ? '未歸物業' : e.estate} 小計</td>
                            <td className="py-1 text-right tabular-nums">{fmtUnits(e.units)}</td>
                            <td className="py-1 text-right tabular-nums">{fmtUnits(e.points)}</td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
                </div>
              );
            })}
          </div>
          <div className="mt-2.5 pt-2 border-t border-mor-line text-[11px] text-gray-400">
            只列這個月有工作的物業。長度是點數比例・點物業名稱看明細
          </div>
        </div>
      )}

      {/*
        ══════════ 產生房務支出的預覽（migration_206）══════════

        ★★★ **按下去之前先看到錢**。這一個動作會在支出頁憑空多出幾十筆、
          幾十萬 —— 而支出頁上那些看起來跟人工記的一模一樣。

        ★★ 算不出錢的那一區要顯示。沒單價的**整筆不產生**（不是記成 $0），
          所以帳會少一截 —— 不講的話沒有人會發現少了什麼。

        ★ 用 `relative` 的一般流排版，不用 position:fixed 的遮罩 ——
          這一頁本來就沒有別的 modal，多一層遮罩只是多一種捲動行為。
      */}
      {genOpen && (
        <div className="rounded-xl bg-white border border-mor-line p-4 mb-4">
          <div className="flex items-baseline justify-between pb-2 mb-3 border-b border-mor-line">
            <div className="text-sm font-medium text-mor-slate">
              產生 {period.slice(0, 4)} 年 {Number(period.slice(4))} 月的房務支出
            </div>
            <div className="text-[11px] text-gray-400">
              會計科目：房務清潔・標籤 房務
            </div>
          </div>

          <table className="w-full text-sm table-fixed">
            <tbody>
              <tr>
                <td className="py-1">
                  清潔費
                  <span className="ml-2 text-xs text-gray-400">{gen.rows.length} 份工</span>
                </td>
                <td className="py-1 w-28 text-right tabular-nums">
                  ${costTotal(gen.rows).toLocaleString('en-US')}
                </td>
              </tr>
              <tr>
                <td className="py-1">
                  人事費
                  <span className="ml-2 text-xs text-gray-400">
                    {gen.lab.length} 筆・記在 {lastDayOf(period).slice(5)}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  ${costTotal(gen.lab).toLocaleString('en-US')}
                </td>
              </tr>
              <tr className="border-t border-mor-line font-medium">
                <td className="py-2">
                  合計
                  <span className="ml-2 text-xs text-gray-400 font-normal">
                    {gen.rows.length + gen.lab.length} 筆支出
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums text-base">
                  ${gen.total.toLocaleString('en-US')}
                </td>
              </tr>
            </tbody>
          </table>

          {/*
            ★★★ 逐筆列出**支出長什麼樣子**（2026-09-02 使用者:「可以有預覽 支出 的樣子嗎？」）。

              只給總額的話，按下去等於簽一張看不到明細的單 ——
              而產生完之後那些支出散在支出頁的幾百列裡，要挑出來對很難。

            ★ 預設收起來:多數時候看總額就夠了，展開是為了「這次不太對」的時候。
            ★★ 不用巢狀捲動（CLAUDE.md）—— 直接全部列出來，
              長就長，反正是展開才看得到的。
          */}
          <div className="mt-3">
            <button onClick={() => setGenRowsOpen(!genRowsOpen)}
              className="text-xs text-mor-blue underline">
              {genRowsOpen ? '收起明細' : `看這 ${gen.rows.length + gen.lab.length} 筆支出長什麼樣子`}
            </button>
            {genRowsOpen && (
              <div className="mt-2 rounded-lg border border-mor-line overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-[11px] min-w-[680px]">
                  <tbody>
                    <tr className="bg-gray-50 text-gray-500">
                      <td className="px-2 py-1.5 w-20">日期</td>
                      <td className="px-2 py-1.5 w-44">項目</td>
                      <td className="px-2 py-1.5 w-20">物業</td>
                      <td className="px-2 py-1.5 w-24">房源</td>
                      <td className="px-2 py-1.5 w-20">會計科目</td>
                      <td className="px-2 py-1.5 w-14">標籤</td>
                      <td className="px-2 py-1.5 w-16">付款方式</td>
                      <td className="px-2 py-1.5 w-24 text-right">金額</td>
                    </tr>
                    {gen.rows.map((r) => (
                      <tr key={r.key} className="border-t border-mor-line/60">
                        <td className="px-2 py-1 text-gray-500">{r.work_date}</td>
                        {nameCell(r.key, cleanItemName(r.label, r.units))}
                        <td className="px-2 py-1 text-gray-600">{estateById[r.property_id] ?? '—'}</td>
                        <td className="px-2 py-1 text-gray-600">{propNameById[r.property_id] ?? '—'}</td>
                        <td className="px-2 py-1 text-gray-500">房務清潔</td>
                        <td className="px-2 py-1">
                          <span className="rounded bg-mor-bluelight text-mor-slate px-1.5 py-0.5">{TAG_NON_CASH}</span>
                        </td>
                        <td className="px-2 py-1 text-gray-400">無</td>
                        <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                          ${r.amount.toLocaleString('en-US')}
                          {/* ★ 單價留在金額底下 —— 「1 × $9,000」是算式不是名字，
                              放在項目欄裡會讓人以為那是要寫進去的字 */}
                          <div className="text-gray-400">
                            {fmtUnits(r.units)} × ${r.price.toLocaleString('en-US')}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {gen.lab.map((r) => (
                      <tr key={r.key} className="border-t border-mor-line/60 bg-amber-50/40">
                        <td className="px-2 py-1 text-gray-500">{r.spent_on}</td>
                        {nameCell(r.key, LABOR_ITEM_NAME)}
                        <td className="px-2 py-1 text-gray-600">
                          {r.property_id
                            ? (estateById[r.property_id] ?? '—')
                            : (estNameById[r.estate_id ?? ''] ?? '—')}
                        </td>
                        <td className="px-2 py-1 text-gray-600">
                          {r.property_id
                            ? (propNameById[r.property_id] ?? '—')
                            : <span className="text-gray-400">整個物業</span>}
                        </td>
                        <td className="px-2 py-1 text-gray-500">房務清潔</td>
                        <td className="px-2 py-1">
                          <span className="rounded bg-mor-bluelight text-mor-slate px-1.5 py-0.5">{TAG_NON_CASH}</span>
                        </td>
                        <td className="px-2 py-1 text-gray-400">無</td>
                        <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                          ${r.amount.toLocaleString('en-US')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {/*
                  ★ 說明放在表格**底下**、不是頁面最上方 ——
                    這張表要捲，訊息跑到看不見的地方等於沒講
                    （CLAUDE.md 2026-09-02）。
                  ★★ 一行講完:改名只對還沒產生的有效。
                */}
                <div className="border-t border-mor-line bg-gray-50 px-2 py-1.5 text-[11px] text-gray-500">
                  {doneLoading
                    ? '正在查這個月已經產生過哪些…'
                    : doneNum > 0
                      ? `項目名稱可以直接改。標「已產生」的 ${doneNum} 筆改名沒有用（系統不會覆蓋既有支出），要改請到支出頁。`
                      : '項目名稱可以直接改。改完要按下面的「產生」才算數，關掉視窗就回到預設名字。'}
                </div>
              </div>
            )}
          </div>

          {gen.unpriced.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
              <div className="text-xs text-amber-900">
                {gen.unpriced.length} 份工<b>算不出錢</b>，不會產生支出
              </div>
              <div className="text-[11px] text-amber-800 mt-1.5 leading-relaxed">
                {(() => {
                  // ★ 逐筆列會很長 —— 照「房源＋原因」收合，數量放後面
                  const g = new Map<string, number>();
                  for (const u of gen.unpriced) {
                    const k = `${u.label}・${u.reason}`;
                    g.set(k, (g.get(k) ?? 0) + 1);
                  }
                  return [...g].map(([k, n]) => `${k} ${n} 份`).join('　｜　');
                })()}
              </div>
            </div>
          )}

          <div className="mt-2 rounded-lg bg-gray-50 p-3 text-[11px] text-gray-500 leading-relaxed">
            已經產生過的不會再產生一次。
            <b>改了單價之後重按，舊的那筆不會跟著改</b> —— 要改金額請到支出頁。
          </div>

          <div className="flex items-center gap-2 mt-3">
            <button onClick={doGenerate} disabled={genBusy || gen.total === 0}
              className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
              {genBusy ? '產生中⋯' : `產生 ${gen.rows.length + gen.lab.length} 筆支出`}
            </button>
            <button onClick={() => setGenOpen(false)}
              className="text-xs text-gray-500 underline">取消</button>
          </div>
        </div>
      )}

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
            排班資料改從「房務行事曆」分頁匯入 —— 匯進去之後,
            這一頁的統計會跟著長出來。
          </div>
          <button onClick={onGoCalendar}
            className="mt-4 rounded-lg bg-mor-slate text-white px-5 py-2 text-sm font-medium hover:bg-mor-slatedark">
            去行事曆匯入
          </button>
        </div>
      ) : tab === 'sheet' ? (
        // 左排班、右布巾。寬螢幕並排,窄螢幕上下疊 ——
        // 改一格房源要能立刻看到布巾跟著動,分開兩頁會逼人來回切。
        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_560px] gap-4 items-start">
        <div className="rounded-xl glass overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-mor-line bg-white/45 text-left">
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
                              /* step 0.5 —— 合掃是各 0.5，step=1 的話瀏覽器的上下鍵改不出小數 */
                              <input type="number" min="0" step="0.5" value={n || ''}
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
                          /*
                            ══════════════════════════════════════════
                            新增一筆工作項（2026-09-01 改成可複選）

                            ★★★ 「誰做的」是**名字鈕**不是下拉。
                              合掃是常態,而下拉一次只能選一個 ——
                              要按兩次「加入」,中間手滑改到房源的話
                              兩筆就不是同一份工,各算 1 間,房間憑空變兩間。

                            ★ 排成一整塊（不是一行）—— 名字有九個,
                              擠在同一行會把房源欄壓到看不見。
                            ══════════════════════════════════════════
                          */
                          <span className="inline-flex flex-col gap-1.5 align-top">
                            <span className="inline-flex items-center gap-1 flex-wrap">
                              <input list="hk-props" value={adding.code} autoFocus
                                onChange={(e) => setAdding({ ...adding, code: e.target.value })}
                                onKeyDown={(e) => {
                                  /*
                                    ★ Enter 只在「有房源、也有人」的時候才送出。
                                      少了人的檢查會寫出一批 staff_id 是空的列,
                                      而那些列不屬於任何人 —— 誰的統計都看不到它們。
                                  */
                                  if (e.key === 'Enter' && adding.code && adding.staffIds.length) {
                                    addItems(d, adding.staffIds, adding.code, adding.type);
                                    setAdding({ ...adding, code: '' });   // 連續新增:存檔後停在輸入器
                                  }
                                  if (e.key === 'Escape') setAdding(null);
                                }}
                                placeholder="房源" className={`${inp} w-24`} />
                              <select value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value })} className={`${inp} w-24`}>
                                {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </select>
                              <button
                                onClick={() => {
                                  if (adding.code && adding.staffIds.length) {
                                    addItems(d, adding.staffIds, adding.code, adding.type);
                                    setAdding({ ...adding, code: '' });
                                  }
                                }}
                                disabled={!adding.code || !adding.staffIds.length}
                                className="text-xs text-mor-blue underline disabled:opacity-40 disabled:no-underline">加入</button>
                              <button onClick={() => setAdding(null)} className="text-xs text-gray-400 underline">完成</button>
                            </span>

                            {/*
                              誰做的 —— 可複選。★ 選中用實心，沒選用外框:
                              只靠顏色深淺的話，縮圖或色弱時分不出哪些被選了。
                            */}
                            <span className="inline-flex items-center gap-1 flex-wrap">
                              <span className="text-[11px] text-gray-400 mr-0.5">誰做的</span>
                              {assignableStaff.map((x) => {
                                const on = adding.staffIds.includes(x.id);
                                return (
                                  <button key={x.id}
                                    onClick={() => setAdding({
                                      ...adding,
                                      staffIds: on
                                        ? adding.staffIds.filter((i) => i !== x.id)
                                        : [...adding.staffIds, x.id],
                                    })}
                                    aria-pressed={on}
                                    className={`rounded px-2 py-0.5 text-[11px] border transition-colors ${
                                      on ? 'bg-mor-slate text-white border-mor-slate'
                                         : 'border-gray-300 text-gray-600 hover:border-mor-slate'}`}>
                                    {x.name}{on ? ' ✓' : ''}
                                  </button>
                                );
                              })}
                            </span>

                            {/*
                              ══════════════════════════════════════════
                              ★★★ 按下去會變成怎樣，先講

                                分攤的分母是「這份工的全部人」，不只是剛勾的那幾個。
                                所以補一個人進既有的工，**原本那個人會從 1 間掉到 0.5 間** ——
                                那是對的（一間房只有一間），但不先講的話，
                                畫面上只會看到「我明明是補資料，怎麼反而變少了」。

                              ★ 規則寫在 `lib/hk-crew.ts`（有測試），這裡只負責顯示。
                              ══════════════════════════════════════════
                            */}
                            {(() => {
                              if (!adding.staffIds.length) return null;
                              const t = previewText(
                                sharePreview(items, d, adding.code, adding.type, adding.staffIds),
                                (id) => staff.find((x) => x.id === id)?.name ?? id,
                              );
                              if (!t) return null;
                              return (
                                <span className="inline-flex flex-col gap-0.5 rounded bg-mor-green/10 px-2 py-1">
                                  <span className="text-[11px] text-mor-green">{t.line}</span>
                                  {t.warn && (
                                    <span className="text-[11px] text-amber-700">⚠ {t.warn}</span>
                                  )}
                                </span>
                              );
                            })()}
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              const s = staff.find((x) => x.count_mode === 'rooms' && canAddItem(d, x.id));
                              if (!s) return flash('當日所有人員都是休假狀態,要先清除休假才能新增房源');
                              /* ★ 預設勾一個人 —— 九成的情況是一個人掃一間，
                                   一個都不勾的話每次都要先按一下 */
                              setAdding({ date: d, staffIds: [s.id], code: '', type: '退房清潔' });
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
            /*
             * 【本月沒排到的房源不列】（2026-08-17 使用者指定）
             *
             * 72 間房裡一個月通常只排到十幾間，其餘整排都是 0 —— 而那些 0
             * 佔掉的高度，正是真正有數字的那幾列需要的。
             *
             * 判斷用「次數」而不是「小計」:小計是 次數 × 幾床 ＋ 拿床單，
             * 而幾床沒填的房源小計會是 0 —— 那種要留著，
             * 因為它是**有排到班但算不出布巾**，正是最需要被看到的一種。
             *
             * 拿床單有填的也留著:那是人手動輸入的，不該因為系統沒排班就藏掉。
             */
            const list = props.filter((p) => p.linen_group === g
              && (countOf(p.code) > 0 || linenOf(p.code) > 0));
            if (!list.length) return null;
            const sub = list.reduce((a, p) => a + countOf(p.code) * (p.beds ?? 0) + linenOf(p.code), 0);
            return (
              <div key={g} className="rounded-xl glass overflow-x-auto">
                <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 font-medium text-sm">{GROUP_LABEL[g]}</div>
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-mor-line/60 text-left text-xs text-gray-500">
                      <th className="px-3 py-2">房源</th>
                      <th className="px-3 py-2 text-right">次數</th>
                      <th className="px-3 py-2 text-right">床數</th>
                      <th className="px-3 py-2 text-right">更換床數</th>
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
                            {p.beds == null && <span className="ml-1 text-[10px] text-amber-600">待補床數</span>}
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
                              title={p.beds == null ? '尚未建檔,填了才算得出更換床數' : '房源主檔的幾床,改了影響所有月份'}
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

          {/*
            ══════════════════════════════════════════════════════
            沒進系統的事件 —— **未指派與房源對不到合成一份**。

            ★★★ 使用者要的是「這個月有哪幾筆沒進系統」這一個問題的答案，
              不是「沒進系統的原因有幾種」。分成兩個區塊的話，
              同一天的兩筆會落在畫面上相距很遠的地方，
              而人是照日期在找東西的（2026-08-31 使用者:
              「我看不懂耶 我的理解是 1. 看甚麼沒進系統 2. 手動放進去 3. 按掉」）。

            ★ 原因寫在每一列上，動作也在每一列上。
            ══════════════════════════════════════════════════════
          */}
          <div className="rounded-xl glass">
            <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-sm">沒進系統的</span>
              <span className="flex items-center gap-3">
                {/*
                  ★★★ 別名是後來才加的 —— `hk_event.parsed_code` 是匯入當下
                    算好存起來的，加別名不會回頭修既有資料。
                    沒有這顆的話，使用者會以為別名沒生效而跑去再加一次。
                */}
                <button onClick={previewReparse}
                  className="rounded-lg border border-mor-green text-mor-greendark px-2.5 py-1 text-xs font-medium hover:bg-mor-greenlight">
                  重新解析
                </button>
                {dismissedCount(exEvents as ExEvent[]) > 0 && (
                  <button onClick={() => setShowDismissed((v) => !v)}
                    className="text-xs text-mor-blue underline">
                    {showDismissed ? '隱藏已按掉的' : `顯示已按掉的（${dismissedCount(exEvents as ExEvent[])}）`}
                  </button>
                )}
                <span className={`text-xs ${exShown.length ? 'text-amber-600' : 'text-gray-400'}`}>{exShown.length} 筆</span>
              </span>
            </div>

            {/* 重新解析的預覽。★ 先看再寫 —— 對錯房源的代價是點數算到別人頭上 */}
            {reparse !== null && reparse.length > 0 && (
              <div className="px-4 py-3 bg-mor-greenlight/60 border-b border-mor-line text-sm">
                <div className="font-medium text-mor-greendark mb-1">用現在的別名可以對上 {reparse.length} 筆</div>
                <div className="text-xs text-gray-600 space-y-0.5 mb-2">
                  {reparse.map((r) => (
                    <div key={r.id}>{r.event_date}　{r.title} → <b>{r.code}</b></div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={applyReparse}
                    className="rounded-lg bg-mor-slate text-white px-3 py-1 text-xs font-medium hover:bg-mor-slatedark">寫入</button>
                  <button onClick={() => setReparse(null)}
                    className="rounded-lg border border-gray-300 px-3 py-1 text-xs">取消</button>
                </div>
              </div>
            )}

            <div className="divide-y divide-mor-line/40">
              {exShown.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-gray-300">沒有漏掉的</div>
              ) : exShown.map((e) => {
                const off = !!e.dismissed_at;
                return (
                  <div key={e.id} className={`px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${off ? 'opacity-50' : ''}`}>
                    <span className="text-gray-500 w-14 shrink-0">{e.event_date.slice(5)}</span>
                    <span className={`min-w-0 flex-1 ${off ? 'line-through' : ''}`}>
                      <span className="font-medium">{e.title}</span>
                      {e.assignees?.length ? <span className="ml-2 text-xs text-gray-400">{e.assignees.join('・')}</span> : null}
                    </span>
                    <span className={`text-xs shrink-0 ${
                      reasonOf(e as ExEvent) === '人員對不到' ? 'text-red-500' : 'text-amber-600'}`}>
                      {reasonOf(e as ExEvent)}
                    </span>
                    {off ? (
                      <span className="shrink-0 flex items-center gap-2">
                        <span className="text-xs text-gray-400">已按掉</span>
                        <button onClick={() => toggleDismiss(e)} className="text-xs text-mor-blue underline">還原</button>
                      </span>
                    ) : (
                      <span className="shrink-0 flex items-center gap-2">
                        {/*
                          ★★★ 正在補的那一列要看得出來（2026-09-02 使用者:
                            「點另一列的『補』沒反應」）。

                            表單只有一個，固定在清單**最下面**。點另一列時它確實換了，
                            但換掉的只有標題那一行小字 —— 而兩筆的人員都對不到主檔，
                            所以表單看起來一模一樣（都是空的）。
                            使用者的結論是「沒反應」，那是完全合理的判斷。

                          ★ 所以把狀態放回**他手指所在的那一列**:按鈕變成「補中…」。
                        */}
                        <button onClick={() => { setExAdded([]); setExAdd({ evId: e.id, units: '', points: '', ...prefillFromEvent(e as ExEvent, (n) => staff.find((x) => x.name === n)?.id ?? null) }); }}
                          className={`rounded-lg px-3 py-1 text-xs font-medium ${
                            exAdd?.evId === e.id
                              ? 'bg-white text-mor-slate border border-mor-slate'
                              : 'bg-mor-slate text-white hover:bg-mor-slatedark'}`}>
                          {exAdd?.evId === e.id ? '補中…' : '補'}
                        </button>
                        <button onClick={() => toggleDismiss(e)}
                          className="rounded-lg border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50">按掉</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 手動補的表單 —— 跟排班表那張同一組欄位，多一個日期 */}
            {exAdd && (
              <div className="px-4 py-3 bg-mor-bluelight/60 border-b border-mor-line">
                {(() => {
                  /*
                    ★★★ 表單要說出**這是在補哪一筆**（2026-09-01 使用者:
                      「補登 上方要顯示 沒進系統的條列」）。
                      沒有這一行的話，畫面上只有四個空欄位 ——
                      使用者按了「補」之後得往上捲去確認自己按的是哪一列，
                      而連補幾筆時更是完全記不得。
                  */
                  const src = events.find((e) => e.id === exAdd.evId);
                  return (
                    <div className="mb-2">
                      <div className="text-sm text-mor-slate font-medium">手動補這一天的工作（可以連補幾筆）</div>
                      {src && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          補這一筆：<b className="text-gray-700">{src.event_date.slice(5)}　{src.title}</b>
                          {src.assignees?.length ? <span className="ml-2 text-gray-400">{src.assignees.join('・')}</span> : null}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1"><span className="text-[11px] text-gray-500">日期</span>
                    <input type="date" value={exAdd.date}
                      onChange={(e) => setExAdd({ ...exAdd, date: e.target.value })} className={inp} /></label>
                  {/*
                    ★★ `relative` ＋ 底下那句提示 `absolute`（2026-09-02 使用者:
                      「沒對到房源的 顯示會歪掉」）。

                      這一排是 `items-end`。提示直接放進 label 裡的話，
                      這一格會變高，而靠底對齊會把輸入框**往上推** ——
                      於是打了主檔沒有的房源，整排欄位就錯開一階。

                    ★ 絕對定位不佔高度，所以提示出現或消失都不會動到版面。
                  */}
                  <label className="relative flex flex-col gap-1"><span className="text-[11px] text-gray-500">房源</span>
                    <input list="hk-props" value={exAdd.code} autoFocus
                      onChange={(e) => setExAdd({ ...exAdd, code: e.target.value })}
                      className={`${inp} w-28`} />
                    {/*
                      ★★★ 打了房源就把那間的打掃點數**顯示**出來
                        （2026-09-01 使用者:「改作顯示 點數即可 不要修改」）。

                      ★ 只顯示，**不自動填進上面的欄位**。填進去的話，
                        使用者存檔時看到的是一個他沒打過的數字 ——
                        而那個數字之後改了房源設定也不會跟著變（它已經被抄下來了）。
                        留空才是「照房源算」，那是會跟著設定走的。

                      ★★ 點數的唯一來源是 `properties.clean_points`
                        （權限管理 → 房源管理）。這裡不提供修改 ——
                        一份資料兩個地方改，是這一輪已經踩過三次的坑。
                    */}
                    {(() => {
                      const code = exAdd.code.trim();
                      if (!code) return null;
                      const hk = propByCode[code];
                      /*
                       * ★★ 主檔沒有的房源**照樣存得了**（2026-09-02 使用者:
                       *   「我要自己填房源耶」）—— 這一格本來就是自由輸入。
                       *
                       *   但要講出代價:查不到房源就算不出點數，那一筆會落進
                       *   卡片上的「⚠ N 筆未計」，而各物業那張表會把它歸到「無房源」。
                       *   不講的話使用者存完看到總數沒變，會以為沒存進去。
                       */
                      if (!hk) {
                        return (
                          <span className="absolute top-full left-0 mt-0.5 whitespace-nowrap text-[11px] text-amber-600">
                            主檔沒有這個房源{exAdd.points.trim() === '' && ' —— 算不出點數，右邊請自己填'}
                          </span>
                        );
                      }
                      const p = hk.property_id ? pointsById[hk.property_id] : null;
                      return (
                        <span className="absolute top-full left-0 mt-0.5 whitespace-nowrap text-[11px] text-gray-500">
                          {p == null
                            ? '這間還沒設打掃點數'
                            : <>這間 <b className="text-mor-slate">{p}</b> 點{exAdd.points.trim() === '' && '（留空就用這個）'}</>}
                        </span>
                      );
                    })()}
                    </label>
                  <label className="flex flex-col gap-1"><span className="text-[11px] text-gray-500">工作類型</span>
                    <select value={exAdd.type} onChange={(e) => setExAdd({ ...exAdd, type: e.target.value })}
                      className={`${inp} w-24`}>
                      {wtypes.map((w) => <option key={w.code} value={w.code}>{w.name}</option>)}
                    </select></label>
                  {/*
                    ★★★ 一筆等於好幾間（migration_198，2026-09-01 使用者:
                      「可以 key 房源我自己打 + 間數 | 打掃點數
                        舉例 無房間 0.5 | 3.5點；無房間 0 | 2點」）。

                      行事曆只寫「正隆」的那種，一筆其實是那天在那個物業做的好幾間，
                      而使用者未必知道是哪幾間房號。

                    ★ 兩欄都**留空 = 照原本算**（1 間、點數查房源）。
                      留空跟填 0 是兩件事:0 代表「這一筆不算間數，只記點數」。
                  */}
                  <label className="flex flex-col gap-1"><span className="text-[11px] text-gray-500">間數</span>
                    <input value={exAdd.units} inputMode="decimal" placeholder="留空=1"
                      onChange={(e) => setExAdd({ ...exAdd, units: e.target.value })}
                      className={`${inp} w-20 text-right`} /></label>
                  <label className="flex flex-col gap-1"><span className="text-[11px] text-gray-500">打掃點數</span>
                    <input value={exAdd.points} inputMode="decimal" placeholder="留空=查房源"
                      onChange={(e) => setExAdd({ ...exAdd, points: e.target.value })}
                      className={`${inp} w-24 text-right`} /></label>
                </div>
                {(exAdd.units.trim() !== '' || exAdd.points.trim() !== '') && (
                  <div className="mt-2 rounded-lg bg-mor-sand/60 px-2 py-1.5 text-[11px] text-gray-600 leading-relaxed">
                    這一筆算 <b>{exAdd.units.trim() === '' ? '1' : exAdd.units}</b> 間
                    {exAdd.points.trim() !== '' && <>、<b>{exAdd.points}</b> 點</>}
                    {exAdd.staffIds.length > 1 && (
                      <span className="text-mor-slate">
                        　{exAdd.staffIds.length} 個人一起做 → 每人各
                        {' '}{fmtUnits((Number(exAdd.units || 1) || 0) / exAdd.staffIds.length)} 間
                        {exAdd.points.trim() !== '' && <>、{fmtUnits((Number(exAdd.points) || 0) / exAdd.staffIds.length)} 點</>}
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-2">
                  {/*
                    ★★★ 沒選人時整區標紅（2026-09-02 使用者:「打入也不可存耶」）。

                      原因本來只寫在最下面按鈕旁邊一行小字，離這裡有半個表單遠 ——
                      而「誰做的」三顆看起來像標籤不像必填欄位，
                      使用者把房源、間數、點數都打完了才發現存不了，
                      然後以為是房源或間數的問題（他先後怪過那兩個）。

                    ★ 行事曆上的人名對不到主檔就帶不進來（Ayu、SHAO-YING HSIEH
                      都不在人員主檔裡），所以這一格**經常**是空的 ——
                      不是偶爾。必填的提示要放在手指要點的地方。
                  */}
                  <div className={`text-[11px] mb-1 ${
                    exAdd.staffIds.length ? 'text-gray-500' : 'text-red-600 font-medium'}`}>
                    誰做的（可複選）
                    {!exAdd.staffIds.length && ' —— 必選，點一下名字'}
                  </div>
                  <div className={`flex flex-wrap gap-1 ${
                    exAdd.staffIds.length ? '' : 'ring-1 ring-red-300 rounded-lg p-1 -m-1'}`}>
                    {assignableStaff.map((x) => {
                      const on = exAdd.staffIds.includes(x.id);
                      return (
                        <button key={x.id} type="button"
                          onClick={() => setExAdd({
                            ...exAdd,
                            staffIds: on ? exAdd.staffIds.filter((i) => i !== x.id) : [...exAdd.staffIds, x.id],
                          })}
                          className={`rounded-lg px-2 py-1 text-xs font-medium border ${
                            on ? 'bg-mor-slate text-white border-mor-slate' : 'bg-white border-gray-300 text-gray-600'}`}>
                          {x.name}{on ? ' ✓' : ''}
                        </button>
                      );
                    })}
                  </div>
                  {/* 合掃預覽 —— 兩個人一起掃是各 0.5 間，不是各 1 間 */}
                  {exAdd.staffIds.length > 0 && exAdd.code && (
                    <div className="mt-2 rounded-lg bg-mor-greenlight px-2 py-1.5 text-[11px] text-mor-greendark">
                      {(() => {
                        const t = previewText(
                          sharePreview(items, exAdd.date, exAdd.code, exAdd.type, exAdd.staffIds),
                          (id) => staff.find((x) => x.id === id)?.name ?? id,
                        );
                        if (!t) return null;
                        // ★ 警告（有人從 1 間掉到 0.5 間）要另起一行，不能跟主句混在一起
                        return <>{t.line}{t.warn && <div className="text-amber-700 mt-0.5">{t.warn}</div>}</>;
                      })()}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {/* ★★★ 房源留空 ＋ 有間數或點數也要能存 —— 判斷跟 submitExAdd
                      同一支（`canSubmitExAdd`）。原本這裡寫 `!exAdd.code`，
                      「正隆」那種整棟工作永遠按不下去（2026-09-02 踩過）。 */}
                  <button onClick={() => submitExAdd(true)}
                    disabled={!canSubmitExAdd(exAdd)}
                    className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-xs font-medium hover:bg-mor-slatedark disabled:opacity-40">
                    存並再補一筆</button>
                  <button onClick={() => submitExAdd(false)}
                    disabled={!canSubmitExAdd(exAdd)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-40">存完收起來</button>
                  <button onClick={() => { setExAdd(null); setExAdded([]); }}
                    className="text-xs text-gray-500 underline">取消</button>
                  {/*
                    ★★★ 按鈕是灰的時候要**說出為什麼**（2026-09-02 使用者:
                      「如何存 無房源」—— 他以為是房源留空造成的，
                      實際上是還沒選人）。

                      灰掉而不說原因，使用者只能一格一格試。而這裡的訊息
                      跟 `submitExAdd` 讀的是同一支 `exAddError`，
                      所以不可能出現「上面說要選人、按下去卻說別的」。
                  */}
                  {exAddError(exAdd) && (
                    <span className="text-xs text-amber-700">{exAddError(exAdd)}</span>
                  )}
                  {/*
                    ★★★ 存檔失敗的訊息也放這裡一份（2026-09-02）。

                      `flash()` 只寫到頁面**最上方**那條訊息列 —— 而補登表單
                      在畫面下半部，捲下來就看不到了。
                      使用者按了「存並再補一筆」，畫面上什麼都沒發生，
                      他的結論是「按鈕壞了」，而系統其實有講原因。

                    ★ 訊息要出現在**動作發生的地方**，不是頁面頂端。
                  */}
                  {msg && !exAddError(exAdd) && (
                    <span className="text-xs text-red-600">{msg}</span>
                  )}
                  {/* ★ 連補幾筆時要看得到補了什麼 —— 不然第三筆會忘記前兩筆 */}
                  {exAdded.length > 0 && (
                    <span className="text-xs text-mor-greendark">已補 {exAdded.length} 筆：{exAdded.join('・')}</span>
                  )}
                </div>
              </div>
            )}

          </div>

          {/* 這兩區列的不是事件，沒有「按掉」—— 解法是去把資料補上，見各自的說明 */}
          {[
            { title: '尚未建檔「幾床」', rows: exceptions.noBeds, hint: '這些房源有清掃紀錄但沒有床數,床單推算會少算。★ 沒有「按掉」——按掉只會讓少算的床單消失在視線外,而總數依然是錯的。' },
            { title: '同月清掃 3 次以上', rows: exceptions.heavy.map(([c, n]) => `${c}　${n} 次`), hint: '可能是重複建立的事件,值得看一眼。' },
          ].map((sec) => (
            <div key={sec.title} className="rounded-xl glass">
              <div className="px-4 py-2.5 border-b border-mor-line bg-white/45 flex items-center justify-between">
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

    </div>
  );
}
