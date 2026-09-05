/*
 * 查-為何刪掉支出沒有稽核紀錄（唯讀）
 * ============================================================
 * 2026-09-05
 *
 * migration_213 刪掉了一筆 30,000 的支出，而它的自檢第 4 列回 **0**：
 * `data_audit` 沒有記到那次刪除。
 *
 * 【為什麼這件事比那 30,000 重要】
 *
 * `data_audit`（migration_72）存在的理由就是「錢的紀錄被刪要查得到」。
 * 它沒記到的話，這張表**在它最需要工作的時候是空的** ——
 * 而它平常看起來很正常（有幾百列 insert/update），
 * 所以沒有人會發現它漏了什麼。
 *
 * 【猜測，但要證】
 *
 * 盤點時看過 `data_audit_log()` 裡有一條
 * 「`auth.uid()` 是 null 就直接 return」的分支。
 * 而在 SQL Editor 裡跑 SQL 時 `auth.uid()` 正是 null。
 *
 * 如果是這樣，那**每一支我給你貼進 SQL Editor 的 migration
 * 都沒有留下稽核紀錄** —— 213 只是第一個被自檢抓到的。
 *
 * ★ 這一支只查、不改。第 1 列是答案。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把結果貼回來。
 */

select v.ord, v."項目", v."內容" from (

  -- ══════════ ★★★ 那支函式到底怎麼寫的 ══════════
  select 100 as ord, '★★★ data_audit_log 的定義' as a,
         coalesce((select pg_get_functiondef(p.oid)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.prokind in ('f', 'p')
                      and p.proname::text = 'data_audit_log'), '（找不到這支函式）') as b

  -- ══════════ 觸發器有沒有掛在 expenses 上 ══════════
  union all
  select 200, 'expenses 上的稽核觸發器',
         coalesce((select string_agg(t.tgname::text || '（' ||
                     case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end || ' ' ||
                     concat_ws('/',
                       case when (t.tgtype &  4) <> 0 then 'INSERT' end,
                       case when (t.tgtype &  8) <> 0 then 'DELETE' end,
                       case when (t.tgtype & 16) <> 0 then 'UPDATE' end) || '）', '、')
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'expenses'
                      and t.tgname::text like '%audit%'), '（一個都沒掛）')

  -- ══════════ ★ 現在這個連線的 uid 是什麼 ══════════
  union all
  select 300, '★ 我現在跑 SQL 時的 auth.uid()',
         coalesce(auth.uid()::text, '（null —— 這就是原因）')

  -- ══════════ 這張表平常有沒有在動 ══════════
  union all
  select 400, 'data_audit 總筆數與最近一筆',
         (select count(*)::text from public.data_audit) || ' 筆，最近一筆 '
           || coalesce((select max(at)::text from public.data_audit), '（沒有）')

  union all
  select 410, '★ delete 事件有幾筆（各表）',
         coalesce((select string_agg(table_name || '：' || n::text, '、' order by n desc)
                     from (select table_name, count(*) as n
                             from public.data_audit where action = 'delete'
                            group by table_name limit 15) s),
                  '⚠ 一筆 delete 都沒記過 —— 這張表從來沒有在刪除時工作過')

  union all
  select 420, 'expenses 的稽核紀錄分佈',
         coalesce((select string_agg(action || '：' || n::text, '、' order by action)
                     from (select action, count(*) as n from public.data_audit
                            where table_name = 'expenses' group by action) s),
                  '（expenses 一筆都沒記過）')

  -- ══════════ ★★ 那筆 30,000 現在還追得回來嗎 ══════════
  union all
  select 500, '★★ 那筆 30,000 的來歷還在不在',
         coalesce((select left(note, 200) from public.advance_payments
                    where category = '零用金' and paid_on = date '2026-08-05'
                      and round(amount, 2) = 30000),
                  '（找不到那筆暫付）')

) v(ord, "項目", "內容")
order by v.ord;
