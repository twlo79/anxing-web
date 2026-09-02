/*
 * migration_208 —— hk_labor_cost 的 RLS policy（206 漏了）
 * ============================================================
 * 2026-09-02 使用者：「人事費 為何是 0」
 *
 * 產生預覽上「人事費 0 筆 $0」，但 migration_206 的自檢 ② 明明列出六筆。
 *
 * ============================================================
 * 【★★★ 為什麼是 0】
 *
 * Supabase 有一個平台管理的 event trigger `rls_auto_enable()`，
 * **新建的表會自動開 RLS**（`schema-baseline.sql` 的檔頭就寫著這件事）。
 *
 * 而 migration_206 建了 `hk_labor_cost` 卻沒有給任何 policy ——
 * 開了 RLS 又沒有 policy 等於**全部擋掉**。
 *
 * ★★ 症狀不是「查詢失敗」，是**查詢成功、回 0 列**
 *   （CLAUDE.md 的坑:RLS 擋下的回成功且影響 0 列）。
 *   所以畫面上是一個很正常的「0 筆 $0」，沒有任何錯誤訊息。
 *
 * ★ migration_196 建 advance_payments 時我有寫 policy，這次漏了。
 *   **新建表一定要跟著寫 policy** —— 這條進 CLAUDE.md。
 *
 * ============================================================
 * 【給誰】
 *
 * 跟房務其他表一致（migration_200／201 之後）：accountant 以上。
 * 人事費是成本設定，房務阿姨不需要看得到。
 */

alter table public.hk_labor_cost enable row level security;

do $do$ begin
  begin
    create policy hk_labor_cost_all on public.hk_labor_cost
      for all
      using (current_role_of() = any (array['accountant','manager','super_admin']))
      with check (current_role_of() = any (array['accountant','manager','super_admin']));
  exception when duplicate_object then null; end;
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('208_hk_labor_rls');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① policy 建好了',
         (select case when count(*) = 1
                      then '✅ ' || max(p.polname)
                           || '　' || max(pg_get_expr(p.polqual, p.polrelid))
                      else '⚠⚠⚠ 有 ' || count(*)::text || ' 條 —— 0 條的話畫面還是會看到 0 筆' end
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'hk_labor_cost'),
         '★ 要看到 accountant／manager／super_admin 三個角色'

  union all
  select 2, '② 資料還在（policy 不影響資料）',
         (select count(*)::text || ' 筆・每月合計 '
                 || coalesce(sum(monthly_amount), 0)::text
            from public.hk_labor_cost where active),
         '★ 應該還是 6 筆、248,000 —— 這支只加 policy，一列資料都不動'

  union all
  select 3, '★★ ③ 還有沒有別的表開了 RLS 卻沒有 policy',
         (select case when count(*) = 0 then '✅ 沒有'
                      else '⚠⚠⚠ ' || string_agg(c.relname, '、') end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
         '★★★ 這種表的症狀跟這次一模一樣:查詢成功、回 0 列、沒有錯誤訊息。'
           || '**掃全部**，不要只查我這次建的那一張'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
