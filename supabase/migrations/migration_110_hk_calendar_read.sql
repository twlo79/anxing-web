-- migration_110：房務排班開放給全公司唯讀
--
-- ============================================================
-- 【為什麼要開】
--
-- 出勤頁要加一個「房務行事曆」，讓大家看得到每天哪些房源要清、誰負責。
-- 但 hk_* 那幾張表在 migration_58 是「主管以上才能讀寫」——
-- 房管打開那個分頁會是全空的，而且不會有錯誤訊息，
-- 看起來就像「這個月沒有排班」。
--
--
-- ============================================================
-- 【為什麼是全公司看全部，而不是各看各的】（使用者指定）
--
-- 排班表上的房務人員（hk_staff）跟登入帳號（profiles）是兩套人 ——
-- hk_staff 裡有外包廠商，也有根本沒有系統帳號的人，兩張表之間沒有對應欄位。
-- 「只看自己的」得先建立那層對應，而排班本來就是要互相配合的資訊：
-- 今天誰在哪一棟、誰可以幫忙、誰休假，那是全組都該知道的事。
--
--
-- ============================================================
-- 【讀寫分開】
--
-- 這支只加 **select**。新增、修改、刪除仍然只有主管以上 ——
-- 原本那條 for all 的政策留著沒動。
--
-- 用兩條政策而不是把原本那條改寬：政策之間是 OR，
-- 寫入路徑完全不受這支影響。改寬原本那條的話，
-- 一個手滑就會連 with check 一起放寬，而那不會有任何症狀。
-- ============================================================

do $$
declare t text;
begin
  -- hk_day / hk_month_property / hk_period 不開 ——
  -- 那些是個人工時與計薪基礎，不是「今天誰在哪裡」。
  -- 行事曆用不到它們，開了只是擴大暴露面。
  foreach t in array array['hk_staff', 'hk_property', 'hk_work_item', 'hk_event']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format($f$
      create policy %I on public.%I for select
        using (current_role_of() is not null)
    $f$, t || '_read', t);
  end loop;
end $$;

-- hk_work_type 存的是「清潔 / 洗烘折 / 入住準備」這種名稱對照，
-- 沒有它行事曆上只會顯示代碼。這張表 migration_58 沒有納入 RLS 迴圈，
-- 這裡明確處理，不要依賴「剛好沒開 RLS」這種預設。
do $$ begin
  if to_regclass('public.hk_work_type') is not null then
    execute 'alter table public.hk_work_type enable row level security';
    execute 'drop policy if exists hk_work_type_read on public.hk_work_type';
    execute $f$create policy hk_work_type_read on public.hk_work_type for select
                using (current_role_of() is not null)$f$;
    execute 'drop policy if exists hk_work_type_write on public.hk_work_type';
    execute $f$create policy hk_work_type_write on public.hk_work_type for all
                using (current_role_of() in ('manager','super_admin'))
                with check (current_role_of() in ('manager','super_admin'))$f$;
  end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('110_hk_calendar_read');
  end if;
end $$;


-- ============================================================
-- 確認（表格輸出）
-- ============================================================
do $$
declare hk_id uuid; admin_id uuid; n_read int; n_write int;
begin
  drop table if exists _chk110;
  create temp table _chk110 (n int, item text, result text, detail text);

  insert into _chk110
  select 1, '唯讀政策已建立',
    case when count(*) = 5 then '✅' else '❌ 只有 ' || count(*) || '/5' end,
    string_agg(tablename, '、' order by tablename)
  from pg_policies
  where schemaname = 'public' and policyname like 'hk\_%\_read';

  -- 房管真的讀得到嗎（不是看政策文字，是實際查一次）
  select id into hk_id from public.profiles where role = 'housekeeper' limit 1;
  if hk_id is null then
    insert into _chk110 values (2, '房管讀得到排班', '－', '沒有房管帳號,跳過');
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', hk_id::text)::text, true);
    -- 注意：這個 do 區塊本身是 superuser 執行，RLS 不會套用在這裡，
    -- 所以只能驗政策存在＋角色函式有回值。真正的驗證在畫面上。
    insert into _chk110 values (2, '房管的角色判定',
      case when current_role_of() = 'housekeeper' then '✅' else '❌ ' || coalesce(current_role_of(), 'null') end,
      'current_role_of() 有值，唯讀政策才會通過');
  end if;

  -- 寫入仍然只有主管以上
  select count(*) into n_write from pg_policies
   where schemaname = 'public' and tablename = 'hk_work_item'
     and cmd = 'ALL' and coalesce(qual, '') like '%manager%';
  insert into _chk110 values (3, '★ 寫入權限沒有被放寬',
    case when n_write >= 1 then '✅ 仍然只有主管以上' else '❌ 原本的寫入政策不見了' end, '');

  -- 個人工時類的表不該被開放
  select count(*) into n_read from pg_policies
   where schemaname = 'public' and tablename in ('hk_day', 'hk_month_property', 'hk_period')
     and policyname like '%\_read';
  insert into _chk110 values (4, '★ 工時與計薪的表沒有被開放',
    case when n_read = 0 then '✅' else '❌ 開了 ' || n_read || ' 張' end,
    'hk_day / hk_month_property / hk_period');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk110 order by n;
