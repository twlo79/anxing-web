/**
 * 房源狀態日曆（2026-09-15 使用者指定）。
 *
 * 一條一個房源、橫軸是日期，訂單與契約畫在同一條線上，空白就是空房。
 *
 * ============================================================
 * 【★★★ 兩種來源的「迄」邊界不一樣】
 *
 * 使用者 2026-09-15 講得很清楚：
 *
 *     短租／Airbnb　迄 = 最後一晚 + 1 天   ← `checkout` 是**退房日**
 *     契約　　　　　迄 = 最後一晚          ← `end_date` 就是最後一晚
 *
 *   9/14 入住、9/18 退房的短租佔 **14、15、16、17 四晚**，
 *   18 號那格是空的 —— 當天可以接新客。
 *
 *   租期迄 9/30 的契約佔**到 30 號那一格**。
 *
 * ★★ 這是整支最容易錯一格的地方，而錯一格的後果是
 *   「畫面說有人、實際上空著」或反過來 —— 兩種都會讓人排錯房。
 *   所以 `lastNightOf()` 是唯一的換算點，畫圖的地方不准自己 ±1。
 *
 * ============================================================
 * 【為什麼邏輯放在這裡而不是頁面裡】
 *
 * 測試環境不處理 JSX（anxing-ui 第一節）。寫在 `.tsx` 裡的判斷式
 * **測不到** —— 而「哪一格有人」正是最需要被釘住的東西。
 */

export type Ymd = string;   // '2026-09-14'

/** 一筆佔用。`kind` 決定 `end` 怎麼解讀 —— 見 `lastNightOf()` */
export type Stay = {
  id: string;
  room: string;
  /** `order` = 訂單（退房日）／`contract` = 契約（最後一晚） */
  kind: 'order' | 'contract';
  start: Ymd | null;
  end: Ymd | null;
  guest?: string | null;
  /** 畫成什麼顏色。short=短租、private=私下、longterm=長租、earnest=訂金 */
  tone: 'short' | 'private' | 'longterm' | 'earnest';
  /**
   * 契約的話是它自己的 id，月租單的話是它從哪張契約長出來的（`orders.contract_id`）。
   * 只給 `dropContractOrders()` 用 —— 見那支的說明。
   */
  contractId?: string | null;
  /**
   * 這筆在資料庫裡的 id（不含 `id` 上面那個 `o`／`c` 前綴）。
   *
   * ★ 點開的卡片要連到那一頁的那一筆（`/contracts?contract=…`、`/shortterm?order=…`）。
   *   在畫面上 `id.slice(1)` 也做得到,但那是**靠前綴的長度活著**的寫法:
   *   哪天前綴變成兩個字,連結會安靜地指到一個不存在的 id。
   */
  srcId?: string;
  /**
   * 契約的類別（`contracts.type`:`longterm` ／ `company` ／ `office`）。
   * 只有 `kind === 'contract'` 才有值。
   *
   * ★ 未來提醒那一頁靠它把「退租」跟「契約結束」分開 ——
   *   公司登記沒有人要搬出去,混在退租清單裡會讓管家去排一間
   *   **根本沒有人住**的房的退房清潔。規則在 `lib/hk-alerts.ts`。
   */
  ctype?: string | null;
};

export type Room = {
  name: string;
  /** 沒設物業的話是 null —— 畫面另外處理，不要用 '未分類' 混進來當成一個物業 */
  estate: string | null;
  /** 物業在側邊的排序值（`estates.sort`）。小的排前面 */
  estateSort?: number | null;
};

/* ────────────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-09` + 14 → `2026-09-14` */
export const ymd = (ym: string, d: number): Ymd => `${ym}-${pad(d)}`;

/** 這個月有幾天。`2026-02` → 28 */
export function daysInMonth(ym: string): number {
  if (!/^\d{4}-\d{2}$/.test(ym ?? '')) return 0;
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  if (m < 1 || m > 12) return 0;
  return new Date(y, m, 0).getDate();
}

/* ────────────────────────────────────────────────────────── */

/**
 * 要畫的那一段日子。
 *
 * ★★★ 2026-09-16 之前整支吃的是 `ym`（一個月字串），所以這一頁
 *   **只能整月看** —— 而跨月的檔期（9/28 ~ 10/6）得切兩次月份，
 *   然後在腦袋裡把兩張圖接起來。使用者:「filter 選月份外可以選 自訂 起訖」。
 *
 * ★★ 改法是**把月併進區間**，不是在旁邊多開一條路:
 *   月檢視 = `monthRange(ym)`，也就是「1 號到月底」的一個普通區間。
 *   兩條路徑各算一次「哪一格有人」的話，改了一邊另一邊會安靜地留在舊答案 ——
 *   而症狀是「月檢視對、自訂檢視差一格」，那種差別沒有人會在畫面上看出來。
 */
export type Range = { from: Ymd; to: Ymd };

/**
 * 一次最多畫幾天。
 *
 * ★ 一格最少 42px（anxing-ui 的最小點擊區），92 天就是 3,900px 寬，
 *   已經要橫捲三個螢幕。一年是 15,000px —— 捲到第三個月的時候，
 *   左邊釘住的房號還在，但人已經不知道自己在看幾月了。
 *
 * ★★ 超過**要講出來**，不是默默截斷。截斷的話畫面會少掉幾天的資料
 *   而完全不說，那比擋下來糟得多。
 */
export const MAX_RANGE_DAYS = 92;

/** `2026-09` → `{ from: '2026-09-01', to: '2026-09-30' }` */
export function monthRange(ym: string): Range {
  const n = daysInMonth(ym);
  if (!n) return { from: '', to: '' };
  return { from: ymd(ym, 1), to: ymd(ym, n) };
}

/** 這段有幾天（含頭含尾）。起迄顛倒或空的回 0 */
export function rangeDays(r: Range): number {
  if (!r?.from || !r?.to) return 0;
  const n = daysBetween(r.from, r.to) + 1;
  return n > 0 ? n : 0;
}

/** 這段的每一天。★ 畫表頭與排格子都走這支 —— 兩邊各自數一次遲早會差一格 */
export function eachDay(r: Range): Ymd[] {
  const n = rangeDays(r);
  const out: Ymd[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(r.from, i));
  return out;
}

/* ────────────────────────────────────────────────────────── */

/** 星期幾。0 = 週日 */
export function weekdayOf(d: Ymd): number {
  return new Date(`${d}T00:00:00`).getDay();
}

export const isWeekend = (d: Ymd) => [0, 6].includes(weekdayOf(d));

/** 兩個日期差幾天。`b - a` */
export function daysBetween(a: Ymd, b: Ymd): number {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.round(ms / 86400000);
}

/** 日期加減天數 */
export function addDays(d: Ymd, n: number): Ymd {
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/**
 * 這筆佔用的**最後一晚**。
 *
 * ★★★ 整支唯一做 ±1 的地方（使用者 2026-09-15 定的規則）：
 *
 *     訂單　`checkout` 是退房日 → 最後一晚 = checkout − 1
 *     契約　`end_date` 就是最後一晚 → 原值
 *
 * ★ 畫圖的地方**不准自己 ±1** —— 兩個地方各算一次，
 *   哪天規則變了就會有一邊沒跟上，而症狀是「差一格」，
 *   最難看出來也最容易讓人排錯房。
 */
export function lastNightOf(s: Pick<Stay, 'kind' | 'end'>): Ymd | null {
  if (!s.end) return null;
  return s.kind === 'order' ? addDays(s.end, -1) : s.end;
}

/** 這一天這筆佔用在不在 */
export function occupies(s: Stay, day: Ymd): boolean {
  const last = lastNightOf(s);
  if (!s.start || !last) return false;
  // ★ 退房日就是入住日的當日單（加費、折讓）不佔任何一晚
  if (daysBetween(s.start, last) < 0) return false;
  return day >= s.start && day <= last;
}

/* ────────────────────────────────────────────────────────── */

/**
 * 契約產生的月租單，跟契約本身**畫的是同一段期間**。
 *
 * ★★★ 2026-09-15：房源狀態頁上線第一天，「同一天有兩筆」的警示把整頁塞滿 ——
 *   每一間長租房、每一天都被列進去。原因不是資料壞掉，是我撈了兩次同一件事:
 *
 *       契約　　LT_南京10-1　9/1 ~ 2027/6/30      ← 一整段
 *       月租單　LT_南京10-1_202609　9/1 ~ 10/1    ← `gen_contract_orders` 產的
 *
 *   兩筆疊在同一條線上，`overlaps()` 就每天都命中。
 *
 * ★ 留契約那一筆：它是一整段、一個房客，畫出來才是人看得懂的樣子。
 *   月租單是**帳**（每個月一張、要收款要開發票），不是**住**。
 *
 * ★★ 只丟掉「它的契約真的在這個月的清單裡」那些。
 *   契約被停用（`active = false`）或撈不到的時候，月租單是那間房唯一的資料 ——
 *   一律丟掉的話，一間有人住的房間會在畫面上變成空的，
 *   而空房正是這一頁最會被拿來做決定的格子。
 */
export function dropContractOrders(stays: readonly Stay[]): Stay[] {
  const drawn = new Set<string>();
  for (const s of stays) {
    if (s.kind === 'contract' && s.contractId) drawn.add(s.contractId);
  }
  return stays.filter((s) =>
    !(s.kind === 'order' && s.contractId && drawn.has(s.contractId)));
}

/* ────────────────────────────────────────────────────────── */

/**
 * 房源排序（使用者 2026-09-15：「房源名稱照順序排」）。
 *
 * ★★ 先照物業的 `sort`，同物業內照房號**自然排序**。
 *
 *   純字串排序會把 `A13` 排在 `A5` 前面（`1` < `5`），
 *   `2F-10` 排在 `2F-2` 前面 —— 那在畫面上看起來就是「亂的」。
 *   把數字段落當數字比才會是 A1 → A3 → A5 → A13。
 */
export function compareRoomName(a: string, b: string): number {
  const split = (s: string) => (s ?? '').match(/\d+|\D+/g) ?? [];
  const xa = split(a);
  const xb = split(b);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const pa = xa[i];
    const pb = xb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const na = /^\d+$/.test(pa);
    const nb = /^\d+$/.test(pb);
    if (na && nb) {
      const d = Number(pa) - Number(pb);
      if (d !== 0) return d;
    } else {
      const d = pa.localeCompare(pb, 'zh-Hant');
      if (d !== 0) return d;
    }
  }
  return 0;
}

export function sortRooms<T extends Room>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => {
    const sa = a.estateSort ?? 9999;
    const sb = b.estateSort ?? 9999;
    if (sa !== sb) return sa - sb;
    const e = (a.estate ?? '').localeCompare(b.estate ?? '', 'zh-Hant');
    if (e !== 0) return e;
    return compareRoomName(a.name, b.name);
  });
}

/* ────────────────────────────────────────────────────────── */

/**
 * 搜尋（使用者 2026-09-15：「可以打房源名稱 or 房客名稱」）。
 *
 * ★ 房客名字是**這個月有出現在這一條上的**那些 —— 不是全部歷史。
 *   打「Roni」要篩出他這個月住的那幾間，而不是他去年住過的。
 *
 * ★★ 空字串一律回 true —— 清空搜尋框就等於沒有篩選。
 */
export function matchRoom(
  room: Room, stays: readonly Stay[], kw: string,
): boolean {
  const q = (kw ?? '').trim().toLowerCase();
  if (!q) return true;
  if ((room.name ?? '').toLowerCase().includes(q)) return true;
  if ((room.estate ?? '').toLowerCase().includes(q)) return true;
  return stays.some((s) => (s.guest ?? '').toLowerCase().includes(q));
}

/* ────────────────────────────────────────────────────────── */

/** 一條房源在這個月的排版：一格一格，有人的那幾格合併成一條 */
export type Cell =
  | { type: 'free'; day: Ymd }
  | { type: 'stay'; day: Ymd; span: number; stay: Stay };

/**
 * 把一個房源這個月的佔用排成一列格子。
 *
 * ★★ **同一天有兩筆的話只畫第一筆**（依 start 排序後的第一個）。
 *   實務上那是資料有問題（重複訂單、移房沒收乾淨），
 *   而畫面上疊起來只會變成看不懂的一團 —— `overlaps()` 另外列出來給人看。
 */
export function rowOf(stays: readonly Stay[], r: Range): Cell[] {
  const days = eachDay(r);
  const n = days.length;
  const sorted = [...stays].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  const out: Cell[] = [];
  let d = 0;
  while (d < n) {
    const day = days[d];
    const hit = sorted.find((s) => occupies(s, day));
    if (!hit) { out.push({ type: 'free', day }); d++; continue; }
    // 這一條在**這段區間裡**佔到第幾天為止。超出區間的部分不畫,
    // 但 stay 本身帶著真實的起訖 —— 點開的卡片要說真話,不是說畫面上看到的那一段
    let span = 1;
    while (d + span < n && occupies(hit, days[d + span])) span++;
    out.push({ type: 'stay', day, span, stay: hit });
    d += span;
  }
  return out;
}

/**
 * 這段區間裡**真的佔到日子**的那幾筆。
 *
 * ★★ 撈資料的條件是「跟這段有交集」，那一層必然會多撈到邊界上的單:
 *   `checkout` 剛好等於 `from` 的訂單、當日進當日出的加費單（不佔任何一晚）。
 *   拿 `stays` 直接去算「這間房有沒有短租」的話，那幾筆會讓一間空房被算成有客。
 *
 * ★ 跟 `rowOf()` 不一樣:`rowOf` 同一天只畫第一筆（畫得下才畫），
 *   這支**每一筆都回**,包含被壓住看不見的那些 —— 篩選要看的是真相,不是畫面。
 */
export function staysInRange(stays: readonly Stay[], r: Range): Stay[] {
  const days = eachDay(r);
  return stays.filter((s) => days.some((d) => occupies(s, d)));
}

/** 這個月有沒有任何一天是空的 */
export function hasFreeDay(cells: readonly Cell[]): boolean {
  return cells.some((c) => c.type === 'free');
}

/** 這個月有沒有任何一天有人 */
export function hasStay(cells: readonly Cell[]): boolean {
  return cells.some((c) => c.type === 'stay');
}

/* ══════════════════════════════════════════════════════════
 * 退租／退房提醒（2026-09-16 使用者指定）
 *
 * 「契約退租提醒 45 天內」「訂單退房提醒 7 天內」。
 *
 * ★★★ 兩種單的 `end` 存的是**不同的東西**，而剛好都是這裡要的日子:
 *
 *     契約　`end_date` ＝ 最後一晚 ＝ **退租日**（不用 ±1）
 *     訂單　`checkout` ＝ **退房日**（最後一晚是它的前一天）
 *
 *   所以算提醒的時候兩邊都直接用 `s.end` —— 但**畫在日曆上不是**:
 *   色條走 `lastNightOf()`，訂單會畫到 checkout 的前一天為止。
 *
 * ★★ 於是同一筆訂單會出現兩個日期:色條結束在 9/25，提醒說 9/26 退房。
 *   **那個差一天是對的**，而看到的人會以為是 bug ——
 *   所以畫面上要把「還有 N 天退房」直接寫在色條上，不要讓人自己數。
 * ══════════════════════════════════════════════════════════ */

/**
 * 契約提前幾天提醒退租。
 *
 * ★★★ 2026-09-16 從 45 改成 **180**（半年）。
 *
 *   第一版訂 45 天，而使用者指著兩張說「這些要退租啦」:
 *     5B1 江芃萱　迄 2026-12-31　→ 106 天後
 *     8A2 周雅婷　迄 2026-11-25　→  70 天後
 *   兩張都在 45 天外，所以提醒是 0 —— 算式沒錯，**是數字訂錯了**。
 *
 * ★★ 45 天對包租代管來說太晚:找新的長租房客要幾週到幾個月，
 *   等到剩 45 天才開始找，那間房八成要空一段。
 *   退租提醒要回答的是「什麼時候該開始找人」，不是「什麼時候要去點交」。
 *
 * ★ 窗口拉大不會讓畫面變吵:日曆上**只有落在目前這段期間裡的**才變紅，
 *   所以九月的畫面不會因為十二月有人要退租而整片紅。
 *   明細照天數由近到遠排，每一筆寫著「還有 N 天」—— 遠近分得出來。
 */
export const ENDING_DAYS = 180;

/**
 * 短租訂單提前幾天提醒退房。
 *
 * ★ 2026-09-16 從 7 改成 **14**。短租的前置期本來就短（清潔、備品、接下一組），
 *   但只有一週的話，**週結帳或隔週排班的人來不及把它排進去**。
 */
export const LEAVING_DAYS = 14;

/** 一筆快要結束的佔用 */
export type Exit = {
  stay: Stay;
  /** 契約是退租日、訂單是退房日 —— 兩個都是 `stay.end` */
  on: Ymd;
  /** 還有幾天。0 ＝ 就是今天 */
  days: number;
};

/**
 * 接下來 `within` 天內要結束的那幾筆。
 *
 * ★★★ 算的基準是**今天**，不是畫面上在看的那一段期間。
 *   提醒問的是「真實世界接下來會空出哪幾間」—— 那是拿來排新客的，
 *   翻到十二月看版面的時候這個答案不該跟著變。
 *   所以呼叫端要另外撈一份資料給它，不要把日曆上那一份丟進來。
 *
 * ★★ 已經過去的不算（`days < 0`）—— 提醒是關於還沒發生的事。
 *   算進去的話，清單會越積越長，然後就沒有人再看它。
 *
 * ★ 快到的排前面。同一天的照房號自然排序 —— 不然每次重整順序都不一樣。
 */
export function exitsSoon(
  stays: readonly Stay[], today: Ymd, kind: Stay['kind'], within: number,
): Exit[] {
  const out: Exit[] = [];
  for (const s of stays) {
    if (s.kind !== kind || !s.end) continue;
    const days = daysBetween(today, s.end);
    if (days < 0 || days > within) continue;
    out.push({ stay: s, on: s.end, days });
  }
  return out.sort((a, b) =>
    a.days - b.days || compareRoomName(a.stay.room, b.stay.room));
}

/** 一段「同一間房同時有兩筆以上」的期間，連同**是哪幾筆** */
export type Overlap = { from: Ymd; to: Ymd; stays: Stay[] };

/**
 * 同一間房在同一天有兩筆以上 —— 資料有問題。
 *
 * ★ 不在日曆上疊著畫（會變成一團看不懂的東西），
 *   而是列出來讓人去修。畫面安靜地只顯示其中一筆比較糟:
 *   看起來正常，而另一筆錢無聲消失在畫面外。
 *
 * ★★★ 回傳**是哪幾筆**，不是只回傳哪幾天（2026-09-15）。
 *   原本只列「14B2 26、27、28、29、30、31 號」——
 *   使用者去契約清單查 14B2，只有一筆，然後就沒路可走了。
 *   一條說「這裡有問題」卻不說是什麼的警示，比沒有還糟:
 *   它花掉注意力、留下一個查不動的問題，久了就沒有人再看它。
 *
 * ★ 同一組重疊的連續幾天併成一段 —— 六天各列一次只是把同一件事講六遍。
 */
export function overlapRanges(stays: readonly Stay[], r: Range): Overlap[] {
  const out: Overlap[] = [];
  let cur: Overlap | null = null;
  let curKey = '';
  for (const day of eachDay(r)) {
    const hit = stays.filter((s) => occupies(s, day));
    if (hit.length < 2) { cur = null; curKey = ''; continue; }
    // 「同一組」是看**哪幾筆**，不是看有幾筆 —— 中途換了一筆就要斷開成兩段
    const key = hit.map((s) => s.id).slice().sort().join('|');
    if (cur && key === curKey) { cur.to = day; continue; }
    cur = { from: day, to: day, stays: hit };
    curKey = key;
    out.push(cur);
  }
  return out;
}

/**
 * 哪幾天有重疊。
 *
 * ★ 從 `overlapRanges()` 攤平出來，不是自己再數一遍 ——
 *   同一條規則寫兩次，改了一邊另一邊會安靜地留在舊答案。
 */
export function overlaps(stays: readonly Stay[], r: Range): Ymd[] {
  const out: Ymd[] = [];
  for (const g of overlapRanges(stays, r)) {
    for (let d = g.from; d <= g.to; d = addDays(d, 1)) out.push(d);
  }
  return out;
}
