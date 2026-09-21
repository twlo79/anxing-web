/*
 * 查-攤還前要先看的.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要查】
 *
 * 2026-09-21 使用者要的第 2 點是「一筆非整攤還：如還 1000 / 5000 / 6000，
 * 從最前面一筆扣」—— 也就是**一列可以只收回一部分，而且還沒結束**。
 *
 * ★★★ 現在的資料模型表達不出這件事。
 *
 *   `statusOf()` 只看兩個欄位:
 *       refunded_on 是空的                    → 待收回
 *       refunded_on 有值 且 收回 <  金額      → **partial ＝ 被扣**
 *       refunded_on 有值 且 收回 >= 金額      → 已收回
 *
 *   而「被扣」會觸發 `needsForfeitExpense()` —— **自動產生一筆支出**
 *   （那個差額被當成公司真的損失掉的錢）。
 *
 *   攤還到一半的列長得**一模一樣**:收回 5,613、金額 7,350。
 *   照現在的程式，它會被當成「愛皮少還了 1,737，記成安幸的費用」——
 *   而事實是愛皮下個月就會還。
 *
 * ★★ 所以一定要多一個「結清了沒」的欄位,把兩件事分開:
 *       還在攤 → 沒結清,差額是**應收**
 *       結清了 → 差額是**被扣**,產生支出
 *
 *   這一支要先回答的是:**現有資料裡有幾列是真的「被扣」**。
 *   搬錯的話,一筆早就認賠的押金會變回應收,而它永遠不會有人來還。
 *
 * ══════════════════════════════════════════════════════════
 * 【這一支問六件事】
 *
 *   ① advance_payments 到底有哪些欄位（我手上沒有它的 create table）
 *   ② 掛在這張表上的 check 約束（改語意前要一次列完 —— README 坑:
 *      migration_239 改型別連死兩次都是沒先列完掛在欄位上的東西）
 *   ③ 現在有幾列是「收回了但沒收足」＝ 現行語意的被扣
 *   ④ 代墊那幾列的帳本（for_book）分佈 —— 還款方是誰
 *   ⑤ 各帳本有哪些收付款帳戶（284 之後）—— 「出帳帳號:愛皮的」要從這裡選
 *   ⑥ 愛皮待收回的那幾列長什麼樣 —— 攤還要從最前面一筆扣,順序得先看清楚
 *
 * ★ 不挑欄位名是刻意的:憑印象寫 `a.settled_on` 的話,欄位不存在就是
 *   42703 整支炸掉;更糟的是剛好有一個同名但意思不同的欄位,
 *   那會回一個看起來很正常的答案（README 坑 G）。
 * ══════════════════════════════════════════════════════════
 */

select * from (

  /* ── ① 全部欄位 ───────────────────────────────────────── */
  select 1 as ord, '① advance_payments 的全部欄位' as "段",
         c.column_name::text                                  as "項目",
         c.data_type::text
           || case when c.is_nullable = 'NO' then ' · not null' else '' end as "內容",
         coalesce(c.column_default, '')::text                  as "補充"
    from information_schema.columns c
   /* ★ 一定要帶 table_schema='public' —— 別的 schema 也可能有同名的表（README 坑）*/
   where c.table_schema = 'public' and c.table_name = 'advance_payments'

  union all
  select 1, '① advance_payments 的全部欄位', '（找不到這張表）',
         '⚠ 表名可能不一樣 —— 下面每一段都不算數，把這一列貼回對話', ''
   where to_regclass('public.advance_payments') is null

  union all
  select 2, '', '', '', ''

  union all
  /* ── ② 掛在這張表上的 check 約束 ───────────────────────
     ★★ 改語意之前要一次列完:view / DEFAULT / check（README 坑,
       migration_239 改型別連死兩次,兩次都是沒先列完）。
     ★ DEFAULT 在上面 ① 的「補充」欄;view 在下面 ②b。 */
  select 3, '★★ ② 這張表上的 check 約束', con.conname::text,
         left(pg_get_constraintdef(con.oid), 200), ''
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public' and cl.relname = 'advance_payments'
     and con.contype::text = 'c'          -- ★ contype 是 "char" 不是 text（README 坑）

  union all
  select 3, '★★ ② 這張表上的 check 約束', '（一條都沒有）',
         'ℹ 沒有 check 約束 —— 加新狀態時不用先拆', ''
   where not exists (
     select 1 from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = 'advance_payments'
        and con.contype::text = 'c')

  union all
  /* ── ②b 有沒有 view 讀這張表 ─────────────────────────── */
  select 4, '★★ ②b 有哪些 view 讀這張表', cl.relname::text,
         'ℹ 改欄位語意時這幾個要一起看', ''
    from pg_depend d
    join pg_rewrite rw on rw.oid = d.objid
    join pg_class cl on cl.oid = rw.ev_class
    join pg_class src on src.oid = d.refobjid
    join pg_namespace n on n.oid = cl.relnamespace
   where src.relname = 'advance_payments'
     and cl.relkind::text in ('v', 'm')   -- ★ 濾 relkind:索引與主鍵也會被掃進來（README 坑）
     and n.nspname = 'public'
   group by cl.relname

  union all
  select 4, '★★ ②b 有哪些 view 讀這張表', '（沒有）',
         '✅ 沒有 view 掛在上面', ''
   where not exists (
     select 1 from pg_depend d
       join pg_rewrite rw on rw.oid = d.objid
       join pg_class cl on cl.oid = rw.ev_class
       join pg_class src on src.oid = d.refobjid
      where src.relname = 'advance_payments' and cl.relkind::text in ('v', 'm'))

  union all
  select 5, '', '', '', ''

  union all
  /* ── ③ ★★★ 現在有幾列是「收回了但沒收足」 ──────────────
     這幾列照現行語意是**被扣**。加了「結清」欄位之後，
     它們必須被搬成「已結清 ＋ 差額是被扣」，不能變回應收。 */
  select 6, '★★★ ③ 收回了但沒收足的列（現行語意＝被扣）',
         coalesce(s.j ->> 'usage', '（沒填項目）')
           || '／' || coalesce(s.j ->> 'counterparty', '（沒填對象）'),
         '金額 ' || coalesce(s.j ->> 'amount', '?')
           || '　收回 ' || coalesce(s.j ->> 'refunded_amount', '?')
           || '　差額 ' || (coalesce((s.j ->> 'amount')::numeric, 0)
                          - coalesce((s.j ->> 'refunded_amount')::numeric, 0))::text,
         '類別 ' || coalesce(s.j ->> 'category', '?')
           || '　已產生支出 '
           || case when (s.j ->> 'forfeit_expense_id') is null then '否' else '是' end
    from (select to_jsonb(a.*) as j from public.advance_payments a) s
   where (s.j ->> 'refunded_on') is not null
     and coalesce((s.j ->> 'refunded_amount')::numeric, -1)
         < coalesce((s.j ->> 'amount')::numeric, 0)

  union all
  /* ★★★ 一列都沒有要說出來 —— 空結果跟「沒查到」長得一樣 */
  select 6, '★★★ ③ 收回了但沒收足的列（現行語意＝被扣）', '（一列都沒有）',
         '✅ 沒有任何列處於 partial —— 加「結清」欄位時不用搬舊資料', ''
   where not exists (
     select 1 from (select to_jsonb(a.*) as j from public.advance_payments a) s
      where (s.j ->> 'refunded_on') is not null
        and coalesce((s.j ->> 'refunded_amount')::numeric, -1)
            < coalesce((s.j ->> 'amount')::numeric, 0))

  union all
  select 7, '', '', '', ''

  union all
  /* ── ④ 代墊那幾列的帳本分佈 ───────────────────────────
     ★ 母體是 0 的話下面幾段全部自動成立 —— 要判定不是只印數字
       （README 坑:migration_210 六列全綠而母體是 0）。 */
  select 8, '④ 代墊列的帳本與狀態',
         coalesce(g.book, '（空的）') || '／' || g.st,
         g.n::text || ' 列　共 ' || g.amt::text, ''
    from (
      select s.j ->> 'for_book' as book,
             case when (s.j ->> 'paid_on') is null then '待出款'
                  when (s.j ->> 'refunded_on') is null then '待收回'
                  else '已收回' end as st,
             count(*) as n,
             sum(coalesce((s.j ->> 'amount')::numeric, 0)) as amt
        from (select to_jsonb(a.*) as j from public.advance_payments a) s
       where coalesce(s.j ->> 'category', '') = '代墊'
       group by 1, 2
    ) g

  union all
  select 8, '④ 代墊列的帳本與狀態', '（一列都沒有）',
         '⚠ 一筆代墊都沒有 —— 下面 ⑥ 不算數', ''
   where not exists (
     select 1 from public.advance_payments a where coalesce(a.category, '') = '代墊')

  union all
  select 9, '', '', '', ''

  union all
  /* ── ⑤ 各帳本有哪些收付款帳戶（migration_284 之後）──────
     「還入帳號:安幸的」「出帳帳號:愛皮的」兩個下拉要從這裡撈。 */
  select 10, '★★ ⑤ 各帳本的收付款帳戶',
         coalesce(p.book, '（沒有 book 欄位）'),
         string_agg(p.code || ' ' || coalesce(p.name, ''), '、' order by p.code), ''
    from (select to_jsonb(x.*) ->> 'book' as book,
                 to_jsonb(x.*) ->> 'code' as code,
                 to_jsonb(x.*) ->> 'name' as name
            from public.payment_accounts x) p
   group by p.book

  union all
  select 11, '', '', '', ''

  union all
  /* ── ⑥ 待收回的代墊，照「從最前面一筆扣」的順序列出來 ────
     ★★★ 攤還要有一個**確定的順序**。畫面上看到的是出款日排序，
       但同一天有 7 列（愛皮 9/09）—— 同一天之內誰先誰後，
       靠的是第二個排序鍵。這裡照 `paid_on, created_at, id` 印，
       就是之後程式要用的那一組。 */
  select 12, '★★★ ⑥ 待收回的代墊（攤還會照這個順序扣）',
         to_char(row_number() over (order by s.paid_on, s.created_at, s.id), 'FM00')
           || '　' || s.paid_on || '　' || s.usage,
         'NT$ ' || s.amt::text,
         s.party
    from (
      select coalesce(to_jsonb(a.*) ->> 'paid_on', '?')          as paid_on,
             coalesce(to_jsonb(a.*) ->> 'created_at', '')        as created_at,
             a.id::text                                          as id,
             coalesce(nullif(to_jsonb(a.*) ->> 'usage', ''), '（沒填項目）') as usage,
             coalesce((to_jsonb(a.*) ->> 'amount')::numeric, 0)  as amt,
             coalesce(to_jsonb(a.*) ->> 'counterparty', '（沒填）') as party
        from public.advance_payments a
       where coalesce(a.category, '') = '代墊'
         and to_jsonb(a.*) ->> 'paid_on' is not null
         and to_jsonb(a.*) ->> 'refunded_on' is null
    ) s

  union all
  select 12, '★★★ ⑥ 待收回的代墊（攤還會照這個順序扣）', '（一列都沒有）',
         '⚠ 沒有待收回的代墊 —— 攤還這件事現在沒有對象', ''
   where not exists (
     select 1 from public.advance_payments a
      where coalesce(a.category, '') = '代墊'
        and a.paid_on is not null and a.refunded_on is null)

) v(ord, "段", "項目", "內容", "補充")
order by v.ord, v."項目";
