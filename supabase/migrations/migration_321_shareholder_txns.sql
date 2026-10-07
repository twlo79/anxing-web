/* ══════════════════════════════════════════════════════════════════════
 * migration_321：安幸・股東往來（股東借給公司／公司還股東）                            2026-10-07
 *
 * 【為什麼】David：「其他收支帳多做一個安幸-股東往來，可以鍵入股東往來借還款情況」
 *   過審稿：收支下拉（收入＝股東借給公司、支出＝公司還股東）、收／付款方式（匯款／現金）、
 *   安幸帳號、股東那邊的帳號、摘要、可上傳照片。
 *
 * 【做什麼】
 *   ① 新表 shareholder_txns：一筆往來一列
 *   ② 權限：跟其他收支帳同一組（會計、總經理）—— 讀寫都是
 *   ③ attachments 多一個母體 shareholder_txn_id（憑證照片掛這裡，路徑前綴 sh/）
 *      att_one_parent 照 migration_185 的作法：讀線上定義、加一欄、重建
 *
 * ★ 股東往來是**負債**，不是收入也不是支出 —— 不進營收表、不進損益（跟押金同一個道理）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

create temp table if not exists _chk321 (k text, v text) on commit preserve rows;

begin;
delete from _chk321;

-- ① 表
create table if not exists public.shareholder_txns (
  id            uuid primary key default gen_random_uuid(),
  txn_date      date not null,
  shareholder   text not null check (btrim(shareholder) <> ''),
  direction     text not null check (direction in ('in', 'out')),   -- in＝股東借給公司、out＝公司還股東
  amount        numeric not null check (amount > 0),
  method        text not null default 'transfer' check (method in ('transfer', 'cash')),
  account_code  text references public.payment_accounts(code) on update cascade,  -- 安幸哪個帳戶收／付
  peer_bank_code text,                                                -- 股東那邊的銀行代碼
  peer_account  text,                                                 -- 股東那邊的帳號
  summary       text,                                                 -- 摘要（例：股東借款９月１０日）
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
comment on table public.shareholder_txns is
  '安幸・股東往來：股東借給公司（in）／公司還股東（out）。負債，不進營收與損益。migration_321。';
create index if not exists shareholder_txns_date_idx on public.shareholder_txns (txn_date desc);
create index if not exists shareholder_txns_holder_idx on public.shareholder_txns (shareholder);

-- ② 權限：會計、總經理（跟其他收支帳那一頁同一組，lib/roles 的 isFinance）
alter table public.shareholder_txns enable row level security;
drop policy if exists sht_rw on public.shareholder_txns;
create policy sht_rw on public.shareholder_txns for all
  using (public.current_role_of() in ('accountant', 'super_admin'))
  with check (public.current_role_of() in ('accountant', 'super_admin'));
grant select, insert, update, delete on public.shareholder_txns to authenticated;

-- ③ 憑證掛得上去
alter table public.attachments add column if not exists shareholder_txn_id uuid
  references public.shareholder_txns(id) on delete cascade;
create index if not exists att_sht_idx on public.attachments (shareholder_txn_id) where shareholder_txn_id is not null;

do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';
  if def is null then raise exception 'attachments 上找不到 att_one_parent —— 前提不成立'; end if;
  if position('shareholder_txn_id' in def) > 0 then
    insert into _chk321 values ('att_one_parent', '已含 shareholder_txn_id（跑過了）');
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
    execute format('alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, shareholder_txn_id) = 1)', cols);
    insert into _chk321 values ('att_one_parent', '原有 ' || n || ' 欄 ＋ shareholder_txn_id');
  end if;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('321_shareholder_txns');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '股東往來表在、RLS 開著' as 檢查,
       case when to_regclass('public.shareholder_txns') is null then '★ 沒有'
            else 'RLS ' || (select case when relrowsecurity then '開' else '關' end from pg_class where oid = 'public.shareholder_txns'::regclass)
                 || '・policy ' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shareholder_txns') end as 結果,
       case when (select relrowsecurity from pg_class where oid = 'public.shareholder_txns'::regclass)
             and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shareholder_txns') = 1 then '✅' else '❌' end as 判定
union all
select 2, '憑證掛得上去（att_one_parent 含新欄位）',
       (select v from _chk321 where k = 'att_one_parent'),
       case when (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent') like '%shareholder_txn_id%'
            then '✅' else '❌' end
union all
select 3, '安幸的收付帳戶（下拉會列這些）',
       (select string_agg(code || ' ' || name, '、' order by sort) from public.payment_accounts where active and coalesce(book, 'anxing') = 'anxing'),
       'ℹ'
order by 1;
