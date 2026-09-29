/* ══════════════════════════════════════════════════════════════════════
 * migration_301  新假別「補休」                                             2026-09-29
 *
 * 【為什麼】David：「多一個補休假」。加班換的休假，跟年假、公司特休分開記。
 *
 * 【這支做什麼】leave_types 加 comp「補休」：有額度、給薪、排在公司特休後面。
 *   額度在假別額度頁填；畫面會把「今年已核可的加班時數」列成建議，按套用才寫進去 —— 不自動。
 *   （加班一小時換一小時補休；要換不同比例的話直接改額度那格。）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

insert into public.leave_types (code, name, has_quota, paid, sort, active, note) values
  ('comp', '補休', true, true, 18, true,
   '加班換的休假。額度在假別額度頁填，畫面會把今年已核可的加班時數列成建議（migration_301）。')
on conflict (code) do update
  set name = excluded.name, has_quota = excluded.has_quota, paid = excluded.paid,
      sort = excluded.sort, active = true, note = excluded.note;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('301_comp_leave');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '301_comp_leave') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '301_comp_leave') then '✅' else '❌' end as 判定
union all select 2, '假別 comp',
       coalesce((select name || '・有額度 ' || has_quota || '・給薪 ' || paid || '・sort ' || sort from public.leave_types where code = 'comp'), '沒有'),
       case when exists (select 1 from public.leave_types where code = 'comp' and active and has_quota) then '✅' else '❌' end
union all select 3, '啟用中的假別（照順序）',
       (select string_agg(name, ' → ' order by sort) from public.leave_types where active),
       'ℹ 年假 → 公司特休 → 補休 → 病假 → 事假'
order by 1;
