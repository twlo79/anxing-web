/*
 * migration_201 —— 補 migration_200 漏掉的 hk_task
 * ============================================================
 * 2026-09-02。200 跑完的自檢 ② 露出一張我沒列到的表:
 *
 *     hk_task.hk_task_read   SELECT　(auth.role() = 'authenticated')
 *     hk_task.hk_task_write  全部　　(current_role_of() = ANY (ARRAY['manager','super_admin']))
 *                                                        ↑ 沒有 accountant
 *
 * ============================================================
 * 【★★★ 我為什麼會漏 —— 以及這支怎麼改掉那個做法】
 *
 * 200 的表名清單是**照著 `schema-baseline.sql` 抄的**。
 * 而 baseline 已經過期:那份檔案裡沒有 hk_task，也沒有那五條 `_read`。
 *
 * 200 的自檢 ③ 我寫「跑之前是 15（10 全部 ＋ 5 唯讀）」，
 * 實際回來的是 **18（12 全部 ＋ 6 唯讀）**。
 * 多出來的 3 條是 hk_task 那 2 條，加上 hk_work_type 額外的 `_write`。
 *
 * ★★ 硬寫清單的代價就是這個:**漏掉的東西不會叫**。
 *   自檢說 ✅ 11/11，因為我只問了我列出來的那 11 條。
 *   真正該問的是「**所有** hk_ 的寫入 policy 都含 accountant 了嗎」。
 *
 * ★ 所以這支不列表名，掃 `relname like 'hk\_%'` 的全部 ——
 *   將來再多一張表也會被掃到（CLAUDE.md:「同一條規則在三個地方各寫一次」，
 *   而硬寫清單就是把規則抄成第二份）。
 *
 * ============================================================
 * 【hk_task 是什麼 —— 為什麼非開不可】
 *
 * 行事曆分頁的工作（`calendar-tab.tsx:214/215/233` 新增／編輯／刪除）。
 * 而 `housekeeping/page.tsx` 已經把 `canEdit` 傳給 CalendarTab ——
 * 也就是**會計看得到那些按鈕**。
 *
 * ★ 新增與編輯有檢查影響列數，會跳「你的帳號沒有排班的權限」（那是對的）。
 * ★★ 但**刪除沒有檢查** —— 按了跳「已刪除」，重新整理東西還在。
 *   那一段一起修（見 calendar-tab.tsx）。
 *
 * ============================================================
 * 【不碰的東西】
 *
 *   · 純 SELECT 的 policy 一律不動（`polcmd = 'r'`）。
 *     hk_task_read 用的是 `auth.role() = 'authenticated'`，
 *     跟其他五條 `current_role_of() is not null` 又不一樣 ——
 *     但兩種都已經放行會計，沒有理由去動它。
 *
 *   · 形狀不認得的**寫入** policy 照樣中止，這一條沒放寬。
 */

do $do$
declare
  r record;
  v_expr  text := $q$current_role_of() = any (array['accountant','manager','super_admin'])$q$;
  n_alt   int := 0;
  n_skip  int := 0;
  n_read  int := 0;
  bad     text[] := array[]::text[];
 begin
  for r in
    select c.relname::text as tbl, p.polname::text as pol, p.polcmd,
           coalesce(pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as w
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     -- ★ 不列表名。掃全部 hk_ ——「漏掉一張」這件事不該再發生一次
     where n.nspname = 'public' and c.relname like 'hk\_%'
     order by c.relname, p.polname
  loop
    if r.polcmd = 'r' then
      n_read := n_read + 1;                       -- 唯讀的不碰
      continue;
    end if;

    if position('accountant' in r.q) > 0 and position('accountant' in r.w) > 0 then
      n_skip := n_skip + 1;                       -- 200 已經改過的
    elsif position('current_role_of()' in r.q) > 0
      and position('manager' in r.q) > 0
      and position('super_admin' in r.q) > 0 then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     r.pol, r.tbl, v_expr, v_expr);
      n_alt := n_alt + 1;
    else
      bad := bad || (r.tbl || '.' || r.pol || '（' || r.polcmd::text || '）→ using: ' || left(r.q, 120));
    end if;
  end loop;

  if array_length(bad, 1) > 0 then
    raise exception E'有 % 條**寫入** policy 的形狀跟我看過的不一樣，整支中止（什麼都沒改）：\n%',
      array_length(bad, 1), array_to_string(bad, E'\n');
  end if;

  raise notice '改了 % 條，已經開過的 % 條，唯讀不碰的 % 條', n_alt, n_skip, n_read;
 end $do$;

comment on table public.hk_task is
  '行事曆上的房務工作。**會計可讀可寫**（migration_201）—— '
  '行事曆分頁的新增／編輯／刪除寫的是這張。'
  '★ 從訂單自動長出來的那些不能直接刪（calendar-tab.tsx 的 isAuto）。';


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('201_hk_task_accountant');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 這次的基準值是「**全部** hk_ 的寫入 policy」，不是我列的那幾張 ——
--   200 就是敗在基準值只涵蓋我想得到的範圍（CLAUDE.md:自檢沒涵蓋合法形狀）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 全部 hk_ 的寫入 policy 都含 accountant',
         (select case when count(*) filter (where not has_acc) = 0
                      then '✅ ' || count(*)::text || ' 條全過'
                      else '⚠⚠ 還有 ' || count(*) filter (where not has_acc)::text
                           || ' 條沒有：'
                           || string_agg(tbl || '.' || pol, '、') filter (where not has_acc) end
            from (
              select c.relname as tbl, p.polname as pol,
                     coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%accountant%'
                 and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%accountant%'
                       as has_acc
                from pg_policy p
                join pg_class c on c.oid = p.polrelid
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname like 'hk\_%' and p.polcmd <> 'r'
            ) z),
         '★★★ 這一列問的是**全部**，不是我列出來的那幾張 —— '
           || '200 的 ①「✅ 11/11」是真的，只是它沒問到 hk_task'

  union all
  select 2, '★★ ② hk_task 的兩條',
         (select string_agg(p.polname || '　'
                   || case p.polcmd when 'r' then 'SELECT' when '*' then '全部'
                                    else p.polcmd::text end
                   || '　' || left(coalesce(pg_get_expr(p.polqual, p.polrelid), '（無）'), 90),
                   E'\n' order by p.polname)
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'hk_task'),
         '★ write 那條要變成 accountant／manager／super_admin；'
           || 'read 那條維持 auth.role() = ''authenticated'' 不動'

  union all
  select 3, '③ policy 條數：跑之前是 18（12 全部 ＋ 6 唯讀）',
         (select count(*) filter (where p.polcmd = '*')::text || ' 條全部　＋　'
                 || count(*) filter (where p.polcmd = 'r')::text || ' 條唯讀　＝　'
                 || count(*)::text || ' 條'
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%'),
         '★ 這支只 alter，一條都不新增不刪除。18 是 200 跑完實際回報的數字，'
           || '不是我從 baseline 推的（baseline 已經過期）'

  union all
  select 4, '④ 全部 hk_ 表都還開著 RLS',
         (select case when count(*) filter (where not c.relrowsecurity) = 0
                      then '✅ ' || count(*)::text || ' 張全部開著'
                      else '⚠⚠⚠ 有 ' || count(*) filter (where not c.relrowsecurity)::text
                           || ' 張被關掉了 —— 那是誰都寫得進去' end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%' and c.relkind = 'r'),
         '★ 這支不該碰 RLS 開關'

  union all
  select 5, '⑤ 有幾張 hk_ 表一條寫入 policy 都沒有',
         (select case when count(*) = 0 then '✅ 沒有'
                      else '⚠ ' || string_agg(c.relname, '、')
                           || ' —— 開了 RLS 卻沒有寫入 policy，那是全部擋掉' end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%' and c.relkind = 'r'
             and c.relrowsecurity
             and not exists (select 1 from pg_policy p
                              where p.polrelid = c.oid and p.polcmd <> 'r')),
         '★★ 這種表的症狀跟 RLS 擋掉一模一樣:回成功、影響 0 列。'
           || '200 沒問這一題 —— 順手補上'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
