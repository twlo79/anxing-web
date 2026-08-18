/**
 * 採購需求單的狀態與進度（純函式）。
 *
 * ============================================================
 * 【三個狀態，講的是「採購走到哪」不是「單子完成了沒」】
 * （2026-08-17 使用者指定）
 *
 *   尚未採購   一項都還沒進請款
 *   部分採購   有些進請款了、有些還沒
 *   採購中     全部都進請款了
 *
 * **「採購中」不是「完成」。** 進請款只代表會計開始處理，
 * 東西還沒到、錢也還沒付。
 *
 * 這個區別很容易被下一個人看錯 —— 資料庫的欄位值是 `done`，
 * 直覺會翻成「已完成」，然後畫面上就會出現「已完成」卻沒有人拿到東西。
 * 所以標籤寫在這裡，不要在畫面上各寫一份。
 *
 * 【真正的完成還沒有狀態】
 * 東西到手要等請款單核可、付款、甚至簽收。那是另一段流程，
 * 現在還沒接 —— 需要的話再加第四個狀態，不要把「採購中」偷偷改成完成。
 */

export type DemandStatus = 'open' | 'partial' | 'done' | 'cancelled';

/** 項目層的狀態。`requested` = 已進請款單 */
export type DemandItemStatus = 'pending' | 'quoted' | 'requested' | 'done' | 'cancelled';

export const DEMAND_STATUS_LABEL: Record<DemandStatus, string> = {
  open: '尚未採購',
  partial: '部分採購',
  done: '採購中',
  cancelled: '已作廢',
};

export const DEMAND_STATUS_CLASS: Record<DemandStatus, string> = {
  open: 'bg-gray-100 text-gray-600',
  // 部分採購用琥珀色 —— 它是唯一「還有事情要做」的狀態,
  // 灰色跟綠色都會讓人以為不用管了
  partial: 'bg-amber-50 text-amber-700',
  done: 'bg-mor-bluelight text-mor-slate',
  cancelled: 'bg-gray-100 text-gray-400',
};

export const ITEM_STATUS_LABEL: Record<DemandItemStatus, string> = {
  pending: '未採購',
  quoted: '已詢價',
  requested: '已進請款',
  done: '已完成',
  cancelled: '已取消',
};

export type DemandItemLike = {
  status: DemandItemStatus;
  item_name?: string | null;
};

export type DemandProgress = {
  status: DemandStatus;
  label: string;
  /** 已進請款的項數 */
  taken: number;
  /** 還沒進請款的項數（不含已取消） */
  left: number;
  /** 有效項數 = taken + left。已取消的不算 */
  total: number;
  /** 還沒買的品名，給「部分採購」時直接列出來 */
  leftNames: string[];
};

/** 還在等會計處理的 */
const isOpen = (s: DemandItemStatus) => s === 'pending' || s === 'quoted';
/** 已經交給請款流程的 */
const isTaken = (s: DemandItemStatus) => s === 'requested' || s === 'done';

/**
 * 從項目推導整張單的狀態與進度。
 *
 * ============================================================
 * 【為什麼要回傳「還沒買的品名」】（使用者指定）
 *
 * 「部分採購」只講了一半 —— 提需求的人真正想知道的是
 * **「我要的五樣裡，哪三樣還沒買」**。
 *
 * 只給一個 `partial` 標籤的話，他還是得點開單子一項一項看。
 * 那個動作每次都要做，而答案就是幾個品名而已。
 *
 * 【已取消的不算進分母】
 * 五項取消兩項、其餘三項都進請款了 —— 那是「採購中」不是「部分採購」。
 * 把取消的算進分母的話,那張單會永遠停在 3/5，看起來像還有事沒做。
 */
export function demandProgress(items: DemandItemLike[], cancelled = false): DemandProgress {
  if (cancelled) {
    return { status: 'cancelled', label: DEMAND_STATUS_LABEL.cancelled,
      taken: 0, left: 0, total: 0, leftNames: [] };
  }
  const live = items.filter((i) => i.status !== 'cancelled');
  const taken = live.filter((i) => isTaken(i.status)).length;
  const left = live.filter((i) => isOpen(i.status)).length;
  const total = taken + left;

  /*
   * 沒有任何項目時是「尚未採購」，不是「採購中」。
   *
   * 空單走 taken === total（0 === 0）的話會被判成全部進請款了 ——
   * 而那張單其實是剛建好、還沒填東西。
   */
  const status: DemandStatus =
    total === 0 ? 'open'
      : taken === 0 ? 'open'
        : left === 0 ? 'done'
          : 'partial';

  return {
    status,
    label: DEMAND_STATUS_LABEL[status],
    taken, left, total,
    leftNames: live.filter((i) => isOpen(i.status))
      .map((i) => (i.item_name ?? '').trim()).filter(Boolean),
  };
}

/**
 * 進度的一行摘要。
 *
 * 尚未採購 → `5 項待採購`
 * 部分採購 → `已進請款 2 / 5・還缺：垃圾袋、抹布、手套`
 * 採購中   → `5 項全部進請款`
 *
 * 「還缺」最多列三樣 —— 再多就換行了，而列表的一列只有一行的高度。
 */
export function progressText(p: DemandProgress, maxNames = 3): string {
  if (p.status === 'cancelled') return '已作廢';
  if (p.total === 0) return '還沒有項目';
  if (p.status === 'open') return `${p.left} 項待採購`;
  if (p.status === 'done') return `${p.taken} 項全部進請款`;
  const names = p.leftNames.slice(0, maxNames).join('、');
  const more = p.leftNames.length > maxNames ? ` 等 ${p.leftNames.length} 樣` : '';
  return `已進請款 ${p.taken} / ${p.total}・還缺：${names}${more}`;
}
