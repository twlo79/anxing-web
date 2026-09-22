/* ══════════════════════════════════════════════════════════════════════
 * migration_290  拿掉多出來的那支「上層」欄位                2026-09-22
 *
 * `properties.parent_id` 是 migration_287 多開的第二支上層欄位。
 * 289 已經把資料合併到 `parent_property_id`（畫面在寫的那一支），
 * 而「住房率改讀 parent_property_id」那版 code 也上線了（commit 00ec914）。
 *
 * ★★★ 留著一支沒有人讀也沒有人寫的欄位比刪掉更危險:
 *   下一個人看到它會以為那是「上層」的其中一種寫法，於是又寫進去 ——
 *   然後同一件事又回到兩個地方。
 *
 * ══════════════════════════════════════════════════════════
 * 【掛在那一欄上的東西 —— 先列完再動】（CLAUDE.md 2026-09-10 的坑）
 *
 *   ① view / rule      → ②a 查，有就**停下來報名字**，不自己 drop 別人的東西
 *   ② DEFAULT          → 287 沒有給預設值，②b 再確認一次
 *   ③ CHECK 約束        → ②c 用**詞邊界** `~ '\mparent_id\M'` 掃，
 *                        不是 `ilike '%parent_id%'`（那會掃到 parent_property_id）
 *   ④ generated column → ②d
 *   ⑤ 索引 properties_parent_idx  → 跟著欄位一起走
 *   ⑥ 外鍵 properties_parent_id_fkey → `drop column` 會自己帶走
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**。
 * ══════════════════════════════════════════════════════════════════════ */

begin;

-- ── ① 資料真的合併過了嗎（沒合併完就不准刪）──────────
do $do$
declare n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='properties'
                    and column_name='parent_id') then
    raise notice 'parent_id 已經不在了 —— 這支跑過了，下面只會確認最終狀態';
    return;
  end if;
  select count(*) into n from public.properties
   where parent_id is not null
     and (parent_property_id is null or parent_property_id <> parent_id);
  if n > 0 then
    raise exception
      '還有 % 列的 parent_id 沒有合併到 parent_property_id —— 先跑 migration_289', n;
  end if;
end $do$;

-- ── ② 掛在那一欄上的東西 ────────────────────────────
do $do$
declare v text; n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='properties'
                    and column_name='parent_id') then return; end if;

  -- ②a view / rule：擋住就停下來**報名字**，不要自己 drop 別人的東西
  select string_agg(distinct c.relname::text, '、') into v
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class c   on c.oid = r.ev_class
   where d.refobjid = 'public.properties'::regclass
     and d.refobjsubid = (select attnum from pg_attribute
                           where attrelid='public.properties'::regclass and attname='parent_id')
     and c.relkind in ('v','m')
     and c.relname <> 'properties';
  if v is not null then
    raise exception '有 view 掛在 parent_id 上:% —— 停下來，先決定那幾支怎麼辦', v;
  end if;

  -- ②b DEFAULT
  select column_default into v from information_schema.columns
   where table_schema='public' and table_name='properties' and column_name='parent_id';
  if v is not null then
    raise exception 'parent_id 有 DEFAULT（%）—— 先確認沒有人依賴它', v;
  end if;

  -- ②c CHECK 約束。★ 詞邊界，不要 ilike '%parent_id%'（會掃到 parent_property_id）
  select string_agg(con.conname::text, '、') into v
    from pg_constraint con
   where con.conrelid = 'public.properties'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ~ '\mparent_id\M';
  if v is not null then
    raise exception 'parent_id 上掛著 CHECK:% —— 先把定義寫進 COMMENT 留底再說', v;
  end if;

  -- ②d generated column
  select count(*) into n from pg_attribute
   where attrelid='public.properties'::regclass and attgenerated <> ''
     and pg_get_expr((select adbin from pg_attrdef where adrelid=attrelid and adnum=attnum), attrelid)
         ~ '\mparent_id\M';
  if n > 0 then
    raise exception '有 generated column 用到 parent_id（% 個）', n;
  end if;
end $do$;

-- ── ③ 刪掉 ──────────────────────────────────────────
/* ★ 索引先拿掉（drop column 其實會帶走，明寫是為了讓這支自己讀得懂） */
drop index if exists public.properties_parent_idx;
alter table public.properties drop column if exists parent_id;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('290_drop_parent_id');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★★ 看不到下面這張表 ＝ 整支回滾了，不是「跑成功但沒輸出」。
-- ★★ 每一列問的都是**最終狀態**，跑第二次答案一模一樣。
-- ══════════════════════════════════════════════════════════
select * from (
  select 0 as s, '⓪ ⚠ 母體：房源總數' as 項目,
         (select count(*)::text from public.properties) as 值,
         case when (select count(*) from public.properties) = 0
              then '❌ 一間都沒有 —— 下面不算數' else '✅ 有東西可以檢查' end as 判定

  union all
  select 1, '① parent_id 還在嗎（應該不在）',
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='properties'
                              and column_name='parent_id') then '還在' else '不在了' end,
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='properties'
                              and column_name='parent_id') then '❌' else '✅' end

  union all
  select 2, '② parent_property_id 還在嗎（應該在）',
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='properties'
                              and column_name='parent_property_id') then '在' else '不見了' end,
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='properties'
                              and column_name='parent_property_id') then '✅' else '❌ 刪錯欄位了' end

  union all
  -- ★ 基準用「跟這次改動無關的量」:有上層的房源筆數（289 之後是 11）
  select 3, '③ 有上層的房源幾間（289 跑完是 11，這支不該動到它）',
         (select count(*)::text from public.properties where parent_property_id is not null),
         case when (select count(*) from public.properties where parent_property_id is not null) = 11
              then '✅ 沒變' else '⚠ 跟 11 不一樣 —— 如果你這中間有自己改過上層就正常，否則要查' end

  union all
  select 4, '④ 信陽那四間的上層還在嗎',
         coalesce((select string_agg(p.name || '→' ||
                    coalesce((select x.name from public.properties x where x.id = p.parent_property_id), '（空）'),
                    '、' order by p.name)
                   from public.properties p where p.name like '信陽5%'), '（沒有這幾間）'),
         case when (select count(*) from public.properties p
                     where p.name like '信陽5%' and p.parent_property_id is null) = 0
              then '✅' else '❌ 有空的' end

  union all
  select 5, '⑤ 指向 properties 的外鍵還剩幾條（應該比 289 之前少一條）',
         (select count(*)::text from pg_constraint con
            join pg_class pc on pc.oid = con.confrelid
           where con.contype='f' and pc.relname='properties'),
         case when not exists (select 1 from pg_constraint
                                where conname = 'properties_parent_id_fkey')
              then '✅ parent_id 那條跟著走了' else '❌ 外鍵還在' end

  union all
  select 6, '⑥ 這支跑過了沒（schema_migrations）',
         coalesce((select name from public.schema_migrations
                    where name = '290_drop_parent_id'), '（沒有紀錄）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '290_drop_parent_id')
              then '✅' else '⚠ 沒記到' end
) x
order by s;
