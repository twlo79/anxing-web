/*
 * migration_251_lock_ym_by_checkin.sql　2026-09-14
 * 月租單算哪個月：看**期別起日**，不是退房日
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 249／250 上線之後，使用者關了 2026-08，收租畫面上八月那一期
 * **還是能改**：「沒鎖阿」。
 *
 * 守衛算的是退房日，而月租單的期間是**租約的月**，不是日曆月：
 *
 *     第 1 期　　 2026/8/25 ~ 2026/9/24
 *     order_key　 LT_3A3_202608      ← 單號說它是八月的
 *     checkin　 　2026-08-25
 *     checkout　  2026-09-25         ← 但退房日在**九月**
 *
 * → 守衛算出 202609，而關的是 202608，於是一路放行。
 *
 * ★★ 這不是「鎖壞了」，是**月份的定義錯了**。
 *   249 的自檢第 ⑤ 條還是綠的 —— 它挑到的是另一張
 *   （期間 7/25~8/25、退房日剛好落在八月的）月租單。
 *   自檢驗的是「擋不擋得住」，沒有驗「算的是不是**那一期**」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼是 checkin 而不是別的】
 *
 * `gen_contract_orders()` 組鍵的方式是
 *
 *     ymtxt := to_char(p_start, 'YYYYMM');
 *     k     := 'LT_' || ct.room || '_' || ymtxt;
 *     … values (k, …, p_start /* checkin */, p_end /* checkout */, …)
 *
 * 也就是 **`checkin` 的月份 ≡ `order_key` 尾巴的 YYYYMM**。
 * 所以這不是另外發明一套算法，是「單號說它屬於哪個月」。
 *
 * ★ 短租**照舊看退房日** —— 住完才算收入，那條沒有問題。
 *
 * ★★★ 代價要講清楚:一期跨兩個月時（8/25~9/24），營收認列是
 *   **兩個月各算一部分**，而關帳只把它歸到一個月。
 *   關八月 → 整期鎖住；關九月 → 這一期不受影響。
 *   以「使用者看到的那張卡是第幾期」為準，因為他要鎖的就是那張卡。
 *
 * ★ 前端那份在 `lib/period-lock.ts` 的 `lockYmOf()`，兩邊必須一模一樣 ——
 *   不一樣的話會出現「畫面說鎖住、資料庫放行」或反過來（README 坑 A）。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop table if exists public._m251_test;
create table public._m251_test (ord int, name text, detail text, verdict text);

-- ══════════════════════════════════════════════════════════
-- ① 一支函式決定「這張單算哪個月」
--
-- ★★ 三支守衛都叫它。各自寫一次 `case when imported_via …` 的話，
--    哪天規則變了會改到兩支、漏掉一支 —— 而漏掉的那支不會報錯。
-- ══════════════════════════════════════════════════════════
create or replace function public.order_lock_ym(o public.orders)
returns text
language sql
immutable
as $fn$
  select to_char(
    case when coalesce(o.imported_via, '') = 'contract'
         then o.checkin      -- 月租單:期別起日（≡ order_key 尾巴的 YYYYMM）
         else o.checkout     -- 短租:退房日（住完才算收入）
    end, 'YYYYMM');
$fn$;

comment on function public.order_lock_ym(public.orders) is
  '這張訂單關帳時算哪個月（migration_251）。'
  '★ 月租單看 checkin —— 它的月份跟 order_key 尾巴的 YYYYMM 一定相同；'
  '退房日會落到下個月（第 1 期 8/25~9/24 的 checkout 是 9/25）。'
  '★★ 短租看 checkout。前端那份在 lib/period-lock.ts 的 lockYmOf()。';

-- ══════════════════════════════════════════════════════════
-- ② 訂單守衛改用它（其餘一字未動）
-- ══════════════════════════════════════════════════════════
create or replace function public.orders_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_ym   text;
  v_uid  uuid := auth.uid();
  v_diff jsonb := '{}'::jsonb;
  k      text;
  oj     jsonb;
  nj     jsonb;
begin
  -- ── INSERT：只擋帶 contract_id 的（加費、折讓）。同步補建的沒有那一欄 ──
  if tg_op = 'INSERT' then
    if new.contract_id is null then return new; end if;
    v_ym := public.order_lock_ym(new);
    if v_ym is null then return new; end if;
    if not public.is_period_locked(v_ym) then return new; end if;
    if public.has_period_unlock(v_ym, null, new.contract_id) then return new; end if;
    raise exception '% 已經關帳，加不了費用也記不了折讓。要加的話請會計在那一期按「開鎖」。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  -- 判不出月份就放行，不要用猜的鎖人
  v_ym := public.order_lock_ym(old);
  if v_ym is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- 會計在畫面上開過鎖 → 放行（migration_250）
  if public.has_period_unlock(v_ym, old.id, old.contract_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- 人直接改這張訂單 → 擋下來，而且講人話
  if v_uid is not null and pg_trigger_depth() <= 1 then
    raise exception '% 已經關帳，這張訂單改不動。要改的話請會計在那一期按「開鎖」。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  -- 產生器重算／同步／匯入 → 不寫，但記一筆
  if tg_op = 'DELETE' then
    insert into public.order_lock_pending (order_id, ym, changes)
    values (old.id, v_ym, jsonb_build_object('_刪除', to_jsonb(old)));
    return null;
  end if;

  oj := to_jsonb(old);
  nj := to_jsonb(new);
  for k in select jsonb_object_keys(nj) loop
    if oj -> k is distinct from nj -> k then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_array(oj -> k, nj -> k));
    end if;
  end loop;
  if v_diff = '{}'::jsonb then return null; end if;

  insert into public.order_lock_pending (order_id, ym, changes)
  values (old.id, v_ym, v_diff);
  return null;
end $fn$;

drop trigger if exists trg_orders_period_lock on public.orders;
create trigger trg_orders_period_lock
  before insert or update or delete on public.orders
  for each row execute function public.orders_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- ③ 分筆收款守衛也走同一支
-- ══════════════════════════════════════════════════════════
create or replace function public.order_payments_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_oid uuid := coalesce(new.order_id, old.order_id);
  v_o   public.orders;
  v_ym  text;
begin
  select * into v_o from public.orders o where o.id = v_oid;
  if not found then return case when tg_op = 'DELETE' then old else new end; end if;

  v_ym := public.order_lock_ym(v_o);
  if v_ym is null then return case when tg_op = 'DELETE' then old else new end; end if;
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if public.has_period_unlock(v_ym, v_oid, v_o.contract_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception '% 已經關帳，這張單的收款紀錄動不了。要改的話請會計在那一期按「開鎖」。',
    substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
    using errcode = 'check_violation';
end $fn$;

drop trigger if exists trg_order_payments_period_lock on public.order_payments;
create trigger trg_order_payments_period_lock
  before insert or update or delete on public.order_payments
  for each row execute function public.order_payments_period_lock_guard();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('251_lock_ym_by_checkin');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
--
-- ★★★ 這次**一定要挑跨月的那種**去測。249 的自檢就是挑到一張
--    退房日剛好落在同一個月的月租單，所以一路綠燈而 bug 還在。
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_ym text; v_ord public.orders.id%type; v_key text;
  v_ci date; v_co date; v_was boolean; v_now boolean;
  ok_block boolean := false; v_err text := '';
begin
  select p.ym into v_ym from public.period_lock p where p.locked
   order by p.ym desc limit 1;
  if v_ym is null then
    insert into public._m251_test values
      (4, '④ 跨月月租單實測', '沒有任何月份關帳，測不了', '⚠ 沒測到');
    return;
  end if;

  /*
   * ★ 條件就是這次的病灶:**退房日在別的月**、而期別起日在已關帳的月。
   *   舊規則對這種單一律放行。
   */
  select o.id, o.order_key, o.checkin, o.checkout, o.paid
    into v_ord, v_key, v_ci, v_co, v_was
    from public.orders o
   where coalesce(o.imported_via, '') = 'contract'
     and o.checkin is not null and o.checkout is not null
     and to_char(o.checkin, 'YYYYMM') = v_ym
     and to_char(o.checkout, 'YYYYMM') <> v_ym
   limit 1;

  if v_ord is null then
    insert into public._m251_test values
      (4, '④ 跨月月租單實測',
       v_ym || ' 沒有「期別起日在這個月、退房日在別的月」的月租單', '⚠ 沒測到');
    return;
  end if;

  begin
    update public.orders set paid = not v_was where id = v_ord;
    select o.paid into v_now from public.orders o where o.id = v_ord;
    ok_block := (v_now = v_was);
    raise exception 'M251_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M251_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into public._m251_test values
    (4, '④ 跨月月租單實測（改完已退掉）',
     v_key || '　期別起日 ' || v_ci || '（' || v_ym || '，已關帳）'
       || '　退房日 ' || v_co || '（' || to_char(v_co, 'YYYYMM') || '，沒關）'
       || '　→ 擋住了：' || ok_block
       || case when v_err <> '' then '　錯誤：' || v_err else '' end,
     case when ok_block then '✅ 舊規則會放行的那種，現在擋得住' else '❌ 還是放行' end);
end $do$;

select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① order_lock_ym() 建好了，而且月租單看 checkin',
         coalesce((select pg_get_functiondef(oid) from pg_proc
                    where oid = 'public.order_lock_ym(public.orders)'::regprocedure)
                  ~ 'o\.checkin', false)::text,
         case when (select prosrc from pg_proc
                     where oid = 'public.order_lock_ym(public.orders)'::regprocedure)
                   ~ 'o\.checkin'
              then '✅ 有' else '❌ 沒有' end

  union all
  select 2, '② 兩支守衛都改用它，沒有人自己再算一次',
         coalesce((select string_agg(p.proname::text, '　' order by p.proname)
                     from pg_proc p
                    where p.proname in ('orders_period_lock_guard', 'order_payments_period_lock_guard')
                      and p.prosrc ~ 'order_lock_ym'), '（沒有）'),
         case when (select count(*) from pg_proc p
                     where p.proname in ('orders_period_lock_guard', 'order_payments_period_lock_guard')
                       and p.prosrc ~ 'order_lock_ym') = 2
               -- ★ 還要確認沒有人留著舊的 to_char(old.checkout…) 自己算
               and not exists (select 1 from pg_proc p
                                where p.proname = 'orders_period_lock_guard'
                                  and p.prosrc ~ 'to_char\(old\.checkout')
              then '✅ 兩支都走同一支，沒有殘留的舊算法' else '❌' end

  union all
  /*
   * ★★★ 這一條是「這次的 bug 有幾張單受影響」。
   *   期別起日在已關帳月份、退房日在別的月 —— 舊規則對它們全部放行。
   */
  select 3, '③ 舊規則漏掉的月租單（期別起日已關帳、退房日在別的月）',
         coalesce((select string_agg(g.txt, '　' order by g.ym) from (
            select to_char(o.checkin, 'YYYYMM') as ym,
                   to_char(o.checkin, 'YYYYMM') || '：' || count(*)::text || ' 張' as txt
              from public.orders o
              join public.period_lock p on p.ym = to_char(o.checkin, 'YYYYMM') and p.locked
             where coalesce(o.imported_via, '') = 'contract'
               and o.checkout is not null
               and to_char(o.checkout, 'YYYYMM') <> to_char(o.checkin, 'YYYYMM')
             group by 1) g), '（沒有）')
         || '　←　這些從現在起鎖住了',
         '✅ 參考（數字大小不代表對錯，只是讓你知道影響範圍）'

  union all
  select t.ord, t.name, t.detail, t.verdict from public._m251_test t

  union all
  select 5, '⑤ 收尾',
         '核對完請執行：drop table public._m251_test;',
         '⚠ 記得清掉這張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
