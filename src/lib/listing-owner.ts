/**
 * 這個 Airbnb listing 編號目前掛在哪一間房上（含停用、含舊編號）。
 *
 * ============================================================
 * 【為什麼】（2026-08-24，listing 39687807 查了三輪才查出來）
 *
 * 同步差異頁上那一列說:
 *
 *     這個 listing 在系統裡沒有任何對照，訂單根本沒進來
 *
 * **那句話是錯的。** 實際查資料庫:
 *
 *     properties.airbnb_listing_id = '39687807' → 「舊-未知(7807)」（已停用）
 *
 * 它有對照 —— 只是對照到一個**停用**的房源。
 * 而防呆的判斷是「沒有對應到任何**啟用中的**房源」，兩者是不同的事:
 *
 *   沒有對照       → 要去建立對照，而「是哪一間房」要回 Airbnb 後台查
 *   對照到停用房源 → 房源就在眼前，決定是啟用它還是把 listing 搬到別間
 *
 * 第二種**答案已經在系統裡了**，只是畫面沒說。
 * 使用者為了一句不精確的訊息，跑了三輪查詢。
 *
 *
 * ============================================================
 * 【為什麼前端自己查，不等爬蟲】
 *
 * `sync_issues.extra` 有一個鍵叫「停用對照」，admin 頁也已經在讀它 ——
 * 那正是為這種情況設計的。但這一筆的 extra 是 `{}`，爬蟲沒填。
 *
 * 而 admin 頁**本來就載入了 properties 與 property_listings**
 * （房源管理那一區要用）。所以這件事前端算得出來，
 * 不必等爬蟲改、也不必多打一趟 API。
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX，寫在元件裡的判斷式測不到 ——
 * 而這一天已經有一個「條件永遠不成立卻毫無症狀」的教訓了。
 */

export type ListingOwner = {
  /** 房源名稱 */
  name: string;
  /** 房源是啟用中的嗎。false = 這就是「訂單進不來」的原因 */
  active: boolean;
  /** 從哪裡對到的 */
  via: '主編號' | '舊編號';
};

/*
 * ★ `active` 收 `boolean | null | undefined`。
 *
 *   資料庫是 `boolean not null default true`，所以實務上不會是 null ——
 *   但前端的 Property 型別寫得比較寬。收窄成 boolean 會讓呼叫端
 *   要自己轉，而**轉錯的方向不會報錯，只會讓畫面說反話**
 *   （停用的說成啟用中）。
 *
 *   這裡統一用 `!== false`:只有明確是 false 才算停用。
 *   跟資料庫的 `not null default true` 同一個方向。
 */
type Prop = {
  id: string; name: string;
  airbnb_listing_id: string | null;
  active?: boolean | null;
};
type Listing = { listing_id: string; property_id: string; is_current: boolean };

/**
 * @param listingId 差異那一列的 `listing_id`
 * @param properties admin 頁已經載入的房源（含停用）
 * @param listings   `property_listings` 舊編號對照表
 */
export function findListingOwner(
  listingId: string | null | undefined,
  properties: readonly Prop[],
  listings: readonly Listing[],
): ListingOwner | null {
  if (!listingId) return null;

  /*
   * ★ 先找主編號。`properties.airbnb_listing_id` 有唯一索引，
   *   所以最多一間 —— 找到就是它。
   */
  const main = properties.find((p) => p.airbnb_listing_id === listingId);
  if (main) return { name: main.name, active: main.active !== false, via: '主編號' };

  /*
   * 再找舊編號對照表。一間房可以掛好幾個編號
   * （Airbnb 重新上架會換新的，舊的訂單還是同一間房）。
   */
  const link = listings.find((l) => l.listing_id === listingId);
  if (link) {
    const p = properties.find((x) => x.id === link.property_id);
    if (p) return { name: p.name, active: p.active !== false, via: '舊編號' };
  }

  return null;
}

/**
 * 那一列該說什麼。
 *
 * ★ 三種狀態三句話 —— 因為**要做的事完全不同**:
 *
 *     對到停用房源 → 房源就在眼前，決定啟用還是搬走
 *     對到啟用房源 → 那訂單為什麼沒進來？是別的問題
 *     真的沒對照   → 只能回 Airbnb 後台查
 *
 *   混成一句「沒有對照」的話，第一種的人會去做第三種的事
 *   （回後台查一間其實已經在系統裡的房）。這正是這次發生的事。
 */
export function listingOwnerHint(owner: ListingOwner | null, listingId: string): string {
  if (!owner) {
    return `這個編號在系統裡沒有任何房源掛著（主編號與舊編號都查過了）`
      + `—— 要拿 ${listingId} 回 Airbnb 後台查是哪一間房。`;
  }
  if (!owner.active) {
    return `★ 這個編號掛在「${owner.name}」上（${owner.via}），但那間房**已停用** ——`
      + `所以訂單對不到「啟用中的房源」。`
      + `要嘛到房源管理把它啟用，要嘛把這個編號搬到正確的房源上。`;
  }
  return `這個編號掛在「${owner.name}」上（${owner.via}），而且是啟用中的 ——`
    + `訂單沒進來的原因不在對照表，要往別的方向查。`;
}
