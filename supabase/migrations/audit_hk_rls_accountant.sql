/*
 * audit_hk_rls_accountant —— 會計改得動房務的資料嗎（唯讀）
 * ============================================================
 * 2026-09-01 使用者：「開放給會計」「都開放」。
 *
 * 畫面那層已經放行了（`housekeeping/page.tsx` 的 canEdit）。
 * 但**畫面放行不等於改得動** —— 房務那幾張表的 RLS 才是最後一關。
 *
 * ★★★ 而 RLS 擋下來的 UPDATE／INSERT **會回成功而且影響 0 列**
 *   （CLAUDE.md 的坑）。所以症狀不是「被拒絕」，而是
 *   **按了儲存、跳「已儲存」、資料一個字都沒變** ——
 *   會計會以為自己記錯了，或者以為系統壞了。
 *
 * 這支只有 select。跑完把結果貼回來，我再決定要不要補一支 migration。
 */

select
  c.relname                                   as "表",
  c.relrowsecurity                            as "有沒有開 RLS",
  coalesce(p.polname, '（沒有任何 policy）')    as "policy",
  case p.polcmd
    when 'r' then 'SELECT' when 'a' then 'INSERT'
    when 'w' then 'UPDATE' when 'd' then 'DELETE'
    when '*' then '全部' else p.polcmd::text end as "管到哪個動作",
  /*
   * ★ policy 的條件原文。`accountant` 有沒有被寫進去，
   *   看這一欄最直接 —— 比推論可靠。
   */
  pg_get_expr(p.polqual, p.polrelid)          as "using 條件",
  pg_get_expr(p.polwithcheck, p.polrelid)     as "with check 條件",
  case
    when not c.relrowsecurity                       then '✅ 沒開 RLS —— 誰都寫得進去'
    when p.polname is null                          then '⚠⚠ 開了 RLS 卻沒有 policy —— 那是全部擋掉'
    when pg_get_expr(p.polqual, p.polrelid) ilike '%accountant%'
      or pg_get_expr(p.polwithcheck, p.polrelid) ilike '%accountant%'
                                                    then '✅ 條件裡有 accountant'
    when pg_get_expr(p.polqual, p.polrelid) ilike '%true%'
      or p.polqual is null                          then '✅ 沒有限制角色'
    else '⚠ 條件裡沒看到 accountant —— 會計可能寫不進去（而且不會報錯）'
  end                                         as "★ 判斷"
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('hk_event', 'hk_work_item', 'hk_day',
                    'hk_month_property', 'hk_property', 'hk_staff',
                    'hk_work_type', 'hk_setting')
order by c.relname, p.polname;
