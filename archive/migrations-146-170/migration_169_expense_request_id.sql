-- migration_169：支出補上 request_id —— 請款單的憑證圖片才跟得過去
--
-- ============================================================
-- 【症狀】（2026-08-24 使用者回報，附畫面）
--
-- PR-202608-068「招待客人-酒」四個項目，請款單上**有 1 張共同憑證圖**。
-- 拆成四筆支出之後，每一筆點開來憑證圖片都寫:
--
--     憑證圖片
--     尚未上傳
--
-- 號碼過去了（CD78918483、CD78918502 +2），**圖沒有**。
--
--
-- ============================================================
-- 【原因 —— 不是共同憑證的問題，是全部都這樣】
--
-- 支出頁本來就有繼承的程式碼:
--
--     <Receipts kind="exp" parentId={d.id}
--               inheritFromRequestId={d.request_id ?? null} />
--                                     ^^^^^^^^^^^^^
--
-- 而 `gen_expenses_from_pr()` 的 insert 欄位清單是:
--
--     spent_on, item_name, amount, amount_original, currency, fx_rate,
--     account_code, purpose_type, estate_id, property_id,
--     payment_method, pay_account, voucher_no, no_voucher,
--     note, source_item_id, created_by
--                ^^^^^^^^^^^^^^ 只有這個,**沒有 request_id**
--
-- 所以每一筆從請款單產生的支出，`request_id` 都是 null，
-- 前端拿到 null 就不繼承 —— 於是**每一張請款單的憑證圖都停在請款單上**。
--
-- 欄位本身一直都在（有 FK expenses_request_id_fkey、有索引 exp_request_idx），
-- 只是從來沒有人寫過它。這是典型的「安靜」錯誤:
-- 沒有報錯、沒有紅字，只有一句「尚未上傳」——
-- 而那句話看起來完全合理。
--
--
-- ============================================================
-- 【為什麼用觸發器補，不重寫 gen_expenses_from_pr】
--
-- 直覺是把 request_id 加進那支函式的 insert 清單。**沒有這樣做**:
--
--  ① 產生「匯款手續費」支出的那支函式**定義不在這個 repo 裡** ——
--     migration_151 只提到它 insert 有 fee_request_id，本體找不到。
--     手續費支出也來自請款單（畫面上那筆「匯款手續費-招待客人-酒」
--     憑證號碼一模一樣），它也該繼承圖。
--     兩支都要改，而我只有其中一支的定義。
--
--  ② 重寫一支手上定義可能已經過時的函式，是這個專案犯過最貴的錯
--     （README 9.5:schema-baseline 一天之內錯五次）。
--
-- 觸發器只寫 request_id 這一個欄位，不碰任何既有邏輯。
-- 兩支函式、以及未來任何一支往 expenses 塞資料的東西，都自動涵蓋。
--
-- ★ BEFORE 觸發器按**名稱字母順序**執行。
--   `trg_expense_fill_request_id` 排在 `trg_expenses_book_code` 前面
--   （'expense_' 的底線 0x5F 小於 'expenses' 的 s 0x73）。
--   兩者寫的欄位不重疊,誰先誰後都不影響。
-- ============================================================


-- ============================================================
-- ① 觸發器:以後產生的支出自動帶 request_id
-- ============================================================
create or replace function public.expense_fill_request_id()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  -- 已經有值就不動 —— 手動建立的支出可能刻意指定，不要覆蓋
  if new.request_id is not null then return new; end if;

  if new.source_item_id is not null then
    -- 一般請款項目 → 回頭問它屬於哪一張單
    select i.request_id into new.request_id
      from public.purchase_request_items i
     where i.id = new.source_item_id;
  elsif new.fee_request_id is not null then
    -- 匯款手續費 → 它本來就記著是哪一張單
    new.request_id := new.fee_request_id;
  end if;

  return new;
end $function$;

comment on function public.expense_fill_request_id() is
  '從請款單產生的支出自動帶上 request_id —— 支出頁靠它繼承請款單的憑證圖片。'
  '用觸發器而不是改 gen_expenses_from_pr:手續費那支函式的定義不在 repo 裡'
  '（migration_169）。';

drop trigger if exists trg_expense_fill_request_id on public.expenses;
create trigger trg_expense_fill_request_id
  before insert or update of source_item_id, fee_request_id on public.expenses
  for each row execute function public.expense_fill_request_id();


-- ============================================================
-- ② 回填既有的支出
-- ============================================================
/*
 * 使用者的話:「請幫我把現有共同憑證的有共同上傳，因此可以看到共同的圖片」
 * —— 就是這一段。
 *
 * ★ 不用分頁。Supabase 最多回 1000 列是 **PostgREST** 的限制，
 *   直接下 SQL 的 update 沒有這回事。
 *
 * ★ 只補 null 的。已經有值的不動 —— 那可能是人手動指定的。
 */
/*
 * ★ 結果寫進 temp table，不要直接 select ——
 *   SQL Editor 只顯示**最後一句** SELECT，直接印的話會被下面那張表蓋掉，
 *   而「補了幾筆」正是這支最重要的數字。
 */
create temp table _chk169 (ord int, item text, result text, note text) on commit drop;

with fixed_item as (
  update public.expenses e
     set request_id = i.request_id
    from public.purchase_request_items i
   where e.source_item_id = i.id
     and e.request_id is null
     and i.request_id is not null
  returning e.id
),
fixed_fee as (
  update public.expenses e
     set request_id = e.fee_request_id
   where e.fee_request_id is not null
     and e.request_id is null
  returning e.id
)
insert into _chk169
select 0, '★★ 這次補了幾筆',
       (select count(*) from fixed_item)::text || ' 筆請款項目 ＋ '
       || (select count(*) from fixed_fee)::text || ' 筆手續費',
       '補完就看得到請款單的憑證圖了';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('169_expense_request_id');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的 insert 一筆，看觸發器有沒有把 request_id 填進去。
 *
 *   只檢查「觸發器存在嗎」抓不到條件寫錯 ——
 *   167 / 164 都是那樣漏的。做完 raise 讓整段回滾。
 */
do $$
declare
  v_item uuid; v_req uuid; v_code text; v_got uuid; v_msg text;
begin
  select i.id, i.request_id into v_item, v_req
    from public.purchase_request_items i
   where i.request_id is not null
   limit 1;
  select code into v_code from public.account_codes
   where book = 'anxing' and active limit 1;

  if v_item is null or v_code is null then
    insert into _chk169 values (1, '★★ 觸發器實測', '⚠ 測不出來',
      '找不到請款項目或會計科目');
    return;
  end if;

  begin
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, payment_method, source_item_id, book
    ) values (
      current_date, '__169 觸發器測試__', 1, 1, 'TWD', 1,
      v_code, 'office', 'transfer', v_item, 'anxing'
    )
    -- source_item_id 有唯一索引,同一個項目已經有支出的話會撞上
    on conflict (source_item_id) do nothing
    returning request_id into v_got;

    if v_got is null then
      v_msg := '⚠ 這個項目已經有支出了,換一筆再測';
    elsif v_got = v_req then
      v_msg := '✅ 自動填上了';
    else
      v_msg := '❌ 填錯了:' || v_got::text;
    end if;

    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    /*
     * ★ 抓 others 不抓 restrict_violation ——
     *   expenses 上的其他觸發器（帳本、會計科目）丟的是 check_violation,
     *   只抓一種的話會炸掉整份腳本（README 9.4 第 9 條）。
     */
    if sqlerrm <> '__rollback__' then
      v_msg := '⚠ 例外:' || sqlerrm;
    end if;
  end;

  insert into _chk169 values (1, '★★ 觸發器實測', coalesce(v_msg, '⚠ 沒跑到'),
    '新產生的支出會自動帶 request_id');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk169 c

  union all
  /*
   * ★★ 回填完之後，這個數字必須是 0。
   *   不是 0 表示還有支出繼承不到圖,而畫面上只會寫「尚未上傳」。
   */
  select 2, '★★ 還有幾筆請款支出沒有 request_id',
         count(*)::text || ' 筆',
         case when count(*) = 0 then '✅ 全部補齊' else '❌ 這些筆看不到請款單的圖' end
    from public.expenses
   where source_item_id is not null and request_id is null

  union all
  select 3, '★★ 還有幾筆手續費支出沒有 request_id',
         count(*)::text || ' 筆',
         case when count(*) = 0 then '✅ 全部補齊' else '❌ 同上' end
    from public.expenses
   where fee_request_id is not null and request_id is null

  union all
  select 4, '現在有 request_id 的支出', count(*)::text || ' 筆',
         '這些點開來就看得到請款單的憑證圖'
    from public.expenses where request_id is not null

  union all
  /*
   * ★ 有幾張請款單真的有圖。
   *   如果這個數字是 0，那補了 request_id 也還是看不到圖 ——
   *   問題會在別的地方,不要以為修好了。
   */
  select 5, '有憑證圖的請款單',
         count(distinct request_id)::text || ' 張',
         '沒有圖的單,補了 request_id 也還是空的'
    from public.attachments where request_id is not null

  union all
  /*
   * ★ 憑證圖的讀取權限。支出頁的人要看得到 attachments 上 request_id 那些列。
   *   這條路以前從來沒有走通過（request_id 一直是 null），所以沒被驗證過。
   *   ★ 這裡只把政策**列出來**,不下判斷 —— 判斷要靠實際用一次。
   */
  select 6, 'attachments 的 select 政策',
         string_agg(polname, '、' order by polname),
         '支出頁靠這些政策讀請款單的圖'
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'attachments' and p.polcmd in ('r', '*')

) v order by ord;
