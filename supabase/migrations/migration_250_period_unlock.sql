/*
 * migration_250_period_unlock.sql　2026-09-14
 * 會計在收租畫面「開鎖」——只開這一期、只開給他自己、離開就失效
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不能只用現有的 period_lock】
 *
 * 249 之後，已關帳月份的訂單與收款都動不了 —— 這是對的。
 * 但唯一的出路是「權限管理 → 關帳 → 把整個月打開」，那有兩個問題：
 *
 *   ① 開的是**整個月**。為了改一期租金，那個月**所有人的所有單**
 *      全部跟著開 —— 包含其他契約、短租、押金。
 *   ② 開了要記得關。而 `close_due_periods()` 刻意「被人打開過的不自動關回去」
 *      （理由在 223：不然會計正在改，隔天清晨又被鎖住），
 *      所以**沒有任何東西**會幫他關。忘了就永遠開著，而畫面上看不出來。
 *
 * ★ 使用者 2026-09-14 指定：「改成畫面上會計開鎖才能編輯，
 *   只開這一期，離開這張卡就自動鎖回去。」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這張表是「誰、哪一期、到什麼時候」】
 *
 *     user_id      開鎖的人。**誰開鎖誰才改得動** ——
 *                  會計開了鎖不等於全公司都能改那一期。
 *     order_id     這一期的哪幾張單（一期可能好幾張:季繳、加費）
 *     contract_id  給「新增加費／折讓」用 —— 那時候還沒有 order id
 *     expires_at   兜底。前端會在關視窗時刪掉，但**瀏覽器關掉、
 *                  當機、網路斷**的時候刪不到 ——
 *                  沒有到期時間的話那把鎖就永遠開著，而沒有人知道。
 *
 * ★★ 兩層保險缺一不可:
 *     前端刪除  → 正常情況下立刻失效（使用者感覺是「離開就鎖回去」）
 *     expires_at → 前端沒機會跑的時候，30 分鐘後自己失效
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 順便補 249 的一個洞：加費與折讓的 INSERT】
 *
 * 249 刻意不擋 `orders` 的 INSERT ——
 * Airbnb 每日同步會補建舊訂單，擋下來會**靜默消失**。
 *
 * 但「＋加費」與「折讓」也是 INSERT，而它們**帶著 contract_id**，
 * 同步的那些**永遠沒有**。所以這支只擋「帶 contract_id 的 INSERT」——
 * 切得精準，而且同步那條路一個字都沒碰到。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop table if exists public._m250_test;
create table public._m250_test (ord int, name text, detail text, verdict text);

-- ══════════════════════════════════════════════════════════
-- ① 臨時解鎖
-- ══════════════════════════════════════════════════════════
create table if not exists public.period_unlock (
  id          uuid primary key default gen_random_uuid(),
  /*
   * 開鎖的人。**只有他自己**改得動 —— 開鎖不是把那一期對全公司打開。
   *
   * ★ 可以是 null：SQL Editor 與 service key 的 `auth.uid()` 就是 null。
   *   宣告成 not null 的話，這支自己的自檢插不進去 ——
   *   而「插不進去所以沒測到」是最不該接受的綠燈（README §3.5）。
   *   實務上不影響:走 RLS 的人一定有 uid，而 policy 的
   *   `user_id = auth.uid()` 會把 null 擋掉。
   */
  user_id     uuid default auth.uid(),
  ym          text not null check (ym ~ '^\d{6}$'),
  /** 這一期的哪幾張單。一期可能有好幾張（季繳三張、加費另計） */
  order_id    uuid references public.orders(id) on delete cascade,
  /** 新增加費／折讓時用 —— 那時候還沒有 order id */
  contract_id uuid references public.contracts(id) on delete cascade,
  granted_at  timestamptz not null default now(),
  /*
   * ★★★ 兜底。前端關視窗時會刪掉這一列，但**關瀏覽器、當機、網路斷**
   *   的時候刪不到。沒有到期時間的話那把鎖永遠開著，而畫面上看不出來
   *   —— 那正是 223 那條「打開過的不自動關回去」造成的同一個問題。
   */
  expires_at  timestamptz not null default now() + interval '30 minutes',
  note        text
);

-- ★ 不能寫 `where expires_at > now()` —— now() 不是 IMMUTABLE，
--   部分索引的條件不收它（直接報錯）。整張索引就好，這表本來就很小。
create index if not exists period_unlock_live_idx
  on public.period_unlock (user_id, ym, expires_at);

alter table public.period_unlock enable row level security;

/*
 * ★★★ 只有會計與 super_admin 開得了鎖（使用者 2026-09-14 指定，跟 249 的開帳權限一致）。
 *   主管與管家看得到那顆鎖，但按不動。
 */
do $do$ begin
  create policy period_unlock_read on public.period_unlock
    for select using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy period_unlock_write on public.period_unlock
    for all using (
      current_role_of() = any (array['accountant','super_admin'])
    ) with check (
      current_role_of() = any (array['accountant','super_admin'])
      -- ★ 只能幫**自己**開鎖。少了這一條，會計可以替別人開一把他自己看不到的鎖
      and user_id = auth.uid()
    );
exception when duplicate_object then null; end $do$;

comment on table public.period_unlock is
  '已關帳期別的臨時解鎖（migration_250）。'
  '★ 一列 = 「某個人、某一期、到某個時間為止改得動」。'
  '★★ 只有會計與 super_admin 開得了，而且只能幫自己開。'
  '★★★ expires_at 是兜底 —— 前端關視窗會刪掉，但瀏覽器直接關掉時刪不到。';

-- ══════════════════════════════════════════════════════════
-- ② 這個人現在改得動這張單嗎
-- ══════════════════════════════════════════════════════════
create or replace function public.has_period_unlock(
  p_ym text, p_order uuid, p_contract uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select exists (
    select 1 from public.period_unlock u
     /*
      * ★ `is not distinct from` 而不是 `=` —— 兩邊都是 null 時要算相等。
      *   SQL Editor／service key 的 auth.uid() 是 null，
      *   而那條路本來就繞得過所有 RLS，所以不是放寬什麼，
      *   只是讓自檢測得到（`null = null` 回的是 NULL，不是 true）。
      */
     where u.user_id is not distinct from auth.uid()
       and u.expires_at > now()
       and u.ym = p_ym
       and (
         (p_order is not null and u.order_id = p_order)
         or (p_contract is not null and u.contract_id = p_contract)
       )
  );
$fn$;

comment on function public.has_period_unlock(text, uuid, uuid) is
  '這個人現在有沒有這一期的臨時解鎖（migration_250）。'
  '★ 綁 auth.uid() —— 開鎖的人自己才改得動。';

-- ══════════════════════════════════════════════════════════
-- ③ 訂單守衛：認解鎖，並補擋「帶 contract_id 的 INSERT」
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
   * ── INSERT（migration_250 新增）────────────────────────
   *
   * ★★★ **只擋帶 contract_id 的**。那是「＋加費」與「折讓」，
   *   而 Airbnb／Agoda 同步補建的舊訂單**永遠沒有 contract_id** ——
   *   全部擋下來的話那些資料會靜默消失（249 檔頭寫過這個顧慮）。
   */
  if tg_op = 'INSERT' then
    if new.contract_id is null or new.checkout is null then return new; end if;
    v_ym := to_char(new.checkout, 'YYYYMM');
    if not public.is_period_locked(v_ym) then return new; end if;
    if public.has_period_unlock(v_ym, null, new.contract_id) then return new; end if;
    raise exception '% 已經關帳，加不了費用也記不了折讓。要加的話請會計在那一期按「開鎖」。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  -- 沒有退房日就判不出月份 —— 放行，不要用猜的鎖人
  if old.checkout is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_ym := to_char(old.checkout, 'YYYYMM');
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  /*
   * ★★★ 會計在畫面上開過鎖 → 放行（migration_250）。
   *   放在「人 vs 產生器」判斷**之前** —— 開鎖的目的就是讓人改，
   *   放在後面的話開了鎖還是被擋。
   */
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

comment on function public.orders_period_lock_guard() is
  '關帳後訂單改不動（223 → 249 拿掉月租單例外 → 250 認臨時解鎖）。'
  '★ 會計開過鎖 → 放行；人直接改 → 丟例外；產生器／同步 → 記進 order_lock_pending。'
  '★★ INSERT 只擋**帶 contract_id 的**（加費、折讓）—— 同步補建的舊訂單沒有那一欄。';

drop trigger if exists trg_orders_period_lock on public.orders;
create trigger trg_orders_period_lock
  before insert or update or delete on public.orders
  for each row execute function public.orders_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- ④ 分筆收款守衛：一樣認解鎖
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
  v_ct  uuid;
  v_ym  text;
begin
  select o.checkout, o.contract_id into v_co, v_ct
    from public.orders o where o.id = v_oid;
  if v_co is null then return case when tg_op = 'DELETE' then old else new end; end if;

  v_ym := to_char(v_co, 'YYYYMM');
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if public.has_period_unlock(v_ym, v_oid, v_ct) then
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

-- ══════════════════════════════════════════════════════════
-- ⑤ 過期的解鎖自己清掉
--
-- ★ 不清的話這張表會一直長，而且「現在誰開著鎖」會被歷史淹掉。
--   接在既有的每日清理排程上（notifications/purge 那支）。
-- ══════════════════════════════════════════════════════════
create or replace function public.purge_period_unlock()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare n int;
begin
  with d as (delete from public.period_unlock
              where expires_at < now() - interval '1 day' returning 1)
  select count(*) into n from d;
  return n;
end $fn$;

comment on function public.purge_period_unlock() is
  '清掉一天前就過期的臨時解鎖（migration_250）。'
  '★ 留一天是為了查得到「誰在什麼時候開過鎖」—— 立刻刪掉的話追不了。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('250_period_unlock');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢　★ 實測在第 ④ 條：真的開一把鎖、改一次、再確認鎖掉之後改不動
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_ym  text; v_ord public.orders.id%type; v_ct uuid;
  v_was boolean; v_now boolean;
  ok_lock boolean := false;   -- 沒開鎖時擋得住
  ok_open boolean := false;   -- 開了鎖改得動
  ok_gone boolean := false;   -- 鎖失效後又擋得住
  v_err text := '';
begin
  select p.ym into v_ym
    from public.period_lock p
   where p.locked
     and exists (select 1 from public.orders o
                  where o.contract_id is not null and o.checkout is not null
                    and to_char(o.checkout, 'YYYYMM') = p.ym)
   order by p.ym desc limit 1;

  if v_ym is null then
    insert into public._m250_test values
      (4, '④ 開鎖實測', '找不到「已關帳且有契約訂單」的月份，測不了', '⚠ 沒測到');
    return;
  end if;

  select o.id, o.contract_id, o.paid into v_ord, v_ct, v_was
    from public.orders o
   where o.contract_id is not null and o.checkout is not null
     and to_char(o.checkout, 'YYYYMM') = v_ym
   limit 1;

  begin
    -- (a) 沒開鎖：改不動（SQL Editor 裡 auth.uid() 是 null，走「記一筆不寫」那條）
    update public.orders set paid = not v_was where id = v_ord;
    select o.paid into v_now from public.orders o where o.id = v_ord;
    ok_lock := (v_now = v_was);

    /*
     * (b) 開一把鎖再改。
     *
     * ★★ SQL Editor 的 `auth.uid()` 是 null，而 `has_period_unlock()`
     *   比的就是 `u.user_id = auth.uid()` —— 所以這裡**故意也插 null**，
     *   讓兩邊對得起來。測的是「有沒有認這張表」，不是「登入身分對不對」。
     */
    insert into public.period_unlock (user_id, ym, order_id, contract_id, note)
    values (null, v_ym, v_ord, v_ct, 'm250 自檢');

    update public.orders set paid = not v_was where id = v_ord;
    select o.paid into v_now from public.orders o where o.id = v_ord;
    ok_open := (v_now <> v_was);

    -- (c) 鎖失效（把它改成已過期）之後又擋得住
    update public.period_unlock set expires_at = now() - interval '1 minute'
     where note = 'm250 自檢';
    update public.orders set paid = v_was where id = v_ord;
    select o.paid into v_now from public.orders o where o.id = v_ord;
    ok_gone := (v_now <> v_was);        -- 改不回去 = 還停在 (b) 改過的值

    raise exception 'M250_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M250_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into public._m250_test values
    (4, '④ 開鎖實測（' || v_ym || '，改完已退掉）',
     '沒開鎖擋得住：' || ok_lock || '　開了鎖改得動：' || ok_open
       || '　鎖過期又擋住：' || ok_gone
       || case when v_err <> '' then '　錯誤：' || v_err else '' end,
     case when ok_lock and ok_open and ok_gone then '✅ 三種狀態都對'
          else '❌ 有一種不對' end);
end $do$;

select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① period_unlock 建好了，而且只有會計寫得進去',
         coalesce((select string_agg(p.polname || '：' || pg_get_expr(p.polqual, p.polrelid), '　' order by p.polname)
                     from pg_policy p where p.polrelid = 'public.period_unlock'::regclass),
                  '（沒有 policy —— 那會全部擋掉）'),
         case when (select count(*) from pg_policy p
                     where p.polrelid = 'public.period_unlock'::regclass) = 2
               and (select pg_get_expr(p.polqual, p.polrelid) from pg_policy p
                     where p.polrelid = 'public.period_unlock'::regclass
                       and p.polname = 'period_unlock_write') !~ 'manager'
              then '✅ 建好了，主管寫不進去' else '❌' end

  union all
  select 2, '② 三支守衛都認 has_period_unlock()',
         (select string_agg(x.n, '　' order by x.n) from (
            select p.proname::text as n from pg_proc p
             where p.proname in ('orders_period_lock_guard', 'order_payments_period_lock_guard')
               and p.prosrc ~ 'has_period_unlock') x),
         case when (select count(*) from pg_proc p
                     where p.proname in ('orders_period_lock_guard', 'order_payments_period_lock_guard')
                       and p.prosrc ~ 'has_period_unlock') = 2
              then '✅ 兩支都認' else '❌ 有一支沒改到' end

  union all
  /*
   * ★★★ 這一條釘的是「同步不能被誤傷」。
   *   INSERT 守衛必須**只看 contract_id**，不是一律擋 ——
   *   一律擋的話 Airbnb 每日同步補建的舊訂單會靜默消失。
   */
  select 3, '③ INSERT 只擋帶 contract_id 的（同步補建不受影響）',
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'new\.contract_id is null'
              then '有「contract_id 是空的就放行」這一條'
              else '★ 找不到 —— 同步可能被誤傷' end,
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'new\.contract_id is null'
              then '✅ 切得精準' else '❌ 會誤傷同步' end

  union all
  select t.ord, t.name, t.detail, t.verdict from public._m250_test t

  union all
  select 5, '⑤ 現在有沒有人開著鎖',
         (select count(*) from public.period_unlock where expires_at > now())::text || ' 把有效的鎖',
         case when (select count(*) from public.period_unlock where expires_at > now()) = 0
              then '✅ 沒有（自檢那把已經退掉了）' else '⚠ 有人開著，看一下是誰' end

  union all
  select 6, '⑥ 收尾',
         '核對完請執行：drop table public._m250_test;',
         '⚠ 記得清掉這張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
