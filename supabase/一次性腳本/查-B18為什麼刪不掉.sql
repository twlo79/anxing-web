/*
 * 查：某幾間房為什麼刪不掉（2026-09-22）
 *
 * **只讀，不改也不刪任何東西。**
 *
 * ★★★ 跟上一支的差別:上一支是我**事先猜**「大概是評價跟子房源」，
 *   然後只數那兩張。B18 兩張都是 0 卻還是刪不掉 —— 表示卡住它的是
 *   第三張表，而我那份查詢**看不到自己漏掉了什麼**。
 *
 *   這一支改成**動態**:從 `pg_constraint` 撈出每一條指向 `properties`
 *   的外鍵，一條一條去數。漏不掉，因為名單不是我打的。
 *   （跟 `schema-baseline.sql` 那條坑同一種:照抄來的表名只問得到
 *     抄來的那幾條，漏掉的不會叫。）
 *
 * ★★ 要查別間房就改下面那一行 `v_names`。
 */

create temp table if not exists _fkchk (
  物業 text, 房源 text, 哪張表 text, 欄位 text, 外鍵名稱 text, 規則 text, 幾列 bigint
);
truncate _fkchk;

do $do$
declare
  /* ★ 要查哪幾間房 —— 改這一行 */
  v_names text[] := array['B18','B01','B02'];
  r record; p record; n bigint; hit boolean;
begin
  for p in
    select pr.id, pr.name, coalesce(e.name, '（沒有物業）') as est
      from public.properties pr
      left join public.estates e on e.id = pr.estate_id
     where pr.name = any (v_names)
     order by est, pr.name
  loop
    hit := false;
    for r in
      select c.relname::text as tbl,
             con.conname::text as fk,
             con.confdeltype::text as del,
             (select a.attname::text
                from unnest(con.conkey) k
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
               order by a.attnum limit 1) as col
        from pg_constraint con
        join pg_class c   on c.oid  = con.conrelid
        join pg_class pc  on pc.oid = con.confrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where con.contype = 'f' and pc.relname = 'properties' and ns.nspname = 'public'
       order by c.relname
    loop
      execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
        into n using p.id;
      if n > 0 then
        hit := true;
        insert into _fkchk values (p.est, p.name, r.tbl, r.col, r.fk,
          case r.del
            when 'a' then '❌ NO ACTION —— 會擋住'
            when 'r' then '❌ RESTRICT —— 會擋住'
            when 'c' then '✅ CASCADE —— 一起刪'
            when 'n' then '✅ SET NULL —— 那一欄變 null'
            when 'd' then '✅ SET DEFAULT'
            else '？ ' || r.del end, n);
      end if;
    end loop;
    /* ★★ 沒有任何子列的話要**寫一列出來**，不要留一張空表 ——
         空的結果跟「查詢沒跑到」長得一模一樣。 */
    if not hit then
      insert into _fkchk values (p.est, p.name, '（沒有任何子列）', '—', '—',
        '✅ 這間刪得掉 —— 擋住的不是它', 0);
    end if;
  end loop;

  if not exists (select 1 from _fkchk) then
    insert into _fkchk values ('—', '—', '—', '—', '—',
      '⚠ 這幾個名字一間房都對不到，下面不算數', 0);
  end if;
end $do$;

-- ① 這幾間房分別被誰卡住（❌ 的排前面）
select 1 as 序, * from _fkchk
order by case when 規則 like '❌%' then 0 else 1 end, 物業, 房源, 哪張表;

-- ② 全站:每一條「會擋住」的外鍵，各卡住幾間房
--    ★ 這張回答的是「79 間被卡住，是被什麼卡的」
do $do2$
declare r record; n bigint;
begin
  create temp table if not exists _fkall (哪張表 text, 外鍵名稱 text, 規則 text, 卡住幾間房 bigint);
  truncate _fkall;
  for r in
    select c.relname::text as tbl, con.conname::text as fk, con.confdeltype::text as del,
           (select a.attname::text from unnest(con.conkey) k
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
             order by a.attnum limit 1) as col
      from pg_constraint con
      join pg_class c   on c.oid  = con.conrelid
      join pg_class pc  on pc.oid = con.confrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where con.contype = 'f' and pc.relname = 'properties' and ns.nspname = 'public'
       and con.confdeltype::text in ('a','r')     -- 只看會擋住的
  loop
    execute format('select count(distinct %I) from public.%I where %I is not null', r.col, r.tbl, r.col)
      into n;
    insert into _fkall values (r.tbl, r.fk,
      case r.del when 'a' then 'NO ACTION' else 'RESTRICT' end, n);
  end loop;
end $do2$;

select 2 as 序, * from _fkall order by 卡住幾間房 desc, 哪張表;
