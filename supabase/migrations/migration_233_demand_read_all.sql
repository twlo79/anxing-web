/*
 * migration_233 —— 採購需求大家都看得到，但只能改自己的
 * ============================================================
 * 2026-09-09 使用者選:「大家都看得到全部，但只能改自己的」。
 *
 * 起因是 migration_232 那個撞號:Una（房務）建了 DM-202609-001，
 * 別人看不到 → 畫面顯示「共 0 張」→ 看起來像系統壞了。
 * 而兩個房務同時提同一箱衛生紙也沒有任何地方擋得住。
 *
 * ============================================================
 * 【★★★ 只改兩條 SELECT 政策，用 alter policy】
 *
 *     pd_read   purchase_demands       SELECT
 *     pdi_read  purchase_demand_items  SELECT
 *
 *   USING: 三種角色  →  current_role_of() is not null（任何登入的人）
 *
 * ★★★ **不 drop、不重建。** `CLAUDE.md` 有一條踩過的坑:
 *   `schema-baseline.sql` 不等於線上，照它抄表名會漏掉沒看過的政策，
 *   而 `drop policy` 會把那幾條拔掉 —— 症狀是房務阿姨什麼都看不到。
 *   `alter policy ... using (...)` 只換那一條的條件，其餘一個字不動。
 *
 * ★★ **寫入那四條完全不碰**:
 *     pd_own / pdi_own    ALL  自己的（房務靠這條改自己的單）
 *     pd_write / pdi_write ALL  會計・主管・總經理
 *   所以「看得到」不會變成「改得動」。
 *
 * ============================================================
 * 【★★ 為什麼兩張表要一起改】
 *
 * 只放寬 `purchase_demands` 的話，房務會看到別人的單而**點開是空的**
 * —— 項目在另一張表，各有各的 RLS。那比看不到更像壞掉。
 *
 * ============================================================
 * 【`current_role_of() is not null` 是什麼意思】
 *
 * 「這個人在人員名冊上、而且查得到角色」。沒有 profiles 列的人照樣擋掉 ——
 * 不是「所有人都看得到」，是「所有員工都看得到」。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

alter policy pd_read  on public.purchase_demands
  using (public.current_role_of() is not null);

alter policy pdi_read on public.purchase_demand_items
  using (public.current_role_of() is not null);

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('233_demand_read_all');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 兩條讀取政策都放寬了',
         coalesce((select string_agg(polname || '：' || pg_get_expr(polqual, polrelid), E'\n' order by polname)
                     from pg_policy
                    where polname in ('pd_read', 'pdi_read')), '（找不到）'),
         case when (select count(*) from pg_policy
                     where polname in ('pd_read', 'pdi_read')
                       and pg_get_expr(polqual, polrelid) like '%is not null%') = 2
              then '✅ 兩條都是' else '❌ 只改到一條 —— 會變成看得到單、點開沒項目' end

  union all
  /*
   * ★★★ 母體判定:寫入那四條**一個字都不能變**。
   *   放寬讀取的同時不小心動到寫入的話，房務就改得動別人的單,
   *   而畫面上完全看不出來。
   */
  select 2, '②★★★ 寫入那四條沒被動到',
         coalesce((select string_agg(polname || '→' ||
                          case when pg_get_expr(polqual, polrelid) like '%requester_id = auth.uid()%'
                                 or pg_get_expr(polqual, polrelid) like '%d.requester_id = auth.uid()%'
                               then '自己的'
                               when pg_get_expr(polqual, polrelid) like '%accountant%'
                               then '三種角色'
                               else '⚠ 別的東西' end, '　' order by polname)
                     from pg_policy
                    where polname in ('pd_own', 'pdi_own', 'pd_write', 'pdi_write')), '（找不到）'),
         case when (select count(*) from pg_policy
                     where polname in ('pd_own', 'pdi_own')
                       and pg_get_expr(polqual, polrelid) like '%requester_id = auth.uid()%') = 2
               and (select count(*) from pg_policy
                     where polname in ('pd_write', 'pdi_write')
                       and pg_get_expr(polqual, polrelid) like '%accountant%') = 2
              then '✅ 四條都還在原本的樣子'
              else '❌ 有被動到 —— 立刻回頭看，房務可能改得動別人的單' end

  union all
  /*
   * ★ 兩張表的政策總數要跟改之前一樣。
   *   `alter policy` 不會增減，數字變了就表示有人 drop 過。
   */
  select 3, '③ 兩張表的政策總數（改之前是 6 條）',
         (select count(*)::text || ' 條' from pg_policy
           where polrelid in ('public.purchase_demands'::regclass,
                              'public.purchase_demand_items'::regclass)),
         case when (select count(*) from pg_policy
                     where polrelid in ('public.purchase_demands'::regclass,
                                        'public.purchase_demand_items'::regclass)) = 6
              then '✅ 6 條' else '⚠ 不是 6 條 —— 有政策被增刪過' end

  union all
  /*
   * ★★ 畫面上要顯示「這張單是誰提的」，而名字來自 profiles。
   *   如果 profiles 房務讀不到，那一欄會是空的 ——
   *   看得到一堆單卻不知道是誰提的，等於沒解決重複提的問題。
   */
  select 4, '④★★ profiles 的讀取政策（決定看不看得到「誰提的」）',
         coalesce((select string_agg(polname || '：' || coalesce(pg_get_expr(polqual, polrelid), '（無條件）'), E'\n')
                     from pg_policy
                    where polrelid = 'public.profiles'::regclass
                      and polcmd in ('r', '*')), '（沒有讀取政策）'),
         '👀 條件如果限定角色，房務會看到「—」而不是名字 —— 那要另外處理'

  union all
  select 5, '⑤ 現在有幾張單、誰提的',
         coalesce((select string_agg(d.demand_no || '（' || coalesce(p.name, '?') || '）', '　'
                                     order by d.demand_no)
                     from public.purchase_demands d
                     left join public.profiles p on p.id = d.requester_id), '（沒有）'),
         '👀 房務登入之後應該看得到這幾張'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '233_demand_read_all'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '233_demand_read_all')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
