-- migration_67：房務設定的異動紀錄
--
-- hk_audit 在 migration_59 就建好了，說好要當出帳爭議的證據，
-- 但一直沒有任何地方寫入 —— 一張空表比沒有這張表更糟，
-- 因為它讓人以為有紀錄。
--
-- 【只記設定層，不記交易層】
-- 記的是 hk_staff / hk_property / hk_work_type / hk_setting ——
-- 那些改動會**追溯影響所有月份的計算**（改幾床、改計布巾開關），
-- 事後看到數字不對時需要知道「是誰在什麼時候改的」。
--
-- hk_work_item 的增刪不記。那是每天的操作，量大好幾個數量級，
-- 而且畫面上本來就看得到（虛線框 = 手動、✎ = 同步後被改過）。
--
-- 【changes 只存真的變動的欄位】
-- 存整列的 before/after 會讓這張表爆掉，而且要人自己比對哪裡不同。
-- 格式：{"beds": [3, 4], "linen_group": ["other", "zl"]}

create or replace function public.hk_audit_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec_key text;
  diff    jsonb := '{}'::jsonb;
  k       text;
  old_j   jsonb;
  new_j   jsonb;
begin
  -- 每張表的識別欄位不同，用 code / key 比 uuid 好認
  rec_key := coalesce(
    to_jsonb(coalesce(new, old)) ->> 'code',
    to_jsonb(coalesce(new, old)) ->> 'key',
    to_jsonb(coalesce(new, old)) ->> 'id',
    '?');

  if tg_op = 'INSERT' then
    insert into hk_audit (table_name, record_key, action, changes, user_id)
    values (tg_table_name, rec_key, 'insert', to_jsonb(new), auth.uid());
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into hk_audit (table_name, record_key, action, changes, user_id)
    values (tg_table_name, rec_key, 'delete', to_jsonb(old), auth.uid());
    return old;
  end if;

  -- UPDATE：只挑真的變了的欄位
  old_j := to_jsonb(old);
  new_j := to_jsonb(new);
  for k in select jsonb_object_keys(new_j) loop
    if old_j -> k is distinct from new_j -> k then
      diff := diff || jsonb_build_object(k, jsonb_build_array(old_j -> k, new_j -> k));
    end if;
  end loop;

  -- 沒有實際變動就不寫。前端的樂觀更新有時會送出一模一樣的值，
  -- 不擋的話這張表會被無意義的列塞滿。
  if diff = '{}'::jsonb then return new; end if;

  insert into hk_audit (table_name, record_key, action, changes, user_id)
  values (tg_table_name, rec_key, 'update', diff, auth.uid());
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['hk_staff', 'hk_property', 'hk_work_type', 'hk_setting']
  loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.hk_audit_log()', t);
  end loop;
end $$;


-- ============================================================
-- 驗證 —— 實際寫一次再回滾
--
-- 只 select 驗證不了觸發器跑不跑得動。sync_order_deposits 就是
-- 這樣壞了兩天沒被發現（migration_65），所以這裡實際做一次寫入。
-- ============================================================
do $$
declare n_before int; n_after int; sample jsonb;
begin
  select count(*) into n_before from hk_audit;

  -- 改一個無關痛癢的值再改回來
  update hk_setting set value = value where key = 'count_mode';          -- 值沒變 → 不該產生紀錄
  select count(*) into n_after from hk_audit;
  if n_after <> n_before then
    raise exception '值沒變卻寫入了紀錄，diff 判斷有問題';
  end if;

  update hk_work_type set sort = sort + 1000 where code = '清潔';        -- 真的變了 → 該有紀錄
  select count(*) into n_after from hk_audit;
  if n_after <> n_before + 1 then
    raise exception '真的變動卻沒寫入紀錄（before=% after=%）', n_before, n_after;
  end if;

  select changes into sample from hk_audit order by at desc limit 1;
  raise notice '觸發器正常。最後一筆 changes = %', sample;

  -- 還原
  update hk_work_type set sort = sort - 1000 where code = '清潔';
  delete from hk_audit where id > (select max(id) - 2 from hk_audit);
end $$;

select count(*) as 目前紀錄數 from public.hk_audit;


-- ── 記錄執行 ───────────────────────────────────────
-- 包在判斷裡，是因為建立 record_migration 的 migration_70 不一定先跑。
-- 順序不對只會少一筆紀錄，不該讓整支 migration 掛掉。
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('67_hk_audit_trigger'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
