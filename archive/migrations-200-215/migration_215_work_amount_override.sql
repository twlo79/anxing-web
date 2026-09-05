-- ============================================================
-- migration_215：工單可以直接指定清潔費金額
--
-- 【這個欄位是給誰用的】
--
-- 一份工的清潔費本來一律是「間數 × 房源單價」。有些時候那個公式
-- 講不出正確的數字 —— 例如開封 2-2 那間談的是 1,000，不是公訂價。
-- 這一欄讓人直接講「這份工付多少」。
--
-- ★★★ 代價要知道：金額與「間數 × 單價」從此**可能不一致**。
--   這正是 CLAUDE.md 那條「推導值存成欄位」在警告的形狀。
--   差別有兩個：
--     1. 這是**人明確填的**，不是程式算完存起來的
--     2. 只有填了才生效 —— null 一律走公式，預設行為完全不變
--   所以它是「覆寫」不是「快取」。快取會過期，覆寫不會。
--
-- ★★ 項目名稱在有覆寫時**不印 ×N**（`cleanItemName` 的 fixedAmount）。
--   印了會變成「×0.17」配一筆 1,500，而 0.17 × 9,000 是 1,530 ——
--   看得懂的人會停下來算，然後以為系統錯了。
--
-- ============================================================
-- 【★ 跟 migration_216 的拆帳怎麼分工】（2026-09-03）
--
--   這一欄（amount_override）  一份工 → **一筆**支出，金額由人指定
--   hk_work_split（216）       一份工 → **多筆**支出，各記到不同房源
--
-- 正隆那份「一份工掃三間」走 216 不走這裡：三間各 1,500 要
-- 分別記到 4B3／13A5／14B1 頭上，一筆支出裝不下三個房源。
--
-- ★★ 這一支**只建欄位，一列資料都不動**。
--   本來還帶著「08-14 那三筆各設 1,500」與「改既有支出」兩段，
--   拿掉了 —— 那是照 migration_214（已作廢）的拆法寫的，
--   而且我沒有看過那幾列現在長什麼樣子（CLAUDE.md：「對不上的不猜」）。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

alter table public.hk_work_item
  add column if not exists amount_override numeric(14,2);

comment on column public.hk_work_item.amount_override is
  '這一份工的清潔費直接指定（migration_215）。null = 用「間數 × 房源單價」算。'
  '★ 0 是「這份工不用錢」，跟 null 不同。'
  '★★ 合掃是同一份工的兩列，兩列各帶同一個值 —— 讀的時候取一個不是加總。'
  '★★★ 一份工要記到多個房源請用 hk_work_split（migration_216），不是這一欄。';

do $do$ begin
  alter table public.hk_work_item
    add constraint hk_work_item_amount_chk
    check (amount_override is null or amount_override >= 0);
exception when duplicate_object then null; end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('215_work_amount_override');
  end if;
end $do$;

commit;

-- ============================================================
-- 自檢
-- ★ 這一支不寫資料，所以沒有母體可以判定 —— 成敗就是欄位與約束。
-- ============================================================
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① amount_override 欄位在不在',
         coalesce((select data_type || coalesce('(' || numeric_precision::text
                          || ',' || numeric_scale::text || ')', '')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'hk_work_item'
                      and column_name = 'amount_override'), '（不存在）'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'hk_work_item'
                              and column_name = 'amount_override')
              then '✅ 要是 numeric(14,2)'
              else '❌ 沒加成功，下面不用看' end

  union all
  -- ★ 負數要擋。付一筆負的清潔費不是任何人想做的事
  select 2, '② 不能是負數的約束',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.hk_work_item'::regclass
                      and conname = 'hk_work_item_amount_chk'), '（沒有）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.hk_work_item'::regclass
                              and conname = 'hk_work_item_amount_chk')
              then '✅' else '❌ 沒擋住' end

  union all
  -- ★★ 這一列是判定不是參考值。剛加完欄位應該是 0 筆 ——
  --   不是 0 代表這一支已經跑過，而中間可能有人填過東西
  select 3, '★★ ③ 目前有幾筆填了覆寫金額',
         (select count(*)::text || ' 筆' from public.hk_work_item
           where amount_override is not null),
         case when (select count(*) from public.hk_work_item
                     where amount_override is not null) = 0
              then '✅ 0 筆 —— 這一支只建欄位，本來就不該有'
              else '⚠ 不是 0 —— 這支跑過了，先確認那幾筆是誰填的再往下走' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '215_work_amount_override'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '215_work_amount_override')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
