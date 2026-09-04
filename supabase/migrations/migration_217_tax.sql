/*
 * migration_217 —— 稅務管理：tax_period ＋ tax_invoice
 * ============================================================
 * 2026-09-04 使用者：「多一個稅務管理」
 *
 * 每兩個月申報一次營業稅。兩張表：
 *
 *   tax_period    一期一列。狀態、上期留抵、結算凍結的四個數字
 *   tax_invoice   一張發票一列。進項銷項**同一張表、同一組欄位**
 *                 （使用者：「請統一規格」）
 *
 * ★ 只做安幸（83684417）。愛皮（93509086）先不做，
 *   但兩張表都帶 `company_tax_id` —— 之後要加不用改表結構。
 *
 * ============================================================
 * 【★★★ 作廢的列要留著】
 *
 * 46 張裡有 3 張作廢，稅額差 21,429。作廢的**不算進申報數**，
 * 但列要在 —— 刪掉就對不回財政部的檔，而發票號碼是連號的，
 * 中間少一號會被問。
 *
 * 所以是 `voided boolean` 而不是刪除。加總的地方一律 `where not voided`。
 *
 * ============================================================
 * 【★★ 為什麼結算要凍結四個數字】
 *
 * `out_tax / in_tax / payable / carry_out` 是推導值，
 * 而 CLAUDE.md 有一條在警告「推導值存成欄位」。這裡是刻意的：
 *
 *   未結算 → 這四欄是 null，畫面即時算
 *   已結算 → 存的是**當初申報的數**，不是「現在算出來的數」
 *
 * 不凍結的話，之後有人補一筆七月的發票，已申報的數字會跟著變，
 * 而三個月後回頭看分不出是「有人補登」還是「當初就算錯」。
 *
 * ============================================================
 * 【★★★ 建表一定要跟著寫 RLS policy】
 *
 * Supabase 的 `rls_auto_enable()` 會自動幫新表開 RLS，
 * 沒有 policy 等於全部擋掉 —— 查詢**回成功、0 列**。
 * migration_206 就是這樣讓六筆人事費一筆都讀不到（208 才修）。
 *
 * 給誰：報稅是會計的事 —— accountant／manager／super_admin。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- 1. 期別
-- ══════════════════════════════════════════════════════════
create table if not exists public.tax_period (
  id              uuid primary key default gen_random_uuid(),

  -- ★ 該期**第一個月**的 YYYYMM。起月一定是奇數（7-8 月期存 '202607'）。
  --   跟全站的 `Ym` 同一種六碼格式 —— 不要另外發明一種
  --   （2026-08-05 那次 '202608' vs '2026-08' 讓營收顯示 0）
  period          text not null check (period ~ '^\d{6}$'),
  company_tax_id  text not null,

  status          text not null default 'open'
                  check (status in ('open','closed')),

  -- ★★★ 上期累積留抵。**不給人手打** —— 它一律等於上一期的 carry_out。
  --   手打的話兩期之間會對不起來，而沒有任何地方會叫。
  --   例外只有第一期（沒有上一期可接），那時候手填一次期初留抵。
  carry_in        numeric(14,0) not null default 0 check (carry_in >= 0),

  -- ── 結算時凍結的四個數字。未結算時是 null ──────────────────
  out_tax         numeric(14,0),
  in_tax          numeric(14,0),
  payable         numeric(14,0),
  carry_out       numeric(14,0),

  closed_at       timestamptz,
  closed_by       uuid,
  note            text,
  created_at      timestamptz not null default now(),

  -- ★ 一家公司一期只有一列
  constraint tax_period_uniq unique (company_tax_id, period),

  -- ★★ 已結算就一定要有那四個數字與時間。
  --   缺一個的話畫面會讀到 null 然後顯示 0 —— 而 0 看起來像「那一期沒生意」
  constraint tax_period_closed_chk check (
    status <> 'closed'
    or (out_tax is not null and in_tax is not null
        and payable is not null and carry_out is not null
        and closed_at is not null)
  ),

  -- ★★ 應繳與留抵互斥。同時有值代表算錯了
  constraint tax_period_exclusive_chk check (
    payable is null or carry_out is null
    or payable = 0 or carry_out = 0
  )
);

comment on table public.tax_period is
  '營業稅期別（migration_217）。雙月一期，period 存該期第一個月的 YYYYMM。'
  '★ carry_in 一律等於上一期的 carry_out —— 不給人手打，第一期例外。'
  '★★ status=closed 時 out_tax/in_tax/payable/carry_out 是**當初申報的數**，'
  '不是現在算出來的 —— 之後補登發票不會動到它們。';

comment on column public.tax_period.carry_in is
  '上期累積留抵。★ 從上一期的 carry_out 帶入，不給人手打。'
  '只有第一期（沒有上一期）才手填期初留抵。';


-- ══════════════════════════════════════════════════════════
-- 2. 發票
-- ══════════════════════════════════════════════════════════
create table if not exists public.tax_invoice (
  id              uuid primary key default gen_random_uuid(),

  period          text not null check (period ~ '^\d{6}$'),
  company_tax_id  text not null,

  -- ★ 進項銷項同一張表、同一組欄位（使用者：「請統一規格」）
  kind            text not null check (kind in ('in','out')),

  category        text,          -- 收入／成本／費用／費用-*／費用-X／費用-X*
  tax_code        text,          -- 21/22/23/24/25/28/X
                                 -- ★ 存 text 不是 int —— 有一個 'X'。
                                 --   存 int 拿 -1 代表 X 的話，那個 -1 遲早被當成金額

  invoice_date    date not null,
  invoice_no      text not null,

  -- ★ 銷項是買方、進項是廠商。同一欄 —— 兩邊都是「對方是誰」
  counterparty            text,
  counterparty_tax_id     text,

  summary         text,          -- 摘要（進項用）
  item_name       text,          -- 品名

  estate_id       uuid references public.estates(id),
  property_id     uuid references public.properties(id),

  net_amount      numeric(14,0) not null default 0,
  tax_amount      numeric(14,0) not null default 0,
  total_amount    numeric(14,0) not null default 0,

  voucher_ref     text,          -- 收支帳
  note            text,

  -- ★★★ 作廢。不算進申報數，但列要留著（刪掉就對不回財政部的檔）
  voided          boolean not null default false,

  source          text not null default 'manual'
                  check (source in ('manual','upload')),

  created_at      timestamptz not null default now(),
  created_by      uuid,

  -- ★★★ 防重複匯入。同一家公司、同一種（進/銷）、同一個發票號碼只能有一列。
  --   同一個檔貼兩次時第二次走 on conflict do update，不會多一整組。
  -- ★ 不含 period —— 發票號碼本來就是唯一的，把 period 加進鍵的話
  --   「期別選錯了再匯一次」會變成兩列而不是覆蓋
  constraint tax_invoice_uniq unique (company_tax_id, kind, invoice_no),

  constraint tax_invoice_amount_chk check (
    net_amount >= 0 and tax_amount >= 0 and total_amount >= 0
  )
);

comment on table public.tax_invoice is
  '營業稅發票明細（migration_217）。進項銷項同一張表，用 kind 分。'
  '★★★ voided 的不算進申報數但列要留著 —— 發票號碼連號，刪了對不回財政部的檔。'
  '加總一律 where not voided。';

comment on column public.tax_invoice.tax_code is
  '21/22/23/24/25/28/X。★ 存 text 不是 int —— 因為有一個 X（不可扣抵）。';

create index if not exists tax_invoice_period_idx
  on public.tax_invoice (company_tax_id, period, kind);
create index if not exists tax_invoice_date_idx
  on public.tax_invoice (invoice_date);


-- ══════════════════════════════════════════════════════════
-- ★★★ RLS —— 建表之後一定要接這兩段（migration_206 漏過一次）
-- ══════════════════════════════════════════════════════════
alter table public.tax_period  enable row level security;
alter table public.tax_invoice enable row level security;

do $do$ begin
  begin
    create policy tax_period_all on public.tax_period
      for all
      using (current_role_of() = any (array['accountant','manager','super_admin']))
      with check (current_role_of() = any (array['accountant','manager','super_admin']));
  exception when duplicate_object then null; end;
  begin
    create policy tax_invoice_all on public.tax_invoice
      for all
      using (current_role_of() = any (array['accountant','manager','super_admin']))
      with check (current_role_of() = any (array['accountant','manager','super_admin']));
  exception when duplicate_object then null; end;
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('217_tax');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 這一支不寫資料，所以沒有母體可判定 —— 成敗就是表、約束、policy。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩張表建好了',
         coalesce((select string_agg(table_name || '(' || n::text || '欄)', '、' order by table_name)
                     from (select c.table_name, count(*) n
                             from information_schema.columns c
                            where c.table_schema = 'public'
                              and c.table_name in ('tax_period','tax_invoice')
                            group by c.table_name) t), '（都不存在）'),
         case when (select count(distinct table_name) from information_schema.columns
                     where table_schema = 'public'
                       and table_name in ('tax_period','tax_invoice')) = 2
              then '✅ 兩張都在' else '❌ 沒建成功，下面不用看' end

  union all
  -- ★★★ 沒有 policy 的症狀是「查詢成功、回 0 列」——
  --   畫面上是一個很正常的「這一期沒有發票」，沒有任何錯誤
  select 2, '★★★ ② RLS policy（兩張各一條）',
         coalesce((select string_agg(p.polname, '、' order by p.polname)
                     from pg_policy p
                     join pg_class c on c.oid = p.polrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname in ('tax_period','tax_invoice')), '（一條都沒有）'),
         case when (select count(*) from pg_policy p
                      join pg_class c on c.oid = p.polrelid
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public'
                       and c.relname in ('tax_period','tax_invoice')) = 2
              then '✅ 讀寫都通得了'
              else '❌❌❌ 少了 policy = 全部擋掉，而畫面上會是「0 筆」不會報錯' end

  union all
  select 3, '③ 防重複匯入的唯一約束',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.tax_invoice'::regclass
                      and conname = 'tax_invoice_uniq'), '（沒有）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.tax_invoice'::regclass
                              and conname = 'tax_invoice_uniq')
              then '✅ 同一張發票只會有一列'
              else '❌ 同一個檔貼兩次會多一整組' end

  union all
  -- ★★ 已結算卻缺凍結值的話，畫面會讀到 null 顯示 0 —— 而 0 看起來像「那期沒生意」
  select 4, '★★ ④ 已結算必須有凍結值的約束',
         coalesce((select conname from pg_constraint
                    where conrelid = 'public.tax_period'::regclass
                      and conname = 'tax_period_closed_chk'), '（沒有）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.tax_period'::regclass
                              and conname = 'tax_period_closed_chk')
              then '✅' else '❌ 可能存出一期「已結算但沒有數字」' end

  union all
  select 5, '⑤ 應繳與留抵互斥的約束',
         coalesce((select conname from pg_constraint
                    where conrelid = 'public.tax_period'::regclass
                      and conname = 'tax_period_exclusive_chk'), '（沒有）'),
         '★ 兩個同時有值代表算錯了'

  union all
  -- ★★ 掃全部，不要只查我這次建的兩張（208 的教訓）
  select 6, '★★ ⑥ 還有沒有別的表開了 RLS 卻沒有 policy',
         (select case when count(*) = 0 then '✅ 沒有'
                      else '⚠⚠⚠ ' || string_agg(c.relname, '、') end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
         '★★★ 這種表的症狀是查詢成功、回 0 列、沒有錯誤訊息'

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '217_tax'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '217_tax')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
