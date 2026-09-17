/*
 * 查-還有誰在讀首繳日.sql　2026-09-17
 *
 * 【為什麼查這個】
 * 前端已經不讀 `contracts.first_payment_date` 了（2026-09-17 改）。
 * 使用者問：「要刪首繳日或是每期_日繳的資料嗎？」
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 回答那個問題之前，要先知道**資料庫這一半有沒有人在讀它**。
 *
 *   我只掃過前端（`src/` 全部）—— 那裡確實只剩下「存檔時原樣帶回去」。
 *   但月租單是**資料庫的觸發器**產的（`gen_contract_orders()`），
 *   而那支我沒讀過。它如果拿 `first_payment_date` 去算 due date，
 *   那前端跟資料庫現在就會**各算各的**，而兩邊都不會報錯 ——
 *   症狀是「畫面上寫每月 1 號，產出來的單卻是 15 號」。
 *
 * ★★ 這正是 2026-09-03 那條坑的形狀:「只找到一條產生路徑就當成唯一的」。
 *   前端只是其中一半。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 *
 * 【怎麼看】最後一列的判定就是答案。
 */

with fns as (
  /* ★ prokind 一定要濾 —— 掃到聚合函式會整支炸掉（2026-09-01 踩過） */
  select p.oid, p.proname::text as name, pg_get_functiondef(p.oid) as def
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
  from pg_constraint
  where conrelid = 'public.contracts'::regclass
),
/* ★ 用詞邊界,不要 like '%first_payment%' —— 後者會掃到別的欄位名（2026-09-01） */
hits_fpd as (
  select '函式' as kind, name from fns where def ~ '\mfirst_payment_date\M'
  union all select 'view', name from vws where def ~ '\mfirst_payment_date\M'
  union all select '約束', name from cons where def ~ '\mfirst_payment_date\M'
),
hits_pd as (
  select '函式' as kind, name from fns where def ~ '\mpay_day\M'
  union all select 'view', name from vws where def ~ '\mpay_day\M'
  union all select '約束', name from cons where def ~ '\mpay_day\M'
),
counts as (
  select
    (select count(*) from public.contracts
      where active and first_payment_date is not null) as fpd_rows,
    (select count(*) from public.contracts
      where active and pay_day is not null and pay_day <> 0) as pd_rows
)

select * from (

  select 1 as ord, '① 誰在讀 first_payment_date（首繳日）' as "區塊",
         coalesce((select string_agg(kind || ' ' || name, '、' order by name) from hits_fpd),
                  '（資料庫這一半沒有人讀它）') as "內容",
         case when exists (select 1 from hits_fpd)
              then '⚠ 有 —— 那前端跟資料庫現在各算各的，要先看那幾支在做什麼'
              else '✅ 沒有人讀 —— 這一欄現在純粹是紀錄，留著不影響任何計算' end as "判定"

  union all
  select 2, '② 誰在讀 pay_day（幾號繳）',
         coalesce((select string_agg(kind || ' ' || name, '、' order by name) from hits_pd),
                  '（資料庫這一半沒有人讀它）'),
         case when exists (select 1 from hits_pd)
              then '⚠ 有 —— 刪掉 pay_day 會動到它們'
              else '✅ 沒有人讀 —— 只有前端在用' end

  union all
  select 3, '③ 現在有幾張有值',
         '首繳日 ' || (select fpd_rows from counts) || ' 張・'
         || '幾號繳 ' || (select pd_rows from counts) || ' 張（生效中的契約）',
         '參考'

  union all
  select 4, '④ 那批「每月 15 號」的攤位還在嗎',
         coalesce((select string_agg(coalesce(display_name, tenant_name), '、' order by tenant_name)
                     from public.contracts
                    where active and room is null
                      and pay_day is null
                      and first_payment_date is not null
                      and extract(day from first_payment_date) = 15), '（沒有）'),
         case when exists (
                select 1 from public.contracts
                 where active and room is null and pay_day is null
                   and first_payment_date is not null
                   and extract(day from first_payment_date) = 15)
              then '⚠ 這幾張現在會變成「跟著租期起日」—— 多半是 1 號。'
                   || '要保住每月 15 號的話，得把 pay_day 明確寫成 15'
              else '✅ 沒有這種契約' end

) t order by t.ord;
