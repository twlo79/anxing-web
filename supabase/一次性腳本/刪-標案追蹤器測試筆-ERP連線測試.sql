/* 一次性：刪掉標案追蹤器裡的連線測試筆（2026-09-29 David 指定）
 *   來源「ERP連線測試」、標題「【ERP連線測試，可忽略】…」。
 * 連同它加星建出來的 tenders 紀錄（如果有）一起刪。只刪來源是 ERP連線測試 的，別的不碰。
 * ★★ 自檢在 commit 後面 —— 看不到就是整支回滾了。 */
begin;

create temp table _feed as
select id, source, title, agency, posted_on, run_at
  from public.tender_feed
 where source = 'ERP連線測試' or title like '【ERP連線測試%';

create temp table _tend as
select t.id, t.name, t.status
  from public.tenders t
 where t.feed_id in (select id from _feed) or t.name like '【ERP連線測試%';

delete from public.tenders     t where t.id in (select id from _tend);
delete from public.tender_feed f where f.id in (select id from _feed);

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '刪掉的追蹤器筆數' as 檢查,
       (select count(*)::text || '：' || coalesce(string_agg(left(title, 30), '、'), '') from _feed) as 結果,
       case when (select count(*) from _feed) between 1 and 3 then '✅' when (select count(*) from _feed) = 0 then 'ℹ 本來就沒有' else '⚠ 超過 3 筆，看一下是不是真的都是測試' end as 判定
union all select 2, '連帶刪掉的紀錄（加星建的）',
       (select count(*)::text from _tend), 'ℹ 0 就是沒加過星'
union all select 3, '刪完還在不在',
       (select count(*)::text from public.tender_feed where source = 'ERP連線測試' or title like '【ERP連線測試%'),
       case when (select count(*) from public.tender_feed where source = 'ERP連線測試' or title like '【ERP連線測試%') = 0 then '✅ 沒了' else '❌ 還在' end
order by 1;
