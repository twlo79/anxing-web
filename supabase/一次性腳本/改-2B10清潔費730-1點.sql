/* 改：2B10 的打掃點數 1、清潔費 730（David 2026-10-05：「1 點，然後 730」）
 *   原本 2B10 的清潔費是 9000（跟其他正隆房間一樣的預設），上一支腳本「有值就不碰」所以留著。
 *   2B10 現在就是房務的「正隆2樓」公區 —— 清潔費照公區算。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
begin;
update public.properties p set clean_points = 1, clean_price = 730
  from public.estates e
 where e.id = p.estate_id and e.name = '正隆' and p.name = '2B10'
   and (p.clean_points is distinct from 1 or p.clean_price is distinct from 730);
commit;

select '2B10 現在' as 檢查,
       (select p.clean_points || ' 點・$' || p.clean_price::int from public.properties p
          join public.estates e on e.id = p.estate_id where e.name = '正隆' and p.name = '2B10') as 結果,
       case when exists (select 1 from public.properties p join public.estates e on e.id = p.estate_id
                          where e.name = '正隆' and p.name = '2B10' and p.clean_points = 1 and p.clean_price = 730)
            then '✅' else '❌' end as 判定;
