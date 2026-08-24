-- 查：三本帳有沒有混在一起
--
-- ============================================================
-- 【這支在回答什麼】
--
-- 「安幸的報表上，會不會不小心算進愛皮／洪鯊的錢？」
--
-- 三家的收入與支出住在**同一張表**（orders / expenses），靠 `book` 欄位分。
-- 所以每一支報表查詢都要自己記得帶 `book = 'anxing'` ——
-- **漏掉一支不會報錯**，只會讓某張報表悄悄多算兩家公司的錢。
--
-- ★ 這支只讀，隨時可以跑。
-- ★ 建議每個月對帳前跑一次，或改完任何一支報表查詢之後跑一次。
--
--
-- ============================================================
-- 【怎麼看結果】
--
-- 目前愛皮洪鯊還沒有資料，所以三張表應該都是 0。
-- 有資料之後:
--
--   第①張   安幸／愛皮／洪鯊 各自的金額 —— 拿安幸那一列去對報表
--   第②張   規則有沒有被違反（科目跟帳本對不上、認列表混進別家的）
--   第③張   前端沒帶 book 會看到什麼（差額就是會被多算的錢）
-- ============================================================


-- ── ① 每一本帳的金額（本月 ＋ 今年）────────────────
select "帳本", "區間", "收入筆數", "收入金額", "支出筆數", "支出金額", "淨額"
from (
  select 1 as ord, b.book as "帳本", '本月' as "區間",
         (select count(*) from public.orders o
           where o.book = b.book
             and o.checkin >= date_trunc('month', current_date)::date
             and o.checkin <  (date_trunc('month', current_date) + interval '1 month')::date) as "收入筆數",
         coalesce((select sum(o.amount) from public.orders o
           where o.book = b.book
             and o.checkin >= date_trunc('month', current_date)::date
             and o.checkin <  (date_trunc('month', current_date) + interval '1 month')::date), 0) as "收入金額",
         (select count(*) from public.expenses e
           where e.book = b.book
             and e.spent_on >= date_trunc('month', current_date)::date
             and e.spent_on <  (date_trunc('month', current_date) + interval '1 month')::date) as "支出筆數",
         coalesce((select sum(e.amount) from public.expenses e
           where e.book = b.book
             and e.spent_on >= date_trunc('month', current_date)::date
             and e.spent_on <  (date_trunc('month', current_date) + interval '1 month')::date), 0) as "支出金額",
         coalesce((select sum(o.amount) from public.orders o
           where o.book = b.book
             and o.checkin >= date_trunc('month', current_date)::date
             and o.checkin <  (date_trunc('month', current_date) + interval '1 month')::date), 0)
         - coalesce((select sum(e.amount) from public.expenses e
           where e.book = b.book
             and e.spent_on >= date_trunc('month', current_date)::date
             and e.spent_on <  (date_trunc('month', current_date) + interval '1 month')::date), 0) as "淨額"
    from (values ('anxing'), ('aipi'), ('hongsha')) b(book)

  union all

  select 2, b.book, '今年',
         (select count(*) from public.orders o
           where o.book = b.book and o.checkin >= date_trunc('year', current_date)::date),
         coalesce((select sum(o.amount) from public.orders o
           where o.book = b.book and o.checkin >= date_trunc('year', current_date)::date), 0),
         (select count(*) from public.expenses e
           where e.book = b.book and e.spent_on >= date_trunc('year', current_date)::date),
         coalesce((select sum(e.amount) from public.expenses e
           where e.book = b.book and e.spent_on >= date_trunc('year', current_date)::date), 0),
         coalesce((select sum(o.amount) from public.orders o
           where o.book = b.book and o.checkin >= date_trunc('year', current_date)::date), 0)
         - coalesce((select sum(e.amount) from public.expenses e
           where e.book = b.book and e.spent_on >= date_trunc('year', current_date)::date), 0)
    from (values ('anxing'), ('aipi'), ('hongsha')) b(book)
) v
order by ord, "帳本";


-- ── ② 規則有沒有被違反 ─────────────────────────────
/*
 * 全部應該是 0。不是 0 的話，那幾筆會讓某張報表的數字錯掉，
 * 而且**不會有任何錯誤訊息**。
 */
select "檢查", "違規筆數", "說明" from (

  select 1 as ord, '★★ 認列表混進非安幸' as "檢查",
         count(*)::text as "違規筆數",
         '愛皮洪鯊的收入被拆成月認列了 —— 營收表會多算（migration_161 應該擋掉）' as "說明"
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
   where o.book <> 'anxing'

  union all
  select 2, '★★ 訂單的科目跟帳本對不上', count(*)::text,
         '愛皮的訂單掛洪鯊的科目 —— 儀錶板的「by 科目」會出現那家沒有的科目'
    from public.orders o
    join public.account_codes c on c.code = o.account_code
   where c.book is distinct from o.book

  union all
  select 3, '★★ 支出的科目跟帳本對不上', count(*)::text, '同上'
    from public.expenses e
    join public.account_codes c on c.code = e.account_code
   where c.book is distinct from e.book

  union all
  select 4, '★ 來源與帳本對不上', count(*)::text,
         'source=other_biz 卻記在安幸帳，或反過來'
    from public.orders
   where (source = 'other_biz') <> (book <> 'anxing')

  union all
  select 5, '★ 一張請款單混兩本帳', count(*)::text,
         '支出產生時會拆進兩本帳，總額對不起來時查不到'
    from (
      select i.request_id
        from public.purchase_request_items i
        join public.purchase_requests r on r.id = i.request_id
       group by i.request_id, r.book
      having count(*) filter (where i.purpose_type = 'other_biz') > 0
         and count(*) filter (where i.purpose_type <> 'other_biz') > 0
    ) x

  union all
  select 6, '★ 愛皮洪鯊有押金', count(*)::text,
         '兩家不收押金（使用者確認）—— 有的話是誤填'
    from public.orders where book <> 'anxing' and coalesce(deposit, 0) <> 0

) v order by ord;


-- ── ③ 忘記帶 book 會多算多少 ───────────────────────
/*
 * ★★ 這一張是重點。
 *
 * 「全部」與「只有安幸」的差額，就是某支查詢忘了帶 book 時
 * 會被**悄悄多算**的金額。
 *
 * 拿它跟財務儀錶板、支出明細上的數字對照 ——
 * 報表顯示的應該是「只有安幸」那一欄。
 */
select
  '本月收入' as "項目",
  coalesce(sum(amount), 0)                                  as "全部（錯的）",
  coalesce(sum(amount) filter (where book = 'anxing'), 0)    as "只有安幸（對的）",
  coalesce(sum(amount) filter (where book <> 'anxing'), 0)   as "差額"
from public.orders
where checkin >= date_trunc('month', current_date)::date
  and checkin <  (date_trunc('month', current_date) + interval '1 month')::date
union all
select '本月支出',
  coalesce(sum(amount), 0),
  coalesce(sum(amount) filter (where book = 'anxing'), 0),
  coalesce(sum(amount) filter (where book <> 'anxing'), 0)
from public.expenses
where spent_on >= date_trunc('month', current_date)::date
  and spent_on <  (date_trunc('month', current_date) + interval '1 month')::date
union all
select '待付款請款單',
  coalesce(sum(total_amount), 0),
  coalesce(sum(total_amount) filter (where book = 'anxing'), 0),
  coalesce(sum(total_amount) filter (where book <> 'anxing'), 0)
from public.purchase_requests
where status = 'approved' and purchased_on is null;
