-- ============================================================
-- 唯讀。每一筆支出長什麼樣子 —— 拿來對帳的。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--   彙總在另一支：查-支出-哪個月哪一間出多少.sql
--
-- 【為什麼要逐筆】
-- 彙總看得到「正隆 8 月出了 300 萬」，看不出那 300 萬是
-- 一筆房東租金還是二十筆修繕。要簽字之前得看得到每一筆。
--
-- ★★ 目前整張表只有 132 筆（記帳從 2026/08 才開始），
--   所以直接全部列出來，不分頁也不篩月份。
--   之後累積到幾千筆時再把 where 的月份條件打開。
-- ============================================================

select e.spent_on                                     as 日期,

       coalesce(es.name,
                case when e.purpose_type = 'office' then '（安幸辦公室）' end,
                '（沒掛物業）')                          as 物業,
       coalesce(p.name,
                case when e.estate_id is not null then '（整棟）'
                     when e.purpose_type = 'office' then '—'
                     else '（沒掛房源）' end)             as 房源,

       coalesce(ac.name, e.account_code, '（沒填科目）')  as 科目,
       e.item_name                                     as 項目,
       e.amount                                        as 金額,

       -- ★★★ 這一欄要看。非實支 ＝ 錢沒有真的匯出去（房務內部成本），
       --   混進現金流量表的話會多扣一截
       case when '非實支' = any(coalesce(e.tags, '{}')) then '非實支' else '實支' end as 實支與否,

       coalesce(e.payment_method, '（沒填）')            as 付款方式,
       coalesce(e.pay_account, '—')                    as 付款帳號,

       -- ★ 沒有憑證的要看得出來。`no_voucher` 是「確定不用憑證」，
       --   跟「還沒補」不同 —— 兩種在畫面上都是空的
       case when e.voucher_no is not null then e.voucher_no
            when e.no_voucher then '（免憑證）'
            else '⚠ 沒有憑證' end                        as 憑證,

       coalesce(e.note, '')                            as 備註,

       -- ★★ 房務產生的那些認得出來。它們是按鈕產生的不是人記的，
       --   對不上時要往房務那邊查，不是往支出這邊查
       case when e.hk_job_key   is not null then '房務清潔（自動產生）'
            when e.hk_labor_key is not null then '房務人事費（自動產生）'
            else '人工記帳' end                          as 怎麼來的

  from public.expenses e
  left join public.properties    p  on p.id  = e.property_id
  left join public.estates       es on es.id = e.estate_id
  left join public.account_codes ac on ac.code = e.account_code

 -- 日期由新到舊；同一天金額大的排前面
 order by e.spent_on desc, e.amount desc;
