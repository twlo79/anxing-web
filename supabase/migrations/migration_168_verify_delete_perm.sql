-- migration_168：重驗 167 的權限（**不改任何東西**，只有 select）
--
-- ============================================================
-- 【167 的第 2 項為什麼是 ❌ —— 是我的自檢寫錯，不是功能壞了】
--
-- 那一項寫的是:
--
--     select case when public.trash_can_delete('orders') then '✅' else '❌' end
--     說明:「以目前連線的角色實測」
--
-- 而 current_role_of() 的定義是:
--
--     select role from profiles where id = auth.uid() and active
--                                          ^^^^^^^^^^
--
-- **SQL Editor 是 postgres 連線，沒有登入身分，`auth.uid()` 是 null。**
-- 所以 current_role_of() 回 null，trash_can_delete 第一行就:
--
--     case when public.current_role_of() is null then false
--
-- 回 false。它**每一次都會是 ❌**，換誰跑都一樣，跟 167 改了什麼無關。
-- 我把一個必然為假的條件寫成了驗收標準。
--
--
-- ============================================================
-- 【功能其實是好的 —— 但下面要真的測，不是用推論的】
--
-- 167 的第 3 項（cleaner 沒被開放）是 ✅，那一項用
-- `pg_get_functiondef(...) like '%housekeeper, accountant, manager, super_admin%'`
-- 比字串 —— 證明 case 分支確實寫進去了。
--
-- 但**比字串不是測行為**。那正是 164 犯的錯的同一種:
-- 索引存在、名字對、形狀看起來都好，而 ON CONFLICT 就是對不到。
--
-- 所以這支改用**假扮身分**:設 request.jwt.claims 的 sub，
-- auth.uid() 就會回那個 uuid，current_role_of() 就查得到角色。
--
--   · 不切 `role authenticated` —— 切了之後這支自己查 profiles 會被 RLS 擋。
--     current_role_of() 是 SECURITY DEFINER，只看 auth.uid()，不需要切。
--   · set_config 的第三個參數是 true = local，交易結束自動還原。
--     SQL Editor 把整份包在一個交易裡，所以跑完不會留下假身分。
--
-- 【假扮失敗時要說「測不出來」，不能說「壞了」】
-- 如果 auth.uid() 沒有跟著 jwt claims 走（例如 auth schema 的定義不同），
-- 下面會顯示「⚠ 無法模擬」而不是 ❌ ——
-- 把「沒測到」報成「壞掉」比不報還糟。
-- ============================================================

do $$
declare
  v_uid uuid;
  v_claim_ok boolean;
begin
  -- 先確認假扮這件事本身有沒有效
  select id into v_uid from public.profiles where active limit 1;
  if v_uid is null then
    raise notice '★ 跳過（profiles 一個 active 帳號都沒有）';
    return;
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid::text)::text, true);
  v_claim_ok := (auth.uid() = v_uid);

  raise notice '★ 假扮身分:% （auth.uid() = %）',
    case when v_claim_ok then '有效 ✅' else '無效 ⚠ 下面會顯示「無法模擬」' end,
    coalesce(auth.uid()::text, '(null)');

  -- 還原,不要讓後面的 SELECT 帶著假身分
  perform set_config('request.jwt.claims', '', true);
end $$;


-- ============================================================
-- 逐角色實測
-- ============================================================
/*
 * 每個角色挑一個真的 active 帳號，假扮成他，
 * 問 trash_can_delete('orders') 與 trash_can_delete('contracts')。
 *
 * 兩張表一起問是重點:
 *   orders     → 管家應該可以（167 改的）
 *   contracts  → 管家應該**不行**（167 沒動它）
 * 只問 orders 的話，「把整個白名單降級」跟「只降 orders」看起來一樣。
 */
/*
 * ★ 用 plpgsql 迴圈，不要用 CTE。
 *
 *   把 set_config 跟 trash_can_delete 放在同一個 SELECT 的不同欄位時，
 *   **Postgres 不保證誰先算** —— 有可能先問完權限才換身分，
 *   那樣每一列都會是上一個人的答案，而且看起來完全正常。
 *
 *   迴圈裡一行一行來，順序是確定的。
 */
create temp table _perm_probe (
  role text, seen_role text, can_del_order boolean, can_del_contract boolean
) on commit drop;

do $$
declare r record;
begin
  for r in
    select distinct on (role) role, id
      from public.profiles
     where active and role is not null
     order by role, id
  loop
    perform set_config('request.jwt.claims',
                       json_build_object('sub', r.id::text)::text, true);
    insert into _perm_probe values (
      r.role,
      public.current_role_of(),
      public.trash_can_delete('orders'),
      public.trash_can_delete('contracts')
    );
  end loop;
  -- 還原,不要讓最後那個 SELECT 帶著假身分
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ============================================================
-- 真的刪一筆（假扮成管家），再回滾
-- ============================================================
/*
 * 【為什麼 167 的「真的刪一筆」等於沒跑】
 *
 * 167 的驗證段有一個 do 區塊會呼叫 soft_delete。但在 SQL Editor 裡
 * current_role_of() 是 null → trash_can_delete 回 false →
 * **soft_delete 第一行就 return NO_PERM，一列都沒動**。
 *
 * 而結果是用 `raise notice` 印的，SQL Editor 看不到 ——
 * 所以那段既沒測到東西，也沒有人知道它沒測到。
 * 兩個問題疊在一起，剛好互相遮蓋。
 *
 *
 * 【這一段怎麼做到「真的刪 ＋ 回滾 ＋ 看得到結果」】
 *
 * plpgsql 的內層 begin/exception 是一個隱式 savepoint:
 * 在裡面 raise，資料庫的變更回滾，**但變數的值留著**。
 * 所以先把結果存進變數，回滾之後再 insert 進 temp table。
 */
create temp table _del_probe (ord int, item text, result text, note text) on commit drop;

do $$
declare
  v_hk uuid; v_anxing uuid; v_other uuid;
  v_r jsonb; v_msg text; v_kids text;
  v_other_msg text := '(沒有其他帳本的收入可測)';
begin
  select id into v_hk from public.profiles
   where active and role = 'housekeeper' limit 1;
  if v_hk is null then
    insert into _del_probe values (1, '★★ 管家實刪一筆', '⚠ 測不出來',
      'profiles 裡沒有 active 的管家帳號');
    return;
  end if;

  select o.id into v_anxing from public.orders o
   where coalesce(o.book, 'anxing') = 'anxing'
     and public.order_locked_reason(o.id) is null
   limit 1;
  select o.id into v_other from public.orders o
   where coalesce(o.book, 'anxing') <> 'anxing'
   limit 1;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_hk::text)::text, true);

  -- ① 安幸的一般訂單 —— 應該刪得掉
  begin
    v_r := public.soft_delete('orders', v_anxing, '__168 自檢__');
    v_msg := case when (v_r->>'ok')::boolean then '✅ 刪得掉'
                  else '❌ 刪不掉:' || (v_r->>'message') end;
    v_kids := '連同 ' || coalesce(v_r->>'children', '0') || ' 筆收款一起進回收桶';
    -- 故意失敗 —— 只回滾這個內層區塊,變數留著
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    /*
     * ★ 抓 others 不是抓 restrict_violation。
     *   soft_delete 裡的觸發器（例如 157 的鎖定守衛）丟的是 check_violation,
     *   只抓 restrict_violation 的話那個例外會炸掉整份腳本,
     *   而症狀是「跑 168 出現一句看不懂的錯誤」——
     *   自檢不該比被檢查的東西還脆弱。
     */
    if sqlerrm <> '__rollback__' then
      v_msg := '⚠ 例外:' || sqlerrm;
      v_kids := '不一定是壞了 —— 也可能是這一筆剛好踩到別的規則';
    end if;
  end;

  -- ② 愛皮／洪鯊的收入 —— 應該擋下來
  if v_other is not null then
    begin
      v_r := public.soft_delete('orders', v_other, '__168 自檢__');
      v_other_msg := case when (v_r->>'ok')::boolean
        then '❌ 竟然刪得掉 —— row 層檢查沒生效'
        else '✅ 擋下來:' || (v_r->>'message') end;
      raise exception using errcode = 'restrict_violation', message = '__rollback__';
    exception when others then
      if sqlerrm <> '__rollback__' then
        v_other_msg := '⚠ 例外:' || sqlerrm;
      end if;
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);

  insert into _del_probe values
    (1, '★★ 管家刪安幸訂單', v_msg, v_kids),
    (2, '★★ 管家刪其他帳本收入', v_other_msg, '愛皮／洪鯊的收入也在 orders 表裡');
end $$;


/*
 * ★ 兩張 temp table 合成**一個** SELECT。
 *   SQL Editor 只顯示最後一句的結果 —— 分兩句的話，
 *   逐角色那張表會被吃掉，而且沒有任何提示。
 */
select "區塊", "項目", "結果", "說明" from (

  -- ── 逐角色問權限 ──────────────────────────────
  select
    case p.role
      when 'cleaner' then 1 when 'housekeeper' then 2 when 'accountant' then 3
      when 'manager' then 4 when 'super_admin' then 5 else 9 end as ord,
    '一、逐角色' as "區塊",
    case p.role
      when 'cleaner' then '房務 cleaner'
      when 'housekeeper' then '★★ 管家 housekeeper'
      when 'accountant' then '會計 accountant'
      when 'manager' then '主管 manager'
      when 'super_admin' then '總經理 super_admin'
      else p.role end as "項目",
    /*
     * 訂單與契約一起看是重點:
     *   「把整個白名單降級」跟「只降 orders」在只看訂單時長得一模一樣。
     */
    case when p.seen_role is null then '⚠ 假扮沒生效,測不出來'
         else '訂單 ' || case when p.can_del_order then '✅可刪' else '❌不可刪' end
              || ' ／ 契約 ' || case when p.can_del_contract then '⚠可刪' else '✅不可刪' end
    end as "結果",
    case
      when p.seen_role is null then '不是功能壞了 —— 是 auth.uid() 沒跟著 jwt claims 走'
      when p.role = 'housekeeper' and p.can_del_order and not p.can_del_contract
        then '★★ 167 要的就是這一列'
      when p.role = 'housekeeper' and not p.can_del_order
        then '★★ 167 沒生效 —— 這才是真的壞了'
      when p.role = 'housekeeper' and p.can_del_contract
        then '★★ 契約被順手開放了 —— 167 不該動它'
      when p.role = 'cleaner' and p.can_del_order
        then '★★ 房務被順手放進來了'
      when p.role = 'cleaner' then '房務照舊擋著'
      else '會計以上,兩張本來就都能刪' end as "說明"
  from _perm_probe p

  union all
  -- ── 真的刪一筆再回滾 ──────────────────────────
  select 10 + d.ord, '二、實際刪除', d.item, d.result, d.note from _del_probe d

  union all
  -- ── 這支沒有動任何資料 ────────────────────────
  select 90, '三、資料', '訂單總數', count(*)::text || ' 筆',
         '168 是純驗證,連 record_migration 都沒記'
    from public.orders

) v order by ord;
