'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, Field, FilterSelect, FilterSearch, FilterClear, FilterCount } from '@/lib/filters';
import {
  isWeekend, weekdayOf, sortRooms, matchRoom, rowOf,
  overlapRanges, dropContractOrders, monthRange, rangeDays, eachDay,
  staysInRange, lastNightOf, daysBetween, addDays, MAX_RANGE_DAYS,
  type Stay, type Room, type Cell, type Range,
} from '@/lib/room-calendar';

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
  type View = '' | 'any' | Stay['tone'] | 'free' | 'dup';
  const [view, setView] = useState<View>('');
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
    if (view === 'any') return x.real.length > 0;
    return x.real.some((s) => s.tone === view);
  }), [base, view]);

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
    || mode !== 'month' || ym !== thisYm());

  const clearAll = () => {
    setEstF(defEst); setKw(''); setKwInput('');
    setView('');
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
        ★★★ 一行一段，而且**寫出是哪幾筆**（使用者 2026-09-15）。
          原本只列「14B2 26、27、28、29、30、31 號」——
          他去契約清單搜 14B2 只有一筆，就沒路可走了。
          說得出「金鋒（契約）× Roni（訂單）」才修得動。

        ★ 2026-09-16:上面多了一顆「⚠ 重疊」藥丸負責**找**（把表格縮到那幾間），
          這一段負責**說是哪幾筆**。兩件事，所以兩個地方。
      */}
      {dup.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <b>同一間房同時有兩筆</b> —— 日曆上只畫得下其中一筆，所以這裡列出來：
          <div className="mt-2 space-y-3">
            {dup.map((d) => (
              <div key={`${d.room}/${d.from}`}>
                {/* 房源名自己一行，底下一筆一行（2026-09-16 使用者指定） */}
                <div className="font-bold">
                  {d.room}
                  <span className="ml-2 font-normal text-amber-700">
                    {mdOf(d.from)}{d.to === d.from ? '' : ` ~ ${mdOf(d.to)}`} 這幾天疊在一起
                  </span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {d.stays.map((s) => {
                    const last = lastNightOf(s);
                    return (
                      <div key={s.id} className="flex flex-wrap items-baseline gap-x-2 pl-3">
                        <span className="text-amber-600">・</span>
                        <span className="font-medium">{s.guest || '（沒有名字）'}</span>
                        <span className="text-amber-700">（{KIND[s.kind]}）</span>
                        {/*
                          ★★★ 寫的是**這一筆自己的起訖**（使用者:「期間是訂單起訖」），
                            不是上面那段重疊的日子 —— 要去修它的人需要知道
                            這張單本來是幾號到幾號，而不是它跟別人撞到的那幾天。

                          ★★ 訂單的「迄」是**退房日**，所以這個數字會跟日曆上的
                            色條**差一天**（使用者:「與房源顯示差一天」）。
                            那不是畫錯 —— 但不講的話看起來就是畫錯。
                            所以後面直接把「最後一晚」寫出來，兩個數字都給，
                            沒有人需要自己減一。契約的「迄」本來就是最後一晚，不用寫。
                        */}
                        <span className="tabular-nums">
                          {dLabel(s.start, refYear)} ~ {dLabel(s.end, refYear)}
                        </span>
                        {s.kind === 'order' && last && (
                          <span className="text-amber-700 tabular-nums">
                            最後一晚 {dLabel(last, refYear)}
                          </span>
                        )}
                        {/* 看到問題的下一步就是去修它 —— 沒有連結就要自己回那一頁再搜一次房號 */}
                        <a href={s.kind === 'contract' ? `/contracts?contract=${s.srcId}`
                                                       : `/shortterm?order=${s.srcId}`}
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

      {/*
        ══════════ ② 藥丸（2026-09-16）══════════

        ★★★ 圖例本來在表格**底下** —— 要先捲過 72 列才看得到顏色的意思，
          而看顏色的時候人在最上面。搬上來順便讓它變成篩選。

        ★★ 分兩排（使用者:「分兩條」）:
            上排　是什麼客　所有客戶／短租／私下／長租契約／訂金
            下排　什麼狀態　空房／⚠ 重疊

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
            ④-C（2026-09-16 使用者選的）。數字就是「有幾間要處理」——
            ★ 沒有重疊的時候**整顆不出現**，不是顯示 0。
              一顆永遠亮著的 0 會變成畫面的一部分，久了沒有人再看它。
          */}
          {dupRooms.length > 0 && (
            <Pill warn on={view === 'dup'} onClick={() => pick('dup')}>
              ⚠ 重疊 {dupRooms.length}
            </Pill>
          )}
        </div>
      </div>

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
                    && view !== 'dup' && c.stay.tone !== view;
                  return (
                    <td key={c.day} colSpan={c.span} className={cls}>
                      <button type="button" onClick={(e) => openCard(e, c.stay, room)}
                        className={`absolute inset-y-1 inset-x-0.5 rounded-md px-1.5
                          flex items-center text-[11px] font-semibold text-white
                          whitespace-nowrap overflow-hidden transition-opacity
                          ${TONE[c.stay.tone].bar} ${dimmed ? 'opacity-20' : 'hover:brightness-110'}`}>
                        {c.stay.guest ?? ''}
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
