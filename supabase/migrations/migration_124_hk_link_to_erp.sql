-- migration_124：房務主檔對到 ERP 主檔（房源 ＋ 人員）
--
-- ============================================================
-- 【問題長什麼樣】（2026-08-14 的試算）
--
--     ⚠ 房源對不到  29 筆   19B2、6B2、JPR1、JPR2、亞曼尼、台2、台視公區、
--                           復興、時兆二樓、時兆公區、開2-1、開4、開封公區
--     ⚠ 人員對不到  52 筆   劉姐、庭玉
--     ★ 套上指派    只有 10 筆
--
-- 100 筆排班只套上 10 筆。不是資料壞了 —— 是**兩邊的主檔從來沒有對過**。
--
-- migration_122 用名字去猜：
--
--     left join properties p on p.name = hp.code or p.name = any(hp.aliases)
--
-- 房務那邊叫「開4」，ERP 那邊叫「開封4F」。字串比不出來，
-- 而人一看就知道是同一間。「JPR1 / JPR1F」「台2 / 台視2」都是同一回事。
--
--
-- ============================================================
-- 【為什麼不繼續加規則去猜】
--
-- 直覺是再補幾條：去掉「F」、把「開」補成「開封」、忽略大小寫。
-- 那條路會一直走下去，而且**錯的時候不會有人發現**：
--
--   「台2」猜成「台視2」聽起來合理，但如果 ERP 那邊其實叫「台北2」，
--   工作就被指派到另一間房去了 —— 排班表上看起來滿滿的，
--   實際上有人被派去清一間不用清的房，而該清的那間沒人。
--
-- 對應關係是**事實**，不是規則。事實只能問人一次，然後存起來。
-- 所以加兩欄外鍵，對一次，之後永遠不用再猜。
--
--
-- ============================================================
-- 【順帶解掉的：打掃報酬算不出來】
--
-- clean_points（migration_123）掛在 properties 上，
-- 而排班統計整頁是用 hk_property.code 在算 —— 中間沒有橋。
--
-- 這兩欄同時也是那座橋：hk_work_item → hk_property → properties.clean_points。

-- ── 一、對應欄位 ───────────────────────────────────

alter table public.hk_property
  add column if not exists property_id uuid references public.properties(id);

comment on column public.hk_property.property_id is
  '對應到 ERP 的房源。null = 還沒對 —— 那個房源的排班套不到行事曆上,'
  '而且算不出打掃報酬。到「房務設定 → 房源」用下拉選單指定,不要靠名字猜。';

create index if not exists hk_property_property_id_idx
  on public.hk_property (property_id) where property_id is not null;

/*
 * 一間 ERP 房源只能被一個房務代碼對到。
 *
 * 沒有這條的話，「開4」跟「開封4」可以同時指到「開封4F」——
 * 然後同一天同一間會產生兩份工作，布巾叫兩倍，
 * 而兩筆看起來都是對的。
 */
create unique index if not exists hk_property_property_id_uniq
  on public.hk_property (property_id) where property_id is not null;


alter table public.hk_staff
  add column if not exists staff_id uuid references public.staff(id);

comment on column public.hk_staff.staff_id is
  '對應到 ERP 的員工。null = 還沒對,這個人的排班一筆都套不進去。';

create unique index if not exists hk_staff_staff_id_uniq
  on public.hk_staff (staff_id) where staff_id is not null;


-- ── 二、回填：只填「一模一樣」的 ─────────────────────
--
-- 完全相同的名稱，或別名裡有完全相同的一項。**沒有模糊比對**。
--
-- 少填一個的代價是「那幾筆要人來對」，看得到、補得回來。
-- 填錯一個的代價是「工作被指派到別間房」，看不到、也沒人會問。
-- 兩種錯不對等，所以往少的那邊倒。
do $$
begin
  -- 房源：code 完全等於 properties.name
  update public.hk_property hp
     set property_id = p.id
    from public.properties p
   where hp.property_id is null
     and p.active
     and p.name = hp.code
     and not exists (select 1 from public.hk_property x where x.property_id = p.id);

  -- 房源：別名裡有一項完全等於 properties.name
  update public.hk_property hp
     set property_id = p.id
    from public.properties p
   where hp.property_id is null
     and p.active
     and p.name = any(hp.aliases)
     and not exists (select 1 from public.hk_property x where x.property_id = p.id);

  -- 人員：名字完全相同
  update public.hk_staff hs
     set staff_id = s.id
    from public.staff s
   where hs.staff_id is null
     and s.name = hs.name
     and not exists (select 1 from public.hk_staff x where x.staff_id = s.id);
end $$;


-- ── 三、整棟／整層的打掃點數 = 子房源加總 ─────────────
--
-- 【為什麼不手填】
--
-- 開封整棟 ＝ 2F ＋ 3F ＋ 4F ＝ (3＋2) ＋ 3 ＋ 4 ＝ 12。
-- 手填一個 12 進去，之後有人把 4F 從 4 調成 5，整棟還是 12 ——
-- 而那個 1 點的差每個月會少發一次，沒有人會發現。
--
-- 【子代沒填的維持 null，不當成 0】
--
-- JPR整棟的兩層都還沒設點數。加總成 0 的話，去掃 JPR 整棟的人
-- 那筆工作報酬是零 —— 他要對完整個月才講得出哪裡不對。
-- 維持 null，統計頁會明白寫「這幾筆算不出報酬」。
create or replace function public.recalc_clean_points() returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_round int := 0;
  v_n     int;
begin
  /*
   * 【為什麼要這個旗標】
   *
   * 這支函式會 update properties.clean_points，而下面的觸發器
   * 正是「clean_points 一改就呼叫這支」—— 它會呼叫自己，
   * 一路疊到 stack depth limit exceeded。
   *
   * pg_trigger_depth() 擋不乾淨：從 SQL 直接呼叫時深度是 0，
   * 第一層觸發器仍然會再進來一次。用交易內的旗標才是真的只跑一輪。
   * （第三個參數 true = 交易結束自動清掉，不會殘留到下一個交易。）
   */
  if coalesce(current_setting('app.recalc_points', true), '') = '1' then
    return;
  end if;
  perform set_config('app.recalc_points', '1', true);

  /*
   * 由下往上做。一層一層來，最多做 10 輪 ——
   * 房源的層數不會超過三層（整棟 → 樓層 → 房間），
   * 10 是給未來留的空間，同時也是防止資料出環時無限跑。
   * （防環觸發器已經擋在寫入端，這裡是第二道。）
   */
  loop
    v_round := v_round + 1;
    exit when v_round > 10;

    with kid as (
      select parent_property_id as pid,
             sum(clean_points)  as pts,
             count(*)                                as n_kids,
             count(clean_points)                     as n_set
        from public.properties
       where parent_property_id is not null
       group by parent_property_id
    )
    update public.properties p
       set clean_points = case when kid.n_set = kid.n_kids then kid.pts else null end
      from kid
     where p.id = kid.pid
       -- 只在真的會變的時候寫。不然每一輪都算「有更新」，永遠跑滿 10 輪
       and p.clean_points is distinct from
           (case when kid.n_set = kid.n_kids then kid.pts else null end);

    get diagnostics v_n = row_count;
    exit when v_n = 0;
  end loop;

  perform set_config('app.recalc_points', '', true);
end $fn$;

comment on function public.recalc_clean_points() is
  '有子房源的房源,打掃點數由子代加總 —— 手填的會被蓋掉,那是刻意的:'
  '整棟的難度就是各層加起來,不該跟各層對不上。子代有任何一個沒填就維持 null。';


/*
 * 子代的點數一改，祖先立刻跟著重算。
 *
 * 不做這個的話，改點數要記得「再去把整棟也改一次」——
 * 而忘記的那次不會報錯，只會讓那個月少發。
 *
 * 重入由 recalc_clean_points() 裡的旗標擋住 —— 這支只管呼叫。
 */
create or replace function public.trg_recalc_clean_points() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform public.recalc_clean_points();
  return null;
end $fn$;

drop trigger if exists trg_properties_clean_points on public.properties;
create trigger trg_properties_clean_points
  after insert or update of clean_points, parent_property_id or delete
  on public.properties
  for each statement execute function public.trg_recalc_clean_points();

select public.recalc_clean_points();


-- ── 四、套用函式改用對應欄位 ───────────────────────
--
-- 不再有任何名字比對。對不到就是對不到，報告會講是哪幾個，
-- 到「房務設定」對一次就好。
create or replace function public.hk_apply_timetree(
  p_from date, p_to date, p_dry boolean default true
) returns table(item text, n bigint, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_assigned bigint := 0;
  v_created  bigint := 0;
begin
  if current_role_of() not in ('manager', 'super_admin') then
    return query select '權限不足'::text, 0::bigint, '只有主管以上能套用排班'::text;
    return;
  end if;

  create temp table _tt_map on commit drop as
  select wi.id            as wi_id,
         wi.work_date,
         wi.work_type,
         wi.property_code,
         hp.property_id,
         hs.staff_id,
         hs.name          as hk_staff_name
    from hk_work_item wi
    left join hk_property hp on hp.code = wi.property_code
    left join hk_staff    hs on hs.id   = wi.staff_id
   where wi.work_date between p_from and p_to;

  if not p_dry then
    -- 一、有對到的工作 → 蓋掉指派。
    -- 工作類型也要對上 —— 不然退房的班會被指派成入住的人。
    with hit as (
      update hk_task t
         set staff_id = m.staff_id
        from _tt_map m
       where t.work_date   = m.work_date
         and t.property_id = m.property_id
         and t.work_type   = m.work_type
         and m.staff_id is not null
         and t.done_at is null            -- 做完的不動,那是已經發生的事實
      returning t.id
    ) select count(*) into v_assigned from hit;

    -- 二、TimeTree 有、ERP 沒有的 → 補一筆人工工作
    -- （公區清潔、贈品這些訂單推導不出來的）
    with miss as (
      insert into hk_task (work_date, property_id, work_type, staff_id, note)
      select m.work_date, m.property_id, m.work_type, m.staff_id, 'TimeTree 匯入'
        from _tt_map m
       where m.property_id is not null
         and not exists (
           select 1 from hk_task t
            where t.work_date = m.work_date
              and t.property_id = m.property_id
              and t.work_type = m.work_type)
      returning id
    ) select count(*) into v_created from miss;
  end if;

  -- ── 報告 ────────────────────────────────────
  return query
  select '期間'::text, 0::bigint, (p_from::text || ' ~ ' || p_to::text
    || case when p_dry then '（試算,沒有寫入）' else '' end);

  return query select 'TimeTree 排班筆數'::text, count(*), ''::text from _tt_map;

  return query
  select '★ 套上指派'::text,
         case when p_dry then
           (select count(*) from _tt_map m join hk_task t
              on t.work_date = m.work_date and t.property_id = m.property_id
             and t.work_type = m.work_type
            where m.staff_id is not null and t.done_at is null)
         else v_assigned end,
         '把「誰做」寫到已經存在的工作上'::text;

  return query
  select '★ 補上 ERP 沒有的工作'::text,
         case when p_dry then
           (select count(*) from _tt_map m
             where m.property_id is not null
               and not exists (select 1 from hk_task t
                     where t.work_date = m.work_date and t.property_id = m.property_id
                       and t.work_type = m.work_type))
         else v_created end,
         '公區清潔、贈品這些訂單推導不出來的'::text;

  /*
   * 對不到的兩條。detail 直接寫「怎麼修」——
   * 只報數字的話，看的人知道有問題但不知道下一步。
   */
  return query
  select '⚠ 房源還沒對到 ERP'::text, count(*),
         coalesce(string_agg(distinct property_code, '、'), '')
         || ' —— 到「房務管理 → 設定 → 房源」的「對應 ERP 房源」欄選一次'
    from _tt_map where property_id is null and property_code is not null;

  return query
  select '⚠ 人員還沒對到 ERP'::text, count(*),
         coalesce(string_agg(distinct hk_staff_name, '、'), '')
         || ' —— 到「房務管理 → 設定 → 人員」的「對應 ERP 員工」欄選一次'
    from _tt_map where staff_id is null and hk_staff_name is not null;

  return query
  select '★ 還是沒人指派的'::text, count(*),
         '訂單說那天要清,但排班表上沒有 —— 這幾筆要人補'::text
    from hk_task t
   where t.work_date between p_from and p_to
     and t.staff_id is null and t.done_at is null;
end $fn$;

grant execute on function public.hk_apply_timetree(date, date, boolean) to authenticated;

comment on function public.hk_apply_timetree(date, date, boolean) is
  '把 TimeTree 匯入的排班（hk_work_item）的「誰做」套到 hk_task 上。'
  '靠 hk_property.property_id / hk_staff.staff_id 對應,不做名字比對 —— '
  '猜錯的話工作會被指派到別間房,而那個錯沒有人會發現。'
  '只覆蓋指派,不刪任何工作。預設 dryRun。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('124_hk_link_to_erp');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk124;
  create temp table _chk124 (ord int, item text, result text, detail text);

  insert into _chk124 values (1, 'hk_property.property_id',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'hk_property'
                        and column_name = 'property_id') then '✅' else '❌' end, '');
  insert into _chk124 values (1, 'hk_staff.staff_id',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'hk_staff'
                        and column_name = 'staff_id') then '✅' else '❌' end, '');

  select count(*) into n from public.hk_property where active;
  select count(*) into m from public.hk_property where active and property_id is not null;
  insert into _chk124 values (2, '房源已對應', m || ' / ' || n, '完全同名的自動對好了');

  select count(*) into n from public.hk_staff where active;
  select count(*) into m from public.hk_staff where active and staff_id is not null;
  insert into _chk124 values (2, '人員已對應', m || ' / ' || n, '');

  -- 這兩條是要行動的清單
  select count(*) into n from public.hk_property where active and property_id is null;
  insert into _chk124 values (8, '★★ 房源還沒對應',
    case when n = 0 then '✅ 都對好了' else '⚠ ' || n || ' 個' end,
    case when n = 0 then '' else
      (select string_agg(code, '、' order by sort) from public.hk_property
        where active and property_id is null)
      || ' —— 到「房務管理 → 設定 → 房源」選對應的 ERP 房源。'
         '公區那幾個如果 ERP 沒有對應的房源,就留空,它們本來就不算報酬' end);

  select count(*) into n from public.hk_staff where active and staff_id is null;
  insert into _chk124 values (8, '★★ 人員還沒對應',
    case when n = 0 then '✅ 都對好了' else '⚠ ' || n || ' 人' end,
    case when n = 0 then '' else
      (select string_agg(name, '、' order by sort) from public.hk_staff
        where active and staff_id is null)
      || ' —— 到「房務管理 → 設定 → 人員」選對應的 ERP 員工' end);

  -- 點數加總有沒有生效
  insert into _chk124
  select 5, '★ ' || name || '（加總）', coalesce(clean_points::text, '算不出來（子代有沒填的）'), ''
    from public.properties
   where name in ('開封2F', '開封整棟', 'JPR整棟')
   order by name;

  select count(*) into n from public.properties where clean_points is null and active;
  insert into _chk124 values (9, '★★ 還沒設打掃點數',
    case when n = 0 then '✅ 都有了' else '⚠ ' || n || ' 間' end,
    case when n = 0 then '' else
      (select string_agg(p.name, '、' order by p.name) from public.properties p
        where p.clean_points is null and p.active
          and not exists (select 1 from public.properties c where c.parent_property_id = p.id))
      || ' —— 這些是「最小單位」的房源,只有它們要手填。'
         '整棟／整層會自己加總,不用管' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk124 order by ord, item;
