/* 改：房務的「正隆2樓」對到 ERP 的 2B10（不是另外建的「正隆2樓」）                     2026-10-05
 *
 * 【為什麼】9/30 那支「加-ERP公區房源」在 ERP 房源裡另外建了一筆「正隆2樓」（公區、1 點、730）。
 *   David：「正隆 2B10」—— 正隆 2 樓就是 2B10 那一間，不用另外一筆。
 *
 * 【做什麼】
 *   ① 房務主檔 正隆2樓 → 接到 ERP 的 2B10
 *   ② 2B10 的打掃點數／清潔費是空的話，抄「正隆2樓」那筆的（1 點、730）；有值的不碰
 *   ③ 之前掛在 ERP「正隆2樓」上的資料（房務工單拆帳、支出⋯ 所有指向它的外鍵）一律改掛 2B10
 *   ④ ERP「正隆2樓」停用（不刪 —— 回收桶以外的刪除不做）
 * ★ 2B10 找不到、或正隆有兩筆 2B10 → 整支停下來，一筆都不改。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
create temp table if not exists _mv (tbl text, col text, n int) on commit preserve rows;

begin;
delete from _mv;

do $$
declare
  v_new uuid; v_old uuid; v_cnt int; r record; k int;
begin
  select count(*), min(p.id::text)::uuid into v_cnt, v_new
    from public.properties p join public.estates e on e.id = p.estate_id
   where p.name = '2B10' and e.name = '正隆';
  if v_cnt <> 1 then
    raise exception '正隆的 2B10 找到 % 筆（要剛好 1 筆）—— 整支停下來', v_cnt;
  end if;
  select id into v_old from public.properties where name = '正隆2樓' and id <> v_new limit 1;

  -- ① 房務主檔
  update public.hk_property set property_id = v_new where code = '正隆2樓' and property_id is distinct from v_new;
  get diagnostics k = row_count;
  if k > 0 then insert into _mv values ('hk_property（房務主檔 正隆2樓）', 'property_id', k); end if;

  if v_old is not null then
    -- ② 點數／清潔費：2B10 空的才抄
    update public.properties n
       set clean_points = coalesce(n.clean_points, o.clean_points),
           clean_price  = coalesce(n.clean_price,  o.clean_price)
      from public.properties o
     where n.id = v_new and o.id = v_old;

    -- ③ 所有指向舊那筆的外鍵改指 2B10（自己查有哪些欄位，不列表名 —— 列表名會漏）
    for r in
      select c.conrelid::regclass::text as tbl, a.attname as col
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = 'public.properties'::regclass
         and array_length(c.conkey, 1) = 1
         and c.conrelid <> 'public.hk_property'::regclass
    loop
      execute format('update %s set %I = $1 where %I = $2', r.tbl, r.col, r.col) using v_new, v_old;
      get diagnostics k = row_count;
      if k > 0 then insert into _mv values (r.tbl, r.col, k); end if;
    end loop;

    -- ④ 停用舊那筆
    update public.properties set active = false where id = v_old and active;
    get diagnostics k = row_count;
    if k > 0 then insert into _mv values ('properties（ERP「正隆2樓」）', 'active → false', k); end if;
  end if;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '房務主檔 正隆2樓 現在對到' as 檢查,
       coalesce((select p.name || '（' || coalesce(p.clean_points::text, '?') || ' 點・$' || coalesce(p.clean_price::int::text, '?') || '）'
                   from public.hk_property h join public.properties p on p.id = h.property_id where h.code = '正隆2樓'), '★ 沒對到') as 結果,
       case when exists (select 1 from public.hk_property h join public.properties p on p.id = h.property_id
                          where h.code = '正隆2樓' and p.name = '2B10') then '✅' else '❌' end as 判定
union all
select 2, '這次搬了什麼',
       coalesce((select string_agg(tbl || '.' || col || ' ' || n || ' 筆', '；') from _mv), '（沒有 —— 跑過了）'), 'ℹ'
union all
select 3, '房務主檔還有沒有掛在 ERP「正隆2樓」（要 0）',
       coalesce((select (select count(*) from public.hk_property where property_id = p.id)::text from public.properties p where p.name = '正隆2樓' limit 1), '（沒有這筆）'),
       'ℹ 停用後不會再出現在選單'
order by 1;
