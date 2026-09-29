/* 一次性：刪掉測試用的請假單（2026-09-29 David 指定）
 *   年假（特休）8 小時、2026-09-02 09:30 → 17:30、事由 Test、狀態 已駁回（Test）
 * 只刪剛好符合上面全部條件的那一筆；找到的不是剛好 1 筆就整支停下來，不猜。
 * 已駁回的單不占額度（used_hours 只算 approved），所以不用動 leave_balances。
 * ★★ 自檢在 commit 後面 —— 看不到就是整支回滾了。 */
begin;

create temp table _del as
select r.id, r.user_id, p.name as 申請人, r.type_code, r.hours,
       (r.start_at at time zone 'Asia/Taipei') as 起, (r.end_at at time zone 'Asia/Taipei') as 迄, r.reason, r.status, r.reject_reason
  from public.leave_requests r join public.profiles p on p.id = r.user_id
 where r.status = 'rejected'
   and (r.start_at at time zone 'Asia/Taipei')::date = date '2026-09-02'
   and r.hours = 8
   and coalesce(r.reason, '') = 'Test';

do $$
declare n int;
begin
  select count(*) into n from _del;
  if n <> 1 then
    raise exception '符合條件的不是剛好 1 筆（找到 % 筆），停下來不刪 —— 貼 _del 的內容給我', n;
  end if;
end $$;

delete from public.leave_requests r using _del d where r.id = d.id;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '刪掉的那一筆' as 檢查,
       (select 申請人 || '・' || type_code || ' ' || hours || 'h・' || to_char(起, 'MM/DD HH24:MI') || '→' || to_char(迄, 'HH24:MI') || '・' || status || '：' || coalesce(reject_reason, '') from _del) as 結果,
       '✅' as 判定
union all select 2, '刪完還在不在',
       (select count(*)::text from public.leave_requests r where r.id in (select id from _del)),
       case when (select count(*) from public.leave_requests r where r.id in (select id from _del)) = 0 then '✅ 沒了' else '❌ 還在' end
union all select 3, '這個人 2026-09-02 還有沒有其他請假',
       (select count(*)::text from public.leave_requests r where r.user_id = (select user_id from _del) and (r.start_at at time zone 'Asia/Taipei')::date = date '2026-09-02'),
       'ℹ 0 就是乾淨了'
order by 1;
