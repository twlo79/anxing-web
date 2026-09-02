-- migration_176：契約的訂金 → deposits 那一列
--
-- ============================================================
-- 【174 缺的一塊】（2026-08-24 做前端時發現）
--
-- 174 加了 `contracts.earnest_amount`，也加了 `deposits.kind`，
-- 但**沒有任何東西把前者變成後者**。
--
-- `sync_contract_deposits()` 只看 `new.deposit`（押金那一欄）——
-- 契約填了訂金存檔之後，暫收管理**一列都不會出現**。
--
-- 症狀是「填了訂金，然後什麼都沒發生」:不報錯、不提示，
-- 使用者會以為自己沒存到，然後再填一次。
--
--
-- ============================================================
-- 【為什麼分成兩支觸發器，不寫在同一支裡】
--
-- `sync_contract_deposits` 的觸發條件是:
--
--     after insert or update of deposit, estate_id, room, tenant_name
--
-- 要合併的話得把 `earnest_amount` 加進那份清單，然後在函式裡分岔。
-- 那支函式現在很短、只做一件事 —— 塞進第二件事之後，
-- 「押金改成 0 會不會誤刪訂金」這種問題就要每次改都重想一遍。
--
-- 分成兩支各管一種 kind，兩邊都短到一眼看得完。
-- 代價是契約存檔會多跑一個觸發器（那不是效能問題）。
--
--
-- ============================================================
-- 【★★ 沿用 174 的部分索引，where 一個字都不能差】
--
--     索引：      (contract_id, currency, kind) where contract_id is not null
--     on conflict：(contract_id, currency, kind) where contract_id is not null
--
-- README 9.1②:`ON CONFLICT (欄位)` 推不出部分索引，
-- 除非那句 on conflict 帶了**一模一樣**的 where。
-- 這個專案為此吃過三次虧（151、165、174）。
-- 所以下面的驗證會**真的存一張契約**，不是只查觸發器存不存在。
-- ============================================================

create temp table _chk176 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- 訂金同步
-- ============================================================
create or replace function public.sync_contract_earnest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.earnest_amount, 0) > 0 then
    insert into deposits (contract_id, currency, amount, estate_id, room, guest_name, kind)
    values (new.id, 'TWD', new.earnest_amount, new.estate_id, new.room, new.tenant_name, 'earnest')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    /*
     * 訂金改成 0。
     *
     * ★ `kind = 'earnest'` 那三個字**不能少** —— 少了就會把押金也清掉。
     *   174 在 sync_contract_deposits 那邊也加了同樣的條件，理由相同。
     *
     * ★ 還沒收到錢的直接刪；收過的標成孤兒留著 ——
     *   錢真的進來過，那一列不能無聲消失（跟押金同一套規則）。
     */
    delete from deposits
     where contract_id = new.id and kind = 'earnest' and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and kind = 'earnest' and received_on is not null;
  end if;
  return new;
end $$;

comment on function public.sync_contract_earnest() is
  '契約的 earnest_amount → deposits 的 kind=earnest 那一列。'
  '★ 跟 sync_contract_deposits 分開，各管一種 kind —— '
  '合在一起的話「改押金會不會誤刪訂金」每次都要重想（migration_176）。';

drop trigger if exists trg_sync_contract_earnest on public.contracts;
create trigger trg_sync_contract_earnest
  after insert or update of earnest_amount, estate_id, room, tenant_name
  on public.contracts
  for each row execute function public.sync_contract_earnest();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('176_sync_earnest');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的存一張訂金契約，看 deposits 有沒有長出那一列。
 *
 *   只查「觸發器存在嗎」抓不到 on conflict 對不到索引 ——
 *   那個症狀是「存不進去」，而觸發器好端端地掛在那裡。
 */
do $$
declare v_est uuid; v_ct uuid; v_n int; v_amt numeric; v_msg text;
begin
  select id into v_est from public.estates limit 1;
  if v_est is null then
    insert into _chk176 values (1, '★★ 訂金會長出暫收那一列', '⚠ 測不出來', '一個物業都沒有');
    return;
  end if;

  begin
    insert into public.contracts (name, estate_id, tenant_name, earnest_only, earnest_amount)
    values ('__176測試__', v_est, 'Test', true, 12345)
    returning id into v_ct;

    select count(*), max(amount) into v_n, v_amt
      from public.deposits where contract_id = v_ct and kind = 'earnest';

    v_msg := case when v_n = 1 and v_amt = 12345
                  then '✅ 長出 1 列，金額 12,345'
                  else '❌ 長出 ' || v_n || ' 列，金額 ' || coalesce(v_amt::text, '(null)') end;

    /*
     * ★ 順便測「改金額會更新不是新增一列」—— 那正是 on conflict 在做的事。
     */
    if v_n = 1 then
      update public.contracts set earnest_amount = 20000 where id = v_ct;
      select count(*), max(amount) into v_n, v_amt
        from public.deposits where contract_id = v_ct and kind = 'earnest';
      v_msg := v_msg || case when v_n = 1 and v_amt = 20000
                             then '　改金額:✅ 還是 1 列、20,000'
                             else '　改金額:❌ 變成 ' || v_n || ' 列' end;
    end if;

    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- 抓 others:contracts 上還有別的觸發器與約束
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk176 values (1, '★★ 訂金會長出暫收那一列', coalesce(v_msg, '⚠ 沒跑到'),
    '174 加了欄位卻沒有人把它變成 deposits');
end $$;


/*
 * ★★ 訂金與押金**互不干擾**。
 *   把押金改成 0 不能把訂金清掉，反之亦然。
 *   少了 `kind = '…'` 那個條件的話就會互相誤刪，
 *   而症狀是「訂金自己不見了」—— 沒有任何錯誤訊息。
 */
do $$
declare v_est uuid; v_ct uuid; v_e int; v_d int; v_msg text;
begin
  select id into v_est from public.estates limit 1;
  if v_est is null then return; end if;

  begin
    insert into public.contracts (name, estate_id, tenant_name,
                                  earnest_only, earnest_amount, deposit,
                                  start_date, end_date, amount_per_period)
    values ('__176測試2__', v_est, 'Test', false, 10000, 30000,
            current_date, current_date + 365, 30000)
    returning id into v_ct;

    -- 把押金改成 0，訂金那一列要活著
    update public.contracts set deposit = 0 where id = v_ct;

    select count(*) filter (where kind = 'earnest'),
           count(*) filter (where kind = 'deposit')
      into v_e, v_d
      from public.deposits where contract_id = v_ct;

    v_msg := case when v_e = 1 and v_d = 0
                  then '✅ 押金清掉了，訂金還在'
                  else '❌ 訂金 ' || v_e || ' 列 ／ 押金 ' || v_d || ' 列' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk176 values (2, '★★ 改押金不會誤刪訂金', coalesce(v_msg, '⚠ 沒跑到'),
    'kind 那個條件少了就會互相清掉');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk176 c

  union all
  select 3, '★ 兩支同步觸發器都在',
         (select count(*)::text || ' / 2' from pg_trigger
           where tgrelid = 'public.contracts'::regclass
             and tgname in ('trg_sync_contract_deposits', 'trg_sync_contract_earnest')),
         '押金一支、訂金一支,各管各的 kind'

  union all
  /*
   * ★ 兩支都要帶 kind。少一個的話那一種暫收存不進去。
   */
  select 4, '★★ 兩支的 on conflict 都帶 kind',
         case when pg_get_functiondef('public.sync_contract_deposits()'::regprocedure)
                   like '%on conflict (contract_id, currency, kind)%'
               and pg_get_functiondef('public.sync_contract_earnest()'::regprocedure)
                   like '%on conflict (contract_id, currency, kind)%'
              then '✅ 2 / 2' else '❌ 有一支沒帶,那一種存不進去' end,
         '要跟 deposits_contract_kind_uidx 的欄位完全一致'

  union all
  select 5, '目前的暫收',
         count(*) filter (where kind = 'deposit')::text || ' 筆押金 ／ '
         || count(*) filter (where kind = 'earnest')::text || ' 筆訂金',
         '這支只加規則,一筆資料都沒動'
    from public.deposits

) v order by ord;
