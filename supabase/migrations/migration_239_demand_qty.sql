begin;

/*
 * migration_239  採購需求:數量獨立成一欄
 * ------------------------------------------------------------
 * 2026-09-10 使用者：
 *   「1. 產品規格*  2. 需要數量*  3. 建議 改成 備註(採購地點 or 連結)」
 *
 * ★★★ 為什麼要拆
 *
 * 原本一個框叫「規格說明／大概數量」，**一個框裝兩件事**。
 * 結果是有人只寫規格（「除霉劑 大瓶」）、有人只寫數量（「3」）——
 * 會計拿到單子不知道要買幾瓶，而畫面上那一格**是填了的**，
 * 看起來完全正常。要問才問得出來，而問的成本是一趟來回。
 *
 * ============================================================
 * 【★★★ 為什麼是 text 不是 numeric】
 *
 * 提需求的當下講的是「兩箱」「一組」「5 支」。
 * 逼成數字欄的話，「一箱」只填得下 1 —— 而那個 1 是**假的**:
 * 會計看到 1 會買一支。
 *
 * ★ 代價:加不起來。這是刻意的 —— 要算錢的是請款單那邊。
 *
 * ============================================================
 * 【★★★ 這一支失敗過兩次，兩次都是同一類原因】（2026-09-10）
 *
 * `qty` 這一欄**早就存在**、型別是 `numeric`（`trg_pdi_lock` 的定義裡
 * 就提到它，只是前端從 migration_141 之後沒再用）。
 * 所以真正要做的事是「改型別」，而改型別會被**掛在那一欄上的東西**擋住:
 *
 *   第一版  只寫 alter ... type text using qty::text
 *           → 42804  default for column "qty" cannot be cast automatically
 *   第二版  補了 drop default、也查了 view
 *           → 42883  operator does not exist: text > numeric
 *                    （那個 `>` 來自欄位上的 check 約束，例如 qty > 0。
 *                      型別一換，Postgres 拿新的 text 去重驗那條約束）
 *
 * ★★★ 所以這一版不再一個一個補，改成**先把擋路的東西列成清單**:
 *
 *     ① view / rule    → 擋住就停下來報名字（不自己 drop 別人的東西）
 *     ② default        → drop（no-op 也安全）
 *     ③ check 約束     → drop，並把定義記進資料表的 COMMENT 留底
 *
 * ★★ 三樣都不會在寫 migration 的時候提醒你，而且錯誤訊息都**不說是誰**:
 *   42883 只講「text > numeric」，不講那個 `>` 從哪來的。
 *
 * ★ 整支包在 begin/commit 裡 —— 任何一句爆就全部回滾，
 *   而使用者看到的是「沒有 output」。**看不到自檢 = 失敗，不是沒輸出。**
 * ------------------------------------------------------------
 */

do $do$
declare
  t        text;
  deps     text;
  c        record;
  dropped  text[] := '{}';
  tbl_note text;
begin
  select data_type into t
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'purchase_demand_items'
     and column_name  = 'qty';

  ------------------------------------------------------------
  -- ① 沒有這一欄 → 補一個 text，結束
  ------------------------------------------------------------
  if t is null then
    alter table public.purchase_demand_items add column qty text;
    raise notice 'qty 不存在 —— 已新增 text';

  ------------------------------------------------------------
  -- ② 已經是文字 → 什麼都不做，舊值原樣留著
  ------------------------------------------------------------
  elsif t in ('text', 'character varying') then
    raise notice 'qty 已經是 % —— 不動', t;

  ------------------------------------------------------------
  -- ③ 是別的型別（實際上是 numeric）→ 清掉擋路的，再轉型
  ------------------------------------------------------------
  else

    /* ── ③-1 view / rule ────────────────────────────────
     *
     * ★★★ 有 view 指著這一欄的話 `alter type` 會被擋，
     *   而原始訊息只說「used by a view or rule」，**不講是哪一個**。
     *
     * ★★ 這裡**不自己 drop**。view 是別人寫的東西，
     *   靜靜刪掉它比擋下來危險 —— 停在這裡讓人決定。
     */
    select string_agg(distinct dep.relname, '、') into deps
      from pg_depend d
      join pg_rewrite   r   on r.oid   = d.objid
      join pg_class     dep on dep.oid = r.ev_class
      join pg_class     src on src.oid = d.refobjid
      join pg_attribute a   on a.attrelid = src.oid and a.attnum = d.refobjsubid
      join pg_namespace ns  on ns.oid  = src.relnamespace
     where ns.nspname  = 'public'
       and src.relname = 'purchase_demand_items'
       and a.attname   = 'qty'
       and dep.relname <> 'purchase_demand_items';

    if deps is not null then
      raise exception
        '有 view 指著 purchase_demand_items.qty：%。'
        ' 這一支停在這裡 —— 要先處理那幾個 view，不自己刪別人的東西。', deps;
    end if;

    /* ── ③-2 DEFAULT ────────────────────────────────────
     *
     * ★ 第一版死在這裡（42804）。numeric 的 default 不會自動轉成 text。
     * ★★ 對「本來就沒有 default」的欄位，drop default 是安全的 no-op ——
     *   所以不先問「有沒有」:多一個分支就是多一個會漏掉的地方。
     */
    alter table public.purchase_demand_items alter column qty drop default;

    /* ── ③-3 check 約束 ────────────────────────────────
     *
     * ★★★ 第二版死在這裡（42883:text > numeric）。
     *   那個 `>` 是欄位上的 check（例如 `qty > 0`）——
     *   型別一換，Postgres 拿新的 text 去重驗它。
     *
     * ★ 用 `\mqty\M`（詞邊界）比對，不是 `%qty%` ——
     *   後者會把 `quantity_note` 之類的欄位也掃進來，
     *   而誤刪一條別的約束**不會報錯**，只會讓一個守門的規則安靜消失。
     *
     * ★★ 刪掉的定義寫進資料表的 COMMENT 留底 ——
     *   「這條規則是被誰、什麼時候拿掉的」要查得到。
     *   刪一個看門的東西而沒有留下紀錄，比留著它更糟。
     */
    for c in
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.purchase_demand_items'::regclass
         and contype  = 'c'
         and pg_get_constraintdef(oid) ~ '\mqty\M'
    loop
      execute format(
        'alter table public.purchase_demand_items drop constraint %I', c.conname);
      dropped := dropped || (c.conname || '：' || c.def);
      raise notice '移除擋住轉型的約束 % → %', c.conname, c.def;
    end loop;

    /* ── ③-4 真正轉型 ───────────────────────────────────
     *
     * ★★ 把 `3.00` 收成 `3`。numeric 直接 ::text 會把尾巴的零帶出來，
     *   而畫面上「× 3.00 箱」看起來像系統壞了。
     */
    alter table public.purchase_demand_items
      alter column qty type text
      using case
              when qty is null      then null
              when qty = trunc(qty) then trunc(qty)::bigint::text
              else qty::text
            end;

    raise notice 'qty 原本是 % —— 已轉成 text，順手移除 % 條約束',
                 t, coalesce(array_length(dropped, 1), 0);

    -- ★ 留底。接在原本的表說明後面，不覆蓋它
    if array_length(dropped, 1) > 0 then
      select obj_description('public.purchase_demand_items'::regclass, 'pg_class')
        into tbl_note;
      execute format(
        'comment on table public.purchase_demand_items is %L',
        coalesce(tbl_note || ' ', '')
        || '★ migration_239 把 qty 從 ' || t || ' 轉成 text，'
        || '過程中移除了這些與 qty 有關的舊約束：'
        || array_to_string(dropped, '；')
        || '（text 欄位上那些數字比較沒有意義；數量現在是「兩箱」這種文字）。');
    end if;
  end if;
end $do$;

comment on column public.purchase_demand_items.qty is
  '需要數量（migration_239）。**text 不是數字** —— 提需求時講的是'
  '「兩箱」「一組」「5 支」，逼成數字只會得到一個假的 1。'
  '★ 因此加不起來，這是刻意的:要算錢的是請款單那邊。'
  '★★ 前端必填（lib/demand.ts 的 missingLabels）；'
  '239 之前的舊資料多半是 null，那些不補 —— 數量只有當初提的人知道。';

comment on column public.purchase_demand_items.spec is
  '產品規格（migration_239 起前端必填）。原本叫「規格說明／大概數量」，'
  '數量已經拆到 qty —— 這一欄現在只放規格。'
  '★ 舊資料裡可能同時混著規格與數量，**不拆**:機器拆不準，'
  '而拆錯的比混在一起更難發現。';

comment on column public.purchase_demand_items.buy_link is
  '採購地點或連結（畫面上叫「備註」，2026-09-10）。'
  '★★ 可能是網址、也可能只是店名（線上就有一筆是「酷彭」）——'
  '顯示端要先問 isUrl() 才決定畫不畫成連結，'
  '不然會做出一個點下去沒反應的假連結。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('239_demand_qty');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 這一段在 commit 之後。**看不到它 = 上面爆了、整支回滾**，
--   不是「跑成功但沒輸出」。2026-09-10 這件事被誤讀了兩次。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① qty 型別',
         coalesce((select data_type from information_schema.columns
                    where table_schema='public' and table_name='purchase_demand_items'
                      and column_name='qty'), '（沒有這一欄）'),
         case when (select data_type from information_schema.columns
                     where table_schema='public' and table_name='purchase_demand_items'
                       and column_name='qty') = 'text'
              then '✅' else '❌ 不是 text，前端塞不進「兩箱」' end

  union all
  select 2, '② default 清掉了沒',
         coalesce((select column_default from information_schema.columns
                    where table_schema='public' and table_name='purchase_demand_items'
                      and column_name='qty'), '（沒有，正常）'),
         case when (select column_default from information_schema.columns
                     where table_schema='public' and table_name='purchase_demand_items'
                       and column_name='qty') is null
              then '✅' else '⚠ 還有 default' end

  union all
  -- ★ 這一條就是第二版爆掉的那個東西。轉完之後應該一條都不剩
  select 3, '③ 還有幾條 check 提到 qty',
         coalesce((select string_agg(conname || '：' || pg_get_constraintdef(oid), '；')
                     from pg_constraint
                    where conrelid = 'public.purchase_demand_items'::regclass
                      and contype  = 'c'
                      and pg_get_constraintdef(oid) ~ '\mqty\M'), '（0 條）'),
         case when not exists (select 1 from pg_constraint
                                where conrelid = 'public.purchase_demand_items'::regclass
                                  and contype  = 'c'
                                  and pg_get_constraintdef(oid) ~ '\mqty\M')
              then '✅' else '❌ 還有數字約束掛在文字欄上' end

  union all
  select 4, '④ 舊值轉過來的筆數',
         (select count(*)::text from public.purchase_demand_items where qty is not null),
         /*
          * ★★★ 這一條**不判對錯**。239 之前前端寫不進數量，
          *   所以 0 完全正常 —— 寫成 ❌ 只會嚇到跑的人。
          */
         'ℹ 舊資料本來就沒有，0 是正常的'

  union all
  select 5, '⑤ 母體（需求項目總數）',
         (select count(*)::text from public.purchase_demand_items),
         case when (select count(*) from public.purchase_demand_items) = 0
              then '⚠ 母體是 0 —— 上面那幾條不算數' else '✅' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '239_demand_qty'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '239_demand_qty')
              then '✅' else '❌ 沒寫進去 —— 整支又回滾了' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
