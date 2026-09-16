'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, Field, FilterSelect, FilterSearch, FilterClear, FilterCount } from '@/lib/filters';
import {
  isWeekend, weekdayOf, sortRooms, matchRoom, rowOf, exitsSoon,
  ENDING_DAYS, LEAVING_DAYS,
  overlapRanges, dropContractOrders, monthRange, rangeDays, eachDay,
  staysInRange, lastNightOf, daysBetween, addDays, MAX_RANGE_DAYS,
  type Stay, type Room, type Cell, type Range, type Exit,
} from '@/lib/room-calendar';
import ToggleInfo from '@/components/ToggleInfo';

/*
 * ══════════════════════════════════════════════════════════
 * 房源狀態（2026-09-15 使用者指定）
 *
 * 一條一個房源、橫軸是日期，訂單與契約畫在同一條線上，空白就是空房。
 *
 * ★★★ 「哪一格有人」的算法全部在 `lib/room-calendar.ts`（有 46 個測試）——
 *   這一頁只負責排版。兩種來源的「迄」邊界不一樣（短租是退房日、
 *   契約是最後一晚），那是最容易錯一格的地方，
 *   而錯一格的後果是「畫面說有人、實際上空著」—— 有人會照著它排錯房。
 *
 * ★★ 房源清單來自 `properties`，**不是從訂單反推**。
 *   從訂單反推的話，「整個月都空著」的房間永遠不會出現在畫面上 ——
 *   而那正是最想看到的那幾間。
 *
 * ══════════════════════════════════════════════════════════
 * 【2026-09-16 四項優化（使用者指定）】
 *
 *   ① 月份之外可以自訂起訖 —— 跨月的檔期不用切兩次月份自己接
 *   ② 圖例搬到表格上面，而且點得下去（＝篩選）
 *   ③ 點色條出現名稱與期間（原本是 hover，手機完全沒有）
 *   ④ 有重疊的房源可以一鍵篩出來
 *
 * ★★★ ① 是 lib 的改動不是畫面的:整支原本吃 `ym`，現在吃 `Range`，
 *   而**月檢視就是 `monthRange(ym)` 的一種自訂區間** —— 不是兩條路。
 *   兩條路徑各算一次「哪一格有人」的話，改了一邊另一邊會安靜地留在舊答案。
 * ══════════════════════════════════════════════════════════
 */

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 顏色。跟藥丸是同一份 —— 兩邊各寫一次就會有對不起來的一天 */
const TONE: Record<Stay['tone'], { bar: string; chip: string; label: string }> = {
  short:    { bar: 'bg-[#2F8C8C]',  chip: 'bg-[#2F8C8C]',  label: '短租（Airbnb／Agoda）' },
  private:  { bar: 'bg-mor-green',  chip: 'bg-mor-green',  label: '私下' },
  longterm: { bar: 'bg-mor-slate',  chip: 'bg-mor-slate',  label: '長租契約' },
  earnest:  { bar: 'bg-[#C9A227]',  chip: 'bg-[#C9A227]',  label: '訂金／未確認' },
};
const TONES = Object.keys(TONE) as Stay['tone'][];

/** 重疊清單裡標「這一筆是哪裡來的」—— 沒有這兩個字就不知道去哪一頁修 */
const KIND: Record<Stay['kind'], string> = { contract: '契約', order: '訂單' };

/*
 * 提醒的紅色。
 *
 * ★★ 算過的:白字對比 **5.58:1**。`mor` 色盤裡最近的 `#C25B5B` 只有 4.25,
 *   而色條上的字是 11px 粗體 —— 小字更需要對比,不是更不需要。
 *   （2026-09-16 在三頁上抓到四處真的過不了的綠字之後,顏色一律先算再用。）
 *
 * ★ 刻意**不重用** `mor` 的任何一個:綠＝已收、藍＝主色、琥珀＝訂金、
 *   紫＝移轉。「快要結束了」是第五種意思,借用會讓那個顏色失去原本的意思。
 */
const ALERT = '#B3423C';

/** `2026-10-26` → `10/26`。年份在篩選列上，這裡再寫一次只是雜訊 */
const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * 重疊清單裡的日期。**同一年只寫月／日，跨年才補上年份。**
 *
 * ★ 長租契約動不動就是 `2025-09-01 ~ 2027-08-31` —— 那兩個年份是重點，
 *   省掉的話「9/1 ~ 8/31」看起來像一段倒著走的日期。
 * ★ 反過來，同一年的每一個日期都掛年份的話，四個數字裡有兩個是雜訊。
 */
const dLabel = (d: string | null | undefined, refYear: string) => {
  if (!d) return '—';
  return d.slice(0, 4) === refYear ? mdOf(d) : `${Number(d.slice(0, 4))}/${mdOf(d)}`;
};

const thisYm = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Est = { id: string; name: string; sort: number | null; active: boolean };

/**
 * ② 藥丸。**一顆元件畫完所有的藥丸** —— 兩排各寫一次就會有長得不一樣的一天。
 *
 * ★ 定在模組層不是元件裡:定在元件裡的話每一次 render 都是一個新的型別，
 *   React 會把整排拆掉重做，而且焦點會掉。
 */
function Pill({ on, onClick, swatch, children, warn }: {
  on: boolean; onClick: () => void; swatch?: string; children: React.ReactNode; warn?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs
                  transition-colors whitespace-nowrap ${
        on ? (warn ? 'bg-amber-700 border-amber-700 text-white'
                   : 'bg-mor-ink border-mor-ink text-white')
           : (warn ? 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                   : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60')}`}>
      {swatch && <i className={`w-2.5 h-2.5 rounded-sm shrink-0 ${swatch} ${
        on ? 'ring-2 ring-white/85' : ''}`} />}
      {children}
    </button>
  );
}

/** ③ 點開的那張卡片。位置用 `fixed` —— 見下面 `openCard()` 的說明 */
type Picked = { stay: Stay; room: string; estate: string | null; x: number; y: number };

export default function RoomStatusPage() {
  const supabase = useMemo(() => createClient(), []);

  /*
   * ① 期間。`month` 與 `custom` 兩種模式，但**算出來都是一個 Range** ——
   *   底下一律只認 `range`，沒有第二條路徑。
   */
  const [mode, setMode] = useState<'month' | 'custom'>('month');
  const [ym, setYm] = useState(thisYm());
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(addDays(todayStr(), 30));

  const [estF, setEstF] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');

  /*
   * ② 藥丸。**全部是同一組單選**（2026-09-16 使用者:「空房 與 有訂單 是 MECE」）。
   *
   *   上排　所有客戶 ／ 短租 ／ 私下 ／ 長租契約 ／ 訂金
   *   下排　空房 ／ ⚠ 重疊
   *
   * ★★★ 空房與有客**互斥且窮盡**:一間房在這段期間裡不是有人就是沒人，
   *   沒有第三種。所以它們不能是兩個各自獨立的開關 ——
   *   兩個開關可以同時打開，而「有客 ＋ 空房」是一個不存在的東西。
   *
   *   第一版就是那樣做的，結果:`空房` 問的是「有沒有**任何一天**是空的」，
   *   於是 4B2（9/4 才入住）也算空房 —— 使用者:「空房還有人耶」。
   *   ★ 一顆叫「空房」的藥丸，答案裡不可以有人。
   *
   * ★ 分兩排只是**視覺分組**（上排問「是什麼客」、下排問「什麼狀態」），
   *   行為上是同一組:點一個就只剩那一種，再點一下清除。
   *
   * ★ 「⚠ 重疊」也放進同一組。它嚴格說不屬於那個二分（重疊的房當然有客），
   *   但它跟其他幾顆問的是同一件事 ——「我現在要看哪一批房」。
   *   讓它獨立的話就又回到「兩個開關可以湊出沒有意義的組合」。
   */
  type View = '' | 'any' | Stay['tone'] | 'free' | 'dup' | 'ending' | 'leaving';
  const [view, setView] = useState<View>('');
  /*
   * ★★★ 三顆提醒旋鈕。**是模式不是篩選** ——
   *   打開＝標示 ＋ 展開明細,畫面上的房間一間都不會少。
   *   要縮到只剩那幾間的話,明細裡有「只看這幾間 →」。
   *   把篩選做成打開提醒的副作用的話,人只是想看一眼有哪幾間,整張表就不見了。
   */
  const [showDup, setShowDup] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [showOut, setShowOut] = useState(false);
  /*
   * ★★★ 提醒**另外撈一份**,不從日曆那一份算。
   *   日曆撈的是「跟目前這段期間有交集」的單 —— 翻到十二月的時候,
   *   十月到期的契約根本不在裡面。而提醒問的是
   *   「真實世界接下來 45 天會空出哪幾間」,那個答案不該跟著月份變。
   */
  const [ending, setEnding] = useState<Exit[]>([]);
  const [leaving, setLeaving] = useState<Exit[]>([]);
  /** 點同一顆就清除 —— 使用者:「再點一下 就清除」 */
  const pick = (v: View) => setView((cur) => (cur === v ? '' : v));

  const [estates, setEstates] = useState<Est[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  /** 還在用、但沒設物業的房源名稱 —— 畫不出來，所以列出來 */
  const [noEstate, setNoEstate] = useState<string[]>([]);
  const [stays, setStays] = useState<Stay[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Picked | null>(null);

  /*
   * ★★ 一進來就選好物業（使用者 2026-09-15：「預設物業選正隆」）。
   *   排序第一個 —— 不是把「正隆」寫死在這裡。多一個物業的那天，
   *   把它的 `sort` 調到前面就好，不用再改一次程式。
   */
  const defaulted = useRef(false);
  const defEst = estates[0]?.name ?? '';

  const range: Range = useMemo(
    () => (mode === 'month' ? monthRange(ym) : { from, to }),
    [mode, ym, from, to]);
  const nDays = rangeDays(range);
  const days = useMemo(() => (nDays > MAX_RANGE_DAYS ? [] : eachDay(range)), [range, nDays]);
  const today = todayStr();

  /*
   * ★★ 範圍不能用的兩種情形要**分開講**:
   *   顛倒／沒填完 → 使用者正在打字或打反了
   *   太長　　　　 → 資料是對的，只是畫不下
   * 合成一句「範圍不對」的話，兩種都不知道下一步該做什麼。
   */
  const noDates = mode === 'custom' && (!from || !to);
  const badRange = mode === 'custom' && !noDates && nDays === 0;
  const tooLong = nDays > MAX_RANGE_DAYS;
  const canDraw = !noDates && !badRange && !tooLong;

  const load = useCallback(async () => {
    if (!canDraw) { setLoading(false); return; }
    setLoading(true);
    const f = range.from;
    const t = range.to;

    const [{ data: es }, { data: ps }] = await Promise.all([
      supabase.from('estates').select('id, name, sort, active').order('sort'),
      /*
       * ★ 停用的房源不畫（使用者 2026-09-15：「物業只有正隆」）。
       * ★★ 取消勾「排房表」的也不畫（migration_255）——
       *   2B10 那種沒在出租、但支出記在它頭上的房源，
       *   停用會讓它從房務、清潔、採購一起消失，而支出還要繼續記。
       *   所以是兩個開關，不是一個。
       */
      supabase.from('properties').select('id, name, estate_id')
        .eq('active', true).eq('show_in_room_calendar', true).order('name'),
    ]);
    /*
     * ★★★ 停用的物業不畫（使用者 2026-09-15：「我只需要這一頁不要顯示」）。
     * ★★ 撈全部的物業，再自己篩 —— 停用的物業要能跟「根本沒設物業」分開:
     *   前者是使用者自己按的，安靜不畫就對了；
     *   後者是漏填，要跳出來叫他去補。
     */
    const estAll = (es ?? []) as Est[];
    const estById: Record<string, Est> = {};
    estAll.forEach((e) => { estById[e.id] = e; });

    const shown = estAll.filter((e) => e.active);
    setEstates(shown);
    if (!defaulted.current && shown.length) {
      defaulted.current = true;
      setEstF(shown[0].name);
    }

    const ownEst = ((ps ?? []) as any[]).map((p) => ({
      name: p.name as string, est: estById[p.estate_id] as Est | undefined,
    }));
    setRooms(ownEst
      .filter((r) => r.est?.active)
      .map((r) => ({ name: r.name, estate: r.est!.name, estateSort: r.est!.sort })));
    setNoEstate(ownEst.filter((r) => !r.est).map((r) => r.name));

    /*
     * ★★ 撈的是「跟這段有交集」的，不是「起日在這段裡」的 ——
     *   後者會漏掉跨進來的長住（8/20 住到 9/10 那種），
     *   而畫面上那間房會顯示成空的。
     *
     * ★ 訂單的 checkout 是**退房日**，所以條件要 `> from` 不是 `>= from`：
     *   9/1 退房的單最後一晚是 8/31，跟九月沒有交集。
     */
    const { rows: os } = await fetchAll<any>((a, b) => supabase.from('orders')
      .select('id, property_raw, guest_name, checkin, checkout, source, imported_via, contract_id')
      .not('source', 'in', '(oneoff,airbnb_cancelled)')
      .lte('checkin', t).gt('checkout', f).range(a, b));

    const { data: cs } = await supabase.from('contracts')
      .select('id, room, tenant_name, display_name, start_date, end_date, active, earnest_only')
      .lte('start_date', t).gte('end_date', f);

    const oStays: Stay[] = ((os ?? []) as any[])
      .filter((o) => o.property_raw)
      .map((o) => ({
        id: `o${o.id}`, srcId: o.id as string,
        room: o.property_raw as string, kind: 'order' as const,
        start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
        contractId: o.contract_id as string | null,
      }));

    const cStays: Stay[] = ((cs ?? []) as any[])
      .filter((c) => c.room && c.active !== false)
      .map((c) => ({
        id: `c${c.id}`, srcId: c.id as string,
        room: c.room as string, kind: 'contract' as const,
        start: c.start_date, end: c.end_date,
        guest: c.display_name || c.tenant_name,
        /*
         * ★ 還在訂金階段的契約單獨一色（使用者 2026-09-15 選的）。
         *   房客還沒入住，但那間房**已經不能給別人** ——
         *   畫成一般長租的話看起來像已經住進去了。
         */
        tone: (c.earnest_only ? 'earnest' : 'longterm') as Stay['tone'],
        contractId: c.id as string,
      }));

    /*
     * ★★★ 契約產生的月租單跟契約畫的是同一段期間 ——
     *   兩筆都留的話每一間長租房的每一天都會被算成「重疊」
     *   （2026-09-15 上線第一天的樣子）。規則與理由在 `dropContractOrders()`。
     */
    setStays(dropContractOrders([...oStays, ...cStays]));

    /*
     * ══════════ 退租／退房提醒（2026-09-16）══════════
     *
     * ★★★ **另外一份查詢**,基準是今天不是 `range`。
     *   翻到十二月的時候,十月到期的契約不在日曆那一份裡 ——
     *   而提醒問的是「真實世界接下來會空出哪幾間」。
     *
     * ★★★ 訂單要排掉 `contract_id` 有值的那些。
     *   那是契約每個月長出來的**月租單**,它的 checkout 是下個月一號 ——
     *   拿去算「7 天內退房」的話,每一間長租房每個月都會叫一次,
     *   而那個人根本沒有要退房。這一條錯的話,提醒會變成每月固定的雜訊,
     *   然後就沒有人再看它。
     */
    const t0 = todayStr();
    const [{ data: ce }, { rows: oe }] = await Promise.all([
      supabase.from('contracts')
        .select('id, room, tenant_name, display_name, start_date, end_date')
        .eq('active', true).gte('end_date', t0).lte('end_date', addDays(t0, ENDING_DAYS)),
      fetchAll<any>((a, b) => supabase.from('orders')
        .select('id, property_raw, guest_name, checkin, checkout, source, contract_id')
        .not('source', 'in', '(oneoff,airbnb_cancelled)')
        .is('contract_id', null)
        .gte('checkout', t0).lte('checkout', addDays(t0, LEAVING_DAYS)).range(a, b)),
    ]);

    const eStays: Stay[] = ((ce ?? []) as any[])
      .filter((c) => c.room)
      .map((c) => ({
        id: `c${c.id}`, srcId: c.id as string, room: c.room as string,
        kind: 'contract' as const, start: c.start_date, end: c.end_date,
        guest: c.display_name || c.tenant_name, tone: 'longterm' as const,
      }));
    const lStays: Stay[] = (oe ?? [])
      .filter((o: any) => o.property_raw)
      .map((o: any) => ({
        id: `o${o.id}`, srcId: o.id as string, room: o.property_raw as string,
        kind: 'order' as const, start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
      }));

    setEnding(exitsSoon(eStays, t0, 'contract', ENDING_DAYS));
    setLeaving(exitsSoon(lStays, t0, 'order', LEAVING_DAYS));
    setLoading(false);
  }, [supabase, range.from, range.to, canDraw]);
  useEffect(() => { load(); }, [load]);

  /** 房源 → 這段的佔用 */
  const byRoom = useMemo(() => {
    const m: Record<string, Stay[]> = {};
    stays.forEach((s) => { (m[s.room] ??= []).push(s); });
    return m;
  }, [stays]);

  /*
   * ★★ 兩層:`base` 只套物業與關鍵字，`visible` 再套藥丸。
   *
   *   ★★★ 「⚠ 重疊」藥丸上的數字必須算在 `base` 上 ——
   *     算在 `visible` 上的話，按下那顆藥丸之後數字會變成它自己篩出來的結果，
   *     而人看到的是一個**按下去就不再變**的數字，等於它沒在報告任何事。
   */
  const base = useMemo(() => {
    if (!canDraw) return [];
    const picked0 = estF ? rooms.filter((r) => r.estate === estF) : rooms;
    return sortRooms(picked0)
      .map((r) => ({ room: r, stays: byRoom[r.name] ?? [] }))
      .filter((x) => matchRoom(x.room, x.stays, kw))
      .map((x) => ({
        ...x,
        cells: rowOf(x.stays, range),
        real: staysInRange(x.stays, range),
        dups: overlapRanges(x.stays, range),
      }));
  }, [rooms, byRoom, estF, kw, range, canDraw]);

  const dupRooms = useMemo(() => base.filter((x) => x.dups.length), [base]);

  /*
   * ★★ 提醒照**物業**收窄,不照關鍵字與藥丸。
   *   物業是「我現在在管哪一棟」——那是範圍；
   *   關鍵字與藥丸是「我現在在看什麼」——那是視角。
   *   讓提醒跟著搜尋框變的話,打字打到一半數字會自己跳,
   *   而那個數字的意思是「有幾件事要處理」。
   */
  const scope = useMemo(() => {
    const names = new Set(rooms.filter((r) => !estF || r.estate === estF).map((r) => r.name));
    return names;
  }, [rooms, estF]);
  const endList  = useMemo(() => ending.filter((e) => scope.has(e.stay.room)), [ending, scope]);
  const outList  = useMemo(() => leaving.filter((e) => scope.has(e.stay.room)), [leaving, scope]);

  /*
   * 要畫成紅色的那幾筆。★ 比對的是 **id**,不是房號 ——
   *   同一間房這個月可能有兩筆,只有快結束的那一筆該變紅。
   */
  const hot = useMemo(() => {
    const m = new Map<string, { days: number; word: string }>();
    if (showEnd) endList.forEach((e) => m.set(e.stay.id, { days: e.days, word: '退租' }));
    if (showOut) outList.forEach((e) => m.set(e.stay.id, { days: e.days, word: '退房' }));
    return m;
  }, [showEnd, showOut, endList, outList]);
  /*
   * 目前這段期間裡**真的畫得出來**的那幾筆。
   *
   * ★★ 提醒算的是今天,而畫面可能停在十二月 —— 兩邊對不上是正常的。
   *   對不上的時候要**講出來**（「這 3 筆都不在目前的期間裡」），
   *   不然使用者會打開提醒、看到一條紅的都沒有,然後以為功能壞了。
   */
  const drawnIds = useMemo(() => {
    const m = new Set<string>();
    base.forEach((x) => x.real.forEach((st) => m.add(st.id)));
    return m;
  }, [base]);

  /* 「只看這幾間」用房號 —— 提醒的那幾筆不見得在目前的期間裡,比 id 會比不到 */
  const endRooms = useMemo(() => new Set(endList.map((e) => e.stay.room)), [endList]);
  const outRooms = useMemo(() => new Set(outList.map((e) => e.stay.room)), [outList]);
  /*
   * ★★ 有客與空房的間數。**這兩個加起來一定等於 base 的長度** ——
   *   寫在藥丸上是為了讓它自己證明這件事:數字對不起來就是哪裡漏了，
   *   而不是等使用者發現「空房裡面還有人」。
   */
  const nOccupied = useMemo(() => base.filter((x) => x.real.length > 0).length, [base]);
  const nFree = base.length - nOccupied;

  const visible = useMemo(() => base.filter((x) => {
    /*
     * ★★ 一律看 `real`（這段裡真的佔到日子的每一筆），不看 `cells` ——
     *   `rowOf()` 同一天只畫第一筆，被壓住的那一筆在 `cells` 裡根本不存在。
     *   拿 `cells` 篩的話，「只看短租」會漏掉被長租壓住的那張短租單，
     *   而那正是最需要被看見的一筆。
     *
     * ★★★ `free` 是 `real.length === 0`（整段都沒人），
     *   **不是** `hasFreeDay()`（有任何一天是空的）。
     *   後者是第一版的寫法，而它會把「9/4 才入住」的房算成空房 ——
     *   使用者:「空房還有人耶」。這兩個問法的差別就是那顆藥丸有沒有用。
     */
    if (!view) return true;
    if (view === 'free') return x.real.length === 0;
    if (view === 'dup') return x.dups.length > 0;
    if (view === 'ending') return endRooms.has(x.room.name);
    if (view === 'leaving') return outRooms.has(x.room.name);
    if (view === 'any') return x.real.length > 0;
    return x.real.some((s) => s.tone === view);
  }), [base, view, endRooms, outRooms]);

  /*
   * ★★ 重疊清乾淨（或換了期間之後沒有重疊）時，那顆藥丸會消失 ——
   *   但 `view` 還停在 `'dup'`，畫面會變成一張空表而且**沒有東西可以點掉它**。
   *   會篩選的東西消失時，它篩出來的狀態也要跟著收掉。
   */
  useEffect(() => { if (view === 'dup' && !dupRooms.length) setView(''); }, [view, dupRooms.length]);

  /** 重疊清單的日期用哪一年當基準 —— 同一年就不寫年份 */
  const refYear = (range.from || `${new Date().getFullYear()}`).slice(0, 4);

  const dup = useMemo(
    () => dupRooms.flatMap((x) => x.dups.map((r) => ({ room: x.room.name, ...r }))),
    [dupRooms]);

  /*
   * ★ 預設的那個物業**不算篩選** —— 算的話篩選列一進來就亮著、
   *   「清除」永遠可按，而按下去什麼都沒變（它本來就是預設值）。
   * ★ 月份／自訂也算 —— 換過期間之後「清除」要回得去本月。
   */
  const active = !!((estF && estF !== defEst) || kw || view
    || showDup || showEnd || showOut
    || mode !== 'month' || ym !== thisYm());

  const clearAll = () => {
    setEstF(defEst); setKw(''); setKwInput('');
    setView('');
    /* ★ 旋鈕也關掉 —— 「清除」是回到剛進來的樣子,而剛進來三顆都是關的 */
    setShowDup(false); setShowEnd(false); setShowOut(false);
    setMode('month'); setYm(thisYm());
    setPicked(null);
  };

  /*
   * ③ 點色條開卡片。
   *
   * ★★★ 用 `fixed` 定位，不是在格子裡 `absolute`。
   *   表格在一個 `overflow-auto` 的容器裡 —— 在格子裡畫的話，
   *   卡片會被容器的邊界**裁掉**，而最後一列與最右邊幾天正是最常被點的地方。
   *
   * ★★ 座標當場從 `getBoundingClientRect()` 取，並且夾在視窗內:
   *   靠右的格子往左收、靠下的格子往上翻。
   */
  const openCard = (e: React.MouseEvent, stay: Stay, room: Room) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const W = 264;
    const H = 190;
    setPicked({
      stay, room: room.name, estate: room.estate,
      x: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      y: r.bottom + H + 8 > window.innerHeight ? Math.max(8, r.top - H - 6) : r.bottom + 6,
    });
  };

  return (
    <div onClick={() => picked && setPicked(null)}>
      <div className="flex items-center justify-between mb-4">
        <h1>房源狀態
          <span className="text-sm font-normal text-gray-400 ml-2">
            訂單與契約畫在同一條線上，空白就是空房
          </span>
        </h1>
      </div>

      <FilterBar active={active} right={<FilterCount n={visible.length} unit="間" />}>
        <FilterSelect label="物業" value={estF} onChange={setEstF}
          options={estates.map((e) => ({ value: e.name, label: e.name }))} />
        {/*
          ① 期間（2026-09-16 使用者:「filter 選月份外可以選 自訂 起訖」）。

          ★ 「月／自訂」做成兩段式切換不是下拉 —— 只有兩個選項，
            下拉要點兩下才換得過去，而這一顆會被換來換去。
        */}
        <Field label="期間">
          <div className="flex h-12 md:h-10 rounded-lg border border-gray-300 overflow-hidden">
            {([['month', '月'], ['custom', '自訂']] as const).map(([v, t]) => (
              <button key={v} onClick={() => setMode(v)}
                className={`px-3.5 text-uisub border-r border-gray-300 last:border-r-0 ${
                  mode === v ? 'bg-mor-slate text-white' : 'bg-white text-gray-600 hover:bg-mor-sand'}`}>
                {t}
              </button>
            ))}
          </div>
        </Field>
        {mode === 'month' ? (
          <Field label="月份">
            <input type="month" value={ym} onChange={(e) => setYm(e.target.value || thisYm())}
              className="h-12 md:h-10 rounded-lg border border-gray-300 px-2 text-ui" />
          </Field>
        ) : (
          <>
            <Field label="起">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="h-12 md:h-10 rounded-lg border border-gray-300 px-2 text-ui" />
            </Field>
            <Field label="迄">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className={`h-12 md:h-10 rounded-lg border px-2 text-ui ${
                  badRange || tooLong ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
            </Field>
          </>
        )}
        {/*
          ★ placeholder 寫「可以搜哪些」—— 標題一律留「關鍵字」（filters.tsx 的規矩）。
            使用者 2026-09-15 指定要能打房客名字，所以那三個字一定要出現在這裡，
            不然沒有人會知道搜得到。
        */}
        <FilterSearch value={kwInput} onChange={setKwInput}
          onSubmit={() => setKw(kwInput.trim())} placeholder="房源／房客" />
        {/* ★ 清除也要把輸入框清掉 —— 只清 kw 的話框裡還留著字，看起來像沒生效 */}
        {/* ★ 清除是回到「預設」，不是回到「全部」 */}
        <FilterClear active={active} onClear={clearAll} />
      </FilterBar>

      {/*
        ① 自訂模式的快捷。★ 只在自訂時出現 —— 月檢視有月份挑選器，
          再擺四顆按鈕只是兩套做同一件事。
      */}
      {mode === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 -mt-1 mb-3">
          <span className="text-[11px] font-semibold text-gray-500">快捷</span>
          {([
            ['本月', () => { const r = monthRange(thisYm()); setFrom(r.from); setTo(r.to); }],
            ['未來 30 天', () => { setFrom(today); setTo(addDays(today, 30)); }],
            ['未來 60 天', () => { setFrom(today); setTo(addDays(today, 60)); }],
            ['未來 90 天', () => { setFrom(today); setTo(addDays(today, 90)); }],
          ] as const).map(([t, fn]) => (
            <button key={t} onClick={fn}
              className="rounded-full border border-mor-line bg-white px-3 py-1 text-[11.5px]
                         text-mor-slate hover:bg-mor-bluelight/60">{t}</button>
          ))}
        </div>
      )}

      {/*
        ★★ 沒設物業的房源畫不出來（左邊那一欄要顯示物業、篩選也是按物業）。
          但**靜靜不見**是最糟的做法 —— 有人新增了房源忘了選物業，
          它就會從此不在任何一張排房表上，而沒有人會發現。
      */}
      {noEstate.length > 0 && (
        <div className="mb-3 rounded-xl border border-mor-line bg-mor-sand/60 px-4 py-2.5 text-xs text-gray-600">
          <b>{noEstate.length} 間房源沒有設定物業</b>，沒有畫在下面 ——
          到「管理 → 物業與房源」把它們歸到物業底下就會出現：
          <span className="ml-1 text-gray-500">{noEstate.join('、')}</span>
        </div>
      )}

      {/*
        ══════════ ② 藥丸（2026-09-16）══════════

        ★★★ 圖例本來在表格**底下** —— 要先捲過 72 列才看得到顏色的意思，
          而看顏色的時候人在最上面。搬上來順便讓它變成篩選。

        ★★ 分兩排（使用者:「分兩條」）:
            上排　是什麼客　所有客戶／短租／私下／長租契約／訂金
            下排　什麼狀態　空房　＋（右邊）三顆提醒旋鈕

        ★ 2026-09-16:「⚠ 重疊」從藥丸變成**旋鈕** ——
          它原本同時是篩選又一直攤著一段明細,一件事兩個入口。
          現在數字留在旋鈕上（警報還在,收起來也看得到）、明細收進去、
          要篩選走明細裡的「只看這幾間」。

          ★★★ 兩排是**同一組單選**，不是兩個獨立的開關
            （2026-09-16 使用者:「空房 與 有訂單 是 MECE」）。
            一間房在這段期間裡不是有人就是沒人 —— 兩個獨立的開關可以同時打開，
            而「有客 ＋ 空房」是一個不存在的東西。分排只是視覺分組。

        ★ 原本篩選列裡的「顯示：全部／只看空房／只看有客」拿掉了 ——
          「只看空房」＝ 下排的空房，「只看有客」＝ 上排的「所有客戶」。
          同一件事留兩個入口的話，兩邊遲早會不一致。
      */}
      <div className="space-y-2 mb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill on={view === 'any'} onClick={() => pick('any')}>
            所有客戶 {nOccupied}
          </Pill>
          {TONES.map((k) => (
            <Pill key={k} swatch={TONE[k].chip} on={view === k} onClick={() => pick(k)}>
              {TONE[k].label}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            ★★★ 空房 ＝ **整段都沒人**（`real.length === 0`），
              不是「有任何一天是空的」。跟上面那顆「所有客戶」加起來
              就是全部的房 —— 數字寫在藥丸上，看得出有沒有漏。
          */}
          <Pill on={view === 'free'} onClick={() => pick('free')}
            swatch="bg-white border border-mor-line">空房 {nFree}</Pill>

          {/*
            ★★ 三顆提醒被篩選中時，這裡出現一顆可以關掉的籤。
              沒有它的話，使用者按了明細裡的「只看這幾間」之後，
              表格短了一截而畫面上**沒有任何東西說是誰做的** ——
              然後他會以為資料不見了。
          */}
          {(view === 'dup' || view === 'ending' || view === 'leaving') && (
            <button type="button" onClick={() => setView('')}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-300
                         bg-amber-50 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100">
              只看{view === 'dup' ? '重疊' : view === 'ending' ? '快退租' : '快退房'}的
              <span className="opacity-70">✕</span>
            </button>
          )}

          {/*
            ══════════ 三顆提醒旋鈕（2026-09-16 使用者:「像一個旋鈕點開」）══════════

            ★★★ 用 `ToggleInfo` —— 站上「👀 防呆」「★ 重要支出」就是這一顆。
              同一種東西長同一個樣子,不另外發明。

            ★★ 它們是**模式**不是篩選:打開＝標示 ＋ 展開明細,房間一間都不會少。
              要縮表格走明細裡的「只看這幾間 →」。

            ★ 沒有東西可以提醒的時候**整顆不出現**,不是顯示 0 ——
              一顆永遠亮著的 0 會變成畫面的一部分,久了沒有人再看它。
          */}
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {dupRooms.length > 0 && (
              <ToggleInfo tone="amber" on={showDup} onToggle={() => setShowDup((v) => !v)}
                label={<>⚠ 重疊 <b className="tabular-nums">{dupRooms.length}</b></>}
                infoLabel="什麼是重疊">
                同一間房在同一天有兩筆以上。日曆上<b>只畫得下其中一筆</b>，
                所以另一筆會安靜地不見 —— 這裡把它列出來。
              </ToggleInfo>
            )}
            {endList.length > 0 && (
              <ToggleInfo tone="red" on={showEnd} onToggle={() => setShowEnd((v) => !v)}
                label={<>退租提醒 <b className="tabular-nums">{endList.length}</b></>}
                infoLabel="退租提醒怎麼算">
                <b>契約</b>在 {ENDING_DAYS} 天內到期的。算的是<b>今天</b>起算，
                不是你正在看的那個月 —— 這個數字問的是「接下來會空出哪幾間」。
              </ToggleInfo>
            )}
            {outList.length > 0 && (
              <ToggleInfo tone="red" on={showOut} onToggle={() => setShowOut((v) => !v)}
                label={<>退房提醒 <b className="tabular-nums">{outList.length}</b></>}
                infoLabel="退房提醒怎麼算">
                <b>短租訂單</b>在 {LEAVING_DAYS} 天內退房的。
                月租單不算 —— 那是契約每個月長出來的帳，不是真的有人要走。
              </ToggleInfo>
            )}
          </span>
        </div>
      </div>

      {/* ── 明細：三顆旋鈕打開才出現 ── */}
      {showDup && dup.length > 0 && (
        <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3
                        text-xs text-amber-900">
          <div className="flex items-center gap-2 font-bold mb-2">
            ⚠ 同一間房同時有兩筆
            <span className="font-normal opacity-80">日曆上只畫得下其中一筆</span>
            <button onClick={() => setView('dup')}
              className="ml-auto font-normal underline hover:no-underline">
              只看這 {dupRooms.length} 間 →
            </button>
          </div>
          <div className="space-y-3">
            {dup.map((d) => (
              <div key={`${d.room}/${d.from}`}>
                <div className="font-bold">
                  {d.room}
                  <span className="ml-2 font-normal text-amber-700">
                    {mdOf(d.from)}{d.to === d.from ? '' : ` ~ ${mdOf(d.to)}`} 這幾天疊在一起
                  </span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {d.stays.map((st) => {
                    const last = lastNightOf(st);
                    return (
                      <div key={st.id} className="flex flex-wrap items-baseline gap-x-2 pl-3">
                        <span className="text-amber-600">・</span>
                        <span className="font-medium">{st.guest || '（沒有名字）'}</span>
                        <span className="text-amber-700">（{KIND[st.kind]}）</span>
                        <span className="tabular-nums">
                          {dLabel(st.start, refYear)} ~ {dLabel(st.end, refYear)}
                        </span>
                        {st.kind === 'order' && last && (
                          <span className="text-amber-700 tabular-nums">
                            最後一晚 {dLabel(last, refYear)}
                          </span>
                        )}
                        <a href={st.kind === 'contract' ? `/contracts?contract=${st.srcId}`
                                                       : `/shortterm?order=${st.srcId}`}
                          target="_blank" rel="noreferrer"
                          className="text-amber-800 underline hover:text-amber-900">打開 →</a>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showEnd && (
        <ExitList kind="ending" list={endList} days={ENDING_DAYS} drawn={drawnIds}
          onFilter={() => setView('ending')}
          onRange={() => { setMode('custom'); setFrom(today); setTo(addDays(today, ENDING_DAYS)); }} />
      )}
      {showOut && (
        <ExitList kind="leaving" list={outList} days={LEAVING_DAYS} drawn={drawnIds}
          onFilter={() => setView('leaving')}
          onRange={() => { setMode('custom'); setFrom(today); setTo(addDays(today, LEAVING_DAYS)); }} />
      )}

      {/* ① 範圍不能畫的兩種情形分開講 —— 見上面 `badRange` / `tooLong` 的說明 */}
      {noDates ? (
        <div className="rounded-xl border border-mor-line bg-white px-4 py-6 text-center text-sm text-gray-400">
          選一個起日與迄日。
        </div>
      ) : badRange ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800">
          起日要在迄日之前 —— 現在是 <b>{from}</b> ~ <b>{to}</b>。
        </div>
      ) : tooLong ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-800">
          這段有 <b>{nDays}</b> 天，一次最多畫 <b>{MAX_RANGE_DAYS}</b> 天。<br />
          <span className="text-xs">再長的話橫向要捲三個螢幕以上，捲到後面就看不出自己在看哪一天了。</span>
        </div>
      ) : (
      /*
        ★★ 左邊房源欄與上面日期列都**釘住**（sticky）。
          橫軸三十天一定要橫向捲動，不釘住的話捲到第 20 天
          就看不出這是哪一間、哪一號（anxing-ui 第二節）。
      */
      <div className="rounded-xl border border-mor-line bg-white overflow-auto max-h-[70vh]">
        <table className="border-separate border-spacing-0 text-xs w-max min-w-full">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 bg-mor-sand border-b border-r border-mor-line
                             min-w-[150px] max-w-[150px] px-2.5 py-1.5 text-left font-semibold">房源</th>
              {/*
                ★★★ 「今天」畫在**表頭**，不是畫在格子上。
                  有人住的那幾天會被合併成**一個** `td`（`colSpan`），
                  那個 td 的 `day` 是**起日**不是今天，所以條件永遠不成立:
                  結果只有空房那幾列畫得出來，看起來就是一條來路不明的藍線
                  （使用者 2026-09-15：「中間藍色的是甚麼」）。

                ★ 跨月的時候每個月的 1 號多標一個月份 ——
                  不標的話「30、1、2」中間那一格是哪個月要用猜的。
              */}
              {days.map((day) => {
                const d = Number(day.slice(8, 10));
                const w = weekdayOf(day);
                const isToday = day === today;
                const first = d === 1;
                return (
                  <th key={day} className={`sticky top-0 z-20 border-b border-r border-mor-line
                      min-w-[42px] py-1 text-center font-semibold
                      ${isToday ? 'bg-mor-slate text-white'
                                : `bg-mor-sand ${isWeekend(day) ? 'text-[#C25B5B]' : ''}`}`}>
                    {first && !isToday
                      ? <span className="text-mor-slate">{Number(day.slice(5, 7))}/1</span>
                      : d}
                    <div className={`font-normal text-[10px] ${isToday ? 'opacity-100' : 'opacity-70'}`}>
                      {isToday ? '今天' : WD[w]}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ room, cells, dups }) => (
              <tr key={`${room.estate}/${room.name}`}
                className={`h-8 ${dups.length ? 'bg-[#FFFDF6]' : ''}`}>
                <td className={`sticky left-0 z-10 border-b border-r border-mor-line
                               min-w-[150px] max-w-[150px] px-2.5 font-medium whitespace-nowrap
                               overflow-hidden text-ellipsis ${dups.length ? 'bg-[#FFFDF6]' : 'bg-white'}`}>
                  {room.name}
                  <span className="text-gray-400 font-normal text-[11px] ml-1.5">{room.estate}</span>
                </td>
                {cells.map((c: Cell) => {
                  const cls = `relative border-b border-r border-mor-line min-w-[42px]
                    ${isWeekend(c.day) ? 'bg-mor-bg/50' : ''}`;
                  if (c.type === 'free') return <td key={c.day} className={cls} />;
                  /*
                    ② 沒被選到的色條**淡掉，不是消失**。
                    ★★★ 那幾天還是有人。整條拿掉的話畫面會說那間房空著 ——
                      而有人會照著它排房。淡掉＝「不是你現在在找的，但它佔著」。
                  */
                  const dimmed = view !== '' && view !== 'any' && view !== 'free'
                    && view !== 'dup' && view !== 'ending' && view !== 'leaving'
                    && c.stay.tone !== view;
                  /*
                   * ★★★ 快結束的畫成紅色。
                   *   ★ 只有**旋鈕打開**的時候才紅 —— 平常不紅,因為這一頁最常做的事
                   *     是看整體調性,而一排紅色會蓋過那件事。
                   *   ★★ 尾巴直接寫「還有 N 天退房」:訂單的色條畫到 checkout 的
                   *     **前一天**為止,而提醒說的是 checkout 當天 ——
                   *     那個差一天是對的,但不寫出來的話看起來就是畫錯。
                   */
                  const hit = hot.get(c.stay.id);
                  return (
                    <td key={c.day} colSpan={c.span} className={cls}>
                      <button type="button" onClick={(e) => openCard(e, c.stay, room)}
                        style={hit ? { background: ALERT } : undefined}
                        className={`absolute inset-y-1 inset-x-0.5 rounded-md px-1.5
                          flex items-center text-[11px] font-semibold text-white
                          whitespace-nowrap overflow-hidden transition-opacity
                          ${hit ? '' : TONE[c.stay.tone].bar}
                          ${dimmed ? 'opacity-20' : 'hover:brightness-110'}`}>
                        <span className="truncate">{c.stay.guest ?? ''}</span>
                        {hit && (
                          <span className="ml-auto pl-1.5 text-[9px] font-extrabold opacity-90
                                           shrink-0 tabular-nums">
                            {hit.days === 0 ? `今天${hit.word}` : `還有 ${hit.days} 天${hit.word}`}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={days.length + 1} className="px-4 py-8 text-center text-gray-400">
                沒有符合的房源
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {/*
        ★★★ 兩種「迄」的規則寫在畫面上（使用者 2026-09-15 定的）。
          不寫的話，看到「9/18 退房那格是空的」的人會以為畫錯了 ——
          而那一格空著正是對的，當天可以接新客。
      */}
      <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
        短租的「迄」是<b>退房日</b>，最後一晚是前一天（9/18 退房 → 只佔到 17 號，18 號可接新客）；
        契約的「迄」<b>就是最後一晚</b>，含當日。
      </p>

      {/* ③ 點開的卡片 —— 見上面 `openCard()` */}
      {picked && <StayCard p={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

/**
 * ③ 點色條跳出來的卡片（2026-09-16 使用者:「點了會出現 名稱 與 期間 > 現在是hover」）。
 *
 * ★★★ 原本是 `title=`。手機**完全沒有 hover** —— 也就是一半的使用情境下
 *   這個資訊根本不存在。桌機上也要等一秒、滑開就消失、複製不了。
 *
 * ★★ 寫的是**真實的起訖**，不是畫面上被切掉的那一段。
 *   8/20 住到 9/10 的單，九月的畫面從 1 號開始，卡片要說 8/20。
 *   說 9/1 的話，人會以為這是一張九月才開始的單。
 *
 * ★★★ 「最後一晚」單獨一行。短租的「迄」是**退房日** ——
 *   這一頁最常被誤會的就是這件事（「9/18 退房那格為什麼是空的」）。
 *   把最後一晚直接寫出來，那一格為什麼空著就不用再問了。
 */
function StayCard({ p, onClose }: { p: Picked; onClose: () => void }) {
  const s = p.stay;
  const last = lastNightOf(s);
  const nights = s.start && last ? daysBetween(s.start, last) + 1 : 0;
  const href = s.kind === 'contract' ? `/contracts?contract=${s.srcId}` : `/shortterm?order=${s.srcId}`;
  return (
    <>
      {/* 點外面關掉。★ 蓋滿整個視窗 —— 只靠色條自己的 blur 的話，捲動時會關不掉 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        style={{ left: p.x, top: p.y }}
        className="fixed z-50 w-[264px] rounded-xl border border-mor-line bg-white p-3 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-bold text-sm">
              <i className={`w-2.5 h-2.5 rounded-sm shrink-0 ${TONE[s.tone].bar}`} />
              <span className="truncate">{s.guest || '（沒有名字）'}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {p.room}{p.estate ? `・${p.estate}` : ''}　{TONE[s.tone].label}
            </div>
          </div>
          <button onClick={onClose} aria-label="關閉"
            className="text-gray-400 hover:text-gray-600 text-base leading-none shrink-0">✕</button>
        </div>

        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 text-xs">
          <dt className="text-gray-400">期間</dt>
          <dd className="tabular-nums">{s.start ?? '—'} ~ {s.end ?? '—'}</dd>
          <dt className="text-gray-400">最後一晚</dt>
          <dd className="tabular-nums">
            {last ?? '—'}{nights > 0 && <span className="text-gray-400 ml-1">（住 {nights} 晚）</span>}
          </dd>
        </dl>

        <a href={href} target="_blank" rel="noreferrer"
          className="block mt-2.5 pt-2 border-t border-mor-line text-xs text-mor-slate hover:text-mor-slatedark">
          打開這張{KIND[s.kind]} →
        </a>
      </div>
    </>
  );
}

/**
 * 退租／退房提醒的明細（2026-09-16 使用者:「然後以上會有明細」）。
 *
 * ★★★ 這一段最重要的是**對不上的時候要講出來**。
 *
 *   提醒算的是**今天**起算的 N 天，而畫面可能停在十二月 ——
 *   打開旋鈕、日曆上一條紅的都沒有，是正常的。
 *   不講的話，看到的人會以為功能壞了，然後再也不開它。
 *
 *   所以沒有任何一筆在目前期間裡的時候，直接寫一行「都不在目前的期間裡」，
 *   旁邊一顆「看未來 N 天」把期間切過去 —— 說出問題，同時給出下一步。
 *
 * ★★ 每一列都有「打開契約／訂單 →」。看到要處理的事，下一步就是去處理它；
 *   沒有連結的話要自己回那一頁再搜一次房號。
 */
function ExitList({ kind, list, days, drawn, onFilter, onRange }: {
  kind: 'ending' | 'leaving';
  list: Exit[];
  days: number;
  drawn: Set<string>;
  onFilter: () => void;
  onRange: () => void;
}) {
  const isEnd = kind === 'ending';
  const title = isEnd ? '退租提醒' : '退房提醒';
  const sub = isEnd ? `契約在 ${days} 天內到期` : `短租訂單在 ${days} 天內退房`;
  const dateLabel = isEnd ? '退租日' : '退房日';
  const inView = list.filter((e) => drawn.has(e.stay.id));

  return (
    <div className="mb-2 rounded-xl border px-4 py-3 text-xs"
      style={{ borderColor: '#ECC8C5', background: '#FDF5F4', color: '#7A2F2A' }}>
      <div className="flex flex-wrap items-center gap-2 font-bold mb-2">
        {title}
        <span className="font-normal opacity-80">{sub}</span>
        <button onClick={onFilter} className="ml-auto font-normal underline hover:no-underline">
          只看這 {list.length} 間 →
        </button>
      </div>

      {!inView.length && (
        <div className="mb-2 leading-relaxed opacity-90">
          ⚠ 這 {list.length} 筆<b>都不在目前的期間裡</b> —— 日曆上不會有紅色。
          <button onClick={onRange}
            className="ml-2 rounded-md border px-2 py-0.5 text-[11px] bg-white hover:bg-red-50"
            style={{ borderColor: '#ECC8C5' }}>
            看未來 {days} 天
          </button>
        </div>
      )}

      <div className="space-y-0.5">
        {list.map((e) => (
          <div key={e.stay.id}
            className="flex flex-wrap items-baseline gap-x-2.5 py-0.5
                       border-t border-dashed border-black/10 first:border-t-0">
            <span className="font-bold min-w-[3.2rem]">{e.stay.room}</span>
            <span className="flex-1 min-w-[6rem]">{e.stay.guest || '（沒有名字）'}</span>
            <span className="tabular-nums opacity-85">{dateLabel} {e.on}</span>
            <span className={`font-extrabold tabular-nums ${e.days <= 7 ? '' : 'opacity-75'}`}>
              {e.days === 0 ? '就是今天' : `還有 ${e.days} 天`}
            </span>
            {!drawn.has(e.stay.id) && (
              <span className="opacity-60">（不在畫面上）</span>
            )}
            <a href={isEnd ? `/contracts?contract=${e.stay.srcId}`
                           : `/shortterm?order=${e.stay.srcId}`}
              target="_blank" rel="noreferrer"
              className="underline hover:no-underline">打開{isEnd ? '契約' : '訂單'} →</a>
          </div>
        ))}
      </div>

      {/*
        ★★★ 差一天那件事寫在這裡。
          訂單的色條畫到 checkout 的**前一天**為止，而這裡寫的是 checkout 當天 ——
          兩個數字差一天是對的，但不講的話看起來就是畫錯。
      */}
      <div className="mt-2 pt-2 border-t border-dashed border-black/15 text-[11px] opacity-85 leading-relaxed">
        {isEnd
          ? <>★ 契約的「迄」<b>就是最後一晚</b> —— 租期迄那天就是退租日，不用 ±1。</>
          : <>★ <b>checkout 是退房日</b>，最後一晚是它的前一天。
              色條畫到前一天為止，而這裡寫的是 checkout 當天 —— <b>差一天是對的</b>。</>}
      </div>
    </div>
  );
}
