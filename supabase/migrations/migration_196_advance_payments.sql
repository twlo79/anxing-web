/*
 * migration_196 —— 暫付：公司付出去、之後要收回來的押金與保證金
 * ============================================================
 * 2026-09-01 使用者：「公司支付的押金、保證金 / 選擇 押金 保證金 > 請款 >
 *                     審核 | 出款後 / 支出 會進暫付管理 > 之後會有收入收回 /
 *                     已付款 | 已退款」
 *                     「改叫 暫收付管理」
 *
 * 四個決定（2026-09-01 使用者選的）:
 *   收回時       沖銷暫付，**不算收入**
 *   出款時       **不算當月支出**，只進暫付
 *   放哪裡       暫收付管理頁多一個分頁
 *   被扣一部分   差額轉成支出
 *
 * ============================================================
 * 【★★★ 為什麼開新表，而不是塞進 deposits】
 *
 * 畫面上它跟暫收並排（同一頁的第四個分頁），所以「共用同一張表」
 * 看起來很自然 —— 而且能省下收退款元件。但那會買下一個很貴的東西:
 *
 *   `deposits` 的每一個既有查詢都要補上「而且不是暫付」。
 *   漏掉一處，暫付的錢就會被算進「我們保管多少客戶的押金」——
 *   **而那個數字看起來完全正常**，只是把「別人的錢」跟「我們的錢」加在一起。
 *
 *   押金頁的統計卡、報表、匯出、請款頁的核可佇列、
 *   `sumByCurrency`、`twdOf`… 十幾個地方，每一處漏掉都不會報錯。
 *
 * ★★ 而「共用元件」那個好處其實不成立:
 *   暫收的退款要走**兩票核可**（主管＋總經理），因為錢要匯出去。
 *   暫付的收回是**錢進來**，不需要核可。
 *   出款那一段的核可，請款單已經做完了。
 *   —— 兩邊真正共用的只有「一張表格加一個抽屜」，那是版面，不是邏輯。
 *
 * ★ 方向相反的錢放同一張表，是「一個欄位兼兩個意思」的放大版
 *   （CLAUDE.md:現在拆開的成本是一張表，之後合著用的成本是每一次查詢）。
 *
 * ============================================================
 * 【★★★ 出款不記費用、收回不記收入 —— 唯一的例外是被扣的差額】
 *
 *   付 150,000 → 這張表一列，帳上**沒有**支出
 *   收回 150,000 → 這一列結案，帳上**沒有**收入
 *   收回 148,000 → 這一列結案，差額 2,000 **變成一筆真的支出**
 *
 * ★ 押金退回來是拿回自己的錢，不是賺到。記成收入的話營收虛增，
 *   而那個數字看起來完全正常 —— 站上對房客押金已經是這個立場
 *   （儀表板寫著「訂單總額・押金非營收」），我方付的要一致。
 *
 * ★★ 手續費是**真的費用**，照舊走請款單的 fee_mode='extra' → 郵電費。
 *   那一段一個字都不動。
 */

-- ══════════════════════════════════════════════════════════
-- ① 表
-- ══════════════════════════════════════════════════════════
create table if not exists public.advance_payments (
  id           uuid primary key default gen_random_uuid(),

  /*
   * 從哪張請款單的哪個項目出去的。
   *
   * ★ `on delete set null` 而不是 cascade —— 請款單被刪掉不代表那筆錢沒付出去。
   *   連著刪的話，一筆還在外面的 150,000 會安靜消失，
   *   而沒有人會發現少了一列（跟 migration_188 的 hk_work_item 同一個道理）。
   */
  request_item_id uuid references public.purchase_request_items(id) on delete set null,

  /*
   * 類別。★ 用 check 不用 enum —— enum 加值要 `alter type`，
   *   而那在交易裡有限制。之後多一種（履約保證金、押標金…）改這裡就好。
   */
  category     text not null,
  counterparty text not null,          -- 對象：房東、機關、電信商
  usage        text not null,          -- 用途：安幸辦公室租賃、114 年清潔標案
  estate_id    uuid references public.estates(id) on delete set null,

  amount       numeric(14,2) not null, -- 付出去多少
  paid_on      date,                   -- 出款日。null = 請款單還沒確認出款
  paid_account text,

  /*
   * 收回。
   *
   * ★★ `refunded_amount` 跟 `amount` 分開存，**不要用一個欄位兼兩個意思**:
   *   「還沒收回」與「收回 0 元（全額被扣）」在畫面上的行為完全不同，
   *   而用 null/0 兼表的話，第一次看到 0 的人分不出是哪一種。
   */
  refunded_on     date,
  refunded_amount numeric(14,2),
  refund_account  text,

  /*
   * 被扣的差額轉成的那筆支出（amount − refunded_amount）。
   *
   * ★★★ 冪等靠它 —— 有值就不再產生第二筆。
   *   沒有這一欄的話重複按「確認收回」就是重複支出，
   *   而總額看起來只是「多了一筆」（跟 deposits.forfeit_order_id 同一個作法）。
   */
  forfeit_expense_id uuid references public.expenses(id) on delete set null,

  note       text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ap_category_chk    check (category in ('押金', '保證金')),
  constraint ap_amount_chk      check (amount > 0),
  /*
   * ★ 收回不能超過付出去的。超過的話「被扣的差額」會是負數，
   *   而負數的支出沒有人看得懂 —— 那通常代表有人把利息或別筆錢混進來了。
   */
  constraint ap_refund_range_chk check (
    refunded_amount is null or (refunded_amount >= 0 and refunded_amount <= amount)),
  /*
   * ★★ 日期與金額要一起有或一起沒有。
   *   只有其中一個的話，狀態就落在「已退款」與「已付款」之間 ——
   *   而畫面上要據此決定顯示哪個標籤，兩邊都不對。
   */
  constraint ap_refund_pair_chk check (
    (refunded_on is null) = (refunded_amount is null)),
  -- ★ 還沒出款就不可能收回。反過來的資料是打錯字，不是一種狀態。
  constraint ap_refund_after_paid_chk check (
    refunded_on is null or (paid_on is not null and refunded_on >= paid_on))
);

comment on table public.advance_payments is
  '暫付：公司付出去、之後要收回來的押金與保證金（migration_196）。'
  '★★★ 出款不記費用、收回不記收入 —— 那是拿回自己的錢。'
  '唯一會產生費用的是「被扣的差額」（forfeit_expense_id）。'
  '★★ 刻意**不放進 deposits** —— 方向相反的錢混在同一張表，'
  '每一個既有查詢都要補上「而且不是暫付」，漏一處就把我們的錢算進客戶的押金裡，'
  '而那個數字看起來完全正常。';

comment on column public.advance_payments.paid_on is
  '出款日。null = 請款單還沒按「確認出款」—— 錢還沒離開我們的帳戶。';
comment on column public.advance_payments.refunded_amount is
  '實際收回多少。★ 跟 amount 分開存：「還沒收回」（null）與'
  '「收回 0 元、全額被扣」（0）在畫面上是兩件完全不同的事。';
comment on column public.advance_payments.forfeit_expense_id is
  '被扣的差額（amount − refunded_amount）產生的那筆支出。'
  '★★★ 冪等靠它 —— 有值就不再產生第二筆。'
  '沒有它的話重複按「確認收回」就是重複支出，而總額看起來只是多了一筆。';

create index if not exists ap_paid_idx     on public.advance_payments (paid_on desc);
create index if not exists ap_open_idx     on public.advance_payments (paid_on)
  where paid_on is not null and refunded_on is null;   -- 「錢還在外面」的清單
create index if not exists ap_req_item_idx on public.advance_payments (request_item_id);


-- ══════════════════════════════════════════════════════════
-- ② 請款單項目：這一筆是不是押金／保證金
-- ══════════════════════════════════════════════════════════
alter table public.purchase_request_items
  add column if not exists advance_category text;

comment on column public.purchase_request_items.advance_category is
  '押金／保證金（migration_196）。null = 一般請款，行為完全不變。'
  '★ 有值的話，確認出款後會在 advance_payments 產生一列，'
  '而**那筆錢不計入當月支出** —— 它是暫時放在別人那裡的資產，不是花掉的錢。';

do $$ begin
  begin
    alter table public.purchase_request_items
      add constraint pri_advance_category_chk
      check (advance_category is null or advance_category in ('押金', '保證金'));
  exception when duplicate_object then null; end;
end $$;


-- ══════════════════════════════════════════════════════════
-- ③ RLS
-- ══════════════════════════════════════════════════════════
alter table public.advance_payments enable row level security;

/*
 * ★ 跟請款單同一群人看得到。包在 exception 裡是因為 SQL Editor
 *   把整份腳本當一個交易，policy 已存在會讓整支回滾（CLAUDE.md 的坑）。
 */
do $$ begin
  begin
    create policy ap_read on public.advance_payments
      for select to authenticated using (true);
  exception when duplicate_object then null; end;

  begin
    create policy ap_write on public.advance_payments
      for all to authenticated
      using (public.current_role_of() in ('accountant', 'manager', 'super_admin'))
      with check (public.current_role_of() in ('accountant', 'manager', 'super_admin'));
  exception when duplicate_object then null; end;
end $$;


-- ══════════════════════════════════════════════════════════
-- ④ 破壞性測試：約束**真的會擋**嗎
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 只查「約束存不存在」是不夠的 —— migration_174 的檔頭記著同樣的教訓:
 *   `on conflict` 推不出部分索引那次，索引明明在，但存不進去。
 *   所以這裡**真的去插違法資料**，確認它被擋下來。
 *
 * ★ 每一筆都包在 `begin … exception` 裡 —— 那在 plpgsql 裡是一個隱含的
 *   savepoint，所以失敗只回滾那一筆，不會拖垮整份腳本
 *   （SQL Editor 把整份包成一個交易，CLAUDE.md 的坑）。
 *
 * ★ 成功插進去的那幾筆會被最後的 delete 清掉 —— 用一個認得出來的
 *   counterparty 當標記，不靠 id。
 */
create temp table _chk196 (item text, result text) on commit drop;

do $$
declare ok boolean;
begin
  -- ① 收回日有值、金額是 null → 應該被 ap_refund_pair_chk 擋
  ok := false;
  begin
    insert into public.advance_payments
      (category, counterparty, usage, amount, paid_on, refunded_on)
    values ('押金', '__chk196__', '約束測試', 1000, '2026-01-01', '2026-02-01');
  exception when check_violation then ok := true;
  end;
  insert into _chk196 values ('有收回日但沒金額',
    case when ok then '✅ 擋下來了' else '⚠ 存進去了 —— 這種列的狀態標籤兩邊都不對' end);

  -- ② 收回金額大於暫付 → 應該被 ap_refund_range_chk 擋
  ok := false;
  begin
    insert into public.advance_payments
      (category, counterparty, usage, amount, paid_on, refunded_on, refunded_amount)
    values ('押金', '__chk196__', '約束測試', 1000, '2026-01-01', '2026-02-01', 1500);
  exception when check_violation then ok := true;
  end;
  insert into _chk196 values ('收回比付出去的多',
    case when ok then '✅ 擋下來了' else '⚠ 存進去了 —— 被扣的差額會變成負數' end);

  -- ③ 還沒出款就先收回 → 應該被 ap_refund_after_paid_chk 擋
  ok := false;
  begin
    insert into public.advance_payments
      (category, counterparty, usage, amount, refunded_on, refunded_amount)
    values ('押金', '__chk196__', '約束測試', 1000, '2026-02-01', 1000);
  exception when check_violation then ok := true;
  end;
  insert into _chk196 values ('還沒出款就收回',
    case when ok then '✅ 擋下來了' else '⚠ 存進去了' end);

  -- ④ 類別亂填 → 應該被 ap_category_chk 擋
  ok := false;
  begin
    insert into public.advance_payments
      (category, counterparty, usage, amount)
    values ('訂金', '__chk196__', '約束測試', 1000);
  exception when check_violation then ok := true;
  end;
  insert into _chk196 values ('類別填「訂金」',
    case when ok then '✅ 擋下來了' else '⚠ 存進去了 —— 分類會長出第三種值' end);

  -- ⑤ 合法的資料要**存得進去**。只擋不放行的約束一樣是壞的
  ok := false;
  begin
    insert into public.advance_payments
      (category, counterparty, usage, amount, paid_on, refunded_on, refunded_amount)
    values ('保證金', '__chk196__', '約束測試', 1000, '2026-01-01', '2026-02-01', 800);
    ok := true;
  exception when others then ok := false;
  end;
  insert into _chk196 values ('★ 合法的部分退（付 1000 收回 800）',
    case when ok then '✅ 存得進去' else '⚠⚠ 存不進去 —— 約束把正常資料也擋了' end);
end $$;

-- ★ 清掉測試資料。用標記找，不靠 id
delete from public.advance_payments where counterparty = '__chk196__';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('196_advance_payments');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。
-- ★ 基準值不依賴這支改的東西：第 5 列數的是既有資料的筆數，
--   而這支一列都不建（migration_187／191 踩過）。
-- ★ 檢查要涵蓋既有資料的**所有合法形狀** —— 194 那次沒做到，
--   6 筆正常資料被誤報，真警報差點被淹掉（2026-09-01 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① advance_payments 建好了',
         (select case when count(*) >= 15
                      then '✅ ' || count(*) || ' 個欄位'
                      else '⚠ 只有 ' || count(*) || ' 個欄位' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'advance_payments'),
         '應該有 17 個'

  union all
  /*
   * ★★★ 四道約束是這張表的骨架。少一道就會長出一種
   *   「畫面上分不出是哪種狀態」的資料，而那種資料不會報錯。
   */
  select 2, '★★★ ② 四道約束都在',
         (select case when count(*) = 5
                      then '✅ 五道全在（類別／金額／收回範圍／日期金額成對／收回不早於出款）'
                      else '⚠ 只有 ' || count(*) || ' 道：'
                           || coalesce(string_agg(conname, '、' order by conname), '（一道都沒有）') end
            from pg_constraint
           where conrelid = 'public.advance_payments'::regclass
             and conname like 'ap_%_chk'),
         '★ 「日期金額成對」那道最容易漏 —— 少了它會出現'
           || '「有收回日但沒金額」的列，而狀態要據此判斷，兩個標籤都不對'

  union all
  select 3, '③ 請款單項目多了 advance_category',
         (select case when count(*) = 1
                      then '✅ 欄位存在，'
                           || (select count(*) from public.purchase_request_items
                                where advance_category is not null)::text
                           || ' 個項目有值（剛建好應為 0）'
                      else '⚠ 欄位不存在' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'purchase_request_items'
             and column_name = 'advance_category'),
         '★ 這支不填任何值 —— 既有的請款單行為一個字都不變'

  union all
  select 4, '★★★ ④ 約束真的會擋（實際插了五筆測試）',
         (select string_agg(item || '：' || result, E'\n') from _chk196),
         '★ 只查「約束存不存在」不夠 —— migration_174 那次索引明明在但存不進去。'
           || '★ 最後一列是反向測試：只擋不放行的約束一樣是壞的'

  union all
  select 5, '⑤ 既有資料一筆都沒動',
         (select (select count(*) from public.purchase_requests)::text || ' 張請款單 ／ '
                 || (select count(*) from public.purchase_request_items)::text || ' 個項目 ／ '
                 || (select count(*) from public.deposits)::text || ' 筆暫收 ／ '
                 || (select count(*) from public.expenses)::text || ' 筆支出'),
         '★ 這支只建一張新表與一個欄位。暫收應該還是 108 筆'

  union all
  select 6, '⑥ 暫付現在有幾筆',
         (select count(*)::text || ' 筆' from public.advance_payments),
         '剛建好一定是 0'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
