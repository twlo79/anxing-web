/*
 * migration_285_lend_by_account.sql　2026-09-21
 * 代墊改成「看付款帳戶屬於哪一本帳」判定，不再靠請款單上那個勾
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *            自檢在 commit 後面，成功就一定看得到。把錯誤訊息整段貼回來。
 *          ★★ **migration_284 要先跑完**（這一支讀它加的 payment_accounts.book）。
 *             沒跑的話第 ① 步會擋下來，一個字都不會改。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-21】
 *   「請款單 如果是用安幸的帳戶 就是代墊，不然不是，是愛皮 洪鯊變實支」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 查出來的事實，這一支是建立在它們上面的】
 *
 *   ① 事業體**不在項目那一層** —— `purchase_request_items` 的
 *      `purpose_type = 'other_biz'` 只說「這一項算其他事業體的」，
 *      **哪一個**事業體由整張單的 `purchase_requests.book` 決定
 *      （查-其他事業體存在哪一欄.sql:other_biz 的列上沒有任何 uuid 有值；
 *       有 other_biz 項目的 3 張單 header 都是 aipi）。
 *
 *      → 所以「一張單不可以跨事業體」**結構上本來就成立**，不用加守衛。
 *
 *   ② 現有 8 筆代墊全部是用安幸的帳戶付的（8088 一筆、安幸現金七筆）。
 *      → 新舊規則對同一批資料給出同一個答案。
 *
 *   ③ 4195（愛皮）與 1624（洪鯊）一筆交易都沒用過。
 *
 * ══════════════════════════════════════════════════════════
 * 【新的判定 —— 只有一份定義:`public.lend_book_for()`】
 *
 *     這張單的帳本      coalesce(purchase_requests.book, 'anxing')
 *     付款帳戶的帳本    payment_accounts.book（284 加的）
 *
 *     兩個一樣   → 不是代墊（自己的錢付自己的帳，直接就是支出）
 *     不一樣     → 代墊，代墊給「這張單的帳本」
 *
 * ★★★ 規則寫成一支函式，**觸發器與閘門都呼叫它**。
 *   兩邊各寫一次的話，改了一邊另一邊會安靜地留在舊規則上
 *   （README 坑 A;262 的帳密權限就是這樣修的）。
 *   自檢第 ⑧ 列證明判斷式真的走那一支。
 *
 * ★★ 只支援「安幸的戶頭付別人的帳」。
 *   愛皮的戶頭付洪鯊的帳這種組合**擋下來報錯** ——
 *   `advance_payments` 那一頁是安幸的暫付，沒有地方放「洪鯊欠愛皮」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 沒填付款帳戶怎麼辦 —— 2026-09-21 查過才決定的】
 *
 * 查出來的現況（查-付款帳戶查不到的那幾張單.sql）:
 *   · 只有 **2 張**單的付款帳戶是空的:PR-202609-006 / 007
 *   · 兩張都**已出款**、都是**現金**、帳本都是 **anxing**
 *   · **沒有**任何一張是「填了一個查不到的代號」
 *
 * 所以規則是:
 *
 *   單的帳本是 anxing ＋ 沒填帳戶  → **不是代墊**（放行）
 *   單的帳本不是 anxing ＋ 沒填帳戶 → **擋下來**
 *
 * ★ 為什麼這樣切:代墊一定是「安幸的戶頭付**別本帳**」。
 *   單本身就是安幸的話，不管錢從哪個戶頭出，結論最多只有
 *   「別人代墊安幸」—— 那個情境系統不支援，也從沒發生過，
 *   所以判成非代墊是安全的，而且跟那 2 張現有資料一致。
 *   單是愛皮／洪鯊的話就真的判不出來，**不猜**（CLAUDE.md）。
 *
 * ★★ 這樣切的好處:現金付款不選帳戶這條日常路徑**不會被擋**。
 *   一律 raise 的話，明天起每一張這種單在「確認出款」那一刻都存不了 ——
 *   那比現在的問題嚴重得多。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 跑之前先拿新規則重算一次舊資料】
 *
 * 第 ② 步把**每一張已出款的單**用新規則算一次，跟現在存著的
 * `advance_for_book` 比。有一張不一樣就整支停下來。
 *
 * ★ 為什麼要這樣:換判定規則最危險的不是「新的算錯」，
 *   是「新舊對同一批資料給出不同答案，而沒有人發現」。
 *   那會變成同一筆錢在舊紀錄裡是代墊、在新邏輯裡不是 ——
 *   兩邊各自看起來都正常，只有相減的時候差一截（README 坑 J）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ `advance_for_book` 不刪，改成由觸發器寫】
 *
 * 它從「人勾的」變成「算出來的」。欄位留著是因為:
 *   · 舊資料靠它才看得出當初是不是代墊
 *   · `advance_payments.for_book` 與它對得起來
 * 但**不再是輸入** —— 觸發器自己算完寫回去，前端那個勾可以拿掉了
 * （畫面是另一支，這裡不動）。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 閘門：284 跑過了沒 ══════
do $do$
begin
  if to_regclass('public.payment_accounts') is null then
    raise exception 'payment_accounts 不在 —— 整支停下來沒有改任何東西。';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'payment_accounts'
       and column_name = 'book')
  then
    raise exception
      'payment_accounts 沒有 book 欄位 —— **migration_284 還沒跑**。'
      '先跑 284 再回來跑這一支。整支停下來沒有改任何東西。';
  end if;

  if to_regprocedure('public.gen_expenses_from_pr()') is null then
    raise exception 'gen_expenses_from_pr() 不在 —— 整支停下來。';
  end if;
end $do$;


-- ══════ ② 規則只有一份定義 ══════
/*
 * ★★★ 回傳值:
 *     null            不是代墊
 *     'aipi'/'hongsha'  代墊給誰
 *     '!unknown'      帳戶查不到而且判不出來（單不是安幸）
 *     '!unsupported'  不支援的組合（非安幸的戶頭付別本帳）
 *
 * ★★ 用「驚嘆號開頭的字串」當特殊值而不是丟例外:
 *   丟例外的話閘門沒辦法一次掃過所有舊單（第一筆就中斷）。
 *   觸發器收到 `!` 開頭的值才翻譯成錯誤訊息。
 */
create or replace function public.lend_book_for(p_payout_account text, p_book text)
returns text
language sql
stable
as $fn$
  select case
    when a.book is not null and a.book = coalesce(p_book, 'anxing') then null
    when a.book = 'anxing'                                          then coalesce(p_book, 'anxing')
    when a.book is not null                                         then '!unsupported'
    /* 以下:帳戶查不到（沒填，或代號不在主檔） */
    when coalesce(p_book, 'anxing') = 'anxing'                      then null
    else '!unknown'
  end
  from (select 1) z
  left join public.payment_accounts a on a.code = p_payout_account;
$fn$;

comment on function public.lend_book_for(text, text) is
  '代墊判定的**唯一一份定義**（migration_285）。'
  '拿「付款帳戶的 payment_accounts.book」跟「這張單的 book」比:'
  '一樣→null(不是代墊)、安幸付別本→代墊給那本、'
  '非安幸付別本→!unsupported、帳戶查不到且單不是安幸→!unknown。'
  '★ gen_expenses_from_pr() 與 migration_285 的閘門都呼叫它，不要另外寫第二份。';


-- ══════ ②b 拿新規則重算舊資料，對不上就停 ══════
do $do$
declare
  v_bad  text;
  v_n    int;
begin
  /*
   * ★★ 只看**已經出款**的單，而且只比「代墊給誰」這個結論。
   *
   * ★★★ `!unknown` / `!unsupported` **不算衝突**:
   *   已出款的單再也不會跑觸發器（`if old.purchased_on is null`），
   *   所以那些單的判定結果不會被重算。
   *   第一版把「算不出來」跟「算出不一樣的答案」壓成同一個數字，
   *   於是兩張現金單（沒填帳戶）把整支擋掉了 ——
   *   而它們現在存的是 null，新規則也說不是代墊，根本沒有衝突。
   *   （README:拿兩個問法不同的檢查互相比較。）
   *
   * ★ 暫支款的單跳過 —— 它跟代墊互斥，本來就不該有 advance_for_book。
   */
  select count(*), left(string_agg(x.req, '、' order by x.req), 200)
    into v_n, v_bad
    from (
      select coalesce(to_jsonb(p.*) ->> 'req_no', p.id::text)
             || '(現在=' || coalesce(p.advance_for_book, 'null')
             || ' 新算=' || coalesce(public.lend_book_for(p.payout_account, p.book), 'null')
             || ')' as req
        from public.purchase_requests p
       where p.purchased_on is not null
         and p.advance_category is null
         and left(coalesce(public.lend_book_for(p.payout_account, p.book), ''), 1) <> '!'
         and coalesce(p.advance_for_book, '')
             is distinct from coalesce(public.lend_book_for(p.payout_account, p.book), '')
    ) x;

  if v_n > 0 then
    raise exception
      '有 % 張已出款的單，新規則算出來的代墊對象跟現在存的不一樣 —— 整支停下來沒有改任何東西。%'
      '把這句話整段貼回對話裡。', v_n, chr(10) || v_bad;
  end if;
end $do$;


-- ══════ ③ 換判定 ══════
/*
 * ★★★ 底下這一支是**照 migration_272 的原樣抄**，只改了
 *   `v_lend` 怎麼來的那幾行，以及多一段「不支援的組合就報錯」。
 *   其餘每一行、每一個註解都沒動（README 二-6:上一支怎麼寫就怎麼抄）。
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
  v_lend text;                           -- 代墊給哪一本帳（算出來的，不再是人勾的）
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;
  if old.purchased_on is null then

    /*
     * ★★★ migration_285：代墊由**付款帳戶的帳本**決定，不再讀 advance_for_book。
     *   規則只有一份 —— `lend_book_for()`（上面那支，閘門也走它）。
     */
    v_lend := public.lend_book_for(new.payout_account, v_book);

    if v_lend = '!unsupported' then
      /*
       * ★★ 只支援「安幸的戶頭付別人的帳」。暫付那一頁是安幸的，
       *   沒有地方放「洪鯊欠愛皮」。
       */
      raise exception
        '付款帳戶「%」不屬於安幸，而這張單是「%」—— 目前只支援安幸代墊別本帳。'
        '請改用安幸或「%」的帳戶付款。',
        coalesce(new.payout_account, '(沒填)'), v_book, v_book;
    elsif v_lend = '!unknown' then
      /*
       * ★★★ 單是愛皮／洪鯊卻沒填（或填了查不到的）付款帳戶 ——
       *   判不出這筆是不是安幸代墊。**不猜**（CLAUDE.md）。
       * ★ 安幸自己的單沒填帳戶是放行的（見檔頭）——
       *   現金付款不選帳戶那條日常路徑不會被擋。
       */
      raise exception
        '這張單是「%」的帳，但付款帳戶「%」在收付款帳號主檔裡查不到 ——'
        '系統要靠它判斷這筆是不是安幸代墊。請先選一個付款帳戶。',
        v_book, coalesce(new.payout_account, '(沒填)');
    end if;

    /* ★ 算完寫回去:這一欄從「人勾的」變成「算出來的」，但還是留著當紀錄 */
    new.advance_for_book := v_lend;

    /*
     * ★★ 兩種特殊走法互斥。同時設的話語意矛盾:
     *   暫支款＝這筆錢本來就要收回來、不產生支出;
     *   代墊＝產生別本帳的支出，安幸這邊記一筆應收。
     */
    if v_adv is not null and v_lend is not null then
      raise exception '一張單不能同時是暫支款與安幸代墊（暫支=%，代墊給=%）', v_adv, v_lend;
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
           case when coalesce(new.shared_voucher, true)
                then new.voucher_no else i.voucher_no end,
           case when coalesce(new.shared_voucher, true)
                then coalesce(new.no_voucher, false)
                else coalesce(i.no_voucher, false) end,
           i.note, i.id, new.requester_id,
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
       *   總額是前端寫進去的快照，項目才是事實。
       */
      select sum(i.amount) into v_amt
        from public.purchase_request_items i where i.request_id = new.id;
      if coalesce(v_amt, 0) <= 0 then
        raise exception '暫支款的金額必須大於 0（這張單加總是 %）', coalesce(v_amt, 0);
      end if;

      /*
       * 物業:全部項目同一個才帶，混著就留 null。
       * ★ 猜一個填進去的話，那筆暫支會掛在錯的物業頭上而沒有人看得出來。
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
  -- 【刻意沒有 elsif】出款日填了就不能改。
  perform public.sync_pr_fee_expense(new);
  return new;
end $function$;


comment on column public.purchase_requests.advance_for_book is
  '代墊給哪一本帳。★ migration_285 起這一欄是**算出來的**不是人勾的 —— '
  'gen_expenses_from_pr() 拿「付款帳戶的 payment_accounts.book」跟這張單的 book 比，'
  '不一樣就是代墊，算完寫回這一欄。'
  '★★ 欄位留著是因為舊資料靠它才看得出當初是不是代墊。';


do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('285_lend_by_account');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  /*
   * ★★★ 母體要判定 —— 一張已出款的單都沒有的話，下面全部自動成立。
   */
  select 1 as ord, '★★★ ① 有幾張已出款的單' as "檢查",
         (select count(*)::text || ' 張'
            from public.purchase_requests where purchased_on is not null) as "結果",
         case when (select count(*) from public.purchase_requests
                     where purchased_on is not null) = 0
              then '⚠ 一張都沒有 —— 下面全部不算數'
              else '✅ 有東西可以檢查' end as "判定"

  union all
  /*
   * ★★★ 問「結果對不對」:用新規則重算，跟存著的值比。
   *   ★ 只比得出來的那些（`!` 開頭的是「算不出來」，另外一列報）。
   *   這一條跑第二次、第十次答案都一樣（README 二-3）。
   */
  select 2, '★★★ ② 新規則重算，跟現在存的對得起來嗎',
         (select count(*)::text || ' 張對不上'
            from public.purchase_requests p
           where p.purchased_on is not null and p.advance_category is null
             and left(coalesce(public.lend_book_for(p.payout_account, p.book), ''), 1) <> '!'
             and coalesce(p.advance_for_book, '')
                 is distinct from coalesce(public.lend_book_for(p.payout_account, p.book), '')),
         case when (select count(*) from public.purchase_requests p
                     where p.purchased_on is not null and p.advance_category is null
                       and left(coalesce(public.lend_book_for(p.payout_account, p.book), ''), 1) <> '!'
                       and coalesce(p.advance_for_book, '')
                           is distinct from coalesce(public.lend_book_for(p.payout_account, p.book), '')) = 0
              then '✅ 每一張都一樣 —— 換規則沒有改變任何舊單的意義'
              else '❌ 有單對不上 —— 上面那道閘門應該已經擋下來了' end

  union all
  /*
   * ③ **還沒出款**的單裡，之後按出款會被擋的有幾張。
   * ★★ 問的是「之後會不會卡住」，不是「過去有幾張沒填」——
   *   已出款的單不會再跑觸發器，列它們只是雜訊。
   */
  select 3, '★★★ ③ 還沒出款的單裡，之後按出款會被擋的',
         (select count(*)::text || ' 張'
            from public.purchase_requests p
           where p.purchased_on is null
             and left(coalesce(public.lend_book_for(p.payout_account, p.book), ''), 1) = '!'),
         case when (select count(*) from public.purchase_requests p
                     where p.purchased_on is null
                       and left(coalesce(public.lend_book_for(p.payout_account, p.book), ''), 1) = '!') = 0
              then '✅ 沒有單會卡住'
              else '⚠ 那幾張要先把付款帳戶選好，不然按出款會擋下來' end

  union all
  /* ④ 現有代墊的付款帳戶，帳本都是安幸嗎 —— 新規則的前提 */
  select 4, '★★ ④ 現有代墊是用哪一本帳的戶頭付的',
         coalesce((select string_agg(distinct coalesce(a.book, '(查不到)'), '、')
                     from public.advance_payments ap
                     left join public.payment_accounts a on a.code = ap.paid_account
                    where ap.category = '代墊'), '（沒有代墊）'),
         case when (select count(*) from public.advance_payments ap
                     left join public.payment_accounts a on a.code = ap.paid_account
                    where ap.category = '代墊'
                      and coalesce(a.book, 'x') <> 'anxing') = 0
              then '✅ 全部都是安幸的戶頭'
              else '❌ 有代墊是用非安幸的戶頭付的 —— 新規則不支援那種組合' end

  union all
  /* ⑤ 函式真的換成新版了嗎。★ 問它的內容，不是問它在不在 */
  select 5, '★★★ ⑤ 觸發器換成新版了嗎',
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%migration_285%')
              then '有 migration_285 的印記' else '還是舊版' end,
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%migration_285%')
              then '✅' else '❌' end

  union all
  /* ⑥ 它不該再讀 advance_for_book 當輸入 */
  select 6, '★★ ⑥ 不再把 advance_for_book 當輸入',
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%new.advance\_for\_book :=%')
              then '已改成寫回去' else '沒看到寫回的那一行' end,
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%new.advance\_for\_book :=%')
              then '✅' else '❌' end

  union all
  /*
   * ★★★ ⑦ 證明**觸發器真的走那一支函式** ——
   *   只檢查函式存在是不夠的:它可以存在，而觸發器裡還留著第二份規則
   *   （README 坑:自檢把清單再打一次，然後拿它當答案）。
   */
  select 7, '★★★ ⑦ 觸發器真的走 lend_book_for() 嗎',
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%lend\_book\_for(%')
              then '有呼叫它' else '沒有 —— 規則可能被抄成第二份' end,
         case when exists (
                select 1 from pg_proc p
                 where p.oid = 'public.gen_expenses_from_pr()'::regprocedure
                   and pg_get_functiondef(p.oid) like '%lend\_book\_for(%')
              then '✅' else '❌' end

  union all
  /* ★★ ⑧ 那支函式的四種答案都要會回 —— 用真的值餵進去問 */
  select 8, '★★ ⑧ 判定函式四種答案都對嗎',
         coalesce(public.lend_book_for('8088', 'anxing'), 'null') || ' / ' ||
         coalesce(public.lend_book_for('8088', 'aipi'), 'null') || ' / ' ||
         coalesce(public.lend_book_for('4195', 'hongsha'), 'null') || ' / ' ||
         coalesce(public.lend_book_for(null, 'anxing'), 'null') || ' / ' ||
         coalesce(public.lend_book_for(null, 'aipi'), 'null'),
         case when public.lend_book_for('8088', 'anxing') is null
               and public.lend_book_for('8088', 'aipi') = 'aipi'
               and public.lend_book_for('4195', 'hongsha') = '!unsupported'
               and public.lend_book_for(null, 'anxing') is null
               and public.lend_book_for(null, 'aipi') = '!unknown'
              then '✅ 安幸付安幸=不是代墊／安幸付愛皮=代墊／愛皮付洪鯊=不支援／沒填+安幸=放行／沒填+愛皮=擋'
              else '❌ 有一種答錯 —— 停下來' end

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '285_lend_by_account'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '285_lend_by_account')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
