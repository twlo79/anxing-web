/*
 * migration_191 —— 訂單與契約的房號改用 ERP 名稱
 * ============================================================
 * 2026-09-01 使用者：「還是有 B4 啊 不是改 B04」「所有紀錄都統一」
 *                     「b. 連 property_raw 一起改」「比對靠訂單 code」
 *
 * 房號不一致總共有四個地方，前兩個已經處理過:
 *
 *     properties.name        ERP 主檔    B04   ← 基準
 *     hk_property.code       房務        B04   ✅ migration_189
 *     orders.property_raw    訂單        B4    ← 這一支
 *     contracts.room         契約        B4    ← 這一支（必須一起）
 *
 * ============================================================
 * 【★★★ 契約非改不可，不是「順便」】
 *
 * 契約靠**房號字串**去找它的訂單（`contracts/page.tsx`）:
 *
 *     if (!o.property_raw || o.property_raw !== c.room) continue;
 *
 * 只改訂單不改契約的話，`B04 !== B4` —— 那張契約從此對不到任何訂單:
 *   · 列表的「收租」欄變成「—」
 *   · 該開的發票不會被提出來
 *
 * ★★ 而且**不會有任何錯誤訊息** —— 只是那幾張契約看起來「這個月沒收到租金」。
 *   這比不改更糟，所以兩張表必須在同一個交易裡改完。
 *
 * ============================================================
 * 【為什麼改 property_raw 是安全的】
 *
 * 一開始擔心的是「Airbnb 重新匯入時會對不到，變成重複訂單」。查過之後不成立:
 *
 *   ① 匯入的比對鍵是 `order_key`（Airbnb 的訂單代碼），不是房號
 *      —— 使用者也確認了:「比對靠訂單 code」
 *
 *   ② `airbnb-sync.ts` 第 784 行寫的本來就是 `property_raw: prop.name`
 *      —— **同步早就把 ERP 名稱當成正確值**，
 *      而它第 886 行還會把 `exist.property_raw` 與 `prop.name` 的差異
 *      列成待確認的異動。也就是說:那些 `B4` 是**改名之前留下的舊資料**，
 *      系統本來就在等人把它們對齊。
 *
 * ★ 所以這一支做的不是「改變規則」，是**把舊資料補到現行規則上**。
 *
 * ============================================================
 * 【對照表是算出來的】
 *
 * 凡是「訂單有連到 ERP 房源，但 property_raw 跟房源名稱不一樣」的，
 * 就是一組 `舊 → 新`。跟 migration_189 同一個思路 ——
 * 規則是「一律用 ERP 名稱」，不是「這幾個」。
 */

create temp table _chk191 (ord int, item text, result text, note text) on commit drop;

-- ══════════════════════════════════════════════════════════
-- 對照表：舊房號 → ERP 名稱
-- ══════════════════════════════════════════════════════════
create temp table _room191 (old_raw text primary key, new_name text not null) on commit drop;

insert into _room191 (old_raw, new_name)
select o.property_raw, p.name
  from public.orders o
  join public.properties p on p.id = o.property_id
 where o.property_raw is not null
   and o.property_raw <> p.name
 group by o.property_raw, p.name;

-- 跑之前的樣子
insert into _chk191
select 0, '跑之前',
       (select count(*) from public.orders o join _room191 r on r.old_raw = o.property_raw)::text
         || ' 筆訂單 ／ '
         || (select count(*) from public.contracts c join _room191 r on r.old_raw = c.room)::text
         || ' 張契約',
       '這些數字改完之後要一模一樣地出現在新房號底下';

-- ══════════════════════════════════════════════════════════
-- ★★★ 前提：同一個舊房號不可以指到兩個不同的 ERP 名稱
--
--   `B4` 在時兆是 B04、在正隆是別間房的話，
--   一律改成其中一個會**把另一棟的訂單改到錯的房間**。
--   那種錯不會報，只會讓某一棟的營收憑空多一截、另一棟少一截。
-- ══════════════════════════════════════════════════════════
do $$
declare amb text;
begin
  select string_agg(old_raw || ' → ' || names, '；') into amb
    from (
      select old_raw, string_agg(new_name, '、' order by new_name) as names
        from _room191 group by old_raw having count(*) > 1
    ) x;
  if amb is not null then
    raise exception
      '這些舊房號同時對到兩個以上的 ERP 房源:% —— '
      '一律改的話會把訂單改到錯的房間，請人工判斷。', amb;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ★★ 前提：改完之後不可以撞到「本來就叫這個名字」的別間房
--
--   舊房號 `B04` 如果已經是別的房源的名稱，那 `B4 → B04` 之後
--   兩群訂單會混在一起。這裡先看有沒有這種情況。
-- ══════════════════════════════════════════════════════════
do $$
declare clash text;
begin
  select string_agg(r.old_raw || ' → ' || r.new_name, '、') into clash
    from _room191 r
   where exists (
     select 1 from public.orders o2
      join public.properties p2 on p2.id = o2.property_id
     where o2.property_raw = r.new_name and p2.name <> r.new_name);
  if clash is not null then
    raise exception '改完會跟既有的房號混在一起:% —— 請人工判斷。', clash;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ① 訂單
-- ══════════════════════════════════════════════════════════
/*
 * ★ 只改**有連到 ERP 房源**的那些。
 *   `property_id` 是 null 的訂單（公司登記、辦公室租金）沒有基準可對，
 *   它們的 property_raw 是人手打的自由文字 —— 動了就是猜。
 */
update public.orders o
   set property_raw = p.name
  from public.properties p
 where p.id = o.property_id
   and o.property_raw is not null
   and o.property_raw <> p.name;

-- ══════════════════════════════════════════════════════════
-- ② 契約（★ 必須跟訂單同一個交易）
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 契約沒有 property_id 可以對，只能靠剛才那張對照表。
 *   所以順序是:先從訂單推導出 `舊 → 新`，再拿它去改契約。
 *   反過來（先改訂單再推導）的話對照表會是空的。
 *
 * ★ 對照表在最上面就建好了，這裡用的是**改之前**的值 —— 正確。
 */
update public.contracts c
   set room = r.new_name
  from _room191 r
 where c.room = r.old_raw;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('191_order_room_erp');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 這次改了哪些房號',
         coalesce((select string_agg(old_raw || ' → ' || new_name, '、' order by old_raw)
                     from _room191), '（沒有要改的，可能是已經跑過了）'),
         (select '共 ' || count(*) || ' 種房號' from _room191)

  union all
  select 2, '★★ 資料量對照',
         (select count(*) from public.orders o join _room191 r on r.new_name = o.property_raw)::text
           || ' 筆訂單 ／ '
           || (select count(*) from public.contracts c join _room191 r on r.new_name = c.room)::text
           || ' 張契約',
         (select '跑之前是：' || result from _chk191 where ord = 0)

  union all
  /*
   * ★★★ 這一項是最終答案:訂單的房號跟 ERP 還有幾筆不一樣。
   *   應該是 0（沒連到房源的除外）。
   */
  select 3, '★★★ 訂單還有幾筆跟 ERP 不一樣',
         (select case when count(*) = 0 then '✅ 0 筆'
                      else '⚠ 還有 ' || count(*) || ' 筆：'
                           || string_agg(distinct o.property_raw || ' ↔ ' || p.name, '、') end
            from public.orders o
            join public.properties p on p.id = o.property_id
           where o.property_raw is not null and o.property_raw <> p.name),
         '有連到 ERP 房源的訂單，房號要跟房源名稱一致'

  union all
  /*
   * ★★★ 契約還對不對得到訂單 —— 這是「一起改」有沒有做到的證據。
   *   有房號的契約，應該都能在訂單裡找到同名的。
   */
  select 4, '★★★ 契約還對得到訂單嗎',
         (select case when count(*) = 0 then '✅ 每一張有房號的契約都找得到同名的訂單'
                      else '⚠ 有 ' || count(*) || ' 張契約的房號在訂單裡找不到：'
                           || string_agg(distinct c.room, '、') end
            from public.contracts c
           where coalesce(c.room, '') <> ''
             and not exists (select 1 from public.orders o where o.property_raw = c.room)),
         '★ 契約靠房號字串找訂單。對不到的話「收租」欄會變成「—」，而且不會報錯'

  union all
  select 5, '沒有連到 ERP 房源的訂單（沒動）',
         (select count(*)::text || ' 筆'
            from public.orders o
           where o.property_id is null and coalesce(o.property_raw, '') <> ''),
         '★ 公司登記、辦公室租金那些。沒有基準可對，動了就是猜，所以留著'

  union all
  select 6, '★ 四個地方現在一致了嗎',
         (select case when
                   (select count(*) from public.hk_property h join public.properties p on p.id = h.property_id where h.code <> p.name) = 0
                   and
                   (select count(*) from public.orders o join public.properties p on p.id = o.property_id where o.property_raw is not null and o.property_raw <> p.name) = 0
                 then '✅ ERP ／ 房務 ／ 訂單 三邊一致'
                 else '⚠ 還有地方不一致，見上面幾列' end),
         '契約沒有 property_id，只能靠第 4 列間接驗證'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
