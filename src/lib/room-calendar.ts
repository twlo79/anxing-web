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
export function rowOf(stays: readonly Stay[], ym: string): Cell[] {
  const n = daysInMonth(ym);
  const sorted = [...stays].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  const out: Cell[] = [];
  let d = 1;
  while (d <= n) {
    const day = ymd(ym, d);
    const hit = sorted.find((s) => occupies(s, day));
    if (!hit) { out.push({ type: 'free', day }); d++; continue; }
    // 這一條在這個月裡佔到第幾天為止
    let span = 1;
    while (d + span <= n && occupies(hit, ymd(ym, d + span))) span++;
    out.push({ type: 'stay', day, span, stay: hit });
    d += span;
  }
  return out;
}

/** 這個月有沒有任何一天是空的 */
export function hasFreeDay(cells: readonly Cell[]): boolean {
  return cells.some((c) => c.type === 'free');
}

/** 這個月有沒有任何一天有人 */
export function hasStay(cells: readonly Cell[]): boolean {
  return cells.some((c) => c.type === 'stay');
}

/**
 * 同一間房在同一天有兩筆以上 —— 資料有問題。
 *
 * ★ 不在日曆上疊著畫（會變成一團看不懂的東西），
 *   而是列出來讓人去修。畫面安靜地只顯示其中一筆比較糟:
 *   看起來正常，而另一筆錢無聲消失在畫面外。
 */
export function overlaps(stays: readonly Stay[], ym: string): Ymd[] {
  const n = daysInMonth(ym);
  const out: Ymd[] = [];
  for (let d = 1; d <= n; d++) {
    const day = ymd(ym, d);
    if (stays.filter((s) => occupies(s, day)).length > 1) out.push(day);
  }
  return out;
}
