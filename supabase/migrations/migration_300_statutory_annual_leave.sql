/* ══════════════════════════════════════════════════════════════════════
 * migration_300  特休級距改勞基法 ＋ 新假別「公司特休」                      2026-09-29
 *
 * 【為什麼】David：「用勞基法算特休，然後設計一個公司額外特休假」。
 *   leave_seniority 原本是「法定 ＋ 安幸加給」混在一起的表（migration_99），
 *   而法定與公司加碼要**分開記** —— 年底對勞基法時法定那份才一目了然。
 *
 * 【這支做什麼】
 *   1. leave_seniority 改成勞基法 38 條：6 月→3、1 年→7、2 年→10、3 年→14、5 年→15、10 年→15
 *      （10 年以上「每滿一年 +1、上限 30」那條規則在前端 lib/annual-leave.ts，表只放級距）。
 *   2. leave_types 加 company_annual「公司特休」：有額度、給薪、排在年假後面。
 *      額度在假別額度頁逐人填 —— 公司想給誰幾天自己決定，不寫公式。
 *
 * 【不動的】已經填好的 leave_balances 額度一筆都不改（畫面上會顯示「建議 N 天」讓人套用）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 1. 級距改法定。刪掉重建（表只有六列、沒有 FK 指過來）
delete from public.leave_seniority;
insert into public.leave_seniority (threshold_months, days, note) values
  (6,   3,  '勞基法 38 條：6 個月以上未滿 1 年'),
  (12,  7,  '勞基法 38 條：1 年以上未滿 2 年'),
  (24,  10, '勞基法 38 條：2 年以上未滿 3 年'),
  (36,  14, '勞基法 38 條：3 年以上未滿 5 年'),
  (60,  15, '勞基法 38 條：5 年以上未滿 10 年'),
  (120, 15, '勞基法 38 條：10 年以上，每滿一年加 1 天、上限 30（那條規則在 lib/annual-leave.ts）');

comment on table public.leave_seniority is
  '特休級距（勞基法 38 條，migration_300 改）。threshold_months = 做滿幾個月（含），days = 那一級的天數。'
  '公司加碼不放這裡 —— 走假別「公司特休」逐人填額度。';

-- 2. 公司特休
insert into public.leave_types (code, name, has_quota, paid, sort, active, note) values
  ('company_annual', '公司特休', true, true, 15, true,
   '公司額外給的特休（法定之外）。額度在假別額度頁逐人填，不套公式（migration_300）。')
on conflict (code) do update
  set name = excluded.name, has_quota = excluded.has_quota, paid = excluded.paid,
      sort = excluded.sort, active = true, note = excluded.note;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('300_statutory_annual_leave');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '300_statutory_annual_leave') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '300_statutory_annual_leave') then '✅' else '❌' end as 判定
union all select 2, '級距表（月→天）',
       (select string_agg(threshold_months || '→' || days, '、' order by threshold_months) from public.leave_seniority),
       case when (select string_agg(threshold_months || '→' || days, '、' order by threshold_months) from public.leave_seniority) = '6→3、12→7、24→10、36→14、60→15、120→15'
            then '✅ 勞基法' else '❌ 跟勞基法不一樣' end
union all select 3, '假別 company_annual',
       coalesce((select name || '・有額度 ' || has_quota || '・給薪 ' || paid || '・sort ' || sort from public.leave_types where code = 'company_annual'), '沒有'),
       case when exists (select 1 from public.leave_types where code = 'company_annual' and active and has_quota) then '✅' else '❌' end
union all select 4, '既有額度一筆都沒動（leave_balances 筆數／額度合計）',
       (select count(*)::text || ' 筆・' || coalesce(sum(quota_hours), 0)::text || ' 小時' from public.leave_balances),
       'ℹ 跟跑之前一樣就對'
order by 1;
