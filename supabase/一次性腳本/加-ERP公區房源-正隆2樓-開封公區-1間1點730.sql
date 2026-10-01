/* ══════════════════════════════════════════════════════════════════════
 * 公區當房源：正隆2樓、開封公區 —— 各 1 間、1 點、清潔費 730，接到房務主檔       2026-09-30
 *
 * 【為什麼】9 月排班統計 6 筆「⚠ 未計」：這兩個公區在房務主檔（hk_property）裡沒接到
 *   ERP 房源（properties），打掃點數與清潔費都算不出來。David：「正隆 2F 1 間 1 點 730、開封公區 2F 1 間 1 點 730」。
 *
 * 【做什麼】
 *   1. properties 加兩筆（ptype common_area、clean_points 1、clean_price 730、units 1）
 *      · 不排房、不算住房率（show_in_room_calendar / count_in_occupancy 都 false）—— 公區不是房間
 *      · estate 用名字找「正隆」「開封」；找不到就整支停下來，不猜
 *      · 已經有同名的就直接用它（跑第二次不會多一筆）
 *   2. hk_property 的 正隆2樓、開封公區 接上 property_id
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  v_zl uuid; v_kf uuid; pid uuid; n int;
begin
  select id into v_zl from public.estates where name = '正隆';
  select id into v_kf from public.estates where name = '開封';
  if v_zl is null or v_kf is null then
    raise exception '找不到物業「正隆」或「開封」（正隆=%、開封=%）—— 整支停下來，一筆都沒寫', v_zl, v_kf;
  end if;

  -- 正隆2樓
  select id into pid from public.properties where name = '正隆2樓' limit 1;
  if pid is null then
    insert into public.properties (name, estate_id, ptype, clean_points, clean_price, units,
                                   show_in_room_calendar, count_in_occupancy, count_linen, active)
    values ('正隆2樓', v_zl, 'common_area', 1, 730, 1, false, false, false, true)
    returning id into pid;
  else
    update public.properties set clean_points = coalesce(clean_points, 1), clean_price = coalesce(clean_price, 730) where id = pid;
  end if;
  update public.hk_property set property_id = pid where code = '正隆2樓' and property_id is null;

  -- 開封公區
  select id into pid from public.properties where name = '開封公區' limit 1;
  if pid is null then
    insert into public.properties (name, estate_id, ptype, clean_points, clean_price, units,
                                   show_in_room_calendar, count_in_occupancy, count_linen, active)
    values ('開封公區', v_kf, 'common_area', 1, 730, 1, false, false, false, true)
    returning id into pid;
  else
    update public.properties set clean_points = coalesce(clean_points, 1), clean_price = coalesce(clean_price, 730) where id = pid;
  end if;
  update public.hk_property set property_id = pid where code = '開封公區' and property_id is null;
  get diagnostics n = row_count;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '兩個公區在 ERP 裡（物業・點數・清潔費）' as 檢查,
       (select string_agg(p.name || '：' || e.name || '・' || p.clean_points || ' 點・$' || p.clean_price::int
                          || '・排房 ' || p.show_in_room_calendar || '・算住房率 ' || p.count_in_occupancy, '；' order by p.name)
          from public.properties p join public.estates e on e.id = p.estate_id
         where p.name in ('正隆2樓', '開封公區')) as 結果,
       case when (select count(*) from public.properties where name in ('正隆2樓', '開封公區')
                    and clean_points = 1 and clean_price = 730 and not show_in_room_calendar and not count_in_occupancy) = 2
            then '✅' else '❌' end as 判定
union all
select 2, '房務主檔接上了',
       (select string_agg(h.code || '→' || coalesce(p.name, '沒接'), '、' order by h.code)
          from public.hk_property h left join public.properties p on p.id = h.property_id
         where h.code in ('正隆2樓', '開封公區')),
       case when (select count(*) from public.hk_property where code in ('正隆2樓', '開封公區') and property_id is not null) = 2 then '✅' else '❌' end
union all
select 3, '9 月還有幾筆算不出點數（要 0；劉姐那筆是時數制不算）',
       (select count(*)::text from public.hk_work_item w
          join public.hk_staff s on s.id = w.staff_id
          left join public.hk_property h on h.code = w.property_code
          left join public.properties p on p.id = h.property_id
         where w.period = '202609' and w.points_override is null and s.count_mode = 'rooms'
           and (h.property_id is null or p.clean_points is null)),
       case when (select count(*) from public.hk_work_item w
          join public.hk_staff s on s.id = w.staff_id
          left join public.hk_property h on h.code = w.property_code
          left join public.properties p on p.id = h.property_id
         where w.period = '202609' and w.points_override is null and s.count_mode = 'rooms'
           and (h.property_id is null or p.clean_points is null)) = 0 then '✅ 卡片上的「⚠ 未計」會消失' else '❌ 還有' end
order by 1;
