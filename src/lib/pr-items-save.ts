/**
 * 請款項目存檔：算出「哪些要刪、哪些要改、哪些要新增」。
 *
 * ============================================================
 * 【原本是全刪再全寫】（2026-08-24 使用者要求逐項憑證時發現）
 *
 *     await supabase.from('purchase_request_items').delete().eq('request_id', reqId);
 *     …
 *     await supabase.from('purchase_request_items').insert(payload);
 *
 * 所以 `purchase_request_items.id` **每存一次就換一批新的**。
 *
 * 一直沒出事，是因為兩件事剛好互相掩護:
 *
 *   · 唯一指向那些 id 的是 `expenses.source_item_id`
 *   · 而支出是「填出款日」才產生的，出款日一填 canEdit 就變 false
 *     （`!r.purchased_on && !r.expense_generated_at`）—— 不能再編輯，id 就不會再變
 *
 * 換句話說，**這是靠「出款後不能編輯」這條規則僥倖沒爆的**。
 * 哪天那條規則放寬（例如允許總管理員改已出款的單），
 * 所有支出的 source_item_id 會同時指向不存在的項目，
 * 而症狀是支出頁的「來自請款單」標記消失、憑證圖繼承不到 ——
 * 沒有任何錯誤訊息。
 *
 *
 * ============================================================
 * 【為什麼現在非改不可】
 *
 * 逐項憑證要把圖掛在 `attachments.request_item_id` 上。
 * id 每次存檔都換的話:
 *
 *   · `on delete cascade` → 每按一次存檔，剛傳的發票**全部被刪掉**
 *   · `on delete set null` → 變成沒有母層的孤兒，違反 att_one_parent
 *
 * 而使用者按存檔的時機，正好就是他剛傳完發票的時候。
 *
 *
 * ============================================================
 * 【為什麼不用 upsert 一句解決】
 *
 * PostgREST 的批次 upsert **取欄位的聯集**（CLAUDE.md 的坑）:
 * 某一列少了某個鍵會被填成 null。新增的列沒有 id、既有的列有，
 * 混在一起送的話，新增那幾列的 id 會被當成 null 送進去。
 *
 * 所以拆成三個動作:刪掉不要的、改既有的、插新的。
 * 這支只負責**算**，不碰資料庫 —— 算對了才有得測。
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX，寫在元件裡的判斷式測不到。
 */

/** 畫面上的一列。新增的沒有 id */
export type EditItem = { id?: string | null };

export type ItemPlan<T extends EditItem> = {
  /** 這些 id 要從資料庫刪掉（使用者在畫面上移除的列） */
  deleteIds: string[];
  /** 這些要 update（有 id 的既有列）。sort 已經照畫面順序填好 */
  update: (T & { id: string; sort: number })[];
  /** 這些要 insert（畫面上新增的列）。**不帶 id** —— 讓資料庫產生 */
  insert: (Omit<T, 'id'> & { sort: number })[];
};

/**
 * @param rows     畫面上的項目，順序就是使用者看到的順序
 * @param existing 資料庫裡目前有哪些 id（這張單底下的）
 */
export function planItemSave<T extends EditItem>(
  rows: readonly T[], existing: readonly string[],
): ItemPlan<T> {
  const seen = new Set<string>();
  const update: (T & { id: string; sort: number })[] = [];
  const insert: (Omit<T, 'id'> & { sort: number })[] = [];

  rows.forEach((r, sort) => {
    /*
     * ★ 只有「id 真的存在於資料庫」才算 update。
     *
     *   畫面上的 id 可能是假的:複製一列的時候，或是舊分頁存了
     *   一個已經被別人刪掉的項目。那時候 update 會影響 0 列
     *   （RLS 那條坑的變形）—— 而畫面會說存好了。
     *   對不到就當成新增，寧可多一列也不要少一列。
     */
    if (r.id && existing.includes(r.id)) {
      seen.add(r.id);
      update.push({ ...r, id: r.id, sort });
    } else {
      const { id: _drop, ...rest } = r as T & { id?: string | null };
      insert.push({ ...(rest as Omit<T, 'id'>), sort });
    }
  });

  return {
    // 資料庫有、畫面上沒有 = 使用者刪掉的
    deleteIds: existing.filter((id) => !seen.has(id)),
    update,
    insert,
  };
}

/**
 * 這次存檔會不會弄丟已經上傳的憑證圖。
 *
 * ★ 回傳「有圖、但這次會被刪掉」的項目 id。
 *   不是拿來擋存檔的 —— 使用者真的要刪那一項就該讓他刪 ——
 *   是拿來**在確認視窗裡講清楚**:
 *
 *       「項目『冷氣濾網』有 2 張憑證圖，刪掉之後不會進回收桶。」
 *
 *   不講的話，圖就是無聲地消失。這個專案的錯誤幾乎都是安靜的。
 */
export function receiptsAtRisk(
  deleteIds: readonly string[], imageCountByItem: Readonly<Record<string, number>>,
): string[] {
  return deleteIds.filter((id) => (imageCountByItem[id] ?? 0) > 0);
}
