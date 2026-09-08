/*
 * migration_228 —— 遞延認列改走 RPC（一個交易做完）
 * ============================================================
 * 2026-09-08 使用者：「遞延 無法成功」
 *
 * 症狀:按「設定遞延認列」跳
 *
 *   遞延認列的金額對不上:母單 40880 + 子單 0 = 40880，實付總額是 76650
 *
 * 而畫面上「明細合計 $76,650・差額 0」—— 前端算的是對的。
 *
 * ============================================================
 * 【★★★ 根因:`deferrable` 延到的是「交易」，不是「一連串請求」】
 *
 * migration_88 把檢查做成 constraint trigger:
 *
 *     create constraint trigger trg_expense_deferral_sum
 *       after insert or update or delete on expenses
 *       deferrable initially deferred          ← 延到交易結束才驗
 *
 * 那個設計是對的，而且註解寫得很清楚:
 *   「一般觸發器會在插入第一張子單的當下就爆掉⋯延到交易結束才驗才是對的」
 *
 * **但前端是三次獨立的 PostgREST 呼叫**:
 *
 *   ① delete from expenses where parent_expense_id = 母單
 *   ② update expenses set deferred, gross_amount, amount   ← 這一步自己 commit
 *   ③ insert 子單
 *
 * **PostgREST 每一個請求各自一個交易。** 所以 `deferrable` 延到的是
 * 第②步自己的結尾 —— 那時子單還沒建，`40880 + 0 ≠ 76650`，必爆。
 *
 * ★ `DeferralPanel.tsx` 的註解寫著「沒關係，觸發器延到交易結束才驗」——
 *   **那個假設從第一天就是錯的**。這個功能只要有子單就不可能成功。
 *
 * ★★ 為什麼一直沒被發現:沒有子單時（整筆都認列在付款日）第②步的
 *   `own` 就等於 `gross`，等式成立、不會爆。真正要拆的時候才會撞到。
 *
 * ============================================================
 * 【為什麼不是「把順序改成先建子單」】
 *
 * 那樣第②步之前，子單已經指向一張**還不是遞延**的母單 ——
 * 它們會以獨立的支出出現在支出頁上，**那筆錢被算兩次**。
 * 而如果第②步失敗（斷網、權限），那些子單就永遠留在那裡。
 *
 * 順序換來換去都有一個中間狀態是錯的。正確的解法是
 * **讓三件事在同一個交易裡** —— 那正是 constraint trigger 當初預期的用法。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- 設定遞延（刪舊子單 → 改母單 → 建新子單，一個交易）
-- ══════════════════════════════════════════════════════════
create or replace function public.set_expense_deferral(
  p_parent uuid,
  p_gross  numeric,
  p_own    numeric,
  p_kids   jsonb            -- [{"on":"2026-10-08","amount":35770}, ...]
) returns int
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare n int;
begin
  /*
   * ★★★ SECURITY DEFINER 會繞過 RLS，所以權限要自己擋。
   *   不擋的話任何登入者都能改別人的支出金額 ——
   *   而 `expenses` 的 exp_write 本來只放行會計以上。
   */
  if current_role_of() not in ('accountant','manager','super_admin') then
    raise exception '只有會計以上可以設定遞延認列';
  end if;

  -- ① 舊子單整組刪掉。硬刪不進回收桶 —— 每改一次遞延就整組重算
  delete from expenses where parent_expense_id = p_parent;

  -- ② 母單
  update expenses
     set deferred = true, gross_amount = p_gross, amount = p_own
   where id = p_parent;
  if not found then
    raise exception '找不到那筆支出（或它已經被刪掉了）';
  end if;

  -- ③ 新子單。其餘欄位由 migration_88 的 sync_expense_child 從母單繼承
  insert into expenses (parent_expense_id, spent_on, amount)
  select p_parent, (k ->> 'on')::date, (k ->> 'amount')::numeric
    from jsonb_array_elements(coalesce(p_kids, '[]'::jsonb)) k;
  get diagnostics n = row_count;

  /*
   * ★ 到這裡函式結束，但**交易還沒結束** —— 是呼叫端（PostgREST 的
   *   那一個請求）在 commit 時才驗 constraint trigger。
   *   三件事都在這一個交易裡，所以那時等式是完整的。
   */
  return n;
end $fn$;

comment on function public.set_expense_deferral(uuid, numeric, numeric, jsonb) is
  '設定遞延認列（migration_228）。刪舊子單 → 改母單 → 建新子單，**一個交易**。'
  '★★★ 一定要走這一支，不要在前端拆成三次呼叫 —— '
  'PostgREST 每個請求各自一個交易，而 trg_expense_deferral_sum 的 '
  '`deferrable` 只延到「那個交易」的結尾，中間那一步必爆。';

-- ══════════════════════════════════════════════════════════
-- 取消遞延（子單全刪 → 母單還原，一個交易）
-- ══════════════════════════════════════════════════════════
create or replace function public.clear_expense_deferral(p_parent uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if current_role_of() not in ('accountant','manager','super_admin') then
    raise exception '只有會計以上可以取消遞延認列';
  end if;

  /*
   * ★ 取消也要在同一個交易裡。分兩次的話:
   *   先刪子單 → 母單還是 deferred、gross 還在、own 只有本期
   *   → 那個 commit 就會爆（own ≠ gross）。
   */
  delete from expenses where parent_expense_id = p_parent;
  update expenses
     set deferred = false, gross_amount = null,
         amount = coalesce(gross_amount, amount)
   where id = p_parent;
  if not found then
    raise exception '找不到那筆支出（或它已經被刪掉了）';
  end if;
end $fn$;

comment on function public.clear_expense_deferral(uuid) is
  '取消遞延認列（migration_228）。子單全刪 ＋ 母單還原成實付總額，一個交易。'
  '★ `amount` 還原成 `gross_amount` —— 那才是實付的錢。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('228_deferral_rpc');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩支 RPC 都在',
         coalesce((select string_agg(p.proname::text || '（' ||
                     case when p.prosecdef then 'definer' else 'invoker ❌' end || '）',
                     '、' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text in ('set_expense_deferral','clear_expense_deferral')),
                  '（找不到）'),
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text in ('set_expense_deferral','clear_expense_deferral')
                      and p.prosecdef) = 2
              then '✅ 兩支都在，而且都是 definer'
              else '❌ 少了，或不是 definer（那樣會被 RLS 擋）' end

  union all
  -- ★★ SECURITY DEFINER 繞過 RLS,所以函式裡一定要自己擋權限
  select 2, '★★ ② 函式裡有沒有自己擋權限',
         case when coalesce((select string_agg(pg_get_functiondef(p.oid), ' ')
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text in
                                    ('set_expense_deferral','clear_expense_deferral')), '')
                   ilike '%current_role_of%'
              then '有 —— 兩支都檢查 current_role_of()'
              else '沒有 ❌' end,
         case when coalesce((select string_agg(pg_get_functiondef(p.oid), ' ')
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text in
                                    ('set_expense_deferral','clear_expense_deferral')), '')
                   ilike '%current_role_of%'
              then '✅ 不是任何登入者都能改別人的支出'
              else '❌ definer ＋ 沒擋權限 = 誰都能改支出金額' end

  union all
  -- ★ 原本那支 constraint trigger 不能被弄壞,它才是最後的守門
  select 3, '★ ③ 遞延的等式檢查還在嗎',
         coalesce((select t.tgname::text || '（'
                     || case when t.tgdeferrable then 'deferrable' else '❌ 不是 deferrable' end || '）'
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'expenses'
                      and t.tgname::text = 'trg_expense_deferral_sum'), '（不見了）'),
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'expenses'
                             and t.tgname::text = 'trg_expense_deferral_sum'
                             and t.tgdeferrable)
              then '✅ 還在而且是 deferrable —— RPC 靠它在交易結尾驗一次'
              else '❌ 不見了或不是 deferrable' end

  union all
  /*
   * ★★★ 母體要判定。現在有幾筆遞延母單、其中有幾筆對不上 ——
   *   對不上的代表之前有半成品留下來。
   */
  select 4, '★★★ ④ 現有的遞延母單對不對得上',
         (select count(*)::text || ' 筆遞延母單，其中金額對不上的 '
                 || count(*) filter (
                      where round(coalesce(e.amount,0)
                        + coalesce((select sum(k.amount) from expenses k
                                     where k.parent_expense_id = e.id), 0))
                        <> round(coalesce(e.gross_amount, 0)))::text || ' 筆'
            from expenses e where e.deferred),
         case when (select count(*) from expenses e where e.deferred) = 0
              then '⚠ 一筆遞延都沒有 —— 上面驗的只是函式的形狀'
              when (select count(*) filter (
                      where round(coalesce(e.amount,0)
                        + coalesce((select sum(k.amount) from expenses k
                                     where k.parent_expense_id = e.id), 0))
                        <> round(coalesce(e.gross_amount, 0)))
                      from expenses e where e.deferred) = 0
              then '✅ 全部對得上'
              else '❌ 有對不上的 —— 那是之前失敗留下的半成品，要手動修' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '228_deferral_rpc'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '228_deferral_rpc')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
