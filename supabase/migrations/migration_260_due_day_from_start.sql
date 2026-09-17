/*
 * migration_260_due_day_from_start.sql　2026-09-17
 * 首繳日退役：把「這一欄已經不參與計算」寫進資料庫本身
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *            自檢在 commit 後面，成功就一定看得到。把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支不動任何一列資料】
 *
 * 只加兩行 COMMENT。沒有 update、沒有 delete、沒有 alter column。
 * 跑十次結果一模一樣。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 2026-09-17 應繳日改成用**租期起日**換算（使用者：「應收日改成租約
 * 首日來換算」「我不需要首繳日了」）。前端已經不讀 first_payment_date。
 *
 * 查-還有誰在讀首繳日.sql 的結果：
 *     ① 資料庫這一半**沒有任何函式、view、約束**在讀 first_payment_date
 *     ② pay_day 也一樣，只有前端在用
 *     ③ 首繳日 107 張有值、幾號繳 13 張有值
 *     ④ 沒有「room is null 且 pay_day 是空的且首繳日剛好 15 號」的攤位
 *
 * 所以**兩欄都不刪**：
 *
 *   first_payment_date　107 張的歷史紀錄。刪掉換不到任何東西
 *                       （它沒有拖慢誰、沒有擋住誰），而那 107 筆
 *                       「當初約定第一期什麼時候繳」再也回不來。
 *
 *   pay_day　　　　　　 13 張正在用。新設計就是靠它覆寫預設值 ——
 *                       這一欄不是遺跡，是現役的。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 那為什麼還要跑這一支】
 *
 * 因為「留著不用」跟「還在用」在資料庫裡**長得一模一樣** ——
 * 一支有值的欄位，107 列資料，看不出它已經退休了。
 *
 * 三個月後有人（很可能是我）寫新功能時看到 `first_payment_date`
 * 有 107 筆漂亮的資料，會很自然地拿它去算日期 ——
 * 於是同一件事又變成兩條路各算各的，而兩邊都不會報錯。
 * 那正是 README 坑 A 的形狀。
 *
 * ★ COMMENT 是唯一一個「查表就看得到」的地方。寫在 .ts 的註解裡
 *   對著 Supabase 介面查欄位的人看不到。
 *
 * ══════════════════════════════════════════════════════════
 */

begin;

comment on column public.contracts.first_payment_date is
  '【已退役 2026-09-17】當初約定的第一期繳款日，只保留歷史紀錄。'
  '★ 不要拿它算應繳日 —— 應繳日由 start_date（租期起日）換算，'
  'pay_day 有值時由 pay_day 覆寫。前端 lib/due-date.ts 的 payDayOf() 是唯一的算法。'
  '存檔時原樣帶回去，沒有人讀它。';

comment on column public.contracts.pay_day is
  '【現役】每期幾號繳，覆寫用。空的＝跟著 start_date 的日子走。'
  '1~31，超過當月天數時由前端收到當月最後一天。'
  '算法只有一份：lib/due-date.ts 的 payDayOf() / dueDayText()。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('260_due_day_from_start');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with fns as (
  /* ★ prokind 一定要濾 —— 掃到聚合函式會整支炸掉（2026-09-01 踩過） */
  select p.proname::text as name, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
),
vws as (
  select c.relname::text as name, pg_get_viewdef(c.oid) as def
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
),
cons as (
  select conname::text as name, pg_get_constraintdef(oid) as def
  from pg_constraint where conrelid = 'public.contracts'::regclass
),
/* ★ 用詞邊界，不要 ilike '%first_payment%' —— 那會掃到別的欄位名 */
readers as (
  select '函式 ' || name as who from fns where def ~ '\mfirst_payment_date\M'
  union all select 'view ' || name from vws where def ~ '\mfirst_payment_date\M'
  union all select '約束 ' || name from cons where def ~ '\mfirst_payment_date\M'
),
cnt as (
  select
    (select count(*) from public.contracts
      where active and first_payment_date is not null) as fpd,
    (select count(*) from public.contracts
      where active and pay_day is not null and pay_day <> 0) as pd
),
cmt as (
  select
    col_description('public.contracts'::regclass, a.attnum) as body,
    a.attname::text as col
  from pg_attribute a
  where a.attrelid = 'public.contracts'::regclass
    and a.attname in ('first_payment_date', 'pay_day')
)

select * from (

  select 1 as ord, '① 首繳日的註解寫上去了沒' as "檢查",
         coalesce((select left(body, 40) || '…' from cmt where col = 'first_payment_date'),
                  '（是空的）') as "結果",
         case when exists (select 1 from cmt
                            where col = 'first_payment_date' and body like '%已退役%')
              then '✅ 寫上去了' else '❌ 沒寫到' end as "判定"

  union all
  select 2, '② 幾號繳的註解寫上去了沒',
         coalesce((select left(body, 40) || '…' from cmt where col = 'pay_day'), '（是空的）'),
         case when exists (select 1 from cmt where col = 'pay_day' and body like '%現役%')
              then '✅ 寫上去了' else '❌ 沒寫到' end

  union all
  /*
   * ★★ 這一列**要判定**，不能只當參考值。
   *   這支只加註解，資料一列都不該少。變成 0 就是有人動了資料。
   */
  select 3, '③ 資料有沒有被動到',
         '首繳日 ' || (select fpd from cnt) || ' 張・幾號繳 ' || (select pd from cnt) || ' 張',
         case when (select fpd from cnt) = 0
              then '⚠ 首繳日一張都沒有了 —— 跑這支之前是 107 張，資料被誰刪了，馬上講'
              when (select pd from cnt) = 0
              then '⚠ 幾號繳一張都沒有了 —— 那 13 張覆寫不見了，馬上講'
              else '✅ 都還在（這支只加註解，本來就不該變）' end

  union all
  /*
   * ★★★ 重驗前提。
   *   「沒有人讀它」是這支的整個理由 —— 哪天有人在資料庫裡接了上去，
   *   前端跟資料庫就會各算各的，而兩邊都不會報錯。
   *   這一列以後每次跑都該是綠的，變紅就是有人接回去了。
   */
  select 4, '④ 資料庫這一半真的沒有人在讀首繳日',
         coalesce((select string_agg(who, '、' order by who) from readers),
                  '（一個都沒有）'),
         case when exists (select 1 from readers)
              then '⚠ 有人在讀 —— 前端已經不讀了，這兩邊現在各算各的'
              else '✅ 沒有人讀 —— 應繳日只有 lib/due-date.ts 一份算法' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '260_due_day_from_start'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '260_due_day_from_start')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
