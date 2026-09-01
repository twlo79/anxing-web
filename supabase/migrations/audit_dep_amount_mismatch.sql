/*
 * audit_dep_amount_mismatch —— migration_194 自檢 ⑤ 的那 7 筆（唯讀）
 * ============================================================
 * 2026-09-01。194 的自檢 ⑤ 說有 7 筆「amount 與 lines 的台幣合計對不起來」。
 *
 * ★★★ 先講清楚:**很可能是我的檢查寫錯，不是資料壞了。**
 *
 *   `lib/deposit-lines.ts` 的 `depLines()` 有一條退路:
 *
 *     「舊資料（migration_87 之前）沒有 lines，
 *       退回用 currency + amount 組一筆 —— 不退回的話
 *       那些押金在畫面上會變成『沒有金額』。」
 *
 *   那種列的 `lines` 是空的，而我的 ⑤ 直接把 TWD 明細加總 → 得到 0，
 *   於是 0 ≠ amount，被判成不一致。**但畫面上它們是對的。**
 *
 * ★ 另外兩種也可能落在同一類:
 *     · 契約押金（走 sync_contract_deposits，不是這次改的那支）
 *     · 只有外幣的押金（amount 是台幣那部分 = 0，明細全在外幣）
 *
 * ★★ 這支把那 7 筆整個攤開，看完才知道是「檢查要修」還是「資料要修」。
 *   在分清楚之前**不要推程式，也不要動任何一筆押金**。
 *
 * 只有 select。執行後把結果整份貼回來。
 */

select
  left(d.id::text, 8)                                   as "押金 id",
  case when d.order_id is not null then '訂單'
       when d.contract_id is not null then '契約'
       else '（都沒有）' end                              as "來源",
  d.kind                                                as "種類",
  d.currency                                            as "幣別",
  d.amount                                              as "amount",
  coalesce((select sum((l->>'amt')::numeric)
              from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l
             where upper(l->>'cur') = 'TWD'), 0)        as "lines 的台幣合計",
  jsonb_typeof(d.lines)                                 as "lines 型別",
  coalesce(jsonb_array_length(
    case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end), 0)
                                                        as "明細筆數",
  d.lines                                               as "lines 原文",
  d.received_on                                         as "收款日",
  d.returned_on                                         as "退款日",
  d.orphaned                                            as "孤兒",
  d.created_at::date                                    as "建立日",
  /*
   * ★ 這一欄是**判斷用**的:
   *   「lines 是空的」→ 那是 depLines() 的退路，畫面正確，是我的檢查誤報
   *   「lines 有明細但數字對不上」→ 那才是真的要處理
   */
  case
    when coalesce(jsonb_array_length(
           case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end), 0) = 0
      then '✅ lines 是空的 —— depLines() 會退回用 amount，畫面正確（我的檢查誤報）'
    when not exists (select 1 from jsonb_array_elements(d.lines) l where upper(l->>'cur') = 'TWD')
      then '✅ 只有外幣 —— amount 是台幣那部分，本來就該是 0'
    else '⚠⚠ 有台幣明細但數字對不上 —— 這一筆要人工看'
  end                                                   as "★ 判斷"
from public.deposits d
where round(coalesce(d.amount, 0), 2) <> round((
        select coalesce(sum((l->>'amt')::numeric), 0)
          from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l
         where upper(l->>'cur') = 'TWD'), 2)
order by
  -- ★ 真的有問題的排最前面，不要讓它埋在正常的那幾筆中間
  case when coalesce(jsonb_array_length(
         case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end), 0) = 0
       then 2 else 1 end,
  d.created_at;
