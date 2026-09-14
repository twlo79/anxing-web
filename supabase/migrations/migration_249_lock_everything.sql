/*
 * migration_249_lock_everything.sql　2026-09-14
 * 關帳＝真的鎖住：月租單不再放行，收款與押金一起鎖，開帳權限收到會計
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 2026-09-14：一張 2026-08 的月租單（LT_3A3_202608，曾信閎）在關帳之後
 * 被改了三次 —— 收款、取消、再取消。**每一次都成功了。**
 *
 * 原因是 `orders_period_lock_guard()` 的第一條就是:
 *
 *     if coalesce(old.imported_via, '') = 'contract' then return …;
 *
 * 月租單無條件放行，不管那個月關了沒。
 *
 * ★ 那條當初是使用者指定的，理由也寫在 223 的註解裡:
 *   「它會隨契約重算，鎖了的話『改契約』會在舊月份上失敗，
 *     而訊息跟契約無關。」 —— 那個顧慮**是真的**，這支不能直接把它刪掉了事。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 怎麼同時做到「鎖死」跟「契約還改得動」】
 *
 * 分開「誰在改」:
 *
 *     人直接改那張訂單　　→ 擋，而且講人話
 *     產生器連帶重算　　　→ 不寫，但記一筆（不要害整張契約存不了）
 *
 * 靠 `pg_trigger_depth()` 分辨（migration_243 用過同一招）:
 *
 *     深度 1  =  有人直接 update orders
 *     深度 ≥2 =  是別的觸發器叫起來的
 *                （改契約 → contracts 的觸發器 → gen_contract_orders
 *                  → update orders，這時深度是 2）
 *
 * ★ 所以「九月改契約」不會再回頭改八月的月租單 ——
 *   那些改動會躺在 `order_lock_pending` 等人決定，
 *   而契約本身存得進去。
 *
 * ★★ migration_247 的 `trg_contract_purpose_propagate` 也走這條 ——
 *   之前我提過「九月勾安幸辦公室會讓八月的報表數字變」，
 *   這支之後就不會了。已關帳月份要一起改的話，先開帳。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 收款與押金也要鎖，而且是**非鎖不可**】
 *
 * 只鎖 orders 的話有一條側門，而且走過去會**把資料弄成不一致**:
 *
 *     刪掉一筆 order_payments
 *       → migration_84 的觸發器 update orders.paid_amount
 *       → 那個 update 深度 ≥2 → 依上面的規則靜默跳過
 *       → **收款紀錄沒了，合計還留著**
 *
 * 那比不鎖還糟。所以在源頭擋。
 *
 * ★ 押金（deposits）分兩組欄位判斷:
 *     received_%  用**收款月**判斷 —— 收了就不能改
 *     returned_%  用**退還月**判斷 —— 退押金是之後才發生的事，
 *                 拿收款月去擋的話押金永遠退不了
 *   其餘欄位跟著收款月。
 *
 * ★★ 用 jsonb 比對欄位名，不寫死欄位清單 ——
 *   之後 deposits 多一欄 `received_note`，這支不用回來改
 *   （README 坑 F：白名單要用「性質」列，不要用「名字」列）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 這支**不**碰的兩件事，刻意的】
 *
 * ① `orders` 的 **INSERT** 不擋。
 *    Airbnb 每日同步會補建舊訂單，擋下來的話那些資料會**靜默消失**
 *    （系統路徑是 return null）。而使用者這次要防的是「改」。
 *    要連補建都擋的話是另一個決定，那時要先想好同步失敗怎麼被看見。
 *    ★ `order_payments` 與 `deposits` 的 INSERT **有擋** ——
 *      沒有任何同步在寫那兩張表，而「在已關帳的月份補一筆收款」
 *      正是這次要防的那件事。
 *
 * ② 支出、請款、房務**沒有**關帳守衛。
 *    它們的「算哪個月」規則各不相同（支出看付款日、請款看核准日…），
 *    一次定五種容易定錯，而定錯不會報錯。另一支再做。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop table if exists public._m249_test;
create table public._m249_test (ord int, name text, detail text, verdict text);

-- ══════════════════════════════════════════════════════════
-- ① 訂單：拿掉月租單的例外，改用「誰在改」來分
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
  /*
   * ★★★ 2026-09-14：這裡原本是「月租單一律放行」。
   *   結果 2026-08 關帳之後，一張 LT_ 月租單被改了三次都成功。
   *   現在月租單跟其他訂單**一視同仁**，差別移到下面的
   *   `pg_trigger_depth()` —— 擋的是「人」，不是「哪一種單」。
   */

  -- 沒有退房日就判不出月份 —— 放行，不要用猜的鎖人
  if old.checkout is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_ym := to_char(old.checkout, 'YYYYMM');
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- ── 這個月鎖住了 ──────────────────────────────────────

  /*
   * ★★★ 人直接改這張訂單 → 擋下來，而且**講人話**。
   *
   *   深度 1 才算「直接」。深度 ≥2 是產生器連帶重算的
   *   （改契約 → gen_contract_orders → update orders），
   *   在那裡丟例外的話**整張契約存不了**，而錯誤訊息會講訂單 ——
   *   那正是 223 當初開放行例外要避免的事。
   */
  if v_uid is not null and pg_trigger_depth() <= 1 then
    raise exception '% 已經關帳，這張訂單改不動。要改的話請會計到權限管理 → 關帳，把那個月打開。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  /*
   * ★★★ 其餘一律**不寫，但記一筆**:
   *     產生器重算（深度 ≥2）、Airbnb 同步、匯入、SQL Editor。
   *   直接放行的話關帳形同虛設；直接擋的話改契約與每日同步會整個失敗。
   */
  if tg_op = 'DELETE' then
    insert into public.order_lock_pending (order_id, ym, changes)
    values (old.id, v_ym, jsonb_build_object('_刪除', to_jsonb(old)));
    return null;                       -- 不刪
  end if;

  oj := to_jsonb(old);
  nj := to_jsonb(new);
  for k in select jsonb_object_keys(nj) loop
    if oj -> k is distinct from nj -> k then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_array(oj -> k, nj -> k));
    end if;
  end loop;

  -- ★ 沒有實際變動就安靜跳過。產生器每次改契約都會重跑一遍所有月份，
  --   值一樣也記一筆的話，待處理清單會被洗到沒人看
  if v_diff = '{}'::jsonb then return null; end if;

  insert into public.order_lock_pending (order_id, ym, changes)
  values (old.id, v_ym, v_diff);
  return null;                         -- ★ 不改
end $fn$;

comment on function public.orders_period_lock_guard() is
  '關帳後訂單改不動（migration_223，249 拿掉月租單例外）。'
  '★ 人直接改 → 丟例外；產生器重算／同步／匯入 → 不寫但記進 order_lock_pending。'
  '★★ 分辨靠 pg_trigger_depth()：深度 1 是人，深度 ≥2 是別的觸發器叫起來的。';

drop trigger if exists trg_orders_period_lock on public.orders;
create trigger trg_orders_period_lock
  before update or delete on public.orders
  for each row execute function public.orders_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- ② 分筆收款：在源頭擋
--
-- ★★★ 不擋的話會**製造不一致**：刪掉收款 → migration_84 的觸發器
--    去 update orders.paid_amount → 那個 update 深度 ≥2 → 被靜默跳過
--    → 收款紀錄沒了、合計還留著。比不擋還糟。
--
-- ★ 這裡一律 raise（不走 pending）—— 沒有任何同步在寫這張表，
--   而錢的紀錄寧可大聲失敗，也不要安靜地不見。
-- ══════════════════════════════════════════════════════════
create or replace function public.order_payments_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_oid uuid := coalesce(new.order_id, old.order_id);
  v_co  date;
  v_ym  text;
begin
  select o.checkout into v_co from public.orders o where o.id = v_oid;
  if v_co is null then return case when tg_op = 'DELETE' then old else new end; end if;

  v_ym := to_char(v_co, 'YYYYMM');
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception '% 已經關帳，這張單的收款紀錄動不了（新增／修改／刪除都不行）。要改的話請會計到權限管理 → 關帳，把那個月打開。',
    substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
    using errcode = 'check_violation';
end $fn$;

comment on function public.order_payments_period_lock_guard() is
  '關帳後分筆收款動不了（migration_249）。'
  '★ 月份看**它掛的那張訂單的退房日**，跟 orders 的守衛同一個依據 —— '
  '用 paid_on 的話，補登一筆跨月的收款會用不同的標準判斷。';

drop trigger if exists trg_order_payments_period_lock on public.order_payments;
create trigger trg_order_payments_period_lock
  before insert or update or delete on public.order_payments
  for each row execute function public.order_payments_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- ③ 押金：收的那組用收款月，退的那組用退還月
--
-- ★★ 一律用收款月的話，八月收的押金在九月**退不了** ——
--    而退押金是每天在發生的正常動作。
--
-- ★ 欄位用 jsonb 前綴比對，不寫死清單（README 坑 F）。
-- ══════════════════════════════════════════════════════════
create or replace function public.deposits_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  oj jsonb; nj jsonb; k text;
  hit_recv boolean := false;   -- 動到「收」那組
  hit_ret  boolean := false;   -- 動到「退」那組
  ym_recv  text;
  ym_ret   text;
  blocked  text;
begin
  oj := to_jsonb(coalesce(old, new));
  ym_recv := nullif(left(coalesce(oj ->> 'received_on', ''), 7), '');
  ym_recv := case when ym_recv is null then null else replace(ym_recv, '-', '') end;

  if tg_op = 'DELETE' then
    -- 刪整筆押金 = 連「收」一起刪，所以看收款月
    if ym_recv is not null and public.is_period_locked(ym_recv) then
      blocked := ym_recv;
    end if;
  else
    nj := to_jsonb(new);
    for k in select jsonb_object_keys(nj) loop
      if oj -> k is distinct from nj -> k then
        if k like 'received%' then hit_recv := true;
        elsif k like 'returned%' then hit_ret := true;
        else hit_recv := true;   -- 其餘欄位（金額、房號、備註…）跟著收款月
        end if;
      end if;
    end loop;

    if tg_op = 'INSERT' then hit_recv := true; end if;

    ym_ret := nullif(left(coalesce(nj ->> 'returned_on', oj ->> 'returned_on', ''), 7), '');
    ym_ret := case when ym_ret is null then null else replace(ym_ret, '-', '') end;

    if hit_recv and ym_recv is not null and public.is_period_locked(ym_recv) then
      blocked := ym_recv;
    elsif hit_ret and ym_ret is not null and public.is_period_locked(ym_ret) then
      blocked := ym_ret;
    end if;
  end if;

  if blocked is not null then
    raise exception '% 已經關帳，這筆押金動不了。要改的話請會計到權限管理 → 關帳，把那個月打開。',
      substr(blocked, 1, 4) || '-' || substr(blocked, 5, 2)
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

comment on function public.deposits_period_lock_guard() is
  '關帳後押金動不了（migration_249）。'
  '★ 收的那組欄位（received_%）看**收款月**，退的那組（returned_%）看**退還月** —— '
  '一律用收款月的話，八月收的押金在九月退不了，而退押金是正常動作。';

drop trigger if exists trg_deposits_period_lock on public.deposits;
create trigger trg_deposits_period_lock
  before insert or update or delete on public.deposits
  for each row execute function public.deposits_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- ④ 開帳權限收到會計（使用者 2026-09-14 指定）
--
-- 讀　照舊三種（會計、主管、super_admin）—— 主管看得到哪幾個月關了
-- 寫　只有會計與 super_admin
--
-- ★ 留著 super_admin 是因為會計請假或離職時，
--   不然沒有任何人開得了帳，而那時候誰也修不了帳。
-- ══════════════════════════════════════════════════════════
drop policy if exists period_lock_write on public.period_lock;
create policy period_lock_write on public.period_lock
  for all using (
    current_role_of() = any (array['accountant','super_admin'])
  ) with check (
    current_role_of() = any (array['accountant','super_admin'])
  );

comment on table public.period_lock is
  '關帳紀錄，一個月一列（migration_223）。'
  '★ `locked=false` 而且 `reopened_at` 有值 = 被人手動打開過 —— '
  '排程**不會**把它自動關回去，不然會計正在改就被鎖住。'
  '★★ 開帳與關帳只有**會計與 super_admin**（migration_249，使用者指定）。'
  '主管看得到但改不動。';

-- ══════════════════════════════════════════════════════════
-- ⑤ 實測 —— 真的去撞一次，然後整段退掉
--
-- ★★★ README 第 3.5 條：自檢要**呼叫**它在檢查的那個東西。
--    查 pg_trigger 裝上了沒，只證明它存在，不證明它會擋。
--
-- ★ SQL Editor 裡 `auth.uid()` 是 null，所以 orders 走的是
--   「不寫但記一筆」那條，不會丟例外 —— 所以這裡驗的是
--   **值有沒有被改掉**，不是有沒有報錯。
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_ym   text;
  v_ord  public.orders.id%type;
  v_was  boolean; v_now boolean;
  v_pay  int := 0;
  ok_ord boolean := false;
  ok_pay boolean := null;
  v_err  text := '';
  v_note text := '';
begin
  -- 挑一個「已關帳、而且底下有月租單」的月份 —— 這次要修的就是這種
  select p.ym into v_ym
    from public.period_lock p
   where p.locked
     and exists (select 1 from public.orders o
                  where o.imported_via = 'contract'
                    and o.checkout is not null
                    and to_char(o.checkout, 'YYYYMM') = p.ym)
   order by p.ym desc
   limit 1;

  if v_ym is null then
    insert into public._m249_test values
      (5, '⑤ 守衛實測', '找不到「已關帳且有月租單」的月份，測不了', '⚠ 沒測到');
    return;
  end if;

  select o.id, o.paid into v_ord, v_was
    from public.orders o
   where o.imported_via = 'contract'
     and o.checkout is not null
     and to_char(o.checkout, 'YYYYMM') = v_ym
   limit 1;

  begin
    -- (a) 訂單：翻 paid，看守衛有沒有把它擋下來
    update public.orders set paid = not v_was where id = v_ord;
    select o.paid into v_now from public.orders o where o.id = v_ord;
    ok_ord := (v_now = v_was);          -- 沒被改掉 = 擋住了

    -- (b) 分筆收款：塞一筆進去，看會不會被拒絕
    begin
      insert into public.order_payments (order_id, paid_on, amount, method)
      values (v_ord, (v_ym || '01')::date, 1, 'cash');
      ok_pay := false;                  -- 插進去了 = 沒擋住
    exception when others then
      /*
       * ★★ 只有**守衛丟的那顆**才算擋住。
       *   少填一個 not null 欄位也會進到這裡 ——
       *   一律當成 true 的話，這一條會在守衛根本沒裝的情況下也顯示綠燈
       *   （README §2.5：母體圈錯，而 0 看起來像成功）。
       */
      v_note := sqlerrm;
      ok_pay := (sqlerrm like '%已經關帳%');
    end;

    raise exception 'M249_ROLLBACK';
  exception when others then
    -- ★ 自己丟的那顆吞掉（它的任務就是把上面的改動退乾淨）
    if sqlerrm <> 'M249_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into public._m249_test values
    (5, '⑤ 守衛實測（' || v_ym || '，改完已退掉）',
     '月租單擋住了：' || coalesce(ok_ord::text, '沒測到')
       || '　分筆收款擋住了：' || coalesce(ok_pay::text, '沒測到')
       || case when v_note <> '' then '（' || left(v_note, 60) || '）' else '' end
       || case when v_err <> '' then '　錯誤：' || v_err else '' end,
     case when ok_ord and coalesce(ok_pay, false) then '✅ 兩支都擋得住'
          else '❌ 有一支擋不住' end);
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('249_lock_everything');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 三支守衛都裝上了',
         coalesce((select string_agg(t.tgname, '　' order by t.tgname)
                     from pg_trigger t
                    where not t.tgisinternal
                      and t.tgname in ('trg_orders_period_lock',
                                       'trg_order_payments_period_lock',
                                       'trg_deposits_period_lock')), '（一支都沒有）'),
         case when (select count(*) from pg_trigger t
                     where not t.tgisinternal
                       and t.tgname in ('trg_orders_period_lock',
                                        'trg_order_payments_period_lock',
                                        'trg_deposits_period_lock')) = 3
              then '✅ 三支都在' else '❌ 少了' end

  union all
  /*
   * ★★★ 這一條釘的就是這次的 bug：舊版第一行是
   *   `if coalesce(old.imported_via, '') = 'contract' then return`
   *   —— 月租單無條件放行。掃函式原始碼確認它不見了。
   */
  select 2, '② 月租單的放行例外真的拿掉了',
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'imported_via.*=.*''contract'''
              then '★ 還找得到「imported_via = contract」的放行'
              else '找不到放行例外，改用 pg_trigger_depth() 分辨' end,
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'pg_trigger_depth'
              and not (select prosrc from pg_proc
                        where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'imported_via.*=.*''contract'''
              then '✅ 拿掉了，而且改用深度判斷' else '❌ 沒改到' end

  union all
  select 3, '③ 開帳權限只剩會計與 super_admin',
         coalesce((select pg_get_expr(p.polqual, p.polrelid) from pg_policy p
                    where p.polrelid = 'public.period_lock'::regclass
                      and p.polname = 'period_lock_write'), '（沒有這條 policy）'),
         case when (select pg_get_expr(p.polqual, p.polrelid) from pg_policy p
                     where p.polrelid = 'public.period_lock'::regclass
                       and p.polname = 'period_lock_write') ~ 'accountant'
               and (select pg_get_expr(p.polqual, p.polrelid) from pg_policy p
                     where p.polrelid = 'public.period_lock'::regclass
                       and p.polname = 'period_lock_write') !~ 'manager'
              then '✅ 主管已排除' else '❌ 條件不對' end

  union all
  select 4, '④ 目前哪幾個月是鎖著的',
         coalesce((select string_agg(p.ym || case when p.auto then '(自動)' else '(手動)' end,
                                     '　' order by p.ym)
                     from public.period_lock p where p.locked), '（一個月都沒關）'),
         case when exists (select 1 from public.period_lock where locked)
              then '✅ 有關帳紀錄' else '⚠ 一個月都沒關 —— 守衛裝了也擋不到東西' end

  union all
  select t.ord, t.name, t.detail, t.verdict from public._m249_test t

  union all
  /*
   * ★ 改契約會不會被這支害到:已關帳月份、而且**未收款**的月租單
   *   才是產生器會去動的（已收款的它本來就不碰）。
   *   有的話那些改動會進 order_lock_pending，不是消失。
   */
  select 6, '⑥ 改契約時可能被擋下來的月租單',
         (select count(*) from public.orders o
           join public.period_lock p on p.ym = to_char(o.checkout, 'YYYYMM') and p.locked
          where o.imported_via = 'contract' and not o.paid)::text
         || ' 張（已關帳、未收款）——'
         || '產生器要改它們的時候會記進 order_lock_pending，不會消失，也不會害契約存不了',
         '✅ 已知，記進待處理清單'

  union all
  select 7, '⑦ 目前待處理的異動',
         (select count(*) from public.order_lock_pending where not resolved)::text || ' 筆未處理',
         '✅ 參考（訂單頁看得到差異）'

  union all
  select 8, '⑧ 收尾',
         '核對完請執行：drop table public._m249_test;',
         '⚠ 記得清掉這張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
