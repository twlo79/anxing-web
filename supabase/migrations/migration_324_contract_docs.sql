/*
 * migration_324_contract_docs.sql　2026-10-08
 * 契約文件（PDF）掛在契約上
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *
 * 【使用者 2026-10-07】
 *   「多做一個區塊 契約文件 打開後可以存 PDF 上傳 存之後可以讀
 *     1. 名字後方多一個 icon 點開可以預覽 PDF  2. 存的契約那裡也可以點預覽
 *     3. 客戶管理連動過去也有契約」「契約放最下方」「做」
 *
 * 【這一支做的事】
 *   ① attachments 多一個母體 contract_id（檔案路徑前綴 ct/）
 *      ★ on delete cascade：契約進回收桶時，文件跟著一起進去、一起復原
 *   ② attachments 多一欄 doc_kind：原約／展延／附約／其他（只有契約文件用，其他附件是 null）
 *   ③ att_one_parent 重建：照 migration_321 的作法 —— 讀線上定義、加一欄、重建
 *
 * ★ 權限沿用憑證那一套（can_see_receipt／can_edit_receipt）：
 *   主管、會計、總經理看得到也傳得上去；管家看不到（契約裡有身分證字號，是個資）。
 *   畫面上也只對這三種人顯示，不會出現「按得下去卻什麼都沒有」。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table if not exists _chk324 (k text primary key, v text) on commit preserve rows;
truncate _chk324;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.contracts') is null then raise exception 'contracts 不在 —— 整支停下來'; end if;
  if to_regclass('public.attachments') is null then raise exception 'attachments 不在 —— 整支停下來'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') then
    raise exception 'attachments 上找不到 att_one_parent —— 前提不成立，整支停下來';
  end if;
end $do$;

-- ══════ ① 母體 ══════
alter table public.attachments add column if not exists contract_id uuid
  references public.contracts(id) on delete cascade;
create index if not exists att_contract_idx on public.attachments (contract_id) where contract_id is not null;
comment on column public.attachments.contract_id is
  '契約文件（migration_324）。路徑前綴 ct/。契約刪除（進回收桶）時一起帶走。';

-- ══════ ② 文件類型 ══════
alter table public.attachments add column if not exists doc_kind text;
do $do$ begin
  alter table public.attachments add constraint att_doc_kind_chk
    check (doc_kind is null or doc_kind in ('原約', '展延', '附約', '其他'));
exception when duplicate_object then null; end $do$;
comment on column public.attachments.doc_kind is
  '契約文件的類型：原約／展延／附約／其他（migration_324）。其他附件是 null。字串跟 src/lib/contract-docs.ts 的 DOC_KINDS 同步。';

-- ══════ ③ att_one_parent 加 contract_id（照 321 的作法）══════
do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';
  if position('contract_id' in def) > 0 then
    insert into _chk324 values ('att_one_parent', '已含 contract_id（跑過了）');
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
    execute format('alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, contract_id) = 1)', cols);
    insert into _chk324 values ('att_one_parent', '原有 ' || n || ' 欄 ＋ contract_id');
  end if;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('324_contract_docs');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'attachments 多了 contract_id、doc_kind' as 檢查,
       (select string_agg(column_name, '、' order by column_name) from information_schema.columns
         where table_schema = 'public' and table_name = 'attachments' and column_name in ('contract_id', 'doc_kind')) as 結果,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'attachments' and column_name in ('contract_id', 'doc_kind')) = 2
            then '✅' else '❌' end as 判定
union all
select 2, '文件掛得上去（att_one_parent 含 contract_id）',
       coalesce((select v from _chk324 where k = 'att_one_parent'), '—'),
       case when (select pg_get_constraintdef(oid) from pg_constraint
                   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') like '%contract_id%'
            then '✅' else '❌' end
union all
select 3, '契約刪除時文件跟著走（cascade）',
       (select case confdeltype when 'c' then 'on delete cascade' else confdeltype::text end
          from pg_constraint where conrelid = 'public.attachments'::regclass and contype = 'f'
           and conkey = array[(select attnum from pg_attribute where attrelid = 'public.attachments'::regclass and attname = 'contract_id')]::smallint[]
         limit 1),
       case when exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass and contype = 'f' and confdeltype = 'c'
                          and confrelid = 'public.contracts'::regclass) then '✅' else '❌' end
order by 1;
