-- migration_157：加費從押金扣除 ＋ 押金退掉之後鎖住
--
-- ============================================================
-- 【要做什麼】（2026-08-22 使用者指定）
--
-- 房客退房時扣了 100 元清潔費:
--
--     押金        10,000
--     加費 清潔費   −100
--     ──────────────────
--     應退          9,900   ← 用這個金額送退款審核
--
-- 退款完成後:押金那筆記「已退 10,000」（全額結清），
-- 其中 9,900 退現金、100 轉成營收。
--
--
-- ============================================================
-- 【為什麼是一筆資料，不是兩筆】
--
-- 訂單的加費本來就是 orders 的子單（source='oneoff'、parent_order_id）。
-- 要能從押金扣，只要在那張子單上多一個 deposit_id。
--
--   押金頁   列 orders where deposit_id = 這筆押金 → 扣款明細
--   訂單頁   本來就看得到那張子單，多顯示「從押金扣除」
--   營收     不用做任何事 —— oneoff 子單本來就進營收報表
--
-- 做成兩張表的話，兩邊各記一次，總有一天對不起來 ——
-- 而對不起來的那天，你只會看到「押金明細加起來跟營收不一樣」。
--
--
-- ============================================================
-- 【為什麼要鎖】（使用者指定「把已退押金的訂單鎖住，其他單也是」）
--
-- 押金退掉 = 這筆生意結清。之後再改訂單金額或加費，
-- 帳上已經結清的數字就會跟著變，而錢早就匯出去了。
--
-- 跟請款單「出款日填了就不能改」是同一條原則:錢動了就不能回頭改。
--
-- ★ 解鎖:會計 ＋ super_admin。
--   完全鎖死的話，打錯一個字就只能請人下 SQL —— 那不是安全，是不方便。
--
-- ★ 後端（匯入排程）不擋 —— 見 order_locked_reason() 的說明。
--
--
-- ============================================================
-- 【影響範圍】（跑之前查過）
--   已退押金 7 筆、會鎖住 7 張訂單、0 張契約，全部在近 90 天內。
-- ============================================================


-- ── ① 加費掛到押金 ─────────────────────────────────
alter table public.orders
  add column if not exists deposit_id uuid
    references public.deposits(id) on delete set null;

/*
 * on delete set null:押金整筆被刪掉時，加費留著變成一般的一次性收入。
 * cascade 的話會連營收一起刪掉 —— 那筆錢是真的收到了，不該消失。
 */

create index if not exists orders_deposit_id_idx
  on public.orders(deposit_id) where deposit_id is not null;

comment on column public.orders.deposit_id is
  '這筆加費從哪筆押金扣。押金頁靠它算應退小計（migration_157）。';


-- ── ①-2 送審時要記下退多少 ─────────────────────────
/*
 * ★★ 沒有這欄的話「核可金額」不存在。
 *
 * 現在的退款審核只寫 refund_status='pending'，**沒有記金額** ——
 * 因為以前一律退全額，金額就是 deposits.amount，不用記。
 *
 * 有了加費之後不成立:主管核的是 9,900，而 amount 還是 10,000。
 * 不記下來的話:
 *
 *   · 核可紀錄上查不到他到底核了多少
 *   · 核完之後加費被改動，沒有東西可以比對
 *   · 確認退款時不知道該匯多少（只能當場再算一次，而算式改了就對不上）
 *
 * null = 舊資料或還沒送審 → 一律視為全額（見前端的 ?? amount）。
 * 回填成 amount 也可以，但那會讓「沒送過審」跟「核可全額」分不出來。
 */
alter table public.deposits
  add column if not exists refund_amount numeric;

comment on column public.deposits.refund_amount is
  '送審當下的應退金額 = 押金 − 加費合計。null = 還沒送審（視為全額）。'
  '主管核的是這個數字，不是 amount（migration_157）。';


-- ── ② 這張訂單為什麼被鎖 ───────────────────────────
/*
 * 回傳鎖定原因，null 表示沒鎖。
 *
 * 三條路都要看 —— 少一條就會有一種漏網的改法:
 *   1. 這張單自己的押金退了
 *   2. 這是加費子單，母訂單的押金退了
 *   3. 這是加費子單，它扣的那筆押金退了（可能不是母訂單那筆）
 */
create or replace function public.order_locked_reason(p_order uuid)
returns text language sql stable security definer set search_path to 'public'
as $function$
  select '押金已於 ' || to_char(max(d.returned_on), 'YYYY-MM-DD') || ' 退還，此單已結清'
    from public.orders o
    join public.deposits d
      on d.order_id = o.id
      or d.order_id = o.parent_order_id
      or d.id       = o.deposit_id
   where o.id = p_order
     and d.returned_on is not null
  having count(*) > 0;
$function$;


create or replace function public.orders_lock_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_reason text;
  v_role   text := public.current_role_of();
begin
  /*
   * ★★ 後端不擋。
   *
   * 匯入排程用 service key 連線，沒有 auth.uid()，current_role_of() 是 null。
   * 這裡放行是**刻意的**:Airbnb 每晚同步會 update 既有訂單，
   * 擋下來的話整批匯入會中斷，而症狀是「昨天的訂單沒進來」——
   * 沒有人會聯想到是押金退款造成的。
   *
   * 代價要知道:任何拿到 service key 的程式都繞得過這道。
   * 這道是**防手滑，不是防惡意** —— 真正的權限在 RLS。
   */
  if v_role is null then return coalesce(new, old); end if;

  -- 會計與總管理員可以改。打錯一個字不該只能請人下 SQL。
  if v_role in ('accountant', 'super_admin') then return coalesce(new, old); end if;

  v_reason := public.order_locked_reason(coalesce(old.id, new.id));
  if v_reason is not null then
    /*
     * ★ 訊息要講出**為什麼**與**怎麼辦**。
     *   只說「不能修改」的話，使用者只會看到畫面沒反應
     *   （2026-08-19「主管按確認沒反應」查了一整天,就是擋阻不講話）。
     */
    raise exception '%。要修改請洽會計或總管理員。', v_reason
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $function$;

drop trigger if exists trg_orders_lock_guard on public.orders;
create trigger trg_orders_lock_guard
  before update or delete on public.orders
  for each row execute function public.orders_lock_guard();


-- ── ③ 加費本身的防呆 ───────────────────────────────
create or replace function public.order_fee_deposit_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  d       public.deposits%rowtype;
  v_used  numeric;
begin
  if new.deposit_id is null then return new; end if;

  select * into d from public.deposits where id = new.deposit_id;
  if not found then
    raise exception '找不到這筆押金' using errcode = 'check_violation';
  end if;

  -- 已經退掉的押金不能再掛新的加費 —— 錢已經匯出去了，扣不到
  if d.returned_on is not null then
    raise exception '這筆押金已於 % 退還，不能再從它扣款。', d.returned_on
      using errcode = 'check_violation';
  end if;

  /*
   * ★ 加費合計不能超過押金。
   *   超過的話應退會變成負數 —— 而負數的退款單沒有人看得懂，
   *   只會變成一張卡在待審核裡沒有人敢按的單子。
   *
   *   排除自己那一列（update 時），不然會把舊值算兩次。
   */
  select coalesce(sum(o.amount), 0) into v_used
    from public.orders o
   where o.deposit_id = new.deposit_id
     and o.id <> new.id;

  if v_used + new.amount > d.amount then
    raise exception
      '加費合計 % 超過押金 %（這筆 %，已有 %）。應退不能是負數。',
      v_used + new.amount, d.amount, new.amount, v_used
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

drop trigger if exists trg_order_fee_deposit_guard on public.orders;
create trigger trg_order_fee_deposit_guard
  before insert or update of deposit_id, amount on public.orders
  for each row execute function public.order_fee_deposit_guard();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('157_deposit_fee');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ orders.deposit_id' as "檢查項目",
         count(*)::text || ' / 1' as "結果",
         case when count(*) = 1 then '✅ 加費掛得上押金了' else '❌' end as "說明"
    from information_schema.columns
   where table_schema = 'public'        -- 少了它，其他 schema 的同名表會誤報
     and table_name = 'orders' and column_name = 'deposit_id'

  union all
  select 2, '★★ 兩道觸發器', count(*)::text || ' / 2',
         case when count(*) = 2 then '✅ 鎖定 ＋ 加費防呆' else '❌ 沒建起來' end
    from pg_trigger
   where tgrelid = 'public.orders'::regclass
     and tgname in ('trg_orders_lock_guard', 'trg_order_fee_deposit_guard')

  union all
  /*
   * ★★ 這一項是重點:既有的 7 張真的鎖住了嗎。
   *   數字對不上就表示 order_locked_reason 的三條路少寫了一條。
   */
  select 3, '★★ 已鎖住的訂單',
         count(*)::text || ' 張',
         case when count(*) >= 1
              then '✅ 跟跑之前查到的 7 張對照'
              else '⚠ 一張都沒有 —— 跟預期的 7 張不符' end
    from public.orders o
   where public.order_locked_reason(o.id) is not null

  union all
  /*
   * ★ 既有的加費一筆都不該被掛上押金。
   *   這支只加欄位，沒有回填 —— 從押金扣是使用者的動作，不是系統猜的。
   */
  select 4, '★ 既有加費未被動到',
         count(*)::text || ' 筆掛了押金',
         case when count(*) = 0 then '✅ 這支不回填，掛押金是人按的'
              else '❌ 不該有值' end
    from public.orders where deposit_id is not null

  union all
  select 5, '★★ deposits.refund_amount',
         count(*)::text || ' / 1',
         case when count(*) = 1 then '✅ 送審記得下核可金額' else '❌ 沒建起來' end
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deposits'
     and column_name = 'refund_amount'

  union all
  select 6, '鎖定的樣子',
         coalesce((select public.order_locked_reason(o.id)
                     from public.orders o
                    where public.order_locked_reason(o.id) is not null
                    limit 1), '（目前沒有鎖住的單）'),
         '非會計的人改這張單時會看到這句話'

) v order by ord;
