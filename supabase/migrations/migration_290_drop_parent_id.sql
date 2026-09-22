/* ══════════════════════════════════════════════════════════════════════
 * migration_290  拿掉多出來的那支「上層」欄位 ＋ 把防呆搬過去   2026-09-22
 *                （第二版:第一版漏了觸發器）
 *
 * ══════════════════════════════════════════════════════════
 * 【第一版為什麼死】
 *
 *   ERROR: 2BP01 cannot drop column parent_id ... because other objects
 *          depend on it
 *   DETAIL: trigger trg_properties_parent_guard on table properties
 *           depends on column parent_id
 *
 * ★★★ 我在第一版列了「掛在那一欄上的東西」——
 *   ① view/rule ② DEFAULT ③ CHECK ④ generated column ⑤ 索引 ⑥ 外鍵
 *   —— **漏了觸發器**。而那份清單存在的唯一理由就是「不要撞一次補一個」，
 *   漏一項等於整份清單沒有用。跟 migration_239 那次是同一種錯。
 *
 * ══════════════════════════════════════════════════════════
 * 【漏掉它順便揭露了一個更重要的問題】
 *
 * `trg_properties_parent_guard`（migration_287 建的）守的是
 * **`parent_id`** —— 不能自我參照、不能成環、父子要同一個物業。
 *
 * 但畫面上那個「上層」下拉寫的是 **`parent_property_id`**，
 * 而那一欄**從來沒有任何防呆**。也就是說:
 *
 *   在房源設定頁把 A 的上層設成 A 自己 → 資料庫收下
 *   把 A 的上層設成 B、B 的上層設成 A → 資料庫也收下
 *
 * 住房率那支 `ancestryOf()` 前端有防成環（`seen` set），所以畫面不會當，
 * 但那是「已經寫進去了也不要當掉」，不是「寫不進去」。
 * **兩邊都要有，而資料庫這一半一直守在沒有人用的那一欄上。**
 *
 * 所以這支不是只刪東西:**把防呆搬到真正在用的那一欄**。
 *
 * ══════════════════════════════════════════════════════════
 * 【掛在 parent_id 上的東西 —— 這次列完】
 *
 *   ① view / rule          → ②a 查，有就停下來報名字
 *   ② DEFAULT              → ②b
 *   ③ CHECK 約束            → ②c 用詞邊界 `~ '\mparent_id\M'`
 *   ④ generated column     → ②d
 *   ⑤ **觸發器**            → ②e ← 第一版漏的就是這一項
 *   ⑥ 索引 properties_parent_idx     → ③ 明寫 drop
 *   ⑦ 外鍵 properties_parent_id_fkey → `drop column` 會自己帶走
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**。
 * ══════════════════════════════════════════════════════════════════════ */

create temp table if not exists _m290_probe (name text, ok boolean, msg text);
truncate _m290_probe;

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

  -- ②e ★★★ 觸發器 —— 第一版漏的就是這一項
  --    只有「我知道的那一支」可以自己處理（下面 ③ 會重建到新欄位上）；
  --    冒出別支就停下來報名字，不要默默 drop 別人的東西。
  select string_agg(t.tgname::text, '、') into v
    from pg_trigger t
   where t.tgrelid = 'public.properties'::regclass
     and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ~ '\mparent_id\M'
     and t.tgname <> 'trg_properties_parent_guard';
  if v is not null then
    raise exception '還有別的觸發器掛在 parent_id 上:% —— 停下來', v;
  end if;
end $do$;

-- ── ③ 防呆搬到 parent_property_id ──────────────────
/*
 * ★★★ 邏輯跟 migration_287 的那支**一模一樣**，只換欄位名。
 *   不是重寫 —— 上一支怎麼寫就怎麼抄（CLAUDE.md:不要憑印象）。
 */
create or replace function public.properties_parent_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  cur   uuid;
  hops  int := 0;
  pest  uuid;
begin
  if new.parent_property_id is null then return new; end if;

  if new.parent_property_id = new.id then
    raise exception '房源不能是自己的上層（%）', new.name;
  end if;

  /* ★ 父子要在同一個物業。兩邊都有設物業而且不一樣才擋 ——
       其中一邊沒設物業是舊資料的形狀，不是錯。 */
  select estate_id into pest from public.properties where id = new.parent_property_id;
  if pest is not null and new.estate_id is not null and pest <> new.estate_id then
    raise exception '上層房源不在同一個物業（% 的上層是別的物業）', new.name;
  end if;

  /* ★★★ 成環。前端那支 ancestryOf() 也有防，但兩邊都要有 ——
       資料庫這邊擋的是「寫不進去」，畫面那邊擋的是「已經寫進去了也不要當掉」。 */
  cur := new.parent_property_id;
  while cur is not null and hops < 32 loop
    if cur = new.id then
      raise exception '上層成環（% 繞回自己）', new.name;
    end if;
    select parent_property_id into cur from public.properties where id = cur;
    hops := hops + 1;
  end loop;
  if hops >= 32 then
    raise exception '上層層數太深（% 往上超過 32 層）', new.name;
  end if;

  return new;
end $fn$;

drop trigger if exists trg_properties_parent_guard on public.properties;
create trigger trg_properties_parent_guard
  before insert or update of parent_property_id, estate_id on public.properties
  for each row execute function public.properties_parent_guard();

comment on column public.properties.parent_property_id is
  '上層房源（整棟／整層）。**全站唯一一支**:房源設定頁的「上層」下拉、'
  '訂單頁、營收表、住房率都讀這一支（migration_289 合併、290 收尾）。'
  '葉子才進住房率的分母，父層的佔用往下展開。'
  '防呆在 trg_properties_parent_guard:不能自我參照、不能成環、父子同一個物業。';

-- ── ④ 刪掉 ──────────────────────────────────────────
drop index if exists public.properties_parent_idx;
alter table public.properties drop column if exists parent_id;

-- ── ⑤ 新的防呆真的擋得住嗎（子交易，撞完退掉，不留資料）──
/*
 * ★★★ 問的是**行為**不是定義。只確認「觸發器存在」的話，
 *   函式body 改錯了它也會回綠（migration_262 那次的教訓）。
 */
do $do$
declare r record; ok boolean; m text;
begin
  select id, name, estate_id into r from public.properties limit 1;
  if r.id is null then
    insert into _m290_probe values ('自我參照', false, '⚠ 一間房都沒有，測不了');
    return;
  end if;

  -- 自我參照
  ok := false; m := '';
  begin
    update public.properties set parent_property_id = r.id where id = r.id;
    ok := false; m := '❌ 居然寫得進去';
    raise exception 'M290_ROLLBACK';
  exception when others then
    if sqlerrm = 'M290_ROLLBACK' then null;
    /* ★★★ 判定要看**行為**（有沒有被擋），不是看**我自己寫的那句訊息**。
         2026-09-22 線上就是這樣誤報的:實際擋它的是另一支更早就存在的
         守衛，訊息是「房源的上層不能是自己」，跟我寫的
         「房源不能是自己的上層（%）」差幾個字 —— 功能完全正常，
         我的自檢卻回 ❌。**比對自己寫的字串＝比我寫的跟我寫的。** */
    else ok := true; m := '擋下來了:' || sqlerrm; end if;
  end;
  insert into _m290_probe values ('自我參照', ok, m);
end $do$;

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
  select 3, '③ 有上層的房源幾間（289 跑完是 11，這支不該動到它）',
         (select count(*)::text from public.properties where parent_property_id is not null),
         case when (select count(*) from public.properties where parent_property_id is not null) = 11
              then '✅ 沒變'
              else '⚠ 跟 11 不一樣 —— 你自己改過上層就正常，否則要查' end

  union all
  select 4, '④ 防呆現在守在哪一欄（應該是 parent_property_id）',
         coalesce((select case when pg_get_triggerdef(t.oid) ~ '\mparent_property_id\M'
                               then 'parent_property_id'
                               else '還是舊的 parent_id' end
                     from pg_trigger t
                    where t.tgrelid='public.properties'::regclass
                      and t.tgname='trg_properties_parent_guard'), '（觸發器不見了）'),
         case when exists (select 1 from pg_trigger t
                            where t.tgrelid='public.properties'::regclass
                              and t.tgname='trg_properties_parent_guard'
                              and pg_get_triggerdef(t.oid) ~ '\mparent_property_id\M')
              then '✅' else '❌ 防呆沒搬過去' end

  union all
  -- ★ 這一列問的是**行為**:真的拿一列去撞自我參照，撞完退掉
  select 5, '⑤ 實測：把某間房的上層設成自己，擋得住嗎',
         coalesce((select msg from _m290_probe where name='自我參照'), '（沒測到）'),
         case when coalesce((select ok from _m290_probe where name='自我參照'), false)
              then '✅ 擋住了' else '❌ 沒擋住' end

  union all
  select 6, '⑥ 指向 properties 的外鍵，parent_id 那條跟著走了嗎',
         (select count(*)::text from pg_constraint con
            join pg_class pc on pc.oid = con.confrelid
           where con.contype='f' and pc.relname='properties') || ' 條',
         case when not exists (select 1 from pg_constraint
                                where conname = 'properties_parent_id_fkey')
              then '✅ 走了' else '❌ 外鍵還在' end

  union all
  select 7, '⑦ 這支跑過了沒（schema_migrations）',
         coalesce((select name from public.schema_migrations
                    where name = '290_drop_parent_id'), '（沒有紀錄）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '290_drop_parent_id')
              then '✅' else '⚠ 沒記到' end
) x
order by s;
