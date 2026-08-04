-- migration_59：房務設定全面可維護
--
-- 目標：新增人員、新房源、改床數、改工作類型，全部在後台完成，不用改程式碼。
--
-- 這支只做「欄位擴充」，不重建 migration_58 的表 —— 那幾張表已經有 7 月的
-- 資料了，重建等於要人重匯一次。

-- ============================================================
-- 1. 人員：多個來源名稱、三色
--
-- timetree_names 是陣列而非單一欄位：排班系統上的顯示名會改
-- （SHAO-YING HSIEH 有時顯示成 Una），改一次就對不到人，
-- 而歷史事件裡兩種寫法會並存。
-- ============================================================
alter table public.hk_staff
  add column if not exists source_names text[] not null default '{}',
  add column if not exists color_text text,
  add column if not exists color_bar  text;

-- 既有的單一 source_name 併進陣列
update public.hk_staff
   set source_names = array[source_name]
 where source_names = '{}' and source_name is not null;

-- 對比度 >= 4.5:1 的文字色與左側色條（色盲使用者不靠底色也能分辨）
update public.hk_staff set color_text = '843C0C', color_bar = 'ED7D31' where code = 'UNA'  and color_text is null;
update public.hk_staff set color_text = '375623', color_bar = '70AD47' where code = '庭玉' and color_text is null;
update public.hk_staff set color_text = '3F3F3F', color_bar = '808080' where code = 'LIU'  and color_text is null;
update public.hk_staff set color = 'DEEBF7', color_text = '1F4E79', color_bar = '5B9BD5' where code = 'GT' and color_text is null;

comment on column public.hk_staff.source_names is
  '排班表上可能出現的顯示名，可多個 —— 同一個人在不同時期的顯示名不一定相同。';


-- ============================================================
-- 2. 房源：是否計布巾、類型
--
-- count_linen 跟 beds=0 是兩件事：
--   beds = 0        → 有床位概念但就是沒床（公區）
--   count_linen = false → 這個房源的清掃完全不進布巾統計
-- 分開才能表達「復興有床但布巾另計」這種情況。
-- ============================================================
alter table public.hk_property
  add column if not exists count_linen boolean not null default true,
  add column if not exists ptype text not null default 'room'
    check (ptype in ('room','building','common_area','other'));

update public.hk_property set ptype = 'common_area' where is_common and ptype = 'room';
update public.hk_property set ptype = 'building'
 where code in ('開整棟','JPR整棟') and ptype = 'room';


-- ============================================================
-- 3. 工作類型主檔
--
-- 原本工作類型是解析器裡的字串常數。搬進資料庫是為了
-- 「贈品補充要不要算布巾」這種問題可以由業務端自己調，不用改版。
-- ============================================================
create table if not exists public.hk_work_type (
  code           text primary key,
  name           text not null,
  count_workload boolean not null default true,   -- 計不計間數
  count_linen    boolean not null default true,   -- 計不計布巾
  sort           int not null default 0,
  active         boolean not null default true
);

insert into public.hk_work_type (code, name, count_workload, count_linen, sort) values
  ('退房清潔', '退房清潔', true,  true,  1),
  ('入住清潔', '入住清潔', true,  true,  2),
  ('換房清潔', '換房清潔', true,  true,  3),
  ('細清',     '細清',     true,  true,  4),
  ('公區清潔', '公區清潔', true,  false, 5),
  ('贈品補充', '贈品補充', true,  true,  6),
  ('點交',     '點交',     true,  false, 7),
  ('拆備品',   '拆備品',   true,  false, 8),
  ('清潔',     '清潔',     true,  true,  9),
  ('其他工時', '其他工時', true,  false, 10)
on conflict (code) do nothing;


-- ============================================================
-- 4. 工作項：手動編輯所需的欄位
--
-- source 是重同步保護的依據。沒有它，下次同步會把使用者手動加的
-- 項目一起洗掉 —— 那是最傷信任的一種 bug，因為使用者不會馬上發現。
-- ============================================================
alter table public.hk_work_item
  add column if not exists source text not null default 'timetree'
    check (source in ('timetree','manual','timetree_edited')),
  add column if not exists note text,
  add column if not exists version int not null default 1;

comment on column public.hk_work_item.source is
  'timetree = 同步產生；manual = 手動新增，同步永不刪除；timetree_edited = 同步後被改過。';

-- 手動新增的項目沒有來源事件
alter table public.hk_work_item alter column event_id drop not null;


-- ============================================================
-- 5. 系統參數
-- ============================================================
create table if not exists public.hk_setting (
  key         text primary key,
  value       text,
  vtype       text not null default 'text' check (vtype in ('text','int','bool','enum')),
  options     text[],
  description text,
  sort        int not null default 0
);

insert into public.hk_setting (key, value, vtype, options, description, sort) values
  ('count_mode', 'clean', 'enum', array['clean','headcount'],
   '打掃次數計法。clean = 同日同房源多人合掃算 1 次（布巾量才不會翻倍）；headcount = 人頭計次。', 1),
  ('include_gift', 'true', 'bool', null,
   '「贈」是否計入間數與次數。', 2),
  ('allow_manual_count', 'false', 'bool', null,
   '是否允許手動覆寫間數。預設關閉 —— 間數應該由房源格推導，手動改會讓兩份數字互相矛盾。', 3),
  ('sync_calendar_id', 'gkbU7n6wKd71', 'text', null,
   '排班行事曆 ID。', 4)
on conflict (key) do nothing;


-- ============================================================
-- 6. 異動紀錄
--
-- 出帳有爭議時，這張表就是證據。只記設定層的異動 ——
-- work_item 的每一筆增刪都記會把表撐爆，而且那些在畫面上看得到。
-- ============================================================
create table if not exists public.hk_audit (
  id          bigserial primary key,
  table_name  text not null,
  record_key  text not null,
  action      text not null,           -- insert / update / delete
  changes     jsonb,                   -- {欄位: [改前, 改後]}
  user_id     uuid,
  at          timestamptz not null default now()
);

create index if not exists hk_audit_at_idx on public.hk_audit (at desc);


-- ============================================================
-- 7. RLS：沿用 migration_58 的規則（主管與總經理）
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['hk_work_type','hk_setting','hk_audit']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format($f$
      create policy %I on public.%I for all
        using (current_role_of() in ('manager','super_admin'))
        with check (current_role_of() in ('manager','super_admin'))
    $f$, t || '_all', t);
  end loop;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select code, name, source_names, workload_mode_check.m as 計法, color, color_text, color_bar
from public.hk_staff
cross join lateral (select count_mode as m) workload_mode_check
order by sort;

select code, name, count_workload, count_linen from public.hk_work_type order by sort;
select key, value, vtype from public.hk_setting order by sort;

-- 手動項目不該有來源事件；同步項目應該要有
select source, count(*), count(event_id) as 有來源事件
from public.hk_work_item group by source;
