/*
 * migration_237 —— 請款單產生支出時帶上帳本；新增「安幸代墊」
 * ============================================================
 * 2026-09-09。
 *
 * ============================================================
 * 【★★★ 這支修的 bug：帳本沒有被帶過去】
 *
 * `gen_expenses_from_pr()` 產生支出時列了 17 個欄位，**沒有 `book`**。
 * 而 `expenses.book` 的預設值是 `'anxing'`。
 *
 * 所以任何非安幸的請款單，產生的支出都會落在安幸帳上:
 *
 *   科目是愛皮專屬的（如 `ap_insurance`）
 *     → `trg_expenses_book_code` 擋下來，使用者看到
 *       「會計科目不屬於這一本帳」而不知道為什麼（2026-09-09 撞到）
 *
 *   科目是通用的
 *     → **什麼事都不會發生**。一筆愛皮的費用靜靜記進安幸的帳，
 *       而兩本帳的數字都看起來很合理。線上已經有 1 筆。
 *
 * ★★★ 守衛只在科目綁帳本時才會叫 —— 被擋下來的那些反而是幸運的。
 *
 * ============================================================
 * 【★★ 新增的第三條路：安幸代墊】
 *
 * 原本的邏輯是**二選一**（第 16 / 46 行）:
 *     advance_category 是 null → 只產生支出
 *     advance_category 有值    → 只建一筆暫付，不產生任何支出
 *
 * 而「安幸替愛皮墊錢」需要**兩邊都要**:
 *
 *     安幸   暫付款（資產）  類別=代墊  for_book=aipi   ← 不記費用
 *     愛皮   支出           book=aipi                  ← 費用記這裡
 *                            ↑ advance_id 指回那筆暫付
 *     還款   暫付收回（逐筆，用現有的收回流程）          ← 不記收入
 *
 * ★ 會計立場跟既有的暫付一致（`lib/advance.ts` 檔頭，2026-09-01 使用者選的）:
 *   出款不記費用、收回不記收入。
 *
 * ★★ `advance_for_book` 必須等於 `book` —— 兩個欄位講同一件事,
 *   不一致的話「費用記在哪本」跟「誰要還錢」會指向不同的公司。
 *   底下直接 raise，不猜。
 *
 * ============================================================
 * 【★★★ 這支是整份重寫函式的，第 1~93 行一字不差再加東西】
 *
 * 抄漏任何一段都不會報錯:憑證那段抄漏 → 計程車的憑證號碼裡混著住宿的發票號;
 * 手續費那行抄漏 → 手續費從此不產生。自檢第 ②③ 條逐段釘住。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

create or replace function public.gen_expenses_from_pr()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_adv  text := new.advance_category;   -- migration_202
  v_amt  numeric;
  v_est  uuid;
  v_book text := coalesce(new.book, 'anxing');
  v_lend text := new.advance_for_book;   -- migration_236：安幸代墊給哪一本帳
  v_ap   uuid;
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
     */
    if v_lend is not null then
      select sum(i.amount) into v_amt
        from public.purchase_request_items i where i.request_id = new.id;
      if coalesce(v_amt, 0) <= 0 then
        raise exception '代墊的金額必須大於 0（這張單加總是 %）', coalesce(v_amt, 0);
      end if;

      insert into public.advance_payments (
        request_id, category, for_book, counterparty, usage, estate_id,
        amount, paid_on, paid_account, note, created_by
      ) values (
        new.id, '代墊', v_lend,
        -- ★ 對象是「要還錢的人」，不是廠商 —— 廠商已經收到錢了
        case v_lend when 'aipi' then '愛皮' when 'hongsha' then '洪鯊' else v_lend end,
        coalesce(nullif(new.advance_usage, ''), '代墊請款單 ' || new.req_no),
        null,                              -- ★ 代墊不掛物業:費用在別本帳上
        v_amt, new.purchased_on,
        new.payout_account,                -- ★ 收回時要回到這個帳戶
        new.note, new.requester_id
      )
      on conflict do nothing;              -- ap_request_uniq:重跑不會變成兩列

      select id into v_ap from public.advance_payments where request_id = new.id;
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
           v_ap                            -- ★ 代墊才有值，其餘是 null
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
end $function$;

/*
 * ── 修既有那筆記錯帳本的支出 ────────────────────────
 *
 * ★★ 只修**科目對得起來**的那些。科目是安幸的、帳本要改成愛皮的話，
 *   `trg_expenses_book_code` 會擋下來而整支回滾 ——
 *   那種要人去看是科目填錯還是單填錯，不能自動猜。
 */
do $do$
declare n_fix int; n_skip int;
begin
  with bad as (
    select e.id, coalesce(r.book,'anxing') as want, e.account_code
      from public.expenses e
      join public.purchase_request_items i on i.id = e.source_item_id
      join public.purchase_requests r on r.id = i.request_id
     where coalesce(r.book,'anxing') <> coalesce(e.book,'anxing')
  ), ok as (
    select b.id, b.want from bad b
     left join public.account_codes c on c.code = b.account_code
     where b.account_code is null or coalesce(c.book,'anxing') = b.want
  )
  update public.expenses e set book = o.want from ok o where e.id = o.id;
  get diagnostics n_fix = row_count;

  select count(*) into n_skip
    from public.expenses e
    join public.purchase_request_items i on i.id = e.source_item_id
    join public.purchase_requests r on r.id = i.request_id
   where coalesce(r.book,'anxing') <> coalesce(e.book,'anxing');

  raise notice '帳本修好 % 筆，還有 % 筆要人工看（科目跟目標帳本對不起來）', n_fix, n_skip;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('237_pr_book_and_advance');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢　★ 字串比對一律 ilike
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 支出的 insert 現在有帶 book',
         case when (select prosrc from pg_proc where proname='gen_expenses_from_pr') ilike '%v_book%'
              then '有' else '沒有' end,
         case when (select prosrc from pg_proc where proname='gen_expenses_from_pr') ilike '%v_book%'
              then '✅ 過' else '❌ 沒改到' end

  union all
  /*
   * ★★★ 母體判定:既有的三段邏輯一段都不能掉。
   *   抄漏憑證那段 → 計程車的憑證號碼裡混著住宿的發票號;
   *   抄漏手續費那行 → 手續費從此不產生。兩種都不會報錯。
   */
  select 2, '②★★★ 既有三段都還在（憑證、暫支款、手續費）',
         (select string_agg(x, '　') from (values
            ('共同憑證', '%shared_voucher%'),
            ('暫支款',   '%暫支款的金額必須大於%'),
            ('手續費',   '%sync_pr_fee_expense%')
          ) t(x, pat)
          where (select prosrc from pg_proc where proname='gen_expenses_from_pr') ilike t.pat),
         case when (select count(*) from (values
                      ('%shared_voucher%'), ('%暫支款的金額必須大於%'), ('%sync_pr_fee_expense%')
                    ) t(pat)
                    where (select prosrc from pg_proc where proname='gen_expenses_from_pr') ilike t.pat) = 3
              then '✅ 三段都在'
              else '❌ 有段落被抄漏 —— 立刻回頭比對，這些都不會報錯' end

  union all
  select 3, '③ 新增的代墊分支在不在',
         case when (select prosrc from pg_proc where proname='gen_expenses_from_pr')
                   ilike '%advance_for_book%' then '在' else '不在' end,
         case when (select prosrc from pg_proc where proname='gen_expenses_from_pr')
                   ilike '%advance_for_book%' then '✅' else '❌' end

  union all
  select 4, '④★★★ 還有幾筆「單的帳本 ≠ 支出的帳本」',
         (select count(*)::text || ' 筆'
            from public.expenses e
            join public.purchase_request_items i on i.id = e.source_item_id
            join public.purchase_requests r on r.id = i.request_id
           where coalesce(r.book,'anxing') <> coalesce(e.book,'anxing')),
         case when (select count(*) from public.expenses e
                      join public.purchase_request_items i on i.id = e.source_item_id
                      join public.purchase_requests r on r.id = i.request_id
                     where coalesce(r.book,'anxing') <> coalesce(e.book,'anxing')) = 0
              then '✅ 修乾淨了'
              else '⚠ 還有 —— 那幾筆的科目跟目標帳本對不起來，要人工看' end

  union all
  select 5, '⑤ 請款產生的支出，帳本分布（改之前全是 anxing）',
         coalesce((select string_agg(coalesce(book,'(null)') || '×' || n::text, '　' order by 1)
                     from (select book, count(*) n from public.expenses
                            where source_item_id is not null group by book) g), '（沒有）'),
         '👀 愛皮那 3 張單產生支出之後，這裡才會出現 aipi'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '237_pr_book_and_advance'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '237_pr_book_and_advance')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
