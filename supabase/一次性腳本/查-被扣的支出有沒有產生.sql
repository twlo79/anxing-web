/*
 * 查-被扣的支出有沒有產生.sql　2026-09-18
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要查這個】
 *
 * 暫付收回時如果收回金額比付出去的少，差額是「被扣」——
 * 那是這個功能裡**唯一真的花掉錢**的一步，要記成一筆支出。
 * 前端 `validateRefund()` 會**擋住存檔**直到使用者選了會計科目：
 *
 *     沒收回的 2000 要記成支出 —— 請選會計科目
 *
 * 但 `deposits/advance-tab.tsx` 的 `saveInner()` 送出去的 payload 裡
 * **沒有 `forfeit_account_code`**，也沒有 insert 任何 expenses。
 * 所以那筆支出如果有產生，產生的人一定是資料庫（觸發器），
 * 而觸發器拿不到使用者選的科目。
 *
 * ★★★ 兩種可能，差很多:
 *   ① 有觸發器在做 → 支出有產生，但**科目不是使用者選的那個**
 *      （他每次都被逼著選一個不會被用到的值）
 *   ② 沒有人在做   → **那筆支出從來沒有產生過**，
 *      被扣的錢完全沒有進帳，而畫面上什麼都不會說
 *
 * 兩種都不是「正常」。這支腳本分辨是哪一種。
 *
 * ★ 我不猜 —— 手上這份工作區只有部分檔案（沒有 migration_196／202），
 *   而「憑印象判斷某個東西存不存在」正是 README 坑 G 那一條
 *   （2026-09-05 連錯三次）。
 * ══════════════════════════════════════════════════════════
 */

select * from (

  /*
   * ★★★ 母體要判定（README 二-1）——
   *   一筆「部分收回」都沒有的話，下面每一條都會自動成立。
   */
  select 1 as ord,
         '★★★ ① 有幾筆是「部分收回」（收回金額 < 付出去的）' as "檢查",
         (select count(*)::text || ' 筆'
            from public.advance_payments
           where refunded_on is not null
             and refunded_amount is not null
             and refunded_amount < amount) as "結果",
         case when (select count(*) from public.advance_payments
                     where refunded_on is not null
                       and refunded_amount is not null
                       and refunded_amount < amount) = 0
              then '⚠ 一筆都沒有 —— 下面全部不算數，這個功能還沒被用過'
              else '✅ 有東西可以檢查' end as "判定"

  union all
  /*
   * ★★★ 這一列是重點:被扣了，但沒有掛任何一筆支出。
   */
  select 2, '★★★ ② 其中有幾筆「沒有掛支出」（forfeit_expense_id 是空的）',
         (select count(*)::text || ' 筆'
            from public.advance_payments
           where refunded_on is not null
             and refunded_amount is not null
             and refunded_amount < amount
             and forfeit_expense_id is null),
         case when (select count(*) from public.advance_payments
                     where refunded_on is not null
                       and refunded_amount is not null
                       and refunded_amount < amount
                       and forfeit_expense_id is null) = 0
              then '✅ 每一筆被扣都有對應的支出'
              else '❌ 有被扣的錢沒有變成支出 —— 那些錢完全沒進帳' end

  union all
  /*
   * ★★ 被扣的總金額。②是 0 的時候這個數字就是「沒進帳的金額」。
   */
  select 3, '★★ ③ 沒掛支出的那幾筆，被扣掉的金額合計',
         coalesce((select to_char(sum(amount - refunded_amount), 'FM999,999,999')
                     from public.advance_payments
                    where refunded_on is not null
                      and refunded_amount is not null
                      and refunded_amount < amount
                      and forfeit_expense_id is null), '0'),
         'ℹ 參考 —— ✅／❌ 看上面那一列'

  union all
  /*
   * ★★★ advance_payments 上有哪些觸發器。
   *   ② 是 ✅ 的話，產生支出的就是這裡面某一支;
   *   ② 是 ❌ 而這一格是「（沒有）」的話，答案就是「沒有人在做」。
   */
  select 4, '★★★ ④ advance_payments 上的觸發器',
         coalesce((select string_agg(t.tgname, '、' order by t.tgname)
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname = 'advance_payments'
                      and not t.tgisinternal), '（沒有）'),
         'ℹ 參考 —— 把這一格連同②一起貼回對話'

  union all
  /*
   * ★ 有沒有 forfeit_account_code 這一欄。
   *   沒有的話就確定「使用者選的科目沒有存進資料庫」。
   */
  select 5, '⑤ advance_payments 有 forfeit_account_code 這一欄嗎',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'advance_payments'
                              and column_name = 'forfeit_account_code')
              then '有' else '沒有' end,
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'advance_payments'
                              and column_name = 'forfeit_account_code')
              then 'ℹ 有這一欄，但前端沒有送它 —— 值會是空的'
              else 'ℹ 沒有這一欄 —— 使用者選的科目確定沒有被存下來' end

  union all
  /*
   * ★★ 已經掛了支出的那幾筆，科目是什麼。
   *   全部都是同一個值（或空的）的話，就證明科目不是使用者選的。
   */
  select 6, '★★ ⑥ 已經掛了支出的那幾筆，支出的會計科目',
         coalesce((select string_agg(distinct coalesce(e.account_code, '（空的）'), '、')
                     from public.advance_payments a
                     join public.expenses e on e.id = a.forfeit_expense_id), '（一筆都沒有）'),
         'ℹ 參考 —— 只有一種值或都是空的，代表科目不是人選的'

) v(ord, "檢查", "結果", "判定") order by v.ord;
