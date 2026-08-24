-- migration_164：收款的匯款手續費 → 郵電費支出
--
-- ============================================================
-- 【要解決什麼】（2026-08-22 使用者指定）
--
-- 房客匯 10,000，銀行扣 30，我們實收 9,970。
-- **那 30 元是我方的成本**，帳上要有一筆郵電費支出，
-- 不然「營收 10,000、銀行只進 9,970」永遠對不起來。
--
-- 這跟請款單的匯款手續費（migration_83）是**同一件事、反方向**:
--
--     請款單   我方付款被扣   fee_mode / fee_amount → 郵電費支出
--     收款     我方收款被扣   order_payments.fee_amount → 郵電費支出
--
-- 所以整支照 `sync_pr_fee_expense()` 的骨架寫，包括冪等的做法。
--
--
-- ============================================================
-- 【使用者拍板的三件事】
--
--   ① 金額填**房客付的**（含手續費）
--      營收是 10,000、郵電費支出 30。會計上比較對，
--      跟請款單的「不內扣」一致。
--      代價:填單的人看銀行入帳 9,970，要自己回推 —— 所以畫面上
--      要即時算出「實際進帳」給他核對（見前端）。
--
--   ② 手續費掛在**每一筆收款**上，不是整張訂單
--      分兩次匯就有兩筆手續費 —— 實際上就是這樣。
--      掛在訂單上的話記不下第二筆。
--
--   ③ 一筆手續費一筆支出，**不按月合併**
--      追得到是哪一筆收款的。代價是一個月 50 筆匯款就多 50 列支出。
--
--
-- ============================================================
-- 【為什麼冪等這麼重要】
--
-- 使用者會改:填錯金額、把收款方式從匯款改成現金、把整筆收款刪掉。
-- 每一種都要讓那筆郵電費支出跟著消失或更新 ——
-- 不然帳上會多一筆**沒有來源的錢**，而對帳時查不到它為什麼在那裡。
--
-- 做法跟 83 一樣:`expenses.fee_payment_id` UNIQUE ＋ upsert／delete。
-- ============================================================


-- ── ① 收款明細記手續費 ─────────────────────────────
alter table public.order_payments
  add column if not exists fee_amount numeric not null default 0,
  add column if not exists fee_on     date;

/*
 * fee_on 是**手續費發生的日期**，不一定等於收款日。
 * 銀行常常隔一天才扣，而那一天決定它算哪個月的支出。
 * 沒填就用收款日（見下面的 coalesce）。
 */

do $$ begin
  alter table public.order_payments add constraint op_fee_chk
    check (fee_amount >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.order_payments.fee_amount is
  '這筆收款被銀行扣掉的手續費。> 0 會產生一筆郵電費支出（migration_164）。'
  '金額欄填的是**房客付的**，所以實際進帳 = amount − fee_amount。';


-- ── ② 支出認得它從哪一筆收款來 ─────────────────────
alter table public.expenses
  add column if not exists fee_payment_id uuid
    references public.order_payments(id) on delete cascade;

/*
 * on delete cascade:收款被刪掉，郵電費支出跟著走。
 * set null 的話會留下一筆孤兒支出，而對帳時沒有人查得出它的來源。
 *
 * UNIQUE 是冪等的關鍵 —— 一筆收款最多一筆手續費支出，
 * 靠 on conflict 更新而不是每次新增。
 */
create unique index if not exists expenses_fee_payment_uidx
  on public.expenses (fee_payment_id) where fee_payment_id is not null;

comment on column public.expenses.fee_payment_id is
  '這筆郵電費支出來自哪一筆收款的匯款手續費（migration_164）。'
  'UNIQUE —— 一筆收款最多一筆，靠它認人做冪等更新。';


-- ── ③ 同步函式（冪等）─────────────────────────────
create or replace function public.sync_op_fee_expense(p public.order_payments)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  fee_code text;
  o        public.orders%rowtype;
begin
  /*
   * 不該有手續費支出的情況一律清掉（這個函式是冪等的，見檔頭）:
   *   不是匯款      現金收款沒有匯費
   *   金額 <= 0     沒被扣就不用記帳
   *
   * 用 delete 而不是 return —— 使用者可能改過設定:
   * 原本填了手續費、後來改成現金收款，那筆已經產生的郵電費
   * 必須跟著消失，否則帳上會多一筆沒有來源的錢。
   */
  if p.method is distinct from 'transfer' or coalesce(p.fee_amount, 0) <= 0 then
    delete from expenses where fee_payment_id = p.id;
    return;
  end if;

  select * into o from public.orders where id = p.order_id;
  if not found then
    delete from expenses where fee_payment_id = p.id;
    return;
  end if;

  /*
   * ★ 其他事業體的收款也可以有手續費，而那筆支出要記在**同一本帳**
   *   （migration_159）。記到安幸帳上的話，愛皮的成本會變成安幸的支出。
   *
   * 但科目要分家:安幸用 postage，愛皮洪鯊各有自己的。
   * 找不到對應科目就不產生支出 —— 硬塞一個別家的科目
   * 會被 trg_expenses_book_code 擋下來，而使用者看到的是
   * 一句看不懂的「會計科目不屬於這一本帳」。
   */
  select code into fee_code from account_codes
   where book = coalesce(o.book, 'anxing')
     and (code = 'postage' or name like '%郵電%' or name like '%銀行費用%'
          or name like '%平台手續費%' or name like '%交易手續費%')
   order by (code = 'postage') desc, sort limit 1;

  if fee_code is null then
    -- 那本帳沒有適合的科目 —— 不猜，也不擋收款本身
    delete from expenses where fee_payment_id = p.id;
    return;
  end if;

  insert into expenses (
    spent_on, item_name, amount, amount_original, currency, fx_rate,
    account_code, purpose_type, estate_id, property_id,
    payment_method, pay_account, note, fee_payment_id, book, created_by
  ) values (
    -- 銀行常常隔一天才扣。沒填就用收款日
    coalesce(p.fee_on, p.paid_on),
    '匯款手續費（收款）',
    p.fee_amount, p.fee_amount, 'TWD', 1,
    fee_code,
    -- 兩家沒有房子 —— 用途走 other_biz；安幸的跟著訂單的物業
    case when coalesce(o.book, 'anxing') <> 'anxing' then 'other_biz'
         when o.estate_id is not null then 'estate' else 'office' end,
    case when coalesce(o.book, 'anxing') <> 'anxing' then null else o.estate_id end,
    case when coalesce(o.book, 'anxing') <> 'anxing' then null else o.property_id end,
    'transfer', p.account,
    '收款手續費・' || coalesce(o.guest_name, '') || '　'
      || coalesce(o.property_raw, '') || '　收款 ' || p.paid_on
      || '　房客付 ' || round(p.amount) || '、實收 ' || round(p.amount - p.fee_amount),
    p.id, coalesce(o.book, 'anxing'), null
  )
  on conflict (fee_payment_id) do update set
    spent_on        = excluded.spent_on,
    amount          = excluded.amount,
    amount_original = excluded.amount_original,
    account_code    = excluded.account_code,
    purpose_type    = excluded.purpose_type,
    estate_id       = excluded.estate_id,
    property_id     = excluded.property_id,
    pay_account     = excluded.pay_account,
    note            = excluded.note,
    book            = excluded.book;
end $function$;

comment on function public.sync_op_fee_expense(public.order_payments) is
  '把收款的匯款手續費同步成一筆郵電費支出。冪等 —— '
  '改成現金收款或金額歸零時會把那筆刪掉（migration_164）。';


create or replace function public.trg_op_fee()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    -- 收款被刪 → 支出靠 on delete cascade 自己走，這裡不用做事
    return old;
  end if;
  perform public.sync_op_fee_expense(new);
  return new;
end $function$;

drop trigger if exists trg_op_fee_expense on public.order_payments;
create trigger trg_op_fee_expense
  after insert or update of fee_amount, fee_on, method, account, amount, paid_on
  on public.order_payments
  for each row execute function public.trg_op_fee();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('164_income_transfer_fee');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 收款的手續費欄位' as "檢查項目",
         count(*)::text || ' / 2' as "結果",
         case when count(*) = 2 then '✅ fee_amount ＋ fee_on' else '❌' end as "說明"
    from information_schema.columns
   where table_schema = 'public' and table_name = 'order_payments'
     and column_name in ('fee_amount', 'fee_on')

  union all
  select 2, '★★ 支出認得來源', count(*)::text || ' / 1',
         case when count(*) = 1 then '✅ expenses.fee_payment_id' else '❌' end
    from information_schema.columns
   where table_schema = 'public' and table_name = 'expenses'
     and column_name = 'fee_payment_id'

  union all
  /*
   * ★★ UNIQUE 是冪等的關鍵。
   *   沒有它的話 on conflict 對不到索引 —— 而症狀是
   *   「儲存失敗：there is no unique or exclusion constraint matching
   *     the ON CONFLICT specification」（8/19 那個坑）。
   */
  select 3, '★★ 冪等的唯一索引',
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public'
                              and indexname = 'expenses_fee_payment_uidx')
              then '✅' else '❌ on conflict 會對不到索引' end,
         '一筆收款最多一筆手續費支出'

  union all
  select 4, '★ 觸發器',
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.order_payments'::regclass
                              and tgname = 'trg_op_fee_expense')
              then '✅' else '❌' end,
         '填了手續費自動產生支出，改成現金自動刪掉'

  union all
  /*
   * ★ 郵電費科目要找得到，不然功能靜默失效。
   */
  select 5, '★ 安幸的郵電費科目',
         coalesce((select code || '（' || name || '）' from account_codes
                    where book = 'anxing' and (code = 'postage' or name like '%郵電%')
                    order by (code = 'postage') desc limit 1), '❌ 找不到'),
         '找不到的話手續費不會產生支出（不擋收款）'

  union all
  select 6, '既有收款', count(*)::text || ' 筆',
         '全部 fee_amount = 0，行為完全不變'
    from public.order_payments where coalesce(fee_amount, 0) = 0

) v order by ord;
