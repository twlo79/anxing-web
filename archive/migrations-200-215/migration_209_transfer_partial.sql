/*
 * migration_209 —— 移房時押金變貴可以移轉（移完是「收部分」）
 * ============================================================
 * 2026-09-02 使用者：「移房完 如果增加押金 如果沒收完 一樣顯示 收部分 全收
 *                     多一個狀態來追蹤 押金狀態」
 *
 * ============================================================
 * 【★★★ 不需要「多一個狀態」】
 *
 * 押金的收款狀態機**早就存在**（`lib/deposit-payment.ts`，migration_147）:
 *
 *     未收 unpaid ／ 收部分 partial ／ 全收 paid ／ 已退 returned
 *
 * 而且它是**算出來的，不存欄位**。那支的檔頭寫著為什麼:
 *
 *   「存了就會有『合計改了但狀態沒跟上』的那種 bug ——
 *     而畫面上那筆押金會顯示「已收款」配一個收了一半的數字」
 *
 * ★ 押金頁的清單也已經在顯示那個標籤了。所以這支**不加任何欄位** ——
 *   加一個存起來的狀態會變成 CLAUDE.md 那條「推導值存成欄位」的
 *   第三個受害者（前兩個是 bank_transactions.balance 與 deposits.lines）。
 *
 * ============================================================
 * 【真正卡住的是這一行】
 *
 *     if round(f.amount,2) <> round(t.amount,2) then  ← 金額不同一律擋
 *
 * 而它的提示自己就寫著解法:
 *
 *   「請先到訂單把押金金額改成一致,**或等「押金收款多筆」做完再補收差額**」
 *
 * 「押金收款多筆」就是 migration_147 —— 同一支 migration 裡做完的。
 * 那句話當時是給未來的自己看的，而未來就是現在。
 *
 * ============================================================
 * 【改成怎樣】
 *
 *   B 比較貴（移房押金增加）  ✅ 放行 —— 移轉那筆進去之後 B 是「收部分」，
 *                                差額用既有的押金收款補
 *   一樣多                     ✅ 照舊
 *   B 比較便宜                 ❌ 繼續擋
 *
 * ★★★ 為什麼便宜的還是要擋:那會**超收**，而多出來的錢是要退給房客的
 *   —— 那是退款，不是移轉。放行的話帳上會有一筆
 *   「已收 30,000 ／ 應收 20,000」，而沒有任何地方說得出那 10,000 去哪了。
 *
 * ★ 前端 `lib/deposit-transfer.ts` 的 `canTransfer()` 同一天改成同一條規則，
 *   而且有測試釘住。兩邊都要改是因為前端只擋得住畫面那條路。
 *
 * ============================================================
 * 【★★ 這支是逐字照抄線上版本 ＋ 改一段】
 *
 * 2026-09-02 用 `pg_get_functiondef` 取回來核對過，跟 migration_147
 * 一字不差（沒有被別人改過）。除了金額那一段與成功訊息之外，
 * 其餘**一個字都沒動** —— 包含所有的檢查順序與訊息文字。
 */

create or replace function public.transfer_deposit(
  p_from uuid, p_to uuid, p_on date default current_date
) returns table(ok boolean, item text, detail text)
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  f public.deposits;
  t public.deposits;
  v_from_name text;
  v_to_name   text;
  v_short     numeric;   -- migration_209：移轉後還差多少
 begin
  if current_role_of() not in ('accountant', 'super_admin') then
    return query select false, '權限不足'::text, '只有會計與總管理員能移轉押金'::text;
    return;
  end if;
  if p_from is null or p_to is null or p_from = p_to then
    return query select false, '來源與目的不能是同一筆'::text, ''::text;
    return;
  end if;
  select * into f from public.deposits where id = p_from;
  select * into t from public.deposits where id = p_to;
  if f.id is null then
    return query select false, '找不到來源押金'::text, ''::text; return;
  end if;
  if t.id is null then
    return query select false, '找不到目的押金'::text, ''::text; return;
  end if;
  v_from_name := coalesce(nullif(f.room, ''), nullif(f.guest_name, ''), '（未填房號）');
  v_to_name   := coalesce(nullif(t.room, ''), nullif(t.guest_name, ''), '（未填房號）');
  if f.received_on is null then
    return query select false, '來源還沒收到押金'::text,
      v_from_name || ' 這筆是「尚未收」—— 沒有錢可以移'::text; return;
  end if;
  if f.returned_on is not null then
    return query select false, '來源已經退款了'::text,
      v_from_name || ' 於 ' || f.returned_on || ' 已退' ||
      case when f.transfer_to_id is not null then '（移轉出去）' else '' end; return;
  end if;
  if f.orphaned then
    return query select false, '來源是孤兒紀錄'::text,
      '來源訂單／契約已經不在了,請先確認這筆押金的歸屬'::text; return;
  end if;
  if t.received_on is not null then
    return query select false, '目的已經收過押金了'::text,
      v_to_name || ' 於 ' || t.received_on || ' 已收 —— 重複收兩次押金是錯的'::text; return;
  end if;
  /*
   * ★ 目的**部分收款**也要擋（migration_147 新增的狀態）。
   *   收了一半再移一整筆進來會變成超收,而畫面上只會看到一個對不起來的數字。
   */
  if coalesce(t.received_amount, 0) > 0 then
    return query select false, '目的已經收過一部分押金了'::text,
      v_to_name || ' 已收 ' || to_char(t.received_amount, 'FM999,999,999') ||
      ' —— 先把那幾筆處理掉再移轉'::text; return;
  end if;
  if t.returned_on is not null then
    return query select false, '目的已經退款了'::text, ''::text; return;
  end if;
  if t.orphaned then
    return query select false, '目的是孤兒紀錄'::text, ''::text; return;
  end if;
  if coalesce(f.currency, 'TWD') <> coalesce(t.currency, 'TWD') then
    return query select false, '幣別不同'::text,
      coalesce(f.currency,'TWD') || ' → ' || coalesce(t.currency,'TWD') ||
      ' —— 換匯是另一件事,不能靠移轉帶過'::text; return;
  end if;
  /*
   * ══════════ migration_209 改的就是這一段 ══════════
   *
   * 舊的是 `<>`（金額不同一律擋）。現在只擋「目的比較便宜」——
   * 那會超收，而多出來的錢是要退給房客的，那是退款不是移轉。
   *
   * ★ 目的比較貴是放行的:移轉那筆進去之後 B 自然是「收部分」，
   *   差額用押金收款補。狀態由 depPayStatus 算，不用存。
   */
  if round(coalesce(t.amount, 0), 2) < round(coalesce(f.amount, 0), 2) then
    return query select false, '目的的押金比較少,會超收'::text,
      v_from_name || ' 收了 ' || to_char(coalesce(f.amount,0), 'FM999,999,999') ||
      '，' || v_to_name || ' 只要 ' || to_char(coalesce(t.amount,0), 'FM999,999,999') ||
      '，會多 ' || to_char(coalesce(f.amount,0) - coalesce(t.amount,0), 'FM999,999,999') ||
      '。多的那筆要退給房客 —— 那是退款不是移轉。請先到' ||
      case when t.order_id is not null then '訂單' else '契約' end ||
      '把金額改成一致,或先退款再移轉'::text; return;
  end if;
  if to_jsonb(f)->'lines' is distinct from to_jsonb(t)->'lines' then
    return query select false, '多幣別明細不同,不能移轉'::text,
      '兩邊的外幣組成要一模一樣'::text; return;
  end if;
  -- 來源:退出去（移轉），這幾欄不歸觸發器管
  update public.deposits set
    returned_on      = p_on,
    returned_method  = 'internal',
    returned_account = null,
    refund_status    = 'approved',
    transfer_to_id   = t.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉至 ' || v_to_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = f.id;
  /*
   * 目的:插一筆收款，received_on / received_amount 由觸發器算。
   * **不要直接 update received_***  —— 見這一段開頭的說明。
   *
   * ★★ 移進去的是**來源的金額**，不是目的的應收。所以目的比較貴時
   *   received_amount < amount，觸發器不會填 received_on ——
   *   狀態自然就是「收部分」。這正是使用者要的行為。
   */
  insert into public.deposit_payments (deposit_id, paid_on, amount, method, account, note, created_by)
  values (t.id, p_on, coalesce(f.amount, 0), 'internal', null,
          '押金移轉自 ' || v_from_name, auth.uid());
  update public.deposits set
    transfer_from_id = f.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉自 ' || v_from_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = t.id;

  /*
   * ★★★ 差額要寫在成功訊息裡（migration_209）。
   *   不寫的話使用者以為移完就結束了 —— 而那筆押金其實還差一截，
   *   要等到有人去看清單上的「收部分」才發現。
   */
  v_short := round(coalesce(t.amount, 0) - coalesce(f.amount, 0), 2);
  return query select true, '已移轉'::text,
    v_from_name || ' → ' || v_to_name || '，NT$ ' ||
    to_char(coalesce(f.amount, 0), 'FM999,999,999') || '，' ||
    to_char(p_on, 'YYYY-MM-DD') || '。錢沒有實際進出,兩邊備註都已註記' ||
    case when v_short > 0
         then '。★ ' || v_to_name || ' 還差 NT$ ' ||
              to_char(v_short, 'FM999,999,999') || ' —— 目前是「收部分」,請到押金收款補收'
         else '' end;
end $fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('209_transfer_partial');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了什麼:第 ③ 列問的是「有幾筆押金」，
--   而這支一列資料都不動，跑前跑後必須一樣。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 舊的「金額不同一律擋」拿掉了',
         (select case when d like '%金額不同,不能移轉%'
                      then '⚠⚠⚠ 還在 —— 押金變貴還是移不了'
                      when d like '%目的的押金比較少,會超收%'
                      then '✅ 換成只擋「目的比較便宜」'
                      else '⚠⚠ 兩句都找不到 —— 函式可能沒更新' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname = 'transfer_deposit') z),
         '★ 前端 lib/deposit-transfer.ts 同一天改成同一條規則（有測試）。'
           || '★★ 兩邊都要改 —— 前端只擋得住畫面那條路'

  union all
  select 2, '★★ ② 其他檢查一條都沒少',
         (select case when d like '%來源還沒收到押金%'
                       and d like '%目的已經收過一部分押金了%'
                       and d like '%幣別不同%'
                       and d like '%多幣別明細不同%'
                       and d like '%deposit_payments%'
                      then '✅ 六道檢查與寫入都在'
                      else '⚠⚠⚠ 有東西掉了 —— 逐字比對線上版本' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname = 'transfer_deposit') z),
         '★★★ 這支是逐字照抄線上版本再改一段。少一道檢查的話，'
           || '**移轉會放行本來該擋的情況**，而那不會有人發現'

  union all
  select 3, '★★★ ③ 一列押金都沒被動到',
         (select count(*)::text || ' 筆押金　／　'
                 || (select count(*) from public.deposit_payments)::text || ' 筆收款'
            from public.deposits),
         '★★★ 這支**只改函式**，不碰任何一列資料。兩個數字跑前跑後必須一樣'

  union all
  select 4, '④ 目前有幾筆是「收部分」',
         (select count(*)::text || ' 筆'
            from public.deposits
           where coalesce(received_amount, 0) > 0
             and received_on is null
             and returned_on is null),
         '★ 這是改完之後移房會產生的那種狀態。現在的數字留著對照 —— '
           || '之後移一次房，這裡應該多一筆'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
