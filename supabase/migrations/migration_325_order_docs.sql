/*
 * migration_325_order_docs.sql　2026-10-08
 * 訂單也能放合約 PDF（跟契約文件同一套，migration_324）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *          ★★ migration_324 要先跑（這一支要用它加的 doc_kind）。
 *
 * 【使用者 2026-10-08】「訂單也加入 放合約的功能~ 同樣模式加入」
 *
 * 【這一支做的事】
 *   ① attachments 多一個母體 order_doc_id → orders（路徑前綴 od/）
 *      ★ on delete cascade：訂單進回收桶時，合約跟著一起進去、一起復原
 *   ② att_one_parent 重建（照 321／324 的作法）
 *
 * ★★ 為什麼不用現成的 attachments.order_id：
 *   那一欄是加費憑證（收據、壞掉的杯子，路徑 of/），管家看得到。
 *   合約有身分證字號，是個資 —— 混在同一欄的話，管家打開加費憑證就會看到合約。
 *   分一個新欄位、新前綴，權限才分得開（主管、會計、總經理才看得到）。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table if not exists _chk325 (k text primary key, v text) on commit preserve rows;
truncate _chk325;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.orders') is null then raise exception 'orders 不在 —— 整支停下來'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'attachments' and column_name = 'doc_kind') then
    raise exception 'attachments 沒有 doc_kind —— migration_324 還沒跑。先跑 324 再回來。整支停下來';
  end if;
  if to_regclass('public.attachments') is null then raise exception 'attachments 不在 —— 整支停下來'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') then
    raise exception 'attachments 上找不到 att_one_parent —— 前提不成立，整支停下來';
  end if;
end $do$;

-- ══════ ① 母體 ══════
alter table public.attachments add column if not exists order_doc_id uuid
  references public.orders(id) on delete cascade;
create index if not exists att_order_doc_idx on public.attachments (order_doc_id) where order_doc_id is not null;
comment on column public.attachments.order_doc_id is
  '訂單的合約 PDF（migration_325）。路徑前綴 od/。不跟加費憑證的 order_id 混用（權限不同）。';

-- ══════ ② att_one_parent 加 order_doc_id ══════
do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';
  if position('order_doc_id' in def) > 0 then
    insert into _chk325 values ('att_one_parent', '已含 order_doc_id（跑過了）');
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
    execute format('alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, order_doc_id) = 1)', cols);
    insert into _chk325 values ('att_one_parent', '原有 ' || n || ' 欄 ＋ order_doc_id');
  end if;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('325_order_docs');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'attachments 多了 order_doc_id' as 檢查,
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'attachments' and column_name = 'order_doc_id') then '有' else '沒有' end as 結果,
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'attachments' and column_name = 'order_doc_id') then '✅' else '❌' end as 判定
union all
select 2, '合約掛得上去（att_one_parent 含 order_doc_id）',
       coalesce((select v from _chk325 where k = 'att_one_parent'), '—'),
       case when (select pg_get_constraintdef(oid) from pg_constraint
                   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') like '%order_doc_id%'
            then '✅' else '❌' end
union all
select 3, '訂單刪除時合約跟著走（cascade）',
       case when exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and contype = 'f'
                          and confdeltype = 'c' and confrelid = 'public.orders'::regclass
                          and conkey = array[(select attnum from pg_attribute where attrelid = 'public.attachments'::regclass and attname = 'order_doc_id')]::smallint[])
            then 'on delete cascade' else '—' end,
       case when exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and contype = 'f'
                          and confdeltype = 'c' and confrelid = 'public.orders'::regclass
                          and conkey = array[(select attnum from pg_attribute where attrelid = 'public.attachments'::regclass and attname = 'order_doc_id')]::smallint[])
            then '✅' else '❌' end
order by 1;
