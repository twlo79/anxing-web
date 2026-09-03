-- ============================================================
-- 唯讀。各月收租情況：該收多少、收了多少、還欠多少。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--
-- ============================================================
-- 【★★ 這一支用「租的月份」不是「應繳日」】
--
-- 逐月現金流那一支問的是「錢什麼時候進來」，所以照**應繳日**分月。
-- 這一支問的是「哪一個月的租收齊了沒」，所以照**月租單自己的月份**分。
--
-- 兩張表的同一個月份會是不同的數字，那是對的 ——
-- 因為安幸是預繳制，7 月的租金 6 月收。
-- 拿兩張表互相對數字之前，先想清楚問的是不是同一件事
-- （CLAUDE.md：拿兩個問法不同的檢查互相比較，2026-09-02 踩過）。
--
-- 【範圍】過去 12 個月 ＋ 未來 12 個月。
--   過去的看催收，未來的看還有多少沒進來。
-- ============================================================

select to_char(date_trunc('month', o.checkin), 'YYYY/MM') as 租的月份,

       count(*)                                            as 幾張月租單,
       sum(o.amount)                                       as 該收,

       sum(case when o.paid then o.amount else 0 end)      as 已收,
       sum(case when o.paid then 0 else o.amount end)      as 未收,

       -- ★ 百分比放最後。先看金額 —— 90% 收齊但缺的是那筆 252 萬年繳
       --   跟 90% 收齊缺的是一筆 3 萬，是完全不同的兩件事
       case when sum(o.amount) = 0 then null
            else round(100.0 * sum(case when o.paid then o.amount else 0 end)
                       / sum(o.amount), 1) end             as 收齊百分比,

       case when date_trunc('month', o.checkin) > date_trunc('month', current_date)
              then '未來 —— 還沒到收款時間，未收是正常的'
            when sum(case when o.paid then 0 else o.amount end) = 0
              then '✅ 收齊'
            when date_trunc('month', o.checkin) = date_trunc('month', current_date)
              then '⚠ 本月，還在收'
            else '❌ 過去的月份還有未收 —— 要催'
       end                                                 as 判定

  from public.orders o
 where o.source in ('longterm','company','office')
   and o.checkin >= date_trunc('month', current_date) - interval '12 months'
   and o.checkin <  date_trunc('month', current_date) + interval '12 months'
 group by date_trunc('month', o.checkin)
 order by date_trunc('month', o.checkin);
