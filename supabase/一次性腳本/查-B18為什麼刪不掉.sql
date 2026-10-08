/*
 * 只查、不改：房源 B18 為什麼刪不掉（2026-10-07 David：「刪 B18」→「不能刪」）
 *
 *   刪房源是進回收桶，但資料庫有外鍵：還有東西掛在這間房源上
 *   （訂單、支出、押金、清潔、評價、房務工作、稅、子房間⋯）就不准刪。
 *   這支把「所有指向 properties 的外鍵」自動掃一遍，列出 B18 被哪些表用到、各幾筆。
 *
 * ★ 不寫死表名 —— 從 pg_constraint 抓，之後新加的表也掃得到。
 */
create temp table if not exists _b18 (表 text, 欄位 text, 筆數 int, 最早 text, 最晚 text) on commit preserve rows;
truncate _b18;

do $do$
declare
  v_ids uuid[];
  c record;
  n int;
  dcol text;
  lo text; hi text;
begin
  select array_agg(id) into v_ids from public.properties where trim(name) = 'B18';
  if v_ids is null then
    insert into _b18 values ('（找不到名字是 B18 的房源）', '', 0, null, null);
    return;
  end if;
  insert into _b18 values ('properties 裡叫 B18 的', '', cardinality(v_ids), null, null);

  for c in
    select cl.relname as tbl, a.attname as col
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and k.confrelid = 'public.properties'::regclass
     order by 1
  loop
    execute format('select count(*) from public.%I where %I = any($1)', c.tbl, c.col) into n using v_ids;
    if n > 0 then
      -- 有日期欄就順便看一下最早最晚（看得出是不是舊資料）
      select column_name into dcol from information_schema.columns
       where table_schema = 'public' and table_name = c.tbl
         and column_name in ('checkin', 'spent_on', 'record_date', 'received_on', 'start_date', 'created_at')
       order by array_position(array['checkin','spent_on','record_date','received_on','start_date','created_at'], column_name::text)
       limit 1;
      lo := null; hi := null;
      if dcol is not null then
        execute format('select min(%I)::date::text, max(%I)::date::text from public.%I where %I = any($1)', dcol, dcol, c.tbl, c.col)
          into lo, hi using v_ids;
      end if;
      insert into _b18 values (c.tbl, c.col, n, lo, hi);
    end if;
  end loop;
end $do$;

select * from _b18 order by 筆數 desc;
