/*
 * migration_232 —— 採購需求的單號函式改成 SECURITY DEFINER
 * ============================================================
 * 2026-09-09。症狀:新增採購需求按送出，回
 *
 *     duplicate key value violates unique constraint
 *     "purchase_demands_demand_no_key"
 *
 * 而畫面上寫著「共 0 張」。
 *
 * ============================================================
 * 【★★★ 為什麼「0 張」還會撞號】
 *
 *   ① 表裡實際上有 1 筆:`DM-202609-001`
 *   ② 那筆被 RLS 擋住 → 使用者看到 0 張
 *   ③ `gen_demand_no()` 是 BEFORE INSERT 觸發器，而它
 *      **不是 SECURITY DEFINER** —— 於是它跟使用者看到一樣的東西
 *   ④ 它算出「本月還沒有任何一張」→ 編 001 → 撞到那筆看不見的
 *
 * ★★★ 這是「RLS 讓計算看到的母體變小」的一種 ——
 *   跟 `CLAUDE.md` 那張坑表上「RLS 擋下來回成功且 0 列」同源，
 *   差別只在這次它有叫。**沒叫的版本更可怕**:
 *   如果那個唯一索引不存在，這裡會安靜地產生兩張同號的單。
 *
 * ============================================================
 * 【對照組就在隔壁】
 *
 * 請款單的 `next_req_no()` 是
 *
 *     LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
 *
 * 同一件事、同一種寫法，採購需求漏了。
 * 所以自檢第 ② 條拿它當母體:兩支必須長得一樣。
 *
 * ============================================================
 * 【★★ 為什麼只改屬性，不重寫函式本體】
 *
 * `alter function` 改得動 security 與 search_path，**本體一個字都不動**。
 * 重寫的話就要把原始定義抄一次 —— 而抄漏一行不會報錯,
 * 只會讓編號規則悄悄變成別的樣子（migration_229 那次的教訓）。
 *
 * ★ `set search_path = public` 不能省。SECURITY DEFINER 的函式
 *   如果不釘 search_path，呼叫者可以用自己的 schema 蓋掉裡面用到的表名。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

alter function public.gen_demand_no() security definer;
alter function public.gen_demand_no() set search_path = public;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('232_demand_no_definer');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ gen_demand_no 現在是 SECURITY DEFINER 而且釘了 search_path',
         coalesce((select 'security_definer=' || p.prosecdef::text
                          || '　config=' || coalesce(array_to_string(p.proconfig, ','), '（沒有）')
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'gen_demand_no'), '（找不到這支函式）'),
         case when (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'gen_demand_no')
              and (select array_to_string(p.proconfig, ',') from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'gen_demand_no')
                  like '%search_path%'
              then '✅ 過' else '❌ 沒改到' end

  union all
  /*
   * ★★★ 母體判定:拿請款單那支當對照。
   *   兩支做的是同一件事（依月份流水編號），設定必須一樣。
   */
  select 2, '②★★★ 跟請款單的 next_req_no 設定一致',
         coalesce((select string_agg(p.proname || '→' || p.prosecdef::text, '　' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('gen_demand_no', 'next_req_no')), '（找不到）'),
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('gen_demand_no', 'next_req_no')
                       and p.prosecdef) = 2
              then '✅ 兩支都是 definer'
              else '❌ 有一支不是 —— 那支會重演同一個 bug' end

  union all
  /*
   * ★★ 函式本體不可以被動到。這支只改屬性,
   *   本體變了就表示有人順手重寫了編號規則。
   */
  select 3, '③★★ 函式本體還是原本那份（前 120 字）',
         coalesce((select left(regexp_replace(p.prosrc, '\s+', ' ', 'g'), 120)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'gen_demand_no'), '（沒有）'),
         '👀 跟你印象中的編號規則對一下'

  union all
  select 4, '④ 現在表裡有幾筆、最大單號',
         (select count(*)::text || ' 筆　最大 '
                 || coalesce(max(demand_no), '（無）') from public.purchase_demands),
         '👀 修好之後新增的那張應該是 DM-202609-002'

  union all
  /*
   * ★ 順手掃一遍還有哪些觸發器函式沒設 definer。
   *   **只是列出來，不自動改** —— 有些觸發器本來就該用呼叫者的權限跑。
   */
  select 5, '⑤ 其他跟採購需求有關、沒設 definer 的函式',
         coalesce((select string_agg(p.proname, '、' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname ilike '%demand%' and not p.prosecdef), '（沒有）'),
         '👀 只是列出來 —— 有些本來就該用呼叫者的權限跑，不要順手全改'

  union all
  /*
   * ★★ 另一件事:為什麼那筆單你看不到。
   *   這支不修它 —— 那是另一個決定（誰該看得到誰的採購需求）。
   */
  select 6, '⑥ purchase_demands 的 RLS 讀取政策',
         coalesce((select string_agg(polname || '：' || coalesce(pg_get_expr(polqual, polrelid), '（無條件）'), E'\n')
                     from pg_policy
                    where polrelid = 'public.purchase_demands'::regclass
                      and polcmd in ('r', '*')), '（沒有讀取政策）'),
         '👀 這是「為什麼你看不到那張單」的答案，這支不改它'

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '232_demand_no_definer'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '232_demand_no_definer')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
