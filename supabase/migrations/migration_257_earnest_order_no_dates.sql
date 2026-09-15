/*
 * migration_257_earnest_order_no_dates.sql　2026-09-15
 * 訂金階段的訂單可以先不填起訖日
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ 256 要先跑完。
 *          ★★★ 這支會**自己驗自己**:真的建一張沒有日期的訂金單，
 *            確認沒有任何觸發器炸掉、也沒有生出髒資料，
 *            通不過的話**連前面的 DDL 一起回滾** —— 不會留下半套。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-15：「勾了訂金的可以先不填起訖。」
 *
 * 雪雪在 14B1／14B3 各付了訂金，但住哪幾天還沒定。
 * 契約那邊有這個狀態（earnest_only，目前 4 張），訂單這邊沒有 ——
 * 而 orders.checkin / checkout 是 NOT NULL。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這個改法真正的風險，以及怎麼把它做窄】
 *
 * 危險不是報錯，是**算錯而不報錯**:
 *
 *     關帳月份算不出來　→ 那筆單永遠鎖不住
 *     營收認列吃到 null → 認列少一筆，報表只是變小
 *     晚數變 null　　　 → 平均房價的分母錯
 *     日曆少畫一段　　　→ 有人照著它排房
 *
 * 前端有 373 處碰這兩個欄位。**全部當成「可能是 null」來審是做不完的**，
 * 而做不完的審查等於沒審。
 *
 * ★★★ 所以加一條 CHECK:
 *
 *     earnest_only 為真，或者兩個日期都有
 *
 *   有了它，「可能沒有日期」的**只剩訂金階段的單**，
 *   其餘每一張的日期照樣保證存在。
 *   要審的問題就從「373 處都可能吃到 null」
 *   縮成「哪幾處要把訂金階段的單排除掉」—— 那是數得完的。
 *
 * ══════════════════════════════════════════════════════════
 * 【查過的（2026-09-15）】
 *
 *   gen_recognitions　　　開頭就有 `if o.checkin is null … then return`
 *                         —— 營收認列早就防過 null，不用改
 *   ord_dates_chk　　　　 `checkin IS NULL OR checkout IS NULL OR …`
 *   ord_stay_nights_chk　 同上 —— 兩條既有 CHECK 本來就容得下 null
 *   idx_orders_checkin　　btree，null 進得去，不衝突
 *   uq_contract_order_month　(contract_id, checkin) 部分唯一索引 ——
 *                         只管 imported_via='contract' 的月租單，
 *                         而訂金單是手動私下單，碰不到它
 *
 * ★ 沒查到原始碼的是 hk_sync_order_tasks（房務排班）——
 *   所以自檢 ⑤ 用**動態掃描**:插一張沒有日期的訂金單之後，
 *   把所有 hk_* 裡有 order_id 的表都數一遍。
 *   生出任何一列就是紅的。
 *
 * ══════════════════════════════════════════════════════════
 * 【前端要怎麼配合（寫在這裡，免得兩邊對不上）】
 *
 * **不要再多一個勾。** 使用者說的是「勾了訂金的可以先不填起訖」，
 * 所以 earnest_only 是**存檔時算出來的**:
 *
 *     earnest_only = (沒填入住日 或 沒填退房日)
 *
 * 而 CHECK 保證了反向:沒有日期就一定是 earnest_only。
 * 兩邊合起來，畫面上只有「訂金」那一個勾，資料庫那邊狀態明確。
 * ══════════════════════════════════════════════════════════
 */

/*
 * ★ 自檢用的暫存表建在交易**外面**。
 *   建在裡面的話，自檢沒過而整支回滾時這張表也跟著消失，
 *   最後那段 select 會變成「relation does not exist」——
 *   而那句錯誤會蓋掉我真正想讓人看到的失敗原因。
 */
create temp table if not exists _m257_test (ord int, name text, detail text, verdict text);

begin;

/* ── ① 訂金階段的旗標：跟 contracts 同名同義 ─────────────── */

alter table public.orders
  add column if not exists earnest_only boolean not null default false;

comment on column public.orders.earnest_only is
  '訂金階段:收了訂金但住哪幾天還沒定，所以 checkin / checkout 可以是 null。'
  '跟 contracts.earnest_only 同名同義。'
  '★ 前端不另外給勾 —— 存檔時由「有沒有填日期」算出來。migration_257。';


/* ── ② 日期放寬 ─────────────────────────────────────────── */

alter table public.orders alter column checkin  drop not null;
alter table public.orders alter column checkout drop not null;

/*
 * ★ nights 維持 NOT NULL，補一個預設 0。
 *   跟著改成可空的話，「這張單住幾晚」會多出第三種答案（null），
 *   而 129 處在算平均房價的地方要各自決定 null 怎麼辦。
 *   訂金階段就是 0 晚 —— 那是明確的事實，不是缺資料。
 */
alter table public.orders alter column nights set default 0;


/* ── ③ CHECK：沒有日期就一定是訂金階段 ──────────────────── */

alter table public.orders drop constraint if exists orders_earnest_dates_chk;
alter table public.orders add constraint orders_earnest_dates_chk
  check (earnest_only or (checkin is not null and checkout is not null));

comment on constraint orders_earnest_dates_chk on public.orders is
  '這條是整個設計的重點:沒有日期的單**只可能是訂金階段**。'
  '有了它，其餘每一張單的日期照樣保證存在 —— '
  '否則 373 處讀日期的程式全部都要當成「可能是 null」來審。migration_257。';


/* ── ④ 自己驗自己：過不了就連 DDL 一起回滾 ──────────────── */

do $do$
declare
  v_oid   uuid;
  v_recog int := -1;
  v_hk    int := 0;
  v_n     int;
  v_lock  text := '（沒測到）';
  v_ok    boolean := false;
  v_err   text := '';
  r       record;
begin
  /*
   * ★★ 真的插一張沒有日期的訂金單。
   *   只看約束加好了沒證明不了它能用 —— orders 上有 14 個觸發器，
   *   其中 hk_sync_order_tasks 我沒讀到原始碼。
   *   會不會炸、會不會生出髒資料，插一張下去最快。
   *
   * ★ 整段包在子交易裡，測完丟 sentinel 自己回滾 ——
   *   連 data_audit_log 那筆稽核紀錄也一起退掉，不留痕跡。
   */
  begin
    insert into public.orders (
      order_key, source, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, earnest_amount,
      earnest_only, imported_via, book)
    values ('_M257_SELFTEST_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
            'private', '_m257_測試房', '_m257_測試',
            null, null, 0, 0, 0, 5000,
            true, 'manual', 'anxing')
    returning id into v_oid;

    -- 營收認列不該生出來（gen_recognitions 開頭就 return，這裡確認它真的有）
    select count(*) into v_recog
      from public.revenue_recognitions where order_id = v_oid;

    -- 房務排班也不該生出來。表名不寫死 —— 掃所有 hk_* 裡有 order_id 的
    for r in
      select c.table_name from information_schema.columns c
       where c.table_schema = 'public' and c.column_name = 'order_id'
         and c.table_name like 'hk\_%'
    loop
      execute format('select count(*) from public.%I where order_id = $1', r.table_name)
        into v_n using v_oid;
      v_hk := v_hk + v_n;
    end loop;

    -- 關帳月份算不出來（沒有退房日），這是預期的 —— 記下來讓人看見
    select coalesce(public.order_lock_ym(o.*), '（null，算不出月份）')
      into v_lock from public.orders o where o.id = v_oid;

    v_ok := (v_recog = 0 and v_hk = 0);

    raise exception 'M257_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M257_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  /*
   * ★★★ 過不了就 raise —— 這一句會把上面的 DDL 一起回滾。
   *   半套的 schema 比沒改更糟:欄位放寬了、但某個觸發器會炸，
   *   而那要等到有人真的建一張訂金單才發現。
   */
  if v_err <> '' then
    raise exception '自檢沒過:插入沒有日期的訂金單時出錯 —— %　（整支已回滾，schema 沒有改動）', v_err;
  end if;
  if not v_ok then
    raise exception '自檢沒過:營收認列 % 列、房務排班 % 列（都該是 0）。整支已回滾。', v_recog, v_hk;
  end if;

  insert into _m257_test values
    (4, '④ 活體測試：建一張沒有日期的訂金單（已退掉）',
     '營收認列 ' || v_recog || ' 列　房務排班 ' || v_hk || ' 列　關帳月份 ' || v_lock,
     '✅ 沒炸、也沒生出髒資料');
end $do$;

commit;


/* ── 自檢表 ─────────────────────────────────────────────── */

select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① orders.earnest_only',
         coalesce((select data_type || '　預設 ' || coalesce(column_default, '（無）')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'orders'
                      and column_name = 'earnest_only'), '★ 沒有這一欄'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'orders'
                              and column_name = 'earnest_only')
              then '✅ 有' else '❌' end

  union all
  select 2, '② 日期可空、晚數有預設',
         (select string_agg(column_name || '='
                            || (case when is_nullable = 'NO' then 'NOT NULL' else '可空' end)
                            || coalesce('（預設 ' || column_default || '）', ''), '　'
                            order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'orders'
             and column_name in ('checkin', 'checkout', 'nights')),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'orders'
                       and column_name in ('checkin', 'checkout')
                       and is_nullable = 'YES') = 2
              then '✅ 兩個都可空' else '❌' end

  union all
  /*
   * ★★★ 這條是整個設計的重點。沒有它的話，
   *   任何一張單都可能沒有日期，而 373 處讀日期的程式全部要重審。
   */
  select 3, '③ CHECK：沒有日期就一定是訂金階段',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.orders'::regclass
                      and conname = 'orders_earnest_dates_chk'), '★ 沒有這條'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.orders'::regclass
                              and conname = 'orders_earnest_dates_chk')
              then '✅ 有' else '❌' end

  union all
  select t.ord, t.name, t.detail, t.verdict from _m257_test t

  union all
  /*
   * ⑤ 既有資料一張都不該變成訂金階段。
   *   這支只開路 —— 哪一張是訂金階段，是使用者在畫面上決定的。
   */
  /*
   * ★★★ 2026-09-15 這一行的字串**寫錯過一次**，修正記在這裡:
   *   原本是 `count(*)::text || ' 張是 earnest_only'` —— 少了 filter，
   *   印出來是**訂單總數 5170**，而判定欄用的是對的條件所以是綠的。
   *   於是畫面上出現「5170 張是 earnest_only ✅ 0 張」這種自相矛盾的一列。
   *
   *   資料完全沒事，說謊的是標籤 —— 而標籤說謊比數字錯更糟:
   *   看到的人會先相信那個數字，然後開始找一個不存在的問題（README 坑 D）。
   *
   * ★ 這支已經跑過，DDL 一個字都沒動 —— 只改自檢要印的字。
   *   重跑照樣安全（欄位與約束都是 if not exists / drop if exists）。
   */
  select 5, '⑤ 沒有既有訂單被改成訂金階段',
         (select count(*) filter (where earnest_only)::text || ' 張是 earnest_only　／　'
                 || count(*) filter (where checkin is null or checkout is null)::text
                 || ' 張沒有日期　／　共 ' || count(*) || ' 張'
            from public.orders),
         case when (select count(*) from public.orders where earnest_only) = 0
              then '✅ 0 張（跟跑之前一樣）' else '❌ 有東西被改到' end

  union all
  select 6, '⑥ 測試訂單沒有留下來',
         (select count(*)::text || ' 張'
            from public.orders where order_key like '_M257_SELFTEST_%'),
         case when (select count(*) from public.orders
                     where order_key like '_M257_SELFTEST_%') = 0
              then '✅ 自己退乾淨了' else '❌ 有殘留，要手動刪' end

  union all
  select 7, '⑦ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
