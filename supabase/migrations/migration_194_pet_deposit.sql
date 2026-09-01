/*
 * migration_194 —— 寵物押金：orders.pet_deposit，並讓押金明細帶項目
 * ============================================================
 * 2026-09-01。接在 193 後面，修正 193 的一個放錯位置。
 *
 * ============================================================
 * 【★★★ 193 的 deposits.item 放錯層級，這支拿掉】
 *
 * 193 把 `item` 加在 deposits 的**列**上，前提是「寵物押金 = 獨立的一列」。
 * 但查證之後發現那個前提是錯的:
 *
 *     CREATE UNIQUE INDEX dep_order_once_idx
 *       ON deposits (order_id) WHERE order_id IS NOT NULL
 *
 *   一張訂單只能有一列押金 —— 第二列**插不進去**，不是被洗掉，是資料庫直接擋。
 *
 * ★ 而多幣別早就解過同一個問題:明細放在 `deposits.lines` 這個 jsonb 陣列裡。
 *   `lib/deposit-lines.ts` 的檔頭寫著「多幣別的現金實務上放在同一個保險箱
 *   一起保管，之後一起退。一次收、一次退、一組帳戶。」
 *   **寵物押金跟一般押金正好也在同一個保險箱。**
 *
 *   所以 item 該在 lines 的每一筆上，不在列上:
 *
 *     lines = [{"cur":"TWD","amt":100000,"item":"一般押金"},
 *              {"cur":"TWD","amt":30000, "item":"寵物押金"},
 *              {"cur":"JPY","amt":10000, "item":"一般押金"}]
 *
 * ★★ 留一個永遠是 null 的欄位比加了又拿掉更糟 ——
 *   三個月後有人會以為它有意義，然後拿去用。
 *
 * ============================================================
 * 【★★★ 這支最大的風險:trigger 的 UPDATE OF 清單】
 *
 *     CREATE TRIGGER trg_sync_order_deposits
 *       AFTER INSERT OR UPDATE OF deposit, fx_deposit, estate_id, ...
 *
 * 這是**欄位級**的觸發條件。加了 `pet_deposit` 卻忘了把它列進去的話:
 *
 *     只改寵物押金 → trigger 不跑 → 訂單上有 30,000，押金管理頁沒有
 *
 * 而**不會有任何錯誤訊息**。使用者以為存好了，錢在收退清單上根本不存在。
 * ★ 自檢第 3 列專門盯這件事。
 *
 * ============================================================
 * 【amount 為什麼要含寵物押金】
 *
 *   · `deposit-lines.ts:38` 註明「twdOf 等於 deposits.amount，
 *      兩者對不起來就是資料壞了」—— twdOf 是 lines 裡 TWD 的**合計**。
 *   · `order_fee_deposit_guard()` 拿 `d.amount` 當「加費從押金扣」的上限。
 *      不含寵物押金的話，明明押金有 130,000 卻只讓扣 100,000。
 */

-- ══════════════════════════════════════════════════════════
-- ① 拆掉 193 放錯位置的欄位
-- ══════════════════════════════════════════════════════════
do $$ begin
  begin
    alter table public.deposits drop constraint dep_item_chk;
  exception when undefined_object then null; end;
end $$;

alter table public.deposits drop column if exists item;


-- ══════════════════════════════════════════════════════════
-- ② 訂單的寵物押金
-- ══════════════════════════════════════════════════════════
alter table public.orders
  add column if not exists pet_deposit numeric(14,2);

comment on column public.orders.pet_deposit is
  '寵物押金（migration_194）。null 或 0 = 沒收。'
  '★ 跟 deposit 分開存，因為 deposit 是「一個數字」——'
  'lib/money-lines 的 fromLines() 會把畫面上所有台幣列加總進去，'
  '合著存的話「一般 100,000 ＋ 寵物 30,000」會變成 130,000，項目消失。'
  '★★ 改這個欄位要能觸發 trg_sync_order_deposits —— 見該 trigger 的 UPDATE OF 清單。';

do $$ begin
  begin
    alter table public.orders
      add constraint orders_pet_deposit_nonneg_chk
      check (pet_deposit is null or pet_deposit >= 0);
  exception when duplicate_object then null; end;
end $$;


-- ══════════════════════════════════════════════════════════
-- ③ 改寫同步函式
-- ══════════════════════════════════════════════════════════
create or replace function public.sync_order_deposits() returns trigger
  language plpgsql security definer set search_path to 'public'
as $function$
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
  if jsonb_array_length(arr) = 0 then
    delete from deposits where order_id = new.id and received_on is null;
    update deposits set orphaned = true
     where order_id = new.id and received_on is not null;
    return new;
  end if;

  insert into deposits (order_id, currency, amount, lines,
                        estate_id, property_id, room, guest_name)
  -- ★★ amount 是**台幣合計**（含寵物押金）。見檔頭第四段:
  --    deposit-lines 的 twdOf() 與 order_fee_deposit_guard() 都靠它。
  values (new.id, 'TWD', twd + pet, arr,
          new.estate_id, new.property_id, new.property_raw, new.guest_name)
  on conflict (order_id) where order_id is not null
  do update set amount = excluded.amount, lines = excluded.lines,
                estate_id = excluded.estate_id, property_id = excluded.property_id,
                room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  return new;
end $function$;


-- ══════════════════════════════════════════════════════════
-- ④ ★★★ trigger 重掛，UPDATE OF 清單加 pet_deposit
-- ══════════════════════════════════════════════════════════
drop trigger if exists trg_sync_order_deposits on public.orders;

create trigger trg_sync_order_deposits
  after insert or update of
    deposit, pet_deposit, fx_deposit, estate_id, property_id, property_raw, guest_name
  on public.orders
  for each row execute function public.sync_order_deposits();


-- ══════════════════════════════════════════════════════════
-- ⑤ 既有押金的 lines 補上項目
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 這一步跟「不回填」矛盾嗎？不矛盾 —— 差別在**它是推導得出來的**。
 *
 *   193 不回填 deposits.item，是因為那個欄位當時沒有任何來源，
 *   填什麼都是猜。
 *
 *   這裡不一樣:194 之前**根本沒有寵物押金這個東西**，
 *   所以既有的每一筆 lines 一定都是一般押金 —— 這是事實，不是猜測。
 *
 * ★ 不補的話，同一張押金管理頁上會出現「有標項目的」與「沒標的」兩種列，
 *   而使用者會問「沒標的那些是什麼」。
 */
update public.deposits
   set lines = (
     select jsonb_agg(
              case when l ? 'item' then l
                   else l || jsonb_build_object('item', '一般押金') end)
       from jsonb_array_elements(lines) l)
 where jsonb_typeof(lines) = 'array'
   and jsonb_array_length(lines) > 0
   and exists (select 1 from jsonb_array_elements(lines) l where not (l ? 'item'));


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('194_pet_deposit');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄留在子查詢（`v.ord`）—— `order by 1` 會照文字排。
-- ★ `pg_get_functiondef` 一律加 prokind 過濾（2026-09-01 踩過 array_agg）。
-- ★ 基準值不依賴這支改的東西:第 5 列用「對不起來的筆數」（應為 0），
--   不用「某一筆的金額」—— 那正是這支會改的量（migration_187／191 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① 193 放錯位置的欄位已移除',
         (select case when count(*) = 0 then '✅ deposits.item 不見了'
                      else '⚠ 還在 —— 那個欄位永遠會是 null' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'deposits' and column_name = 'item'),
         '項目改放在 lines 的每一筆上（見第 4 列）'

  union all
  select 2, '② orders.pet_deposit 建好了',
         (select case when count(*) = 1
                      then '✅ 欄位存在，' || (select count(*) from public.orders
                                                where coalesce(pet_deposit, 0) > 0)::text
                           || ' 筆訂單有寵物押金（剛建好應為 0）'
                      else '⚠ 欄位不存在' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'orders' and column_name = 'pet_deposit'),
         '4985 筆訂單一筆都不該有值 —— 這支不填任何金額'

  union all
  /*
   * ★★★ 這一列是這支最重要的檢查。
   *   UPDATE OF 是欄位級條件:漏了 pet_deposit，改寵物押金就不會同步，
   *   而畫面上不會有任何錯誤 —— 押金管理頁單純地少一筆。
   */
  select 3, '★★★ ③ trigger 會被 pet_deposit 觸發嗎',
         (select case when pg_get_triggerdef(t.oid) ilike '%pet_deposit%'
                      then '✅ UPDATE OF 清單裡有 pet_deposit'
                      else '⚠⚠⚠ 沒有！只改寵物押金不會同步到押金管理頁，而且不會報錯' end
            from pg_trigger t
           where t.tgrelid = 'public.orders'::regclass
             and t.tgname = 'trg_sync_order_deposits'),
         '★ 這是全支最容易出錯又最難發現的一點'

  union all
  select 4, '④ 同步函式改好了',
         (select case
                   when d ilike '%寵物押金%' and d ilike '%twd + pet%' and d ilike '%一般押金%'
                     then '✅ 寵物押金那一筆、amount 含寵物押金、一般押金標記 —— 三項都在'
                   else '⚠ 缺:'
                        || case when d not ilike '%寵物押金%' then '寵物押金那一筆 ' else '' end
                        || case when d not ilike '%twd + pet%' then 'amount 沒含寵物押金 ' else '' end
                        || case when d not ilike '%一般押金%'   then '一般押金標記 ' else '' end
                 end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f', 'p')
                     and p.proname = 'sync_order_deposits') x),
         '★ prokind 過濾不能省 —— 掃到聚合函式會整支回滾'

  union all
  /*
   * ★★ 基準值不依賴這支改的東西:算的是「對不起來的筆數」，
   *   而正確答案永遠是 0，跟這支改了多少列無關。
   */
  select 5, '★★ ⑤ amount 與 lines 的台幣合計仍然一致',
         (select case when count(*) = 0
                      then '✅ ' || (select count(*) from public.deposits)::text
                           || ' 筆全部對得起來'
                      else '⚠ 有 ' || count(*) || ' 筆對不起來 —— deposit-lines 的前提破了' end
            from public.deposits d
           where round(coalesce(d.amount, 0), 2) <> round((
                   select coalesce(sum((l->>'amt')::numeric), 0)
                     from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l
                    where upper(l->>'cur') = 'TWD'), 2)),
         '★ deposit-lines.ts:38「twdOf 等於 amount，對不起來就是資料壞了」'

  union all
  select 6, '⑥ 既有押金的 lines 都補上項目了',
         (select case when count(*) filter (where miss) = 0
                      then '✅ ' || count(*) || ' 筆的明細全部有 item'
                      else '⚠ 有 ' || count(*) filter (where miss) || ' 筆還缺' end
            from (select exists (select 1 from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l
                                  where not (l ? 'item')) miss
                    from public.deposits d
                   where jsonb_typeof(d.lines) = 'array'
                     and jsonb_array_length(d.lines) > 0) y),
         '★ 194 之前沒有寵物押金這個東西，所以既有的一定都是一般押金 —— 這是推導，不是猜'

  union all
  select 7, '⑦ 金額一毛都沒動',
         (select (select count(*) from public.deposits)::text || ' 筆押金 ／ 台幣總額 '
                 || (select coalesce(sum(amount), 0)::text from public.deposits)
                 || ' ／ ' || (select count(*) from public.orders)::text || ' 筆訂單'),
         '★ 這支只加標記與欄位。押金筆數與總額要跟跑之前一樣（193 那次是 105 筆）'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
