/*
 * migration_256_order_earnest.sql　2026-09-15
 * 訂單也能收訂金：一張單放得下「押金」與「訂金」兩列
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ 這支要**先跑**，再推前端。前端會寫 orders.earnest_amount，
 *            欄位不存在的話那個存檔會整個失敗。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-15：雪雪在 14B1／14B3 各付了一筆訂金，
 * 那兩筆現在掛在「訂金階段的契約」上，要改成私下訂單。
 *
 * 但訂單這邊收不了訂金 —— 不是沒有欄位那麼簡單:
 *
 *     dep_order_once_idx = UNIQUE(order_id)
 *
 * **一張訂單只能有一列 deposits。** 所有幣別與寵物押金全部塞在
 * 同一列的 lines 裡，amount 是台幣合計。
 * 而訂金有自己的一生（收 → 退／沒收／轉押金，三條互斥），
 * 所以它必須是自己一列 —— 跟押金擠在同一列的話，
 * 「退了訂金」會變成「退了整張單的押金」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 照抄契約，不要自己發明】
 *
 * 契約那邊 migration_174～176 已經做完這件事:
 *
 *     contracts.earnest_amount　　　　　　欄位
 *     trg_sync_contract_earnest　　　　　 觸發器
 *     sync_contract_earnest()　　　　　　 同步函式
 *     deposits_contract_kind_uidx　　　　 (contract_id, currency, kind)
 *
 * 這支就是把同一套搬到訂單上，**連欄位名字都一樣**（earnest_amount）。
 * 自己取別的名字的結果是以後每寫一次查詢都要先想「這張表是哪個」，
 * 而兩邊的邏輯會慢慢分岔 —— 分岔的地方不會報錯，
 * 只會是「契約的訂金這樣算、訂單的訂金那樣算」，
 * 直到某天兩張報表對不起來才有人發現。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼訂金只有台幣】
 *
 * 契約那邊的訂金也只有台幣（contracts 有 fx_deposit，沒有 fx_earnest）。
 * 這支跟著只做台幣 —— 不是偷懶，是**兩邊要一樣**。
 * 哪天真的收到外幣訂金，兩邊一起加。
 *
 * ══════════════════════════════════════════════════════════
 * 【查過哪些東西不用改（2026-09-15，四支查詢）】
 *
 *   mark_deposits_orphaned　　訂單刪了把該訂單的 deposits 全部標孤兒。
 *                             押金與訂金都該標 —— 本來就對，不動。
 *   transfer_deposit　　　　　 吃的是明確的兩個 deposit id，不會撈錯。
 *   order_fee_deposit_guard　  走 orders.deposit_id（加費單指向某一筆押金），
 *                             跟「這張訂單有幾列押金」無關。
 *   order_locked_reason　　　  同上，也是走 orders.deposit_id。
 *
 * ★ 要改的只有 sync_order_deposits（收尾沒分 kind）。
 *   前端還有一支 pickDeposit 要一起改，那在 code 那邊。
 * ══════════════════════════════════════════════════════════
 */

begin;

/* ── ① 欄位：跟 contracts 同名 ───────────────────────────── */

alter table public.orders
  add column if not exists earnest_amount numeric not null default 0;

comment on column public.orders.earnest_amount is
  '訂金（台幣）。跟 contracts.earnest_amount 同名同義。'
  '> 0 時由 trg_sync_order_earnest 同步出一列 deposits(kind=''earnest'')，'
  '收退／沒收／轉押金走押金管理頁。0 = 這張單沒收訂金。migration_256。';


/* ── ② 索引：一張訂單每種 kind 各一列 ────────────────────── */

/*
 * ★★★ 舊的是 UNIQUE(order_id) —— 一張訂單只能一列，
 *   訂金插不進去（而且錯誤是唯一約束衝突，訊息跟訂金無關）。
 *
 * ★ 現有資料一定不會違反新索引:舊索引保證了「一張單一列」，
 *   所以 (order_id, kind) 本來就唯一。自檢 ⑥ 會再確認一次。
 */
drop index if exists public.dep_order_once_idx;

create unique index if not exists deposits_order_kind_uidx
  on public.deposits (order_id, kind)
  where order_id is not null;

comment on index public.deposits_order_kind_uidx is
  '一張訂單的每一種 kind 各一列（押金一列、訂金一列）。'
  '幣別不在索引裡 —— 訂單的多幣別是塞在同一列的 lines，'
  '跟契約那邊 (contract_id, currency, kind) 的形狀不一樣。migration_256。';


/* ── ③ 押金同步：加上 kind，收尾只掃自己那一種 ───────────── */

create or replace function public.sync_order_deposits()
returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
declare
  arr jsonb := '[]'::jsonb;
  twd numeric := coalesce(new.deposit, 0);
  pet numeric := coalesce(new.pet_deposit, 0);
  l jsonb; c text; a numeric;
begin
  /*
   * ★ 一般押金。item 明寫「一般押金」而不是留空 ——
   *   留空的話畫面上要靠 `item ?? '一般押金'` 補，而那個 ?? 會被複製到
   *   每一個顯示的地方，然後某一處漏掉（CLAUDE.md:讓資料自己說清楚）。
   *
   * ★★ 舊資料的 lines **沒有** item，那是刻意不回填的:
   *   回填之後就分不出「這是同步寫的」與「這是 194 之前的」。
   *   顯示端用 itemLabel() 統一當成一般押金。
   */
  if twd > 0 then
    arr := arr || jsonb_build_object('cur', 'TWD', 'amt', twd, 'item', '一般押金');
  end if;

  /*
   * ★★★ 寵物押金**不依賴 twd** —— 只收寵物押金、不收一般押金是合法的
   *   （短住的房客常常只押寵物）。寫成 `if twd > 0 then ... pet` 的話
   *   那種訂單的寵物押金會安靜消失。
   */
  if pet > 0 then
    arr := arr || jsonb_build_object('cur', 'TWD', 'amt', pet, 'item', '寵物押金');
  end if;

  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := upper(nullif(trim(l->>'cur'), ''));
    a := coalesce((l->>'amt')::numeric, 0);
    -- 台幣不會出現在 fx_deposit（前端存檔時就分開了），這裡再擋一次,
    -- 免得手動改資料的人把台幣塞進去造成 lines 裡多一個沒有項目的 TWD。
    if c is not null and a > 0 and c <> 'TWD' then
      arr := arr || jsonb_build_object('cur', c, 'amt', a, 'item', '一般押金');
    end if;
  end loop;

  -- 完全沒有押金了。還沒收錢的直接清掉；已經收了的留著標 orphaned ——
  -- 錢在我們手上，紀錄不能無聲消失。
  --
  -- ★ 判斷用 arr 的長度而不是 `twd = 0`：加了寵物押金之後，
  --   「一般押金清空、寵物押金還在」是合法狀態，而它不該觸發刪除。
  --
  -- ★★★ migration_256 加的 `kind = 'deposit'` **三個字不能少**。
  --   少了的話，這張單的**訂金**會被一起清掉或標成孤兒 ——
  --   而觸發它的只是有人改了房客姓名。
  --   契約那邊 migration_176 踩過同一個坑，註解就寫在 sync_contract_earnest 裡。
  if jsonb_array_length(arr) = 0 then
    delete from deposits
     where order_id = new.id and kind = 'deposit' and received_on is null;
    update deposits set orphaned = true
     where order_id = new.id and kind = 'deposit' and received_on is not null;
    return new;
  end if;

  insert into deposits (order_id, currency, amount, lines,
                        estate_id, property_id, room, guest_name, kind)
  -- ★★ amount 是**台幣合計**（含寵物押金）。
  --    deposit-lines 的 twdOf() 與 order_fee_deposit_guard() 都靠它。
  values (new.id, 'TWD', twd + pet, arr,
          new.estate_id, new.property_id, new.property_raw, new.guest_name, 'deposit')
  on conflict (order_id, kind) where order_id is not null
  do update set amount = excluded.amount, lines = excluded.lines,
                estate_id = excluded.estate_id, property_id = excluded.property_id,
                room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  return new;
end $fn$;


/* ── ④ 訂金同步：照抄 sync_contract_earnest ─────────────── */

create or replace function public.sync_order_earnest()
returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
begin
  if coalesce(new.earnest_amount, 0) > 0 then
    insert into deposits (order_id, currency, amount, lines,
                          estate_id, property_id, room, guest_name, kind)
    values (new.id, 'TWD', new.earnest_amount,
            jsonb_build_array(jsonb_build_object(
              'cur', 'TWD', 'amt', new.earnest_amount, 'item', '一般押金')),
            new.estate_id, new.property_id, new.property_raw, new.guest_name, 'earnest')
    on conflict (order_id, kind) where order_id is not null
    do update set amount = excluded.amount,
                  lines = excluded.lines,
                  estate_id = excluded.estate_id, property_id = excluded.property_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    /*
     * ★ `kind = 'earnest'` 那三個字不能少 —— 少了會把押金也清掉。
     *   （契約那邊 migration_176 的原註解，一字不改搬過來。）
     */
    delete from deposits
     where order_id = new.id and kind = 'earnest' and received_on is null;
    update deposits set orphaned = true
     where order_id = new.id and kind = 'earnest' and received_on is not null;
  end if;
  return new;
end $fn$;

comment on function public.sync_order_earnest() is
  'orders.earnest_amount → deposits(kind=''earnest'')。'
  'sync_contract_earnest() 的訂單版，兩邊要一起改。migration_256。';

drop trigger if exists trg_sync_order_earnest on public.orders;
/*
 * ★ 監看的欄位跟 trg_sync_order_deposits 一樣要含「會變的歸屬欄」——
 *   房客改名、換房源之後，那一列押金上的快照要跟著走，
 *   不然押金管理頁上那筆錢還掛在舊房號、舊名字底下。
 */
create trigger trg_sync_order_earnest
  after insert or update of earnest_amount, estate_id, property_id, property_raw, guest_name
  on public.orders
  for each row execute function public.sync_order_earnest();

commit;


/* ── 自檢 ───────────────────────────────────────────────── */

create temp table _m256_test (ord int, name text, detail text, verdict text);

do $do$
declare
  v_oid  uuid;
  v_dep  int := -1;
  v_ear  int := -1;
  v_err  text := '';
begin
  /*
   * ★★ 真的建一張訂單、設押金與訂金，看會不會長出兩列，然後整個退掉。
   *   只看函式原始碼有沒有 'kind' 證明不了它真的分得開 ——
   *   而「分不開」的症狀是那筆訂金某天無聲變成孤兒（README 坑 C 的親戚）。
   *
   * ★ 整段包在 exception 裡，測完丟 sentinel 自己回滾。
   *   plpgsql 的變數在子交易回滾之後**還留著**，所以結果帶得出來。
   */
  begin
    insert into public.orders (
      order_key, source, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, earnest_amount, imported_via)
    values ('_M256_SELFTEST_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
            'private', '_m256_測試房', '_m256_測試',
            current_date + 400, current_date + 401, 1, 0, 1000, 2000, 'manual')
    returning id into v_oid;

    select count(*) filter (where kind = 'deposit'),
           count(*) filter (where kind = 'earnest')
      into v_dep, v_ear
      from public.deposits where order_id = v_oid;

    raise exception 'M256_ROLLBACK';
  exception when others then
    if sqlerrm <> 'M256_ROLLBACK' then v_err := sqlerrm; end if;
  end;

  insert into _m256_test values
    (5, '⑤ 活體測試：一張單同時有押金與訂金（已退掉）',
     '押金 ' || v_dep || ' 列　訂金 ' || v_ear || ' 列'
       || case when v_err <> '' then '　（' || left(v_err, 90) || '）' else '' end,
     case when v_dep = 1 and v_ear = 1 then '✅ 兩列各自成立'
          when v_err <> '' then '❌ 測試沒跑完，看上面那句'
          else '❌ 列數不對' end);
end $do$;


select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① orders.earnest_amount',
         coalesce((select data_type || '　預設 ' || coalesce(column_default, '（無）')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'orders'
                      and column_name = 'earnest_amount'), '★ 沒有這一欄'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'orders'
                              and column_name = 'earnest_amount')
              then '✅ 有' else '❌' end

  union all
  select 2, '② 索引換成 (order_id, kind)',
         coalesce((select indexdef from pg_indexes
                    where schemaname = 'public' and tablename = 'deposits'
                      and indexname = 'deposits_order_kind_uidx'), '★ 沒有')
           || case when exists (select 1 from pg_indexes
                                 where schemaname = 'public' and tablename = 'deposits'
                                   and indexname = 'dep_order_once_idx')
                   then '　★★ 舊的 dep_order_once_idx 還在！' else '' end,
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public' and tablename = 'deposits'
                              and indexname = 'deposits_order_kind_uidx')
               and not exists (select 1 from pg_indexes
                                where schemaname = 'public' and tablename = 'deposits'
                                  and indexname = 'dep_order_once_idx')
              then '✅ 換好了' else '❌' end

  union all
  /*
   * ★★★ 這一條是整支的重點:收尾那兩句有沒有帶 kind。
   *   沒帶的話改個房客姓名就會把訂金標成孤兒，而且不會報錯。
   */
  select 3, '③ sync_order_deposits 收尾有分 kind',
         case when (select prosrc from pg_proc
                     where oid = 'public.sync_order_deposits()'::regprocedure)
                   ~ 'kind = ''deposit'''
              then '有 —— 只掃自己那一種'
              else '★ 沒有 —— 訂金會被它清掉或標孤兒' end,
         case when (select prosrc from pg_proc
                     where oid = 'public.sync_order_deposits()'::regprocedure)
                   ~ 'kind = ''deposit''' then '✅' else '❌' end

  union all
  select 4, '④ sync_order_earnest 與觸發器都在',
         (case when exists (select 1 from pg_proc
                             where oid = 'public.sync_order_earnest()'::regprocedure)
               then '函式有' else '★ 函式沒有' end)
         || '　'
         || coalesce((select tgname from pg_trigger
                       where tgrelid = 'public.orders'::regclass
                         and tgname = 'trg_sync_order_earnest'), '★ 觸發器沒有'),
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.orders'::regclass
                              and tgname = 'trg_sync_order_earnest')
              then '✅' else '❌' end

  union all
  select t.ord, t.name, t.detail, t.verdict from _m256_test t

  union all
  /*
   * ⑥ 這支不該動到任何一筆既有資料。
   *   有訂金掛在訂單上就是有東西被意外建出來了 ——
   *   9/15 查過是 0 筆，雪雪那兩筆要等搬移腳本才會出現。
   */
  select 6, '⑥ 沒有意外生出訂金',
         (select count(*)::text || ' 筆訂金掛在訂單上'
            from public.deposits where order_id is not null and kind = 'earnest'),
         case when (select count(*) from public.deposits
                     where order_id is not null and kind = 'earnest') = 0
              then '✅ 0 筆（跟跑之前一樣）' else '❌ 多出東西了' end

  union all
  select 7, '⑦ 測試訂單沒有留下來',
         (select count(*)::text || ' 張'
            from public.orders where order_key like '_M256_SELFTEST_%'),
         case when (select count(*) from public.orders
                     where order_key like '_M256_SELFTEST_%') = 0
              then '✅ 自己退乾淨了' else '❌ 有殘留，要手動刪' end

  union all
  select 8, '⑧ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
