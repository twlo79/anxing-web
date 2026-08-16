/**
 * 房務工作的顯示邏輯（純函式）。
 *
 * ============================================================
 * 【為什麼格子裡要看到「工作」而不是「幾間」】
 *
 * 上一版的格子寫的是「庭玉 1・Una 2」—— 那回答的是「誰在」，
 * 但看行事曆的人真正要問的是「**今天要做什麼**」。
 *
 * 「庭玉 1」看不出是哪一間、是退房還是入住、客人是誰。
 * 要知道就得點進去 —— 而一個月三十天，每天都要點進去看的行事曆
 * 等於沒有行事曆。
 *
 * 所以每一筆工作各佔一條，直接寫「退房 A15・Kevin」。
 */

export type HkTask = {
  /**
   * 有沒有被人確認過（migration_133）。
   *
   * 自動從訂單長出來的預設 false —— 那是**建議**，不是工作。
   * 打勾之後才上行事曆。人工加的直接 true。
   */
  accepted?: boolean;
  id: string;
  work_date: string;
  property_id: string | null;
  work_type: string;
  staff_id: string | null;
  /** 'checkout' / 'checkin' = 從訂單自動長出來的。null = 人工加的 */
  auto_kind: 'checkout' | 'checkin' | null;
  done_at: string | null;
  note: string | null;
  order_id: string | null;
  /*
   * 時間與標題（migration_134，照 TimeTree）。
   *
   * 全部選填 —— 既有的幾百筆都沒有這些欄位，
   * 設成必填的話那些會全部變成空白或跳型別錯誤。
   */
  /** 全天。**沒有值一律當成全天** —— 既有資料沒有時間 */
  all_day?: boolean | null;
  /** 當天的開始時間 "09:00:00"。work_date 已經是台北日期，這裡不帶時區 */
  start_time?: string | null;
  /** 結束。**小於 start_time 代表跨夜**，算時長要 +24 小時 */
  end_time?: string | null;
  /** 自訂標題。沒填就用 taskLabel 組 */
  title?: string | null;
};

/** 補上人看得懂的名字之後的樣子 */
export type TaskView = HkTask & {
  room: string | null;
  guest: string | null;
  staff: string | null;
};

/** 這一筆是不是系統自動長出來的 */
export const isAuto = (t: Pick<HkTask, 'auto_kind'>) => t.auto_kind != null;

/**
 * 格子裡那一條字。
 *
 * 【順序：工作類型 → 房源 → 客人】
 * 由粗到細。掃過一整排時，眼睛先抓到的是「退房」還是「入住」——
 * 那決定今天幾點要到、要帶什麼。房源決定去哪裡，客人只是辨識用。
 *
 * 【客人放最後而且可以被截掉】
 * 名字最長也最不重要。截掉「Ariel Wang」不影響任何決定，
 * 截掉「A15」就得點進去查。
 */
export function taskLabel(t: Pick<TaskView, 'work_type' | 'room' | 'guest'>): string {
  const parts = [t.work_type, t.room ?? '（無房源）'];
  const g = (t.guest ?? '').trim();
  return g ? `${parts.join(' ')}・${g}` : parts.join(' ');
}

/**
 * 排序：**未指派的排最前面**。
 *
 * 那是這個畫面唯一需要人動手的東西。排在後面的話，格子只顯示前幾條，
 * 未指派的就被擠到「+3」裡面 —— 而那正是最不該被藏起來的。
 *
 * 其餘依工作類型、房源，讓同一種工作聚在一起。
 */
export function sortTasks(list: TaskView[]): TaskView[] {
  return [...list].sort((a, b) =>
    Number(!!a.staff_id) - Number(!!b.staff_id)
    || (a.work_type ?? '').localeCompare(b.work_type ?? '')
    || (a.room ?? '').localeCompare(b.room ?? '', 'zh-Hant'));
}

/** 依日期分組 */
export function byDate(list: TaskView[]): Record<string, TaskView[]> {
  const out: Record<string, TaskView[]> = {};
  for (const t of list) (out[t.work_date] ??= []).push(t);
  for (const k of Object.keys(out)) out[k] = sortTasks(out[k]);
  return out;
}

export type DayCount = {
  total: number;
  unassigned: number;
  done: number;
  /** 還沒打勾接受的建議（migration_133）。要人動手的第一順位 */
  pending: number;
};

export function dayCounts(list: TaskView[]): DayCount {
  /*
   * 【未接受的不算進 total】（migration_133）
   *
   * 「今天有 6 件工作」跟「今天有 4 件工作 ＋ 2 個建議」是兩回事。
   * 混在一起的話,人會照著 6 去排人力,而其中兩件他還沒決定要不要做。
   */
  const real = list.filter((t) => t.accepted !== false);
  return {
    total: real.length,
    unassigned: real.filter((t) => !t.staff_id).length,
    done: real.filter((t) => t.done_at).length,
    pending: list.filter((t) => t.accepted === false).length,
  };
}

/** 還沒打勾的建議 */
export const isPending = (t: Pick<HkTask, 'accepted'>) => t.accepted === false;

/**
 * 布巾組數 ＝ Σ 每筆工作的房源床數。
 *
 * ============================================================
 * 【為什麼算不出來要回報，不是當成 0】
 *
 * 床數沒填的房源（`beds` 是 null）算不出組數。當成 0 的話，
 * 那間房就**靜靜地少帶一組床單** —— 房務到現場才發現，
 * 而總數看起來完全正常。
 *
 * 所以回傳分兩個數字：算得出來的總和，以及算不出來的有幾筆。
 * 畫面上那個「?」就是叫人去把床數填一填。
 *
 * @param bedsOf 房源 id → 床數。null / undefined = 還沒建檔
 * @param countLinen 房源 id → 算不算布巾。公區與整棟通常不算
 */
export function linenSets(
  list: TaskView[],
  bedsOf: (propertyId: string) => number | null | undefined,
  countLinen: (propertyId: string) => boolean = () => true,
): { sets: number; unknown: number } {
  let sets = 0, unknown = 0;
  for (const t of list) {
    if (!t.property_id) continue;          // 沒有房源的工作不帶布巾
    if (!countLinen(t.property_id)) continue;
    const b = bedsOf(t.property_id);
    if (b == null) { unknown++; continue; }
    sets += b;
  }
  return { sets, unknown };
}

/**
 * 一個人某一天的工作。給房務自己看的「今天我要做什麼」。
 */
export function tasksOf(list: TaskView[], staffId: string): TaskView[] {
  return sortTasks(list.filter((t) => t.staff_id === staffId));
}

/* ============================================================
 * 工作類型的顏色（2026-08-16 使用者指定：照 TimeTree）
 * ============================================================
 *
 * 【為什麼從「按人配色」改成「按工作類型」】
 *
 * 他們在 TimeTree 上就是這樣用的:藍＝退房、綠＝入住、紫＝清潔、黃＝休假。
 * 打開月曆掃一眼，看到的是「今天有幾件退房、幾件入住」——
 * 那是排班要回答的第一個問題。
 *
 * 按人配色回答的是「誰今天比較忙」，那要等你先記住六個人各是什麼顏色。
 * 而人會換、會離職，顏色跟著位移，記憶就作廢了。
 * 工作類型不會換。
 *
 *
 * 【那「誰做」怎麼看】
 *
 * 寫在 bar 上（「退房清潔 A15・庭玉」）。顏色讓你分類，文字讓你確認。
 *
 *
 * 【未指派不用灰色，用虛線】
 *
 * 原本灰色＝未指派，換成類型配色之後那個訊號就沒地方放了。
 * 改成**保留類型顏色但畫虛線邊框、文字淡一階** ——
 * 「這是什麼工作」跟「有沒有人接」是兩件事，各自用一個視覺通道，
 * 不用互相犧牲。
 *
 * 灰色會弄丟「這是退房還是入住」，而那正是要指派的人第一個要知道的。
 */

/**
 * 一個類型一組色。
 *
 * 【實心滿版 ＋ 白字，不是淺底深字】（照 TimeTree 網頁版）
 *
 * 淺底深字在一格塞五六條的時候，每條之間的界線會糊掉 ——
 * 五個淡藍色的方塊看起來像一整塊。實心色條有明確的邊界，
 * 而顏色本身就是分類，不需要再靠邊框去分。
 *
 * 黃色配白字讀不到，所以休假那一條用深字 —— 唯一的例外。
 */
export type TypeTone = {
  /** 實心背景色（inline style，不是 Tailwind class —— 這些不是調色盤裡的色） */
  bg: string;
  /** 條上的文字色 */
  fg: string;
};

const TONE_MAP: Record<string, TypeTone> = {
  // 退房 —— 藍。整個月最多的一種
  退房: { bg: '#4FC3F7', fg: '#FFFFFF' },
  // 入住 —— 綠
  入住: { bg: '#5CC98C', fg: '#FFFFFF' },
  // 清潔（換房、細清、公區…）—— 紫
  清潔: { bg: '#B39DDB', fg: '#FFFFFF' },
  // 休假 —— 黃。**這一條用深字**，白字在黃底上讀不到
  休假: { bg: '#FFE04D', fg: '#5C4B00' },
  // 其他（贈品、點交、拆備品、其他工時）—— 褐
  其他: { bg: '#A1887F', fg: '#FFFFFF' },
};

/**
 * 工作類型 → 分類。
 *
 * 用 `includes` 而不是完全比對:工作類型是使用者可以在設定頁改的，
 * 「退房清潔」哪天變成「退房清潔（含布巾）」不該讓顏色掉回「其他」。
 *
 * 順序有意義 —— 「退房」要排在「清潔」前面，
 * 不然「退房清潔」會先撞到「清潔」那一條。
 */
export function toneKeyOf(workType: string | null | undefined): string {
  const t = workType ?? '';
  if (t.includes('退房') || t.includes('退')) return '退房';
  if (t.includes('入住')) return '入住';
  if (t.includes('休') || t.includes('假')) return '休假';
  if (t.includes('清潔') || t.includes('細清') || t.includes('清')) return '清潔';
  return '其他';
}

export function toneOfType(workType: string | null | undefined): TypeTone {
  return TONE_MAP[toneKeyOf(workType)];
}

/** 圖例用。順序 = 月曆上出現的頻率，不是字母序 */
export const TYPE_LEGEND: { key: string; tone: TypeTone }[] =
  ['退房', '入住', '清潔', '休假', '其他'].map((key) => ({ key, tone: TONE_MAP[key] }));

/* ============================================================
 * 時間（migration_134，照 TimeTree）
 * ============================================================ */

/** "09:00:00" / "09:00" → 分鐘。空的回 null */
export function toMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(':');
  const hh = Number(h), mm = Number(m ?? 0);
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
}

/**
 * 工作時長（分鐘）。
 *
 * 【跨夜用 +24 小時，不是錯誤】
 *
 * `end_time < start_time`（22:00–02:00）代表做到隔天。
 * 資料庫沒有 CHECK 擋它 —— 那是合法的排班，不是打錯。
 *
 * 直接相減會得到負數，而負數在畫面上會顯示成「−20 小時」，
 * 看的人只會覺得系統壞了。
 */
export function durationMin(
  start: string | null | undefined, end: string | null | undefined,
): number | null {
  const a = toMin(start), b = toMin(end);
  if (a == null || b == null) return null;
  return b >= a ? b - a : b + 24 * 60 - a;
}

/** "09:00:00" → "09:00"。給畫面用 —— 秒沒有資訊 */
export const hhmmOf = (t: string | null | undefined): string =>
  t ? t.slice(0, 5) : '';

/**
 * 時間區間的顯示字串。
 *
 * 全天不寫「全天」兩個字 —— 絕大多數工作都是全天，
 * 每一列都掛一個「全天」等於整片噪音。**沒有時間就是全天**，
 * 而有時間的那幾筆自然會跳出來。
 */
export function timeRangeText(t: {
  all_day?: boolean | null; start_time?: string | null; end_time?: string | null;
}): string {
  if (t.all_day !== false) return '';
  const s = hhmmOf(t.start_time), e = hhmmOf(t.end_time);
  if (!s && !e) return '';
  if (s && e) return `${s}–${e}`;
  return s || e;
}

/**
 * 排序用的鍵：全天排最前，其餘照開始時間。
 *
 * 全天排前面是因為那些是「今天要做，時間自己抓」——
 * 有指定時間的是硬約束，看的人要先掃過軟的再看硬的。
 */
export const startKeyOf = (t: {
  all_day?: boolean | null; start_time?: string | null;
}): number => (t.all_day !== false ? -1 : (toMin(t.start_time) ?? 24 * 60));

/**
 * 這一筆在畫面上要顯示的一行字。
 *
 * 有自訂標題就用它 —— 「聚餐」「洗烘折毛巾」這種本來就不該被組成
 * 「其他工時 (無房源)」。沒填才用 taskLabel 組。
 */
export function displayTitle(t: Pick<TaskView, 'work_type' | 'room' | 'guest'> & {
  title?: string | null;
}): string {
  return t.title?.trim() || taskLabel(t);
}
