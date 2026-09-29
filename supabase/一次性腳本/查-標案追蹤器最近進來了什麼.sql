-- 只讀。標案追蹤器（tender_feed）最近 14 天每一次匯入進來幾筆、最新的幾筆是什麼。
-- 爬蟲 9/29 推播了 2 筆（台鐵板橋文化段土地出租…），這裡看得到才算「進來了」。
select 1 as 序, '最近 14 天每一次匯入' as 檢查,
       coalesce((select string_agg(to_char(run_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI') || '：' || n || ' 筆', '、' order by run_at desc)
          from (select run_at, count(*) n from public.tender_feed
                 where run_at >= now() - interval '14 days' group by run_at) x), '（14 天內一筆都沒進來）') as 結果
union all
select 2, '最新 5 筆',
       coalesce((select string_agg(to_char(run_at at time zone 'Asia/Taipei', 'MM/DD') || ' ' || source || '｜' || left(title, 40), E'\n' order by run_at desc)
          from (select * from public.tender_feed order by run_at desc limit 5) y), '（空的）')
union all
select 3, '總筆數／最早一筆',
       (select count(*)::text || ' 筆，最早 ' || coalesce(to_char(min(run_at) at time zone 'Asia/Taipei', 'YYYY-MM-DD'), '—') from public.tender_feed)
order by 1;
