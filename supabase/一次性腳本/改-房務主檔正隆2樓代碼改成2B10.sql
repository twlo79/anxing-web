/* 改：房務主檔「正隆2樓」→ 代碼改成 2B10（排班表上直接顯示 2B10）                    2026-10-05
 *
 * 【為什麼】上一支只把它對到 ERP 的 2B10，但排班表格子上寫的是房務主檔自己的代碼，所以還是「正隆2樓」。
 *   David：「還是顯示正隆 2F，不是 2B10」。
 *
 * 【做什麼】
 *   · 房務主檔還沒有 2B10 → 把「正隆2樓」那一列直接改名 2B10
 *   · 已經有一列 2B10 → 那一列接手（對到 ERP 2B10、算公區不算布巾），「正隆2樓」那一列停用
 *   · 所有用代碼記的地方（排班工單、月統計⋯ 自己掃 property_code 欄位，不列表名）'正隆2樓' → '2B10'
 *   · 「正隆2樓」加進 2B10 的別名 —— 之後 TimeTree 寫「正隆2樓」照樣認得到
 * ★ 月統計（hk_month_property）同一個月兩邊都有的話，那個月**不搬**、列在自檢裡給人決定（主鍵會撞）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
create temp table if not exists _mv (what text, n int) on commit preserve rows;

begin;
delete from _mv;

do $$
declare
  v_old public.hk_property; v_new public.hk_property; r record; k int; v_pid uuid;
begin
  select * into v_old from public.hk_property where code = '正隆2樓';
  select * into v_new from public.hk_property where code = '2B10';
  select p.id into v_pid from public.properties p join public.estates e on e.id = p.estate_id
   where e.name = '正隆' and p.name = '2B10';

  if v_old.id is null then
    insert into _mv values ('房務主檔沒有「正隆2樓」了（跑過了）', 0);
  elsif v_new.id is null then
    -- 直接改名
    update public.hk_property
       set code = '2B10', name = '2B10',
           aliases = case when '正隆2樓' = any(aliases) then aliases else array_append(aliases, '正隆2樓') end,
           property_id = coalesce(v_pid, property_id)
     where id = v_old.id;
    insert into _mv values ('房務主檔「正隆2樓」改名 2B10（別名留「正隆2樓」）', 1);
  else
    -- 已經有 2B10：讓它接手
    update public.hk_property
       set aliases = (select array_agg(distinct a) from unnest(aliases || v_old.aliases || array['正隆2樓']) a),
           property_id = coalesce(v_pid, property_id), ptype = v_old.ptype,
           count_linen = v_old.count_linen, beds = v_old.beds, linen_group = v_old.linen_group, active = true
     where id = v_new.id;
    update public.hk_property set active = false, aliases = '{}' where id = v_old.id;
    insert into _mv values ('房務主檔已有 2B10：接手別名與設定，「正隆2樓」那一列停用', 1);
  end if;

  -- 用代碼記的地方，一律改成 2B10（月統計主鍵會撞的那幾個月跳過）
  for r in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'property_code' and t.table_type = 'BASE TABLE'
  loop
    if r.table_name = 'hk_month_property' then
      update public.hk_month_property m set property_code = '2B10'
       where m.property_code = '正隆2樓'
         and not exists (select 1 from public.hk_month_property x where x.period = m.period and x.property_code = '2B10');
    else
      execute format('update public.%I set property_code = %L where property_code = %L', r.table_name, '2B10', '正隆2樓');
    end if;
    get diagnostics k = row_count;
    if k > 0 then insert into _mv values (r.table_name || '：正隆2樓 → 2B10', k); end if;
  end loop;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '這次改了什麼' as 檢查,
       coalesce((select string_agg(what || '（' || n || '）', '；') from _mv), '（沒有）') as 結果, 'ℹ' as 判定
union all
select 2, '房務主檔 2B10',
       coalesce((select code || '・對到 ' || coalesce((select name from public.properties where id = h.property_id), '沒接')
                        || '・別名 ' || array_to_string(aliases, '、') || '・' || case when active then '啟用' else '停用' end
                   from public.hk_property h where code = '2B10'), '★ 沒有'),
       case when exists (select 1 from public.hk_property where code = '2B10' and active and '正隆2樓' = any(aliases)) then '✅' else '❌' end
union all
select 3, '排班工單還寫著「正隆2樓」的（要 0）',
       (select count(*)::text from public.hk_work_item where property_code = '正隆2樓'),
       case when (select count(*) from public.hk_work_item where property_code = '正隆2樓') = 0 then '✅' else '❌' end
union all
select 4, '月統計兩邊都有、沒搬的月份（要人決定）',
       coalesce((select string_agg(period, '、' order by period) from public.hk_month_property where property_code = '正隆2樓'), '沒有'),
       'ℹ'
order by 1;
