/*
 * migration_334_leave_attachments.sql　2026-10-19
 * 請假單可以附檔（診斷證明、收據照片），送出後也能補上傳
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *          ★★ 先跑這支，再推程式。
 *
 * 【David 2026-10-19】「請假申請可以上傳資料、圖片並可以預覽；已申請可以補上傳資料」
 *
 * 【這一支做的事】
 *   ① attachments 多一個母體 leave_request_id → leave_requests（路徑前綴 lv/）
 *      ★ on delete cascade：請假單被刪時附件一起走
 *      ★ 一次送出好幾天（同一個 batch_id）時，附件掛在那一批**最早的那一天**
 *   ② att_one_parent 重建（照 321／324／325 的作法：讀線上定義、加一欄、重建）
 *   ③ 權限：**看得到這張假單的人，就看得到、傳得上它的附件**
 *      —— 申請人自己、會審這張假的主管與總經理（跟假單本身同一套 RLS，不另外寫一份規則）
 *      ★ 做法是**另外加幾條 lv/ 專用的 policy**，不去改 can_see_receipt／can_edit_receipt：
 *        那兩支管了十幾種附件，改它的風險比這次要做的事大得多。policy 之間是「或」，
 *        lv/ 的路徑只會被這幾條放行，別的附件一條都沒動。
 *      ★ 這次不開刪除：上傳錯了請主管或總經理處理（前端也不顯示刪除鈕）。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table if not exists _chk334 (k text primary key, v text) on commit preserve rows;
truncate _chk334;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.leave_requests') is null then raise exception 'leave_requests 不在 —— 整支停下來'; end if;
  if to_regclass('public.attachments') is null then raise exception 'attachments 不在 —— 整支停下來'; end if;
  if to_regclass('storage.objects') is null then raise exception 'storage.objects 不在 —— 整支停下來'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') then
    raise exception 'attachments 上找不到 att_one_parent —— 前提不成立，整支停下來';
  end if;
end $do$;

-- ══════ ① 母體 ══════
alter table public.attachments add column if not exists leave_request_id uuid
  references public.leave_requests(id) on delete cascade;
create index if not exists att_leave_req_idx on public.attachments (leave_request_id) where leave_request_id is not null;
comment on column public.attachments.leave_request_id is
  '請假單的附件（migration_334）。路徑前綴 lv/。同一批請假掛在最早那一天。';

-- ══════ ② att_one_parent 加 leave_request_id ══════
do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';
  if position('leave_request_id' in def) > 0 then
    insert into _chk334 values ('att_one_parent', '已含 leave_request_id（跑過了）');
  else
    cols := btrim(substring(def from 'num_nonnulls\(([^)]*)\)'));
    if cols is null or cols = '' then
      select string_agg(m[1], ', ' order by m[1]) into cols
        from regexp_matches(def, '([a-z_][a-z0-9_]*)\s+IS\s+NOT\s+NULL', 'gi') as m;
    end if;
    if cols is null or cols = '' then raise exception 'att_one_parent 認不出欄位清單：%', def; end if;
    n := length(cols) - length(replace(cols, ',', '')) + 1;
    if n < 3 then raise exception 'att_one_parent 只解析出 % 欄（%），請人工確認：%', n, cols, def; end if;
    execute 'alter table public.attachments drop constraint att_one_parent';
    execute format('alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, leave_request_id) = 1)', cols);
    insert into _chk334 values ('att_one_parent', '原有 ' || n || ' 欄 ＋ leave_request_id');
  end if;
end $$;

-- ══════ ③ 權限 ══════
/*
 * ★★ security invoker（預設）—— 刻意的。
 *   用呼叫的人自己的身分去查 leave_requests，所以「看得到這張假」的規則就是假單本身那套 RLS：
 *   員工只看得到自己的、主管與總經理看得到要審的。不用在這裡再寫一份、然後哪天兩份不一樣。
 */
create or replace function public.can_see_leave_att(p_path text)
returns boolean language sql stable set search_path = public as $fn$
  select split_part(coalesce(p_path, ''), '/', 1) = 'lv'
     and split_part(p_path, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and exists (select 1 from public.leave_requests l where l.id = split_part(p_path, '/', 2)::uuid);
$fn$;
grant execute on function public.can_see_leave_att(text) to authenticated;

drop policy if exists att_read_lv on public.attachments;
create policy att_read_lv on public.attachments for select
  using (path like 'lv/%' and public.can_see_leave_att(path));

drop policy if exists att_write_lv on public.attachments;
create policy att_write_lv on public.attachments for insert
  with check (path like 'lv/%'
              and uploaded_by = auth.uid()
              and leave_request_id is not null
              and leave_request_id::text = split_part(path, '/', 2)
              and public.can_see_leave_att(path));

drop policy if exists lv_obj_read on storage.objects;
create policy lv_obj_read on storage.objects for select
  using (bucket_id = 'receipts' and name like 'lv/%' and public.can_see_leave_att(name));

drop policy if exists lv_obj_write on storage.objects;
create policy lv_obj_write on storage.objects for insert
  with check (bucket_id = 'receipts' and name like 'lv/%' and public.can_see_leave_att(name));

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('334_leave_attachments');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'attachments 多了 leave_request_id' as 檢查,
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'attachments' and column_name = 'leave_request_id') then '有' else '沒有' end as 結果,
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'attachments' and column_name = 'leave_request_id') then '✅' else '❌' end as 判定
union all
select 2, '附件掛得上請假單（att_one_parent 含 leave_request_id）',
       coalesce((select v from _chk334 where k = 'att_one_parent'), '—'),
       case when (select pg_get_constraintdef(oid) from pg_constraint
                   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') like '%leave_request_id%'
            then '✅' else '❌' end
union all
select 3, '權限：附件表 2 條（看、傳）',
       (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'attachments'
         and policyname in ('att_read_lv', 'att_write_lv')) || ' 條',
       case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'attachments'
                   and policyname in ('att_read_lv', 'att_write_lv')) = 2 then '✅' else '❌' end
union all
select 4, '權限：檔案 2 條（看、傳）',
       (select count(*)::text from pg_policies where schemaname = 'storage' and tablename = 'objects'
         and policyname in ('lv_obj_read', 'lv_obj_write')) || ' 條',
       case when (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname in ('lv_obj_read', 'lv_obj_write')) = 2 then '✅' else '❌' end
order by 1;
