// 長租月租單的 order_key 格式:LT_{room}_{YYYYMM}
//
// ⚠ 絕對不要單靠 supabase 的 .like('order_key', `LT_${room}_%`) 來篩選。
//    SQL LIKE 的 "_" 是「任一字元」萬用字元,所以房號 2F-1 的查詢會連同
//    2F-10 ~ 2F-19 的月租單一起撈出來(2F-2 → 2F-20~2F-29,依此類推)。
//    這曾造成 seed 匯入時把 2F-1/2F-2/2F-3 的收款記錄整批清空。
//
// 正確用法:.like() 只當作粗篩(讓資料庫先縮小範圍),撈回來之後
//          一律再用 onlyLtOf() 在 JS 端做精確比對。
//
//    const { data } = await supabase.from('orders')
//      .select('id, order_key').like('order_key', `LT_${room}_%`);
//    const rows = onlyLtOf(data, room);   // ← 這步不能省

export const ltPrefix = (room: string) => `LT_${room}_`;

/**
 * 契約月租單的鍵基底。**所有拼 order_key 的地方都要走這支。**
 *
 * 房號有值   LT_{房號}_      既有的幾千筆訂單是這個格式,不動它
 * 房號空的   LTC_{契約id}_   公司登記、辦公室租金這種本來就不屬於某一間房
 *
 * 為什麼分兩種:房號原本是必要的,沒填就一列都產不出來(migration_77 之前),
 * 而全部改用契約 id 要改寫已經收過錢的訂單鍵 —— paid / paid_at / 發票都掛在上面,
 * 搬遷寫錯就是收款紀錄對不上。所以只讓新的情況走 id,舊的維持原樣。
 *
 * 跟 archive/migrations-30-99/migration_77 裡的 kbase 必須完全一致,
 * 兩邊算出不同的鍵就會產生重複的月租單。
 */
export function keyBase(c: { id?: string | null; room?: string | null }): string {
  return c.room ? `LT_${c.room}_` : `LTC_${c.id ?? ''}_`;
}

/** order_key 是否確實屬於這張契約(前綴完全相符,且結尾是 6 位數年月) */
export function isKeyOf(orderKey: string, base: string): boolean {
  if (!base || base === 'LTC__') return false;
  return orderKey.startsWith(base) && /^\d{6}$/.test(orderKey.slice(base.length));
}

/** order_key 是否確實屬於這間房 */
export function isLtKeyOf(orderKey: string, room: string): boolean {
  if (!room) return false;
  return isKeyOf(orderKey, ltPrefix(room));
}

/**
 * 從查詢結果中只留下確實屬於這張契約的月租單。
 *
 * 這一步不能省 —— SQL LIKE 的 "_" 是萬用字元,`LT_2F-1_%` 會連 2F-10 ~ 2F-19
 * 一起撈出來。曾經因此把 2F-1/2F-2/2F-3 的收款記錄整批清空。
 */
export function onlyKeyOf<T extends { order_key: string }>(
  rows: T[] | null | undefined,
  base: string,
): T[] {
  return (rows ?? []).filter((r) => isKeyOf(r.order_key, base));
}

/** 舊介面:依房號過濾。新程式請用 onlyKeyOf(rows, keyBase(contract))。 */
export function onlyLtOf<T extends { order_key: string }>(
  rows: T[] | null | undefined,
  room: string | null | undefined,
): T[] {
  return (rows ?? []).filter((r) => isLtKeyOf(r.order_key, room ?? ''));
}

/** 取出 order_key 尾端的 YYYYMM */
export function ltYm(orderKey: string, room: string): string {
  return orderKey.slice(ltPrefix(room).length);
}
