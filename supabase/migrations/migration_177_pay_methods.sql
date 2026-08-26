-- migration_177：支付方式多兩種 —— 臨櫃、自動繳款
--
-- ============================================================
-- 【要做什麼】（2026-08-25 使用者:「支付方式多兩種:臨櫃、自動繳款。
--                模式仿造匯款，一樣可以選帳本」）
--
--   counter  臨櫃     拿現金／支票去銀行櫃檯繳（水電、稅、規費）
--   autopay  自動繳款  銀行按期自動扣款
--
-- 兩種的共同點是**錢從安幸某一個帳戶出去**，所以跟匯款一樣
-- 要能指定 payout_account。
--
--
-- ============================================================
-- 【★★ 不改這支的話，前端做完也存不進去】
--
-- 三道 CHECK 把付款方式寫死成三種:
--
--   pr_pay_chk      purchase_requests.payment_method in (cash,transfer,credit_card)
--   pr_planned_chk  payout_account 只有 transfer / credit_card 能有值
--   exp_pay_chk     expenses.payment_method 同上三種
--
-- 症狀是「選了臨櫃，按儲存，跳出一句看不懂的英文」——
-- 而畫面上那個下拉明明選得到。
--
-- ★ `exp_pay_chk` 一定要一起改:支出是請款單出款後產生的，
--   只放寬請款單那邊的話，單子存得進去、**出款時才炸**，
--   而那時錢已經匯出去了。
--
--
-- ============================================================
-- 【為什麼是放寬 CHECK 而不是改成參照表】
--
-- 五個值、幾年才動一次，而 CHECK 的好處是**改的時候會被迫想一遍**:
-- 參照表新增一列不會有人審，CHECK 要寫 migration。
-- 這一頁的付款方式牽動待排付款、手續費、出款帳號三條規則，
-- 悄悄多一個值比多寫一支 migration 危險。
-- ============================================================

create temp table _chk177 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① purchase_requests：付款方式
-- ============================================================
do $$ begin
  alter table public.purchase_requests drop constraint if exists pr_pay_chk;
  alter table public.purchase_requests add constraint pr_pay_chk
    check (payment_method is null
           or payment_method in ('cash', 'transfer', 'credit_card', 'counter', 'autopay'));
end $$;

comment on constraint pr_pay_chk on public.purchase_requests is
  '付款方式五選一。counter=臨櫃、autopay=自動繳款（migration_177）。'
  '★ 要跟 src/lib/purchase-pay.ts 的 PAY_OPTS 一致 —— '
  '前端多一個值而這裡沒放寬的話,存檔會吐 SQL 例外。';


-- ============================================================
-- ② purchase_requests：哪些方式可以有安幸付款帳號
-- ============================================================
/*
 * ★ 現金**仍然不准**有 payout_account。
 *
 *   現金是從手上出去的。指定一個銀行帳號的話，對帳的人會以為
 *   那筆錢真的從元大 8088 匯出去了 —— 而銀行流水裡永遠找不到它。
 *
 * ★ 這道約束是「payout_account 有值時，方式必須是這幾種」，
 *   不是「這幾種必須有 payout_account」。必填由前端擋
 *   （排付款那一步），因為填單當下常常還不知道從哪個戶頭出。
 */
do $$ begin
  alter table public.purchase_requests drop constraint if exists pr_planned_chk;
  alter table public.purchase_requests add constraint pr_planned_chk
    check (payout_account is null
           or payment_method in ('transfer', 'credit_card', 'counter', 'autopay'));
end $$;


-- ============================================================
-- ③ expenses：出款後產生的支出
-- ============================================================
do $$ begin
  alter table public.expenses drop constraint if exists exp_pay_chk;
  alter table public.expenses add constraint exp_pay_chk
    check (payment_method is null
           or payment_method in ('cash', 'transfer', 'credit_card', 'counter', 'autopay'));
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('177_pay_methods');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的存一筆，不是只看約束的字面。
 *
 *   看字面的話等於把上面那段 SQL 抄一次去檢查自己 ——
 *   README 9.4 #12:自檢要問**結果**，不能複製被檢查的邏輯。
 *   174 就是那樣回了一個假的綠燈。
 */
do $$
declare v_uid uuid; v_acct text; v_msg text; m text;
begin
  select id into v_uid from public.profiles limit 1;
  select code into v_acct from public.payment_accounts limit 1;
  if v_uid is null then
    insert into _chk177 values (1, '★★ 兩種新方式存得進去', '⚠ 測不出來', '一個使用者都沒有');
    return;
  end if;

  begin
    foreach m in array array['counter', 'autopay'] loop
      insert into public.purchase_requests (req_no, requester_id, payment_method, payout_account)
      values ('__177測試__' || m, v_uid, m, v_acct);
    end loop;
    v_msg := '✅ 臨櫃與自動繳款都存得進去,而且帶得了安幸付款帳號';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk177 values (1, '★★ 兩種新方式存得進去', coalesce(v_msg, '⚠ 沒跑到'),
    '沒放寬 CHECK 的話前端做完也存不進去');
end $$;


/*
 * ★★ 現金**仍然**不能有安幸付款帳號 —— 放寬不能放過頭。
 *   這一題要的是 ❌(擋下來) 才算對。
 */
do $$
declare v_uid uuid; v_acct text; v_msg text;
begin
  select id into v_uid from public.profiles limit 1;
  select code into v_acct from public.payment_accounts limit 1;
  if v_uid is null or v_acct is null then return; end if;

  begin
    insert into public.purchase_requests (req_no, requester_id, payment_method, payout_account)
    values ('__177測試現金__', v_uid, 'cash', v_acct);
    v_msg := '❌ 現金竟然帶得了付款帳號 —— 那筆錢會出現在銀行明細裡';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    /*
     * ★ `null` 是一個**語句**，後面要有分號。
     *   少了的話 parser 會把下一行的 elsif 當成 null 的一部分，
     *   錯誤訊息指在 elsif 那一行 —— 而那一行沒有問題。
     */
    if sqlerrm = '__rollback__' then
      null;
    elsif sqlerrm like '%pr_planned_chk%' then
      v_msg := '✅ 擋下來了';
    else
      v_msg := '⚠ 擋下來了但原因不同:' || sqlerrm;
    end if;
  end;

  insert into _chk177 values (2, '★ 現金仍然不能有付款帳號', coalesce(v_msg, '⚠ 沒跑到'),
    '現金是從手上出去的,掛帳號會讓對帳的人找不到那筆流水');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk177 c

  union all
  /*
   * ★ 問的是「現在的定義裡有沒有這兩個字」,對象是**三道約束**。
   *   少改一道的症狀各不相同（存不進去／帳號存不進去／出款時才炸），
   *   所以要一次看到三個答案。
   */
  select 3, '★★ 三道約束都放寬了',
         (select count(*)::text || ' / 3' from pg_constraint
           where conname in ('pr_pay_chk', 'pr_planned_chk', 'exp_pay_chk')
             and pg_get_constraintdef(oid) like '%counter%'
             and pg_get_constraintdef(oid) like '%autopay%'),
         'exp_pay_chk 漏改的話,單子存得進去但出款時才炸 —— 那時錢已經匯出去了'

  union all
  select 4, '★ 既有的單一筆都沒動',
         (select count(*)::text || ' 張請款單 ／ '
                 || (select count(*) from public.expenses)::text || ' 筆支出'
            from public.purchase_requests),
         '這支只放寬規則,不改任何一列資料'

  union all
  select 5, '目前用到的付款方式',
         coalesce((select string_agg(x.m || '×' || x.n, '、' order by x.n desc)
                     from (select coalesce(payment_method, '(空)') as m, count(*) as n
                             from public.purchase_requests group by 1) x), '(沒有資料)'),
         '臨櫃與自動繳款要等有人開單才會出現'

) v order by ord;
