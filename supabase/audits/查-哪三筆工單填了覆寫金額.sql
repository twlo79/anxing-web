/*
 * 查-哪三筆工單填了覆寫金額，順便看 216 跑了沒（唯讀）
 * ============================================================
 * 2026-09-05
 *
 * migration_215 的自檢第 3 列回「3 筆」而不是 0 ——
 * 那支跑過了，而且中間有人填過覆寫金額。
 *
 * 【為什麼要先看再說】
 *
 * `amount_override` 一填，那份工的清潔費就**不再等於**
 * 「間數 × 房源單價」。三筆是誰填的、填了多少、為什麼填 ——
 * 不知道的話，之後任何一個「金額對不上」的問題都會先懷疑到它。
 *
 * ★ 猜測是 08-14 正隆那三間各 1,500，但**不猜**。
 *   而且如果真的是那三筆，它們應該走 `hk_work_split`（216 的拆帳）
 *   而不是這一欄 —— 一筆支出裝不下三個房源。
 *
 * 【★ 為什麼用 to_jsonb 而不列欄位名】
 *
 * 我沒有 `hk_work_item` 的欄位清單在手上，而憑印象寫欄位名
 * 今天已經錯過三次（CLAUDE.md）。整列轉成 JSON 印出來，
 * 不用賭任何一個名字。
 *
 * 【怎麼跑】整份貼進 SQL Editor。唯讀。
 */

select v.ord, v."項目", v."內容", v."判定" from (

  -- ══════════ ★★★ 那三筆到底是什麼 ══════════
  select 100 + row_number() over (order by w.amount_override desc) as ord,
         '★★★ 填了覆寫金額的工單' as a,
         to_jsonb(w)::text as b,
         '$' || w.amount_override::text as d
    from public.hk_work_item w
   where w.amount_override is not null

  -- ══════════ 這些工單對應的房源叫什麼 ══════════
  union all
  select 200, '這些工單掛在哪個房源',
         coalesce((select string_agg(distinct p.name || '（' || p.id::text || '）', '、')
                     from public.hk_work_item w
                     join public.properties p on p.id = w.property_id
                    where w.amount_override is not null), '（接不到 properties，或欄位不叫 property_id）'),
         'ℹ 三筆是不是同一天同一份工'

  -- ══════════ ★ 216 跑了沒 ══════════
  union all
  select 300, '★ hk_work_split 表在不在',
         case when to_regclass('public.hk_work_split') is null then '不存在（216 沒跑）'
              else '存在，' || (select count(*)::text
                                  from public.hk_work_split) || ' 列拆帳' end,
         case when to_regclass('public.hk_work_split') is null
              then '⚠ 216 還沒跑' else '✅ 216 跑過了' end

  union all
  select 310, '210~219 各支的記錄時間',
         coalesce((select string_agg(name || '｜' ||
                     coalesce(to_jsonb(sm)->>'applied_at', to_jsonb(sm)->>'created_at',
                              to_jsonb(sm)->>'at', '（沒有時間欄位）'), E'\n' order by name)
                     from public.schema_migrations sm
                    where name >= '210' and name < '220'), '（一支都沒記到）'),
         'ℹ 我一直以為 213/215/216 沒跑 —— 這一格是事實'

  -- ══════════ ★★ 有沒有既有支出跟覆寫金額對不上 ══════════
  union all
  select 400, '★★ 這三筆有沒有已經產生的房務支出',
         coalesce((select string_agg(e.item_name || '｜$' || e.amount::text || '｜' || e.spent_on::text, E'\n')
                     from public.expenses e
                    where e.spent_on in (select w.work_date from public.hk_work_item w
                                          where w.amount_override is not null)
                      and e.item_name like '%清潔%'), '（那幾天沒有清潔費支出）'),
         'ℹ 金額對不上的話，支出是用舊公式產生的'

) v(ord, "項目", "內容", "判定")
order by v.ord;
