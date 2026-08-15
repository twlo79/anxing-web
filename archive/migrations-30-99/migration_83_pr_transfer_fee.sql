-- migration_83：請款單的匯款手續費
--
-- ============================================================
-- 【要做什麼】
--
-- 請款單多一組欄位：手續費「內扣」或「不內扣」。
--
--   內扣    受款人自己吸收 —— 我方支出就是請款金額，帳上不用多記什麼
--   不內扣  我方額外負擔 —— 我方總支出 = 請款金額 + 手續費，那筆手續費要記帳
--
-- 所以只有「不內扣」會產生東西：確認出款之後，自動多一筆支出
--
--     日期      = 出款日（purchased_on）
--     物業／房源 = 同那張請款單
--     會計科目   = 郵電費
--     金額      = 手續費
--
--
-- 【物業／房源怎麼決定】
-- 一張單可能有好幾個項目，分屬不同房源。規則：
--
--     全部項目的用途／物業／房源都一樣 → 帶那組
--     只要有一個不一樣              → 歸辦公室（purpose_type='office'，不掛房源）
--
-- 手續費是「這一次匯款」產生的，不是某個房源產生的。硬塞給其中一個房源
-- 會讓那個房源的成本莫名其妙變高，而且沒有人看得出來為什麼。
--
--
-- 【為什麼不重複產生】
-- expenses 多一欄 fee_request_id，unique。一張請款單最多一筆手續費支出，
-- 這件事由資料庫保證，不靠觸發器自己記得。
-- 跟 source_item_id 是同一個做法 —— 那一欄就是為了「一個項目只能一筆支出」而存在的。
--
--
-- 【改成內扣了怎麼辦】
-- 同步函式是冪等的：不內扣→內扣，或金額改成 0，那筆支出會被刪掉。
-- 金額改了就跟著改。不是「產生一次就不管了」。


-- ============================================================
-- 1. 請款單的手續費欄位
-- ============================================================

alter table public.purchase_requests
  add column if not exists fee_mode   text    not null default 'included',
  add column if not exists fee_amount numeric not null default 0;

comment on column public.purchase_requests.fee_mode is
  'included=內扣（受款人吸收,不另記帳）／extra=不內扣（我方負擔,會產生一筆郵電費支出）';
comment on column public.purchase_requests.fee_amount is
  '手續費金額,新台幣。fee_mode=included 時必須是 0。';

-- 兩件事一起擋在資料庫層：
--
--   1. 內扣卻填了金額 = 語意矛盾
--   2. 非匯款卻選不內扣 = 根本不會有匯款手續費
--      現金是當面付的,信用卡的費用是銀行跟商家收的,兩者都沒有「匯款手續費」這回事。
--      只把前端的欄位藏起來不夠 —— 付款方式改成現金時如果沒清乾淨,
--      舊值會留在資料庫裡繼續產生郵電費支出,而畫面上完全看不到它。
--
-- 不內扣允許 0：草稿階段可能還沒問到銀行實收多少，送單時前端才要求填。
alter table public.purchase_requests drop constraint if exists pr_fee_chk;
alter table public.purchase_requests add constraint pr_fee_chk check (
  (fee_mode = 'included' and fee_amount = 0) or
  (fee_mode = 'extra'    and fee_amount >= 0 and payment_method = 'transfer')
);


-- ============================================================
-- 2. 支出這邊：認得出「這筆是哪張請款單的手續費」
-- ============================================================

alter table public.expenses
  add column if not exists fee_request_id uuid references public.purchase_requests(id) on delete set null;

-- unique = 一張請款單最多一筆手續費支出。重複產生在資料庫層就不可能。
create unique index if not exists uq_expense_fee_request
  on public.expenses (fee_request_id) where fee_request_id is not null;

comment on column public.expenses.fee_request_id is
  '這筆支出是哪張請款單的匯款手續費。一般支出為 null。'
  'unique —— 一張單只會有一筆,不靠觸發器自律。';


-- ============================================================
-- 3. 確保「郵電費」這個會計科目存在
--
-- 線上的 account_codes 是 baseline 建的，repo 裡看不到內容，
-- 所以這裡不假設它一定有，沒有就補上。
-- 已經有同名科目（不管 code 叫什麼）就沿用，不要製造兩個「郵電費」。
-- ============================================================

do $$
declare has_fi boolean; existing text;
begin
  select code into existing from public.account_codes
   where code = 'postage' or name = '郵電費' limit 1;
  if existing is not null then
    raise notice '郵電費科目已存在（code=%）', existing;
    return;
  end if;

  -- for_income 是後來加的欄位，不確定這個環境有沒有，所以先問再插
  select exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'account_codes'
      and column_name = 'for_income') into has_fi;

  if has_fi then
    insert into public.account_codes (code, name, sort, active, for_income)
    values ('postage', '郵電費', coalesce((select max(sort) from public.account_codes), 0) + 1, true, false);
  else
    insert into public.account_codes (code, name, sort, active)
    values ('postage', '郵電費', coalesce((select max(sort) from public.account_codes), 0) + 1, true);
  end if;
  raise notice '已新增會計科目 郵電費 (postage)';
end $$;


-- ============================================================
-- 4. 手續費支出的同步
--
-- 冪等：不管呼叫幾次，結果都一樣 ——
--   不內扣且金額 > 0 → 有一筆，內容跟現在的請款單一致
--   其餘情況        → 沒有那一筆
--
-- 寫成獨立函式而不是塞進 gen_expenses_from_pr()，是因為它要能被
-- 「改日期」「改金額」「改內扣方式」三種情況共用。
-- ============================================================

create or replace function public.sync_pr_fee_expense(p public.purchase_requests)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  fee_code text;
  n_group  int;
  fp text; fe uuid; fpr uuid;
begin
  -- 不該有手續費支出的情況一律清掉（這個函式是冪等的，見檔頭）：
  --   還沒核可、還沒確認出款  → 錢沒出去，不該有支出
  --   不是匯款               → 現金與信用卡沒有匯款手續費
  --   內扣、或金額是 0        → 我方沒有多付，不用記帳
  --
  -- 用 delete 而不是 return，是因為使用者可能改過設定：
  -- 原本不內扣、出款後改成內扣，或付款方式從匯款改成現金 ——
  -- 那筆已經產生的郵電費支出必須跟著消失，否則帳上會多一筆沒有來源的錢。
  if p.status <> 'approved' or p.purchased_on is null
     or p.payment_method is distinct from 'transfer'
     or p.fee_mode <> 'extra' or coalesce(p.fee_amount, 0) <= 0 then
    delete from expenses where fee_request_id = p.id;
    return;
  end if;

  -- 科目：優先用 postage，沒有就找名字叫郵電費的
  select code into fee_code from account_codes
   where code = 'postage' or name = '郵電費'
   order by (code = 'postage') desc limit 1;

  -- 用途歸屬：全部項目一致才帶，否則歸辦公室（理由見檔頭）
  select count(*) into n_group from (
    select distinct purpose_type, estate_id, property_id
    from purchase_request_items where request_id = p.id) t;

  if n_group = 1 then
    select purpose_type, estate_id, property_id into fp, fe, fpr
    from purchase_request_items where request_id = p.id limit 1;
  else
    fp := 'office'; fe := null; fpr := null;
  end if;

  insert into expenses (
    spent_on, item_name, amount, amount_original, currency, fx_rate,
    account_code, purpose_type, estate_id, property_id,
    payment_method, pay_account, voucher_no, no_voucher,
    note, fee_request_id, created_by
  ) values (
    p.purchased_on, '匯款手續費', p.fee_amount, p.fee_amount, 'TWD', 1,
    fee_code, fp, fe, fpr,
    p.payment_method, p.payout_account, p.voucher_no, coalesce(p.no_voucher, false),
    '請款單 ' || p.req_no || ' 匯款手續費（不內扣）'
      || case when n_group > 1 then '．該單項目分屬多個房源,歸辦公室' else '' end,
    p.id, p.requester_id
  )
  on conflict (fee_request_id) do update set
    spent_on     = excluded.spent_on,
    amount       = excluded.amount,
    amount_original = excluded.amount_original,
    account_code = excluded.account_code,
    purpose_type = excluded.purpose_type,
    estate_id    = excluded.estate_id,
    property_id  = excluded.property_id,
    payment_method = excluded.payment_method,
    pay_account  = excluded.pay_account,
    voucher_no   = excluded.voucher_no,
    no_voucher   = excluded.no_voucher,
    note         = excluded.note;
end $function$;

comment on function public.sync_pr_fee_expense(public.purchase_requests) is
  '把請款單的匯款手續費同步成一筆支出。冪等 —— 改成內扣或金額歸零時會把那筆刪掉。';


-- ============================================================
-- 5. gen_expenses_from_pr()：接上手續費
--
-- 這個版本是從 migration_54 的定義改的，項目支出那段**逐字保留**，
-- 只把「日期沒變就直接 return」那道早退拆開，讓手續費還有機會同步。
--
-- 為什麼要拆：原本只要 purchased_on 沒變就整個 return，
-- 那麼「已經出款之後才改手續費金額」就永遠不會生效。
-- ============================================================

create or replace function public.gen_expenses_from_pr()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;

  if old.purchased_on is null then
    -- 第一次確認出款 → 產生項目支出
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, estate_id, property_id,
      payment_method, pay_account, voucher_no, no_voucher,
      note, source_item_id, created_by
    )
    select new.purchased_on, i.item_name, i.amount,
           coalesce(i.amount_original, i.amount), new.currency, new.fx_rate,
           i.account_code, i.purpose_type, i.estate_id, i.property_id,
           new.payment_method,
           new.payout_account,          -- 我方付款帳號,之前漏帶,支出頁的付款帳號一直是空的
           -- 一張請款單可能拆成多筆支出，憑證號碼會重複帶。
           -- 這是對的：同一張發票本來就對應多個項目，之後對帳靠這個號碼把它們串回去。
           new.voucher_no, coalesce(new.no_voucher, false),
           i.note, i.id, new.requester_id
      from public.purchase_request_items i
     where i.request_id = new.id
    on conflict (source_item_id) do nothing;

    new.expense_generated_at := now();

  elsif old.purchased_on <> new.purchased_on then
    -- 只改日期：同步既有支出，不重複產生
    update public.expenses e
       set spent_on = new.purchased_on
     where e.source_item_id in (
       select i.id from public.purchase_request_items i where i.request_id = new.id);
  end if;

  -- 手續費：三種情況都要對齊（第一次出款、改日期、只改了手續費）。
  -- 函式本身是冪等的，多呼叫不會出事。
  perform public.sync_pr_fee_expense(new);

  return new;
end $function$;


-- ============================================================
-- 6. 既有已出款的單：把手續費補上
--
-- 這一支上線前填的單 fee_mode 都是預設的 'included'，
-- 所以這裡實際上不會產生任何支出 —— 跑它只是為了確認函式接得上，
-- 而且以後有人回頭補填手續費時，資料狀態是一致的。
-- ============================================================

do $$
declare r record; n int := 0;
begin
  for r in select * from public.purchase_requests
            where status = 'approved' and purchased_on is not null
              and fee_mode = 'extra' and coalesce(fee_amount, 0) > 0
  loop
    perform public.sync_pr_fee_expense(r);
    n := n + 1;
  end loop;
  raise notice '補產手續費支出:% 張單', n;
end $$;


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
   where table_schema = 'public' and table_name = 'purchase_requests'
     and column_name in ('fee_mode', 'fee_amount');
  if n = 2 then raise notice '✅ 請款單有 fee_mode / fee_amount';
  else raise warning '❌ 請款單欄位不齊（找到 % 個）', n; end if;

  select count(*) into n from pg_constraint where conname = 'pr_fee_chk';
  if n = 1 then raise notice '✅ 手續費約束已建立（內扣不可有金額、非匯款不可不內扣）';
  else raise warning '❌ pr_fee_chk 不存在'; end if;

  -- 約束的內容對不對 —— 少了 payment_method 那半，現金單一樣可以設不內扣。
  -- 這裡不用「實際 update 一筆試試看」：那種測法萬一約束沒生效，
  -- 就真的把使用者的單改掉了。CHECK 是宣告式的，讀定義就是最直接的證明。
  select pg_get_constraintdef(oid) into c from pg_constraint where conname = 'pr_fee_chk';
  if c like '%payment_method%' and c like '%transfer%' then
    raise notice '✅ 約束有涵蓋「只有匯款才能不內扣」';
  else raise warning '❌ 約束沒涵蓋付款方式:%', c; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'uq_expense_fee_request';
  if n = 1 then raise notice '✅ 一單一筆手續費的唯一索引已建立';
  else raise warning '❌ uq_expense_fee_request 不存在'; end if;

  select code into c from public.account_codes where code = 'postage' or name = '郵電費' limit 1;
  if c is not null then raise notice '✅ 郵電費科目存在（code=%）', c;
  else raise warning '❌ 找不到郵電費科目'; end if;

  -- 觸發器函式真的有接上手續費同步
  if position('sync_pr_fee_expense' in
       pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0 then
    raise notice '✅ gen_expenses_from_pr 已接上手續費同步';
  else raise warning '❌ gen_expenses_from_pr 沒有接上手續費同步'; end if;

  -- 項目支出那段不能被改掉 —— 這是這一支最大的風險
  if position('source_item_id' in
       pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0
     and position('voucher_no' in
       pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0 then
    raise notice '✅ 原本的項目支出邏輯（含憑證欄位）仍在';
  else raise warning '❌ 項目支出邏輯被改壞了!'; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- 有手續費的單現在長什麼樣（目前應該是 0 筆）
select p.req_no, p.purchased_on as 出款日, p.fee_mode, p.fee_amount as 手續費,
       e.id is not null as 已產生支出, e.account_code as 科目, e.amount as 支出金額
from public.purchase_requests p
left join public.expenses e on e.fee_request_id = p.id
where p.fee_mode = 'extra'
order by p.purchased_on desc nulls last;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('83_pr_transfer_fee'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
