/**
 * 暫收款總計（2026-08-25 使用者：「要有總共 暫收款」）。
 *
 * 看板上面兩列分別是訂金與押金，各自回答「這一種錢在哪個階段」。
 * 少的是最上面那一句話：**我們手上現在總共有多少別人的錢**。
 * 那正是「暫收付管理」的暫收那半在問的事。
 *
 * ── 為什麼是合併不是相加 ────────────────────────────
 *
 * 金額不能用一個數字表示 —— 這張表是多幣別的（migration_87）。
 * `cur` 是「幣別 → 金額」，兩邊合併時要**逐幣別相加**。
 *
 * 直接寫 `a.cur.TWD + b.cur.TWD` 的話，外幣會安靜地消失：
 * 卡片上的台幣數字完全正確，而 USD 700 那幾筆從總計裡不見了，
 * 沒有任何跡象。
 *
 * ★ 筆數可以直接相加 —— 訂金與押金是 deposits 上互斥的兩種 kind，
 *   同一列不會被算兩次。
 */

export type Bucket = { n: number; cur: Record<string, number> };

/** 兩個（以上）分類合併成一個。逐幣別相加，不假設有哪些幣別。 */
export function mergeBuckets(...bs: Bucket[]): Bucket {
  const out: Bucket = { n: 0, cur: {} };
  for (const b of bs) {
    if (!b) continue;
    out.n += b.n ?? 0;
    for (const [cur, amt] of Object.entries(b.cur ?? {})) {
      out.cur[cur] = (out.cur[cur] ?? 0) + amt;
    }
  }
  return out;
}

/**
 * 訂金 ＋ 押金 = 暫收款總計，三個階段各一份。
 *
 * ★ 階段的語意在兩種錢之間是一致的，所以合得起來：
 *     pending  還沒收到
 *     held     錢在我們手上
 *     returned 處理完了（押金是退款；訂金還有沒收與轉押）
 *
 *   ★★ `returned` 這一格**兩種的意思不完全一樣** —— 訂金的沒收沒有把錢退出去。
 *      所以總計那一列的第三格寫「已結案」而不是「已退款」，
 *      不然會讓人以為那些錢都出去了。
 */
export function totalBuckets(
  earn: { pending: Bucket; held: Bucket; returned: Bucket },
  dep: { pending: Bucket; held: Bucket; returned: Bucket },
) {
  return {
    pending: mergeBuckets(earn.pending, dep.pending),
    held: mergeBuckets(earn.held, dep.held),
    returned: mergeBuckets(earn.returned, dep.returned),
  };
}
