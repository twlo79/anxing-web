-- migration_142：帳戶管理 —— 三個銀行帳戶的流水鏡像
--
-- ============================================================
-- 三個帳戶都在元大中崙,都是綜合活期（三份 PDF 實測確認 2026-08-18）:
--
--     20992000170564   期初 28,107 → 2025/06/30 餘額     81,977   47 筆
--     21762000024145   期初      0 → 2025/06/30 餘額      6,590    7 筆（2025/06 才開戶）
--     20992000148088   期初  4,504 → 2025/06/30 餘額    262,433  198 筆
--
-- **24145 的號碼是另一個系列**（21762 開頭,不是 20992）——
-- 同一家分行、同一種帳戶,號碼前綴卻不同。
-- 「三個帳號長得像,比前面幾碼就好」這種捷徑在這裡就會出錯。
--
-- 名稱先照帳號末五碼取。要改成看得懂的名字（例如「營運戶」「押金戶」）
-- 直接改下面的 insert,或事後在資料庫改都可以。
-- ============================================================


-- ============================================================
-- 【為什麼餘額不存在 bank_accounts 上】
--
-- 直覺會在帳戶主檔加一欄 `balance`,用觸發器維護。
-- 但那一欄會**慢慢跟真實對不上**:補匯一份舊對帳單、刪掉一筆重複、
-- 任何一次順序沒照預期,那一欄就錯了 —— 而且不會報錯。
--
-- 對帳單本身就寫著期末餘額。餘額不是「算出來的」,是**銀行說的**。
-- 所以存在 bank_statements.closing_balance,卡片讀最新那一份。
--
-- 代價:沒上傳就沒有數字。那是誠實的 —— 本來就不知道。
--
--
-- ============================================================
-- 【帳號怎麼比對】
--
-- 三個完整帳號都拿到了,所以**一律比完整帳號**(去掉非數字後全等)。
-- account_no_tail 是退路 —— 將來多一個帳戶而還沒拿到 PDF 時才用得上。
--
-- **不論比完整帳號還是末五碼,都只准比「解析出來的帳號欄位」,
--   絕對不可以在整份 PDF 的文字裡搜。**
--
-- 元大這份裡票據號碼長這樣:
--
--     012-0000341168247682
--
-- 那串數字裡隨時可能出現 24145 或 48088 ——
-- 全文搜會撞上票據號碼,而那時它會把整份流水記到錯的帳戶,
-- 靜靜地,沒有人會發現。
--
-- 所以解析器的順序是:先定位「帳號」那一列 → 取出號碼 → 才比對。
-- ============================================================


create table if not exists public.bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                    -- 「元大中崙」
  bank         text not null,                    -- 「元大銀行」
  account_no      text,                          -- 完整帳號。**還不知道就留空**
  account_no_tail text not null,                 -- 末五碼。比對用的最低保證
  parser       text,                             -- 用哪一支解析器:'yuanta' …
  opening_balance    numeric(14,2),              -- 第一份對帳單之前帳上有多少
  opening_balance_on date,
  sort         int  not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint bank_accounts_tail_len check (account_no_tail ~ '^[0-9]{5}$')
);

/*
 * 末五碼唯一 —— 將來多開一個帳戶剛好也是 48088 時,**在這裡失敗**。
 *
 * 不擋的話那時比對會撞上兩個帳戶,而程式多半會取第一個 ——
 * 一半的流水記到錯的帳上,靜靜地。
 * 真的撞了,那時就得把完整帳號填齊改用全比對,而那是對的做法。
 */
create unique index if not exists uq_bank_accounts_tail
  on public.bank_accounts (account_no_tail);

comment on table public.bank_accounts is
  '銀行帳戶主檔（migration_142）。三個帳戶:70564 / 24145 / 48088。';
comment on column public.bank_accounts.account_no is
  '完整帳號。填了就用它比對(去掉非數字後全等)。'
  '留空表示還不知道 —— 那時退而用末五碼比對。';
comment on column public.bank_accounts.account_no_tail is
  '末五碼。**只准拿去比對解析出來的帳號欄位,不可以全文搜** —— '
  '票據號碼(012-0000341168247682)裡隨時會出現一樣的五碼,'
  '撞上就整份記到錯的帳戶。';
comment on column public.bank_accounts.opening_balance is
  '第一份對帳單第一筆之前,帳上原本有多少。'
  '不填的話最早那一筆的餘額連不起來 —— 自檢會報,但不擋。';


-- ── 上傳批次 ───────────────────────────────────────
/*
 * 一份 PDF 一列。存在的意義是「這些流水是哪一份對帳單來的」——
 * 將來發現某一份解析錯了,要能整批撤掉。
 *
 * closing_balance 是卡片上那個數字的來源。
 */
create table if not exists public.bank_statements (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.bank_accounts(id) on delete cascade,
  period_from  date not null,
  period_to    date not null,
  closing_balance numeric(14,2),                 -- PDF 上的期末餘額 ← 卡片讀這個
  total_debit     numeric(14,2),                 -- footer 的「總計」支出
  total_credit    numeric(14,2),                 -- footer 的「總計」存入
  parsed_count   int not null default 0,         -- 解析出幾筆
  inserted_count int not null default 0,         -- 實際寫入幾筆
  skipped_count  int not null default 0,         -- 重複跳過幾筆
  warnings     text[],                           -- 驗不過但仍匯入的項目
  file_name    text,
  uploaded_by  uuid references auth.users(id),
  uploaded_at  timestamptz not null default now(),
  note         text
);

create index if not exists idx_bank_statements_acct
  on public.bank_statements (account_id, period_to desc);

comment on column public.bank_statements.closing_balance is
  '對帳單上的期末餘額。**卡片顯示的餘額讀這裡** —— '
  '餘額是銀行說的,不是我們算的(使用者確認:以對帳單結餘為準)。';
comment on column public.bank_statements.warnings is
  '驗證沒過但人確認後仍匯入的項目。'
  '留著是因為將來數字對不上時,這裡是唯一查得到「當初就知道有問題」的地方。';


-- ── 流水 ───────────────────────────────────────────
create table if not exists public.bank_transactions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.bank_accounts(id) on delete cascade,
  statement_id uuid references public.bank_statements(id) on delete set null,
  seq          int,                              -- 在該份對帳單裡的第幾列(同日排序用)
  txn_date     date,                             -- 交易日 ← 人對帳看這個
  post_date    date not null,                    -- 帳務日 ← 餘額順序跟這個走
  txn_time     time,
  description  text,                             -- ＡＴＭ轉／企網付款／存款息…
  counterparty text,                             -- 交易行庫
  debit        numeric(14,2) not null default 0, -- 支出
  credit       numeric(14,2) not null default 0, -- 存入
  balance      numeric(14,2) not null,           -- 帳面餘額 ← 去重鑰匙的一部分
  memo         text,                             -- 摘要:１２月房租／南５／林思瑜３月租金
  ref_no       text,                             -- 票據號碼
  created_at   timestamptz not null default now(),
  constraint bank_txn_one_side check (debit = 0 or credit = 0)
);

/*
 * 【去重鑰匙】account_id + 帳務日 + 餘額 + 交易時間
 *
 * 不用 PDF 上的序號 —— 那是**本次查詢的流水號**,
 * 換一個查詢期間就從 1 重來。拿它當鑰匙,第二次上傳會蓋掉第一次的。
 *
 * 餘額比金額可靠:同一天收兩筆一樣的房租(都 46,000)金額會撞,
 * 但第一筆進來之後餘額就變了,第二筆的餘額必然不同。
 *
 * 還加交易時間是為了唯一撞得到的情況 ——
 * 同一天先進 X 元又出 X 元,餘額繞回原點。
 *
 * txn_time 可能是 null（有些交易沒印時間）,而 **null 在唯一索引裡互不相等** ——
 * 所以 coalesce 成 '00:00:00',不然沒印時間的兩筆會重複匯入。
 */
create unique index if not exists uq_bank_txn
  on public.bank_transactions
     (account_id, post_date, balance, (coalesce(txn_time, '00:00:00'::time)));

create index if not exists idx_bank_txn_list
  on public.bank_transactions (account_id, post_date desc, seq desc);

comment on constraint bank_txn_one_side on public.bank_transactions is
  '支出與存入不會同時有值。'
  '兩邊都填代表解析器把 x 座標判錯了 —— 那不會報錯,只會讓餘額慢慢歪掉。';
comment on column public.bank_transactions.memo is
  '摘要。**全形字原樣存,不要轉半形** —— '
  '「１２月房租」「南５」「林思瑜３月租金」是將來對帳的線索,'
  '轉了之後跟 PDF 對不起來,而人核對時看的是 PDF。';


-- ============================================================
-- 建三個帳戶
-- ============================================================
/*
 * 三個帳號都從 PDF 讀到了,所以 account_no 全部填滿 ——
 * 比對一律走完整帳號,末五碼那條退路現在用不到。
 *
 * opening_balance 是**從第一份對帳單推導**的:第一筆的「餘額 − 存入 + 支出」。
 * 不是人填的 —— 人填會填錯,而填錯了整條餘額鏈就對不上,
 * 然後每次匯入都會跳警告,最後沒有人再看警告。
 *
 * 名稱先照末五碼取。要改成看得懂的名字(「營運戶」「押金戶」)
 * 直接改這裡,或事後在資料庫改都可以。
 *
 * 用 on conflict do nothing:重跑不會把已經改好的名字蓋回去。
 */
insert into public.bank_accounts
  (name, bank, account_no, account_no_tail, parser, opening_balance, opening_balance_on, sort)
values
  ('元大 70564', '元大銀行', '20992000170564', '70564', 'yuanta', 28107, '2025-01-01', 1),
  ('元大 24145', '元大銀行', '21762000024145', '24145', 'yuanta',     0, '2025-01-01', 2),
  ('元大 48088', '元大銀行', '20992000148088', '48088', 'yuanta',  4504, '2025-01-01', 3)
on conflict (account_no_tail) do nothing;


-- ── RLS ────────────────────────────────────────────
/*
 * 使用者指定:會計 / 主管 / 總經理。
 *
 * 對照 migration_140,那裡的三個角色是 accountant / manager / super_admin。
 * **這裡不給任何人 own 條款** —— 銀行流水沒有「自己的」這回事。
 */
alter table public.bank_accounts     enable row level security;
alter table public.bank_statements   enable row level security;
alter table public.bank_transactions enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bank_accounts', 'bank_statements', 'bank_transactions'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read',  t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$
      create policy %I on public.%I for select
        using (current_role_of() in ('accountant', 'manager', 'super_admin'))
    $f$, t || '_read', t);
    execute format($f$
      create policy %I on public.%I for all
        using (current_role_of() in ('accountant', 'manager', 'super_admin'))
        with check (current_role_of() in ('accountant', 'manager', 'super_admin'))
    $f$, t || '_write', t);
  end loop;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('142_bank_accounts');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; miss text;
begin
  drop table if exists _chk142;
  create temp table _chk142 (ord int, item text, result text, detail text);

  -- 三張表
  insert into _chk142
  select 1, '資料表 ' || t, case when to_regclass('public.' || t) is not null
    then '✅' else '❌' end, ''
  from unnest(array['bank_accounts', 'bank_statements', 'bank_transactions']) t;

  -- 三個帳戶
  select count(*) into n from public.bank_accounts;
  insert into _chk142 values (2, '帳戶數', n || ' 個',
    case when n = 3 then '70564 / 24145 / 48088' else '★ 應該是 3 個' end);

  -- ★ 哪幾個還沒填銀行
  select string_agg(account_no_tail, '、' order by account_no_tail) into miss
    from public.bank_accounts where bank = '待填';
  insert into _chk142 values (3, '★ 還沒填銀行的帳戶',
    coalesce(miss, '（都填了）'),
    case when miss is null then '三個都是元大中崙,同一支解析器'
         else '這幾個帳戶名稱是暫用的,上傳頁會照著顯示 —— 記得改' end);

  -- ★ 哪幾個還沒有完整帳號
  select string_agg(account_no_tail, '、' order by account_no_tail) into miss
    from public.bank_accounts where account_no is null;
  insert into _chk142 values (4, '★ 只有末五碼的帳戶',
    coalesce(miss, '（都有完整帳號）'),
    '有的話比對會退而用末五碼。**只比解析出來的帳號欄位,不可全文搜** —— '
    '票據號碼(012-0000341168247682)裡隨時會出現一樣的五碼');

  -- ★ 期初餘額 —— 從第一份對帳單推導,不是人填的
  select string_agg(account_no_tail || '=' || to_char(opening_balance, 'FM999,999,999'),
                    '、' order by sort) into miss
    from public.bank_accounts where opening_balance is not null;
  insert into _chk142 values (5, '★ 期初餘額', coalesce(miss, '（都沒有）'),
    '第一筆的「餘額 − 存入 + 支出」。錯了的話整條餘額鏈都會跳警告');

  -- ★★ 去重索引真的擋得住嗎 —— 實測一次
  /*
   * 唯一索引寫錯（例如漏了 coalesce）不會有任何徵兆,
   * 要等到第二次上傳同一份 PDF 才發現流水變兩倍。
   * 那時已經混在一起,分不出哪一筆是重複的。
   */
  begin
    insert into public.bank_transactions (account_id, post_date, balance, credit, txn_time)
    select id, '1900-01-01', 999, 999, null from public.bank_accounts limit 1;
    begin
      insert into public.bank_transactions (account_id, post_date, balance, credit, txn_time)
      select id, '1900-01-01', 999, 999, null from public.bank_accounts limit 1;
      insert into _chk142 values (6, '★★ 沒印時間的重複擋得住', '❌ 插得進去第二次',
        '唯一索引沒把 txn_time 的 null 收斂 —— 重傳同一份會變兩倍');
    exception when unique_violation then
      insert into _chk142 values (6, '★★ 沒印時間的重複擋得住', '✅', 'null 有被 coalesce 收斂');
    end;
    delete from public.bank_transactions where post_date = '1900-01-01';
  exception when others then
    insert into _chk142 values (6, '★★ 沒印時間的重複擋得住', '❌ ' || sqlerrm, '');
  end;

  -- ★★ 支出存入同時有值要被擋（解析器判錯 x 座標的症狀）
  begin
    insert into public.bank_transactions (account_id, post_date, balance, debit, credit)
    select id, '1900-01-02', 999, 100, 200 from public.bank_accounts limit 1;
    insert into _chk142 values (7, '★★ 支出與存入不能同時有值', '❌ 插得進去',
      'CHECK 沒生效 —— 解析器判錯 x 座標時不會被擋下來');
    delete from public.bank_transactions where post_date = '1900-01-02';
  exception when check_violation then
    insert into _chk142 values (7, '★★ 支出與存入不能同時有值', '✅', 'CHECK 擋住了');
  when others then
    insert into _chk142 values (7, '★★ 支出與存入不能同時有值', '⚠ ' || sqlerrm, '');
  end;

  -- RLS
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('bank_accounts', 'bank_statements', 'bank_transactions');
  insert into _chk142 values (8, 'RLS policy 數', n || ' 條',
    case when n = 6 then '三張表各 read/write,限會計以上' else '★ 應該是 6 條' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk142 order by ord, item;
