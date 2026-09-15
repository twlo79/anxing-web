/*
 * migration_254_order_lock_money_only.sql　2026-09-15
 * 訂單守衛：關帳鎖的是「會改變那個月帳的欄位」，不是整列資料
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ **253 要先跑**（押金那半）。兩支是同一個原則的兩邊。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 249~251 之後，已關帳月份的訂單**任何一欄**都改不動 ——
 * 包含房客名字打錯、想補一句備註。
 *
 * 2026-09-15 押金那邊就是這樣炸的:使用者只把租戶名字從「Luck」
 * 改成「碩美股份有限公司」，契約存檔連帶同步押金的名字，
 * 而那筆訂金的收款月是已關帳的 202608 —— 於是**整張契約存不了**，
 * 而錯誤訊息講的是押金。
 *
 * ★ 使用者 2026-09-15:「先開放關帳以外的部分修改吧。」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 訂單用「安全清單」，押金用「金錢清單」—— 為什麼相反】
 *
 * 押金（253）列的是**哪些欄位算錢**，其餘放行。
 * 訂單這裡反過來，列的是**哪些欄位不算錢**，其餘一律鎖。
 *
 * 因為兩張表的形狀不一樣:
 *
 *   `deposits` 大半是流程欄（簽核、退款申請、轉移紀錄），
 *              跟金額有關的是少數 → 列少數那邊
 *   `orders`   幾乎每一欄都會改變報表 —— 金額、日期、收款狀態、
 *              物業房源、用途、來源、科目、帳本 → 列例外那邊
 *
 * ★★ 兩邊都**列舉**而不是猜，而且自檢會把「落在哪一邊」印出來 ——
 *   以後多一個欄位，看得見它被歸到哪裡（README 坑 F）。
 *
 * ★★★ `estate_id` / `property_id` / `property_raw` / `purpose_type`
 *   **一定要鎖**。它們決定那筆錢算在誰頭上 ——
 *   改了等於改已關帳月份的營收報表，而報表上不會有任何痕跡。
 *
 * ══════════════════════════════════════════════════════════
 * 【關帳之後到底能做什麼（寫給三個月後的自己）】
 *
 * 假設關的是 2026-08：
 *
 *   改不動　八月那些單的:收款／取消收款／收款日、金額、日期、
 *           加費、折讓、開發票、物業房源、用途
 *   照樣做　九月以後的一切；**退押金**（記在退的那天，走九月的帳）；
 *           改名字、改備註；查詢與匯出
 *   要改　　會計在那一期按「開鎖」→ 改 → 關掉視窗自動鎖回
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table _m254_test (ord int, name text, detail text, verdict text);

/*
 * 不影響帳的欄位 —— 改它們不擋。
 *
 * ★★★ 使用者 2026-09-15 定的界線：
 *     **「關帳涉及帳務行為：錢、期間、發票。可編輯姓名。」**
 *
 *   所以鎖的是那三類，名字放行。備註（note）與移房紀錄（move_chain）
 *   同樣不進任何報表，一併放行 —— 它們是給人看的字串，不是帳。
 *
 * ★ 做成函式而不是寫死在守衛裡:自檢要用同一份清單，
 *   兩邊各抄一次就會有「守衛放行、自檢說該擋」的一天。
 */
create or replace function public.order_lock_free_cols()
returns text[]
language sql
immutable
as $fn$
  select array[
    'guest_name',   -- 房客名字打錯要能改
    'note',         -- 備註是給人看的，不進任何報表
    'move_chain'    -- 移房過程的顯示字串（migration_246）
  ]::text[];
$fn$;

comment on function public.order_lock_free_cols() is
  '關帳後仍可編輯的訂單欄位（migration_254）。'
  '★ 這裡沒列到的一律鎖住 —— orders 幾乎每一欄都會改變報表，'
  '所以列例外那一邊比列金錢那一邊安全。'
  '★★ estate_id / property_raw / purpose_type 絕對不能加進來：'
  '它們決定那筆錢算在誰頭上，改了等於改已關帳月份的營收，而報表上沒有痕跡。';

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

  v_ym := public.order_lock_ym(old);
  if v_ym is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  /*
   * ★★★ 只動到不影響帳的欄位 → **放行**（migration_254）。
   *
   *   改版前是「任何一欄不同就擋」，所以房客名字打錯、想補一句備註，
   *   只要那張單落在已關帳月份就改不了 ——
   *   而 2026-09-15 在押金那邊，同一個病讓**整張契約存不了**。
   *
   * ★ 放在「開鎖」與「深度」判斷**之前** —— 這些欄位本來就不該進鎖的範圍，
   *   不需要先開鎖才能改一個名字。
   */
  if tg_op = 'UPDATE' then
    oj := to_jsonb(old);
    nj := to_jsonb(new);
    for k in select jsonb_object_keys(nj) loop
      if oj -> k is distinct from nj -> k then
        v_diff := v_diff || jsonb_build_object(k, jsonb_build_array(oj -> k, nj -> k));
      end if;
    end loop;

    -- 一欄都沒真的變 → 放行
    if v_diff = '{}'::jsonb then return new; end if;

    -- 變的全都在「不影響帳」的清單裡 → 放行
    if not exists (
      select 1 from jsonb_object_keys(v_diff) kk
       where kk <> all (public.order_lock_free_cols())
    ) then
      return new;
    end if;
  end if;

  -- 會計在畫面上開過鎖 → 放行（migration_250）
  if public.has_period_unlock(v_ym, old.id, old.contract_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- 人直接改這張訂單 → 擋下來，而且講人話
  if v_uid is not null and pg_trigger_depth() <= 1 then
    raise exception '% 已經關帳，這張訂單的金額與日期改不動（名字、備註可以改）。要改的話請會計在那一期按「開鎖」。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  -- 產生器重算／同步／匯入 → 不寫，但記一筆
  if tg_op = 'DELETE' then
    insert into public.order_lock_pending (order_id, ym, changes)
    values (old.id, v_ym, jsonb_build_object('_刪除', to_jsonb(old)));
    return null;
  end if;

  insert into public.order_lock_pending (order_id, ym, changes)
  values (old.id, v_ym, v_diff);
  return null;
end $fn$;

comment on function public.orders_period_lock_guard() is
  '關帳後訂單的**金額與日期**改不動（223 → 249 拿掉月租單例外 → 250 認開鎖 '
  '→ 251 月份看期別起日 → 254 只鎖會改變帳的欄位）。'
  '★ 名字、備註、移房紀錄照樣能改（order_lock_free_cols）。'
  '★★ 人直接改 → 丟例外；產生器／同步 → 不寫但記進 order_lock_pending。';

drop trigger if exists trg_orders_period_lock on public.orders;
create trigger trg_orders_period_lock
  before insert or update or delete on public.orders
  for each row execute function public.orders_period_lock_guard();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('254_order_lock_money_only');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_id uuid; v_ym text; v_name text; v_amt numeric; v_now numeric; v_gn text;
  v_err text := '';
  ok_name boolean := false; ok_money boolean := false;
begin
  select o.id, public.order_lock_ym(o), o.guest_name, o.amount
    into v_id, v_ym, v_name, v_amt
    from public.orders o
   where public.order_lock_ym(o) is not null
     and public.is_period_locked(public.order_lock_ym(o))
   limit 1;

  if v_id is null then
    insert into _m254_test values
      (4, '④ 訂單守衛實測', '找不到落在已關帳月份的訂單，測不了', '⚠ 沒測到');
    return;
  end if;

  begin
    -- (a) 改名字 → 要**改得動**
    update public.orders set guest_name = coalesce(v_name, '') || '・試' where id = v_id;
    select o.guest_name into v_gn from public.orders o where o.id = v_id;
    ok_name := (v_gn is distinct from v_name);

    /*
     * (b) 改金額 → 要**擋住**。
     * ★ SQL Editor 的 auth.uid() 是 null，走的是「不寫但記一筆」那條，
     *   所以驗的是**值有沒有被改掉**，不是有沒有報錯（249 同一個道理）。
     */
    update public.orders set amount = coalesce(v_amt, 0) + 1 where id = v_id;
    select o.amount into v_now from public.orders o where o.id = v_id;
    ok_money := (v_now is not distinct from v_amt);

    raise exception 'M254_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M254_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into _m254_test values
    (4, '④ 訂單守衛實測（' || v_ym || '，改完已退掉）',
     '改名字放行：' || coalesce(ok_name::text, '—')
       || '　改金額擋住：' || coalesce(ok_money::text, '—')
       || case when v_err <> '' then '　（' || left(v_err, 70) || '）' else '' end,
     case when ok_name and ok_money then '✅ 名字改得動、金額改不動' else '❌' end);
end $do$;


select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 關帳後仍可編輯的訂單欄位',
         array_to_string(public.order_lock_free_cols(), '　'),
         case when 'guest_name' = any (public.order_lock_free_cols())
               and 'note' = any (public.order_lock_free_cols())
              then '✅ 名字與備註都開了' else '❌' end

  union all
  /*
   * ★★★ 這一條是「有沒有不小心開太多」。
   *   物業、房源、用途決定那筆錢算在誰頭上 ——
   *   它們出現在可編輯清單裡就是嚴重錯誤。
   */
  select 2, '② 決定歸屬的欄位**沒有**被開放',
         (select coalesce(string_agg(x, '　'), '（都鎖著，對）')
            from unnest(array['estate_id','property_id','property_raw','purpose_type',
                              'amount','paid','paid_at','paid_amount','checkin','checkout',
                              'source','book','fee_type','account_code']) x
           where x = any (public.order_lock_free_cols())),
         case when not exists (
                select 1 from unnest(array['estate_id','property_id','property_raw','purpose_type',
                                           'amount','paid','paid_at','paid_amount','checkin','checkout',
                                           'source','book','fee_type','account_code']) x
                 where x = any (public.order_lock_free_cols()))
              then '✅ 一個都沒開' else '❌ 有不該開的被開了' end

  union all
  select 3, '③ 守衛真的有用那份清單',
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'order_lock_free_cols'
              then '有' else '★ 沒有 —— 清單改了守衛不會跟' end,
         case when (select prosrc from pg_proc
                     where oid = 'public.orders_period_lock_guard()'::regprocedure)
                   ~ 'order_lock_free_cols'
              then '✅ 同一份清單' else '❌' end

  union all
  select t.ord, t.name, t.detail, t.verdict from _m254_test t

  union all
  select 5, '⑤ 收尾', '這支用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
