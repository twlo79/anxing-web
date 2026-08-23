-- migration_119：房源的「上層房源」（同一個空間的不同賣法）
--
-- ============================================================
-- 【要解決什麼】
--
-- 同一塊空間有好幾種賣法，而它們在系統裡是各自獨立的房源：
--
--     開封整棟
--       ├─ 開封2F          開封整棟 ＝ 2F ＋ 3F ＋ 4F
--       │    ├─ 開封2-1     開封2F   ＝ 2-1 ＋ 2-2
--       │    └─ 開封2-2
--       ├─ 開封3F
--       └─ 開封4F
--     開封1F-1              ← 不在整棟裡
--     開封店面              ← 不在整棟裡
--
-- 「同一間房不能同時被兩個人訂」那條檢查看不到這個關係：
-- 整棟被訂走的同一段期間，2-1 照樣可以被訂走，而防呆完全不會出聲。
--
-- 那是真的撞房 —— 客人到現場會發現房間有別人，
-- 而且通常是入住當天才發現。
--
--
-- ============================================================
-- 【為什麼不是「整棟」一個布林欄位】
--
-- 這一版的前身就是那樣做的，範圍取「同一個物業」。JPR 剛好成立
-- （JPR1F / JPR2F / JPR整棟 三個全都互斥），開封就整個垮掉：
--
--   · 開封店面、開封1F-1 **不在**整棟裡，卻會被標成撞房
--   · 開封2F 與 開封2-1 是真的撞房，卻抓不到 —— 因為 2F 不是「整棟」
--
-- 真正的關係是一棵樹，不是「整棟 vs 其他」。所以存**上層房源**：
-- 每個房源指向包含它的那一個。
--
-- 規則變成一句話：
--
--     **兩筆訂單的房源在同一條祖先鏈上（一個包含另一個），
--       期間重疊就是撞房。**
--
-- 兄弟不算（開封2F 與 開封3F 各自獨立），沒有上層的也不算
-- （開封店面跟誰都不衝突）。
--
--
-- ============================================================
-- 【如果你已經跑過這支的前一版】
--
-- 前一版加的是 is_whole_building。再跑一次是安全的 ——
-- 下面會把那一欄的資料轉成 parent_property_id 再標記棄用。

alter table public.properties
  add column if not exists parent_property_id uuid references public.properties(id);

comment on column public.properties.parent_property_id is
  '包含這個房源的上層房源。開封2-1 → 開封2F → 開封整棟。'
  '訂單頁的「👀防呆」用它抓「同一塊空間被賣了兩次」。';

create index if not exists idx_properties_parent
  on public.properties (parent_property_id) where parent_property_id is not null;


/*
 * 不能指向自己，也不能繞回來。
 *
 * 【為什麼要用觸發器而不是 CHECK】
 * CHECK 只看得到這一列。「A 的上層是 B、B 的上層是 A」這種環
 * 要往上追才看得出來 —— 而一旦成環，下面的遞迴查詢會直接無窮迴圈。
 */
create or replace function public.properties_no_cycle() returns trigger
language plpgsql as $fn$
declare v_id uuid; n int := 0;
begin
  if new.parent_property_id is null then return new; end if;
  if new.parent_property_id = new.id then
    raise exception '房源的上層不能是自己';
  end if;

  v_id := new.parent_property_id;
  while v_id is not null loop
    n := n + 1;
    if v_id = new.id then
      raise exception '這樣會繞成一個圈（% 已經在它的下層）', new.name;
    end if;
    -- 保險絲：資料已經壞掉時不要無窮迴圈
    if n > 20 then raise exception '房源的層數超過 20 層，資料可能已經成環'; end if;
    select parent_property_id into v_id from public.properties where id = v_id;
  end loop;
  return new;
end $fn$;

drop trigger if exists trg_properties_no_cycle on public.properties;
create trigger trg_properties_no_cycle
  before insert or update of parent_property_id on public.properties
  for each row execute function public.properties_no_cycle();


-- ============================================================
-- 舊版的 is_whole_building：把資料轉過來
-- ============================================================
--
-- 前一版的語意是「同物業內，整棟與其他所有房源互斥」。
-- 轉換時照那個語意接：同物業裡沒有上層的房源，指向那個整棟。
-- **不含整棟自己**，也不覆蓋已經設好的。
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name = 'properties' and column_name = 'is_whole_building') then

    update public.properties p
       set parent_property_id = w.id
      from public.properties w
     where w.is_whole_building
       and w.estate_id = p.estate_id
       and p.id <> w.id
       and p.parent_property_id is null
       and coalesce(p.is_whole_building, false) = false;

    execute $c$ comment on column public.properties.is_whole_building is
      '⚠️ 已由 parent_property_id 取代（migration_119）。'
      '「整棟 vs 其他」表達不了三層結構 —— 開封整棟只含 2F/3F/4F，'
      '而 2F 自己又含 2-1/2-2。不要再讀它。' $c$;
  end if;
end $$;


-- ============================================================
-- 查一個房源的所有上層（給畫面與檢查用）
-- ============================================================
create or replace function public.property_ancestors(p_id uuid)
returns table(id uuid, name text, depth int)
language sql stable as $fn$
  with recursive up as (
    select pr.parent_property_id as pid, 1 as depth
      from public.properties pr where pr.id = p_id
    union all
    select pr.parent_property_id, up.depth + 1
      from public.properties pr
      join up on pr.id = up.pid
     where up.pid is not null and up.depth < 20
  )
  select p.id, p.name, up.depth
    from up join public.properties p on p.id = up.pid
   order by up.depth
$fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('119_property_parent');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; v_est uuid; a uuid; b uuid;
begin
  drop table if exists _chk119;
  create temp table _chk119 (ord int, item text, result text, detail text);

  insert into _chk119 values (1, 'parent_property_id 欄位',
    case when exists (select 1 from information_schema.columns
                      where table_name = 'properties' and column_name = 'parent_property_id')
         then '✅' else '❌' end, '');

  -- 成環要被擋下來
  select id into v_est from public.estates limit 1;
  delete from public.properties where name in ('__t119_a__', '__t119_b__');
  insert into public.properties (name, estate_id) values ('__t119_a__', v_est) returning id into a;
  insert into public.properties (name, estate_id) values ('__t119_b__', v_est) returning id into b;
  update public.properties set parent_property_id = a where id = b;
  begin
    update public.properties set parent_property_id = b where id = a;
    insert into _chk119 values (2, '★★ 上層繞成圈要被擋', '❌ 沒擋住',
      '成環的話往上追會無窮迴圈,整個防呆會卡死');
  exception when others then
    insert into _chk119 values (2, '★★ 上層繞成圈要被擋', '✅ 資料庫層級擋下',
      '只在畫面上擋的話,直接下 SQL 就繞過去了');
  end;

  insert into _chk119 values (3, '★ 查得到所有上層',
    case when (select count(*) from public.property_ancestors(b)) = 1 then '✅' else '❌' end,
    '開封2-1 要查得到 2F 與整棟兩層');

  delete from public.properties where name in ('__t119_a__', '__t119_b__');

  select count(*) into n from public.properties where parent_property_id is not null;
  insert into _chk119 values (4, '目前有設上層的房源', n || ' 間',
    case when n = 0 then '到「房源管理」設定 —— 沒設就不做這個檢查,不會誤報' else '' end);

  /*
   * 名稱看起來有包含關係但沒設的。不自動幫他設 ——
   * 命名會飄，而猜錯的兩種後果都很糟：
   * 猜多了整排正常訂單被標紅，猜少了撞房抓不到。
   */
  select count(*) into n from public.properties
   where parent_property_id is null
     and (name like '%整棟%' or name like '%全棟%' or name like '%包棟%');
  insert into _chk119 values (5, '看起來是整棟的房源',
    case when n = 0 then '－' else n || ' 間' end,
    case when n = 0 then ''
         else (select string_agg(name, '、') from public.properties
                where parent_property_id is null
                  and (name like '%整棟%' or name like '%全棟%' or name like '%包棟%'))
              || ' —— 整棟自己不用設上層,但它底下的樓層要把上層指到它' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk119 order by ord, item;
