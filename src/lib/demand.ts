/**
 * 採購需求單的項目驗證。
 *
 * ============================================================
 * 【為什麼要抽出來】（2026-08-31）
 *
 * `demand-tab.tsx` 裡有**兩份一模一樣的判斷**:
 *   · `canSubmit`  → 決定「存檔」按鈕亮不亮
 *   · `save()`     → 真的送出前再擋一次
 *
 * 那支檔案裡本來就寫著:
 *   「跟 save() 裡的驗證是**同一組條件** —— 分成兩份的話，
 *     按鈕亮著卻送不出去（或反過來），而使用者只會覺得系統壞了。」
 *
 * ★★★ 而 migration_186 加「安幸辦公室」時**差點就漏掉其中一份** ——
 *   改了 save() 沒改 canSubmit 的話，症狀是:
 *   選了辦公室、品名也打了，**存檔按鈕還是灰的**，
 *   而畫面上沒有任何東西說明為什麼。
 *
 * 兩份判斷共用一個函式就漂不了。
 *
 * ★ 而且寫在 `.ts` 才測得到 —— 測試環境不處理 JSX（CLAUDE.md）。
 *
 * ============================================================
 * 【★★ office 與 estate 的互斥】
 *
 * 「安幸辦公室」不是物業，它不在 `estates` 裡，所以它的 `estate_id`
 * 一定是空的。資料庫有互斥約束擋著（`pdi_purpose_one_of`，migration_186），
 * 但擋下來的錯誤訊息填表的人看不懂 —— 前端要先擋。
 */

export type DemandItemLike = {
  item_name: string;
  purpose_type: 'estate' | 'office';
  /** office 時是空字串。 */
  estate_id: string;
};

/**
 * 這一列**算不算有填東西**。
 *
 * ★★ 判斷裡要包含 `purpose_type === 'office'`。
 *   只看 `estate_id` 的話，「只選了安幸辦公室、品名還沒打」那一列
 *   會被當成空白列**默默丟掉** —— 而使用者以為自己填了，
 *   送出後才發現少一項。
 */
export function isFilled(i: DemandItemLike): boolean {
  return !!(i.item_name.trim() || i.estate_id || i.purpose_type === 'office');
}

/**
 * 這一列填完整了沒。
 *
 * ★ office **不用**選物業 —— 它本來就不是物業。
 *   沿用舊的 `!i.estate_id` 判斷的話，選了辦公室永遠過不了。
 */
export function isComplete(i: DemandItemLike): boolean {
  if (!i.item_name.trim()) return false;
  if (i.purpose_type === 'office') return true;
  return !!i.estate_id;
}

/**
 * 整張單能不能送。回傳錯誤訊息，可以送的話回 null。
 *
 * @param items   表單上的全部列（含空白列）
 * @param shipTo  寄送地點。空的不能送 —— 東西買了不知道寄哪，會計要回頭問一次
 *
 * ★★ 錯誤訊息帶**第幾項**。只說「有項目沒填完」的話，
 *   十項的單子要自己一列一列找。
 */
export function validateDemand(
  items: DemandItemLike[], shipTo: string | null | undefined,
): string | null {
  const filled = items.filter(isFilled);
  if (filled.length === 0) return '至少要填一個項目';

  const bad = filled.findIndex((i) => !isComplete(i));
  if (bad >= 0) return `第 ${bad + 1} 項的品名與用途都要填`;

  if (!shipTo) return '請選寄送地點';
  return null;
}

/**
 * 要寫進 `purchase_demand_items.estate_id` 的值。
 *
 * ★★★ office 一律 `null`，**不是空字串、也不是留著上一次選的物業**。
 *
 *   留著的傷害不是「存不進去」（互斥約束會擋），
 *   而是萬一哪天約束被拿掉:報表照 `estate_id` 分組，
 *   那一筆會**同時算進辦公室與那個物業**，兩邊都對不上，
 *   而畫面上完全看不出來。
 */
export function estateIdToSave(i: DemandItemLike): string | null {
  return i.purpose_type === 'office' ? null : i.estate_id;
}

/* ══════════════════════════════════════════════════════════
 * 新增時要寫進資料庫的那一列
 * ══════════════════════════════════════════════════════════
 *
 * 【★★★ 為什麼這個要抽出來】（2026-09-09）
 *
 * `buy_link` 這一欄**從上線到現在一次都沒被存進去過**:
 * 表單有那個輸入框、列表也有顯示 `建議連結` 的程式碼，
 * 中間的 insert 少寫了一行 —— 於是那個連結永遠是空的,
 * 而畫面上只是「沒有連結」，看起來像使用者沒填。
 *
 * ★★ 這是 `CLAUDE.md` 那條「一個靜默的讀 ＋ 一個靜默的寫
 *   ＝ 一個不存在的功能」的第二次。第一次是 `hk_day.rooms_override`。
 *
 * ★★★ 抽成函式之後，「表單收了什麼」與「寫進去什麼」
 *   變成同一個地方的事，而且**測得到**。
 *   下次再加一欄，測試那一條會提醒你這裡也要加。
 */

export type DemandItemDraft = DemandItemLike & {
  /** 規格說明。大概數量也寫在這裡（migration_141 之後沒有獨立數量欄） */
  spec: string;
  /** 建議購買連結 */
  buy_link: string;
};

/** 新增採購需求時，一個項目要寫進 `purchase_demand_items` 的那一列。 */
export function newItemRow(i: DemandItemDraft, demandId: string) {
  return {
    demand_id: demandId,
    item_name: i.item_name.trim(),
    // ★ 空字串一律寫 null —— 「沒填」只能有一種形狀，
    //   不然查詢時要同時比 `is null` 與 `= ''`，而漏掉一種不會報錯
    spec: i.spec.trim() || null,
    buy_link: i.buy_link.trim() || null,
    purpose_type: i.purpose_type,
    /*
     * ★★ office 一定寫 null，不是空字串也不是留著上一次的物業。
     *   互斥約束（`pdi_purpose_one_of`）會擋，但擋下來的訊息看不懂 ——
     *   而且真正的傷害是「沒擋住」的那種寫法:報表照 estate_id 分組，
     *   一筆同時算進辦公室與那個物業，兩邊都對不上。
     */
    estate_id: estateIdToSave(i),
  };
}
