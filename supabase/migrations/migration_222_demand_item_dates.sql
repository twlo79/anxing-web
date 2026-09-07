/*
 * migration_222 —— 採購需求項目加「採購平台」「採購日」「預計到貨」
 * ============================================================
 * 2026-09-07 使用者：「已採購 加上日期」「預計到貨 填日期」
 *                    「多一個採購平台 蝦皮 酷澎 淘寶 好事多」
 *
 * ★ 平台那一欄是後來追加的，一起併進這一支 ——
 *   `add column if not exists`，跑過了再跑一次也不會出事。
 *
 * ============================================================
 * 【這兩個日期在回答不同的問題】
 *
 *   `purchased_on`  **東西什麼時候買的**  —— 給對帳用
 *   `eta`           **什麼時候會到**      —— 給等貨的人用
 *
 * 提需求的房務阿姨真正想知道的是 `eta`:「我的除霉劑什麼時候到」。
 * 而會計要的是 `purchased_on`:那筆錢算在哪個月。
 *
 * ★ 兩個都**可以留空**。買了但不知道哪天到、或到貨了才補登，
 *   都是正常的。必填的話人會亂填一個日期，而亂填的日期
 *   比空著更糟 —— 空的看得出來沒填，填錯的看起來像真的。
 *
 * ============================================================
 * 【★★ 為什麼不從請款單推 `purchased_on`】
 *
 * 走請款流程的話，`purchase_requests.purchased_on` 已經有出款日了。
 * 但那是**錢出去的日子**，不是東西買的日子 ——
 * 而零用金直接買的那條路根本沒有請款單。
 *
 * 兩條路要有同一個欄位可以填，所以放在項目上。
 *
 * ★ 走請款流程時前端會拿請款單的出款日當預設值帶進來，
 *   但那是**預設不是連動** —— 人改得動它。
 *
 * ============================================================
 * 【★ 不加 check 說「已採購才能填日期」】
 *
 * 直覺是加 `status = 'done' or purchased_on is null`。不加，理由:
 *   · `eta` 在「已詢價」時就該填得了（廠商講了幾天到）
 *   · 補登的順序是人的自由:先填日期再改狀態也應該可以
 *   · 擋下來的訊息是一句 SQL 例外，填表的人看不懂
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

alter table public.purchase_demand_items
  add column if not exists purchased_on date;

alter table public.purchase_demand_items
  add column if not exists eta date;

/*
 * ★★★ 平台存 `text`，**刻意不加 check**。
 *
 *   直覺是 `check (platform in ('蝦皮','酷澎','淘寶','好事多'))`。不加，理由:
 *   多一個平台（全聯、家樂福、廠商官網）就要多一支 migration，
 *   而那是一件**這個月會發生**的事 —— 加約束等於把「以後在哪買」
 *   這個決定綁在資料庫上。
 *
 *   清單放在前端 `lib/purchase-demand.ts` 的 `PURCHASE_PLATFORMS`，
 *   加一個就是改那一行。
 *
 * ★ 代價要知道:沒有約束就擋不住錯字，「蝦皮」跟「蝦皮購物」
 *   會變成兩個平台而報表分不開。緩衝是畫面上只給下拉、不給自由打字。
 */
alter table public.purchase_demand_items
  add column if not exists platform text;

comment on column public.purchase_demand_items.purchased_on is
  '東西是哪一天買的（migration_222）。null = 還沒填。'
  '★ 跟 purchase_requests.purchased_on 不同 —— 那個是**錢出去的日子**，'
  '而且零用金直接買的那條路沒有請款單。兩條路共用這一欄。';

comment on column public.purchase_demand_items.platform is
  '在哪買的（migration_222）：蝦皮／酷澎／淘寶／好事多⋯。null = 還沒填。'
  '★★★ 刻意**沒有 check** —— 多一個平台就要多一支 migration 太重，'
  '而那是這個月就會發生的事。清單在前端 lib/purchase-demand.ts 的 '
  'PURCHASE_PLATFORMS，加一個就是改那一行。'
  '★ 代價:擋不住錯字，「蝦皮」跟「蝦皮購物」會變成兩個平台。'
  '緩衝是畫面只給下拉、不給自由打字。';

comment on column public.purchase_demand_items.eta is
  '預計到貨日（migration_222）。null = 不知道或還沒問。'
  '★ 提需求的人真正想知道的就是這一格 ——「我的除霉劑什麼時候到」。'
  '★★ 刻意不擋「還沒採購就填 eta」:已詢價時廠商就會講幾天到。';

/*
 * ★ `trg_pdi_lock` 只擋 item_name / qty / estate_id / spec 四欄
 *   （2026-09-05 查證過），所以這兩個新欄位**改得動** ——
 *   已經轉成請款單之後還是可以補日期。那正是要的行為。
 */

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('222_demand_item_dates');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 三個欄位在不在',
         coalesce((select string_agg(column_name || ' ' || data_type
                    || case when is_nullable = 'YES' then '（可為 null）' else '（NOT NULL ❌）' end,
                    '、' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'purchase_demand_items'
                      and column_name in ('purchased_on', 'eta', 'platform')), '（都不存在）'),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'purchase_demand_items'
                       and column_name in ('purchased_on', 'eta', 'platform')
                       and is_nullable = 'YES') = 3
              then '✅ 三個都在，而且都可以留空'
              else '❌ 少了，或被設成 NOT NULL' end

  union all
  -- ★ 不該有 check 擋「還沒採購就填日期」—— 已詢價時就該填得了 eta
  select 2, '★ ② 有沒有多餘的 check 擋住這兩欄',
         coalesce((select string_agg(pg_get_constraintdef(co.oid), ' ｜ ')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'purchase_demand_items'
                      and co.contype::text = 'c'
                      and (pg_get_constraintdef(co.oid) ilike '%purchased_on%'
                        or pg_get_constraintdef(co.oid) ilike '%eta%'
                        or pg_get_constraintdef(co.oid) ilike '%platform%')),
                  '（沒有 —— 這樣才對）'),
         '★ platform 也不該有 check —— 多一個平台不該要一支 migration'

  union all
  /*
   * ★★★ 母體要判定。這一支只建欄位，所以現在一定是 0 筆有值 ——
   *   不是 0 就代表這支跑過了，而中間可能有人填過東西。
   */
  select 3, '★★★ ③ 目前有幾筆填了日期',
         (select count(*)::text || ' 個項目，其中填了採購日的 '
                 || count(*) filter (where purchased_on is not null)::text || ' 筆、'
                 || '填了預計到貨的 ' || count(*) filter (where eta is not null)::text || ' 筆、'
                 || '填了平台的 ' || count(*) filter (where platform is not null)::text || ' 筆'
            from public.purchase_demand_items),
         case when (select count(*) from public.purchase_demand_items) = 0
              then '⚠ 一個項目都沒有 —— 上面只驗到欄位定義'
              when (select count(*) filter (where purchased_on is not null
                                          or eta is not null or platform is not null)
                      from public.purchase_demand_items) = 0
              then '✅ 0 筆 —— 這一支只建欄位，本來就不該有'
              else '⚠ 已經有人填了 —— 這支跑過了？先確認那幾筆是誰填的' end

  union all
  -- ★ trg_pdi_lock 不能因為這一支而擋到新欄位
  select 4, '★ ④ trg_pdi_lock 擋哪幾欄',
         coalesce((select case when pg_get_functiondef(p.oid) ilike '%purchased_on%'
                            or pg_get_functiondef(p.oid) ilike '%eta%'
                            or pg_get_functiondef(p.oid) ilike '%platform%'
                          then '⚠ 定義裡提到新欄位' else 'item_name / qty / estate_id / spec（沒提到新欄位）' end
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text = 'trg_pdi_lock'), '（找不到那支觸發器）'),
         '✅ 沒提到就對了 —— 已轉請款單的項目還是要補得了日期'

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '222_demand_item_dates'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '222_demand_item_dates')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
