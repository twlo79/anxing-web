/**
 * 房務行事曆的資料整理（純函式）。
 *
 * 頁面負責取資料與畫面，「哪一天有哪些工作、怎麼排序、怎麼摘要」放在這裡 ——
 * 那是會出錯而且看不出來的部分：少一筆、排錯序、同一個人被算兩次。
 */

export type WorkItem = {
  id: string;
  work_date: string;
  property_code: string | null;
  work_type: string;
  staff_id: string;
};

export type DayEntry = {
  staff: string;
  staffId: string;
  work: string;
  /** 這個人這天在這個工作類型下負責的房源，已排序 */
  rooms: string[];
};

/**
 * 一天的工作，按「人」收攏。
 *
 * 【為什麼按人而不是按房源】
 * 排班表一天可能有二十筆（一個人掃八間就是八筆）。一筆一列的話，
 * 格子裡是二十行看不完的字，而人想知道的只有「今天誰在、大概多少間」。
 *
 * 收攏之後一天通常是二到四列：「Una 清潔 8 間」。
 */
export function groupByStaff(
  items: WorkItem[],
  staffName: (id: string) => string,
  workName: (code: string) => string,
  roomName: (code: string) => string,
): DayEntry[] {
  const map = new Map<string, DayEntry>();
  for (const it of items) {
    const key = `${it.staff_id}|${it.work_type}`;
    let e = map.get(key);
    if (!e) {
      e = {
        staff: staffName(it.staff_id), staffId: it.staff_id,
        work: workName(it.work_type), rooms: [],
      };
      map.set(key, e);
    }
    // property_code 是 null 代表沒有房源（協助行政、洗烘折毛巾）——
    // 那筆仍然是一件工作，不能因為沒有房號就消失
    if (it.property_code) e.rooms.push(roomName(it.property_code));
  }
  for (const e of map.values()) e.rooms.sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  // 間數多的排前面 —— 一眼看到的是當天的主力
  return [...map.values()].sort(
    (a, b) => b.rooms.length - a.rooms.length || a.staff.localeCompare(b.staff, 'zh-Hant'));
}

/** work_date → 該天的工作。日期直接當 key，不做時區轉換（資料庫存的就是本地日期）。 */
export function byDate(items: WorkItem[]): Record<string, WorkItem[]> {
  const out: Record<string, WorkItem[]> = {};
  for (const it of items) (out[it.work_date] ??= []).push(it);
  return out;
}

/**
 * 格子裡的一行字。
 *
 * 沒有房源的工作不寫「0 間」——「Una 洗烘折 0 間」看起來像出錯了，
 * 但它其實是一件正常的工作。
 */
export function entryText(e: DayEntry): string {
  return e.rooms.length ? `${e.staff} ${e.rooms.length}` : `${e.staff} ${e.work}`;
}

/** 一天的摘要：幾個人、幾間。給格子的標題用。 */
export function dayTotal(entries: DayEntry[]): { people: number; rooms: number } {
  return {
    people: new Set(entries.map((e) => e.staffId)).size,
    rooms: entries.reduce((n, e) => n + e.rooms.length, 0),
  };
}
