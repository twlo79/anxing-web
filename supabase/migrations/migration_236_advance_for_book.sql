/*
 * migration_236 —— 安幸代墊其他事業體：欄位
 * ============================================================
 * 2026-09-09。起因:`PR-202608-075` 按確認付款日時被擋下來 ——
 *
 *     會計科目「ap_insurance」不屬於這一本帳（aipi ≠ anxing）
 *
 * 那個檢查是對的。問題在於那張單走錯路了:費用是**愛皮的**
 * （科目也是愛皮的），但錢從**安幸的戶頭**出去。
 *
 * ============================================================
 * 【★★★ 會計立場 —— 跟既有的暫付一致】
 *
 * `lib/advance.ts` 開頭寫著（2026-09-01 使用者選的）:
 *     出款 **不記費用** —— 暫時放在別人那裡的資產，不是花掉的錢
 *     收回 **不記收入** —— 拿回自己的錢，不是賺到
 *
 * 「安幸替愛皮墊錢」是同一件事的另一種形狀:
 *
 *     安幸   暫付款（資產）  類別=代墊  for_book=aipi   ← 不記費用
 *     愛皮   支出 ap_insurance         book=aipi        ← 費用記在這裡
 *     還款   安幸暫付收回                                ← 不記收入
 *
 * 兩本帳各自完整。安幸不虛增費用，愛皮也不會有一筆沒有出處的支出。
 *
 * ============================================================
 * 【這一支只加欄位，不動任何函式】
 *
 * 產生支出的是 `gen_expenses_from_pr()`。要讓它同時建暫付，
 * 得整份重寫那支函式 —— 而**憑印象抄會抄漏**（migration_229、230 的教訓）。
 * 所以拆成兩支:這一支把欄位備好，下一支拿到線上定義之後再改函式。
 *
 * ★ 這一支跑完系統行為**完全不變**:三個欄位都是選填，沒有人在寫。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ── ① 暫付：代墊給哪一本帳 ────────────────────────
/*
 * ★★ 不用既有的 `counterparty`（自由文字）—— 打「愛皮」跟
 *   「愛皮旅行社」會變成兩個對象，永遠算不出「替愛皮墊了多少」。
 *
 * ★ null = 這筆不是代墊（既有的押金、保證金、零用金全都是 null）。
 */
alter table public.advance_payments
  add column if not exists for_book text;

alter table public.advance_payments drop constraint if exists advance_for_book_chk;
alter table public.advance_payments add constraint advance_for_book_chk
  check (for_book is null or for_book in ('aipi', 'hongsha'));

-- ── ② 類別多一種「代墊」──────────────────────────
/*
 * ★★★ 舊的 check 約束名字不確定（migration_202 建的），
 *   所以**用內容找**再換掉 —— 憑印象猜名字會 drop 不到，
 *   而 drop 不到的話下面 add 會直接衝突。
 */
do $do$
declare r record; n int := 0;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.advance_payments'::regclass
              and contype = 'c'
              and pg_get_constraintdef(oid) like '%押金%'
  loop
    execute format('alter table public.advance_payments drop constraint %I', r.conname);
    raise notice '拿掉舊的類別約束：%', r.conname;
    n := n + 1;
  end loop;
  if n = 0 then raise notice '找不到舊的類別約束 —— 可能本來就沒有'; end if;
end $do$;

alter table public.advance_payments add constraint advance_category_chk
  check (category in ('押金', '保證金', '零用金', '代墊', '其他'));

-- ── ③ 支出指回那筆暫付 ────────────────────────────
/*
 * ★★ 愛皮那筆支出的付款帳號是**安幸的戶頭** —— 不指回暫付的話，
 *   對帳時愛皮帳上會有一筆錢從別人的戶頭出去而沒有任何線索。
 *
 * ★ `on delete set null`:暫付被刪掉時支出要留著（錢真的花了），
 *   只是斷了線索。串聯刪除會把一筆真實的費用一起帶走。
 */
alter table public.expenses
  add column if not exists advance_id uuid;

alter table public.expenses drop constraint if exists expenses_advance_fk;
alter table public.expenses add constraint expenses_advance_fk
  foreign key (advance_id) references public.advance_payments(id) on delete set null;

-- ── ④ 請款單標記「這張是安幸代墊」──────────────────
/*
 * ★ 存的是「代墊給哪一本帳」而不是一個布林值 ——
 *   布林值還要另外問「墊給誰」，兩個欄位就會有不一致的組合。
 */
alter table public.purchase_requests
  add column if not exists advance_for_book text;

alter table public.purchase_requests drop constraint if exists pr_advance_for_book_chk;
alter table public.purchase_requests add constraint pr_advance_for_book_chk
  check (advance_for_book is null or advance_for_book in ('aipi', 'hongsha'));

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('236_advance_for_book');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢　★ 字串比對一律 ilike
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 三個欄位都加好了',
         (select string_agg(t || '.' || c, '　' order by t) from (values
            ('advance_payments','for_book'), ('expenses','advance_id'),
            ('purchase_requests','advance_for_book')) x(t, c)
           where exists (select 1 from information_schema.columns i
                          where i.table_schema='public' and i.table_name=x.t
                            and i.column_name=x.c)),
         case when (select count(*) from (values
                      ('advance_payments','for_book'), ('expenses','advance_id'),
                      ('purchase_requests','advance_for_book')) x(t, c)
                     where exists (select 1 from information_schema.columns i
                                    where i.table_schema='public' and i.table_name=x.t
                                      and i.column_name=x.c)) = 3
              then '✅ 三個都在' else '❌ 少了' end

  union all
  /*
   * ★★★ 母體判定:**舊的四種類別一個都不能掉**。
   *   換 check 約束時抄漏一種，那一類的暫付從此存不了 ——
   *   而症狀是使用者存檔時看到一句看不懂的約束錯誤。
   */
  select 2, '②★★★ 類別約束：舊的四種都還在，多了代墊',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conname = 'advance_category_chk'), '（沒有約束）'),
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'advance_category_chk') ilike '%押金%'
               and (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'advance_category_chk') ilike '%保證金%'
               and (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'advance_category_chk') ilike '%零用金%'
               and (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'advance_category_chk') ilike '%其他%'
               and (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'advance_category_chk') ilike '%代墊%'
              then '✅ 五種都在'
              else '❌ 有類別被抄漏 —— 那一類從此存不了，立刻回頭' end

  union all
  select 3, '③ 既有的暫付一筆都沒被影響',
         coalesce((select string_agg(category || '×' || n::text, '　' order by category)
                     from (select category, count(*) n from public.advance_payments
                            group by category) g), '（一筆暫付都沒有）'),
         case when (select count(*) from public.advance_payments) = 0
              then '⚠ 一筆都沒有 —— 下面沒東西可驗，但約束還是要對'
              else '✅ 都還在（類別合法才查得出來）' end

  union all
  select 4, '④ 支出 → 暫付的外鍵',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conname = 'expenses_advance_fk'), '（沒有）'),
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'expenses_advance_fk') ilike '%set null%'
              then '✅ on delete set null —— 暫付被刪時支出留著'
              else '❌ 不是 set null —— 刪暫付會把真實的費用一起帶走' end

  union all
  /*
   * ★ 這支跑完行為完全不變 —— 三個欄位都沒有人在寫。
   *   下一支才會讓 gen_expenses_from_pr() 用到它們。
   */
  select 5, '⑤ 現在有幾筆用到新欄位（應該全是 0）',
         (select (select count(*) from public.advance_payments where for_book is not null)::text || ' / '
                 || (select count(*) from public.expenses where advance_id is not null)::text || ' / '
                 || (select count(*) from public.purchase_requests where advance_for_book is not null)::text),
         '👀 暫付 / 支出 / 請款單。這支跑完應該是 0 / 0 / 0'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '236_advance_for_book'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '236_advance_for_book')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
