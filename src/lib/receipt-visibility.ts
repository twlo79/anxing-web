/**
 * 誰看得到請款單的憑證圖片。
 *
 * ============================================================
 * 【為什麼需要這支】（2026-08-24，migration_170 的實測結果）
 *
 * 假扮各角色查同一張請款單的憑證圖，數回幾列:
 *
 *     會計 accountant    ✅ 1 / 1
 *     主管 manager       ✅ 1 / 1
 *     總經理 super_admin ✅ 1 / 1
 *     管家 housekeeper   ❌ 0 / 1
 *
 * 管家看不到 —— 而那是**設計如此**，不是 bug。
 * `can_see_receipt(p_path)` 的 else 分支是:
 *
 *     exists (select 1 from attachments a
 *               join purchase_requests p on p.id = a.request_id
 *              where a.path = p_path and p.requester_id = auth.uid())
 *                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^
 *     只看得到「自己送的單」底下的附件
 *
 *
 * ============================================================
 * 【不寫這支的話會發生什麼 —— 畫面會說謊】
 *
 * 請款單抽屜上有一句提示:
 *
 *     「還沒上傳共同憑證圖片」
 *
 * 它的條件是 `sharedImgs.length === 0`。但對管家來說，
 * **圖傳了、他只是看不到**，`sharedImgs` 一樣是空的。
 * 於是畫面告訴他「還沒上傳」——
 * 然後他會去催一個已經把發票傳好的人。
 *
 * 「沒有東西」與「你看不到」是兩件事，畫面上不能長一樣。
 * 這跟 lib/profile.tsx 的「還在查 vs 查完了沒有角色」是同一條原則。
 *
 *
 * ============================================================
 * 【這不是安全機制】
 *
 * 真正的把關是 `can_see_receipt()` 這條 RLS。
 * 這支存在的唯一理由是**不要讓畫面講出不成立的話**。
 * 所以它必須跟那支 SQL 一致 —— 不一致的兩種後果:
 *
 *   前端比 RLS 寬 → 畫面說「有 3 張圖」，實際上一張都載不到
 *   前端比 RLS 窄 → 明明看得到卻被畫面藏起來
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX，寫在元件裡的判斷式測不到。
 */

/**
 * 不管單是誰送的，都看得到憑證圖的角色。
 *
 * ★ 必須跟 `can_see_receipt()` 第一個 when 分支一模一樣。
 *   `housekeeper` **不在裡面** —— 它在 SQL 裡另有一條
 *   `p_path like 'op/%'` 的分支，那是**訂單的收款證明**，
 *   跟請款單的 `pr/` 沒有關係（migration_154）。
 */
export const RECEIPT_ALL_ROLES = ['accountant', 'manager', 'super_admin'] as const;

/**
 * 這個人看不看得到這張請款單的憑證圖。
 *
 * @param role   profiles.role
 * @param isMine 這張單是不是他自己送的（requester_id === 我）
 */
export function canSeeRequestReceipt(
  role: string | null | undefined, isMine: boolean | null | undefined,
): boolean {
  // 角色還沒載入 —— 先當作看不到,那時候不要下任何結論
  if (!role) return false;
  if ((RECEIPT_ALL_ROLES as readonly string[]).includes(role)) return true;
  return !!isMine;
}

/**
 * 憑證圖片區底下該說哪一句話。
 *
 * 回 null 表示不用說話（有圖，圖自己會顯示）。
 *
 * ★ 三種狀態要講三句不同的話:
 *     有圖         → 不說話
 *     沒圖、看得到 → 「還沒上傳」——這是真的，可以去催
 *     沒圖、看不到 → 「你沒有權限看」——**不能說還沒上傳**
 */
export function receiptHint(
  role: string | null | undefined, isMine: boolean | null | undefined, imageCount: number,
): string | null {
  if (imageCount > 0) return null;
  return canSeeRequestReceipt(role, isMine)
    ? '還沒上傳共同憑證圖片'
    : '憑證圖片只有會計以上、或送單的人看得到。';
}
