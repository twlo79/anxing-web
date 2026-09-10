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
  /**
   * 產品規格（2026-09-10 使用者指定必填）。
   *
   * ★★ 以前叫「規格說明／大概數量」，一個框裝兩件事 ——
   *   於是有人只寫規格、有人只寫數量，會計兩種都要猜。
   *   現在拆成 `spec` 與 `qty` 兩欄，各自必填。
   */
  spec: string;
  /**
   * 需要數量（2026-09-10 新增，必填）。
   *
   * ★★★ **是文字不是數字**。提需求的當下講的是「兩箱」「5 支」「一組」——
   *   逼成數字欄的話，「一箱」只能填 1，而那個 1 是假的:
   *   會計看到 1 會買一支。
   *
   * ★ 代價:加不起來。可以接受 —— 這一欄從來沒有人加總，
   *   真正要算錢的是請款單那邊，那裡才有單價與數量。
   */
  qty: string;
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
  return !!(i.item_name.trim() || i.estate_id || i.purpose_type === 'office'
    // ★ 2026-09-10 規格與數量也要算進來。漏掉的話「只打了規格」那一列
    //   會被當成空白列丟掉 —— 跟上面 office 那條是同一個坑。
    || i.spec?.trim() || i.qty?.trim());
}

/**
 * 這一列**還缺哪幾欄**。回空陣列＝填完了。
 *
 * ★★★ 訊息要講**缺什麼**，不是「沒填完」。
 *   四個欄位的一列，只說「沒填完」等於叫人自己一格一格看。
 *
 * ★ 順序照畫面上的順序 —— 使用者照著找的時候是由左到右。
 */
export function missingLabels(i: DemandItemLike): string[] {
  const out: string[] = [];
  if (!i.item_name.trim()) out.push('品名');
  if (i.purpose_type !== 'office' && !i.estate_id) out.push('用途');
  if (!i.spec?.trim()) out.push('產品規格');
  if (!i.qty?.trim()) out.push('需要數量');
  return out;
}

/**
 * 這一列填完整了沒。
 *
 * ★ office **不用**選物業 —— 它本來就不是物業。
 *   沿用舊的 `!i.estate_id` 判斷的話，選了辦公室永遠過不了。
 */
export function isComplete(i: DemandItemLike): boolean {
  // ★ 跟 missingLabels 同一份判斷 —— 兩邊各寫一次的話，
  //   遲早出現「送得出去但訊息說還缺一欄」那種矛盾畫面
  return missingLabels(i).length === 0;
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
  // ★ 2026-09-10 改成講出缺的那幾欄（原本固定寫「品名與用途」，
  //   而欄位變成四個之後那句話會說謊）
  if (bad >= 0) return `第 ${bad + 1} 項還沒填：${missingLabels(filled[bad]).join('、')}`;

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
  /**
   * 備註 —— 採購地點或連結（2026-09-10 使用者改的標題）。
   *
   * ★ 欄位名還是 `buy_link`，因為資料庫那一欄叫這個名字。
   *   為了改一個標題去改欄位名，要動 migration、觸發器、
   *   拆單的抄欄位清單…… 而換來的只是名字好看一點。
   *   ★★ 標題與欄位名不同的時候，**顯示端寫一次註解說清楚**就夠了。
   */
  buy_link: string;
};

/**
 * 把貼進來的購買連結補成完整網址。
 *
 * ============================================================
 * 【★★★ 為什麼一定要補】（2026-09-09）
 *
 * 使用者從網址列複製常常帶不到 `https://`（`www.momoshop.com.tw/...`）。
 * 那樣的字串放進 `<a href>`，瀏覽器會當成**相對路徑** ——
 * 點下去跳到 `justwork.estia.com.tw/www.momoshop.com.tw/...`。
 *
 * ★★ 症狀是「按了沒反應」或跳到一個 404，而**連結看起來是好的**:
 *   藍色、有底線、滑鼠變成手。沒有任何東西說它壞了。
 *
 * ★ 補在**存檔**的時候，不是顯示的時候 —— 顯示端補的話,
 *   資料庫裡留下的還是壞的，匯出、複製給廠商時一樣不能用。
 *
 * ============================================================
 * 【不猜的那幾種】
 *
 *   已經有 http:// 或 https://  → 原樣
 *   `//example.com`             → 補 `https:`
 *   看起來不像網址（沒有點）      → **原樣留著**，不要硬補
 *     ★ 有人可能貼的是店名或料號。補成 `https://某某五金行`
 *       只會產生一個一定連不上的連結，而那比沒有連結更難查。
 */
export function normalizeUrl(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return 'https:' + t;
  // ★ 沒有點的一律不補 —— 那多半不是網址
  return /\./.test(t) && !/\s/.test(t) ? 'https://' + t : t;
}

/**
 * 這個值**點得下去嗎**。
 *
 * ★★★ 顯示端一定要問這一句。2026-09-09 線上就有一筆
 *   `DM-202609-004` 的「連結」是**「酷彭」**（店名）——
 *   而畫面把它畫成一個藍色有底線、滑鼠變手的「建議連結」，
 *   點下去什麼都不會發生。
 *
 * ★★ 那不是使用者填錯:「哪裡買」本來就可能是店名。
 *   錯的是畫面**假裝它是連結**。
 */
export function isUrl(v: string | null | undefined): boolean {
  return /^https?:\/\//i.test((v ?? '').trim());
}

/** 新增採購需求時，一個項目要寫進 `purchase_demand_items` 的那一列。 */
export function newItemRow(i: DemandItemDraft, demandId: string) {
  return {
    demand_id: demandId,
    item_name: i.item_name.trim(),
    // ★ 空字串一律寫 null —— 「沒填」只能有一種形狀，
    //   不然查詢時要同時比 `is null` 與 `= ''`，而漏掉一種不會報錯
    spec: i.spec.trim() || null,
    /*
     * ★★★ 2026-09-10 新增。加一欄的時候，**三個地方**都要跟著加:
     *   ① 這裡（寫進去）② `SPLIT_INHERITED`（拆單時抄過去）
     *   ③ 讀取的 select 欄位清單
     *   —— 少了任何一個都不會報錯，只會安靜地變成空的
     *   （`buy_link` 就是這樣少了半年，見上面那段）。
     */
    qty: i.qty.trim() || null,
    // ★ 補成完整網址 —— 少了 https:// 的會被當成相對路徑（見 normalizeUrl）
    buy_link: normalizeUrl(i.buy_link),
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
