-- migration_162：訂單直接存會計科目（給其他收支帳用）
--
-- ============================================================
-- 【為什麼需要】
--
-- 安幸的訂單沒有 `account_code` 欄位 —— 科目是**算出來的**:
--
--     order_account_code(source, fee_type)
--       oneoff ＋ '清潔費'  →  'cleaning'
--       其餘                →  'rent_income'
--
-- 那套對安幸成立（收入不是房租就是那八種一次性費用），
-- 但對愛皮洪鯊完全不成立:「股利收入」「團費收入」不在那份對照表裡，
-- 而 `else` 分支會把它們**全部算成租金收入**。
--
--
-- ============================================================
-- 【為什麼不改 order_account_code()】
--
-- 那支函式是**營收報表的分組依據**。動它一行就會讓某個科目的
-- 歷史數字整批位移（migration_148 的註解也寫著同一句）。
--
-- 而且改了也不對:愛皮的科目有 19 個、洪鯊 15 個，
-- 把 34 個 case 塞進一支給安幸用的對照函式，
-- 下一個看的人會以為安幸也用得到那些。
--
--
-- ============================================================
-- 【為什麼不借用 fee_type】
--
-- `fee_type` 存的是**中文名目**（'清潔費'、'管理費'）。
-- 塞 'ap_tour' 進去的話同一欄有兩種格式，
-- 而任何一支照 fee_type 分組的查詢都會看到一半中文一半代號。
--
-- 一個新欄位比較誠實。安幸的訂單一律留 null，行為完全不變。
-- ============================================================

alter table public.orders
  add column if not exists account_code text
    references public.account_codes(code) on update cascade;

/*
 * on update cascade:科目代號改名時訂單跟著走。
 * 沒有的話改代號會讓那批訂單指到一個不存在的科目 ——
 * 而 join 不到的那些在報表上會變成「未分類」，不報錯。
 */

create index if not exists orders_account_code_idx
  on public.orders(account_code) where account_code is not null;

comment on column public.orders.account_code is
  '會計科目。**只有其他收支帳（book <> anxing）用**（migration_162）。'
  '安幸的訂單一律 null —— 它的科目由 order_account_code(source, fee_type) 算出來。';


/*
 * ★ 科目要跟帳本對得起來。
 *
 * 愛皮的訂單掛洪鯊的科目的話，儀錶板的「by 科目」會出現
 * 一個那家公司根本沒有的科目 —— 而金額是對的，只有分類錯，
 * 所以不會有人發現。
 */
create or replace function public.orders_book_code_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_book text;
begin
  if new.account_code is null then return new; end if;

  select book into v_book from public.account_codes where code = new.account_code;

  if v_book is distinct from coalesce(new.book, 'anxing') then
    raise exception '會計科目「%」不屬於這一本帳（% ≠ %）。',
      new.account_code, coalesce(v_book, '（查無此科目）'), coalesce(new.book, 'anxing')
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists trg_orders_book_code on public.orders;
create trigger trg_orders_book_code
  before insert or update of account_code, book on public.orders
  for each row execute function public.orders_book_code_guard();


-- 支出那側同一條規則。expenses 本來就有 account_code。
create or replace function public.expenses_book_code_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_book text;
begin
  if new.account_code is null then return new; end if;
  select book into v_book from public.account_codes where code = new.account_code;
  if v_book is distinct from coalesce(new.book, 'anxing') then
    raise exception '會計科目「%」不屬於這一本帳（% ≠ %）。',
      new.account_code, coalesce(v_book, '（查無此科目）'), coalesce(new.book, 'anxing')
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists trg_expenses_book_code on public.expenses;
create trigger trg_expenses_book_code
  before insert or update of account_code, book on public.expenses
  for each row execute function public.expenses_book_code_guard();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('162_orders_account_code');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ orders.account_code' as "檢查項目",
         count(*)::text || ' / 1' as "結果",
         case when count(*) = 1 then '✅' else '❌' end as "說明"
    from information_schema.columns
   where table_schema = 'public' and table_name = 'orders' and column_name = 'account_code'

  union all
  select 2, '★ 科目與帳本一致的防線', count(*)::text || ' / 2',
         case when count(*) = 2 then '✅ 訂單與支出都有'
              else '❌ 觸發器沒建齊' end
    from pg_trigger
   where tgname in ('trg_orders_book_code', 'trg_expenses_book_code')

  union all
  /*
   * ★★ 既有的支出**一筆都不能違規**。
   *   有的話表示安幸的科目表裡混進了別家的 book 值，
   *   而觸發器建好之後那幾筆就再也存不進去了。
   */
  select 3, '★★ 既有支出的科目都對得上帳本',
         count(*)::text || ' 筆違規',
         case when count(*) = 0 then '✅' else '❌ 這幾筆之後會改不動' end
    from public.expenses e
    join public.account_codes c on c.code = e.account_code
   where c.book is distinct from coalesce(e.book, 'anxing')

  union all
  select 4, '安幸的訂單', count(*)::text || ' 筆',
         '全部 account_code = null，行為完全不變'
    from public.orders where book = 'anxing' and account_code is null

) v order by ord;
