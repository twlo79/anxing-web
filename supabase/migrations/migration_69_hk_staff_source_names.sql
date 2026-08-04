-- migration_69：收斂 hk_staff.source_name → source_names[]
--
-- 【問題一：兩個欄位，只有一個被維護】
-- 一個人在排班表上可能有多個顯示名（「SHAO-YING HSIEH」和「Una」是同一個人），
-- 所以 migration_58 之後加了 source_names[]。但舊的 source_name 沒有拿掉。
--
-- 設定頁的「排班表顯示名」輸入框只寫 source_names。改過名字之後，
-- source_name 就停在舊值，而且它還帶著 unique 約束 ——
-- 擋的是一個沒人維護的欄位，真正拿來比對的 source_names 反而沒擋。
--
-- 【問題二：兩個人可以宣告同一個顯示名，而且不會報錯】
-- staffLookup() 是把名字塞進 Map，後蓋前。兩個人都填「花花」的話，
-- 其中一個人的工作會**整批算到另一個人頭上**，畫面上什麼都不會說。
-- 月底看到某人間數莫名變少，追起來很難。
--
-- 這支做三件事：
--   1. 把 source_name 的值併回 source_names（不能掉資料）
--   2. 加上「不可為空」與「不可與其他在職人員重名」的約束
--   3. 移除 source_name
--
-- 【⚠ 這支要在 deploy 之前跑】
-- source_name 目前是 not null。新版的設定頁「新增人員」不再送這個欄位，
-- 所以程式先上線、SQL 還沒跑的那段時間，新增人員會失敗
-- （null value in column "source_name" violates not-null constraint）。
-- 其他功能不受影響 —— 只有新增人員這一個動作會中。
-- 順序反了也不會壞資料，跑完 SQL 就恢復。

-- ── 1. 回填 ────────────────────────────────────────
-- 只補進去，不覆蓋。source_names 已經有值的以它為準（那是有人手動維護過的）。
update public.hk_staff
   set source_names = array[source_name]
 where coalesce(array_length(source_names, 1), 0) = 0
   and source_name is not null and source_name <> '';

-- 有些人可能 source_names 有值但漏掉了原本的 source_name
-- 用 array_append 而不是 ||：migration_65 就是被 `text[] || 字串` 咬到的，
-- Postgres 會優先解讀成 陣列‖陣列 然後噴 malformed array literal。
-- 這裡 source_name 有明確型別所以其實不會中，但不想再讓下一個人踩。
update public.hk_staff
   set source_names = array_append(source_names, source_name)
 where source_name is not null and source_name <> ''
   and not (source_name = any (source_names));

-- ── 2. 回填完整性檢查（沒過就整支回滾）────────────
do $$
declare empty_cnt int; lost text;
begin
  select count(*) into empty_cnt
  from public.hk_staff where coalesce(array_length(source_names, 1), 0) = 0;
  if empty_cnt > 0 then
    raise exception '還有 % 位人員的 source_names 是空的，回填不完整，中止', empty_cnt;
  end if;

  select string_agg(code, ', ') into lost
  from public.hk_staff
  where source_name is not null and source_name <> ''
    and not (source_name = any (source_names));
  if lost is not null then
    raise exception 'source_name 沒有被併進 source_names:%，中止', lost;
  end if;

  raise notice '回填完成，沒有掉資料';
end $$;

-- ── 3. 重名防呆 ────────────────────────────────────
-- 在職人員之間不可共用顯示名。停用的不管 —— 人離職後名字要能給新人用。
create or replace function public.hk_staff_no_dup_source_name() returns trigger
language plpgsql as $$
declare clash text;
begin
  -- 空陣列、{NULL}、{''} 都算沒填。array_length 只擋得掉第一種。
  new.source_names := array(
    select btrim(x) from unnest(coalesce(new.source_names, '{}'::text[])) x
    where x is not null and btrim(x) <> '');

  if array_length(new.source_names, 1) is null then
    raise exception '「%」至少要有一個排班表顯示名，否則排班表上的工作對不到人', new.name;
  end if;

  if not new.active then return new; end if;

  select string_agg(format('%s（%s）', s.name, x), '、') into clash
  from public.hk_staff s, unnest(s.source_names) x
  where s.id <> new.id and s.active and x = any (new.source_names);

  if clash is not null then
    raise exception
      '顯示名重複:% 已經被使用。兩個人共用同一個名字的話，其中一位的工作會整批算到另一位頭上',
      clash;
  end if;
  return new;
end $$;

drop trigger if exists trg_hk_staff_no_dup on public.hk_staff;
create trigger trg_hk_staff_no_dup
  before insert or update of source_names, active on public.hk_staff
  for each row execute function public.hk_staff_no_dup_source_name();

-- 現有資料先驗一遍，有重名的話約束建了也是壞的
do $$
declare dup text;
begin
  select string_agg(format('%s → %s', x, names), E'\n') into dup
  from (
    select x, string_agg(s.name, '、') as names
    from public.hk_staff s, unnest(s.source_names) x
    where s.active
    group by x having count(*) > 1
  ) t;
  if dup is not null then
    raise exception '現有資料就有重名，先到設定頁修掉再跑這支:%', dup;
  end if;
end $$;

-- ── 4. 移除舊欄位 ──────────────────────────────────
alter table public.hk_staff drop column if exists source_name;

comment on column public.hk_staff.source_names is
  '排班表上的顯示名（可多個，同一人在來源可能有不同寫法）。'
  '比對負責人的唯一依據 —— 原本的單數 source_name 已於 migration_69 移除。'
  '在職人員之間不可重複，由 trg_hk_staff_no_dup 擋住。';


-- ============================================================
-- 驗證 —— 實際寫一次再回滾
-- 只 select 驗證不到觸發器（migration_65 就是這樣漏掉的）
-- ============================================================
select code, name, source_names, active from public.hk_staff order by sort;

do $$
declare victim uuid; other_name text; ok boolean := false;
begin
  select id into victim from public.hk_staff where active order by sort limit 1;
  select x into other_name
  from public.hk_staff s, unnest(s.source_names) x
  where s.active and s.id <> victim limit 1;

  if victim is null or other_name is null then
    raise notice '在職人員不足兩位，跳過重名驗證';
    return;
  end if;

  -- 搶別人的顯示名 → 應該被擋
  -- 若沒被擋，例外分支不會執行，ok 維持 false，下面就會中止整支 migration，
  -- 被改壞的那一列也跟著回滾。
  begin
    update public.hk_staff set source_names = array[other_name] where id = victim;
  exception when others then ok := true;
  end;
  if not ok then raise exception '重名沒有被擋，觸發器沒生效（已回滾）'; end if;

  -- 清空顯示名 → 應該被擋
  ok := false;
  begin
    update public.hk_staff set source_names = '{}'::text[] where id = victim;
  exception when others then ok := true;
  end;
  if not ok then raise exception '空的顯示名沒有被擋'; end if;

  raise notice '防呆正常:重名與空值都擋得住';
end $$;

select count(*) as 人員數, count(*) filter (where active) as 在職 from public.hk_staff;


-- ── 記錄執行 ───────────────────────────────────────
-- 包在判斷裡，是因為建立 record_migration 的 migration_70 不一定先跑。
-- 順序不對只會少一筆紀錄，不該讓整支 migration 掛掉。
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('69_hk_staff_source_names'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
