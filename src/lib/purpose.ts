/*
 * 「這筆收入算誰的」—— 契約層級的規則（migration_247）。
 *
 * ★★★ 安幸辦公室**不是一棟樓，是契約／訂單上的一個標記**。
 *
 *   契約照樣選物業（正隆）、照樣選房源（B01）—— 那間房本來就是正隆的，
 *   從頭到尾沒有搬過、也沒有被複製。勾這一格只改一件事:
 *   **這筆錢在營收報表上算誰的。**
 *
 *   做成「物業下拉裡多一個安幸辦公室」的話就得二選一，
 *   選了安幸辦公室就選不了正隆，房源也跟著沒有著落。
 *   而這裡要的是**兩個都留著**。
 *
 * ★★ 這個檔案是**畫面版的規則**，資料庫那一份在 migration_247 的
 *   `contract_purpose_normalize()`。兩邊必須一模一樣 ——
 *   不一樣的話畫面顯示沒勾、資料庫存的是 office，
 *   而使用者看到的是「我明明沒勾」。
 */

export type Purpose = 'estate' | 'office' | 'other_biz';

/**
 * 這兩種契約類別**本來就是安幸自己的生意**，不是幫股東收的房租，
 * 所以用途一定是 office，勾不勾都一樣。
 *
 * 值對應契約頁的 TYPE_LABEL：office＝辦公室、company＝公司登記。
 */
export const TYPE_ALWAYS_OFFICE = ['office', 'company'];

/** 契約類別是不是「一定屬安幸辦公室」的那兩種 */
export const purposeLockedByType = (type: string | null | undefined) =>
  TYPE_ALWAYS_OFFICE.includes(type ?? '');

/**
 * 這張契約的用途。**存檔與畫面都走這一支** ——
 * 兩邊各算一次的話，勾選框顯示的跟存進去的會不一樣。
 */
export function contractPurpose(
  c: { type?: string | null; purpose_type?: string | null },
): Purpose {
  if (purposeLockedByType(c.type)) return 'office';
  return c.purpose_type === 'office' ? 'office' : 'estate';
}

/** 勾選框現在是不是勾著的 */
export const isOfficePurpose = (
  c: { type?: string | null; purpose_type?: string | null },
) => contractPurpose(c) === 'office';
