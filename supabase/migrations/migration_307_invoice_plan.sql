/* ══════════════════════════════════════════════════════════════════════
 * migration_307：發票「哪些月份要開」—— 契約怎麼開、物業預設、起算月、月份例外（不開／額外）        2026-10-01
 *
 * 【為什麼】David 四點 ＋ 兩條：
 *   1. 預設每月開一張，年繳／季繳約可以選「每年開／每季開」（一期一張）
 *   2. 正隆的契約預設都要開發票（★ 只有正隆；其他物業要開才勾）
 *   3. 2026/09 起算：之前的月份不列待開、不算逾期
 *   4. 年繳約按月開 → 一期底下一個月一列各自開；月份可以「不開」、可以「＋ 加一張」額外的
 *   ・ 「收費後開」拿掉（欄位留著不讀，不刪 —— 刪了就回不來）
 *   ・ ★★★ 已經開的發票（invoices）一列都不動、一個欄位都不加
 *
 * 【做什麼】
 *   ① contracts.invoice_every：'month'（預設）／'period'。既有契約全部 'month'。
 *   ② estates.invoice_default：新契約預設要不要開。只有「正隆」true。
 *   ③ work_settings.invoice_from_ym：全公司一個起算月，'202609'。
 *   ④ 新表 contract_invoice_adjust：契約 × 月份的例外 —— skip（不開）或 extra（額外，帶金額、備註）。
 *      一個月只能有一條 skip；extra 可以好幾條。RLS 跟 invoices 一樣（管家／主管／總經理／會計）。
 *   ⑤ 正隆在職、非未稅的契約 invoice_required 一次全部 true（自檢列出改了幾張）。
 *   「哪些月份要開」的基本清單是算出來的，不存 —— 這張表只存例外。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 契約：發票怎麼開
alter table public.contracts add column if not exists invoice_every text not null default 'month';
alter table public.contracts drop constraint if exists contracts_invoice_every_chk;
alter table public.contracts add constraint contracts_invoice_every_chk check (invoice_every in ('month', 'period'));
comment on column public.contracts.invoice_every is
  '發票怎麼開：month＝一個月一張（預設）；period＝跟租金一期一張（年繳＝每年開）。migration_307。';
comment on column public.contracts.invoice_after_paid is
  '【已停用 2026-10-01，migration_307】「收費後開」拿掉了。欄位留著不讀，不要再寫。';

-- ② 物業：新契約預設要不要開發票
alter table public.estates add column if not exists invoice_default boolean not null default false;
comment on column public.estates.invoice_default is '新增契約選到這個物業時「需要開發票」預設勾起來。只有正隆是 true（2026-10-01 David）。';
update public.estates set invoice_default = (name = '正隆');

-- ③ 全公司：發票從哪個月起算
alter table public.work_settings add column if not exists invoice_from_ym text;
alter table public.work_settings drop constraint if exists ws_invoice_from_ym_chk;
alter table public.work_settings add constraint ws_invoice_from_ym_chk check (invoice_from_ym is null or invoice_from_ym ~ '^[0-9]{6}$');
comment on column public.work_settings.invoice_from_ym is
  '待開發票從這個月（六碼 ym）起算；之前的月份不列、不算逾期。取代前端寫死的「前 2 個月」。';
update public.work_settings set invoice_from_ym = '202609' where id = 1 and invoice_from_ym is null;

-- ④ 月份例外
create table if not exists public.contract_invoice_adjust (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  ym          text not null check (ym ~ '^[0-9]{6}$'),
  kind        text not null check (kind in ('skip', 'extra')),
  -- extra 才有金額；skip 一律 null
  amount      numeric check (kind = 'extra' or amount is null),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
comment on table public.contract_invoice_adjust is
  '發票「哪些月份要開」的例外：skip＝這個月不開（列劃掉、不算待開）；extra＝額外加一張（帶金額、備註）。'
  '基本清單照契約的 invoice_every 算出來，不存；這裡只存例外。跟 invoices 無關 —— 已開的發票不受這張表影響。';
create unique index if not exists cia_skip_uniq on public.contract_invoice_adjust (contract_id, ym) where kind = 'skip';
create index if not exists cia_contract_idx on public.contract_invoice_adjust (contract_id);

alter table public.contract_invoice_adjust enable row level security;
drop policy if exists cia_read  on public.contract_invoice_adjust;
drop policy if exists cia_write on public.contract_invoice_adjust;
create policy cia_read  on public.contract_invoice_adjust for select
  using (public.current_role_of() in ('housekeeper', 'manager', 'super_admin', 'accountant'));
create policy cia_write on public.contract_invoice_adjust for all
  using (public.current_role_of() in ('housekeeper', 'manager', 'super_admin', 'accountant'))
  with check (public.current_role_of() in ('housekeeper', 'manager', 'super_admin', 'accountant'));
grant select, insert, update, delete on public.contract_invoice_adjust to authenticated, service_role;

-- ⑤ 正隆在職契約全部要開發票（未稅的除外 —— 204 的 check 擋著）
create temp table _flip as
  select c.id from public.contracts c join public.estates e on e.id = c.estate_id
   where e.name = '正隆' and c.active and not coalesce(c.tax_free, false) and not c.invoice_required;
update public.contracts set invoice_required = true where id in (select id from _flip);

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('307_invoice_plan');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '契約 invoice_every 都是 month' as 檢查,
       (select count(*) || ' 張・非 month ' || count(*) filter (where invoice_every <> 'month') from public.contracts) as 結果,
       case when (select count(*) from public.contracts where invoice_every <> 'month') = 0 then '✅' else 'ℹ 有人改過了' end as 判定
union all
select 2, '物業預設開發票（只有正隆）',
       (select string_agg(name || case when invoice_default then ' ✅' else ' —' end, '・' order by sort, name) from public.estates where active),
       case when (select count(*) from public.estates where invoice_default) = 1 and exists (select 1 from public.estates where name = '正隆' and invoice_default) then '✅' else '❌' end
union all
select 3, '起算月',
       (select coalesce(invoice_from_ym, '（空）') from public.work_settings where id = 1),
       case when (select invoice_from_ym from public.work_settings where id = 1) = '202609' then '✅' else '❌' end
union all
select 4, '例外表建好、RLS 開、authenticated 讀得到',
       case when to_regclass('public.contract_invoice_adjust') is null then '沒有表'
            else 'RLS ' || (select case when relrowsecurity then '開' else '關' end from pg_class where oid = 'public.contract_invoice_adjust'::regclass)
              || '・policy ' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'contract_invoice_adjust')
              || '・grant ' || has_table_privilege('authenticated', 'public.contract_invoice_adjust', 'select') end,
       case when to_regclass('public.contract_invoice_adjust') is not null
             and (select relrowsecurity from pg_class where oid = 'public.contract_invoice_adjust'::regclass)
             and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'contract_invoice_adjust') = 2
             and has_table_privilege('authenticated', 'public.contract_invoice_adjust', 'select') then '✅' else '❌' end
union all
select 5, '這次把幾張正隆契約改成要開發票',
       (select count(*)::text from _flip) || ' 張（正隆在職要開的現在共 '
         || (select count(*) from public.contracts c join public.estates e on e.id = c.estate_id where e.name = '正隆' and c.active and c.invoice_required) || ' 張）',
       'ℹ 第一次跑會是 39；第二次 0'
union all
select 6, '★ 已開的發票一張都沒動（張數／最晚月份）',
       (select count(*) || ' 張・' || coalesce(max(ym), '—') from public.invoices where status = 'issued'),
       'ℹ 跟跑之前一樣就對了（之前查是 42 張・202610）'
union all
select 7, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '307_invoice_plan'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '307_invoice_plan') then '✅' else '❌' end
order by 1;
