/*
 * migration_202 —— 請款單勾「暫支款」→ 出款後進暫付，不記支出
 * ============================================================
 * 2026-09-02 使用者指定的九步:
 *
 *   1 照常填請款單 → 2 下方一個「暫支款」勾 → 3 勾了變暫支 → 4 未出款
 *   → 5 審核過 → 6 填待出款日期與帳戶 → 7 確認 → 8 已出款
 *   → 9 點收款；短收的差額可選會計科目，記成支出
 *
 * ★★ 第 4、5、6、8 步**一個字都不用改** —— 請款單本來就有
 *   status / planned_transfer_on / payout_account / purchased_on。
 *   真正要動的只有第 7 步那個岔路。
 *
 * ============================================================
 * 【三個使用者後來補的條件】
 *
 *   · 勾在**整張單**，不是每個項目（migration_196 建錯層了，這支搬過來）
 *   · 類別要有「**其他**」
 *   · 收回時錢要**回到原出款帳戶**
 *     → `paid_account` 從 `payout_account` 帶過去，
 *       收款抽屜再拿它當 `refund_account` 的預設值（前端做，這支只負責存對）
 *
 * ============================================================
 * 【★★★ 為什麼敢動 gen_expenses_from_pr】
 *
 * 因為這次**先看了線上的原始碼**，不是照 `schema-baseline.sql` 猜。
 * 而那兩份是不一樣的:
 *
 *   baseline 的版本    有一段「只改日期:同步既有支出」的 elsif
 *   線上的版本         沒有，而且寫著「【刻意沒有 elsif】出款日填了就不能改」
 *
 * ★ 照 baseline 改的話，我會把一段**已經被刻意拿掉**的邏輯加回去 ——
 *   出款日就又變成可以改的了，而沒有人會發現規則鬆掉
 *   （CLAUDE.md:「schema-baseline.sql 不等於線上」，2026-09-02 剛加的那條）。
 *
 * ★★ 下面的函式本體除了新增的 if／else 之外，**逐字照抄線上版本** ——
 *   憑證那段 case、on conflict、sync_pr_fee_expense 全部原封不動。
 *
 * ============================================================
 * 【手續費不跟著岔開】
 *
 * 不內扣的郵電費照舊產生（`sync_pr_fee_expense` 那一行沒動）。
 * ★ 手續費是**真的花掉的錢，不會收回來** —— 它不是暫支。
 *   跟著一起不記支出的話，那筆郵電費就從此消失。
 */

-- ══════════════════════════════════════════════════════════
-- ① 勾選欄位搬到單頭
-- ══════════════════════════════════════════════════════════
alter table public.purchase_requests
  add column if not exists advance_category text,
  add column if not exists advance_usage    text;

comment on column public.purchase_requests.advance_category is
  '暫支款類別:押金／保證金／其他（migration_202）。null = 一般請款，行為完全不變。'
  '★★★ 有值的話，確認出款時**不產生支出**，改在 advance_payments 建一列 —— '
  '那筆錢是暫時放在別人那裡的資產，不是花掉的錢。';
comment on column public.purchase_requests.advance_usage is
  '暫支款的用途（migration_202）。收回時要靠它認出這是哪一筆，所以勾了就必填。';

do $do$ begin
  begin
    alter table public.purchase_requests
      add constraint pr_advance_category_chk
      check (advance_category is null
          or advance_category in ('押金', '保證金', '其他'));
  exception when duplicate_object then null; end;
  begin
    -- ★ 勾了就一定要有用途。少了它 advance_payments.usage 是 not null 會插不進去，
    --   而那個錯誤會在使用者按「確認出款」時才爆出來 —— 太晚了
    alter table public.purchase_requests
      add constraint pr_advance_usage_chk
      check (advance_category is null or coalesce(advance_usage, '') <> '');
  exception when duplicate_object then null; end;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ② 拆掉項目層那個沒用過的欄位
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ migration_196 把 advance_category 建在 `purchase_request_items` 上，
 *   但使用者要的是整張單一個勾。**兩層都留著就是同一件事有兩個答案** ——
 *   而畫面上只會顯示其中一個（CLAUDE.md:「一份資料存在兩個地方」）。
 *
 * ★ 敢刪是因為它從來沒被寫過:前端全站 grep 不到 `advance_category`
 *   （2026-09-02 查過），所以全部是 null。下面還是先數一次再刪 ——
 *   數出來不是 0 就中止，不猜。
 */
do $do$
declare n int;
 begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public'
                and table_name = 'purchase_request_items'
                and column_name = 'advance_category') then
    execute 'select count(*) from public.purchase_request_items where advance_category is not null'
       into n;
    if n > 0 then
      raise exception '項目層的 advance_category 有 % 列是有值的 —— 中止，先把它們搬到單頭再說', n;
    end if;
    alter table public.purchase_request_items drop column advance_category;
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ③ advance_payments：改掛單頭、放寬類別
-- ══════════════════════════════════════════════════════════
alter table public.advance_payments
  add column if not exists request_id uuid references public.purchase_requests(id) on delete set null;

comment on column public.advance_payments.request_id is
  '從哪張請款單出去的（migration_202）。null = 手動建的。'
  '★ on delete set null 不是 cascade —— 請款單被刪不代表那筆錢沒付出去。'
  '連著刪的話一筆還在外面的 200,000 會安靜消失。';

do $do$ begin
  -- ★ 同一張請款單只能長出一列暫付。沒有這條的話，觸發器萬一被重跑
  --   就是第二列 —— 而畫面上看起來只是「多了一筆暫付」
  begin
    create unique index ap_request_uniq on public.advance_payments (request_id)
      where request_id is not null;
  exception when duplicate_table then null; end;

  -- 類別放寬到「其他」（2026-09-02 使用者:「類別有其他」）
  begin
    alter table public.advance_payments drop constraint ap_category_chk;
  exception when undefined_object then null; end;
  begin
    alter table public.advance_payments
      add constraint ap_category_chk check (category in ('押金', '保證金', '其他'));
  exception when duplicate_object then null; end;

  -- 項目層的外鍵沒有用過了,拆掉（同上:不留兩條通往同一張單的路）
  begin
    alter table public.advance_payments drop column request_item_id;
  exception when undefined_column then null; end;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ④ 出款時的岔路
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 本體第一行不能是 `begin`（SQL Editor 會在那裡斷句，
 *   回 `syntax error at or near "if"`）—— 線上那版正好是，
 *   所以這裡加一個 declare 把它推下去。
 */
create or replace function public.gen_expenses_from_pr()
  returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_adv  text := new.advance_category;   -- migration_202
  v_amt  numeric;
  v_est  uuid;
 begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;
  if old.purchased_on is null then
    if v_adv is null then
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
           -- 憑證（migration_155 / 156）。
           --
           -- 勾了共同憑證 → 整張單一個號碼（既有的 59 張都是這樣，行為不變）
           -- 沒勾         → 每個項目帶自己的
           --
           -- 舊的寫法是無條件用 new.voucher_no，旁邊還寫著
           -- 「同一張發票本來就對應多個項目」—— 那個假設在多張發票時不成立，
           -- 結果是計程車那筆的憑證號碼裡混著住宿的發票號。
           case when coalesce(new.shared_voucher, true)
                then new.voucher_no else i.voucher_no end,
           case when coalesce(new.shared_voucher, true)
                then coalesce(new.no_voucher, false)
                else coalesce(i.no_voucher, false) end,
           i.note, i.id, new.requester_id
      from public.purchase_request_items i
     where i.request_id = new.id
    on conflict (source_item_id) do nothing;
    else
      /*
       * ★★★ 暫支款:**不產生任何支出**，改在 advance_payments 建一列。
       *
       * ★ 金額用項目的加總，不用 new.total_amount ——
       *   總額是前端寫進去的快照，項目才是事實。兩者不一致時
       *   （改了項目沒重算），錯的那個會變成一筆永遠對不起來的暫付。
       *
       * ★ `i.amount` 已經是台幣（外幣放在 amount_original，
       *   對照上面支出那段的欄位對應），所以不用管匯率。
       */
      select sum(i.amount) into v_amt
        from public.purchase_request_items i where i.request_id = new.id;
      if coalesce(v_amt, 0) <= 0 then
        raise exception '暫支款的金額必須大於 0（這張單加總是 %）', coalesce(v_amt, 0);
      end if;

      /*
       * 物業:全部項目同一個才帶，混著就留 null。
       * ★ 猜一個填進去的話，那筆暫支會掛在錯的物業頭上而沒有人看得出來
       *   （CLAUDE.md:「對不上的不猜」）。
       */
      select case when count(distinct i.estate_id) = 1 then min(i.estate_id) end
        into v_est
        from public.purchase_request_items i
       where i.request_id = new.id and i.estate_id is not null;

      insert into public.advance_payments (
        request_id, category, counterparty, usage, estate_id,
        amount, paid_on, paid_account, note, created_by
      ) values (
        new.id, v_adv,
        coalesce(nullif(new.payee_company, ''), nullif(new.payee_account, ''), '（未填）'),
        new.advance_usage, v_est,
        v_amt, new.purchased_on,
        new.payout_account,             -- ★ 收回時要回到這個帳戶
        new.note, new.requester_id
      )
      on conflict do nothing;           -- ap_request_uniq:重跑不會變成兩列
    end if;
    new.expense_generated_at := now();
  end if;
  -- 【刻意沒有 elsif】出款日填了就不能改（見檔頭第 5 節）。
  -- 手續費：冪等,多呼叫不會出事。
  -- ★★ 暫支款也照樣產生 —— 手續費是真的花掉的錢,不會收回來,那不是暫支。
  perform public.sync_pr_fee_expense(new);
  return new;
end $fn$;

comment on function public.gen_expenses_from_pr() is
  '確認出款時產生支出（migration_202 加了暫支款的岔路）。'
  '★★★ 單頭勾了 advance_category 就**不產生支出**，改在 advance_payments 建一列，'
  '帶著 purchased_on 與 payout_account —— 收回時錢要回到同一個帳戶。'
  '★★ 手續費（sync_pr_fee_expense）兩種都照樣產生:那是真的花掉的錢。';


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('202_advance_from_pr');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了什麼:它一列資料都不動,
--   所以「支出筆數」與「暫付筆數」跑前跑後必須完全一樣。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 一般請款那段逐字沒變',
         (select case when d like '%on conflict (source_item_id) do nothing%'
                       and d like '%shared_voucher%'
                       and d like '%sync_pr_fee_expense%'
                      then '✅ on conflict／憑證 case／手續費 三段都在'
                      else '⚠⚠⚠ 有東西掉了 —— 一般請款的支出會產生錯' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname = 'gen_expenses_from_pr') z),
         '★★★ 這支的風險全在這裡。暫支是新功能，出錯只影響還沒用的東西；'
           || '一般請款是每天在跑的，改壞了是所有人的支出'

  union all
  select 2, '★★ ② 岔路接上了',
         (select case when d like '%advance_category%' and d like '%advance_payments%'
                      then '✅ 認得 advance_category，也會寫 advance_payments'
                      else '⚠⚠ 沒接上 —— 勾了暫支還是會產生支出' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname = 'gen_expenses_from_pr') z),
         ''

  union all
  select 3, '★★ ③ 一份資料只有一個地方',
         (select string_agg(x.line, E'\n') from (
            select case when exists (select 1 from information_schema.columns
                                      where table_schema='public' and table_name='purchase_request_items'
                                        and column_name='advance_category')
                        then '⚠ purchase_request_items.advance_category 還在'
                        else '✅ 項目層那個欄位已拆掉' end as line
            union all
            select case when exists (select 1 from information_schema.columns
                                      where table_schema='public' and table_name='advance_payments'
                                        and column_name='request_item_id')
                        then '⚠ advance_payments.request_item_id 還在'
                        else '✅ 舊外鍵已拆掉' end
            union all
            select case when exists (select 1 from information_schema.columns
                                      where table_schema='public' and table_name='purchase_requests'
                                        and column_name='advance_category')
                        then '✅ 單頭有 advance_category'
                        else '⚠⚠ 單頭沒有 —— 前端沒地方存' end
          ) x),
         '★★ 勾選狀態同時存在項目與單頭的話，畫面只會顯示其中一個，'
           || '而另一個會靜靜地決定要不要產生支出'

  union all
  select 4, '④ 類別放寬到「其他」',
         (select coalesce(pg_get_constraintdef(oid), '（找不到）')
            from pg_constraint
           where conrelid = 'public.advance_payments'::regclass
             and conname = 'ap_category_chk'),
         '★ 要看到 押金／保證金／其他 三個'

  union all
  select 5, '★★ ⑤ 一張單只能長一列暫付',
         (select case when count(*) = 1 then '✅ ap_request_uniq 在'
                      else '⚠⚠ 沒有 —— 觸發器重跑會變成兩列暫付' end
            from pg_indexes
           where schemaname = 'public' and indexname = 'ap_request_uniq'),
         '★ 手動建的那些 request_id 是 null，不受影響（Postgres 的唯一索引不管 null）'

  union all
  select 6, '★★★ ⑥ 一列資料都沒被動到',
         (select '支出 ' || (select count(*) from public.expenses)::text || ' 筆　／　'
                 || '暫付 ' || (select count(*) from public.advance_payments)::text || ' 筆　／　'
                 || '已出款請款單 ' || (select count(*) from public.purchase_requests
                                          where purchased_on is not null)::text || ' 張'),
         '★★★ 這支只改結構與函式，**不碰任何一列資料**（舊的那筆保證金'
           || '$200,000 使用者決定不動）。三個數字跑前跑後應該完全一樣'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
