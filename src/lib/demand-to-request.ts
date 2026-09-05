/**
 * 採購需求 → 請款單（純函式）。
 *
 * ============================================================
 * 【為什麼這條路一直沒接上】（2026-09-05 查出來的）
 *
 * `migration_140` 把資料庫那一半做完了 —— 關聯欄位、單頭狀態的
 * 自動彙總、已請款的項目鎖住、請款單被駁回時自動退回。
 *
 * **但前端沒有任何一行程式會把 `status` 寫成 `'requested'`。**
 * `purchase_demand_items` 只有 INSERT，沒有 UPDATE；
 * 請款單頁完全沒有讀 `purchase_demands`。
 *
 * 結果:需求單永遠停在「尚未採購」，而資料庫查出來
 * 一共只有 1 筆項目、狀態 `pending` —— 這條路從來沒有被走過。
 *
 * 這一支補的就是中間那一段。
 *
 * ============================================================
 * 【★★★ 金額用 null 不是 0】
 *
 * 帶進請款單的當下**還不知道金額** —— 要先詢價。
 *
 * 而 0 在請款單上是一個合法的值（贈品、換貨、對方吸收），
 * 畫面上「0」跟「還沒填」長得一模一樣。拿 0 當「待填」的話:
 * 送審時擋不住、兩層核可都不會發現、付款出去少一筆錢。
 *
 * 所以 `amount` 帶 `null`（migration_218 把 not null 拿掉了），
 * 畫面顯示「待填」，**送審時逐項擋**、草稿不擋。
 */

export type DemandItemStatus = 'pending' | 'quoted' | 'requested' | 'done' | 'cancelled';

/** 需求項目（只取帶得過去的欄位）。 */
export type DemandItemSrc = {
  id: string;
  item_name: string;
  spec?: string | null;
  purpose_type: 'estate' | 'office';
  estate_id?: string | null;
  status: DemandItemStatus;
  request_item_id?: string | null;
};

/** 請款項目（要建出來的那一列）。 */
export type RequestItemDraft = {
  item_name: string;
  /** ★★★ null = 還沒填。**不是 0** —— 見檔頭 */
  amount: number | null;
  purpose_type: 'estate' | 'office';
  estate_id: string | null;
  note: string | null;
  sort: number;
  /** 從哪一個需求項目來的。存檔後要拿它回寫 `request_item_id` */
  fromDemandItemId: string;
};

/**
 * 哪些項目**還可以**被帶進請款單。
 *
 * ★★ `requested` 與 `done` 已經被領走了 —— 再帶一次會變成兩張請款單
 *   同時在請同一筆錢，而總額只是「比較大」。
 * ★ `cancelled` 是人決定不買的，不該再冒出來。
 */
export const isTakeable = (s: DemandItemStatus) => s === 'pending' || s === 'quoted';

export const takeableItems = <T extends { status: DemandItemStatus }>(items: T[]): T[] =>
  (items ?? []).filter((i) => isTakeable(i.status));

/**
 * 需求項目 → 請款項目。
 *
 * ★ 規格（`spec`）寫進**備註**不是品名。
 *   併進品名的話「衛生紙*1箱 大包裝」會被當成一個品項名稱，
 *   而請款單的品名是要印在單子上給人核的。
 *
 * ★★ `office` 的 `estate_id` 一律 null —— 安幸辦公室不是物業，
 *   資料庫有互斥約束擋著（`pdi_purpose_one_of`）。
 *   帶著上一次選的物業過去會被擋，而錯誤訊息看不懂。
 *
 * @param startSort 已經有幾列請款項目（接在後面）
 */
export function toRequestItems(
  items: DemandItemSrc[], startSort = 0,
): RequestItemDraft[] {
  return takeableItems(items ?? []).map((i, n) => ({
    item_name: (i.item_name ?? '').trim(),
    amount: null,
    purpose_type: i.purpose_type,
    estate_id: i.purpose_type === 'office' ? null : (i.estate_id || null),
    note: (i.spec ?? '').trim() || null,
    sort: startSort + n,
    fromDemandItemId: i.id,
  }));
}

/**
 * 送審前檢查：有沒有項目還沒填金額。
 *
 * ============================================================
 * 【★★★ 為什麼是「送審擋」不是「存檔擋」】
 *
 * 草稿的用途就是「先開起來，金額之後補」——
 * 存檔就擋的話這整條路走不通。
 *
 * 而送審是「請你們核可付這些錢」，金額是空的就不成立。
 *
 * ★ 回傳品名而不是筆數。「有 2 項沒填金額」要人自己在
 *   十幾列裡找，而回名字他一眼就看得到是哪兩項。
 */
export function unpricedNames(
  items: { item_name: string; amount: number | null | undefined }[],
): string[] {
  return (items ?? [])
    .filter((i) => i.amount == null)
    .map((i) => (i.item_name ?? '').trim() || '（沒填品名）');
}

/** 送審擋阻的訊息。`null` = 可以送。 */
export function submitBlockedBy(
  items: { item_name: string; amount: number | null | undefined }[],
): string | null {
  const names = unpricedNames(items);
  if (!names.length) return null;
  const head = names.slice(0, 5).join('、');
  return `這 ${names.length} 項還沒填金額，送審之前要填：${head}`
       + (names.length > 5 ? ` 等 ${names.length} 項` : '')
       + '\n\n★ 真的是 0 元（贈品、換貨）請直接填 0 —— 那跟「還沒填」不一樣。';
}

/**
 * 一張請款單的合計。
 *
 * ★★ **還沒填的那幾項不算進去，而且要講**。
 *   把 null 當 0 加總的話，合計看起來是一個完整的數字 ——
 *   而它少了還沒填的那幾筆，沒有人會發現。
 */
export function requestTotal(
  items: { amount: number | null | undefined }[],
): { total: number; unpriced: number } {
  const xs = items ?? [];
  return {
    total: xs.reduce((a, i) => a + (i.amount == null ? 0 : Number(i.amount) || 0), 0),
    unpriced: xs.filter((i) => i.amount == null).length,
  };
}

/** 合計要顯示的字。★ 有待填的就講出來，不要只印一個數字。 */
export function totalText(
  items: { amount: number | null | undefined }[],
): string {
  const { total, unpriced } = requestTotal(items);
  const money = `$${total.toLocaleString('en-US')}`;
  return unpriced ? `${money}（另有 ${unpriced} 項待填）` : money;
}

/**
 * 存完請款單之後，要把哪幾個需求項目改成 `requested`。
 *
 * ★★★ 回「計畫」而不是直接寫資料庫 —— 這樣測得到，
 *   而且呼叫端可以檢查影響列數（RLS 擋下的 UPDATE 回成功且 0 列）。
 *
 * @param drafts 送出去的那批（帶著 `fromDemandItemId`）
 * @param savedIds 資料庫回傳的請款項目 id，順序跟 drafts 一致
 */
export function linkBackPlan(
  drafts: RequestItemDraft[], savedIds: string[],
): { demandItemId: string; requestItemId: string }[] {
  const out: { demandItemId: string; requestItemId: string }[] = [];
  const n = Math.min((drafts ?? []).length, (savedIds ?? []).length);
  for (let i = 0; i < n; i++) {
    if (!drafts[i].fromDemandItemId || !savedIds[i]) continue;
    out.push({ demandItemId: drafts[i].fromDemandItemId, requestItemId: savedIds[i] });
  }
  return out;
}

/**
 * 「標為已採購」能不能按（零用金直接買的那條路）。
 *
 * ★★ 已經進請款的**不給按** —— 那條路的完成要跟著請款單走，
 *   手動標成 `done` 的話請款單付款時會對不起來，
 *   而畫面上兩邊都顯示「已完成」，看不出是哪一條路走完的。
 */
export function canMarkDone(i: { status: DemandItemStatus }): boolean {
  return i.status === 'pending' || i.status === 'quoted';
}

/** 「標為已採購」的確認訊息。★ 要講清楚這條路**不會**產生請款單。 */
export function markDoneConfirm(names: string[]): string {
  return `把這 ${names.length} 項標成已採購？\n\n`
    + names.slice(0, 8).map((n) => `　• ${n}`).join('\n')
    + (names.length > 8 ? `\n　⋯ 等 ${names.length} 項` : '')
    + '\n\n★ 這條路**不會**產生請款單 —— 給零用金直接買的情況用。\n'
    + '　 要走請款流程請改按「建請款單」。';
}
