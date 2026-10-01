/* ══════════════════════════════════════════════════════════════════════
 * 測試帳號（dianne@gmail.com）：profiles 的名字從「月」改成「test」，跟 staff 那列同名        2026-10-01
 *
 * 【為什麼】同一個帳號在 staff 叫 test、在 profiles 叫 月 —— 在職名單、活動上傳的下拉、
 *   假別額度都是讀 profiles，所以到處出現一個已經離職的「月」。David：test 是測試用，留著。
 *
 * 【做什麼】只改這一列的 name。用登入 email 找人，不用名字（還有另一個已停用的「月」）。
 *   跑第二次沒事。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

update public.profiles p
   set name = 'test'
 where p.id = (select id from auth.users where email = 'dianne@gmail.com')
   and p.name <> 'test';

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, 'dianne@gmail.com 在 profiles 叫什麼' as 檢查,
       (select name || '・' || role || case when active then '・在職' else '・離職' end
          from public.profiles where id = (select id from auth.users where email = 'dianne@gmail.com')) as 結果,
       case when (select name from public.profiles where id = (select id from auth.users where email = 'dianne@gmail.com')) = 'test'
            then '✅' else '❌' end as 判定
union all
select 2, '在職名單裡還有沒有「月」',
       (select count(*)::text from public.profiles where name = '月' and active),
       case when (select count(*) from public.profiles where name = '月' and active) = 0 then '✅ 沒有了' else '❌' end
order by 1;
