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
 * ============================================================
 * 【2026-09-05：第四個狀態接上了】
 *
 * 上面那段原本寫著「真正的完成還沒有狀態⋯⋯需要的話再加第四個狀態，
 * 不要把『採購中』偷偷改成完成」。現在補上了，而且**沒有**動
 * `DemandStatus` 那四個值 —— 資料庫的 check 只認 open/partial/done/cancelled。
 *
 * 做法是把「顯示」跟「鍵」分開（CLAUDE.md：同一支欄位既拿來顯示
 * 又拿來當 key）：
 *
 *   `status`  給資料庫與 CSS 用，還是四個值
 *   `label`   給人看，全部項目都採購完時才會是「已採購」
 *
 * 【★★★ 「已採購」= 請款單送審，是使用者 2026-09-05 選的】
 *
 * 資料庫這邊是 migration_219 的 `trg_pr_take_demands`：
 * 請款單 draft → pending 那一刻，接到的需求項目翻成 `done`。
 * 退回草稿會翻回 `requested`，被駁回則由既有的
 * `trg_pr_reject_demands` 退回 `pending` 並清掉關聯。
 *
 * ★ 另一個選項是「填了出款日才算」（跟 `gen_expenses_from_pr` 同一刻）。
 *   代價講清楚：送審之後、核可付款之前那段時間，需求單會顯示「已採購」
 *   而錢還沒出去。使用者接受這個代價 —— 他要的是「會計處理完了」，
 *   不是「錢付了」。要改回來的話動 migration_219 那一支就好。
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

/*
 * ★ `done` 從「已完成」改成「已採購」（2026-09-05）。
 *
 *   「已完成」在這張單上沒有定義 —— 東西到了算完成？錢付了算完成？
 *   而這個狀態實際代表的是「請款單送審了，會計處理完他那一段」。
 *   用語表裡這件事叫**已採購**（跟按鈕「標為已採購」同一個字）。
 */
export const ITEM_STATUS_LABEL: Record<DemandItemStatus, string> = {
  pending: '未採購',
  quoted: '已詢價',
  requested: '已進請款',
  done: '已採購',
  cancelled: '已取消',
};

/** 單頭顯示成「已採購」時的樣式。★ 綠色全站保留給「已收／通過／完成」 */
export const DEMAND_PAID_CLASS = 'bg-mor-greenlight text-mor-green';

/**
 * 採購平台（2026-09-07 使用者：「蝦皮 酷澎 淘寶 好事多」）。
 *
 * ★★★ **這裡是唯一的清單**。資料庫那一欄是純 `text`、沒有 check ——
 *   多一個平台就是在這個陣列加一行，不用 migration。
 *   （加約束的話「以後在哪買」這個決定就被綁在資料庫上，
 *     而那是這個月就會變的事。）
 *
 * ★ 代價:沒有約束就擋不住錯字，「蝦皮」跟「蝦皮購物」會變成兩個平台
 *   而報表分不開。緩衝是畫面上**只給下拉、不給自由打字**。
 *
 * ★ 順序照常用程度排 —— 下拉不用捲就選得到最常用的那個。
 */
export const PURCHASE_PLATFORMS = ['蝦皮', '酷澎', '淘寶', '好事多'] as const;

export type PurchasePlatform = typeof PURCHASE_PLATFORMS[number];

export type DemandItemLike = {
  status: DemandItemStatus;
  item_name?: string | null;
};

export type DemandProgress = {
  /** ★ 給資料庫與 CSS 用的鍵，只有四個值。顯示請用 `label` */
  status: DemandStatus;
  /** 給人看的字。全部採購完時是「已採購」，那個字不在 `status` 裡 */
  label: string;
  /** 已進請款的項數（含已採購的） */
  taken: number;
  /** 已採購的項數。`paid === taken > 0` 才算整張採購完 */
  paid: number;
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
      taken: 0, paid: 0, left: 0, total: 0, leftNames: [] };
  }
  const live = items.filter((i) => i.status !== 'cancelled');
  const taken = live.filter((i) => isTaken(i.status)).length;
  const paid = live.filter((i) => i.status === 'done').length;
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

  /*
   * ★★★ 「已採購」是**顯示字**，不是第五個 `status` 值。
   *
   *   資料庫的 check 只認 open/partial/done/cancelled，
   *   加第五個值要改約束、改 `demand_rollup`、改前端三個地方 ——
   *   而這件事只是要讓人看得懂那一行字。
   *
   * ★ 條件是 `paid === taken`：全部進請款的項目都已經送審了。
   *   寫成 `paid > 0` 的話，五項裡一項送審就會顯示「已採購」。
   */
  const allPaid = status === 'done' && taken > 0 && paid === taken;

  return {
    status,
    label: allPaid ? '已採購' : DEMAND_STATUS_LABEL[status],
    taken, paid, left, total,
    leftNames: live.filter((i) => isOpen(i.status))
      .map((i) => (i.item_name ?? '').trim()).filter(Boolean),
  };
}

/** 單頭標籤的樣式。★ 已採購要綠色，那不在 `DEMAND_STATUS_CLASS` 裡 */
export function demandClass(p: DemandProgress): string {
  if (p.status === 'done' && p.taken > 0 && p.paid === p.taken) return DEMAND_PAID_CLASS;
  return DEMAND_STATUS_CLASS[p.status];
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
  if (p.status === 'done') {
    if (p.paid === p.taken) return `${p.taken} 項全部採購完`;
    if (p.paid === 0) return `${p.taken} 項全部進請款`;
    return `${p.taken} 項全部進請款・已採購 ${p.paid}`;
  }
  const names = p.leftNames.slice(0, maxNames).join('、');
  const more = p.leftNames.length > maxNames ? ` 等 ${p.leftNames.length} 樣` : '';
  return `已進請款 ${p.taken} / ${p.total}・還缺：${names}${more}`;
}

/* ══════════════════════════════════════════════════════════
 * 會計手動改狀態（2026-09-05 使用者要求）
 * ══════════════════════════════════════════════════════════
 *
 * 【★★★ 為什麼一定要有這個逃生口】
 *
 * 狀態平常由觸發器維護，但有兩種情況會卡住而**沒有任何一條路救得回來**：
 *
 * ① 會計把草稿請款單**刪掉**（不是駁回）。
 *    外鍵是 `on delete set null`，所以 `request_item_id` 被清成 null，
 *    可是 `status` 還留在 `requested`。那一項顯示「已進請款」卻點不到
 *    單號，而 `isTakeable('requested')` 是 false ——
 *    **再也不能被帶進任何請款單**。
 *    （migration_219 補了觸發器，但那之前卡住的資料還在。）
 *
 * ② 東西改用零用金買了、或需求取消了，而請款單那邊已經開了。
 *
 * 系統負責看見，人負責決定 —— 這是那條原則的第二半。
 *
 * 【★★ 改回未採購一定要清掉 `request_item_id`】
 *
 * 不清的話會留下一個「未採購但接著請款單」的項目：
 * 它可以被再帶一次（`isTakeable('pending')` 是 true），
 * 於是同一筆錢出現在兩張請款單上，而總額只是「比較大」。
 */

/** 手動改狀態時，一併要寫的欄位。★ `request_item_id: null` 是有意義的值，不是「沒改」 */
export type ManualPatch = { status: DemandItemStatus; request_item_id?: null };

/**
 * 這一項可以手動改成哪些狀態（含目前這個）。
 *
 * ★ 已經接到請款單的**不給改成「已詢價」或「已取消」** ——
 *   那會變成「還在詢價中，但錢已經在請款單上了」，
 *   而畫面上兩邊各說各話。要退掉就退到底（未採購，同時解除關聯）。
 */
export function manualStatusOptions(
  i: { status: DemandItemStatus; request_item_id?: string | null },
): DemandItemStatus[] {
  if (i.request_item_id) return ['requested', 'done', 'pending'];
  return ['pending', 'quoted', 'done', 'cancelled'];
}

/** 選了目標狀態之後要寫進資料庫的東西。 */
export function manualStatusPatch(
  to: DemandItemStatus, hadRequest: boolean,
): ManualPatch {
  // 退回開放狀態一律解除關聯 —— 理由見上面那段
  if (hadRequest && (to === 'pending' || to === 'quoted' || to === 'cancelled')) {
    return { status: to, request_item_id: null };
  }
  return { status: to };
}

/**
 * 改之前要讓人看到的一句話。`null` = 不用特別講。
 *
 * ★ 只講**這個動作會造成什麼**，不解釋實作
 *   （CLAUDE.md：說明文字簡練清楚，寫給不知道前因後果的人看）。
 */
export function manualStatusNote(
  to: DemandItemStatus, hadRequest: boolean,
): string | null {
  if (hadRequest && (to === 'pending' || to === 'quoted' || to === 'cancelled')) {
    return '會解除跟請款單的關聯。那張請款單上的項目不會消失，要自己去請款單刪。';
  }
  if (!hadRequest && to === 'done') {
    return '沒有請款單的「已採購」是零用金直接買的。要走請款流程請改按「建請款單」。';
  }
  return null;
}

/**
 * 這一項是不是卡在「已進請款但接不到請款單」。
 *
 * ★★ 這是 ① 那個洞留下的資料。畫面上要標出來，
 *   不然它看起來就是一筆正常的「已進請款」，而它永遠不會前進。
 *
 * ============================================================
 * 【★★★ `done` 不算 —— 2026-09-07 修的誤報】
 *
 * 原本寫成 `(status === 'requested' || status === 'done') && !request_item_id`，
 * 而**零用金直接買**那條路產生的正是「已採購 ＋ 沒有請款單」——
 * 完全正常的資料被標成「接不到單」。
 *
 * 使用者手動把一項改成「已採購」之後就看到那個橘標，
 * 問「接不到單是什麼意思？」——**誤報比不報更糟**，
 * 它讓人開始懷疑一批本來沒問題的資料。
 *
 * ★ 只有 `requested` 才算卡住:那個狀態的定義就是
 *   「已經進了某一張請款單」，接不到單就是自相矛盾。
 *   `done` 沒有這個矛盾 —— 它可以是零用金買的。
 */
export function isOrphanRequested(
  i: { status: DemandItemStatus; request_item_id?: string | null },
): boolean {
  return i.status === 'requested' && !i.request_item_id;
}
