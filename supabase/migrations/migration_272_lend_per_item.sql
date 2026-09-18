/*
 * migration_272_lend_per_item.sql　2026-09-18
 * 代墊暫付改成「一個項目一列」，不再是「一張請款單一列」
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_268 要先跑完（這支用它的 `advance_usage_short()`）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18：「請款單裡有的項目 要拆出來」】
 *
 *   現在（3 列）                          改成（8 列）
 *   115/7月勞保費 等 2 筆    $4,530   →   115/7月健保費        $1,428
 *                                         115/7月勞保費        $3,102
 *   115/7月電信費-0975 等 5 筆 $1,329  →  旅平險                 $261
 *                                         115/7月電信費-0975     $246
 *                                         115/8月電信費-2778     $305
 *                                         115/7月電信費-2778     $300
 *                                         115/8月電信費-0975     $217
 *   115/7-8月管理服務費      $7,350   →   115/7-8月管理服務費  $7,350
 *
 * ★★★ 為什麼要拆:這樣**一列暫付對到一筆支出，1 對 1**。
 *   愛皮還錢時收回哪一列，愛皮那邊就長出哪一筆實支。
 *   現在是 1 對多 —— 收回 $4,530 的話，那筆錢該算健保費還是勞保費？沒有答案。
 *
 * ★★ 那個「等 N 筆」是我 migration_267 寫的 —— 它在**遮一個本來就不對的聚合**。
 *   拆完之後它沒有用了（見第 ⑤ 段）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這支動了 `gen_expenses_from_pr()`，而那是有代價的】
 *
 * 我 2026-09-17 在 migration_267 明確拒絕改這支函式，理由是
 * 「我手上只有 migration_237 的版本，238～271 之間有沒有人動過我不知道」。
 *
 * ★ 這次是**先把線上那份印出來看過**才動的（2026-09-18 使用者跑的查詢）。
 *   而且印出來確實跟 237 那份**不一樣** —— 多了兩塊：
 *
 *     · `shared_voucher` 的憑證判斷（migration_155 / 156）
 *     · 結尾的 `perform public.sync_pr_fee_expense(new)`（手續費）
 *
 *   照 237 那份副本蓋回去的話，這兩塊會**安靜地消失**。
 *
 * ★★ 所以底下那一整支是**照線上那份原樣抄**，只改了「代墊」那一段。
 *   其餘每一行、每一個註解都沒動 —— 要 diff 的話就 diff 那一段。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 索引不能整條拔掉 —— 暫支款還靠它】
 *
 *   `ap_request_uniq` = unique(request_id) where request_id is not null
 *
 * 它同時在保證兩件事：
 *   · 代墊   一張單一列  ← 這個要拿掉
 *   · 暫支款 一張單一列  ← 這個是**對的**，要留著
 *
 * 所以改成 `where request_id is not null and category <> '代墊'`，
 * 另外開一條 `ap_item_uniq` 管代墊那邊（一個項目一列）。
 *
 * ★ 整條拔掉的話，暫支款那邊的 `on conflict do nothing` 就失效了 ——
 *   重跑會產生兩列暫支，而總額只是「比較大」（README:整批刪掉重建那條）。
 *
 * ══════════════════════════════════════════════════════════
 * 【回填的守衛】
 *
 *   ★ 已經收回過的**不拆** —— 那筆收回的錢要算到哪一個項目上沒有答案。
 *     碰到就整支 raise 停下來報單號。
 *   ★★ 拆之前的總額與拆之後必須一樣。不一樣就 raise。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】回填只找「還沒拆的」（`source_item_id is null`
 *   而且那張單還有別的項目），第二次跑影響 0 列。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 新欄位：這一列暫付對到哪一個項目 ══════

alter table public.advance_payments
  add column if not exists source_item_id uuid
    references public.purchase_request_items(id) on delete set null;

comment on column public.advance_payments.source_item_id is
  '代墊:這一列對到請款單的哪一個項目(migration_272,使用者:「請款單裡有的項目 要拆出來」)。'
  '★ 一個項目一列 —— 這樣「收回這一列」就對得到「哪一筆支出」,1 對 1。'
  '★★ 暫支款不用這一欄(它本來就是一張單一列)。';

-- ══════ ② 換索引 ══════

/*
 * ★ 先建新的再刪舊的?不行 —— 舊的還在的話新的代墊插不進去。
 *   但 drop 與 create 在同一個交易裡，中間沒有別人看得到的空窗。
 */
drop index if exists public.ap_request_uniq;

/* 暫支款維持「一張單一列」—— 代墊以外才管 */
create unique index if not exists ap_request_uniq
  on public.advance_payments (request_id)
  where request_id is not null and category <> '代墊';

/* 代墊:一個項目一列 */
create unique index if not exists ap_item_uniq
  on public.advance_payments (source_item_id)
  where source_item_id is not null;

-- ══════ ③ 把現有的 3 列拆成 8 列 ══════

do $do$
declare
  r        record;
  v_before numeric;
  v_after  numeric;
  v_split  int := 0;
begin
  select coalesce(sum(amount), 0) into v_before
    from public.advance_payments where category = '代墊';

  for r in
    select a.id, a.request_id, a.for_book, a.counterparty, a.paid_on,
           a.paid_account, a.note, a.created_by, a.amount,
           coalesce(a.refunded_amount, 0) as back, pr.req_no
      from public.advance_payments a
      left join public.purchase_requests pr on pr.id = a.request_id
     where a.category = '代墊'
       and a.request_id is not null
       and a.source_item_id is null          -- ★ 還沒拆的
  loop
    /*
     * ★★★ 已經收回過的不拆。那筆錢該算到哪一個項目上沒有答案 ——
     *   平均分？照比例？兩種都是猜，而猜錯不會有人發現。
     */
    if r.back > 0 then
      raise exception
        '% 停下來：這一列已經收回過 $%，拆的話那筆錢要算到哪一個項目上沒有答案。'
        '先跟人確認怎麼分，再手動處理這一列。', coalesce(r.req_no, r.id::text), r.back;
    end if;

    /* 一個項目一列。★ 金額 0 或負的不建 —— 沒有錢要墊 */
    insert into public.advance_payments (
      request_id, source_item_id, category, for_book, counterparty, usage, estate_id,
      amount, paid_on, paid_account, note, created_by
    )
    select r.request_id, i.id, '代墊', r.for_book, r.counterparty,
           coalesce(public.advance_usage_short(i.item_name), '（沒有項目名稱）'),
           null,
           i.amount, r.paid_on, r.paid_account, r.note, r.created_by
      from public.purchase_request_items i
     where i.request_id = r.request_id
       and coalesce(i.amount, 0) > 0
    on conflict do nothing;

    /*
     * 支出接到自己那一列暫付上。
     * ★ 照 `source_item_id` 對 —— 那是支出與項目之間本來就有的鍵。
     */
    update public.expenses e
       set advance_id = ap.id
      from public.advance_payments ap
     where ap.source_item_id = e.source_item_id
       and ap.category = '代墊'
       and e.request_id = r.request_id;

    /* 舊的那一列聚合暫付拿掉 */
    delete from public.advance_payments where id = r.id;

    v_split := v_split + 1;
    raise notice '% 拆好了（$% → % 個項目）', coalesce(r.req_no, '?'), r.amount,
      (select count(*) from public.purchase_request_items i
        where i.request_id = r.request_id and coalesce(i.amount, 0) > 0);
  end loop;

  /*
   * ★★★ 拆之前跟拆之後總額必須一樣。
   *   不一樣代表有項目的金額是 0／負的（沒建）、或有項目被刪過 ——
   *   兩種我都不知道正確答案是什麼，**停下來報數字**。
   */
  select coalesce(sum(amount), 0) into v_after
    from public.advance_payments where category = '代墊';

  if round(v_before) <> round(v_after) then
    raise exception
      '停下來：拆之前代墊合計 $%，拆之後 $%，差 $%。'
      '多半是有項目的金額是 0 或負數（那種不建暫付）—— 先查清楚再拆。',
      round(v_before), round(v_after), round(v_before - v_after);
  end if;

  if v_split = 0 then
    raise notice '沒有要拆的 —— 可能已經跑過了（這支是冪等的）';
  end if;
end $do$;

-- ══════ ④ 產生端改成一個項目一列 ══════
/*
 * ★★★ 這一整支是**照線上那份原樣抄**（2026-09-18 從 pg_get_functiondef 印出來的），
 *   只改「代墊」那一段。其餘每一行、每一個註解都沒動。
 *
 *   ★ 特別留意兩塊**不要弄掉**（237 那份副本裡沒有它們）：
 *     · `shared_voucher` 的憑證判斷
 *     · 結尾的 `perform public.sync_pr_fee_expense(new)`
 */
CREATE OR REPLACE FUNCTION public.gen_expenses_from_pr()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_adv  text := new.advance_category;   -- migration_202
  v_amt  numeric;
  v_est  uuid;
  v_book text := coalesce(new.book, 'anxing');
  v_lend text := new.advance_for_book;   -- migration_236：安幸代墊給哪一本帳
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;
  if old.purchased_on is null then

    /*
     * ★★ 兩種特殊走法互斥。同時設的話語意矛盾:
     *   暫支款＝這筆錢本來就要收回來、不產生支出;
     *   代墊＝產生別本帳的支出，安幸這邊記一筆應收。
     */
    if v_adv is not null and v_lend is not null then
      raise exception '一張單不能同時是暫支款與安幸代墊（暫支=%，代墊給=%）', v_adv, v_lend;
    end if;
    if v_lend is not null and v_lend <> v_book then
      raise exception '代墊的帳本對不起來：這張單是 %，卻要代墊給 %。兩者必須一致', v_book, v_lend;
    end if;

    /*
     * ★★★ 代墊:先建暫付，再產生支出並指回去。
     *   順序不能倒 —— 支出要帶 advance_id。
     *
     * ★★★ migration_272:**一個項目一列**，不再是一張單一列。
     *   這樣「收回這一列」就對得到「哪一筆支出」。
     *   聚合成一列的話，收回 $4,530 要算健保費還是勞保費沒有答案。
     */
    if v_lend is not null then
      select sum(i.amount) into v_amt
        from public.purchase_request_items i where i.request_id = new.id;
      if coalesce(v_amt, 0) <= 0 then
        raise exception '代墊的金額必須大於 0（這張單加總是 %）', coalesce(v_amt, 0);
      end if;

      insert into public.advance_payments (
        request_id, source_item_id, category, for_book, counterparty, usage, estate_id,
        amount, paid_on, paid_account, note, created_by
      )
      select new.id, i.id, '代墊', v_lend,
             -- ★ 對象是「要還錢的人」，不是廠商 —— 廠商已經收到錢了
             case v_lend when 'aipi' then '愛皮' when 'hongsha' then '洪鯊' else v_lend end,
             /*
              * ★ 項目名稱直接當「項目」欄。人在請款單上手填的用途優先
              *   —— 那是人寫的字（跟 migration_267 同一條規則）。
              */
             coalesce(nullif(new.advance_usage, ''),
                      public.advance_usage_short(i.item_name),
                      '代墊請款單 ' || new.req_no),
             null,                              -- ★ 代墊不掛物業:費用在別本帳上
             i.amount, new.purchased_on,
             new.payout_account,                -- ★ 收回時要回到這個帳戶
             new.note, new.requester_id
        from public.purchase_request_items i
       where i.request_id = new.id
         and coalesce(i.amount, 0) > 0
      on conflict do nothing;              -- ap_item_uniq:重跑不會變成兩列
    end if;

    if v_adv is null then
    -- 第一次確認出款 → 產生項目支出
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, estate_id, property_id,
      payment_method, pay_account, voucher_no, no_voucher,
      note, source_item_id, created_by,
      book, advance_id                     -- ★ migration_237 新增
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
           i.note, i.id, new.requester_id,
           /*
            * ★★★ 帳本要跟著這張單走（migration_237 修）。
            *   不帶的話吃預設值 `anxing` —— 愛皮的單會產生安幸的支出,
            *   而科目通用時**什麼事都不會發生**，錢靜靜記到錯的帳本上。
            */
           v_book,
           /*
            * ★★★ migration_272:每一筆支出接到**自己那一項**的暫付，
            *   不是整張單共用一個 v_ap。照 source_item_id 對。
            */
           case when v_lend is null then null
                else (select ap.id from public.advance_payments ap
                       where ap.source_item_id = i.id and ap.category = '代墊'
                       limit 1) end
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
       *
       * ★★ 暫支款維持**一張單一列** —— 那是對的，沒有改。
       *   它靠的是 `ap_request_uniq`（migration_272 之後條件多了
       *   `and category <> '代墊'`，對暫支款來說行為完全不變）。
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
end $function$;

-- ══════ ⑤ 拿掉 267 的「等 N 筆」 ══════
/*
 * ★★ 一列一個項目之後，那支聚合函式與它的觸發器就沒有用了。
 *   留著更糟:它認 `代墊請款單 %` 這個樣子，哪天有人手動插一列
 *   長那樣的，它會把它改寫成「第一項 等 N 筆」—— 而那是錯的了。
 *
 * ★ `advance_usage_short()` **留著** —— 上面那支函式還在用它截項目名稱。
 */
drop trigger if exists trg_ap_usage_from_items on public.advance_payments;
drop function if exists public.ap_usage_from_items();
drop function if exists public.advance_usage_from_items(uuid);

comment on column public.advance_payments.usage is
  '這筆暫付是在做什麼(畫面上「項目」那一欄)。'
  '★ 代墊:寫**那一個項目的名稱**(migration_272 起一個項目一列)。'
  '人在請款單上手填的「用途」優先。'
  '★★ migration_267 那支把整張單濃縮成「第一項 等 N 筆」的觸發器已經拿掉 ——'
  '那個聚合本身就是要修的東西。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('272_lend_per_item');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with lend as (
  select a.id, a.request_id, a.source_item_id, a.usage, a.amount::int as amt,
         a.counterparty, coalesce(a.refunded_amount, 0)::int as back
    from public.advance_payments a where a.category = '代墊'
),
ex as (
  select e.id, e.advance_id, e.source_item_id, abs(e.amount)::int as amt, e.item_name
    from public.expenses e
   where e.request_id in (select request_id from lend where request_id is not null)
),
idx as (
  select i.relname::text as name, pg_get_indexdef(x.indexrelid)::text as def
    from pg_index x join pg_class i on i.oid = x.indexrelid
   where x.indrelid = 'public.advance_payments'::regclass and x.indisunique
),
fn as (
  select pg_get_functiondef(p.oid)::text as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gen_expenses_from_pr'
     and p.prokind in ('f','p')          -- ★ 聚合函式會炸（README 2026-09-01）
   limit 1
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 272) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 母體：代墊暫付' as "檢查",
         (select count(*)::text from lend) || ' 列　$'
         || coalesce((select sum(amt)::text from lend), '0') as "結果",
         case when (select count(*) from lend) = 0
              then '⚠ **一列都沒有 —— 下面全部不算數**'
              else '參考 —— 第 ②③ 列在判它' end as "判定"

  union all
  /*
   * ★★★ 這一列是這支的目的:**每一列都要對到一個項目**。
   *   還有 source_item_id 是空的 → 那一列還是聚合的。
   */
  select 2, '② 還有沒有沒拆開的',
         (select count(*) filter (where source_item_id is null) from lend)::text || ' 列沒對到項目',
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend where source_item_id is null)
              then '❌ 還有聚合的 —— 看它是被哪一道守衛擋下來（已收回過的不拆）'
              else '✅ 每一列都對到一個項目' end

  union all
  /*
   * ★★★ 只問「拆開了」不夠 —— 換成什麼要看得到。
   */
  select 3, '③ 現在長什麼樣',
         coalesce((select string_agg(coalesce(usage, '（空白）') || '　$' || amt,
                                     E'\n' order by amt desc, usage) from lend), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend where coalesce(usage, '') like '%等 % 筆')
              then '❌ 還有寫著「等 N 筆」的 —— 那是聚合的殘留'
              when exists (select 1 from lend where coalesce(btrim(usage), '') = '')
              then '❌ 有空白的'
              else '✅ 每一列都是一個項目的名稱' end

  union all
  /*
   * ★★★ 1 對 1。一列暫付對一筆支出 —— 這正是拆的理由。
   */
  select 4, '④ 暫付與支出是不是 1 對 1',
         '代墊 ' || (select count(*) from lend)::text || ' 列　│ 接到暫付的支出 '
         || (select count(*) filter (where advance_id is not null) from ex)::text || ' 筆'
         || '　│ 一列被多筆支出共用的 '
         || (select count(*) from (select advance_id from ex
                                    where advance_id is not null
                                    group by advance_id having count(*) > 1) d)::text || ' 列',
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from (select advance_id from ex
                                           where advance_id is not null
                                           group by advance_id having count(*) > 1) d)
              then '❌ 有一列暫付被好幾筆支出共用 —— 那就是還沒拆乾淨'
              when (select count(*) filter (where advance_id is not null) from ex)
                 <> (select count(*) from lend)
              then '⚠ 兩邊筆數不一樣 —— 多半是手續費那種不從項目長出來的支出（正常），'
                   || '或有項目金額是 0（不建暫付）。看第 ⑤ 列的總額'
              else '✅ 1 對 1' end

  union all
  /*
   * ★★★ 拆之前的基準是 $13,209（2026-09-18 拆之前查到的）。
   *   ★ 但**不要寫死那個數字** —— 寫死的話之後有人新增代墊，這一列就開始說謊。
   *     改成問「暫付合計 vs 那幾張單的項目合計」，兩個都會一起長。
   */
  select 5, '⑤ 暫付合計 vs 項目合計',
         '代墊合計 $' || coalesce((select sum(amt)::text from lend), '0')
         || '　│ 那幾張單的項目合計 $'
         || coalesce((select sum(i.amount)::bigint::text
                        from public.purchase_request_items i
                       where i.request_id in (select request_id from lend where request_id is not null)
                         and coalesce(i.amount, 0) > 0), '0'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when coalesce((select sum(amt) from lend), 0)
                 = coalesce((select sum(i.amount) from public.purchase_request_items i
                              where i.request_id in (select request_id from lend where request_id is not null)
                                and coalesce(i.amount, 0) > 0), 0)
              then '✅ 一樣 —— 拆完總額沒變'
              else '❌ 對不上 —— 拆的過程漏了或多了，要查' end

  union all
  /*
   * ★★★ 索引。暫支款那條**必須還在**，不然它的 on conflict 失效、
   *   重跑會產生兩列暫支（而總額只是「比較大」）。
   */
  select 6, '⑥ 索引換對了嗎',
         coalesce((select string_agg(name, E'\n' order by name) from idx), '（一條都沒有）'),
         case when not exists (select 1 from idx where name = 'ap_item_uniq')
              then '❌ 少了 ap_item_uniq —— 代墊重跑會產生重複的列'
              when not exists (select 1 from idx where name = 'ap_request_uniq'
                                 and def ~ '\m代墊\M')
              then '❌ ap_request_uniq 不見了或沒帶「代墊以外」的條件 ——'
                   || '**暫支款的重複防護破了**'
              else '✅ 兩條都在:暫支款一張單一列、代墊一個項目一列' end

  union all
  /*
   * ★★★ 換函式最怕的是把別人的東西蓋掉。
   *   這一列去讀線上那份，確認那兩塊還在。
   */
  select 7, '⑦ 換函式有沒有弄掉別人的東西',
         case when not exists (select 1 from fn) then '★ 找不到函式'
              else (case when (select src from fn) ~ '\mshared_voucher\M'
                         then '憑證判斷 ✅' else '憑證判斷 ❌' end)
                   || '　'
                   || (case when (select src from fn) ~ '\msync_pr_fee_expense\M'
                            then '手續費 ✅' else '手續費 ❌' end)
                   || '　'
                   || (case when (select src from fn) ~ '\msource_item_id\M'
                            then '一項一列 ✅' else '一項一列 ❌' end)
         end,
         case when not exists (select 1 from fn) then '❌ 找不到函式'
              when (select src from fn) !~ '\mshared_voucher\M'
              then '❌ **憑證判斷被蓋掉了**（migration_155/156）—— 要還原'
              when (select src from fn) !~ '\msync_pr_fee_expense\M'
              then '❌ **手續費那一行被蓋掉了** —— 要還原'
              else '✅ 兩塊都在，而且代墊改成一項一列了' end

  union all
  select 8, '⑧ 267 的聚合觸發器拿掉了嗎',
         case when exists (select 1 from pg_trigger t
                            where t.tgrelid = 'public.advance_payments'::regclass
                              and t.tgname = 'trg_ap_usage_from_items' and not t.tgisinternal)
              then '還在' else '拿掉了' end
         || '　│ advance_usage_short（還要用）'
         || case when to_regprocedure('public.advance_usage_short(text)') is not null
                 then ' ✅' else ' ❌' end,
         case when exists (select 1 from pg_trigger t
                            where t.tgrelid = 'public.advance_payments'::regclass
                              and t.tgname = 'trg_ap_usage_from_items' and not t.tgisinternal)
              then '❌ 還在 —— 它會把新的一項一列改寫回「等 N 筆」'
              when to_regprocedure('public.advance_usage_short(text)') is null
              then '❌ 截字函式不見了 —— 上面那支函式呼叫它會炸'
              else '✅ 聚合的拿掉了，截字的留著' end

  union all
  select 9, '⑨ 200～272 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 10, '⑩ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '272_lend_per_item'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '272_lend_per_item')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
