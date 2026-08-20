-- migration_153：所有員工都看得到彼此的姓名
--
-- ============================================================
-- 【症狀】（2026-08-19）
--
-- 請款單列表的「請款者」整欄是「—」。主管、會計看到的都一樣，
-- 只有 super_admin 看得到名字。
--
-- 同樣的症狀還出現在:押金的送審人、房源評價的負責人、
-- 回收桶的「誰刪的」、核可紀錄的「誰投的票」。
-- 那些欄位全部靠 profiles 查名字。
--
--
-- ============================================================
-- 【為什麼】
--
-- profiles 的讀取政策是:
--
--     profiles_self_read            id = auth.uid() OR super_admin
--     profiles_self_read_accountant id = auth.uid()
--
-- **除了 super_admin，每個人都只讀得到自己那一列。**
-- 前端拿不到別人的名字，只能印「—」。
--
-- 而那個「—」跟「這筆真的沒有請款者」長得一模一樣 ——
-- 所以看的人會以為是資料缺漏，不會想到是權限。
--
--
-- ============================================================
-- 【為什麼開放是安全的】
--
-- profiles 這張表只有四欄:id / name / role / active。
--
--   · 沒有 email、沒有電話、沒有薪資、沒有任何個資
--   · 姓名與角色本來就是公司內部人人都知道的事
--     （請款單上本來就印著「誰送的」，只是查不到名字）
--
-- 開放的是**讀取**，寫入完全不動 —— 改別人的角色仍然只有
-- super_admin 做得到（profiles_admin_write 不變）。
--
-- ★ 而且限定 `active` —— 離職的人不會出現在任何下拉選單裡。
--   但**已經存在的紀錄仍然查得到名字**（見下面的說明）。
--
--
-- ============================================================
-- 【為什麼是追加一條，不是改寫既有的】
--
-- Postgres 的 permissive policy 是 OR 關係。
-- 改寫既有那兩條的風險是「本來看得到的東西突然看不到」，
-- 而那種退步通常要等某個人某天打不開某一頁才會發現。
--
-- 追加一條只會讓可見範圍變大，不可能讓誰失去既有的權限。
-- 這也是這個 schema 一路以來的慣例（見 RLS 段落開頭的註解）。

create policy profiles_read_for_staff on public.profiles for select
  using (public.current_role_of() is not null);

comment on policy profiles_read_for_staff on public.profiles is
  '任何在職員工都讀得到 profiles（只有 id/name/role/active，無個資）。'
  '沒有這條的話，除了 super_admin 以外的人在請款者、送審人、負責人等'
  '欄位只會看到「—」，而那跟「資料真的沒填」長得一模一樣（migration_153）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('153_profiles_read_all');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk153;
  create temp table _chk153 (ord int, item text, result text, detail text);

  insert into _chk153 values (1, '★★ 新的讀取政策',
    case when exists (select 1 from pg_policy p
                       join pg_class c on c.oid = p.polrelid
                      where c.relname = 'profiles' and p.polname = 'profiles_read_for_staff')
         then '✅' else '❌' end,
    '在職員工都讀得到姓名');

  /*
   * ★★ 既有的政策一條都不能少。
   *
   * 這支只**追加**。少掉任何一條的症狀都是「某個角色某一頁突然打不開」，
   * 而那要等有人真的去點才會發現。
   */
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'profiles'
     and p.polname in ('profiles_self_read', 'profiles_self_read_accountant', 'profiles_admin_write');
  insert into _chk153 values (2, '★★ 既有政策', n || ' / 3',
    case when n = 3 then '✅ 都還在（這支只追加，沒改寫）' else '❌ 有政策不見了' end);

  /*
   * ★ 寫入權限不能變。
   *   改別人的角色仍然只有 super_admin 做得到。
   */
  insert into _chk153 values (3, '★ 寫入仍限 super_admin',
    case when exists (select 1 from pg_policy p
                       join pg_class c on c.oid = p.polrelid
                      where c.relname = 'profiles' and p.polname = 'profiles_admin_write'
                        and pg_get_expr(p.polqual, p.polrelid) like '%super_admin%')
         then '✅' else '❌' end,
    '這支只開放讀取');

  select count(*) into n from public.profiles where active;
  insert into _chk153 values (4, '在職員工', n || ' 人',
    '這些人的姓名之後在請款者、送審人、負責人等欄位都看得到');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk153 order by ord;


-- ============================================================
-- 目前有幾筆紀錄的「人」是查不到名字的
-- ============================================================
/*
 * 跑完這支之後，下面這幾個數字對非 super_admin 的使用者
 * 應該全部變成 0（在他們的視角）。
 *
 * 這裡用 super_admin 的視角跑，所以本來就查得到 ——
 * 它的用途是告訴你「有多少欄位依賴這張表」。
 */
select '請款單的請款者' as "欄位",
       count(*) as "筆數",
       count(*) filter (where p.id is null) as "查不到人的"
  from public.purchase_requests r
  left join public.profiles p on p.id = r.requester_id
union all
select '押金的送審人', count(*), count(*) filter (where p.id is null)
  from public.deposits d
  left join public.profiles p on p.id = d.refund_requested_by
 where d.refund_requested_by is not null
union all
select '請款單的主管票', count(*), count(*) filter (where p.id is null)
  from public.purchase_requests r
  left join public.profiles p on p.id = r.manager_approved_by
 where r.manager_approved_by is not null;
