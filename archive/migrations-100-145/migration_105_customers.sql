-- migration_105：客戶管理
--
-- ============================================================
-- 【客戶資料現在散在兩個地方】
--
--   contracts.tenant_name / phone      長租房客
--   orders.guest_name                  短租房客（沒有電話、沒有 email）
--
-- 想知道「三樓那位王小姐的電話」要先猜他是長租還是短租，猜錯就找不到。
-- 而備註（不吃辣、隔壁鄰居投訴過、續約意願高）目前沒有地方寫，
-- 寫在訂單的 note 上會被下一張訂單留在後面。
--
--
-- ============================================================
-- 【一位客戶一列，不是一段住宿一列】（使用者確認）
--
-- 訂了三次的常客如果佔三列，電話要填三次、備註要填三次，
-- 而下次要看的時候不知道該看哪一列。
--
-- 所以以「物業 ＋ 房源 ＋ 姓名」為一列，住宿起訖顯示
-- 最早入住 ~ 最晚退房，另外標住過幾次。
--
--
-- ============================================================
-- 【哪些欄位跟著來源走，哪些是你的】（使用者確認）
--
--   系統寫（每次同步覆蓋）：姓名、房源、住宿起訖、次數
--   使用者寫（永遠不覆蓋）：電話、email、備註
--
-- 電話比較特別：契約本來就有 phone，所以**只在空的時候**補進去，
-- 一旦有人手動改過就不再回頭覆蓋。全部覆蓋的話，
-- 「客戶換號碼了我改成新的」會在下一次同步被打回舊的，
-- 而且不會有任何提示。
--
--
-- ============================================================
-- 【為什麼不是把 orders 加一個 customer_id】
--
-- 那要回填 3,504 張訂單、改匯入 API、改所有寫訂單的地方，
-- 而且爬蟲送來的 guest_name 本來就不穩定（同一個人可能拼法不同）。
-- 這張表是**彙整**不是主檔 —— 訂單那邊什麼都不用改，壞掉也只壞這一頁。
-- ============================================================

create table if not exists public.customers (
  id             uuid primary key default gen_random_uuid(),

  -- ── 來源欄位（sync_customers 會覆蓋，不要手改）──
  estate_id      uuid references public.estates(id) on delete set null,
  property_id    uuid references public.properties(id) on delete set null,
  property_label text,
  name           text not null,
  stay_from      date,
  stay_to        date,
  stay_count     int not null default 0,
  src_phone      text,          -- 契約帶來的原始電話，只用來初次填入
  src_kind       text,          -- contract / order / both

  -- ── 使用者欄位（同步永遠不動）──
  phone          text,
  email          text,
  note           text,

  /*
   * 比對鍵。
   *
   * 姓名去掉所有空白再轉小寫 —— 「王 小明」和「王小明」是同一個人，
   * 但爬蟲送來的空白不穩定。不正規化的話同一個人會變成兩列，
   * 而電話填在其中一列上。
   *
   * estate/property 用 text 是為了讓 null 也能參與唯一鍵 ——
   * SQL 的 null 不等於 null，直接拿 uuid 當鍵的話，
   * 沒有物業的客戶每同步一次就多一列。
   */
  estate_key     text generated always as (coalesce(estate_id::text, '-')) stored,
  prop_key       text generated always as (
                   coalesce(property_id::text, nullif(btrim(coalesce(property_label, '')), ''), '-')
                 ) stored,
  name_key       text generated always as (
                   lower(regexp_replace(coalesce(name, ''), '\s+', '', 'g'))
                 ) stored,

  -- 上一次同步有沒有對到來源。對不到 = 訂單被改名或刪掉了，
  -- 但備註還在 —— 要讓人看得到，不能默默留著一列孤兒。
  stale          boolean not null default false,
  synced_at      timestamptz,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  constraint customers_key_uniq unique (estate_key, prop_key, name_key)
);

create index if not exists cust_estate_idx on public.customers (estate_id, name);
create index if not exists cust_stay_idx   on public.customers (stay_to desc);

comment on table public.customers is
  '客戶彙整表。由 sync_customers() 從 contracts 與 orders 產生 —— '
  '**是彙整不是主檔**,訂單那邊什麼都不用改。'
  '姓名/房源/起訖由同步覆蓋;電話/email/備註是人填的,永遠不覆蓋。';

comment on column public.customers.stale is
  '上次同步對不到來源。訂單改了客戶名或被刪掉時會變 true —— '
  '那一列的備註還在,要讓人看得到並自己決定怎麼處理。';


-- ============================================================
-- 同步
--
-- 【為什麼是「先 update 再 insert」而不是 on conflict】
-- on conflict 的推斷要對上唯一索引的完整定義，而這裡的鍵是三個
-- generated column。拆成兩步讀起來清楚得多，也不會因為索引定義
-- 改了一個字就靜靜地變成每次都 insert 新列。
-- ============================================================

create or replace function public.sync_customers()
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  n_upd int; n_ins int; n_stale int;
begin
  -- 放行旗標：下面要改 name / stay_* 這些「來源欄位」，
  -- 而 customers_guard 擋的就是那些。security definer 不會跳過觸發器。
  -- true = 只在這個交易裡有效，不會外洩到後面的語句。
  perform set_config('app.syncing', 'on', true);

  -- 同一個交易裡呼叫第二次的話，on commit drop 還沒生效 —— 先清掉。
  -- 少這一行的話「重新整理」按兩次就會噴 relation already exists。
  drop table if exists _src;

  create temp table _src on commit drop as
  with raw as (
    /*
     * 契約：一張契約就是一位長租客。
     * 名字優先用 tenant_name —— name 是契約的名稱（可能是「開封 3F 契約」），
     * 不是人的名字。
     */
    select
      c.estate_id,
      null::uuid                                                        as property_id,
      coalesce(nullif(btrim(c.room), ''), nullif(btrim(c.property_raw), '')) as property_label,
      coalesce(nullif(btrim(c.tenant_name), ''), nullif(btrim(c.display_name), '')) as nm,
      c.start_date                                                      as f,
      c.end_date                                                        as t,
      1                                                                 as n,
      nullif(btrim(c.phone), '')                                        as ph,
      'contract'                                                        as kind
    from public.contracts c
    where coalesce(nullif(btrim(c.tenant_name), ''), nullif(btrim(c.display_name), '')) is not null

    union all

    /*
     * 訂單：排除兩種。
     *   contract_id is not null   契約自動產生的月租單 —— 上面那段已經有了
     *   parent_order_id is not null 加費／移房的子單 —— 不是一段新的住宿
     */
    select
      o.estate_id,
      o.property_id,
      coalesce(p.name, nullif(btrim(o.property_raw), ''))               as property_label,
      btrim(o.guest_name)                                               as nm,
      min(o.checkin)                                                    as f,
      max(o.checkout)                                                   as t,
      count(*)::int                                                     as n,
      null::text                                                        as ph,
      'order'                                                           as kind
    from public.orders o
    left join public.properties p on p.id = o.property_id
    where o.contract_id is null
      and o.parent_order_id is null
      and nullif(btrim(o.guest_name), '') is not null
    group by o.estate_id, o.property_id, coalesce(p.name, nullif(btrim(o.property_raw), '')),
             btrim(o.guest_name)
  )
  select
    coalesce(r.estate_id::text, '-')                                    as estate_key,
    coalesce(r.property_id::text, nullif(btrim(coalesce(r.property_label, '')), ''), '-') as prop_key,
    lower(regexp_replace(coalesce(r.nm, ''), '\s+', '', 'g'))           as name_key,
    max(r.estate_id::text)::uuid                                        as estate_id,
    max(r.property_id::text)::uuid                                      as property_id,
    max(r.property_label)                                               as property_label,
    max(r.nm)                                                           as name,
    min(r.f)                                                            as stay_from,
    max(r.t)                                                            as stay_to,
    sum(r.n)::int                                                       as stay_count,
    max(r.ph)                                                           as src_phone,
    case when count(distinct r.kind) > 1 then 'both' else max(r.kind) end as src_kind
  from raw r
  group by 1, 2, 3;

  -- 1) 已經有的：只更新來源欄位。電話只在空的時候補，email 與備註完全不動。
  update public.customers c
     set name         = s.name,
         estate_id    = s.estate_id,
         property_id  = s.property_id,
         property_label = s.property_label,
         stay_from    = s.stay_from,
         stay_to      = s.stay_to,
         stay_count   = s.stay_count,
         src_phone    = s.src_phone,
         src_kind     = s.src_kind,
         phone        = coalesce(nullif(btrim(coalesce(c.phone, '')), ''), s.src_phone),
         stale        = false,
         synced_at    = now(),
         updated_at   = now()
    from _src s
   where c.estate_key = s.estate_key
     and c.prop_key   = s.prop_key
     and c.name_key   = s.name_key;
  get diagnostics n_upd = row_count;

  -- 2) 新的
  insert into public.customers
    (estate_id, property_id, property_label, name, stay_from, stay_to, stay_count,
     src_phone, src_kind, phone, stale, synced_at)
  select s.estate_id, s.property_id, s.property_label, s.name, s.stay_from, s.stay_to,
         s.stay_count, s.src_phone, s.src_kind, s.src_phone, false, now()
    from _src s
   where not exists (
     select 1 from public.customers c
      where c.estate_key = s.estate_key and c.prop_key = s.prop_key and c.name_key = s.name_key);
  get diagnostics n_ins = row_count;

  /*
   * 3) 對不到來源的標成 stale。
   *
   * **不刪。** 那一列上可能有人寫過備註，而來源消失最常見的原因
   * 是訂單改了客戶名（打錯字修正）—— 刪掉的話備註跟著不見，
   * 而且沒有人會發現。標記起來讓人自己決定。
   */
  update public.customers c
     set stale = true, updated_at = now()
   where not exists (
     select 1 from _src s
      where c.estate_key = s.estate_key and c.prop_key = s.prop_key and c.name_key = s.name_key)
     and c.stale = false;
  get diagnostics n_stale = row_count;

  perform set_config('app.syncing', 'off', true);
  return jsonb_build_object('ok', true, 'updated', n_upd, 'inserted', n_ins, 'stale', n_stale);
end $fn$;

comment on function public.sync_customers is
  '從 contracts 與 orders 重建客戶清單。電話只在空的時候補,email 與備註永遠不動。'
  '對不到來源的標 stale 而不刪除 —— 那一列上可能有人寫過備註。';

revoke all on function public.sync_customers() from public;
grant execute on function public.sync_customers() to authenticated;


-- ============================================================
-- RLS：所有人都看得到、都改得動（使用者指定）
--
-- 但**只開放 update**。新增與刪除走 sync_customers()，
-- 因為手動新增的列沒有比對鍵的來源，下一次同步會被標成 stale，
-- 而那看起來像壞掉。
-- ============================================================

alter table public.customers enable row level security;

drop policy if exists cust_read on public.customers;
create policy cust_read on public.customers for select
  using (current_role_of() is not null);

drop policy if exists cust_edit on public.customers;
create policy cust_edit on public.customers for update
  using (current_role_of() is not null)
  with check (current_role_of() is not null);

/*
 * 只讓改那三欄。
 *
 * RLS 是列級的，擋不住欄位 —— 沒有這個觸發器的話，
 * 任何人都可以在客戶頁把姓名或住宿起訖改掉，而那些是來源欄位，
 * 下一次同步就被打回去。使用者會覺得「我改了但它自己變回來」。
 * 直接擋在資料庫，並講清楚為什麼。
 */
create or replace function public.customers_guard() returns trigger
language plpgsql as $fn$
begin
  if new.name           is distinct from old.name
  or new.estate_id      is distinct from old.estate_id
  or new.property_id    is distinct from old.property_id
  or new.property_label is distinct from old.property_label
  or new.stay_from      is distinct from old.stay_from
  or new.stay_to        is distinct from old.stay_to
  or new.stay_count     is distinct from old.stay_count then
    -- 同步本身是 security definer 執行的，它改這些欄位不會走到這裡
    -- （session_replication_role 沒動，所以還是會走）—— 用旗標放行
    if current_setting('app.syncing', true) is distinct from 'on' then
      raise exception '客戶的姓名、房源、住宿起訖是從訂單與契約帶過來的，不能在這裡改。'
        '要改請到那張訂單或契約上改，這裡會跟著更新。';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists trg_customers_guard on public.customers;
create trigger trg_customers_guard before update on public.customers
  for each row execute function public.customers_guard();


-- ── 首次建立 ───────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.sync_customers();
  raise notice '客戶同步：新增 % 列、更新 % 列、標記失效 % 列',
    r->>'inserted', r->>'updated', r->>'stale';
end $$;


-- ── 確認 ───────────────────────────────────────────
select
  (select count(*) from public.customers)                               as "客戶列數",
  (select count(*) from public.customers where src_kind = 'contract')    as "來自契約",
  (select count(*) from public.customers where src_kind = 'order')       as "來自訂單",
  (select count(*) from public.customers where src_kind = 'both')        as "兩者都有",
  (select count(*) from public.customers
    where stay_to >= (now() at time zone 'Asia/Taipei')::date)           as "尚未退房",
  (select count(*) from public.customers where estate_id is null)        as "未指定物業",
  (select count(*) from public.customers where coalesce(phone,'') <> '') as "有電話";

-- 每個物業幾位客戶（分頁會照這個順序排）
select
  coalesce(e.name, '（未指定物業）')                                     as "物業",
  count(*)                                                              as "客戶數",
  count(*) filter (where c.stay_to >= (now() at time zone 'Asia/Taipei')::date) as "尚未退房"
from public.customers c
left join public.estates e on e.id = c.estate_id
group by e.name, e.sort
order by e.sort nulls last, e.name nulls last;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('105_customers'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
