-- migration_87：短租發票 ＋ 押金改成「一筆多幣別」
--
-- ============================================================
-- 【一、押金不再一幣別一列】
--
-- 原本的設計是 unique (order_id, currency) —— 收台幣 5,000 ＋ 日圓 10,000
-- 就會在押金管理裡變成兩列，各自有自己的收款日、入款方式、退款流程。
--
-- 但實際作業不是那樣：多幣別的現金**放在同一個保險箱一起保管，之後一起退**。
-- 一次收、一次退、一組帳戶。拆成兩列的話使用者要填兩次一模一樣的東西，
-- 而且兩列的收款日還可能不小心填得不一樣，事後看不出哪個才對。
--
-- 所以改成一筆押金一列，幣別明細存在 lines：
--
--     lines = [{"cur":"TWD","amt":160000},{"cur":"JPY","amt":10000}]
--
-- amount 保留**台幣**那部分（統計、報表、Excel 都在讀它，語意不變），
-- currency 固定 'TWD'。外幣只出現在 lines 裡。
--
-- 【為什麼安全】
-- 執行前查過：目前沒有任何一組母體有兩種以上幣別（0 筆）。
-- 所以這支不需要合併任何東西，只是把既有每一列的幣別寫進它自己的 lines。
--
--
-- ============================================================
-- 【二、短租也要能開發票】
--
-- 契約早就有這條線:contracts.invoice_required 打勾 → 收租視窗每期填號碼
-- → 存進 invoices。短租完全沒有，只能記在備註裡。
--
-- 沿用同一張 invoices 表。它本來就有 order_id 欄位 —— 契約的發票也是靠它
-- 掛回那一期的月租單，短租只是 contract_id 留空。
--
-- 【唯一索引為什麼要限定 contract_id is null】
-- 契約的發票也會填 order_id。索引若寫成「一張訂單一張發票」而不分來源，
-- 會連契約那邊一起管到，而那邊的規則是「一個契約一個月一張」，不是同一件事。


-- ============================================================
-- 1. 短租訂單的發票設定
-- ============================================================

alter table public.orders
  add column if not exists invoice_required boolean not null default false,
  add column if not exists invoice_title    text,
  add column if not exists invoice_tax_id   text;

comment on column public.orders.invoice_required is
  '這張短租訂單要開發票。打勾之後收款視窗才會出現發票號碼欄位。';

create unique index if not exists inv_order_once_idx
  on public.invoices (order_id)
  where order_id is not null and contract_id is null and status = 'issued';


-- ============================================================
-- 2. 契約的外幣押金欄位
--
-- 短租早就有 orders.fx_deposit，契約只有一個台幣欄位。格式刻意做成一樣的，
-- 前端兩邊共用 lib/money-lines 的轉換。
-- ============================================================

alter table public.contracts
  add column if not exists fx_deposit jsonb not null default '[]'::jsonb;

comment on column public.contracts.fx_deposit is
  '外幣押金明細 [{"cur":"JPY","amt":10000}]。台幣仍在 deposit 欄位。';


-- ============================================================
-- 3. 押金的幣別明細
-- ============================================================

alter table public.deposits
  add column if not exists lines jsonb not null default '[]'::jsonb;

comment on column public.deposits.lines is
  '這筆押金的幣別明細 [{"cur":"TWD","amt":160000},{"cur":"JPY","amt":10000}]。'
  '多幣別是一起收、一起退的（放同一個保險箱），所以是一列不是多列。'
  'amount 只存台幣那部分,外幣只在這裡。';

-- 回填：既有每一列本來就代表一種幣別，把它寫進自己的 lines。
-- 只補空的,重跑不會把已經有明細的列洗掉。
update public.deposits
   set lines = jsonb_build_array(jsonb_build_object('cur', currency, 'amt', amount))
 where lines = '[]'::jsonb and coalesce(amount, 0) <> 0;


-- ── 索引從「一母體一幣別」改成「一母體一列」──────────
--
-- 舊索引不 drop 的話，之後同一張訂單想同時有 TWD 與 JPY 仍會被擋住，
-- 而那正是這支要允許的事。

drop index if exists public.dep_order_cur_idx;
drop index if exists public.dep_contract_cur_idx;

create unique index if not exists dep_order_once_idx
  on public.deposits (order_id) where order_id is not null;
create unique index if not exists dep_contract_once_idx
  on public.deposits (contract_id) where contract_id is not null;


-- ============================================================
-- 4. 同步：訂單 → 押金
--
-- 一張訂單一列。台幣與外幣併成 lines，一起收、一起退。
-- ============================================================

create or replace function public.sync_order_deposits() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  arr jsonb := '[]'::jsonb;
  twd numeric := coalesce(new.deposit, 0);
  l jsonb; c text; a numeric;
begin
  if twd > 0 then
    arr := arr || jsonb_build_object('cur', 'TWD', 'amt', twd);
  end if;

  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := upper(nullif(trim(l->>'cur'), ''));
    a := coalesce((l->>'amt')::numeric, 0);
    -- 台幣不會出現在 fx_deposit（前端存檔時就分開了），這裡再擋一次,
    -- 免得手動改資料的人把台幣塞進去造成 lines 裡有兩個 TWD。
    if c is not null and a > 0 and c <> 'TWD' then
      arr := arr || jsonb_build_object('cur', c, 'amt', a);
    end if;
  end loop;

  -- 完全沒有押金了。還沒收錢的直接清掉；已經收了的留著標 orphaned ——
  -- 錢在我們手上，紀錄不能無聲消失。
  if jsonb_array_length(arr) = 0 then
    delete from deposits where order_id = new.id and received_on is null;
    update deposits set orphaned = true
     where order_id = new.id and received_on is not null;
    return new;
  end if;

  insert into deposits (order_id, currency, amount, lines,
                        estate_id, property_id, room, guest_name)
  values (new.id, 'TWD', twd, arr,
          new.estate_id, new.property_id, new.property_raw, new.guest_name)
  on conflict (order_id) where order_id is not null
  do update set amount = excluded.amount, lines = excluded.lines,
                estate_id = excluded.estate_id, property_id = excluded.property_id,
                room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  return new;
end $fn$;


-- ============================================================
-- 5. 同步：契約 → 押金
--
-- 形狀跟上面刻意做成一樣的。兩邊行為不一致的話，
-- 使用者會發現「同一件事在契約與短租結果不同」。
-- ============================================================

create or replace function public.sync_contract_deposits() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  arr jsonb := '[]'::jsonb;
  twd numeric := coalesce(new.deposit, 0);
  l jsonb; c text; a numeric;
begin
  if twd > 0 then
    arr := arr || jsonb_build_object('cur', 'TWD', 'amt', twd);
  end if;

  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := upper(nullif(trim(l->>'cur'), ''));
    a := coalesce((l->>'amt')::numeric, 0);
    if c is not null and a > 0 and c <> 'TWD' then
      arr := arr || jsonb_build_object('cur', c, 'amt', a);
    end if;
  end loop;

  if jsonb_array_length(arr) = 0 then
    delete from deposits where contract_id = new.id and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and received_on is not null;
    return new;
  end if;

  insert into deposits (contract_id, currency, amount, lines,
                        estate_id, room, guest_name)
  values (new.id, 'TWD', twd, arr, new.estate_id, new.room, new.tenant_name)
  on conflict (contract_id) where contract_id is not null
  do update set amount = excluded.amount, lines = excluded.lines,
                estate_id = excluded.estate_id,
                room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  return new;
end $fn$;

-- 觸發器要涵蓋 fx_deposit —— 只監看 deposit 的話，改外幣押金不會生效。
drop trigger if exists trg_sync_contract_deposits on public.contracts;
create trigger trg_sync_contract_deposits
  after insert or update of deposit, fx_deposit, estate_id, room, tenant_name
  on public.contracts
  for each row execute function public.sync_contract_deposits();


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的 schema 變更
-- 整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; c text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'orders'
     and column_name in ('invoice_required', 'invoice_title', 'invoice_tax_id');
  if n = 3 then raise notice '✅ orders 的發票欄位齊了';
  else raise warning '❌ orders 發票欄位只有 % 個', n; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'inv_order_once_idx';
  if n = 1 then raise notice '✅ 一張短租訂單一張發票的唯一索引已建立';
  else raise warning '❌ inv_order_once_idx 不存在'; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'deposits' and column_name = 'lines';
  if n = 1 then raise notice '✅ deposits.lines 已建立';
  else raise warning '❌ deposits.lines 不存在'; return; end if;

  -- 舊索引一定要消失,否則同一張訂單仍然不能有兩種幣別
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname in ('dep_order_cur_idx', 'dep_contract_cur_idx');
  if n = 0 then raise notice '✅ 舊的「一幣別一列」索引已移除';
  else raise warning '❌ 還有 % 個舊索引在,多幣別會被擋下來', n; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname in ('dep_order_once_idx', 'dep_contract_once_idx');
  if n = 2 then raise notice '✅ 新的「一母體一列」索引已建立';
  else raise warning '❌ 新索引只有 % 個', n; end if;

  -- 回填有沒有漏
  select count(*) into n from public.deposits
   where jsonb_array_length(lines) = 0 and coalesce(amount, 0) <> 0;
  if n = 0 then raise notice '✅ 每一筆有金額的押金都有幣別明細';
  else raise warning '❌ 有 % 筆押金沒有明細', n; end if;

  -- 明細裡的台幣要跟 amount 對得起來
  select count(*) into n from public.deposits d
   where coalesce(d.amount, 0) <> 0
     and coalesce((select (e->>'amt')::numeric from jsonb_array_elements(d.lines) e
                    where e->>'cur' = 'TWD' limit 1), 0) <> coalesce(d.amount, 0);
  if n = 0 then raise notice '✅ 明細的台幣金額與 amount 一致';
  else raise warning '❌ 有 % 筆的台幣明細與 amount 對不上', n; end if;

  -- 同步函式真的改成一列了嗎
  c := pg_get_functiondef('public.sync_order_deposits()'::regprocedure);
  if position('lines' in c) > 0 then raise notice '✅ 訂單押金同步已寫入幣別明細';
  else raise warning '❌ sync_order_deposits 沒有處理 lines'; end if;

  select pg_get_triggerdef(oid) into c from pg_trigger
   where tgname = 'trg_sync_contract_deposits';
  if c is not null and position('fx_deposit' in c) > 0 then
    raise notice '✅ 契約觸發器有監看 fx_deposit';
  else raise warning '❌ 契約觸發器沒有監看 fx_deposit:%', c; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 現況 ───────────────────────────────────────────

select case when contract_id is not null then '契約'
            when order_id is not null then '短租'
            else '手動' end                                 as 來源,
       jsonb_array_length(lines)                            as 幣別數,
       count(*)                                             as 筆數,
       sum(amount)::bigint                                  as 台幣金額,
       count(*) filter (where received_on is not null)      as 已收款
from public.deposits
group by 1, 2 order by 1, 2;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('87_st_invoice_deposit_lines'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
