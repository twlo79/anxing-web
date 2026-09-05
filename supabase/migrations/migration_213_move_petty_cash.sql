-- ============================================================
-- migration_213：把 2026-08-05 的零用金撥補 30,000 從支出搬到暫付
--
-- 【為什麼要一支 migration 而不是手點】
-- 「新增暫付」與「刪掉支出」是**兩個動作**。中間斷掉的話:
--   先建再刪 → 重複計 30,000（看得到，會有人問）
--   先刪再建 → 錢憑空消失（看不到，沒有人會發現）
--
-- 手點只能選一種順序，而兩種都有失敗窗口。
-- 這一支把兩件事包在**同一個交易**裡 —— 要嘛都成，要嘛都不動。
--
-- 【為什麼零用金是暫付不是支出】
-- 錢交給 Cindy 的當下還沒花掉，那是**放在她那裡的資產**。
-- 她拿去買東西才是費用。跟押金、保證金同一種性質。
--
-- ★★★ **這一支只搬這一筆**（2026-09-03 使用者選「只搬這一筆」）。
--   不掃「所有零用金科目的支出」—— 那會連到別的月份、別的情境，
--   而我沒有看過那些列。「對不上的不猜」（CLAUDE.md）。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

do $do$
declare
  e record;
  n int;
  new_id uuid;
begin
  -- ── 1. 先確認**剛好一筆** ────────────────────────────────
  -- ★★★ 不是 1 就中止。0 筆代表已經搬過（或條件寫錯），
  --   2 筆以上代表我認錯了東西 —— 兩種都不該硬做下去。
  select count(*) into n
    from public.expenses
   where spent_on = date '2026-08-05'
     and round(amount, 2) = 30000
     and item_name like '%零用金撥補%';

  if n = 0 then
    raise notice '找不到那筆支出 —— 可能已經搬過了。這一支不做事。';
    return;
  elsif n > 1 then
    raise exception '符合條件的支出有 % 筆，不是 1 筆 —— 中止，先確認是哪一筆再說', n;
  end if;

  select * into e
    from public.expenses
   where spent_on = date '2026-08-05'
     and round(amount, 2) = 30000
     and item_name like '%零用金撥補%';

  -- ── 2. 建暫付 ────────────────────────────────────────────
  /*
   * ★ purpose_type = 'office'、estate_id = null（migration_212）。
   *   安幸辦公室不是物業，兩個欄位要一起寫才不會自相矛盾。
   * ★★ note 寫下它的來歷。三個月後看到這筆 30,000 的人
   *   要查得到它本來是哪一列支出 —— 而那列已經被這支刪掉了。
   */
  insert into public.advance_payments
    (category, counterparty, usage, purpose_type, estate_id,
     amount, paid_on, paid_account, note)
  values
    ('零用金', 'Cindy', '零用金撥補', 'office', null,
     e.amount, e.spent_on, e.pay_account,
     'migration_213 從支出搬過來（原支出 id ' || e.id::text
     || '、憑證 ' || coalesce(e.voucher_no, '無') || '）。'
     || '零用金是先把錢交給人，花掉才是費用 —— 屬於暫付不是支出。')
  returning id into new_id;

  -- ── 3. 刪掉原支出 ────────────────────────────────────────
  /*
   * ★ 真的刪，不是標記。留著的話那 30,000 會被**算兩次**
   *   （支出一次、暫付一次），而總額看起來只是「比較大」。
   * ★★ `data_audit`（migration_72）會記下這次刪除，
   *   所以刪掉不等於查不到 —— 這正是那張表存在的理由。
   */
  delete from public.expenses where id = e.id;

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '刪除影響 % 列（預期 1）—— 中止，整份回滾', n;
  end if;

  raise notice '搬完:暫付 % 建立，原支出 % 已刪', new_id, e.id;
end $do$;

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('213_move_petty_cash');
  end if;
end $$;

commit;

-- ============================================================
-- 自檢
-- ★ 母體要判定 —— 這一支的成敗就是「暫付那一筆在不在」。
-- ============================================================
select '1. 暫付裡有沒有這筆零用金' as 檢查,
       coalesce((select counterparty || '・' || usage || '・' || amount::text
                   from public.advance_payments
                  where category = '零用金' and paid_on = date '2026-08-05'
                    and round(amount, 2) = 30000), '（沒有）') as 結果,
       case when exists (select 1 from public.advance_payments
                          where category = '零用金' and paid_on = date '2026-08-05'
                            and round(amount, 2) = 30000)
            then '✅ 搬進來了' else '❌ 沒建成功，下面兩列不用看' end as 判定

union all
-- ★★ 支出那邊一定要不見了。兩邊都在 = 這 30,000 被算兩次
select '2. 支出那邊還在不在（要不在）',
       (select count(*)::text from public.expenses
         where spent_on = date '2026-08-05'
           and round(amount, 2) = 30000
           and item_name like '%零用金撥補%'),
       case when (select count(*) from public.expenses
                   where spent_on = date '2026-08-05'
                     and round(amount, 2) = 30000
                     and item_name like '%零用金撥補%') = 0
            then '✅ 已經刪掉，不會重複計'
            else '❌ 兩邊都在 —— 這 30,000 被算兩次了' end

union all
-- ★ 用途要是 office 而且沒掛物業（ap_purpose_chk 會擋，但問一次）
select '3. 用途是不是安幸辦公室',
       coalesce((select purpose_type || ' / estate_id ' ||
                        coalesce(estate_id::text, 'null')
                   from public.advance_payments
                  where category = '零用金' and paid_on = date '2026-08-05'), '—'),
       case when exists (select 1 from public.advance_payments
                          where category = '零用金' and paid_on = date '2026-08-05'
                            and purpose_type = 'office' and estate_id is null)
            then '✅' else '❌ 用途不對' end

union all
/*
 * ★★ 刪除有沒有留下軌跡。錢的紀錄被刪一定要查得到（migration_72）。
 *
 * ★★★ 這一條原本寫成「最近十分鐘有沒有 expenses 的刪除」，那是錯的
 *   （2026-09-05 抓到）。兩個毛病：
 *
 *   ① 它問的是「**這次跑**做了什麼」，而這支是冪等的 ——
 *      第二次跑會走「找不到那筆支出，不做事」直接 return，
 *      於是這一格變成 0，看起來像稽核壞了。實際上 213 早在 09-03
 *      就跑過，紀錄好端端地在。我花了兩輪查詢在追一個不存在的 bug。
 *   ② 「十分鐘內」會隨時間過期。一個會自己變成紅字的檢查等於沒有檢查。
 *
 *   自檢要問「**結果對不對**」，不是「這次跑發生了什麼」
 *   （CLAUDE.md：自檢的基準值依賴這支正在改的東西）。
 *
 * ★ `user_id` 是 null 很正常 —— 從 SQL Editor 跑的沒有登入者。
 *   `data_audit_log()` 的 DELETE 與 INSERT 分支照記，
 *   只有 UPDATE 那一段會在 uid 為 null 時跳過。
 */
select '4. 那一筆的刪除有沒有被記到',
       coalesce((select label || '｜刪於 ' || at::date::text
                   from public.data_audit
                  where table_name = 'expenses' and action = 'delete'
                    and label like '%零用金撥補%'
                  order by at desc limit 1), '（沒有這筆刪除紀錄）'),
       case when exists (select 1 from public.data_audit
                          where table_name = 'expenses' and action = 'delete'
                            and label like '%零用金撥補%')
            then '✅ 查得到那筆 30,000 是什麼時候被誰刪的'
            else '❌ 沒有軌跡 —— data_audit 的觸發器可能沒掛上' end

union all
select '5. 這一支有沒有被記錄',
       coalesce((select max(name) from public.schema_migrations
                  where name = '213_move_petty_cash'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations
                          where name = '213_move_petty_cash')
            then '✅' else '❌ record_migration 沒寫進去' end;
