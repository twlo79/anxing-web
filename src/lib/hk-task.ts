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

export type DayCount = { total: number; unassigned: number; done: number };

export function dayCounts(list: TaskView[]): DayCount {
  return {
    total: list.length,
    unassigned: list.filter((t) => !t.staff_id).length,
    done: list.filter((t) => t.done_at).length,
  };
}

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
