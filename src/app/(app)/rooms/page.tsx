'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayStr } from '@/lib/period';
import { createClient } from '@/lib/supabase';
import Req from '@/components/Req';
import { findRooms, finderError, nightsBetween, type FinderSeg } from '@/lib/room-finder';
import { fetchAll } from '@/lib/fetch-all';
import { useProfile } from '@/lib/profile';
import { canEditOrders } from '@/lib/roles';
import { noteTable, normNote, noteChanged, noteSaveError } from '@/lib/stay-note';
import { FilterBar, Field, FilterSelect, FilterSearch, FilterClear, FilterCount } from '@/lib/filters';
import {
  isWeekend, weekdayOf, sortRooms, matchRoom, rowOf, exitsSoon,
  overlapRanges, dropContractOrders, monthRange, rangeDays, eachDay,
  staysInRange, lastNightOf, daysBetween, addDays, MAX_RANGE_DAYS, checkedOut,
  type Stay, type Room, type Cell, type Range, type Exit,
} from '@/lib/room-calendar';
/*
 * ★★★ 「幾天內」從寫死改成可以按（2026-09-16 使用者:
 *   「不要有 hardcode 什麼時候」「共同一組就好 / 7 14 30 45 全部」）。
 *
 *   同一排膠囊、同一個預設值，**跟房務管理的「未來提醒」共用一份** ——
 *   兩邊各寫一組的話，同一件事會有兩排長得不一樣的膠囊。
 */
import {
  ALERT_WINDOWS, OUT_WINDOWS, DEFAULT_END_WINDOW, DEFAULT_OUT_WINDOW, winLabel, winDays, parseWinOr, type AlertWindow,
} from '@/lib/hk-alerts';
import ToggleInfo from '@/components/ToggleInfo';
import { savedToast } from '@/lib/saved-feedback';
import { isManagerOrBoss, isFinance } from '@/lib/roles';
import { airbnbLinks } from '@/lib/airbnb-link';
import { parseRoomsPrefs, serializeRoomsPrefs, shiftYm, ROOMS_PREFS_KEY } from '@/lib/rooms-prefs';
import MovePanel, { type MoveRoom } from './move-panel';
import AddBookingPanel, { type Created } from './add-booking-panel';
import { useIsMobile } from '@/lib/use-is-mobile';
import {
  ancestryOf, occupancyOf, occupancyByRoom, totalOccupancy, fmtPct, occTone, type RoomNode,
} from '@/lib/occupancy';

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
  /* ★ 2026-10-19 David：「私下換顏色」—— 原本的綠跟短租的藍綠太像。看過稿選咖啡棕：跟訂金的黃、移房的紫、警示的紅都分得開，白字對比 5.4 */
  private:  { bar: 'bg-[#8A6142]',  chip: 'bg-[#8A6142]',  label: '私下' },
  longterm: { bar: 'bg-mor-slate',  chip: 'bg-mor-slate',  label: '長租契約' },
  earnest:  { bar: 'bg-[#C9A227]',  chip: 'bg-[#C9A227]',  label: '訂金／未確認' },
};
const TONES = Object.keys(TONE) as Stay['tone'][];

/**
 * 已退房（2026-10-03 David：「多一種顏色，已退房變灰色」）。
 * ★ 不是一種「客」，是一種**狀態** —— 所以不進 TONE、不當篩選藥丸，
 *   只蓋掉色條的顏色；點開卡片仍寫原本是短租／私下／長租。
 */
const DONE_BAR = 'bg-gray-400';

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
      /*
       * ★ 字級用 `text-uisub`（15px）不是 `text-xs` —— 藥丸是**介面外框**不是資料
       *   （anxing-ui 第四節:xs/sm 給表格內文,ui/uisub 給外框）。
       *   直接寫死 `text-[15px]` 的話，哪天整站調外框字級就會漏掉這一排。
       */
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-uisub
                  transition-colors whitespace-nowrap ${
        on ? (warn ? 'bg-amber-700 border-amber-700 text-white'
                   : 'bg-mor-ink border-mor-ink text-white')
           : (warn ? 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                   : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60')}`}>
      {swatch && <i className={`w-3 h-3 rounded-sm shrink-0 ${swatch} ${
        on ? 'ring-2 ring-white/85' : ''}`} />}
      {children}
    </button>
  );
}

type View = '' | 'any' | Stay['tone'] | 'free' | 'done' | 'dup' | 'ending' | 'leaving' | 'moved';

/** 藥丸上的字。`''` 是沒有選 */
const VIEW_LABEL: Record<string, string> = {
  any: '所有客戶', free: '空房', dup: '重疊',
  short: '短租', private: '私下', longterm: '長租契約', earnest: '訂金／未確認',
  ending: '快退租', leaving: '快退房', done: '已退房', moved: '移房',
};

/**
 * 一間房符不符合某一顆藥丸。
 *
 * ★★★ `ending` ／ `leaving` **不在這裡**。那兩顆是從提醒清單反推的
 *   （「只看這 N 間」），而提醒清單本身又要靠這支來收窄 ——
 *   放進來就變成自己篩自己，React 會直接抓到相依迴圈。
 *   它們在 `visible` 那邊單獨處理。
 *
 * ★★ 這支是**唯一**一份藥丸規則。原本 `visible` 裡寫一份、
 *   提醒那邊再寫一份的話，改了一邊另一邊會安靜地留在舊答案
 *   （README 坑 A）。
 */
function matchPill(x: { real: readonly Stay[]; dups: readonly unknown[] }, view: View): boolean {
  if (!view || view === 'ending' || view === 'leaving') return true;
  if (view === 'free') return x.real.length === 0;
  /* ★ 已退房（2026-10-04 David：「已退房獨立一個膠囊」）：這段期間裡有一筆已經退房的 */
  if (view === 'done') { const t = todayStr(); return x.real.some((s) => checkedOut(s, t)); }
  if (view === 'dup') return x.dups.length > 0;
  /* ★ 移房（2026-10-19 David 選 A 案）：這段期間裡有一筆移過房的 */
  if (view === 'moved') return x.real.some((s) => !!s.moveChain);
  if (view === 'any') return x.real.length > 0;
  return x.real.some((s) => s.tone === view);
}

/** 手機卡片抽屜佔螢幕高度的比例（2026-10-12 David 過審「約 2/5」）。改這裡要一起改 StayCard 的 h-[42vh] */
const SHEET_RATIO = 0.42;

/** ③ 點開的那張卡片。位置用 `fixed` —— 見下面 `openCard()` 的說明 */
type Picked = { stay: Stay; room: string; estate: string | null; x: number; y: number };

/** 跟篩選列的 Field 同一個樣子，只是標題後面掛紅星（Field 的標題只收字串） */
function ReqField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="flex items-center h-5 mb-1 text-uisub leading-5 text-gray-500 whitespace-nowrap">{label}<Req /></span>
      {children}
    </div>
  );
}

export default function RoomStatusPage() {
  const supabase = useMemo(() => createClient(), []);

  /*
   * ① 期間。`month` 與 `custom` 兩種模式，但**算出來都是一個 Range** ——
   *   底下一律只認 `range`，沒有第二條路徑。
   */
  /* 'find' ＝ 找房（2026-10-19 David 過審 A 案）：期間的第三格，填住宿起／退房日找空房 */
  const [mode, setMode] = useState<'month' | 'custom' | 'find'>('month');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  /** 按了「找空房」的那一組（改日期不會馬上重找，按了才算） */
  const [findQ, setFindQ] = useState<{ from: string; to: string } | null>(null);
  const [planIdx, setPlanIdx] = useState(0);
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
  /*
   * ★★ 退租與退房**各自一個天數**（2026-10-04 David：「預設退租未來 45 天、退房未來 7 天」）。
   *   以前共用一個（2026-09-16「共同一組就好」）—— 兩件事要看的長度本來就不同：
   *   退租要提早一個多月找新房客，退房只要看這週排哪些清潔。
   *   記在網址上（`?ewin=45&owin=7`）—— 重新整理、或把連結丟給會計，看到的是同一份。
   */
  const [endWin, setEndWin] = useState<AlertWindow>(() =>
    typeof window === 'undefined' ? DEFAULT_END_WINDOW
      : parseWinOr(new URLSearchParams(window.location.search).get('ewin'), DEFAULT_END_WINDOW));
  const [outWin, setOutWin] = useState<AlertWindow>(() =>
    typeof window === 'undefined' ? DEFAULT_OUT_WINDOW
      : parseWinOr(new URLSearchParams(window.location.search).get('owin'), DEFAULT_OUT_WINDOW));
  function pickWin(which: 'ewin' | 'owin', w: AlertWindow) {
    (which === 'ewin' ? setEndWin : setOutWin)(w);
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set(which, String(w));
    u.searchParams.delete('win');
    window.history.replaceState(null, '', u.toString());
  }
  /** 點同一顆就清除 —— 使用者:「再點一下 就清除」 */
  const pick = (v: View) => setView((cur) => (cur === v ? '' : v));

  const [estates, setEstates] = useState<Est[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  /** 住房率用的房源樹（含父子、間數、算不算住房率） */
  const [occNodes, setOccNodes] = useState<RoomNode[]>([]);
  /** 還在用、但沒設物業的房源名稱 —— 畫不出來，所以列出來 */
  const [noEstate, setNoEstate] = useState<string[]>([]);
  const [stays, setStays] = useState<Stay[]>([]);
  const [loading, setLoading] = useState(true);
  /** 這一次讀取失敗的原因（畫面保留上一份，不清成空的） */
  const [loadErr, setLoadErr] = useState('');
  /*
   * ★★★ 讀取序號（2026-10-16 David：「換月份會 lag、放久了晚讀入的消失」）。
   *   連按換月時好幾份讀取同時在跑，**最慢回來的那一份會蓋掉最新的**；
   *   每一份帶自己的序號，回來時不是最新的就丟掉。
   */
  const loadSeq = useRef(0);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** 展開的房源（同一間有兩筆以上時，一筆一條；2026-10-06 David） */
  const [openRooms, setOpenRooms] = useState<Set<string>>(new Set());
  /** 卡片上能不能改備註（管家以上，跟訂單／契約編輯同一組） */
  const { role } = useProfile();
  const canNote = canEditOrders(role);
  /** 卡片上的金額只給主管、總經理、會計看（管家看排房不看錢） */
  const canMoney = isManagerOrBoss(role) || isFinance(role);
  /** 本頁移房（2026-10-12）：可以移到哪些房（在用、勾排房表、物業在用） */
  const [moveRooms, setMoveRooms] = useState<MoveRoom[]>([]);
  /** `物業/房號` → Airbnb 房源頁 */
  const [abByRoom, setAbByRoom] = useState<Record<string, string>>({});
  /** 訂單 id → 卡片上的來源編號與金額（不放進 Stay —— Stay 是日曆算法的型別，跟錢無關） */
  const [orderInfo, setOrderInfo] = useState<Record<string, { key: string | null; amount: number | null }>>({});
  /** 正在移房的訂單 id */
  const [moving, setMoving] = useState<string | null>(null);
  /** ＋ 加訂單（2026-10-13）：開著時帶入的物業／房源／日子 */
  const [adding, setAdding] = useState<{ estateId: string | null; propertyId?: string | null; day?: string | null; to?: string | null; plan?: FinderSeg[] | null } | null>(null);
  /** 剛建好的那一筆 —— 上方綠條附連結去補押金 */
  const [created, setCreated] = useState<Created | null>(null);
  const isMobile = useIsMobile();
  const gridRef = useRef<HTMLDivElement>(null);

  /*
   * ★★ 一進來就選好物業（使用者 2026-09-15：「預設物業選正隆」）。
   *   排序第一個 —— 不是把「正隆」寫死在這裡。多一個物業的那天，
   *   把它的 `sort` 調到前面就好，不用再改一次程式。
   */
  const defaulted = useRef(false);

  /*
   * ══════════ 篩選記憶（2026-10-12 David：「要有 local storage 不要把記憶洗掉」）══════════
   *
   * ★★ 「存」寫在「讀」**前面**：同一次掛載時兩支依序跑，存的那支先看到 ready=false 就跳過，
   *   讀完、state 換成記憶裡的值之後才開始存 —— 反過來的話，第一次會先把預設值蓋上去。
   * ★ 網址帶的 `?ewin=` `?owin=` 優先（丟給會計的連結要看到同一份）。
   * ★ 讀寫都包 try：無痕視窗、存滿、被擋都可能丟例外 —— 記不住不該讓整頁壞掉。
   */
  const prefsReady = useRef(false);
  useEffect(() => {
    if (!prefsReady.current) return;
    try {
      window.localStorage.setItem(ROOMS_PREFS_KEY, serializeRoomsPrefs({
        estF, mode: mode === 'find' ? 'month' : mode, ym, from, to, kw, view, showDup, showEnd, showOut, ewin: endWin, owin: outWin,
      }));
    } catch { /* 記不住就算了 */ }
  }, [estF, mode, ym, from, to, kw, view, showDup, showEnd, showOut, endWin, outWin]);
  useEffect(() => {
    let p: ReturnType<typeof parseRoomsPrefs> = null;
    try { p = parseRoomsPrefs(window.localStorage.getItem(ROOMS_PREFS_KEY), Object.keys(VIEW_LABEL)); } catch { p = null; }
    if (p) {
      if (p.estF !== undefined) { setEstF(p.estF); defaulted.current = true; }
      if (p.mode) setMode(p.mode);
      if (p.ym) setYm(p.ym);
      if (p.from) setFrom(p.from);
      if (p.to) setTo(p.to);
      if (p.kw !== undefined) { setKw(p.kw); setKwInput(p.kw); }
      if (p.view !== undefined) setView(p.view as View);
      if (p.showDup !== undefined) setShowDup(p.showDup);
      if (p.showEnd !== undefined) setShowEnd(p.showEnd);
      if (p.showOut !== undefined) setShowOut(p.showOut);
      const q = new URLSearchParams(window.location.search);
      if (p.ewin != null && !q.get('ewin')) setEndWin(parseWinOr(String(p.ewin), DEFAULT_END_WINDOW));
      if (p.owin != null && !q.get('owin')) setOutWin(parseWinOr(String(p.owin), DEFAULT_OUT_WINDOW));
    }
    prefsReady.current = true;
  }, []);
  const defEst = estates[0]?.name ?? '';

  const range: Range = useMemo(
    () => (mode === 'month' ? monthRange(ym)
      /* 找房：日曆就是那幾晚（退房那天不算）；還沒按「找空房」時先看這個月 */
      : mode === 'find' ? (findQ ? { from: findQ.from, to: addDays(findQ.to, -1) } : monthRange(ym))
      : { from, to }),
    [mode, ym, from, to, findQ]);
  const nDays = rangeDays(range);
  /*
   * ★★★ 表格畫的是「資料是哪一段」，不是「選單選了哪一段」（2026-10-16 David：「還是分批讀入」）。
   *   按 › 的當下日期列就換成下個月，但色條還是上個月讀來的那一份 ——
   *   於是先冒出跨月的長住（上個月的資料剛好蓋到下個月的那幾條），三百毫秒後其他的才補上。
   *   看起來就是「分批讀入」。現在表格等新資料回來，日期與色條一起換。
   */
  const [dataRange, setDataRange] = useState<Range | null>(null);
  const shown: Range = dataRange ?? range;
  const shownDays = rangeDays(shown);
  const days = useMemo(() => (shownDays > MAX_RANGE_DAYS ? [] : eachDay(shown)), [shown.from, shown.to, shownDays]);
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
    const seq = ++loadSeq.current;
    if (!canDraw) { setLoading(false); return; }
    setLoading(true);
    const f = range.from;
    const t = range.to;

    /*
     * ★★ 五支查詢**一起發、一起回來才畫**（2026-10-16）。
     *   改版前是：房源先回來先畫 → 再等訂單（分頁、一頁一頁等）→ 再等契約。
     *   中間那段畫面是「新月份的日期＋舊月份的色條」，長租（契約）的色條最後才補上 ——
     *   就是「一部分晚一點讀入」。
     */
    const [r1, r2, r3, ro, rc] = await Promise.all([
      supabase.from('estates').select('id, name, sort, active').order('sort'),
      /*
       * ★ 停用的房源不畫（使用者 2026-09-15：「物業只有正隆」）。
       * ★★ 取消勾「排房表」的也不畫（migration_255）——
       *   2B10 那種沒在出租、但支出記在它頭上的房源，
       *   停用會讓它從房務、清潔、採購一起消失，而支出還要繼續記。
       *   所以是兩個開關，不是一個。
       */
      /* ★ 2026-10-04：住房率要整個物業的房（含沒勾排房表、但要算住房率的），所以撈全部在用的，畫的時候再篩 */
      supabase.from('properties')
        .select('id, name, estate_id, show_in_room_calendar, parent_property_id, units, count_in_occupancy, airbnb_listing_id')
        .eq('active', true).order('name'),
      /* Airbnb 連結用（一間房掛多個 listing 時多的在這裡）。讀不到就是沒有連結，不擋整頁 */
      supabase.from('property_listings').select('listing_id, property_id, is_current'),
      /*
       * ★★ 撈的是「跟這段有交集」的，不是「起日在這段裡」的 ——
       *   後者會漏掉跨進來的長住（8/20 住到 9/10 那種），
       *   而畫面上那間房會顯示成空的。
       *
       * ★ 訂單的 checkout 是**退房日**，所以條件要 `> from` 不是 `>= from`：
       *   9/1 退房的單最後一晚是 8/31，跟九月沒有交集。
       *
       * ★ 分頁一定要 `.order('id')` —— 沒有排序的話每一頁的順序不保證一樣，跨頁會重複或漏掉。
       */
      fetchAll<any>((a, b) => supabase.from('orders')
        .select('id, property_raw, guest_name, checkin, checkout, source, imported_via, contract_id, note, order_key, amount, move_chain')
        .not('source', 'in', '(oneoff,airbnb_cancelled)')
        .is('cancelled_on', null)   // 已取消的私下訂單不畫（migration_319）—— 那幾晚空出來了
        .lte('checkin', t).gt('checkout', f).order('id').range(a, b)),
      fetchAll<any>((a, b) => supabase.from('contracts')
        .select('id, room, tenant_name, display_name, start_date, end_date, active, earnest_only, note')
        .lte('start_date', t).gte('end_date', f).order('id').range(a, b)),
    ]);

    /* 已經有更新的一份在跑 → 這份丟掉（不然慢回來的舊月份會蓋掉新月份） */
    if (seq !== loadSeq.current) return;

    /*
     * ★★★ 任何一支失敗就**整份不換**，留著上一份、講原因（2026-10-16）。
     *   改版前錯誤全被吞掉：`data` 變 null → 當成「沒有資料」→ 那一類色條整排消失，
     *   畫面看起來像房都空了。頁面放很久、登入過期之後最容易發生 —— 就是「放久了晚讀入的消失」。
     */
    const err = r1.error?.message ?? r2.error?.message ?? r3.error?.message ?? ro.error ?? rc.error;
    if (err) {
      setLoadErr(err);
      setLoading(false);
      return;
    }
    setLoadErr('');
    const es = r1.data, ps = r2.data, pl = r3.data, os = ro.rows, cs = rc.rows;
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

    const allProps = (ps ?? []) as any[];
    /*
     * 住房率的房源樹（跟儀表板同一套規則，lib/occupancy）：
     *   count_in_occupancy 關掉的不算、停用物業的不算、整棟／整層只當祖先不進分母、打通房算兩間。
     */
    const nameOf: Record<string, string> = {};
    allProps.forEach((p) => { nameOf[p.id] = p.name; });
    setOccNodes(allProps
      .filter((p) => p.count_in_occupancy !== false)
      .filter((p) => !p.estate_id || estById[p.estate_id]?.active)
      .map((p) => ({
        name: p.name as string,
        estate: p.estate_id ? (estById[p.estate_id]?.name ?? null) : null,
        parent: p.parent_property_id ? (nameOf[p.parent_property_id] ?? null) : null,
        units: p.units ?? 1,
      })));
    const ownEst = allProps.filter((p) => p.show_in_room_calendar !== false).map((p) => ({
      name: p.name as string, est: estById[p.estate_id] as Est | undefined,
    }));
    setRooms(ownEst
      .filter((r) => r.est?.active)
      .map((r) => ({ name: r.name, estate: r.est!.name, estateSort: r.est!.sort })));
    setNoEstate(ownEst.filter((r) => !r.est).map((r) => r.name));

    /* 本頁移房的候選房、Airbnb 連結（2026-10-12）—— 跟日曆畫的是同一批房 */
    const links = airbnbLinks(allProps, (pl ?? []) as any[]);
    const ab: Record<string, string> = {};
    const mr: MoveRoom[] = [];
    for (const p of allProps) {
      const est = p.estate_id ? estById[p.estate_id] : undefined;
      if (!est?.active || p.show_in_room_calendar === false) continue;
      if (links[p.id]) ab[`${est.name}/${p.name}`] = links[p.id];
      mr.push({ id: p.id, name: p.name, estate_id: p.estate_id, estate: est.name });
    }
    setAbByRoom(ab);
    setMoveRooms(mr);


    const info: Record<string, { key: string | null; amount: number | null }> = {};
    for (const o of (os ?? []) as any[]) info[o.id] = { key: o.order_key ?? null, amount: o.amount == null ? null : Number(o.amount) };
    setOrderInfo(info);

    const oStays: Stay[] = ((os ?? []) as any[])
      .filter((o) => o.property_raw)
      .map((o) => ({
        id: `o${o.id}`, srcId: o.id as string,
        room: o.property_raw as string, kind: 'order' as const,
        start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
        contractId: o.contract_id as string | null,
        note: (o.note as string | null) ?? null,
        moveChain: ((o.move_chain as string | null) ?? '').trim() || null,
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
        note: (c.note as string | null) ?? null,
      }));

    /*
     * ★★★ 契約產生的月租單跟契約畫的是同一段期間 ——
     *   兩筆都留的話每一間長租房的每一天都會被算成「重疊」
     *   （2026-09-15 上線第一天的樣子）。規則與理由在 `dropContractOrders()`。
     */
    setStays(dropContractOrders([...oStays, ...cStays]));
    setDataRange({ from: f, to: t });   // 跟色條同一次換（見 `shown`）

    setLoading(false);
  }, [supabase, range.from, range.to, canDraw]);
  useEffect(() => { load(); }, [load]);

  /*
   * ══════════════════════════════════════════════════════════
   * 退租／退房提醒 —— **自己一條查詢**，不跟日曆那份綁在一起。
   *
   * ★★ 換天數只重抓提醒，日曆不用整張重畫;
   *   換月份只重抓日曆，提醒不用重抓。兩件事的觸發條件本來就不同。
   * ══════════════════════════════════════════════════════════
   */
  const loadAlerts = useCallback(async () => {
    /*
     * ══════════ 退租／退房提醒（2026-09-16）══════════
     *
     * ★★★ **另外一份查詢**,基準是今天不是 `range`。
     *   翻到十二月的時候,十月到期的契約不在日曆那一份裡 ——
     *   而提醒問的是「真實世界接下來會空出哪幾間」。
     *
     * ★★★ 訂單要排掉 `contract_id` 有值的那些。
     *   那是契約每個月長出來的**月租單**,它的 checkout 是下個月一號 ——
     *   拿去算「N 天內退房」的話,每一間長租房每個月都會叫一次,
     *   而那個人根本沒有要退房。這一條錯的話,提醒會變成每月固定的雜訊,
     *   然後就沒有人再看它。
     */
    const t0 = todayStr();
    /* ★ 「全部」＝ 往後不設上界,實際傳一個有限的大數（`winDays()` 的說明） */
    const nEnd = winDays(endWin), nOut = winDays(outWin);
    const [{ rows: ce }, { rows: oe }] = await Promise.all([
      /*
       * ★★★ 契約也要分頁。Supabase 預設最多回 1000 列而且不報錯 ——
       *   窗口按到「全部」時這一支等於「所有還沒到期的契約」,
       *   第 1001 筆之後會安靜消失,而畫面上只是「怎麼少了幾張」。
       */
      fetchAll<any>((a, b) => supabase.from('contracts')
        .select('id, room, tenant_name, display_name, start_date, end_date')
        .eq('active', true).gte('end_date', t0).lte('end_date', addDays(t0, nEnd)).range(a, b)),
      fetchAll<any>((a, b) => supabase.from('orders')
        .select('id, property_raw, guest_name, checkin, checkout, source, contract_id')
        .not('source', 'in', '(oneoff,airbnb_cancelled)')
        .is('cancelled_on', null)   // 已取消的不提醒退房（migration_319）
        .is('contract_id', null)
        .gte('checkout', t0).lte('checkout', addDays(t0, nOut)).range(a, b)),
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

    setEnding(exitsSoon(eStays, t0, 'contract', nEnd));
    setLeaving(exitsSoon(lStays, t0, 'order', nOut));
  }, [supabase, endWin, outWin]);
  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  /*
   * ★★ 分頁在背景放很久再切回來 → 自己重讀一次（2026-10-16）。
   *   背景分頁的計時器會被瀏覽器放慢，登入憑證可能已經過期又換新；
   *   畫面上那份是很久以前的，有人在這段時間排了房也看不到。
   */
  useEffect(() => {
    let hiddenAt = 0;
    const f = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000) { load(); loadAlerts(); }
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [load, loadAlerts]);


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
        cells: rowOf(x.stays, shown),
        real: staysInRange(x.stays, shown),
        dups: overlapRanges(x.stays, shown),
      }));
  }, [rooms, byRoom, estF, kw, shown.from, shown.to, canDraw]);

  const dupRooms = useMemo(() => base.filter((x) => x.dups.length), [base]);

  /*
   * ══════════════════════════════════════════════════════════
   * 提醒的範圍 —— **跟著畫面上的房源走**
   * （2026-09-16 使用者:「退租提醒和房源綁在一起，不是所有」）
   *
   * ★★★ 之前提醒只照物業收窄，不管藥丸。理由是「那個數字的意思是
   *   有幾件事要處理，不該跟著視角跳」。實際用起來不對:
   *   按下「空房 8」之後，底下那張表列著 **60 筆跟這 8 間無關的契約** ——
   *   兩塊東西疊在同一個畫面上卻各說各話，而人會以為它壞了。
   *
   * ★★ 所以現在是三層，由外往內:
   *     物業 ＋ 關鍵字　→ `base`（`matchRoom` 已經套過）
   *     藥丸　　　　　　→ `matchPill`
   *     提醒自己的窗口　→ `exitsSoon`（在 loadAlerts 裡）
   *
   * ★★★ 「快退租／快退房」那兩顆藥丸**不參與收窄**（`matchPill` 回 true）——
   *   它們是從提醒清單反推的，再拿去篩提醒就是自己篩自己。
   *
   * ★ 代價:數字會跟著藥丸跳。所以底下那張表要**講出來**
   *   「現在只看『空房』這 8 間」，不然 0 看起來像壞掉（見 `ExitList` 的 `narrow`）。
   * ══════════════════════════════════════════════════════════
   */
  const scope = useMemo(
    () => new Set(base.filter((x) => matchPill(x, view)).map((x) => x.room.name)),
    [base, view]);
  const endList  = useMemo(() => ending.filter((e) => scope.has(e.stay.room)), [ending, scope]);
  const outList  = useMemo(() => leaving.filter((e) => scope.has(e.stay.room)), [leaving, scope]);

  /** 藥丸正在收窄提醒的時候，底下那張表要說出來是哪一顆 */
  const narrow = (view && view !== 'ending' && view !== 'leaving')
    ? `${VIEW_LABEL[view] ?? view}」這 ${scope.size} 間` : '';

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
  /** 這段期間裡有已退房住宿的間數（跟空房一樣數「間」） */
  const nDone = useMemo(() => base.filter((x) => matchPill(x, 'done')).length, [base]);
  const nMoved = useMemo(() => base.filter((x) => matchPill(x, 'moved')).length, [base]);

  /*
   * ══════════ 住房率（2026-10-04 David）══════════
   * 「有住宿的晚數 ÷ 期間總晚數」，期間就是上面篩選列那一段 —— 換期間就重算。
   * ★ 訂金／未確認不算有人住（還沒確定會來）。
   * ★★ 每一列：自己的佔用 ＋ 祖先（整棟／整層）的佔用，逐日去重 —— 跟色條同一套 occupies()。
   * ★★ 物業：只算葉子、打通房算兩間、count_in_occupancy 關掉的不算 —— 跟儀表板同一份 lib，數字一樣。
   */
  const occStaysBy = useMemo(() => {
    const m: Record<string, Stay[]> = {};
    stays.filter((s) => s.tone !== 'earnest').forEach((s) => { (m[s.room] ??= []).push(s); });
    return m;
  }, [stays]);
  const occOfRow = useCallback((name: string) => {
    const st = ancestryOf(occNodes.length ? occNodes : [{ name, estate: null }], name)
      .flatMap((n) => occStaysBy[n] ?? []);
    return occupancyOf(st, shown);
  }, [occNodes, occStaysBy, shown.from, shown.to]);
  const estOcc = useMemo(() => {
    if (!canDraw || !estF) return null;
    const list = occupancyByRoom(occNodes.filter((n) => n.estate === estF), occStaysBy, shown);
    return totalOccupancy(list);
  }, [occNodes, occStaysBy, shown.from, shown.to, estF, canDraw]);

  /*
   * ══════════ 找房（2026-10-19）══════════
   * ★ 只在選定的那個物業裡找、只看資料真的是那一段的時候算（`shown` 跟 `range` 對上）——
   *   不然按下去的那三百毫秒會拿上一個月的佔用去算，閃一下錯的答案。
   */
  const finding = mode === 'find' && !!findQ;
  const fResult = useMemo(() => {
    if (!finding || !findQ) return null;
    if (!estF) return { kind: 'bad' as const, message: '先在「物業」選一個物業 —— 找房只在同一個物業裡找（不跨物業拼房）' };
    if (shown.from !== range.from || shown.to !== range.to) return null;
    const names = sortRooms(rooms.filter((r) => r.estate === estF)).map((r) => r.name);
    const set = new Set(names);
    return findRooms(names, stays.filter((x) => set.has(x.room)), findQ.from, findQ.to);
  }, [finding, findQ, estF, shown.from, shown.to, range.from, range.to, rooms, stays]);
  useEffect(() => { setPlanIdx(0); }, [fResult]);
  /** 要亮的格子：房 → 哪幾晚、綠（整段）或黃（拼） */
  const fHit = useMemo(() => {
    const m = new Map<string, { tone: 'full' | 'part'; days: Set<string> }>();
    if (!fResult || !findQ) return m;
    const nights = (a: string, b: string) => { const out = new Set<string>(); for (let d = a; d < b; d = addDays(d, 1)) out.add(d); return out; };
    if (fResult.kind === 'full') fResult.rooms.forEach((r) => m.set(r, { tone: 'full', days: nights(findQ.from, findQ.to) }));
    if (fResult.kind === 'mix') (fResult.plans[planIdx] ?? []).forEach((sg) => m.set(sg.room, { tone: 'part', days: nights(sg.from, sg.to) }));
    return m;
  }, [fResult, findQ, planIdx]);
  const fDim = fHit.size > 0;
  const fErr = finderError(fFrom, fTo);
  const fNights = nightsBetween(fFrom, fTo);
  const doFind = () => { if (!fErr) { setFindQ({ from: fFrom, to: fTo }); setPicked(null); } };
  /** 住宿起／退房日＋找空房。桌機在篩選列、手機在最上面那一塊 —— 同一份 */
  const findInputs = (mobile: boolean) => (
    <div className={mobile ? 'space-y-2' : 'flex flex-wrap items-end gap-3'}>
      <div className={mobile ? 'grid grid-cols-2 gap-2' : 'contents'}>
        <ReqField label="住宿起">
          <input type="date" value={fFrom} onChange={(e) => { setFFrom(e.target.value); if (!fTo || e.target.value >= fTo) setFTo(addDays(e.target.value, 1)); }}
            className={`${mobile ? 'h-11 w-full' : 'h-12 md:h-10'} rounded-lg border border-gray-300 px-2 text-ui bg-white`} />
        </ReqField>
        <ReqField label="退房日">
          <input type="date" value={fTo} min={fFrom || undefined} onChange={(e) => setFTo(e.target.value)}
            className={`${mobile ? 'h-11 w-full' : 'h-12 md:h-10'} rounded-lg border px-2 text-ui bg-white ${
              fFrom && fTo && fNights <= 0 ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
        </ReqField>
      </div>
      <div className={mobile ? 'flex items-center gap-3' : 'flex items-center gap-2'}>
        <span className="text-xs text-mor-slate tabular-nums whitespace-nowrap">{fNights > 0 ? `${fNights} 晚` : fFrom && fTo ? '退房日要晚於入住' : ''}</span>
        <button type="button" onClick={doFind} disabled={!!fErr} title={fErr ?? ''}
          className={`${mobile ? 'flex-1 h-12 text-base' : 'h-12 md:h-10 text-uisub'} rounded-lg bg-mor-slate px-4 font-medium text-white hover:bg-mor-slatedark disabled:opacity-40`}>
          找空房
        </button>
      </div>
    </div>
  );

  const visible0 = useMemo(() => base.filter((x) => {
    /*
     * ★★ 一律看 `real`（這段裡真的佔到日子的每一筆），不看 `cells` ——
     *   `rowOf()` 同一天只畫第一筆，被壓住的那一筆在 `cells` 裡根本不存在。
     *   拿 `cells` 篩的話，「只看短租」會漏掉被長租壓住的那張短租單，
     *   而那正是最需要被看見的一筆。（規則在 `matchPill()`。）
     *
     * ★★★ `free` 是 `real.length === 0`（整段都沒人），
     *   **不是** `hasFreeDay()`（有任何一天是空的）。
     *   後者是第一版的寫法，而它會把「9/4 才入住」的房算成空房 ——
     *   使用者:「空房還有人耶」。這兩個問法的差別就是那顆藥丸有沒有用。
     *
     * ★ 只有這兩顆在這裡單獨處理 —— 它們是從提醒清單反推的房號，
     *   不是房間自己的性質（理由見 `matchPill()`）。
     */
    if (view === 'ending') return endRooms.has(x.room.name);
    if (view === 'leaving') return outRooms.has(x.room.name);
    return matchPill(x, view);
  }), [base, view, endRooms, outRooms]);
  /* 找房有結果時：找到的房排到最上面（手機不用往下捲去找），順序照結果 */
  const visible = useMemo(() => {
    if (!fDim) return visible0;
    const order = fResult?.kind === 'full' ? fResult.rooms : fResult?.kind === 'mix' ? (fResult.plans[planIdx] ?? []).map((x) => x.room) : [];
    const rank = (n: string) => { const i = order.indexOf(n); return i < 0 ? 1e6 : i; };
    return [...visible0].sort((a, b) => rank(a.room.name) - rank(b.room.name));
  }, [visible0, fDim, fResult, planIdx]);

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
    setFindQ(null); setFFrom(''); setFTo('');
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
    /*
     * ★★ 手機：卡片是底部抽屜（約 2/5 螢幕）。點的那一列在抽屜會蓋到的位置時，
     *   先捲表格、不夠再捲整頁，讓那一列停在抽屜正上方（2026-10-12 過審）。
     */
    if (isMobile) {
      const delta = r.bottom - (window.innerHeight * (1 - SHEET_RATIO) - 12);
      if (delta > 0) requestAnimationFrame(() => {
        const c = gridRef.current;
        const d1 = c ? Math.max(0, Math.min(delta, c.scrollHeight - c.clientHeight - c.scrollTop)) : 0;
        if (c && d1) c.scrollBy({ top: d1, behavior: 'smooth' });
        if (delta - d1 > 0) window.scrollBy({ top: delta - d1, behavior: 'smooth' });
      });
    }
    const W = 296;
    const H = 300;
    setPicked({
      stay, room: room.name, estate: room.estate,
      x: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      y: r.bottom + H + 8 > window.innerHeight ? Math.max(8, r.top - H - 6) : r.bottom + 6,
    });
  };

  /*
   * 桌機鍵盤 ← → 換月（2026-10-12）。
   * ★ 正在打字（輸入框、下拉）、卡片或移房開著的時候不換 —— 那時候的 ← → 是給那個東西用的。
   */
  useEffect(() => {
    if (mode !== 'month') return;
    const f = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (picked || moving || adding) return;
      e.preventDefault();
      setYm((y) => shiftYm(y, e.key === 'ArrowLeft' ? -1 : 1));
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [mode, picked, moving, adding]);

  /** 一格（空格或色條）。主列與展開的子列共用 */
  const drawCell = (c: Cell, room: Room) => {
                  const cls = `relative border-b border-r border-mor-line min-w-[36px] md:min-w-[42px]
                    ${isWeekend(c.day) ? 'bg-mor-bg/50' : ''}`;
                  /* 空白格子：點了直接加訂單，帶入這間房與這一天（2026-10-13） */
                  if (c.type === 'free') {
                    /* 找房亮的格子：綠＝整段空、黃＝拼房的那一段 */
                    const fh = fHit.get(room.name);
                    const fcls = fh?.days.has(c.day)
                      ? (fh.tone === 'full' ? '!bg-green-200 shadow-[inset_0_2px_0_#16a34a,inset_0_-2px_0_#16a34a]'
                                            : '!bg-amber-200 shadow-[inset_0_2px_0_#d97706,inset_0_-2px_0_#d97706]') : '';
                    if (!canNote) return <td key={c.day} className={`${cls} ${fcls}`} />;
                    return (
                      <td key={c.day} className={`${cls} ${fcls} cursor-pointer hover:bg-mor-bluelight/60`}
                        title={`${room.name} ${c.day.slice(5).replace('-', '/')} 加訂單`}
                        onClick={(e) => {
                          e.stopPropagation(); setPicked(null);
                          const mr = moveRooms.find((r) => r.name === room.name && r.estate === room.estate);
                          setAdding({ estateId: mr?.estate_id ?? null, propertyId: mr?.id ?? null, day: c.day });
                        }} />
                    );
                  }
                  /*
                    ② 沒被選到的色條**淡掉，不是消失**。
                    ★★★ 那幾天還是有人。整條拿掉的話畫面會說那間房空著 ——
                      而有人會照著它排房。淡掉＝「不是你現在在找的，但它佔著」。
                  */
                  /* 找房有結果時，沒找到的房整排淡掉 */
                  const dimmed = (fDim && !fHit.has(room.name)) || (view === 'done' ? !checkedOut(c.stay, today)
                    : view === 'moved' ? !c.stay.moveChain
                    : view !== '' && view !== 'any' && view !== 'free'
                    && view !== 'dup' && view !== 'ending' && view !== 'leaving'
                    && c.stay.tone !== view);
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
                          ${hit ? '' : checkedOut(c.stay, today) ? DONE_BAR : TONE[c.stay.tone].bar}
                          ${dimmed ? 'opacity-20' : 'hover:brightness-110'}`}>
                        {/*
                          ★ 移房小標（2026-10-19 A 案）：色條照來源顏色，前面加紫色「↪ A13→B03」。
                            兩晚以下放不下，只留「↪」，點開卡片看完整。
                        */}
                        {c.stay.moveChain && (
                          <span title={`移房 ${c.stay.moveChain.split('>').join(' → ')}`}
                            className="shrink-0 mr-1 rounded bg-white px-1 text-[10px] font-semibold text-violet-700">
                            ↪{c.span > 2 ? ` ${c.stay.moveChain.split('>').join('→')}` : ''}
                          </span>
                        )}
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
  };

  return (
    <div onClick={() => picked && setPicked(null)}
      /* 手機抽屜開著時底下多留一段，最後幾列才捲得到抽屜上方 */
      className={picked && isMobile ? 'pb-[45vh]' : ''}>
      <div className="flex items-center justify-between mb-4">
        <h1>房源狀態
          <span className="text-sm font-normal text-gray-400 ml-2">
            Airbnb　私下　契約　狀態
          </span>
        </h1>
        {canNote && (
          <button type="button"
            onClick={() => setAdding({ estateId: estates.find((e) => e.name === estF)?.id ?? null })}
            className="h-10 rounded-lg bg-mor-slate px-4 text-ui font-medium text-white hover:bg-mor-slatedark">
            ＋ 加訂單
          </button>
        )}
      </div>

      {/* 剛建好的那一筆：附連結去補押金等（2026-10-13） */}
      {created && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-mor-greenlight px-4 py-2.5 text-sm text-mor-greendark">
          <span>✓ 已建立{created.kind === 'private' ? '私下訂單' : '契約'}・{created.room}</span>
          <a href={created.kind === 'private' ? `/shortterm?order=${created.id}` : `/contracts?contract=${created.id}`}
            target="_blank" rel="noreferrer" className="font-medium hover:underline">
            到{created.kind === 'private' ? '訂單頁' : '契約頁'}補押金 →
          </a>
          <button type="button" onClick={() => setCreated(null)} aria-label="關掉"
            className="ml-auto text-mor-greendark/70 hover:text-mor-greendark">✕</button>
        </div>
      )}

      {/*
        手機的換月放在最上面一整排（2026-10-12 過審）—— 篩選列在手機上是收起來的，
        換月是這一頁最常做的事，不該藏在「篩選」裡面。
      */}
      {/* 手機：月／自訂／找房三格撐滿整排（找房 2026-10-19）—— 篩選列在手機上是收起來的 */}
      <div className="md:hidden flex h-11 rounded-lg border border-gray-300 overflow-hidden mb-2">
        {([['month', '月'], ['custom', '自訂'], ['find', '🔍 找房']] as const).map(([v, t]) => (
          <button key={v} type="button" onClick={() => setMode(v)}
            className={`flex-1 text-ui border-r border-gray-300 last:border-r-0 ${
              mode === v ? 'bg-mor-slate text-white' : 'bg-white text-gray-600'}`}>{t}</button>
        ))}
      </div>
      {mode === 'find' && (
        <div className="md:hidden mb-3 rounded-xl border border-mor-line bg-white p-3">
          {findInputs(true)}
          <div className="mt-2 text-[11px] text-gray-400">物業：{estF || '（到「篩選」選一個）'}</div>
        </div>
      )}
      {mode === 'month' && (
        <div className="md:hidden flex items-center gap-2 mb-3">
          <div className="flex-1 flex items-center justify-between h-11 rounded-lg border border-gray-300 bg-white">
            <button type="button" onClick={() => setYm(shiftYm(ym, -1))} aria-label="上個月"
              className="w-12 h-full text-xl text-mor-slate">‹</button>
            <b className="tabular-nums text-ui">{ym}</b>
            <button type="button" onClick={() => setYm(shiftYm(ym, 1))} aria-label="下個月"
              className="w-12 h-full text-xl text-mor-slate">›</button>
          </div>
          <button type="button" onClick={() => setYm(thisYm())} disabled={ym === thisYm()}
            className="h-11 rounded-lg border border-gray-300 bg-white px-3 text-uisub text-mor-slate disabled:text-gray-300">本月</button>
        </div>
      )}

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
            {([['month', '月'], ['custom', '自訂'], ['find', '🔍 找房']] as const).map(([v, t]) => (
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
            {/* ‹ › 換月（2026-10-12 David：「有左右可以看上個月下個月」）。桌機鍵盤 ← → 也能翻 */}
            <div className="flex items-center gap-1.5">
              <div className="flex h-12 md:h-10 rounded-lg border border-gray-300 overflow-hidden bg-white">
                <button type="button" onClick={() => setYm(shiftYm(ym, -1))} aria-label="上個月" title="上個月（←）"
                  className="w-10 text-lg text-mor-slate hover:bg-mor-sand">‹</button>
                <input type="month" value={ym} onChange={(e) => setYm(e.target.value || thisYm())}
                  className="border-x border-gray-300 px-2 text-ui" />
                <button type="button" onClick={() => setYm(shiftYm(ym, 1))} aria-label="下個月" title="下個月（→）"
                  className="w-10 text-lg text-mor-slate hover:bg-mor-sand">›</button>
              </div>
              <button type="button" onClick={() => setYm(thisYm())} disabled={ym === thisYm()}
                className="h-12 md:h-10 rounded-lg border border-gray-300 bg-white px-3 text-uisub text-mor-slate
                           hover:bg-mor-sand disabled:text-gray-300 disabled:hover:bg-white">本月</button>
            </div>
          </Field>
        ) : mode === 'find' ? (
          /* 找房（A 案）：月份那格換成住宿起／退房日＋找空房 */
          findInputs(false)
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
        ══════════ 找房的結果（2026-10-19 A 案）══════════
        綠＝整段空房（點房號＝用這間加訂單）；黃＝只能拼（選一組、用這組建單）；紅＝沒有空房（講出是哪幾晚滿）。
      */}
      {mode === 'find' && (() => {
        const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
        const est = estates.find((e) => e.name === estF);
        const roomId = (n: string) => moveRooms.find((r) => r.name === n && r.estate === estF)?.id ?? null;
        /* ✕ 關掉（2026-10-19 David：「多一個可以關掉」）：收掉結果與亮格，日曆回到月；填的日期留著，改一下再找 */
        const x = (
          <button type="button" onClick={() => { setFindQ(null); setPlanIdx(0); }} aria-label="關掉找房結果" title="關掉"
            className="absolute top-2 right-2 w-8 h-8 rounded-full text-lg leading-none opacity-60 hover:opacity-100 hover:bg-black/5">✕</button>
        );
        if (!findQ) return (
          <div className="mb-3 rounded-xl border border-mor-line bg-white px-4 py-2.5 text-sm text-gray-500">
            填<b>住宿起</b>與<b>退房日</b>（退房那晚不算），按「找空房」—— 日曆會換成那幾晚，空的房亮起來。
          </div>);
        if (!fResult) return <div className="relative mb-3 rounded-xl bg-white px-4 py-2.5 pr-12 text-sm text-gray-400">{x}找房中⋯</div>;
        const span = `${md(findQ.from)}～${md(findQ.to)}`;
        if (fResult.kind === 'bad') return <div className="relative mb-3 rounded-xl bg-amber-50 px-4 py-2.5 pr-12 text-sm text-amber-800">{x}{fResult.message}</div>;
        if (fResult.kind === 'full') return (
          <div className="relative mb-3 rounded-xl bg-green-50 border border-green-200 px-4 py-3 pr-12 text-sm text-green-900">
            {x}✅ <b>整段空房 {fResult.rooms.length} 間</b>　{estF}・{span}（{fResult.nights} 晚）
            <div className="mt-2 flex flex-wrap gap-2">
              {fResult.rooms.map((n) => canNote ? (
                <button key={n} type="button"
                  onClick={() => setAdding({ estateId: est?.id ?? null, propertyId: roomId(n), day: findQ.from, to: findQ.to })}
                  className="h-10 max-md:flex-1 rounded-lg border border-green-300 bg-white px-3 font-semibold text-green-800 hover:bg-green-100">
                  {n}　＋ 用這間加訂單
                </button>
              ) : <span key={n} className="rounded-lg border border-green-300 bg-white px-3 py-1.5 font-semibold text-green-800">{n}</span>)}
            </div>
          </div>);
        if (fResult.kind === 'mix') return (
          <div className="relative mb-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 pr-12 text-sm text-amber-900">
            {x}⚠ {estF}・{span} 沒有整段空的房，可以<b>拼</b>（換房次數少的排前面）：
            <div className="mt-2 space-y-2">
              {fResult.plans.map((pl, i) => (
                <div key={i} onClick={() => setPlanIdx(i)}
                  className={`rounded-lg border border-dashed bg-white px-3 py-2 cursor-pointer flex flex-wrap items-center gap-x-3 gap-y-1 ${
                    i === planIdx ? 'border-amber-500 ring-1 ring-amber-400' : 'border-amber-300'}`}>
                  <b className="text-amber-800">方案 {i + 1}</b>
                  <span className="text-xs text-amber-700">換 {pl.length - 1} 次房</span>
                  <span className="tabular-nums">{pl.map((sg) => `${sg.room} ${md(sg.from)}～${md(sg.to)}（${sg.nights} 晚）`).join(' → ')}</span>
                  {canNote && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); setPlanIdx(i);
                        setAdding({ estateId: est?.id ?? null, day: findQ.from, to: findQ.to, plan: pl }); }}
                      className={`max-md:w-full md:ml-auto h-9 rounded-lg px-3 text-sm font-medium ${
                        i === planIdx ? 'bg-mor-slate text-white' : 'border border-mor-slate text-mor-slate bg-white'}`}>
                      用這組建單
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-amber-700/80">只在同一個物業裡拼。建一張訂單、自動拆成這幾段，訂單上會掛移房紀錄。</div>
          </div>);
        return (
          <div className="relative mb-3 rounded-xl bg-red-50 border border-red-200 px-4 py-3 pr-12 text-sm text-red-800">
            {x}✕ <b>這段沒有空房</b>　{estF}・{span}
            {fResult.fullNights.length > 0 && <>　{fResult.fullNights.map(md).join('、')} 這 {fResult.fullNights.length} 晚整個物業都滿，拼也拼不起來。</>}
            <div className="mt-1 text-xs text-red-700/80">試試別的物業，或把起迄挪開那幾晚。</div>
          </div>);
      })()}

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
          {/* ★ 2026-10-04 David：「已退房獨立一個膠囊」—— 跟空房同一排（都是「什麼狀態」） */}
          <Pill on={view === 'done'} onClick={() => pick('done')} swatch={DONE_BAR}>已退房 {nDone}</Pill>
          {/* ★ 移房（2026-10-19 A 案）：紫色＝移轉，跟押金移房同一個意思。點了只亮移過房的那幾條 */}
          <Pill on={view === 'moved'} onClick={() => pick('moved')} swatch="bg-violet-600">↪ 移房 {nMoved}</Pill>

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
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {/*
              ══════════ 提醒的天數（2026-09-16 使用者:「有點多耶，有沒有 drop down」）══════════

              ★★★ 第一版是**一排膠囊**（7／14／30／45／全部），跟上面那排房源藥丸
                長得一模一樣 —— 而它們是兩種東西:
                　藥丸　房源篩選，一天按十次　→ 一直切來切去的，攤開來才快
                　天數　設一次就不太動　　　　→ 收進下拉

                這一區看起來滿，不是因為東西多，是**同一種形狀用在兩種用途上**，
                眼睛每次都要重讀一遍才知道哪一排管哪件事。

              ★★ 換成下拉之後選項反而**加回 90／180**:
                膠囊多一個就多佔一塊版面，下拉多一個只是清單長一列。
                選項的數量本來就該由「畫面怎麼呈現」決定。

              ★ 兩顆旋鈕上的數字**留在外面**，不收進下拉 ——
                那兩個是**儀表**不是警報，而且退租與退房是兩件不同的工作
                （一個要找新房客、一個要排清潔），合成一個數字等於把資訊丟掉。
            */}
            {dupRooms.length > 0 && (
              <ToggleInfo tone="amber" on={showDup} onToggle={() => setShowDup((v) => !v)}
                label={<>⚠ 重疊 <b className="tabular-nums">{dupRooms.length}</b></>}
                infoLabel="什麼是重疊">
                同一間房在同一天有兩筆以上。日曆上<b>只畫得下其中一筆</b>，
                所以另一筆會安靜地不見 —— 這裡把它列出來。
              </ToggleInfo>
            )}
            {/*
              ★★★ 2026-09-16 改:退租／退房**永遠出現,就算是 0**。
                第一版跟「⚠ 重疊」一樣「沒東西就整顆不見」,結果使用者回報
                「退房按鈕還沒看到」—— 而它其實是對的（那七天真的沒有人要退房）。
                **人分不出「沒事」跟「沒做出來」**,而分不出的時候他會假設是後者。

              ★★ 跟「⚠ 重疊」的差別在於那兩種 0 的意思不一樣:
                　重疊 0　＝ 沒有壞掉的資料。那是**正常狀態**,不需要一顆常駐的警報。
                　退租 0　＝ 接下來這段時間沒有人要退租。那是一個**答案**,而且是會變的答案。
                前者是警報，後者是儀表 —— 警報平常要安靜，儀表平常就該看得到。
            */}
            {/*
              ★ 2026-10-04 David：「退房提醒、提醒期間 UI 合在一起，知道是同一件事」
                ＋「退租預設 45 天、退房預設 7 天」。一個框：每個提醒緊接著**自己的**天數。
              ★★ 框裡一律不換行（whitespace-nowrap ＋ flex-none）。放不下時整個框一起換到下一行 ——
                上一版框太窄，「提醒」「退租」被擠成直排。
            */}
            <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full
                             border border-mor-line bg-white pl-1 pr-2 py-0.5">
              <ToggleInfo tone="red" on={showEnd} onToggle={() => setShowEnd((v) => !v)}
                label={<>退租提醒 <b className="tabular-nums">{endList.length}</b></>}
                infoLabel="退租提醒怎麼算">
                <b>契約</b>在{endWin === 0 ? '之後全部' : `未來 ${winLabel(endWin)}`}內到期的（後面的下拉可以換）。
                算的是<b>今天</b>起算，不是你正在看的那個月 ——
                這個數字問的是「接下來會空出哪幾間」。
              </ToggleInfo>
              <select value={endWin} onChange={(e) => pickWin('ewin', Number(e.target.value) as AlertWindow)}
                aria-label="退租提醒看未來幾天"
                className="h-8 rounded-full border border-mor-line bg-white px-2 text-uisub text-gray-700 hover:bg-mor-sand/60">
                {ALERT_WINDOWS.map((w) => <option key={w} value={w}>{w === 0 ? '全部' : `未來 ${winLabel(w)}`}</option>)}
              </select>
              <i aria-hidden className="mx-1.5 h-5 w-px bg-mor-line" />
              <ToggleInfo tone="red" on={showOut} onToggle={() => setShowOut((v) => !v)}
                label={<>退房提醒 <b className="tabular-nums">{outList.length}</b></>}
                infoLabel="退房提醒怎麼算">
                <b>短租訂單</b>在{outWin === 0 ? '之後全部' : `未來 ${winLabel(outWin)}`}內退房的（後面的下拉可以換）。
                月租單不算 —— 那是契約每個月長出來的帳，不是真的有人要走。
              </ToggleInfo>
              <select value={outWin} onChange={(e) => pickWin('owin', Number(e.target.value) as AlertWindow)}
                aria-label="退房提醒看未來幾天"
                className="h-8 rounded-full border border-mor-line bg-white px-2 text-uisub text-gray-700 hover:bg-mor-sand/60">
                {OUT_WINDOWS.map((w) => <option key={w} value={w}>{`未來 ${winLabel(w)}`}</option>)}
              </select>
            </span>
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
        <ExitList kind="ending" list={endList} days={winDays(endWin)} all={endWin === 0}
          narrow={narrow} drawn={drawnIds}
          onFilter={() => setView('ending')}
          onRange={(n) => { setMode('custom'); setFrom(today); setTo(addDays(today, n)); }} />
      )}
      {showOut && (
        <ExitList kind="leaving" list={outList} days={winDays(outWin)} all={outWin === 0}
          narrow={narrow} drawn={drawnIds}
          onFilter={() => setView('leaving')}
          onRange={(n) => { setMode('custom'); setFrom(today); setTo(addDays(today, n)); }} />
      )}

      {/*
        ★ 2026-10-04 物業住房率：期間跟著上面的篩選列，算式寫出來 —— 看得出分母是幾間 × 幾晚。
      */}
      {estOcc && estOcc.rooms > 0 && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-mor-line bg-white px-4 py-2.5">
          <span className="text-uisub text-gray-500">{estF} 住房率</span>
          <span className={`text-2xl font-bold tabular-nums ${occTone(estOcc.rate) === 'low' ? 'text-red-600' : 'text-mor-ink'}`}>
            {fmtPct(estOcc.rate)}
          </span>
          <span className="text-xs text-gray-400 tabular-nums">
            {estOcc.used.toLocaleString()} 晚有人住 ÷（{estOcc.rooms} 間 × {shownDays} 晚）・{shown.from} ~ {shown.to}
          </span>
        </div>
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
      <>
      {/* 讀取失敗：畫面留著上一份，這裡講原因（錯誤留在表格上方，不是 2.5 秒就消失的 flash） */}
      {loadErr && (
        <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <span className="flex-1">沒讀到最新的資料，下面是上一次的畫面：{loadErr}</span>
          <button onClick={() => { load(); loadAlerts(); }} className="shrink-0 rounded-md border border-red-300 px-2 py-0.5">重新讀取</button>
        </div>
      )}
      {/* ★ 讀取中淡掉：換月時舊的色條還在，不淡掉的話看起來像新月份的資料（2026-10-16） */}
      <div ref={gridRef} className={`rounded-xl border border-mor-line bg-white overflow-auto max-h-[70vh] transition-opacity ${loading ? 'opacity-50' : ''}`}>
        <table className="border-separate border-spacing-0 text-xs w-max min-w-full">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 bg-mor-sand border-b border-r border-mor-line
                             min-w-[104px] max-w-[104px] md:min-w-[150px] md:max-w-[150px] px-2.5 py-1.5 text-left font-semibold">房源</th>
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
                      min-w-[36px] md:min-w-[42px] py-1 text-center font-semibold
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
              {/* ★ 2026-10-04 住房率欄：釘在最右邊，捲日期時不動 */}
              <th className="sticky right-0 top-0 z-30 bg-mor-sand border-b border-l border-mor-line
                             min-w-[64px] px-2 py-1.5 text-right font-semibold whitespace-nowrap">住房率</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ room, cells, dups, real }) => {
              const rk = `${room.estate}/${room.name}`;
              /*
               * ★ 只有**真的重疊**才給展開（2026-10-06 David：「看不出來重疊衝到的是哪裡」）。
               *   同一間兩筆但日期沒交集（Mego 9/4–10/5、Daniel 10/18–）本來就畫得出來，不用展開。
               */
              const multi = dups.length > 0;
              const dupDays = dups.reduce((n, d) => n + daysBetween(d.from, d.to) + 1, 0);
              const dupIds = new Set(dups.flatMap((d) => d.stays.map((x) => x.id)));
              const isOpen = multi && openRooms.has(rk);
              /* 卡片開著的那一列加黃底 —— 手機抽屜蓋住半個畫面時，還看得出點的是哪一間 */
              const isPicked = !!picked && picked.room === room.name && picked.estate === room.estate;
              return (
              <Fragment key={rk}>
              <tr
                className={`h-8 ${isPicked ? 'bg-amber-50' : dups.length ? 'bg-[#FFFDF6]' : ''}`}>
                <td className={`sticky left-0 z-10 border-b border-r border-mor-line
                               min-w-[104px] max-w-[104px] md:min-w-[150px] md:max-w-[150px] px-2.5 font-medium text-sm whitespace-nowrap
                               overflow-hidden text-ellipsis ${isPicked ? 'bg-amber-100' : dups.length ? 'bg-[#FFFDF6]' : 'bg-white'}`}>
                  {multi ? (
                    <button type="button" className="inline-flex items-center gap-1"
                      onClick={() => setOpenRooms((m) => { const n = new Set(m); n.has(rk) ? n.delete(rk) : n.add(rk); return n; })}>
                      {room.name}
                      <span className="rounded-full bg-red-50 px-1.5 text-[10px] font-medium text-red-600">⚠ 重疊 {dupDays} 天</span>
                      {/* 箭頭放後面（2026-10-06 David：「toggle 移到後方」）—— 房號維持跟其他列同一條左邊線 */}
                      <span className="text-gray-400 text-[10px]">{isOpen ? '▾' : '▸'}</span>
                    </button>
                  ) : room.name}
                  {/* Airbnb（2026-10-12）：有對應 listing 才出現，沒有就整顆不畫 */}
                  {abByRoom[rk] && (
                    <a href={abByRoom[rk]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                      title="在 Airbnb 打開" aria-label={`${room.name} 的 Airbnb 頁`}
                      className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded bg-[#E0484E] align-middle
                                 text-[9px] font-bold text-white hover:brightness-90">A</a>
                  )}
                  {/* ★ 物業維持小字 —— 它是附註,跟房號一起放大的話兩個一樣重,反而更難掃 */}
                  <span className="hidden md:inline text-gray-400 font-normal text-[11px] ml-1.5">{room.estate}</span>
                </td>
                {cells.map((c: Cell) => drawCell(c, room))}
                {(() => {
                  const o = occOfRow(room.name);
                  return (
                    <td title={`${o.used} 晚有人住 ÷ ${o.days} 晚`}
                      className={`sticky right-0 z-10 border-b border-l border-mor-line px-2 text-right text-sm
                                  tabular-nums whitespace-nowrap ${dups.length ? 'bg-[#FFFDF6]' : 'bg-white'} ${
                        occTone(o.rate) === 'low' ? 'text-red-600' : 'text-mor-ink'}`}>
                      {fmtPct(o.rate, 0)}
                    </td>
                  );
                })()}
              </tr>
              {/*
                展開：撞在一起的那幾筆各畫一條，最下面一條紅色標出「撞在哪幾天」。
                只列有參與重疊的訂單 —— 沒撞到的本來就畫在主列上。
              */}
              {isOpen && [...real].filter((x) => dupIds.has(x.id))
                .sort((x, y) => (x.start ?? '').localeCompare(y.start ?? '')).map((st) => (
                <tr key={`${rk}/${st.id}`} className="h-7 bg-mor-bg/30">
                  <td className="sticky left-0 z-10 border-b border-r border-mor-line bg-[#FAFAF8] min-w-[104px] max-w-[104px] md:min-w-[150px] md:max-w-[150px]
                                 pl-6 pr-2 text-[11px] text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis">
                    └ {st.guest || '（沒有名字）'}
                  </td>
                  {rowOf([st], shown).map((c: Cell) => drawCell(c, room))}
                  <td className="sticky right-0 z-10 border-b border-l border-mor-line bg-[#FAFAF8]" />
                </tr>
              ))}
              {isOpen && (
                <tr className="h-7">
                  <td className="sticky left-0 z-10 border-b border-r border-mor-line bg-red-50 min-w-[104px] max-w-[104px] md:min-w-[150px] md:max-w-[150px]
                                 pl-6 pr-2 text-[11px] font-medium text-red-600 whitespace-nowrap">└ 撞在這幾天</td>
                  {(() => {
                    // 重疊的日子畫成紅條（連續的併成一段），其餘空格
                    const hitDay = new Set(dups.flatMap((d) => eachDay({ from: d.from, to: d.to })));
                    const out: React.ReactNode[] = [];
                    for (let i = 0; i < days.length;) {
                      if (!hitDay.has(days[i])) { out.push(<td key={days[i]} className="border-b border-r border-mor-line min-w-[36px] md:min-w-[42px]" />); i++; continue; }
                      let n = 1; while (i + n < days.length && hitDay.has(days[i + n])) n++;
                      const a = days[i], b = days[i + n - 1];
                      out.push(
                        <td key={a} colSpan={n} className="relative border-b border-r border-mor-line">
                          <div className="absolute inset-y-1 inset-x-0.5 rounded-md bg-red-500 px-1.5 flex items-center text-[10px] font-semibold text-white whitespace-nowrap overflow-hidden">
                            {a.slice(5).replace('-', '/')}{n > 1 ? ` ～ ${b.slice(5).replace('-', '/')}` : ''}（{n} 晚）
                          </div>
                        </td>);
                      i += n;
                    }
                    return out;
                  })()}
                  <td className="sticky right-0 z-10 border-b border-l border-mor-line bg-red-50" />
                </tr>
              )}
              </Fragment>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={days.length + 2} className="px-4 py-8 text-center text-gray-400">
                沒有符合的房源
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      </>
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
      {picked && <StayCard p={picked} today={today} canNote={canNote} onClose={() => setPicked(null)}
        sheet={isMobile} abUrl={abByRoom[`${picked.estate}/${picked.room}`] ?? null}
        info={picked.stay.kind === 'order' && picked.stay.srcId ? orderInfo[picked.stay.srcId] ?? null : null}
        canMoney={canMoney}
        onMove={() => { const id = picked.stay.srcId; setPicked(null); if (id) setMoving(id); }}
        onNoteSaved={(id, note) => {
          /* 存好之後把畫面上那一筆換掉 —— 不重抓整個月，卡片也不用關 */
          setStays((ss) => ss.map((s) => (s.id === id ? { ...s, note } : s)));
          setPicked((pk) => (pk && pk.stay.id === id ? { ...pk, stay: { ...pk.stay, note } } : pk));
        }} />}

      {/* ＋ 加訂單（2026-10-13）：私下訂單或契約。建好之後日曆與提醒重抓 */}
      {adding && <AddBookingPanel sheet={isMobile} rooms={moveRooms} init={adding}
        onClose={() => setAdding(null)}
        onDone={(c) => {
          setAdding(null); setCreated(c);
          savedToast(`已建立${c.kind === 'private' ? '私下訂單' : '契約'} ${c.room}`);
          load(); loadAlerts();
        }} />}

      {/* 本頁移房（2026-10-12）：跟訂單頁同一套算法與 RPC，存好之後日曆與提醒都重抓 */}
      {moving && <MovePanel srcId={moving} sheet={isMobile} rooms={moveRooms}
        onClose={() => setMoving(null)}
        onDone={(msg) => { setMoving(null); savedToast(msg); load(); loadAlerts(); }} />}
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
function StayCard({ p, today, canNote, onClose, onNoteSaved, sheet, abUrl, info, canMoney, onMove }: {
  p: Picked; today: string; canNote: boolean; onClose: () => void;
  onNoteSaved: (stayId: string, note: string | null) => void;
  /** 手機：底部抽屜（2026-10-12 David：「貼著底部往上彈出，佔比較多的區域」） */
  sheet: boolean;
  abUrl: string | null;
  info: { key: string | null; amount: number | null } | null;
  canMoney: boolean;
  onMove: () => void;
}) {
  const s = p.stay;
  const supabase = useMemo(() => createClient(), []);
  /** null ＝ 沒在編輯；字串 ＝ 編輯中的內容 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteErr, setNoteErr] = useState('');
  const [saved, setSaved] = useState(false);
  const saveNote = async () => {
    if (draft === null || saving || !s.srcId) return;
    if (!noteChanged(s.note, draft)) { setDraft(null); return; }
    setSaving(true); setNoteErr(''); setSaved(false);
    const val = normNote(draft);
    const { data, error } = await supabase.from(noteTable(s.kind)).update({ note: val }).eq('id', s.srcId).select('id');
    setSaving(false);
    const bad = noteSaveError(error, data);
    if (bad) { setNoteErr(bad); return; }
    onNoteSaved(s.id, val);
    setDraft(null); setSaved(true);
  };
  const done = checkedOut(s, today);
  const last = lastNightOf(s);
  const nights = s.start && last ? daysBetween(s.start, last) + 1 : 0;
  const href = s.kind === 'contract' ? `/contracts?contract=${s.srcId}` : `/shortterm?order=${s.srcId}`;
  /* 找房移房：只有訂單（契約不在這裡移），管家以上 */
  const canMove = s.kind === 'order' && canNote && !!s.srcId;
  const y0 = useRef<number | null>(null);
  return (
    <>
      {/* 點外面關掉。★ 蓋滿整個視窗 —— 只靠色條自己的 blur 的話，捲動時會關不掉 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        style={sheet ? undefined : { left: p.x, top: p.y }}
        className={sheet
          ? 'fixed inset-x-0 bottom-0 z-50 h-[42vh] flex flex-col rounded-t-2xl border-t border-mor-line bg-white shadow-[0_-8px_28px_rgba(0,0,0,0.16)]'
          : 'fixed z-50 w-[296px] rounded-xl border border-mor-line bg-white p-3 shadow-xl'}>
        {/* 手機抽屜的把手：往下拉關掉 */}
        {sheet && (
          <div className="pt-2 pb-1 shrink-0 touch-none"
            onPointerDown={(e) => { y0.current = e.clientY; }}
            onPointerUp={(e) => { if (y0.current != null && e.clientY - y0.current > 60) onClose(); y0.current = null; }}>
            <i className="block mx-auto w-10 h-1.5 rounded-full bg-mor-line" />
          </div>
        )}
        <div className={sheet ? 'flex-1 overflow-y-auto px-4 pb-3' : ''}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className={`flex items-center gap-1.5 font-bold ${sheet ? 'text-base' : 'text-sm'}`}>
              <i className={`w-2.5 h-2.5 rounded-sm shrink-0 ${done ? DONE_BAR : TONE[s.tone].bar}`} />
              <span className="truncate">{s.guest || '（沒有名字）'}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {p.room}{p.estate ? `・${p.estate}` : ''}　{TONE[s.tone].label}{done ? '・已退房' : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="關閉"
            className={sheet ? 'w-8 h-8 rounded-full bg-mor-bg text-gray-500 text-base leading-none shrink-0'
                             : 'text-gray-400 hover:text-gray-600 text-base leading-none shrink-0'}>✕</button>
        </div>

        <dl className={`mt-2.5 grid grid-cols-[auto_1fr] gap-x-2.5 ${sheet ? 'gap-y-1.5 text-sm' : 'gap-y-1 text-xs'}`}>
          {/* 房源＋Airbnb（2026-10-12）*/}
          <dt className="text-gray-400">房源</dt>
          <dd>
            <b className="font-semibold">{p.room}</b>
            {abUrl && <a href={abUrl} target="_blank" rel="noreferrer"
              className="ml-2 text-mor-slate hover:text-mor-slatedark">Airbnb ↗</a>}
          </dd>
          {info?.key && (<>
            <dt className="text-gray-400">訂單編號</dt>
            <dd className="font-mono">{info.key}</dd>
          </>)}
          {canMoney && info?.amount != null && (<>
            <dt className="text-gray-400">金額</dt>
            <dd className="tabular-nums">NT$ {info.amount.toLocaleString()}</dd>
          </>)}
          <dt className="text-gray-400">期間</dt>
          <dd className="tabular-nums">{s.start ?? '—'} ~ {s.end ?? '—'}</dd>
          <dt className="text-gray-400">最後一晚</dt>
          <dd className="tabular-nums">
            {last ?? '—'}{nights > 0 && <span className="text-gray-400 ml-1">（住 {nights} 晚）</span>}
          </dd>
        </dl>

        {/*
          備註（2026-10-05 David 過審）：寫的是訂單／契約本身的 note，跟那一頁編輯的是同一欄。
          管家以上看得到「編輯」；其他人只讀。錯誤留在卡片裡。
        */}
        {(s.note || canNote) && (
          <div className="mt-2.5 pt-2 border-t border-dashed border-mor-line text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-400">備註</span>
              {canNote && draft === null && (
                <button onClick={() => { setDraft(s.note ?? ''); setNoteErr(''); setSaved(false); }}
                  className="text-mor-slate hover:text-mor-slatedark">{s.note ? '編輯' : '＋ 加備註'}</button>
              )}
            </div>
            {draft === null ? (
              s.note && <div className="mt-1 whitespace-pre-wrap break-words leading-relaxed max-h-[9rem] overflow-y-auto">{s.note}</div>
            ) : (
              <>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={4}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }}
                  className="mt-1.5 w-full rounded-lg border border-mor-line px-2 py-1.5 text-xs leading-relaxed focus:outline-none focus:border-mor-slate" />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-[11px] text-gray-400 mr-auto">存到這張{KIND[s.kind]}的備註</span>
                  <button onClick={() => { setDraft(null); setNoteErr(''); }} disabled={saving}
                    className="h-7 rounded-md border border-mor-line px-2.5">取消</button>
                  <button onClick={saveNote} disabled={saving}
                    className="h-7 rounded-md bg-mor-slate px-2.5 text-white hover:bg-mor-slatedark disabled:opacity-60">
                    {saving ? '儲存中⋯' : '儲存'}</button>
                </div>
              </>
            )}
            {noteErr && <div className="mt-1 text-red-600">{noteErr}</div>}
            {saved && !noteErr && draft === null && <div className="mt-1 text-mor-greendark">已儲存</div>}
          </div>
        )}

        {!sheet && (
        <div className="mt-2.5 pt-2 border-t border-mor-line flex items-center justify-between text-xs">
          <a href={href} target="_blank" rel="noreferrer" className="text-mor-slate hover:text-mor-slatedark">
            打開這張{KIND[s.kind]} →
          </a>
          {/* 找房移房（2026-10-12 改成本頁抽屜）—— 跟訂單頁同一套算法與 RPC。契約不在這裡移 */}
          {canMove && (
            <button type="button" onClick={onMove}
              className="font-medium text-mor-slate hover:text-mor-slatedark">移房</button>
          )}
        </div>
        )}
        </div>
        {/* 手機：兩顆大按鈕。「打開」實心排第一（抽屜按鈕的規矩），移房外框 */}
        {sheet && (
          <div className="shrink-0 flex gap-2 border-t border-mor-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <a href={href} target="_blank" rel="noreferrer"
              className="flex-1 h-12 rounded-xl bg-mor-slate text-white text-sm font-medium flex items-center justify-center">
              打開這張{KIND[s.kind]}</a>
            {canMove && (
              <button type="button" onClick={onMove}
                className="flex-1 h-12 rounded-xl border border-mor-line bg-white text-sm font-medium">移房</button>
            )}
          </div>
        )}
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
/**
 * 一次先給幾筆。
 *
 * ★ 六筆 —— 剛好是「一眼掃得完」而且不會把日曆推出畫面的長度。
 *   定在模組層是為了讓那顆按鈕上的「還有 N 筆」跟這裡永遠是同一個數字。
 */
const FOLD_AT = 6;

function ExitList({ kind, list, days, all, narrow, drawn, onFilter, onRange }: {
  kind: 'ending' | 'leaving';
  list: Exit[];
  days: number;
  /** 使用者按的是「全部」—— `days` 那時是一個很大的數字，不能印出來 */
  all: boolean;
  /**
   * 有藥丸正在收窄的話，這裡是那顆藥丸的名字與間數。
   *
   * ★★★ 沒有它的話，按下「空房」之後這張表會變成 0 筆，
   *   而畫面上**沒有任何東西說是誰做的** —— 使用者只會看到
   *   「剛剛還有 60 筆，現在一筆都沒有」，然後以為壞了。
   */
  narrow: string;
  drawn: Set<string>;
  onFilter: () => void;
  /** 把期間切成「今天 ～ 今天＋n 天」。n 由 ExitList 夾過上限之後傳回來 */
  onRange: (n: number) => void;
}) {
  const isEnd = kind === 'ending';
  /*
   * ★★★ 「看未來 N 天」要夾在 `MAX_RANGE_DAYS` 以內。
   *   契約的窗口是半年（180 天），而日曆一次最多畫 92 天 ——
   *   直接把 180 丟給期間的話，按下去只會換來一句
   *   「這段有 180 天，一次最多畫 92 天」，等於那顆按鈕是壞的。
   *
   * ★ 按鈕上的字寫**實際會切成幾天**，不是寫窗口的天數 ——
   *   寫 180 而切出 92 的話，那顆按鈕在說謊。
   */
  const jump = Math.min(days, MAX_RANGE_DAYS);
  /*
   * ══════════ 超過六筆就折起來（2026-09-16 使用者:「有點多耶」）══════════
   *
   * ★★ 使用者的截圖上 24 筆一次攤開，佔掉一整個螢幕 ——
   *   而真正要處理的是最上面那兩三筆（清單本來就由近到遠排）。
   *
   * ★★★ 折的是**顯示**不是**計算**:旋鈕上那個數字、
   *   標題上的「只看這 N 間」都還是完整的 N。
   *   折起來連數字也跟著少的話，那個數字就不再是「有幾件事要處理」。
   *
   * ★ 按鈕上寫**還有幾筆**。不寫的話展開之前不知道還有多少，等於要猜 ——
   *   而人不會為了一個未知的數量去點一顆按鈕。
   */
  /*
   * ★★★ 這裡**不能叫 `all`** —— 上面的 prop 已經有一個 `all`
   *   （使用者按的天數是不是「全部」）。同名會把它蓋掉，
   *   而症狀是標題上的「契約往後到期」跟著展開按鈕變 ——
   *   tsc 不會抓（兩個都是 boolean），畫面上也只是一句話怪怪的。
   */
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? list : list.slice(0, FOLD_AT);
  /* ★ 換了天數或藥丸就收回去 —— 上一次展開的狀態不該跟著新的清單走 */
  useEffect(() => { setExpanded(false); }, [days, list.length]);
  const title = isEnd ? '退租提醒' : '退房提醒';
  /*
   * ★ 按「全部」時 `days` 是 3650（十年）—— 直接印會變成
   *   「契約在 3650 天內到期」，那是一個沒有人看得懂的數字。
   */
  const span = all ? '往後' : `${days} 天內`;
  const sub = isEnd ? `契約${span}到期` : `短租訂單${span}退房`;
  const dateLabel = isEnd ? '退租日' : '退房日';
  const inView = list.filter((e) => drawn.has(e.stay.id));

  return (
    <div className="mb-2 rounded-xl border px-4 py-3 text-xs"
      style={{ borderColor: '#ECC8C5', background: '#FDF5F4', color: '#7A2F2A' }}>
      <div className="flex flex-wrap items-center gap-2 font-bold mb-2">
        {title}
        <span className="font-normal opacity-80">{sub}</span>
        {narrow && (
          <span className="font-normal opacity-80">・只算「{narrow}</span>
        )}
        {list.length > 0 && (
          <button onClick={onFilter} className="ml-auto font-normal underline hover:no-underline">
            只看這 {list.length} 間 →
          </button>
        )}
      </div>

      {/*
        ★★★ 沒有半筆的時候要**講出答案**，不是留一片空白。
          「接下來這段時間沒有契約到期」是一個有用的答案 ——
          而空白只會讓人以為這個功能沒做出來（2026-09-16 使用者:
          「退房按鈕還沒看到」，那顆其實在，只是當時 0 筆所以整顆藏起來了）。
      */}
      {!list.length ? (
        <div className="leading-relaxed opacity-85">
          {all ? '往後' : `接下來 ${days} 天`}{isEnd ? '沒有契約到期' : '沒有訂單要退房'}。
          {narrow && <>　<b>目前只看「{narrow}</b> —— 上面那顆藥丸再點一下就看全部。</>}
        </div>
      ) : !inView.length ? (
        <div className="mb-2 leading-relaxed opacity-90">
          ⚠ 這 {list.length} 筆<b>都不在目前的期間裡</b> —— 日曆上不會有紅色。
          <button onClick={() => onRange(jump)}
            className="ml-2 rounded-md border px-2 py-0.5 text-[11px] bg-white hover:bg-red-50"
            style={{ borderColor: '#ECC8C5' }}>
            看未來 {jump} 天
          </button>
        </div>
      ) : null}

      <div className="space-y-0.5">
        {shown.map((e) => (
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

      {list.length > FOLD_AT && (
        <button onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 w-full rounded-lg border border-dashed px-2 py-1 text-[11px]
                     bg-white/70 hover:bg-white"
          style={{ borderColor: '#ECC8C5' }}>
          {expanded ? '收起來 ▴' : `還有 ${list.length - FOLD_AT} 筆，全部展開 ▾`}
        </button>
      )}

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
