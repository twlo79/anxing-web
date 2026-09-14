begin;

/*
 * migration_246  訂單記下「移房過程」
 * ------------------------------------------------------------
 * 2026-09-14 使用者：
 *   「有移過房的，在房源後面多一個標籤『移房』，
 *     下面可以顯示房源移房過程 B01>B03 這樣」
 *
 * ★★★ 為什麼要一個欄位，不用現成的推
 *
 * 兩段以上的移房本來就靠 `move_group` 串在一起，理論上把同一組的
 * `property_raw` 照 checkin 排序就是那條鏈。但列表頁**一次載幾百筆**，
 * 為了畫一個標籤去 join 同一張表、再依組聚合，成本與複雜度都不划算。
 *
 * ★★ 更重要的是**只改房號、不拆段**的那種移房 —— 那種連 `move_group`
 *   都沒有（`doMove()` 寫 `move_group: isMulti ? grp : null`）。
 *   2026-09-14 Jasmine 那筆 B01 → B03 就是這樣:
 *   異動紀錄看得到，但訂單上完全沒有痕跡。
 *
 * ★ 所以存一條**完整的鏈**在每一列上:`B01>B03`。
 *   畫面直接讀，不用 join，兩種移房都蓋得到。
 *
 * ============================================================
 * 【★★ 為什麼不從備註去解析】
 *
 * `doMove()` 會在備註寫「移房 B01>B03」，看起來可以直接解析。
 * **不要** —— 備註是使用者手打的地方（Jasmine 那筆就寫著
 * 「舊舊B1，移到B5」）。拿一個人會自由編輯的欄位當結構化資料，
 * 哪天有人改了一個字，畫面就安靜地不對了。
 *
 * ============================================================
 * 【舊資料不補】
 *
 * 已經移過房的那些單，鏈只存在於異動紀錄裡 —— 而那裡的格式是
 * 「欄位舊值→新值」，一次移房可能有好幾列。機器拼得出來，但拼錯的
 * 比沒有更糟（`CLAUDE.md`:對不上的不猜）。
 *
 * ★ 兩段以上的舊資料**看得出來**（有 `move_group`），底下的自檢會
 *   把它們列出來，要補的話人工填比較準。
 * ------------------------------------------------------------
 */

alter table public.orders
  add column if not exists move_chain text;

comment on column public.orders.move_chain is
  '移房過程（migration_246）。例:「B01>B03」。null = 沒有移過房。'
  '★ 由 doMove() 寫入，兩種移房都寫:只改房號的、以及拆成多段的。'
  '★★ **不要從備註解析這條鏈** —— 備註是使用者自由編輯的欄位，'
  '拿它當結構化資料，哪天有人改一個字畫面就安靜地不對了。'
  '★ 畫面直接讀這一欄，不用 join move_group —— 列表一次幾百筆。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('246_orders_move_chain');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 欄位建好了',
         coalesce((select data_type from information_schema.columns
                    where table_schema='public' and table_name='orders'
                      and column_name='move_chain'), '（沒有這一欄）'),
         case when (select data_type from information_schema.columns
                     where table_schema='public' and table_name='orders'
                       and column_name='move_chain') = 'text'
              then '✅' else '❌' end

  union all
  select 2, '② 現在有幾筆有鏈',
         (select count(*)::text from public.orders where move_chain is not null) || ' 筆',
         /*
          * ★ 不判對錯。這一支只加欄位，不回頭補舊資料 ——
          *   所以現在一定是 0。之後有人移房才會長出來。
          */
         'ℹ 這支不補舊資料，0 是正常的'

  union all
  select 3, '③★★ 兩段以上的舊移房（有 move_group 的）',
         coalesce((select string_agg(x.s, '　' order by x.s) from (
                     select o.move_group::text || '：'
                            || string_agg(coalesce(o.property_raw,'?'), '>' order by o.checkin) as s
                       from public.orders o
                      where o.move_group is not null
                      group by o.move_group) x), '（沒有）'),
         /*
          * ★★ 這些是**推得出來**的鏈 —— 要補的話照這個填進 move_chain。
          *   我不自動補:同一組裡如果有人事後改過房號，推出來的鏈
          *   會是「現在的樣子」而不是「當初移的過程」。
          */
         'ℹ 要補的話照這個填，人工比較準'

  union all
  select 4, '④ 只改房號的舊移房',
         '查不到',
         /*
          * ★★★ 誠實寫「查不到」，不要印一個 0。
          *   那種移房沒有 move_group、也沒有在訂單上留任何痕跡 ——
          *   只有異動紀錄裡有（欄位 property_raw 的舊值→新值）。
          *   印 0 會讓人以為「沒有這種資料」，而事實是「這裡看不到」。
          */
         'ℹ 這種只有異動紀錄查得到，這一支救不回來'

  union all
  select 5, '⑤ 母體（訂單總數）',
         (select count(*)::text from public.orders),
         case when (select count(*) from public.orders) = 0
              then '⚠ 母體是 0 —— 上面不算數' else '✅' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
