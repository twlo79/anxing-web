/**
 * 住房率。（2026-09-16 使用者：「財務儀錶板多一個入住率，各房源期間都有入住率」）
 * ★ 2026-09-18 起全站改叫**住房率**（使用者指定）—— 上面那句是當時的原話。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 為什麼是「數日子」不是「加總天數」
 *
 * 直覺的寫法是把每一筆的天數加起來除以區間天數。那是錯的，
 * 而且**錯出來的數字看起來很正常**：
 *
 *     訂單 A　9/01 ~ 9/10
 *     訂單 B　9/08 ~ 9/15      ← 重疊三天（移房沒收乾淨、重複訂單）
 *
 *   加總：9 + 7 = 16 天 ÷ 30 = 53%
 *   實際：9/01 ~ 9/14 共 14 天 ÷ 30 = 47%
 *
 *   重疊越多分子越大，極端狀況會跑出 **120% 的住房率** ——
 *   而看報表的人只會覺得「這個月特別好」。
 *
 * ★★ 所以這支是**逐日問「這天有沒有人」**，一天就是一天。
 *   重疊算一次，上限天然就是 100%，而重疊本身由房源狀態那頁的
 *   「⚠ 重疊」去報，不是在這裡偷偷吸收掉。
 *
 * ★ 差一天的規則（訂單 checkout 是退房日、契約 end_date 是最後一晚）
 *   一律走 `occupies()` —— 這裡不准自己 ±1。兩個地方各算一次，
 *   哪天規則變了就會有一邊沒跟上，而症狀是「住房率差 3%」，
 *   沒有人查得出來是哪裡差的。
 * ══════════════════════════════════════════════════════════
 *
 * ★ 寫在 `.ts` 不是 `.tsx` —— 測試環境不處理 JSX。
 */

import {
  type Range, type Stay, type Ymd,
  eachDay, occupies, rangeDays, compareRoomName, monthRange, daysInMonth,
} from './room-calendar.ts';

/** 一間房在一段期間裡的入住狀況 */
export type RoomOcc = {
  room: string;
  /** 沒設物業的話是 null */
  estate: string | null;
  /**
   * 這一列代表幾間房（打通房「台1+2」是 2）。
   *
   * ★ 選填 —— 舊的呼叫端沒帶，當 1。`rate` **不受它影響**
   *   （兩間一起租，住房率一樣），它只放大合計的分子與分母。
   */
  units?: number;
  /** 可住天數 ＝ 這段期間有幾天 */
  days: number;
  /** 有人的天數 */
  used: number;
  /** 空著的天數 ＝ days − used */
  free: number;
  /** 住房率 0 ~ 1。`days` 是 0 的時候回 0，不是 NaN */
  rate: number;
};

/** 合計。`rooms` 是有幾間房參與計算 —— 沒有它就看不出分母是怎麼來的 */
export type OccTotal = { rooms: number; days: number; used: number; free: number; rate: number };

/* ────────────────────────────────────────────────────────── */

/**
 * 這段期間裡有幾天是有人的。
 *
 * ★★ 逐日問，所以同一天有三筆也只算一天（理由見檔頭）。
 * ★ 呼叫端通常有很多間房，`ds` 讓外面算一次就好 ——
 *   每間房各 `eachDay()` 一次的話，一年 × 一百間房是十萬次字串運算。
 */
export function usedDays(stays: readonly Stay[], r: Range, ds?: readonly Ymd[]): number {
  const days = ds ?? eachDay(r);
  if (!days.length || !stays.length) return 0;
  let n = 0;
  for (const d of days) {
    if (stays.some((s) => occupies(s, d))) n++;
  }
  return n;
}

/**
 * 一間房的住房率。
 *
 * ★ `rate` 不四捨五入 —— 要顯示成百分比是畫面的事（`fmtPct`）。
 *   在這裡先round的話，合計會變成「一堆四捨五入過的數字再平均」，
 *   跟真正的合計對不起來，而差的那 0.1% 沒有人解釋得了。
 */
export function occupancyOf(stays: readonly Stay[], r: Range, ds?: readonly Ymd[]): {
  days: number; used: number; free: number; rate: number;
} {
  const days = ds ? ds.length : rangeDays(r);
  const used = days ? usedDays(stays, r, ds) : 0;
  return { days, used, free: days - used, rate: days ? used / days : 0 };
}

/* ══════════════════════════════════════════════════════════
 * 子母房源（2026-09-21 使用者：「有的是子母房源關係
 *   jpr 整棟 = JPR1+JPR2；開封整棟 = 2樓(2-1+2-2) + 3樓 + 4樓」）
 *
 * ★★★ 為什麼非做不可：整棟跟底下那幾間是**同一個空間**。
 *   兩邊都留在分母裡的話：
 *     開封分母算 6 間，而訂了「整棟」那 93 天只記在整棟那一列上，
 *     底下五列全是 0 → 住房率 24.4%，實際七成。
 *   **低報三分之二，而畫面上完全正常 —— 沒有任何地方會叫。**
 *
 * ★★ 規則兩條：
 *   ① 分母只算**葉子**（沒有小孩的房源）。整棟、2F 這種父層不算間數。
 *   ② 父層的佔用**往下展開** —— 訂了整棟那幾天，底下每個葉子都算有人。
 *
 * ★ `units` 是另一件事：台1+2 是兩間打通一起租 —— 一列，但分母算 2 間。
 *   不拆成「台1」「台2」兩列，是因為那兩列永遠不會被單獨訂，
 *   卻會出現在排房表與每一個下拉選單裡。
 * ══════════════════════════════════════════════════════════ */

/**
 * 不佔房間的契約類別。
 *
 * ★★★ 公司登記／辦公室登記**只掛物業，沒有房號**（使用者 2026-09-21：
 *   「辦公室登記沒掛房源 只掛物業 不用算」）。近 12 個月有 34 張這種契約。
 *
 * ★★ 現在擋住它們的是「`room` 是空字串所以 falsy」—— 那是**偶然**。
 *   哪天有人給一張公司登記填了房號，那間房就會被算成整年有人，
 *   而住房率只是「變高了」，沒有任何地方會叫。要問的是「它是哪一類」，
 *   不是「它有沒有填房號」。
 */
export const NON_ROOM_CONTRACT: ReadonlySet<string> = new Set(['company', 'office']);

/** 這張契約佔不佔房間 —— 要有房號，而且不是公司／辦公室登記 */
export function contractOccupiesRoom(c: { room?: string | null; type?: string | null }): boolean {
  if (!String(c?.room ?? '').trim()) return false;
  return !NON_ROOM_CONTRACT.has(String(c?.type ?? '').trim());
}

/** 住房率要看的房源。`parent`／`units` 沒帶的話行為跟以前完全一樣 */
export type RoomNode = {
  name: string;
  /** 沒設物業的話是 null */
  estate: string | null;
  /** 父房源的 name（整棟／整層）。空的＝自己就是最上層 */
  parent?: string | null;
  /** 這一列代表幾間房。打通房是 2，預設 1 */
  units?: number;
};

/**
 * `units` 沒填、填 0、填負數、填字串都當 1。
 *
 * ★ 分母不能被一個沒填好的欄位吃掉 —— units 是 0 的話那間房會從分母
 *   整個消失，而住房率只是「變高了一點」，沒有人看得出少了一間。
 */
export function unitsOf(r: { units?: number | null }): number {
  const n = Math.floor(Number(r?.units ?? 1));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 葉子 ＝ 沒有任何人指它當父層。
 *
 * ★★ 用「有沒有小孩」判斷，**不是**用名字裡有沒有「整棟」——
 *   名字是給人看的，改個名字不該改變算法（而那種規則改了不會叫）。
 */
export function leafRooms<T extends RoomNode>(rooms: readonly T[]): T[] {
  const hasChild = new Set<string>();
  for (const r of rooms ?? []) {
    const p = String(r.parent ?? '').trim();
    if (p) hasChild.add(p);
  }
  return (rooms ?? []).filter((r) => !hasChild.has(r.name));
}

/**
 * 挑出這幾個房源**連同它們底下的所有子孫**。
 *
 * ★★★ 篩選「只看開封整棟」的時候要用這支。只留整棟自己的話，
 *   它在那份子集合裡變成沒有小孩 ＝ 葉子，分母就變成「1 間」——
 *   而整棟根本不是一間房，那個住房率會是四倍。
 *
 * ★ 同時也要留**祖先**：篩「只看開封3F」時，3F 的佔用有一部分
 *   記在「開封整棟」上，不把整棟帶進來的話那幾天會消失。
 *   祖先進來之後 3F 就不是葉子了嗎？不會 —— 葉子是「沒有小孩」，
 *   3F 沒有小孩。整棟有小孩（3F），所以整棟不進分母。兩件事剛好都對。
 */
export function subtreeOf<T extends RoomNode>(
  rooms: readonly T[], names: readonly string[],
): T[] {
  const want = new Set(names ?? []);
  if (!want.size) return [...(rooms ?? [])];
  /* 往下：一路把小孩加進來（層數有限，最多掃 rooms.length 輪） */
  for (let i = 0; i < (rooms ?? []).length; i++) {
    let grew = false;
    for (const r of rooms ?? []) {
      const par = String(r.parent ?? '').trim();
      if (par && want.has(par) && !want.has(r.name)) { want.add(r.name); grew = true; }
    }
    if (!grew) break;
  }
  /* 往上：把祖先也帶進來 —— 它們不進分母，但它們身上的佔用要收得到 */
  for (const n of [...want]) for (const a of ancestryOf(rooms ?? [], n)) want.add(a);
  return (rooms ?? []).filter((r) => want.has(r.name));
}

/** 這些房源一共幾間（葉子的 units 加總）—— 合計的分母就是它 */
export function totalUnits(rooms: readonly RoomNode[]): number {
  return leafRooms(rooms ?? []).reduce((n, r) => n + unitsOf(r), 0);
}

/**
 * 自己 ＋ 所有祖先的名字（由下往上）。佔用要從這些名字一起收。
 *
 * ★★★ 防成環。A 的父是 B、B 的父是 A 的話這支會無限迴圈，
 *   而症狀是整個儀錶板**白畫面**。資料庫那邊也擋（migration_287 的
 *   觸發器），但畫面這邊不能靠「資料一定是對的」活著。
 */
export function ancestryOf(rooms: readonly RoomNode[], name: string): string[] {
  const by = new Map<string, RoomNode>();
  /* ★ 同名的列有好幾筆時只認第一筆 —— 房源表裡真的有同名列（洪家 C房）。
       兩筆的 parent 不一樣的話這裡要有一個確定的答案，不能看順序。 */
  for (const r of rooms ?? []) if (!by.has(r.name)) by.set(r.name, r);
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = String(name ?? '');
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = String(by.get(cur)?.parent ?? '').trim();
  }
  return out;
}

/**
 * 每一間房各算一次。
 *
 * ★★★ `rooms` 傳進來的是**要納入計算的房源**，這支不負責篩「有沒有在租」。
 *   停用的、不算住房率的（`count_in_occupancy = false`）要在外面就排掉 ——
 *   2B10 那種只用來記支出、根本沒在租的房源留在分母裡，
 *   會把整體住房率一路往下拉，而畫面上完全看不出原因。
 *
 * ★★ 但**子母關係這支自己折**（只留葉子、父層的佔用往下展開）——
 *   那是結構不是政策，放到外面去做的話遲早有一個呼叫端會忘記，
 *   而忘記的症狀是一個看起來很正常、低了三分之二的數字。
 *
 * ★ 排序照房號的自然順序（10 排在 9 後面），不是按住房率。
 *   按率排的話每次區間一換順序就全部重來，找不到自己要看的那一間。
 */
export function occupancyByRoom(
  rooms: readonly RoomNode[],
  byRoom: Readonly<Record<string, readonly Stay[]>>,
  r: Range,
): RoomOcc[] {
  const ds = eachDay(r);
  return leafRooms(rooms ?? [])
    .sort((a, b) => compareRoomName(a.name, b.name))
    .map((rm) => {
      /* ★ 自己的佔用 ＋ 每一個祖先的佔用。`usedDays` 是逐日去重的，
           所以父子同一天都被訂（撞房）也只算一天，不會超過 100%。
           撞房本身由房源狀態頁去報，不在這裡偷偷吸收掉。 */
      const stays = ancestryOf(rooms ?? [], rm.name)
        .flatMap((n) => byRoom[n] ?? []);
      const o = occupancyOf(stays, r, ds);
      return { room: rm.name, estate: rm.estate, units: unitsOf(rm), ...o };
    });
}

/**
 * 合計。
 *
 * ★★★ 是「總住宿天數 ÷ 總可住天數」，**不是各房住房率的平均**。
 *   兩者在房間數一樣多、天數一樣長的時候剛好相等，所以很容易寫錯 ——
 *   而區間跨月、或某幾間房中途才開始出租的時候就會分岔。
 *   「所有房間合起來被住掉幾成」才是這個數字要回答的問題。
 */
export function totalOccupancy(list: readonly RoomOcc[]): OccTotal {
  let days = 0, used = 0, rooms = 0;
  for (const o of list) {
    /* ★★ `rooms` 是**幾間房**不是幾列 —— 台1+2 一列算兩間。
         沒帶 units 的舊呼叫端當 1，所以這個改動對它們沒有差別。 */
    const u = unitsOf(o);
    rooms += u;
    days += o.days * u;
    used += o.used * u;
  }
  return { rooms, days, used, free: days - used, rate: days ? used / days : 0 };
}

/** 依物業彙總。物業是 null 的收在 key `''` —— 畫面自己決定要不要顯示 */
export function occupancyByEstate(list: readonly RoomOcc[]): (OccTotal & { estate: string })[] {
  const m = new Map<string, RoomOcc[]>();
  for (const o of list) {
    const k = o.estate ?? '';
    const a = m.get(k);
    if (a) a.push(o); else m.set(k, [o]);
  }
  return [...m.entries()]
    .map(([estate, rows]) => ({ estate, ...totalOccupancy(rows) }))
    .sort((a, b) => a.estate.localeCompare(b.estate));
}

/* ══════════════════════════════════════════════════════════
 * 按月切（2026-09-18 使用者:「營收畫長條圖 住房率畫折線圖 可以合在一起」）
 * ══════════════════════════════════════════════════════════ */

/**
 * 把一個月**夾進**篩選區間。完全沒有交集回 `null`。
 *
 * ★★★ 一定要夾。不夾的話，篩選「9/01 ~ 9/18」時九月那一格會拿
 *   **整個九月 30 天**當分母，而分子只有 18 天有資料 ——
 *   住房率無聲地少掉四成，畫面上就是折線在最後一格跳水，
 *   而那看起來像「這個月生意突然變差」。
 *
 * ★★ 同理，第一個月也要夾（區間從月中開始的時候）。
 *
 * ★ 夾完之後那一格的分母跟整體那個數字是同一套算法 ——
 *   十二格的入住天數加起來會等於整體的入住天數（有測試釘住）。
 */
export function clipToRange(ym: string, r: Range): Range | null {
  const m = monthRange(ym);
  const from = m.from > r.from ? m.from : r.from;
  const to = m.to < r.to ? m.to : r.to;
  return from > to ? null : { from, to };
}

/**
 * 這個月**被夾過**嗎（＝不是完整的一個月）。
 *
 * ★★★ 為什麼要知道：區間的最後一個月幾乎一定是沒過完的。
 *   九月只到 9/18 的話，那根長條只有十八天的營收 ——
 *   畫出來就是一根明顯矮掉的柱子，看起來像**營收暴跌**，
 *   而它只是月還沒過完。這是這張圖最會騙人的地方。
 *
 * ★ 住房率沒有這個問題（分母也跟著夾），所以只有長條要標。
 */
export function isPartialMonth(ym: string, r: Range): boolean {
  const cl = clipToRange(ym, r);
  if (!cl) return false;                        // 根本不在範圍裡 —— 那是「沒有」不是「不完整」
  return rangeDays(cl) < daysInMonth(ym);
}

/** 一個月的合計。`m` 是 `2026-09` 這種。 */
export type MonthOcc = OccTotal & { m: string };

/**
 * 每個月各算一次。
 *
 * ★★★ 跟區間**沒有交集**的月份回 `days: 0`（不是 rate 0）——
 *   兩者在畫面上差很多：`days = 0` 是「這個月不在看的範圍裡」，
 *   要讓折線**斷開**；`rate = 0` 是「這個月一天都沒住」，
 *   那是一個真的、很糟的事實，要畫在底線上。
 *   混成同一個值的話，一條斷掉的線會被讀成「全空」。
 *
 * ★★ 月份清單由呼叫端給（通常跟營收那張圖同一組）——
 *   這支不自己生月份，不然兩張圖的 x 軸會各長一套而且一定會分岔。
 */
export function occupancyByMonth(
  rooms: readonly RoomNode[],
  byRoom: Readonly<Record<string, readonly Stay[]>>,
  months: readonly string[],
  r: Range,
): MonthOcc[] {
  return (months ?? []).map((m) => {
    const cl = clipToRange(m, r);
    /* ★ 沒交集的月份也要報**幾間房**（不是幾列）—— 跟有交集的月份
         用同一個數字，不然折線斷掉那幾格的房間數會跳。 */
    if (!cl) return { m, rooms: totalUnits(rooms ?? []), days: 0, used: 0, free: 0, rate: 0 };
    return { m, ...totalOccupancy(occupancyByRoom(rooms, byRoom, cl)) };
  });
}

/* ────────────────────────────────────────────────────────── */

/**
 * 0.8734 → `87.3%`。
 *
 * ★ 一位小數。整數的話 0% 跟 0.4% 長得一樣，
 *   而「有一間房被住了一天」跟「整個月全空」是兩件不同的事。
 */
export function fmtPct(rate: number, digits = 1): string {
  if (!Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

/**
 * 高／中／低。畫面拿去決定顏色。
 *
 * ★★ 門檻寫在這裡而不是畫面上 —— 三個地方（長條、合計、明細表）
 *   各寫一次 `> 0.8` 的話，改門檻時一定會漏掉一個，
 *   而那一格會用舊的顏色繼續說話。
 *
 * ★ 分界點用 `>=`：剛好 80% 算高。人講「八成滿」指的就是它。
 */
export const OCC_HIGH = 0.8;
export const OCC_LOW = 0.5;
export function occTone(rate: number): 'high' | 'mid' | 'low' {
  if (rate >= OCC_HIGH) return 'high';
  if (rate >= OCC_LOW) return 'mid';
  return 'low';
}
