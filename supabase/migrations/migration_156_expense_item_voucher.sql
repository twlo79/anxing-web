-- migration_156：支出的憑證改吃請款項目自己的號碼
--
-- ============================================================
-- 【接續 migration_155】
--
-- 155 把憑證欄位加到 purchase_request_items，前端也填得了，
-- 但 gen_expenses_from_pr **還是把請款單層級的號碼複製給每一筆支出**。
-- 所以 155 跑完之後，逐項填的憑證停在請款單裡，流不到支出頁。
--
-- 這支補上最後一段。
--
--
-- ============================================================
-- 【原本錯在哪】
--
-- 舊的寫法是:
--
--     new.voucher_no, coalesce(new.no_voucher, false),
--
-- 旁邊還留著一句註解:
--
--     「一張請款單可能拆成多筆支出，憑證號碼會重複帶。
--       這是對的：同一張發票本來就對應多個項目。」
--
-- 那個假設**只在真的只有一張發票時成立**。十七張不同收據時，
-- 填單的人把號碼用頓號串成一串塞進那一格，然後整串複製給每一筆支出 ——
-- 計程車車資那筆的憑證號碼裡混著差旅住宿的發票號。
--
-- 對帳的人拿那個號碼去查，查到的是別的東西。而且不會有任何錯誤。
--
--
-- ============================================================
-- 【這支只改兩行】
--
-- 函式本體是從線上的 pg_get_functiondef 抄下來的（2026-08-21），
-- 除了憑證那兩行以外**一個字都沒動**，包括:
--
--   · on conflict (source_item_id) do nothing
--   · perform public.sync_pr_fee_expense(new)
--   · 「【刻意沒有 elsif】出款日填了就不能改」那句註解
--     ★ 那句是下一個人唯一看得懂「為什麼改出款日的按鈕會消失」的地方。
--       刪掉它，三個月後就會有人以為那是漏寫的。
--
-- ★ 為什麼不用 baseline 那份:repo 裡的 schema-baseline.sql 有一段
--   「只改日期：同步既有支出」的連動，**線上根本沒有**。
--   照那份覆寫等於把一段已經被拿掉的行為裝回去。
--
--
-- ============================================================
-- 【行為】
--
--   shared_voucher = true   用請款單的號碼（既有的 59 張全部走這條，行為不變）
--   shared_voucher = false  用該項目自己的號碼
--
-- ★ 這支**不回頭改既有的支出**。
--   已經產生的支出裡那串頓號號碼留在原地 —— 它們是當時填的事實，
--   而系統分不出那一串裡哪個號碼對應哪個項目（那個資訊從來沒存過）。
--   「對不上的不猜」:少填一個看得到、補得回來;填錯一個沒有人會發現。
--   支出頁的截斷顯示（src/lib/voucher.ts）因此不能拿掉。
-- ============================================================

create or replace function public.gen_expenses_from_pr()
returns trigger language plpgsql security definer set search_path to 'public'
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
    new.expense_generated_at := now();
  end if;
  -- 【刻意沒有 elsif】出款日填了就不能改（見檔頭第 5 節）。
  -- 手續費：冪等,多呼叫不會出事。
  perform public.sync_pr_fee_expense(new);
  return new;
end $function$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('156_expense_item_voucher');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 觸發器已改' as "檢查項目",
         case when pg_get_functiondef(p.oid) like '%shared_voucher%'
              then '✅' else '❌ 沒改到' end as "結果",
         '支出的憑證會看 shared_voucher 決定拿哪一個' as "說明"
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gen_expenses_from_pr'

  union all
  /*
   * ★★ 其他行為一個都不能少。
   *   這支是整個覆寫函式本體，漏抄一行的症狀是「某個功能突然不見了」，
   *   而那要等有人真的去用才會發現。
   */
  select 2, '★★ 既有行為都還在',
         case when pg_get_functiondef(p.oid) like '%sync_pr_fee_expense%'
               and pg_get_functiondef(p.oid) like '%on conflict (source_item_id)%'
               and pg_get_functiondef(p.oid) like '%刻意沒有 elsif%'
              then '✅ 3 / 3' else '❌ 有東西被抄漏了' end,
         '手續費連動、重複產生的防線、出款日鎖定的說明'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gen_expenses_from_pr'

  union all
  /*
   * ★ 155 必須先跑過。
   *   沒有 shared_voucher 欄位的話，上面那個 case 會直接噴錯 ——
   *   而且是在**下一次有人確認出款**的時候才噴，不是現在。
   */
  select 3, '★ migration_155 已經跑過',
         case when exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'purchase_requests'
              and column_name = 'shared_voucher')
         then '✅' else '❌ 先跑 155，不然下次確認出款會噴錯' end,
         'purchase_requests.shared_voucher'

  union all
  select 4, '既有支出（不回頭改）',
         count(*)::text || ' 筆',
         '那串頓號號碼留在原地 —— 系統分不出哪個號碼對應哪個項目'
    from public.expenses where voucher_no like '%、%'

) v order by ord;
