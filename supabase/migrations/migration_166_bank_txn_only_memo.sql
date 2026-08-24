-- migration_166：銀行流水只能改摘要，其他欄位鎖住
--
-- ============================================================
-- 【為什麼】（2026-08-22 使用者指定）
--
-- 帳戶明細要能編輯「摘要」——「股東還款」「１２月房租」這種註記
-- 只有人知道，銀行對帳單上沒有。
--
-- 但**其餘欄位一個都不能改**:
--
--     交易日 / 帳務日 / 金額 / 餘額 / 交易帳號 / 交易型態
--
-- 那些是**銀行給的事實**。改了之後這一頁就不再是「銀行流水的鏡像」，
-- 而是一份看起來像銀行流水的自由文字 —— 那比沒有這一頁更危險，
-- 因為對帳的人會相信它。
--
--
-- ============================================================
-- 【為什麼 RLS 不夠】
--
-- migration_142 的政策是 `for all`，也就是會計以上**整列都能改**。
-- 前端只讓改摘要，但前端擋不住:
--
--   · 重新整理後的舊畫面
--   · 直接打 API
--   · 未來某個人寫的另一支程式
--
-- 「只能改這一欄」是資料的規則，不是畫面的規則，所以寫在觸發器。
--
--
-- ============================================================
-- 【匯入不受影響】
--
-- 上傳對帳單時要 upsert 整列（金額、餘額都會寫）。
-- 匯入用 service key，`current_role_of()` 是 null —— 放行。
--
-- 跟 migration_157 的訂單鎖定同一個判斷:**這道是防手滑，不是防惡意**。
-- ============================================================

create or replace function public.bank_txn_memo_only()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_role text := public.current_role_of();
begin
  -- 匯入排程（service key，沒有 auth.uid()）放行 —— 見檔頭
  if v_role is null then return new; end if;

  /*
   * ★ 逐欄比對。用 `to_jsonb(new) - 'memo' <> to_jsonb(old) - 'memo'`
   *   比一個一個列出來好:之後加欄位不用回來改這裡，
   *   而漏改的症狀是「那個新欄位可以偷偷被改掉」。
   */
  if (to_jsonb(new) - 'memo') <> (to_jsonb(old) - 'memo') then
    raise exception
      '銀行流水只能編輯「摘要」。金額、日期、餘額、帳號都是銀行給的事實，'
      '改了這一頁就不再是對帳單的鏡像。要修正請重新上傳對帳單。'
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

drop trigger if exists trg_bank_txn_memo_only on public.bank_transactions;
create trigger trg_bank_txn_memo_only
  before update on public.bank_transactions
  for each row execute function public.bank_txn_memo_only();

comment on function public.bank_txn_memo_only() is
  '銀行流水只能改 memo。其餘欄位是銀行給的事實 —— '
  '前端也只讓改摘要，但前端擋不住重新整理後的舊畫面（migration_166）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('166_bank_txn_only_memo');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的改兩次:改摘要要成功、改金額要被擋。
 *   只用 select 檢查「觸發器存在嗎」的話，抓不到條件寫錯
 *   （164 就是這樣漏掉的）。
 *
 * 兩次都在 do 區塊裡，做完 raise 讓它整段回滾。
 */
do $$
declare v_id uuid; v_ok_memo boolean := false; v_blocked boolean := false;
begin
  select id into v_id from public.bank_transactions limit 1;
  if v_id is null then
    raise notice '★ 跳過測試（還沒有銀行流水）';
    return;
  end if;

  -- ① 改摘要應該成功
  begin
    update public.bank_transactions set memo = '__測試摘要__' where id = v_id;
    v_ok_memo := true;
  exception when others then
    v_ok_memo := false;
  end;

  -- ② 改金額應該被擋
  begin
    update public.bank_transactions set debit = debit + 1 where id = v_id;
    v_blocked := false;   -- 沒被擋 = 壞了
  exception when check_violation then
    v_blocked := true;
  end;

  raise notice '★★ 改摘要:% ／ 改金額被擋:%',
    case when v_ok_memo then '成功 ✅' else '失敗 ❌' end,
    case when v_blocked then '是 ✅' else '否 ❌ 沒擋住' end;

  raise exception using errcode = 'restrict_violation', message = '__rollback__';
exception
  when restrict_violation then
    if sqlerrm = '__rollback__' then raise notice '★ 測試資料已回滾';
    else raise; end if;
end $$;


select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 觸發器' as "檢查項目",
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.bank_transactions'::regclass
                              and tgname = 'trg_bank_txn_memo_only')
              then '✅' else '❌' end as "結果",
         '只能改摘要，其餘欄位擋下並說明原因' as "說明"

  union all
  /*
   * ★ 匯入那條路要留著。
   *   v_role is null 就 return —— 沒有它的話上傳對帳單會整批失敗，
   *   而症狀是「匯入沒反應」，沒有人會聯想到這支觸發器。
   */
  select 2, '★ 匯入不受影響',
         case when pg_get_functiondef(p.oid) like '%v_role is null then return new%'
              then '✅' else '❌ 上傳對帳單會失敗' end,
         'service key 沒有 auth.uid()，放行'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'bank_txn_memo_only'

  union all
  select 3, '既有流水', count(*)::text || ' 筆',
         '這支只加規則，一筆資料都沒動'
    from public.bank_transactions

) v order by ord;
