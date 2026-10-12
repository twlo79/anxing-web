/*
 * migration_329_attendance_fix_user_default.sql　2026-10-08
 * 補登打卡送不出去：user_id 補預設值
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。
 *
 * 【原因】管家「花」補 10/06 下班卡：new row violates row-level security policy for table "attendance_fixes"
 *   · 寫入規則 afix_self 是 `user_id = auth.uid()`（只能替自己送）
 *   · 畫面送出時沒帶 user_id，這一欄又沒有預設值 → user_id 是空的 → 規則判不過
 *   · 所以不只花，**每一個人**的補登都送不出去（花以前送過的補登是 0 筆）
 *
 * 【這一支】user_id 預設 auth.uid()。畫面那邊這次也改成明確帶 user_id，兩層都有。
 *   ★ 規則不動：還是只能替自己送，主管、總經理照舊可以審。
 * ══════════════════════════════════════════════════════════
 */

begin;
alter table public.attendance_fixes alter column user_id set default auth.uid();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('329_attendance_fix_user_default');
  end if;
end $do$;
commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 'user_id 預設值' as 檢查, coalesce(column_default, '（沒有）') as 結果,
       case when column_default like '%auth.uid()%' then '✅' else '❌' end as 判定
  from information_schema.columns
 where table_schema = 'public' and table_name = 'attendance_fixes' and column_name = 'user_id'
union all
select '寫入規則還是「只能替自己送」', pg_get_expr(polwithcheck, polrelid),
       case when pg_get_expr(polwithcheck, polrelid) like '%auth.uid()%' then '✅' else '❌' end
  from pg_policy where polrelid = 'public.attendance_fixes'::regclass and polname = 'afix_self';
