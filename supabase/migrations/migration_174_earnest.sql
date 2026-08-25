-- migration_174：訂金（暫收管理的第二種錢）
--
-- ============================================================
-- 【要做什麼】（2026-08-24 使用者指定，企劃見 docs/企劃-訂金與暫收管理.md）
--
--   收訂金 → 知道契約內容 → 收押金餘款 → 租約開始收房租
--
--   訂金收了之後三選一:**沒收 / 退款 / 轉押金**
--
--   押金管理改叫「暫收管理」，含訂金與押金兩種。
--
--
-- ============================================================
-- 【這支只加欄位與規則，不動任何既有行為】
--
-- 跑完之後畫面完全一樣 —— `kind` 預設 'deposit'，既有的 100 多筆押金
-- 全部維持原狀。訂金要等前端做完才進得來。
--
-- 這是刻意的:schema 先到位，前端分階段接上去。
-- 一次改完的話，出事時分不出是 schema 還是畫面。
--
--
-- ============================================================
-- 【★★ 最危險的一段:唯一索引】
--
-- `sync_contract_deposits()`（migration_56）用:
--
--     on conflict (contract_id, currency) where contract_id is not null
--
-- 而索引是 `(contract_id, currency) where contract_id is not null`。
-- **這是部分索引** —— README 9.1② 記著「`ON CONFLICT (欄位)`
-- 推不出部分索引」，而這裡之所以現在是對的，是因為那句
-- `on conflict` **帶了一模一樣的 where**。
--
-- 加了 `kind` 之後，三個地方要同時改，漏一個就是「存不進去」:
--
--   ① 索引       (contract_id, currency, kind) where contract_id is not null
--   ② on conflict (contract_id, currency, kind) where contract_id is not null
--   ③ insert 的欄位清單要帶 kind
--
-- 這支已經吃過兩次同樣的虧（migration_151、165），
-- 所以下面的驗證會**真的 upsert 兩次**，不是只查索引存不存在。
--
--
-- ============================================================
-- 【放寬三個 NOT NULL 是安全的 —— 階段 0 查證過】
--
--   gen_contract_orders          第一行就 `if start_date is null … return`
--   gen_contract_recognitions    開頭擋 null 日期 ＋ null/0 租金
--   schema-baseline:779 那支      同上，而且多一道 `if not ct.active`
--   前端                          型別本來就是 `string | null`，計算都有 `|| 0`
--
-- 所以放寬之後**不會**長出日期是 null 的月租單或認列。
-- 下面的驗證會存一筆三欄都空的契約，確認沒有任何東西被產生出來。
-- ============================================================

create temp table _chk174 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① deposits.kind：押金 / 訂金
-- ============================================================
alter table public.deposits
  add column if not exists kind text not null default 'deposit';

do $$ begin
  alter table public.deposits drop constraint if exists dep_kind_chk;
  alter table public.deposits add constraint dep_kind_chk
    check (kind in ('deposit', 'earnest'));
end $$;

comment on column public.deposits.kind is
  'deposit=押金／earnest=訂金。兩者生命週期相同（未收→已收→退款兩票），'
  '所以共用同一張表與同一套流程,不開新表（migration_174）。';


-- ============================================================
-- ② 唯一索引加上 kind —— 一張契約可以同時有訂金與押金
-- ============================================================
/*
 * ★★ 三個地方要一起改，見檔頭。這裡是 ①，下面 ③ 是函式。
 *
 * ★ where 條件**一個字都不能動** —— `on conflict` 那邊要寫一模一樣的，
 *   不一樣的話 Postgres 推不出這顆索引，症狀是「存不進去」。
 */
drop index if exists public.deposits_contract_currency_uidx;
drop index if exists public.dep_contract_currency_uidx;

do $$
declare idx_name text;
begin
  -- 舊索引的名字可能不只一種寫法,從 pg_indexes 撈出來再刪
  for idx_name in
    select indexname from pg_indexes
     where schemaname = 'public' and tablename = 'deposits'
       and indexdef like '%contract_id%currency%'
       and indexdef not like '%kind%'
  loop
    execute format('drop index if exists public.%I', idx_name);
  end loop;
end $$;

create unique index if not exists deposits_contract_kind_uidx
  on public.deposits (contract_id, currency, kind)
  where contract_id is not null;

comment on index public.deposits_contract_kind_uidx is
  '一張契約 × 一種幣別 × 一種暫收（押金/訂金）只能有一列。'
  '★ 部分索引 —— sync_contract_deposits 的 on conflict 必須帶'
  '一模一樣的 where，否則推不出這顆（README 9.1②）。';


-- ============================================================
-- ③ sync_contract_deposits：帶上 kind
-- ============================================================
/*
 * 逐段對照線上定義改，只動兩個地方:
 *   · insert 的欄位清單加 kind
 *   · on conflict 加 kind
 *
 * ★ `where kind = 'deposit'` 那兩處是新加的 ——
 *   這支只管押金，**不能碰訂金那一列**。
 *   少了它的話，把契約的押金改成 0 會連訂金一起刪掉。
 */
create or replace function public.sync_contract_deposits() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.deposit, 0) > 0 then
    insert into deposits (contract_id, currency, amount, estate_id, room, guest_name, kind)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.room, new.tenant_name, 'deposit')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    delete from deposits
     where contract_id = new.id and kind = 'deposit' and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and kind = 'deposit' and received_on is not null;
  end if;
  return new;
end $$;


-- ============================================================
-- ④ contracts：訂金欄位 ＋ 放寬三個 NOT NULL
-- ============================================================
alter table public.contracts
  add column if not exists earnest_amount numeric not null default 0,
  add column if not exists earnest_only boolean not null default false;

comment on column public.contracts.earnest_only is
  '這張契約還在訂金階段:不產生月租單、租期與租金可以空著。'
  '★ 用旗標而不是「日期是不是 null」判斷 —— 日期空著有很多種原因'
  '（舊資料、匯入失敗、有人手動清掉），旗標才講得出「這是訂金階段」'
  '而不是「這張契約壞了」（migration_174）。';

alter table public.contracts alter column start_date       drop not null;
alter table public.contracts alter column end_date         drop not null;
alter table public.contracts alter column amount_per_period drop not null;

/*
 * ★★ 只有訂金階段才准空著。
 *
 *   不加這道約束的話，一般契約也可以存成三欄都空 ——
 *   而那種契約不會長月租單、不會有認列，
 *   **看起來只是一張「還沒設定好」的契約，沒有任何錯誤**。
 *   三個月後沒有人知道它是故意的還是漏填的。
 */
do $$ begin
  alter table public.contracts drop constraint if exists ct_earnest_fields_chk;
  alter table public.contracts add constraint ct_earnest_fields_chk
    check (
      earnest_only
      or (start_date is not null and end_date is not null and amount_per_period is not null)
    );
end $$;


-- ============================================================
-- ⑤ 轉押與沒收的痕跡
-- ============================================================
/*
 * 比照 migration_146 的移房:備註寫中文字**不夠**。
 * 報表要把「轉押」排除在本月收款／退款之外，
 * 而分不出來的話總額又剛好對得起來（錢沒離開公司）——
 * 不會有任何跡象。
 */
alter table public.deposits
  add column if not exists converted_to_deposit_id   uuid references public.deposits(id),
  add column if not exists converted_from_earnest_id uuid references public.deposits(id),
  add column if not exists converted_by  uuid,
  add column if not exists converted_at  timestamptz,
  add column if not exists forfeited_on  date,
  add column if not exists forfeit_order_id uuid references public.orders(id) on delete set null,
  add column if not exists forfeited_by  uuid;

comment on column public.deposits.forfeit_order_id is
  '沒收訂金產生的那筆一次性收入。★ 冪等靠它 —— 有值就不再產生第二筆。'
  '沒有這一欄的話重複按就是重複收入,而總額看起來只是「多了一筆」'
  '（migration_174）。';

/*
 * ★★ 三條路互斥:退款 / 沒收 / 轉押，走過一條就不能再走。
 *
 *   已退 → 再沒收:錢還他了卻認列成收入，營收憑空多一筆
 *   已沒收 → 再退款:收入認列過了又匯錢出去，兩邊都錯
 *   已轉押 → 再退款:押金那邊已經算收到了，退了押金會憑空少一筆
 *
 *   三種都不會報錯，都只會讓某一張報表安靜地錯掉。
 *   所以擋在資料庫，不是畫面。
 */
do $$ begin
  alter table public.deposits drop constraint if exists dep_exit_once_chk;
  alter table public.deposits add constraint dep_exit_once_chk
    check (
      num_nonnulls(returned_on, forfeited_on, converted_to_deposit_id) <= 1
    );
end $$;

comment on constraint dep_exit_once_chk on public.deposits is
  '退款、沒收、轉押三選一，走過一條就不能再走（migration_174）。';


-- ============================================================
-- ⑥ 沒收產生的收入不能刪 —— 沿用 migration_157 的鎖
-- ============================================================
/*
 * 使用者指定「沒收的收入不能刪」。**不需要新機制** ——
 * `order_locked_reason()` 已經在做這件事，這裡只多一個理由。
 *
 * ★ 逐段對照 migration_157 的線上定義改，只加一個 if。
 *   `trg_orders_lock_guard` 是 before update or delete，所以改也擋、刪也擋。
 */
create or replace function public.order_locked_reason(p_order uuid)
returns text language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_reason text;
begin
  -- 沒收訂金產生的收入（migration_174）
  select '這筆是沒收訂金產生的收入（'
         || to_char(d.forfeited_on, 'YYYY-MM-DD') || '），不能刪除或修改'
    into v_reason
    from public.orders o
    join public.deposits d on d.id = o.deposit_id
   where o.id = p_order and d.forfeited_on is not null
   limit 1;
  if v_reason is not null then return v_reason; end if;

  -- 既有:押金已退款（migration_157）
  select '這筆訂單的押金已退款（'
         || to_char(d.returned_on, 'YYYY-MM-DD') || '）'
    into v_reason
    from public.orders o
    join public.deposits d on d.id = o.deposit_id
   where o.id = p_order and d.returned_on is not null
   limit 1;

  return v_reason;
end $function$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('174_earnest');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

/*
 * ★★ 第一題:同一張契約存訂金 ＋ 押金兩列。
 *
 *   這是這支最容易壞的地方（唯一索引 ＋ ON CONFLICT）。
 *   只查「索引存在嗎」抓不到 —— 索引會存在、名字會對，
 *   而 on conflict 就是推不出它（migration_151、165 的教訓）。
 */
do $$
declare v_ct uuid; v_msg text;
begin
  select id into v_ct from public.contracts limit 1;
  if v_ct is null then
    insert into _chk174 values (1, '★★ 同一張契約存兩種暫收', '⚠ 測不出來', '一張契約都沒有');
    return;
  end if;

  begin
    -- 押金那一列走 upsert（跟 sync_contract_deposits 同一條路）
    insert into public.deposits (contract_id, currency, amount, kind)
    values (v_ct, 'TWD', 30000, 'deposit')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount;

    -- 訂金那一列。舊索引還在的話這一行會撞上去
    insert into public.deposits (contract_id, currency, amount, kind)
    values (v_ct, 'TWD', 10000, 'earnest')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount;

    v_msg := '✅ 兩列都存進去了';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- 抓 others 不抓單一種類:deposits 上還有別的觸發器與約束
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk174 values (1, '★★ 同一張契約存兩種暫收', coalesce(v_msg, '⚠ 沒跑到'),
    '唯一索引 ＋ ON CONFLICT 都要對得上');
end $$;


/*
 * ★★ 第二題:訂金階段的契約**不會長出任何東西**。
 *
 *   放寬 NOT NULL 的風險全在這裡。階段 0 查過三支函式都有防護，
 *   但那是讀程式碼 —— 這裡真的存一筆再數。
 */
do $$
declare v_est uuid; v_ct uuid; v_orders int; v_recog int; v_msg text;
begin
  select id into v_est from public.estates limit 1;
  if v_est is null then
    insert into _chk174 values (2, '★★ 訂金契約不長月租單', '⚠ 測不出來', '一個物業都沒有');
    return;
  end if;

  begin
    insert into public.contracts (name, estate_id, tenant_name, earnest_only, earnest_amount)
    values ('__174測試__', v_est, 'Test', true, 10000)
    returning id into v_ct;

    /*
     * ★ 用 `orders.contract_id` 關聯，不是 order_key 的字串比對。
     *
     *   而認列要**透過訂單**數 —— `revenue_recognitions` 只有 `order_id`，
     *   沒有 contract_id 也沒有 source_id（查證過 schema-baseline:336）。
     *   migration_137:108 也是這樣 join 的。
     */
    select count(*) into v_orders from public.orders where contract_id = v_ct;
    select count(*) into v_recog
      from public.revenue_recognitions r
      join public.orders o on o.id = r.order_id
     where o.contract_id = v_ct;

    v_msg := case when v_orders = 0 and v_recog = 0
                  then '✅ 月租單 0 筆、認列 0 筆'
                  else '❌ 長出了 ' || v_orders || ' 筆月租單、' || v_recog || ' 筆認列' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then v_msg := '❌ 存不進去:' || sqlerrm; end if;
  end;

  insert into _chk174 values (2, '★★ 訂金契約不長月租單／認列', coalesce(v_msg, '⚠ 沒跑到'),
    '三欄都空的契約要安安靜靜什麼都不做');
end $$;


/*
 * ★★ 第三題:一般契約**不准**三欄空著。
 *   沒有這道約束的話，漏填會變成一張「看起來只是還沒設定好」的契約。
 */
do $$
declare v_est uuid; v_msg text;
begin
  select id into v_est from public.estates limit 1;
  if v_est is null then return; end if;

  begin
    insert into public.contracts (name, estate_id, tenant_name, earnest_only)
    values ('__174測試2__', v_est, 'Test', false);
    v_msg := '❌ 沒擋住 —— 一般契約可以三欄都空';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when check_violation then
    v_msg := '✅ 擋下來了';
  when others then
    if sqlerrm <> '__rollback__' then v_msg := '⚠ ' || sqlerrm; end if;
  end;

  insert into _chk174 values (3, '★★ 一般契約不准三欄空著', coalesce(v_msg, '⚠ 沒跑到'),
    'earnest_only = false 時三欄都是必填');
end $$;


/*
 * ★★ 第四題:三條路互斥。
 */
do $$
declare v_id uuid; v_msg text;
begin
  select id into v_id from public.deposits where received_on is not null limit 1;
  if v_id is null then
    insert into _chk174 values (4, '★★ 退款/沒收/轉押 三選一', '⚠ 測不出來', '沒有已收的暫收');
    return;
  end if;

  begin
    update public.deposits
       set returned_on = current_date, forfeited_on = current_date
     where id = v_id;
    v_msg := '❌ 沒擋住 —— 可以同時退款又沒收';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when check_violation then
    v_msg := '✅ 擋下來了';
  when others then
    if sqlerrm <> '__rollback__' then v_msg := '⚠ ' || sqlerrm; end if;
  end;

  insert into _chk174 values (4, '★★ 退款/沒收/轉押 三選一', coalesce(v_msg, '⚠ 沒跑到'),
    '走過一條就不能再走另一條');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk174 c

  union all
  /*
   * ★★ 索引必須帶 kind **而且**保留原本的 where。
   *   where 不見了的話 on conflict 推不出它（README 9.1②）。
   */
  select 5, '★★ 唯一索引的形狀',
         coalesce((select indexdef from pg_indexes
                    where schemaname = 'public'
                      and indexname = 'deposits_contract_kind_uidx'),
                  '❌ 索引不見了'),
         '要有 kind,而且要保留 WHERE contract_id IS NOT NULL'

  union all
  select 6, '★ 舊索引已經清掉',
         case when not exists (
           select 1 from pg_indexes
            where schemaname = 'public' and tablename = 'deposits'
              and indexdef like '%contract_id%currency%'
              and indexdef not like '%kind%')
         then '✅' else '❌ 舊索引還在,訂金會撞上去' end,
         '留著的話同一張契約仍然只能有一列'

  union all
  select 7, '★ 既有押金全部維持原狀',
         count(*) filter (where kind = 'deposit')::text || ' 筆押金 ／ '
         || count(*) filter (where kind = 'earnest')::text || ' 筆訂金',
         '這支只加欄位,訂金要等前端做完才進得來'
    from public.deposits

  union all
  select 8, '★ 現有契約沒有被約束擋到',
         count(*)::text || ' 筆三欄有缺的一般契約',
         '應為 0 —— 不是 0 的話那些契約以後改不動'
    from public.contracts
   where not earnest_only
     and (start_date is null or end_date is null or amount_per_period is null)

) v order by ord;
