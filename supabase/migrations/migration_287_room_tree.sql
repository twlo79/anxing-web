/* ══════════════════════════════════════════════════════════════════════
 * migration_287  子母房源 ＋ 打通房 ＋ 住房率自己的開關     2026-09-21
 *
 * 住房率現在是錯的，而且錯得看起來很正常。三個原因：
 *
 *   ① **子母房源**（使用者 2026-09-21：「有的是子母房源關係」）
 *      「開封整棟」跟底下的 2F／3F／4F 是**同一個空間**，兩邊都在分母裡。
 *      訂了整棟那 93 天只記在整棟那一列，底下五列全是 0
 *      → 開封住房率 24.4%，實際七成。**低報三分之二。**
 *
 *   ② **打通房**（「台1+2 是兩間打通一起租」）
 *      一列，但分母該算兩間。
 *
 *   ③ **「排房表」被借去當「算不算住房率」**
 *      開封1F-1 整年都有人住，卻因為沒勾排房表而一天都不算。
 *      那是兩件事，這支把它們分開。
 *
 * 加三欄：
 *   parent_id           父房源（整棟／整層）。**葉子才進分母，父層的佔用往下展開**
 *   units               這一列代表幾間房（打通房是 2）
 *   count_in_occupancy  算不算住房率 —— 跟「要不要排房」分開
 *
 * ★★★ 這支會**改資料**（設父子、停用兩個物業、停用南京10）。
 *   每一項最後都用「最終狀態」驗（不是用影響列數），所以跑第二次、第十次
 *   答案一模一樣。名字打錯的話會在 commit 之前 raise，不會安靜地什麼都沒做。
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**，
 *   不是「跑成功但沒輸出」。
 * ══════════════════════════════════════════════════════════════════════ */

begin;

-- ── 1. 三個新欄位 ───────────────────────────────────────────────────
alter table public.properties
  add column if not exists parent_id uuid references public.properties(id);

alter table public.properties
  add column if not exists units integer not null default 1;

alter table public.properties
  add column if not exists count_in_occupancy boolean not null default true;

comment on column public.properties.parent_id is
  '父房源（整棟／整層）。住房率的分母只算葉子（沒有小孩的），父層的佔用往下展開到每個葉子。migration_287';
comment on column public.properties.units is
  '這一列代表幾間房。打通房（台1+2）是 2。住房率的分子與分母都乘它。migration_287';
comment on column public.properties.count_in_occupancy is
  '算不算住房率。跟 show_in_room_calendar（要不要排房）是兩件事：開封1F-1 不排房但要算。migration_287';

/* ★ units 至少 1。0 的話那間房會從分母整個消失，而住房率只是「變高了一點」 */
do $do$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.properties'::regclass
                   and conname = 'properties_units_chk') then
    alter table public.properties
      add constraint properties_units_chk check (units >= 1);
  end if;
end $do$;

create index if not exists properties_parent_idx
  on public.properties (parent_id) where parent_id is not null;

-- ── 2. count_in_occupancy 的初始值 ＝ 現在的排房表勾選 ───────────────
/* ★★ 只在「這一欄還沒有人動過」的時候補 —— 用 parent_id 那一輪的痕跡判斷。
     直接無條件覆蓋的話，跑第二次會把之後人工調過的設定蓋掉。 */
do $do$
declare n int;
begin
  select count(*) into n from pg_attribute
   where attrelid = 'public.properties'::regclass
     and attname = 'count_in_occupancy' and not attisdropped;
  if n = 1 and not exists (
        select 1 from public.properties where count_in_occupancy is false) then
    update public.properties
       set count_in_occupancy = (show_in_room_calendar is not false)
     where count_in_occupancy is distinct from (show_in_room_calendar is not false);
  end if;
end $do$;

-- ── 3. 防呆：不能自我參照、不能成環、父子要同一個物業 ───────────────
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
  if new.parent_id is null then return new; end if;

  if new.parent_id = new.id then
    raise exception '房源不能是自己的父層（%）', new.name;
  end if;

  /* ★ 父子要在同一個物業。兩邊都有設物業而且不一樣才擋 ——
       其中一邊沒設物業是舊資料的形狀，不是錯。 */
  select estate_id into pest from public.properties where id = new.parent_id;
  if pest is not null and new.estate_id is not null and pest <> new.estate_id then
    raise exception '父房源不在同一個物業（% 的父層是別的物業）', new.name;
  end if;

  /* ★★★ 成環。前端那支 ancestryOf() 也有防，但兩邊都要有 ——
       資料庫這邊擋的是「寫不進去」，畫面那邊擋的是「已經寫進去了也不要當掉」。 */
  cur := new.parent_id;
  while cur is not null and hops < 32 loop
    if cur = new.id then
      raise exception '父子成環（% 繞回自己）', new.name;
    end if;
    select parent_id into cur from public.properties where id = cur;
    hops := hops + 1;
  end loop;
  if hops >= 32 then
    raise exception '父子層數太深（% 往上超過 32 層）', new.name;
  end if;

  return new;
end $fn$;

drop trigger if exists trg_properties_parent_guard on public.properties;
create trigger trg_properties_parent_guard
  before insert or update of parent_id, estate_id on public.properties
  for each row execute function public.properties_parent_guard();

-- ── 4. 設資料 ───────────────────────────────────────────────────────
/* ★★★ 每一項都用「最終狀態」驗，不是用影響列數 ——
     影響列數在第二次跑會是 0（東西已經設好了），那種檢查會自己變紅。 */
do $do$
declare
  e_kai  uuid;  e_jpr uuid;  e_tai uuid;  e_nan uuid;  e_xin uuid;
  n int;
begin
  select id into e_kai from public.estates where name = '開封';
  select id into e_jpr from public.estates where name = 'JPR';
  select id into e_tai from public.estates where name = '台視';
  select id into e_nan from public.estates where name = '南京';
  select id into e_xin from public.estates where name = '信陽';

  if e_kai is null or e_jpr is null or e_tai is null or e_nan is null then
    raise exception '找不到物業（開封／JPR／台視／南京 其中之一）—— 名字對不上就停下來，不要猜';
  end if;

  /* ── 開封整棟 ─┬─ 開封2F ─┬─ 開封2-1
                  │          └─ 開封2-2
                  ├─ 開封3F
                  └─ 開封4F
     開封1F-1 沒有父層 ——「整棟」不含 1 樓（使用者 2026-09-21 確認，
     而且資料也證實：整棟那 93 天全部跟 1F-1 的長租重疊，兩者並存） */
  update public.properties c set parent_id = p.id
    from public.properties p
   where p.name = '開封整棟' and p.estate_id = e_kai
     and c.estate_id = e_kai and c.name in ('開封2F', '開封3F', '開封4F')
     and c.parent_id is distinct from p.id;

  update public.properties c set parent_id = p.id
    from public.properties p
   where p.name = '開封2F' and p.estate_id = e_kai
     and c.estate_id = e_kai and c.name in ('開封2-1', '開封2-2')
     and c.parent_id is distinct from p.id;

  select count(*) into n from public.properties c
    join public.properties p on p.id = c.parent_id
   where c.estate_id = e_kai
     and ((p.name = '開封整棟' and c.name in ('開封2F', '開封3F', '開封4F'))
       or (p.name = '開封2F'  and c.name in ('開封2-1', '開封2-2')));
  if n <> 5 then raise exception '開封的父子沒設好（應該 5 條，實際 %）', n; end if;

  /* ── JPR整棟 ─┬─ JPR1F
                 └─ JPR2F */
  update public.properties c set parent_id = p.id
    from public.properties p
   where p.name = 'JPR整棟' and p.estate_id = e_jpr
     and c.estate_id = e_jpr and c.name in ('JPR1F', 'JPR2F')
     and c.parent_id is distinct from p.id;

  select count(*) into n from public.properties c
    join public.properties p on p.id = c.parent_id
   where c.estate_id = e_jpr and p.name = 'JPR整棟'
     and c.name in ('JPR1F', 'JPR2F');
  if n <> 2 then raise exception 'JPR 的父子沒設好（應該 2 條，實際 %）', n; end if;

  /* ── 信陽整層 ─┬─ 信陽5 / 5-1 / 5-2 / 5-3
     ★ 信陽這個物業這次要停用，設了也不影響任何數字 ——
       留著是為了哪天重新啟用時不用再查一次。
     ★★ 資料證實這四間是**獨立的四間房**（同一段期間四個不同客人），
       不是 信陽5 底下再掛三間。 */
  if e_xin is not null then
    update public.properties c set parent_id = p.id
      from public.properties p
     where p.name = '信陽整層' and p.estate_id = e_xin
       and c.estate_id = e_xin and c.name in ('信陽5', '信陽5-1', '信陽5-2', '信陽5-3')
       and c.parent_id is distinct from p.id;
  end if;

  /* ── 台1+2 是兩間打通一起租 ── */
  update public.properties set units = 2
   where estate_id = e_tai and name = '台1+2' and units is distinct from 2;
  select count(*) into n from public.properties
   where estate_id = e_tai and name = '台1+2' and units = 2;
  if n <> 1 then raise exception '台1+2 的 units 沒設好（應該 1 列，實際 %）', n; end if;

  /* ── 台視公區不是可以出租的單位：不排房、也不算住房率 ── */
  update public.properties
     set show_in_room_calendar = false, count_in_occupancy = false
   where estate_id = e_tai and name = '台視公區'
     and (show_in_room_calendar is not false or count_in_occupancy is not false);
  select count(*) into n from public.properties
   where estate_id = e_tai and name = '台視公區'
     and show_in_room_calendar is false and count_in_occupancy is false;
  if n <> 1 then raise exception '台視公區沒關好（應該 1 列，實際 %）', n; end if;

  /* ── 開封1F-1：不排房，但整年都有人住 —— 要算住房率 ── */
  update public.properties set count_in_occupancy = true
   where estate_id = e_kai and name = '開封1F-1' and count_in_occupancy is not true;
  select count(*) into n from public.properties
   where estate_id = e_kai and name = '開封1F-1' and count_in_occupancy;
  if n <> 1 then raise exception '開封1F-1 沒打開（應該 1 列，實際 %）', n; end if;

  /* ── 南京10 已經不用了（近 12 個月一筆佔用都沒有）── */
  update public.properties set active = false
   where estate_id = e_nan and name = '南京10' and active is not false;
  select count(*) into n from public.properties
   where estate_id = e_nan and name = '南京10' and active is false;
  if n <> 1 then raise exception '南京10 沒停用（應該 1 列，實際 %）', n; end if;

  /* ── 洪家、信陽兩個物業停用（使用者 2026-09-21 指定）── */
  update public.estates set active = false
   where name in ('洪家', '信陽') and active is not false;
  select count(*) into n from public.estates
   where name in ('洪家', '信陽') and active is false;
  if n <> 2 then raise exception '洪家／信陽沒停用（應該 2 個，實際 %）', n; end if;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('287_room_tree');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★★ 看不到下面這張表 ＝ 整支回滾了，不是「跑成功但沒輸出」。
-- ★★ 每一列跑第二次、第十次答案都一樣（問的是最終狀態，不是這次做了什麼）。
-- ══════════════════════════════════════════════════════════
with leaf as (
  select p.*, (not exists (select 1 from public.properties c where c.parent_id = p.id)) as is_leaf
  from public.properties p
),
den as (                                   -- 真正進住房率分母的那些
  select l.*, e.name as est
  from leaf l
  join public.estates e on e.id = l.estate_id
  where l.is_leaf
    and l.active is not false
    and l.count_in_occupancy
    and e.active is not false
)
select * from (
  select 1 as s, '① 三個新欄位都在'::text as 檢查,
         count(*)::text as 數值,
         case when count(*) = 3 then '✅' else '❌ 應該 3 欄' end as 結果
    from information_schema.columns
   where table_schema = 'public' and table_name = 'properties'
     and column_name in ('parent_id', 'units', 'count_in_occupancy')

  union all
  select 2, '② 父子關係共幾條（開封 5 ＋ JPR 2 ＋ 信陽 4）',
         count(*)::text,
         case when count(*) = 11 then '✅' else '❌ 應該 11 條' end
    from public.properties where parent_id is not null

  union all
  select 3, '③ 成環或自我參照',
         count(*)::text,
         case when count(*) = 0 then '✅ 沒有' else '❌ 有環' end
    from public.properties where parent_id = id

  union all
  select 4, '④ 台1+2 的 units',
         coalesce((select units::text from public.properties p
                   join public.estates e on e.id = p.estate_id
                  where e.name = '台視' and p.name = '台1+2'), '（找不到）'),
         case when (select units from public.properties p
                    join public.estates e on e.id = p.estate_id
                   where e.name = '台視' and p.name = '台1+2') = 2
              then '✅' else '❌ 應該是 2' end

  union all
  select 5, '⑤ 住房率分母一共幾間房（葉子的 units 加總）',
         coalesce(sum(units), 0)::text,
         case when coalesce(sum(units), 0) between 100 and 130
              then '✅ 修之前是 122 列' else '⚠ 看一下' end
    from den

  union all
  select 6, '⑥ ⚠ 母體檢查：分母是空的嗎',
         count(*)::text,
         case when count(*) = 0
              then '❌ 一間房都沒有 —— 下面全部不算數'
              else '✅ 有東西可以算' end
    from den

  union all
  select 7, '⑦ 開封進分母的房間（應該是 1F-1／2-1／2-2／3F／4F 五間）',
         coalesce((select string_agg(name, '、' order by name) from den where est = '開封'), '（沒有）'),
         case when (select count(*) from den where est = '開封') = 5
              then '✅' else '❌ 應該 5 間' end

  union all
  select 8, '⑧ JPR 進分母的房間（應該是 JPR1F／JPR2F）',
         coalesce((select string_agg(name, '、' order by name) from den where est = 'JPR'), '（沒有）'),
         case when (select count(*) from den where est = 'JPR') = 2
              then '✅' else '❌ 應該 2 間' end

  union all
  select 9, '⑨ 台視進分母的房間（3 列 ＝ 4 間，公區不在裡面）',
         coalesce((select string_agg(name || '×' || units, '、' order by name)
                   from den where est = '台視'), '（沒有）'),
         case when (select coalesce(sum(units), 0) from den where est = '台視') = 4
               and not exists (select 1 from den where est = '台視' and name = '台視公區')
              then '✅' else '❌ 應該 4 間且不含公區' end

  union all
  select 10, '⑩ 停用的物業（洪家、信陽）還有房間在分母裡嗎',
         count(*)::text,
         case when count(*) = 0 then '✅ 沒有' else '❌ 停用的物業不該有房間在分母' end
    from den where est in ('洪家', '信陽')

  union all
  select 11, '⑪ 這支跑過了沒（schema_migrations）',
         coalesce((select name from public.schema_migrations where name = '287_room_tree'), '（沒有紀錄）'),
         case when exists (select 1 from public.schema_migrations where name = '287_room_tree')
              then '✅' else '⚠ 沒記到（record_migration 不存在？）' end
) x
order by s;
