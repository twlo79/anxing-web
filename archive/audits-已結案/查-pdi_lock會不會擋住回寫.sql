/*
 * 查-pdi_lock 會不會擋住回寫（唯讀，第二輪）
 * ============================================================
 * 2026-09-05
 *
 * 【為什麼還要查一輪】
 *
 * 上一支的第 6 區用「函式定義裡有沒有出現 `purchase_demand` 這個字」
 * 去找相關函式 —— 而觸發器函式用的是 `new.` / `old.`，
 * **根本不會提到表名**。
 *
 * 所以這兩支被漏掉了，而它們正是掛在 `purchase_demand_items` 上的：
 *
 *   · `trg_pdi_lock`   BEFORE UPDATE   ← ★★★ 名字叫 lock
 *   · `trg_demand_rollup` AFTER I/U/D
 *
 * 【★★★ 為什麼 lock 那支非查不可】
 *
 * 它是 BEFORE UPDATE。BEFORE 觸發器 `return null` 的話那一列
 * **會被安靜跳過** —— UPDATE 回成功、影響 0 列、沒有任何錯誤
 * （CLAUDE.md：RLS 擋下的 UPDATE 回成功且影響 0 列，同一種症狀）。
 *
 * 如果它的規則是「已經 requested 的不准再改」，那：
 *   · 我寫的「標為已採購」會靜默失效
 *   · 之後要做的「付款完翻成 done」也會被它擋
 * 而畫面上看到的是「按了沒反應」。
 *
 * 【順便查兩件會影響設計的事】
 *   · `pdi_write` / `pdi_own` 的條件 —— 會計改得動別人提的需求嗎
 *   · `request_item_id` 的外鍵 on delete —— 請款單被**刪掉**（不是駁回）
 *     的時候，需求項目會不會卡在 requested 回不來
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把結果表貼回來。唯讀。
 */

select v.ord, v."項目", v."內容" from (

  -- ══════════ ★★★ 兩支被漏掉的觸發器函式 ══════════
  select 100 as ord, ('★★★ ' || p.proname::text) as a,
         pg_get_functiondef(p.oid) as b
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.proname::text in ('trg_pdi_lock', 'trg_demand_rollup')

  -- ══════════ policy 的實際條件 ══════════
  union all
  select 200, 'policy ' || policyname || '（' || cmd || '）',
         'USING: ' || coalesce(qual, '（無）')
           || E'\nWITH CHECK: ' || coalesce(with_check, '（無）')
           || E'\nroles: ' || array_to_string(roles, ',')
    from pg_policies
   where schemaname = 'public' and tablename = 'purchase_demand_items'

  -- ══════════ 外鍵：請款單被刪掉時怎麼辦 ══════════
  union all
  select 300, '外鍵 ' || co.conname::text,
         pg_get_constraintdef(co.oid)
    from pg_constraint co
    join pg_class c on c.oid = co.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'purchase_demand_items'
     and co.contype::text = 'f'

  -- ══════════ 單頭 status 允許哪些值（要加「已採購」的話得先知道） ══════════
  union all
  select 400, 'purchase_demands.status 的 check',
         coalesce((select string_agg(pg_get_constraintdef(co.oid), ' ｜ ')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname = 'purchase_demands'
                      and co.contype::text = 'c'
                      and pg_get_constraintdef(co.oid) ilike '%status%'),
                  '（沒有 check —— 新增狀態不用改約束）')

  -- ══════════ 付款那一步到底改哪一欄（決定「已採購」掛在哪個事件） ══════════
  union all
  select 500, 'gen_expenses_from_pr 的觸發條件',
         coalesce((select pg_get_functiondef(p.oid)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f', 'p')
                      and p.proname::text = 'gen_expenses_from_pr'), '（找不到）')

) v(ord, "項目", "內容")
order by v.ord, v."項目";
