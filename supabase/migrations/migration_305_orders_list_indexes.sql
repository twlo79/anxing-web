/* ══════════════════════════════════════════════════════════════════════
 * migration_305：orders 加索引 —— 短租訂單清單重載（存檔後那一下）變快                        2026-10-01
 *
 * 【為什麼】David：「修改訂單後儲存變慢了，要 load」。
 *   pg_stat_statements 量出來：慢的不是 update（沒進前 25），是存完之後**重新載入清單**那一句
 *   （select orders.* + properties 名稱 + 精算總筆數，平均 200～700 ms、最慢 1.4 s，各種篩選組合都一樣）。
 *   orders 到今天只有三個索引：order_key（唯一）、account_code、book ——
 *   清單每次都是 `where source in (…) order by checkin desc`，沒有一個索引用得上，整張表掃一遍再排序。
 *
 * 【做什麼】只加索引，不動任何資料、不動任何函式：
 *   ① (source, checkin desc)   清單的篩選＋排序 —— 主要的那一個
 *   ② (checkin desc)           沒篩來源時的排序、日期區間篩選
 *   ③ (estate_id)              依物業篩選、營收報表
 *   ④ (property_id)            住房率、房源明細
 *   ⑤ (parent_order_id)        存檔第 2 步「查這張單底下的加費」—— 每一次存檔都會查
 *   每一個都 if not exists，跑第二次不會重建。建索引失敗不會把整支拉下去（各自 exception 包起來）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    'create index if not exists orders_source_checkin_idx on public.orders (source, checkin desc)',
    'create index if not exists orders_checkin_idx        on public.orders (checkin desc)',
    'create index if not exists orders_estate_idx         on public.orders (estate_id)',
    'create index if not exists orders_property_idx       on public.orders (property_id)',
    'create index if not exists orders_parent_idx         on public.orders (parent_order_id)'
  ] loop
    begin
      execute stmt;
    exception when others then
      raise warning '索引沒建成（不影響其他）：% —— %', stmt, sqlerrm;
    end;
  end loop;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('305_orders_list_indexes');
  end if;
end $do$;

commit;

-- 讓查詢規劃器知道有新索引可用（不在交易裡跑）
analyze public.orders;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with want(name) as (values ('orders_source_checkin_idx'), ('orders_checkin_idx'), ('orders_estate_idx'),
                           ('orders_property_idx'), ('orders_parent_idx'))
select 1 as 序, '五個索引都在' as 檢查,
       (select string_agg(w.name || case when i.indexname is null then ' ❌' else ' ✅' end, '；' order by w.name)
          from want w left join pg_indexes i on i.schemaname = 'public' and i.tablename = 'orders' and i.indexname = w.name) as 結果,
       case when (select count(*) from want w join pg_indexes i on i.schemaname = 'public' and i.tablename = 'orders' and i.indexname = w.name) = 5
            then '✅' else '❌ 看上面哪一個沒建成' end as 判定
union all
select 2, '母體：orders 總筆數（給下面對照用）',
       (select count(*)::text from public.orders),
       case when (select count(*) from public.orders) = 0 then '⚠ 沒有東西可檢查，下面全部不算數' else 'ℹ' end
union all
select 3, 'planner 統計已更新（analyze 跑過）',
       (select coalesce(to_char(greatest(last_analyze, last_autoanalyze), 'YYYY-MM-DD HH24:MI:SS'), '（還沒）')
          from pg_stat_user_tables where schemaname = 'public' and relname = 'orders'),
       case when (select greatest(last_analyze, last_autoanalyze) from pg_stat_user_tables where schemaname = 'public' and relname = 'orders')
                 > now() - interval '5 minutes' then '✅ 剛剛' else '⚠ analyze 沒跑到，索引要等 autovacuum 才會被用' end
union all
select 4, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '305_orders_list_indexes'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '305_orders_list_indexes') then '✅' else '❌' end
order by 1;
