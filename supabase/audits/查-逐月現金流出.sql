-- ============================================================
-- 唯讀。過去 12 個月**實際付出去的錢**，逐月分科目。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--
-- ============================================================
-- 【★★★ 為什麼是「過去」不是「未來」】
--
-- 收的那一邊（租金）系統裡有未來 —— gen_contract_orders 依契約
-- 把每個月的月租單先產生出來了，所以看得到 12 個月後要收多少。
--
-- **付的那一邊沒有。** `expenses` 是「已經花掉才記」的表，
-- 沒有任何地方預先排出「下個月要付房東多少」。
--
-- 所以未來的流出只能用**過去的實際支出當基準**去推。
-- 這份給的是那個基準，不是預測 —— 兩者差別要講清楚，
-- 不然拿去跟未來的流入相減會得到一個看起來很精確的錯數字。
--
-- ============================================================
-- 【★★★ 非實支要排除】
--
-- 標了「非實支」的那些（房務清潔、房務人事費）是**內部成本認列**，
-- 錢沒有真的匯出去。算現金流時把它們算進去，會多扣好幾十萬
-- 而帳面看起來只是「支出比較高」。
--
-- ★ 判斷用 `'非實支' = any(tags)`。那個字串的唯一出處是
--   `src/lib/expense-tags.ts` 的 `TAG_NON_CASH`。
-- ============================================================

with e as (
  select date_trunc('month', spent_on)::date as m,
         coalesce(ac.name, e.account_code, '（沒填科目）') as 科目,
         e.amount,
         ('非實支' = any(coalesce(e.tags, '{}'))) as 非實支
    from public.expenses e
    left join public.account_codes ac on ac.code = e.account_code
   where e.spent_on >= date_trunc('month', current_date) - interval '11 months'
     and e.spent_on <  date_trunc('month', current_date) + interval '1 month'
),
-- ── 逐月合計 ────────────────────────────────────────────────
bymon as (
  select to_char(m, 'YYYY/MM') as 月份,
         sum(case when not 非實支 then amount else 0 end) as 實際付出去的,
         sum(case when 非實支     then amount else 0 end) as 非實支,
         count(*) as 筆數
    from e group by to_char(m, 'YYYY/MM')
),
-- ── 分科目合計（只算實支）──────────────────────────────────
bycode as (
  select 科目,
         sum(amount) as 十二個月合計,
         round(sum(amount) / 12) as 平均每月,
         count(*) as 筆數
    from e where not 非實支 group by 科目
)
-- ★★ 兩張表併成一張輸出 —— SQL Editor 只顯示最後一個 select，
--   分開寫的話上面那張看不到
select 1 as 區, 月份 as 項目, 實際付出去的 as 金額,
       非實支 as 次要金額, 筆數,
       '★ 這是真的匯出去的錢。非實支那一欄不算現金' as 說明
  from bymon

union all
select 2, '＝ 十二個月合計',
       (select sum(實際付出去的) from bymon),
       (select sum(非實支) from bymon),
       (select sum(筆數) from bymon),
       '★★ 除以 12 就是「每月大概要付多少」的基準'

union all
select 3, '＝ 平均每月',
       round((select sum(實際付出去的) from bymon) / 12),
       round((select sum(非實支) from bymon) / 12),
       null,
       '★★★ 拿這個數字去跟未來的流入比 —— 但它是過去的平均，不是預測'

union all
select 4, 科目, 十二個月合計, 平均每月, 筆數,
       '分科目：這一年花最多的排前面'
  from bycode

order by 區, 金額 desc nulls last;
