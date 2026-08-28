-- migration_163：其他事業體的會計科目由人選，不要被自動覆寫
--
-- ============================================================
-- 【不跑這支的話會怎樣】
--
-- **愛皮洪鯊的收入完全存不進去。**
--
-- `sync_order_account()`（migration_91）在每次寫入時**一律覆寫**科目:
--
--     new.account_code := order_account_code(new.source, new.fee_type);
--
-- 而 `order_account_code('other_biz', …)` 走 else 分支 → `'rent_income'`。
--
-- 於是:
--   1. 使用者選「團費收入」
--   2. 觸發器改成「租金收入」
--   3. migration_162 的防線發現「rent_income 屬於安幸、這筆是愛皮的帳」
--   4. **raise exception，存不進去**
--
--
-- ============================================================
-- 【為什麼安幸要自動覆寫、其他事業體不要】
--
-- migration_91 的註解寫著:
--
--     「一律覆寫，不保留手動值。使用者明確說『收入不用選的就自動填』，
--       所以不存在『手動指定』這件事。」
--
-- 那對安幸成立 —— 收入不是房租就是那八種一次性費用，算得出來。
--
-- **對愛皮洪鯊不成立。** 投資公司的「股利收入」與「處分投資利益」
-- 從 source / fee_type 推不出來，只有填單的人知道。
-- 所以那邊必須是手選的。
--
-- ★ 改的是**條件**，不是那句覆寫。安幸的行為一個字都沒變。
--
--
-- ============================================================
-- 【為什麼不改 order_account_code() 本身】
--
-- 那支是營收報表的分組依據，動一行就會讓某個科目的歷史數字整批位移
-- （migration_148 的註解也寫著同一句）。
--
-- 而且它是 `immutable` 的純函式 —— 讓它去查 account_codes 表
-- 就不再是純函式了，那會影響它能不能被索引使用。
-- ============================================================

create or replace function public.sync_order_account()
returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
begin
  /*
   * ★★ 其他事業體的科目是**人選的**，不要碰（migration_163）。
   *
   * 這裡直接 return 而不是算完再判斷 ——
   * 算了再丟掉的話，下一個人會以為那個算式對這條路也有效。
   */
  if coalesce(new.book, 'anxing') <> 'anxing' then
    return new;
  end if;

  -- 安幸:一律覆寫，不保留手動值（migration_91 的原始行為，一個字沒變）
  new.account_code := public.order_account_code(new.source, new.fee_type);
  return new;
end $fn$;


/*
 * ★ 觸發器的執行順序。
 *
 * Postgres 的 BEFORE 觸發器**按名字的字母順序**跑。
 * `sync_order_account` 要在 `trg_orders_book_code`（162 建的防線）**之前**跑，
 * 不然防線看到的是還沒被覆寫的舊值。
 *
 *   sync_order_account 的觸發器叫 trg_orders_account
 *   防線叫             trg_orders_book_code
 *
 *   'trg_orders_account' < 'trg_orders_book_code'   ✅ 順序正確
 *
 * 這是巧合不是設計 —— 所以寫下來。哪天有人改名字要重新確認一次。
 */


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('163_account_code_skip_other_books');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 其他事業體不再被覆寫' as "檢查項目",
         case when pg_get_functiondef(p.oid) like '%migration_163%' then '✅' else '❌' end as "結果",
         '不改的話愛皮洪鯊的收入完全存不進去' as "說明"
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_order_account'

  union all
  /*
   * ★★ 安幸那條路一個字都不能變。
   *   少了那句覆寫的話，安幸的收入會留著前端傳來的值 ——
   *   而營收報表按科目分組時那些值多半是 null，整批掉進「未分類」。
   */
  select 2, '★★ 安幸仍然自動填科目',
         case when pg_get_functiondef(p.oid) like '%order_account_code(new.source, new.fee_type)%'
              then '✅' else '❌ 那句覆寫被弄丟了' end,
         '安幸的行為完全沒變'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_order_account'

  union all
  /*
   * ★ 觸發器順序:覆寫要在防線之前。
   *   Postgres 的 BEFORE 觸發器按名字字母序跑。
   */
  select 3, '★ 觸發器順序',
         string_agg(t.tgname, ' → ' order by t.tgname),
         case when 'trg_orders_account' < 'trg_orders_book_code'
              then '✅ 覆寫在防線之前' else '❌ 順序反了' end
    from pg_trigger t
   where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
     and t.tgname in ('trg_orders_account', 'trg_orders_book_code')

  union all
  /*
   * ★★ 既有訂單的科目一筆都不能變。
   *   ⚠ 跑之前先記下這四個數字。
   */
  select 4, '★★ 既有訂單的科目分佈',
         string_agg(x.account_code || ' ' || x.n, '、' order by x.n desc),
         '★ 跟跑之前對照，必須一模一樣'
    from (select account_code, count(*) as n from public.orders
           where book = 'anxing' group by account_code order by count(*) desc limit 4) x

) v order by ord;
