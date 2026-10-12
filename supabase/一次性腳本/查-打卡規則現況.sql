/*
 * 只查、不改：打卡現在怎麼判斷位置（2026-10-12，做「每人可打卡地點＋遠端打卡」之前）
 *   punch() 是很早期建的，專案資料夾裡沒有它的原始碼，要從線上印出來照著改。
 *   ★ 一張表，把「定義」那一欄整格複製貼回來就好。
 */
select '① punch() 的定義' as 項目, pg_get_functiondef(p.oid) as 內容
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'punch'
union all
select '② attendance 的欄位',
       string_agg(column_name || ' ' || data_type || coalesce(' default ' || column_default, ''), E'\n' order by ordinal_position)
  from information_schema.columns where table_schema = 'public' and table_name = 'attendance'
union all
select '③ 有設座標的物業',
       string_agg(name || '：' || gps_lat || ', ' || gps_lng || '（' || gps_radius_m || 'm）', E'\n' order by sort)
  from public.estates where gps_lat is not null
union all
select '④ 會打卡的人（profiles）',
       string_agg(name || '・' || role || '・' || id, E'\n' order by name)
  from public.profiles where role in ('housekeeper', 'manager', 'accountant', 'super_admin');
