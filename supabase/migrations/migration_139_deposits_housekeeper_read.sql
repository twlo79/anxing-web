-- migration_139：管家（與房務）看得到押金，但改不了
--
-- ============================================================
-- 【要做什麼】（2026-08-17 使用者指定）
--
-- 管家要能查押金 —— 房客問「我的押金退了沒」時，
-- 現在他得去找會計。加一條唯讀的 policy。
--
-- **只加 select，不動 dep_write。** 寫入仍然只有
-- accountant / manager / super_admin。
--
--
-- ============================================================
-- 【⚠ 房務（cleaner）也會一起看到】
--
-- migration_131 建 `cleaner` 角色時寫得很清楚:
--
--     cleaner 只收窄選單，**不是權限隔離** ——
--     RLS 跟 housekeeper 相同，知道網址還是進得去。
--
-- 所以這條 policy 一開，清潔人員也讀得到押金金額。
-- 側邊欄不給他們 `/deposits` 這一項，但那擋不住直接打網址。
--
-- 要真的擋住的話，policy 要寫成 `= 'housekeeper'` 而不是 `in (…)`——
-- 但那會讓 cleaner 與 housekeeper 第一次出現 RLS 差異，
-- 而其他二十幾張表都還是「兩者相同」。
--
-- **這裡照使用者說的做（管家看得到），並把 cleaner 一併放行** ——
-- 保持「cleaner 的 RLS ≡ housekeeper」這條不變式。
-- 要改成真正隔離的話，那是一次全面的決定，不該從押金開始。

drop policy if exists dep_read_hk on public.deposits;

create policy dep_read_hk on public.deposits for select
  using (current_role_of() in ('housekeeper', 'cleaner'));

comment on table public.deposits is
  '押金。讀:accountant/manager/super_admin（dep_read）＋ housekeeper/cleaner（dep_read_hk，唯讀）。'
  '寫:僅 accountant/manager/super_admin（dep_write）。'
  '⚠ cleaner 的 RLS 與 housekeeper 相同（migration_131）—— 側邊欄不給,但打網址進得去。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('139_deposits_housekeeper_read');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk139;
  create temp table _chk139 (ord int, item text, result text, detail text);

  insert into _chk139 values (1, 'dep_read_hk 讀取 policy',
    case when exists (select 1 from pg_policy
                       where polrelid = 'public.deposits'::regclass and polname = 'dep_read_hk')
         then '✅' else '❌' end, '管家／房務唯讀');

  /*
   * 【最重要的一條】寫入沒有被放寬。
   *
   * 只加 select 卻不小心把 for all 的那條也改到的話，
   * 管家就能改押金金額 —— 而那不會有任何徵兆,
   * 直到某一筆金額對不上帳。
   */
  select count(*) into n from pg_policy
   where polrelid = 'public.deposits'::regclass
     and polcmd in ('*', 'w', 'a', 'd')
     and pg_get_expr(polqual, polrelid) like '%housekeeper%';
  insert into _chk139 values (2, '★★ 管家不能寫入',
    case when n = 0 then '✅ 沒有任何寫入 policy 含 housekeeper'
         else '❌ 有 ' || n || ' 條寫入 policy 放行了管家' end,
    '只加 select,dep_write 不動');

  insert into _chk139
  select 5, '　policy：' || polname,
         case polcmd when 'r' then 'SELECT' when '*' then 'ALL'
                     when 'a' then 'INSERT' when 'w' then 'UPDATE'
                     when 'd' then 'DELETE' else polcmd::text end,
         pg_get_expr(polqual, polrelid)
    from pg_policy where polrelid = 'public.deposits'::regclass
   order by polname;

  insert into _chk139 values (8, '⚠ 房務（cleaner）也讀得到', '是',
    'migration_131:cleaner 的 RLS ≡ housekeeper。側邊欄不給,但打網址進得去');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk139 order by ord, item;
