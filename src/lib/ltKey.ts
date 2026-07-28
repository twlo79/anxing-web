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

/** order_key 是否確實屬於這間房(前綴完全相符,且結尾是 6 位數年月) */
export function isLtKeyOf(orderKey: string, room: string): boolean {
  if (!room) return false;
  const p = ltPrefix(room);
  return orderKey.startsWith(p) && /^\d{6}$/.test(orderKey.slice(p.length));
}

/** 從查詢結果中只留下確實屬於這間房的月租單 */
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
