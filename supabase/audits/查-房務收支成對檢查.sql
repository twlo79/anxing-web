/*
 * 查 —— 房務的工單 → 支出 → 收入，整條鏈子對不對得起來
 * ============================================================
 * 2026-09-09。成對分錄（migration_228/229）之後，一份工應該產生：
 *
 *   ① 物業       支出  房務清潔   expenses.hk_job_key = 日期|房源id|工作類型
 *   ② 安幸辦公室  收入  房務清潔   orders.order_key    = 'HKREV|' ‖ ①的鍵
 *   ③ 安幸辦公室  支出  薪資勞務   expenses.hk_job_key = 'HR|日期|員工id|房源id'
 *                                （只有時薪人員才有，**不該有對應收入**）
 *
 *   人事費另外一組：
 *   ④ 物業       支出  薪資支出   expenses.hk_labor_key = 期間|物業id
 *   ⑤ 安幸辦公室  收入  人事費     orders.order_key = 'HKLABREV|' ‖ ④的鍵
 *                                （**只有正隆**成對，其餘只有支出）
 *
 * ★★★ 這支要回答的是「①②有沒有一對一、金額一不一樣」——
 *   落單的那幾筆是最危險的:金額都正常，只是少了一半，
 *   而任何一張報表的總額看起來都不會怪。
 *
 * 【怎麼跑】改下面那兩個日期，整份貼進 SQL Editor。
 */

with params as (
  -- ↓↓↓ 只改這兩行 ↓↓↓
  select date '2026-08-01' as d1, date '2026-08-31' as d2
),

-- ── 這個期間的三批支出 ─────────────────────────────
clean_exp as (          -- ① 清潔費（含拆帳的 split:）
  select e.hk_job_key as k, e.amount, e.item_name, e.spent_on
    from public.expenses e, params p
   where e.spent_on between p.d1 and p.d2
     and e.hk_job_key is not null
     and e.hk_job_key not like 'HR|%'
),
hour_exp as (           -- ③ 時薪工資
  select e.hk_job_key as k, e.amount, e.item_name
    from public.expenses e, params p
   where e.spent_on between p.d1 and p.d2
     and e.hk_job_key like 'HR|%'
),
labor_exp as (          -- ④ 人事費
  select e.hk_labor_key as k, e.amount, e.estate_id
    from public.expenses e, params p
   where e.spent_on between p.d1 and p.d2
     and e.hk_labor_key is not null
),

-- ── 對應的兩批收入 ─────────────────────────────────
clean_inc as (          -- ②
  select o.order_key as ok,
         substring(o.order_key from 7) as k,   -- 去掉 'HKREV|'
         o.amount, o.item_name, o.checkin, o.guest_name
    from public.orders o, params p
   where o.order_key like 'HKREV|%'
     and o.checkin between p.d1 and p.d2
),
labor_inc as (          -- ⑤
  select o.order_key as ok,
         substring(o.order_key from 10) as k,  -- 去掉 'HKLABREV|'
         o.amount, o.guest_name
    from public.orders o, params p
   where o.order_key like 'HKLABREV|%'
     and o.checkin between p.d1 and p.d2
),

-- ── 工單（母體）────────────────────────────────────
jobs as (
  select distinct
         w.work_date,
         hp.property_id,
         w.work_type,
         w.property_code
    from public.hk_work_item w
    left join public.hk_property hp on hp.code = w.property_code
    cross join params p
   where w.work_date between p.d1 and p.d2
),
priced_jobs as (        -- 有房源、有公訂價 → 本來就該產生清潔費
  select j.*, pr.clean_price
    from jobs j
    join public.properties pr on pr.id = j.property_id
   where pr.clean_price is not null and pr.clean_price > 0
),

/*
 * ★★★ 各批的筆數 —— **每一條檢查都要先問自己的母體有沒有東西**。
 *
 * 2026-09-09 踩過:整批都還沒產生時，「有沒有落單」「兩邊等不等」
 * 九條全部回 ✅ —— 而正確答案是「不知道，因為一筆都沒有」。
 * 六個綠勾比一個紅字更容易讓人以為做完了。
 *
 * ★ 母體 0 的判定寫「⚠ 不算數」，不寫 ✅。
 */
n as (
  select (select count(*) from clean_exp) as ce,
         (select count(*) from clean_inc) as ci,
         (select count(*) from hour_exp)  as he,
         (select count(*) from labor_exp) as le,
         (select count(*) from labor_inc) as li
)

select v.ord, v."檢查", v."結果", v."判定" from (

  -- ══════════ 母體 ══════════
  select 0, '⓪★★★ 母體：這個期間有幾份工',
         (select count(*)::text || ' 份（其中有房源又有公訂價的 '
                 || (select count(*) from priced_jobs)::text || ' 份）'
            from jobs),
         case when (select count(*) from jobs) = 0
              then '❌ 一份工都沒有 —— 下面每一條都自動成立，全部不算數'
              when (select ce + ci + he + le + li from n) = 0
              then '⚠ 有工單但**一筆都還沒產生** —— 先按「產生收支」，下面九條現在不算數'
              else '✅ 有東西可以檢查' end

  -- ══════════ 清潔費那一對 ══════════
  union all
  select 1, '① 清潔費：支出筆數 vs 收入筆數',
         (select count(*) from clean_exp)::text || ' 支出　'
         || (select count(*) from clean_inc)::text || ' 收入',
         case when (select ce + ci from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when (select count(*) from clean_exp) = (select count(*) from clean_inc)
              then '✅ 一樣多' else '❌ 不一樣多 —— 看 ② ③' end

  union all
  select 2, '②★★★ 有支出、沒有收入的（安幸做了工卻沒跟物業收錢）',
         coalesce((select string_agg(k, '、' order by k)
                     from (select k from clean_exp e
                            where not exists (select 1 from clean_inc i where i.k = e.k)
                            limit 20) t), '（沒有）'),
         case when (select ce from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when exists (select 1 from clean_exp e
                            where not exists (select 1 from clean_inc i where i.k = e.k))
              then '❌ 有落單 —— 這幾間物業付了錢，安幸帳上卻沒有收入'
              else '✅ 一筆都沒落單' end

  union all
  select 3, '③★★★ 有收入、沒有支出的（安幸收了錢，物業帳上沒有成本）',
         coalesce((select string_agg(k, '、' order by k)
                     from (select k from clean_inc i
                            where not exists (select 1 from clean_exp e where e.k = i.k)
                            limit 20) t), '（沒有）'),
         case when (select ci from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when exists (select 1 from clean_inc i
                            where not exists (select 1 from clean_exp e where e.k = i.k))
              then '❌ 有落單 —— 多半是支出被刪過而收入還在'
              else '✅ 一筆都沒落單' end

  union all
  select 4, '④★★★ 配得起來但**金額不一樣**的',
         coalesce((select string_agg(e.k || '（支出 ' || e.amount::text
                                     || ' / 收入 ' || i.amount::text || '）', '、')
                     from clean_exp e join clean_inc i on i.k = e.k
                    where e.amount <> i.amount), '（沒有）'),
         case when (select least(ce, ci) from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when exists (select 1 from clean_exp e join clean_inc i on i.k = e.k
                            where e.amount <> i.amount)
              then '❌ 同額反向被破壞了 —— 多半是有人單獨改過其中一邊'
              else '✅ 每一對都同額' end

  union all
  select 5, '⑤ 清潔費總額（兩邊要一樣）',
         'NT$ ' || coalesce((select sum(amount) from clean_exp), 0)::text
         || '　vs　NT$ ' || coalesce((select sum(amount) from clean_inc), 0)::text,
         case when (select ce + ci from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when coalesce((select sum(amount) from clean_exp), 0)
                 = coalesce((select sum(amount) from clean_inc), 0)
              then '✅ 相等' else '❌ 不相等' end

  -- ══════════ 工單 → 支出 ══════════
  union all
  select 6, '⑥★★★ 有房源、有公訂價，卻沒有產生清潔費的工',
         coalesce((select string_agg(x, '、')
                     from (select j.work_date::text || ' ' || j.property_code as x
                             from priced_jobs j
                            where not exists (
                              select 1 from clean_exp e
                               where e.k = j.work_date::text || '|' || j.property_id::text
                                         || '|' || j.work_type)
                              and not exists (
                              select 1 from public.hk_work_split s
                               where s.work_date = j.work_date
                                 and s.job_code = j.property_code
                                 and s.work_type = j.work_type)
                            order by j.work_date limit 20) t), '（沒有）'),
         case when exists (
                select 1 from priced_jobs j
                 where not exists (
                   select 1 from clean_exp e
                    where e.k = j.work_date::text || '|' || j.property_id::text
                              || '|' || j.work_type)
                   and not exists (
                   select 1 from public.hk_work_split s
                    where s.work_date = j.work_date and s.job_code = j.property_code
                      and s.work_type = j.work_type))
              then '⚠ 有工沒產生支出 —— 按過「產生收支」了嗎？拆帳過的不會出現在這裡'
              else '✅ 每一份工都產生了' end

  -- ══════════ 時薪工資 ══════════
  union all
  select 7, '⑦ 時薪工資（劉姐）',
         (select count(*) from hour_exp)::text || ' 筆・NT$ '
         || coalesce((select sum(amount) from hour_exp), 0)::text,
         '👀 只是給你看'

  union all
  select 8, '⑧★★ 時薪工資**不該**有對應收入',
         coalesce((select string_agg(k, '、') from hour_exp h
                    where exists (select 1 from public.orders o
                                   where o.order_key = 'HKREV|' || h.k)), '（沒有）'),
         case when (select he from n) = 0 then '⚠ 沒有時薪工資，這一條不算數'
              when exists (select 1 from hour_exp h
                            where exists (select 1 from public.orders o
                                           where o.order_key = 'HKREV|' || h.k))
              then '❌ 有 —— 那是安幸付給員工的錢，不是向誰收的'
              else '✅ 一筆都沒有' end

  -- ══════════ 人事費 ══════════
  union all
  select 9, '⑨ 人事費：支出 vs 收入',
         (select count(*) from labor_exp)::text || ' 支出（NT$ '
         || coalesce((select sum(amount) from labor_exp), 0)::text || '）　'
         || (select count(*) from labor_inc)::text || ' 收入（NT$ '
         || coalesce((select sum(amount) from labor_inc), 0)::text || '）',
         case when (select le + li from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when (select count(*) from labor_inc)
                 <= (select count(*) from labor_exp)
              then '✅ 收入不多於支出（只有正隆成對，其餘只有支出）'
              else '❌ 收入比支出多 —— 有憑空多出來的收入' end

  union all
  select 10, '⑩★★ 人事費收入配得到支出而且同額',
         coalesce((select string_agg(i.k || '（收 ' || i.amount::text || '）', '、')
                     from labor_inc i
                    where not exists (select 1 from labor_exp e
                                       where e.k = i.k and e.amount = i.amount)),
                  '（都配得到）'),
         case when (select li from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when exists (select 1 from labor_inc i
                            where not exists (select 1 from labor_exp e
                                               where e.k = i.k and e.amount = i.amount))
              then '❌ 有收入配不到同額的支出'
              else '✅ 每一筆都配得到' end

  -- ══════════ 重複 ══════════
  union all
  select 11, '⑪★★★ 同一份工被產生兩次',
         coalesce((select string_agg(k || '×' || n::text, '、')
                     from (select k, count(*) n from clean_exp group by k having count(*) > 1) t),
                  '（沒有）'),
         case when (select ce from n) = 0 then '⚠ 母體是 0，這一條不算數'
              when exists (select 1 from (select k from clean_exp group by k having count(*) > 1) t)
              then '❌ 有重複 —— 唯一索引沒擋住，帳會多算'
              else '✅ 沒有重複' end

  -- ══════════ 收入掛在哪 ══════════
  union all
  select 12, '⑫ 房務收入掛在哪（物業／房源）',
         /*
          * ★★ 分組要在**內層**，字串在外層拼。
          *   `group by 1` 而第 1 欄含 count(*) → 42803
          *   （2026-09-09 踩過，跟查侯安琪那支同一種錯）。
          */
         coalesce((select string_agg(g.lbl || ' ×' || g.n::text, '　' order by g.lbl)
                     from (select coalesce(s.name, '（無物業）') || '／'
                                  || coalesce(pr.name, o.property_raw, '（無房源）') as lbl,
                                  count(*) as n
                             from public.orders o
                             left join public.estates s on s.id = o.estate_id
                             left join public.properties pr on pr.id = o.property_id
                             cross join params p
                            where (o.order_key like 'HKREV|%' or o.order_key like 'HKLABREV|%')
                              and o.checkin between p.d1 and p.d2
                            group by 1) g), '（沒有）'),
         '👀 現在應該全部是「安幸辦公室／（無房源）」'

) v(ord, "檢查", "結果", "判定") order by v.ord;
