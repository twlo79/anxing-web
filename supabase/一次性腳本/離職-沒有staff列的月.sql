/* ══════════════════════════════════════════════════════════════════════
 * 出勤頁有兩個「月」，權限管理只有一個                                   2026-09-29
 *
 * 【為什麼】profiles 裡有兩個「月」（兩個登入帳號），staff 只剩一列指著其中一個。
 *   另一個是孤兒 profile —— 權限管理看不到它，所以沒有地方可以按「設為離職」，
 *   它就一直留在出勤頁上。
 *
 * 【做什麼】沒有 staff 列指著的「月」→ profiles.active = false。
 *   有 staff 列的那個不動 —— 那個到權限管理按「設為離職」（推了新版之後那顆會連 profiles 一起改）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _orphan (uid uuid, name text);

with todo as (
  update public.profiles p set active = false
   where p.name = '月' and p.active
     and not exists (select 1 from public.staff s where s.auth_uid = p.id)
  returning p.id, p.name
)
insert into _orphan select id, name from todo;

commit;

-- ═══ 自檢 ═══════════════════════════════════════════════════════════
select 1 as 序, '這次設為離職的孤兒 profile（要 1）' as 檢查,
       (select count(*)::text from _orphan) as 結果,
       case (select count(*) from _orphan) when 1 then '✅' when 0 then 'ℹ 沒有孤兒 —— 兩個月都在 staff 裡？看第 3 列' else '⚠ 不只一個，看第 3 列' end as 判定
union all
select 2, '出勤頁現在會列的人',
       (select string_agg(name, '、' order by name) from public.profiles where active),
       case when (select count(*) from public.profiles where active and name = '月') <= 1 then '✅ 剩一個月' else '❌ 還有兩個' end
union all
select 3, '所有叫「月」的 profile（在職？有 staff 列？）',
       (select string_agg(format('%s：profiles %s／staff %s', left(p.id::text, 8),
                                 case when p.active then '在職' else '離職' end,
                                 coalesce((select case when s.active then '在職' else '離職' end from public.staff s where s.auth_uid = p.id), '沒有列')), '；')
          from public.profiles p where p.name = '月'),
       'ℹ 有 staff 列的那個到權限管理按「設為離職」'
order by 1;
