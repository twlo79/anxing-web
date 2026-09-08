/*
 * migration_227 —— 備品管理
 * ============================================================
 * 2026-09-07 使用者：「多一個 tab 備品管理」
 *
 * ============================================================
 * 【規則】（2026-09-07 使用者逐項確認）
 *
 *   庫存分到  **物業**（時兆的衛生紙跟正隆的衛生紙是兩筆）
 *   誰做什麼  會計設初始量；管家／房務取用、補貨、盤點
 *   取用(−)   他們自己填一筆，**不是**打掃一間自動扣
 *   補貨(+)   自己填，**不從採購需求自動入庫**
 *   盤點      每月底填「實際盤到多少」，差異由系統算
 *
 * ★ 用語（使用者選 B）:**取用**（−）／**補貨**（+）。
 *   不用「領用／入庫」—— 按的人是管家跟房務，不是倉管，
 *   他們腦中沒有「庫」這個東西，只有櫃子裡的衛生紙。
 *
 * ============================================================
 * 【★★★ 庫存餘量**不存欄位**】
 *
 * 餘量 = 所有異動的加總。做成一個可以填的格子就會變成第二個真相，
 * 而它遲早跟流水對不上。
 *
 * 這個專案踩過一模一樣的坑:`bank_transactions.balance` 是算出來的
 * 卻存進欄位，維護它的只有前端一段程式 —— 錯了半年沒有人發現，
 * 最後靠 migration_203 改成觸發器維護才修好
 * （CLAUDE.md:「推導值存成欄位」）。
 *
 * 所以這裡從第一天就不走那條路:給一個 view，`sum(qty)` 現算。
 * 備品頂多幾百列，這個量級不需要快取。
 *
 * ============================================================
 * 【★★ 流水不給刪】
 *
 * 填錯了記一筆反向的沖銷，不要刪。
 * 刪掉的話「上個月為什麼少了 5 個」永遠答不出來 ——
 * 而那正是盤點時唯一想知道的事。
 *
 * ★ RLS 沒有 delete policy，所以刪除會被擋（回 0 列）。
 *   要真的清掉錯誤資料只能走 SQL Editor。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- 1. 品項主檔
-- ══════════════════════════════════════════════════════════
create table if not exists public.supply_item (
  id         uuid primary key default gen_random_uuid(),
  /*
   * ★ 物業。null = 安幸辦公室（跟 expenses.purpose_type 同一種語意，
   *   但這裡不需要第二個欄位:備品只有這兩種歸屬）。
   */
  estate_id  uuid references public.estates(id),
  name       text not null,
  /** 規格型號。「大包裝／12 卷」這種 —— 同名不同規格是兩個品項 */
  spec       text,
  vendor     text,
  /*
   * ★★ 效期只有**一格**（照使用者的 Excel）。
   *   代價要知道:不同批次的效期不同，補了新的一批之後
   *   這一格要自己改成新的。真的要逐批管得做批號，那是另一個量級。
   */
  expire_on  date,
  note       text,
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,

  /*
   * ★★★ 同一個物業、同名同規格只能有一筆。
   *   沒有這條的話「衛生紙」會被建出三筆，而餘量各算各的 ——
   *   畫面上看起來就是三個不同的東西，沒有人會發現那是同一種。
   * ★ `coalesce` 是因為 null 彼此不相等:辦公室的品項（estate_id null）
   *   不加 coalesce 的話同名可以建無限多筆。
   */
  constraint supply_item_uniq unique nulls not distinct (estate_id, name, spec)
);

alter table public.supply_item enable row level security;

/*
 * ★★★ 新建表一定要接 policy。Supabase 的 `rls_auto_enable()`
 *   會自動開 RLS，而沒有 policy 等於全部擋掉 —— 查詢**回成功、0 列**，
 *   畫面上是一個很正常的「還沒有任何備品」（migration_206 踩過）。
 */
do $do$ begin
  create policy supply_item_read on public.supply_item
    for select using (
      current_role_of() = any (array['cleaner','housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

/* ★ 建／改品項是會計以上。房務不該能新增品項（那會長出一堆同義詞） */
do $do$ begin
  create policy supply_item_write on public.supply_item
    for all using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    ) with check (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

comment on table public.supply_item is
  '備品品項主檔（migration_227）。一個物業一種規格一筆。'
  '★ 庫存餘量**不在這裡** —— 看 supply_balance view。';

-- ══════════════════════════════════════════════════════════
-- ★★★ 2. 異動流水（唯一的真實來源）
-- ══════════════════════════════════════════════════════════
create table if not exists public.supply_txn (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.supply_item(id) on delete cascade,

  /*
   * ★ 四種:
   *   init    會計設的初始庫存（一個品項只該有一筆）
   *   in      補貨（+）
   *   out     取用（−）
   *   adjust  盤點調整（可正可負）
   */
  kind        text not null check (kind in ('init','in','out','adjust')),

  /*
   * ★★★ `qty` **帶正負號**，方向就在數字裡。
   *
   *   存正數再靠 `kind` 決定方向的話，加總要寫成
   *   `sum(case when kind='out' then -qty else qty end)` ——
   *   而那個 case 會被複製到每一個要算餘量的地方
   *   （CLAUDE.md:同一條規則在三個地方各寫一次）。
   *
   *   帶號的話 `sum(qty)` 就是答案，只有一種寫法。
   * ★ check 擋掉 0:記一筆「動了 0 個」沒有意義，多半是打錯。
   */
  qty         numeric(14,2) not null check (qty <> 0),

  happened_on date not null default (now() at time zone 'Asia/Taipei')::date,
  note        text,
  /** 盤點產生的調整流水會指回那一次盤點 */
  count_id    uuid,
  created_at  timestamptz not null default now(),
  created_by  uuid,

  /*
   * ★★ 方向要跟 kind 一致，不然帳面對得起來但語意是錯的:
   *   一筆 kind='out' 卻是正數的話，餘量會變多而畫面顯示「取用」。
   */
  constraint supply_txn_sign_chk check (
    (kind in ('init','in') and qty > 0)
    or (kind = 'out' and qty < 0)
    or kind = 'adjust'
  )
);

create index if not exists supply_txn_item_idx on public.supply_txn (item_id, happened_on);

alter table public.supply_txn enable row level security;

/* ★ 房務與管家要能記取用與補貨 —— 那是他們每天在做的事 */
do $do$ begin
  create policy supply_txn_read on public.supply_txn
    for select using (
      current_role_of() = any (array['cleaner','housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy supply_txn_insert on public.supply_txn
    for insert with check (
      current_role_of() = any (array['cleaner','housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

/*
 * ★★★ **刻意沒有 update / delete policy**。
 *   流水是歷史，改了或刪了就對不回去。填錯記一筆反向的沖銷。
 *   （RLS 擋下的 delete 回成功且 0 列，所以前端也不要放刪除鈕 ——
 *     放了會變成「按了沒反應」。）
 */

comment on table public.supply_txn is
  '備品異動流水（migration_227）。**唯一的真實來源** —— 餘量是它的加總。'
  '★ qty 帶正負號:init/in 正、out 負、adjust 可正可負。'
  '★★ 沒有 update/delete policy:流水不給改也不給刪，填錯記一筆反向的。';

-- ══════════════════════════════════════════════════════════
-- 3. 月底盤點
-- ══════════════════════════════════════════════════════════
create table if not exists public.supply_count (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.supply_item(id) on delete cascade,
  ym          text not null check (ym ~ '^\d{6}$'),

  /** 盤點當下系統算出來的餘量。★ 存下來 —— 之後補流水不會改到這個數 */
  system_qty  numeric(14,2) not null,
  /** 實際盤到多少 */
  counted_qty numeric(14,2) not null,
  /** 差異 = 實際 − 系統。★ 存下來，不要每次重算（那要重建當時的狀態） */
  diff        numeric(14,2) not null,
  /** 差異的原因:用掉沒登記／補貨漏登／破損／盤錯⋯ */
  reason      text,
  counted_at  timestamptz not null default now(),
  counted_by  uuid,

  /* ★ 一個品項一個月只盤一次。盤兩次的話差異會被算兩遍 */
  constraint supply_count_uniq unique (item_id, ym)
);

alter table public.supply_count enable row level security;

do $do$ begin
  create policy supply_count_read on public.supply_count
    for select using (
      current_role_of() = any (array['cleaner','housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy supply_count_write on public.supply_count
    for all using (
      current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    ) with check (
      current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

comment on table public.supply_count is
  '月底盤點（migration_227）。★ 填的是「實際盤到多少」，差異由系統算 —— '
  '直接改餘量的話「為什麼少了 2 瓶」就消失了，而那正是盤點要回答的。';

-- ══════════════════════════════════════════════════════════
-- ★★★ 4. 餘量（view，不是欄位）
-- ══════════════════════════════════════════════════════════
create or replace view public.supply_balance as
select
  i.id                                                            as item_id,
  coalesce(sum(t.qty), 0)                                         as balance,
  coalesce(sum(t.qty) filter (where t.kind = 'init'), 0)          as init_qty,
  coalesce(sum(t.qty) filter (where t.kind = 'in'), 0)            as in_qty,
  coalesce(-sum(t.qty) filter (where t.kind = 'out'), 0)          as out_qty,
  coalesce(sum(t.qty) filter (where t.kind = 'adjust'), 0)        as adjust_qty,
  max(t.happened_on)                                              as last_move_on
from public.supply_item i
left join public.supply_txn t on t.item_id = i.id
group by i.id;

comment on view public.supply_balance is
  '備品的庫存餘量（migration_227）。**現算，不是存的欄位** —— '
  '理由見 supply_txn 的註解與 CLAUDE.md 的「推導值存成欄位」。'
  '★ out_qty 取負號回正，畫面上「取用」要顯示正數。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('227_supply');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 三張表 ＋ 一個 view',
         coalesce((select string_agg(relname::text, '、' order by relname)
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname in ('supply_item','supply_txn','supply_count','supply_balance')),
                  '（都沒建出來）'),
         case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public'
                       and c.relname in ('supply_item','supply_txn','supply_count','supply_balance')) = 4
              then '✅ 四個都在' else '❌ 少了，下面不用看' end

  union all
  /*
   * ★★★ 沒有 policy 等於全部擋掉 —— 查詢回成功、0 列，
   *   畫面上是一個很正常的「還沒有任何備品」。
   */
  select 2, '★★★ ② RLS policy 夠不夠',
         coalesce((select string_agg(tablename || '：' || cnt::text || ' 條', '、' order by tablename)
                     from (select tablename, count(*) as cnt from pg_policies
                            where schemaname = 'public'
                              and tablename in ('supply_item','supply_txn','supply_count')
                            group by tablename) s), '（一條都沒有）'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('supply_item','supply_txn','supply_count')) >= 6
              then '✅ 三張表都有讀寫' else '❌ 不夠 —— 查詢會回成功且 0 列' end

  union all
  -- ★★ 流水刻意不給改不給刪。有 update/delete policy 就是寫錯了
  select 3, '★★ ③ 流水有沒有被開放修改（不該有）',
         coalesce((select string_agg(policyname || '（' || cmd || '）', '、')
                     from pg_policies
                    where schemaname = 'public' and tablename = 'supply_txn'
                      and cmd in ('UPDATE','DELETE','ALL')), '（沒有 —— 這樣才對）'),
         case when exists (select 1 from pg_policies
                            where schemaname = 'public' and tablename = 'supply_txn'
                              and cmd in ('UPDATE','DELETE','ALL'))
              then '❌ 流水可以被改或刪 —— 帳就對不回去了'
              else '✅ 只能新增。填錯記一筆反向的沖銷' end

  union all
  -- ★ 方向與 kind 要一致,不然餘量對但語意錯
  select 4, '★ ④ 方向約束在不在',
         coalesce((select string_agg(conname::text, '、')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'supply_txn'
                      and co.contype::text = 'c'), '（沒有）'),
         case when exists (select 1 from pg_constraint co
                            join pg_class c on c.oid = co.conrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'supply_txn'
                             and co.conname::text = 'supply_txn_sign_chk')
              then '✅ out 一定是負數、in 一定是正數'
              else '❌ 少了 —— 會出現「取用」卻讓餘量變多的流水' end

  union all
  -- ★ 同物業同名同規格只能一筆,不然餘量會各算各的
  select 5, '★ ⑤ 品項不重複的約束',
         coalesce((select pg_get_constraintdef(co.oid)
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'supply_item'
                      and co.conname::text = 'supply_item_uniq'), '（沒有）'),
         case when exists (select 1 from pg_constraint co
                            join pg_class c on c.oid = co.conrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'supply_item'
                             and co.conname::text = 'supply_item_uniq')
              then '✅ 同一種東西不會被建成三筆'
              else '❌ 會長出同義詞，而餘量各算各的' end

  union all
  /*
   * ★★★ 母體要判定。這一支只建結構 —— 現在一定是 0 筆。
   *   要開始用請到房務管理 → 備品管理建品項。
   */
  select 6, '★★★ ⑥ 目前有幾個品項',
         (select count(*)::text || ' 個品項、'
                 || (select count(*)::text from public.supply_txn) || ' 筆流水'
            from public.supply_item),
         case when (select count(*) from public.supply_item) = 0
              then '✅ 0 —— **正常**。這一支只建結構，要用請到畫面上建品項'
              else 'ℹ 已經有資料了' end

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '227_supply'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '227_supply')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
