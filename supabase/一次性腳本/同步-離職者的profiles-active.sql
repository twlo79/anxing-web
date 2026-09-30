/* ══════════════════════════════════════════════════════════════════════
 * 離職的人從出勤頁消失：把 staff.active 同步到 profiles.active         2026-09-29
 *
 * 【為什麼】權限管理的「設為離職」只改 staff.active ＋ 封鎖帳號，
 *   而出勤（假別額度、公告）看的是 profiles.active —— 兩份資料各存一次，
 *   離職的人就一直留在假別額度表上（兩個「月」）。
 *   API 已經改成兩欄一起改；這支把**已經**離職的補齊。
 *
 * 【做什麼】staff 是離職（active = false）而 profiles 還是在職的 → 改成離職。
 *   反向（staff 在職、profiles 離職）只列出來不動 —— 那種要人看過。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _sync (name text, uid uuid);

with todo as (
  update public.profiles p set active = false
    from public.staff s
   where s.auth_uid = p.id and s.active = false and p.active = true
  returning p.name, p.id
)
insert into _sync select name, id from todo;

commit;

-- ═══ 自檢 ═══════════════════════════════════════════════════════════
select 1 as 序, '這次改成離職的（profiles）' as 檢查,
       coalesce((select string_agg(name, '、') from _sync), '沒有') as 結果,
       case when exists (select 1 from _sync) then '✅' else 'ℹ 本來就一致，或那幾個人在權限管理還沒設為離職' end as 判定
union all
select 2, '還留在出勤頁、但 staff 那邊已離職的（要 0）',
       coalesce((select string_agg(p.name, '、') from public.profiles p join public.staff s on s.auth_uid = p.id
                  where s.active = false and p.active = true), '沒有'),
       case when exists (select 1 from public.profiles p join public.staff s on s.auth_uid = p.id where s.active = false and p.active = true) then '❌' else '✅' end
union all
select 3, '反向：staff 在職、profiles 離職（只列不動）',
       coalesce((select string_agg(p.name, '、') from public.profiles p join public.staff s on s.auth_uid = p.id
                  where s.active = true and p.active = false), '沒有'),
       'ℹ 有的話到權限管理按「恢復在職」再「設為離職」一次就會對齊'
union all
select 4, '出勤頁現在會列的人（profiles 在職）',
       (select string_agg(name, '、' order by name) from public.profiles where active), 'ℹ'
union all
select 5, '權限管理裡在職名單（staff 在職、有帳號）',
       (select string_agg(name, '、' order by name) from public.staff where active and auth_uid is not null), 'ℹ 兩列要一樣'
order by 1;
