-- migration_76：定期收費 + 一次性收入的「項目」
--
-- 【要解決什麼】
-- 時兆每個月都有洗衣機、烘衣機、垃圾代收費三筆收入。以前只能一筆一筆開
-- 「一次性收入」，而且三筆的會計科目都是清潔費 —— 營收報表按科目分組，
-- 三個項目全部併成一格，看不出組成。
--
-- 兩個缺口：
--   1. 沒有「項目」這一層。來源 → 會計科目 → 項目，中間少了最後一層。
--   2. 沒有「每個月一定會長出來」的機制。漏掉一個月不會有任何跡象。
--
-- 【設計】
--   recurring_charges  設定：物業 + 房源(選填) + 科目 + 項目 + 預設金額 + 起訖月
--          ↓ 觸發器 / rebuild_recurring_orders()
--   orders             每月一列，source='oneoff'，imported_via='recurring'
--          ↓ 既有的 trg_orders_recog
--   revenue_recognitions
--
-- 產生出來的就是一般的一次性收入訂單，營收報表與 Excel 都照舊吃得到。
--
-- 【金額為什麼可以改】
-- 垃圾代收費每月固定 5,070，設一次就不用管。
-- 洗衣機是 2,150 / 2,050 / 2,600…，要當月結束才知道 ——
-- 所以產生時帶預設金額，之後逐月改。定期收費保證的是「不會漏掉哪個月」，
-- 不是「金額不用填」。
--
-- 【只產到本月】
-- 未來月份不先產生。先產的話，12 月的垃圾費現在就會計入年度營收，
-- 而那筆錢還沒發生 —— 營收是看已發生的認列，不是預估。


-- ── 一、項目欄位 ───────────────────────────────────
-- orders 與 revenue_recognitions 都要加。只加 orders 的話，
-- 報表讀的是認列表，項目就傳不過去 —— 而且不會報錯，只會一直是空的。
alter table public.orders
  add column if not exists item_name text;
alter table public.revenue_recognitions
  add column if not exists item_name text;

comment on column public.orders.item_name is
  '一次性收入的項目名稱(洗衣機/烘衣機/垃圾代收費…)。會計科目底下再細一層,自由輸入。';

create index if not exists idx_orders_item_name
  on public.orders (item_name) where item_name is not null;


-- ── 二、定期收費設定 ───────────────────────────────
create table if not exists public.recurring_charges (
  id           uuid primary key default gen_random_uuid(),
  estate_id    uuid not null references public.estates(id),
  -- 房源選填。null = 整棟 —— 公區清潔、垃圾代收這類本來就不屬於某一間房。
  property_id  uuid references public.properties(id),
  property_raw text,
  fee_type     text not null,                 -- 會計科目,如「清潔費」
  item_name    text not null,                 -- 項目,如「洗衣機」
  amount       numeric not null default 0,    -- 每月產生時帶的預設金額
  start_ym     text not null check (start_ym ~ '^[0-9]{6}$'),
  end_ym       text check (end_ym ~ '^[0-9]{6}$'),   -- null = 無限期
  active       boolean not null default true,
  note         text,
  created_at   timestamptz not null default now(),
  check (end_ym is null or end_ym >= start_ym)
);

comment on table public.recurring_charges is
  '定期收費設定。每月自動在 orders 產生一列一次性收入,金額可逐月調整。';

-- 同一個物業/房源/科目/項目不該有兩筆設定 —— 有的話每個月會產生兩列一樣的收入。
--
-- coalesce 的外面要再包一層括號:Postgres 的索引運算式除了單純的函式呼叫,
-- 其餘一律要用括號包起來,COALESCE 屬於後者。少一層就是語法錯誤。
--
-- 用 coalesce 是因為 null 在唯一索引裡互不相等 —— 直接寫 property_id 的話,
-- 兩筆「整棟」的設定不會被擋下來,每個月會產生兩列一樣的收入。
create unique index if not exists uq_recurring_charge
  on public.recurring_charges
     (estate_id, (coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)), fee_type, item_name);

alter table public.recurring_charges enable row level security;

-- 權限比照契約:一般角色也讀得到(他們看得到訂單),但只有會計/主管/總經理能改設定。
drop policy if exists rc_read on public.recurring_charges;
create policy rc_read on public.recurring_charges for select
  using (current_role_of() is not null);
drop policy if exists rc_write on public.recurring_charges;
create policy rc_write on public.recurring_charges for all
  using (current_role_of() = any (array['accountant','manager','super_admin']))
  with check (current_role_of() = any (array['accountant','manager','super_admin']));


-- ── 三、產生月租單 ─────────────────────────────────
create or replace function public.gen_recurring_orders(rc public.recurring_charges)
 returns integer language plpgsql security definer as $fn$
declare
  ms date; last_ms date; ymtxt text; ename text; n int := 0;
begin
  -- 停用或已刪的設定:把還沒收款的未來列清掉,已收款的留著(那是既成事實)
  if not rc.active then
    delete from orders
     where imported_via = 'recurring'
       and order_key like 'RC_' || rc.id || '_%'
       and paid = false;
    return 0;
  end if;

  select e.name into ename from estates e where e.id = rc.estate_id;

  ms := to_date(rc.start_ym || '01', 'YYYYMMDD');
  -- 只產到本月。end_ym 有設就取比較早的那個。
  last_ms := date_trunc('month', current_date)::date;
  if rc.end_ym is not null then
    last_ms := least(last_ms, to_date(rc.end_ym || '01', 'YYYYMMDD'));
  end if;

  -- 超出範圍、還沒收款的先清掉（改了起訖月會用到）
  delete from orders
   where imported_via = 'recurring'
     and order_key like 'RC_' || rc.id || '_%'
     and paid = false
     and (checkin < ms or checkin > last_ms);

  while ms <= last_ms loop
    ymtxt := to_char(ms, 'YYYYMM');
    insert into orders (order_key, source, estate_id, property_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, fee_type, item_name, note, imported_via, paid)
    values ('RC_' || rc.id || '_' || ymtxt, 'oneoff', rc.estate_id, rc.property_id, rc.property_raw,
      null, ms, ms, 0, rc.amount, 0, rc.fee_type, rc.item_name, rc.note, 'recurring', false)
    on conflict (order_key) do update
      set fee_type = excluded.fee_type,
          item_name = excluded.item_name,
          estate_id = excluded.estate_id,
          property_id = excluded.property_id,
          property_raw = excluded.property_raw
      -- **金額刻意不覆蓋。** 使用者改過的當月實際金額不能被設定的預設值蓋掉,
      -- 那是這個機制最重要的一條 —— 洗衣機每個月都不一樣。
      where orders.imported_via = 'recurring' and orders.paid = false;
    n := n + 1;
    ms := (ms + interval '1 month')::date;
  end loop;
  return n;
end $fn$;

create or replace function public.trg_recurring_sync() returns trigger
 language plpgsql security definer as $fn$
begin
  if tg_op = 'DELETE' then
    -- 設定刪了,未收款的列跟著走;已收款的留著,那是真的收過的錢
    delete from orders
     where imported_via = 'recurring'
       and order_key like 'RC_' || old.id || '_%'
       and paid = false;
    return old;
  end if;
  perform gen_recurring_orders(new);
  return new;
end $fn$;

drop trigger if exists trg_recurring_charges on public.recurring_charges;
create trigger trg_recurring_charges
  after insert or update or delete on public.recurring_charges
  for each row execute function public.trg_recurring_sync();

/**
 * 補產到本月。
 *
 * 沒有排程可以每月自動跑,所以由畫面上的按鈕呼叫 —— 這支是冪等的,
 * 重複呼叫只會補上缺的月份,已存在的不會變(金額也不會被蓋掉)。
 */
create or replace function public.rebuild_recurring_orders()
 returns integer language plpgsql security definer as $fn$
declare rc public.recurring_charges; c int := 0;
begin
  for rc in select * from recurring_charges where active loop
    c := c + gen_recurring_orders(rc);
  end loop;
  return c;
end $fn$;


-- ── 四、項目要跟著進認列表 ─────────────────────────
-- gen_recognitions 原本不知道 item_name 這一欄。不改的話項目永遠是 null,
-- 報表拆不出洗衣機/烘衣機 —— 而且不會報錯,只會安靜地全部空白。
create or replace function public.gen_recognitions(o orders)
 returns void language plpgsql security definer
as $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date;          -- 最後一個有住宿天數的月份
  acc numeric := 0;      -- 前面各月已認列的合計
  amt numeric;
begin
  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);
  -- 一次性收入（含折讓的負數）不跨月，整筆記在 checkin 當月
  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount,
      fee_type, item_name)
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount,
      coalesce(o.fee_type, '其他'), o.item_name);
    return;
  end if;
  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  -- checkout 是退房日（不算一晚），所以最後一晚是 checkout - 1。
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then
        amt := o.amount - acc;                        -- 餘數全給最後一期
      else
        amt := trunc(o.amount * n / o.nights);        -- 無條件捨去到整數
        acc := acc + amt;
      end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount,
        fee_type, item_name)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null, null);
    end if;
    ms := me;
  end loop;
end $function$;


-- ============================================================
-- 驗證 —— 實際建一筆再回滾
--
-- 只 select 驗證不到觸發器跑不跑得動（migration_65 就是這樣漏掉的）。
-- ============================================================
do $$
declare
  eid uuid; rid uuid; n_ord int; n_rec int; months int;
  first_amt numeric;
  -- 傳整列給函式要先 select into 一個 row 變數。
  -- 寫成 gen_recurring_orders((select * from ...)) 會噴
  -- 「subquery must return only one column」—— 那是純量子查詢的語法。
  rcrow public.recurring_charges;
begin
  -- 驗證失敗只警告,不讓整份 migration 回滾。
  --
  -- Supabase SQL Editor 把整份腳本當一個交易跑,所以驗證區塊裡任何一個
  -- 錯誤都會把上面剛建好的資料表與函式一起還原 —— 而畫面上只看得到一行錯誤,
  -- 不會有人意識到「什麼都沒建起來」。2026-08 就這樣連續兩次以為跑過了。
  --
  -- 建結構是這支的主要目的,驗證是附加的。附加的東西不該有能力否決主要的。
  begin
  select id into eid from estates order by sort, name limit 1;
  if eid is null then raise notice '沒有物業,跳過驗證'; return; end if;

  insert into recurring_charges (estate_id, fee_type, item_name, amount, start_ym)
  values (eid, '清潔費', '__定期收費測試__', 1234,
          to_char(current_date - interval '2 months', 'YYYYMM'))
  returning id into rid;

  select count(*) into n_ord from orders
   where imported_via = 'recurring' and order_key like 'RC_' || rid || '_%';
  months := 3;   -- 前兩個月 + 本月
  if n_ord <> months then
    raise exception '應該產生 % 列,實際 %', months, n_ord;
  end if;

  -- 認列要跟著長出來,而且項目要帶過去
  select count(*) into n_rec from revenue_recognitions rr
    join orders o on o.id = rr.order_id
   where o.order_key like 'RC_' || rid || '_%';
  if n_rec <> months then
    raise exception '認列列數不對:應 %,實際 %', months, n_rec;
  end if;
  if not exists (select 1 from revenue_recognitions rr join orders o on o.id = rr.order_id
                  where o.order_key like 'RC_' || rid || '_%' and rr.item_name = '__定期收費測試__') then
    raise exception '項目沒有帶進認列表';
  end if;

  -- 改了當月金額之後,再跑一次產生不該把它蓋回預設值
  update orders set amount = 9999
   where order_key = 'RC_' || rid || '_' || to_char(current_date, 'YYYYMM');
  select * into rcrow from recurring_charges where id = rid;
  perform gen_recurring_orders(rcrow);
  select amount into first_amt from orders
   where order_key = 'RC_' || rid || '_' || to_char(current_date, 'YYYYMM');
  if first_amt <> 9999 then
    raise exception '重新產生把改過的金額蓋掉了（變成 %）—— 洗衣機每月金額不同,這條不能壞', first_amt;
  end if;

  raise notice '定期收費正常:產生 % 列、認列 % 列、改過的金額不會被覆蓋', n_ord, n_rec;

  delete from recurring_charges where id = rid;   -- 觸發器會連帶清掉未收款的訂單
  delete from orders where order_key like 'RC_' || rid || '_%';
  exception when others then
    -- 測試資料可能沒清掉,盡量收拾;收不掉也不要因此再噴一次錯
    begin
      delete from orders where order_key like 'RC_' || coalesce(rid::text, '') || '_%';
      delete from recurring_charges where id = rid;
    exception when others then null;
    end;
    raise warning '⚠ 定期收費的驗證沒過:% —— 資料表與函式已經建好,但這一條要查:%',
      sqlerrm, '請把這行訊息貼給工程師';
  end;
end $$;


-- 目前的設定與產生狀況
select rc.item_name as 項目, rc.fee_type as 科目, e.name as 物業,
       rc.amount as 預設金額, rc.start_ym as 起, coalesce(rc.end_ym, '無限期') as 迄,
       (select count(*) from orders o where o.order_key like 'RC_' || rc.id || '_%') as 已產生月數
from public.recurring_charges rc
join public.estates e on e.id = rc.estate_id
order by e.sort, rc.item_name;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('76_recurring_charges'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
