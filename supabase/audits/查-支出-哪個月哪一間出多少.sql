-- ============================================================
-- 唯讀。哪個月、哪一間、出多少。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--   逐筆明細在另一支：查-支出明細-逐筆.sql
--
-- ============================================================
-- 【★★★ 非實支要分開，不能混在一起看】
--
-- 標了「非實支」的（房務清潔、房務人事費）是**內部成本認列**，
-- 錢沒有真的匯出去。跟真的付出去的錢加在一起，
-- 那個數字既不是現金也不是成本 —— 兩邊都對不上。
--
-- 所以兩欄分開印。「實支」那一欄才是現金流量表要用的。
--
-- ★ 判斷用 `'非實支' = any(tags)`。那個字串的唯一出處是
--   `src/lib/expense-tags.ts` 的 `TAG_NON_CASH`。
--
-- ============================================================
-- 【★★ 沒有房源的那些不會被丟掉】
--
-- 支出可以掛在**物業**上而沒有房源（整棟的水電、管理費），
-- 也可以掛在「安幸辦公室」（`purpose_type = 'office'`，沒有物業也沒有房源）。
--
-- 用 inner join 接 properties 的話那幾筆會安靜消失，
-- 而總額看起來只是「比較小」。所以一律 left join ＋ 明講是哪一種。
-- ============================================================

select to_char(e.spent_on, 'YYYY/MM')                    as 月份,

       -- ★ 三段退回：房源 → 物業 → 辦公室。每一段都講得出是哪一種
       coalesce(es.name,
                case when e.purpose_type = 'office' then '（安幸辦公室）' end,
                '（沒掛物業）')                            as 物業,
       coalesce(p.name,
                case when e.estate_id is not null then '（整個物業，沒指定房源）'
                     when e.purpose_type = 'office' then '—'
                     else '（沒掛房源）' end)               as 房源,

       count(*)                                          as 筆數,

       -- ★★ 實支 ＝ 真的匯出去的錢。現金流量表只能用這一欄
       sum(case when not ('非實支' = any(coalesce(e.tags, '{}')))
                then e.amount else 0 end)                as 實支,
       sum(case when      '非實支' = any(coalesce(e.tags, '{}'))
                then e.amount else 0 end)                as 非實支,

       -- ★ 花在什麼上面。一格塞不下就截斷 —— 要看全部去逐筆那一支
       left(string_agg(distinct coalesce(ac.name, e.account_code, '（沒填科目）'), '、'), 60) as 科目

  from public.expenses e
  left join public.properties   p  on p.id  = e.property_id
  left join public.estates      es on es.id = e.estate_id
  left join public.account_codes ac on ac.code = e.account_code

 group by to_char(e.spent_on, 'YYYY/MM'),
          coalesce(es.name,
                   case when e.purpose_type = 'office' then '（安幸辦公室）' end,
                   '（沒掛物業）'),
          coalesce(p.name,
                   case when e.estate_id is not null then '（整個物業，沒指定房源）'
                        when e.purpose_type = 'office' then '—'
                        else '（沒掛房源）' end)

 -- ★ 月份由新到舊、金額由大到小。要對帳的人先看到大的那幾筆
 order by 1 desc, 5 desc;
