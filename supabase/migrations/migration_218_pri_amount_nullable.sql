/*
 * migration_218 —— 請款項目的金額可以留空
 * ============================================================
 * 2026-09-05 使用者：「會計可以在採購單上也能按 進請款單嗎？
 *                      但還不知道金額怎麼辦？」
 *
 * 從採購需求帶進請款單時，**金額還不知道** —— 要先詢價。
 * 請款單本來就支援這件事（`purchases/page.tsx:910` 的註解）：
 *
 *     「草稿可以先不填金額（送單當下未必問得到銀行實收多少），送審就要填。」
 *
 * 但 `purchase_request_items.amount` 是 `not null default 0`，
 * 所以帶進去的項目只能是 **0 元**。
 *
 * ============================================================
 * 【★★★ 為什麼 0 不能拿來當「還沒填」】
 *
 * 0 在請款單上是一個**合法的值** —— 贈品、換貨、對方吸收。
 * 而畫面上「0」跟「還沒填」長得一模一樣。
 *
 * 拿 0 當「待填」的話：
 *   · 送審時擋不住（它是一個數字，看起來就是填好的）
 *   · 主管、總經理各按一次核可，**兩個人都不會發現**
 *   · 付款出去少一筆錢，而那筆需求還在等
 *
 * 少掉的那一截沒有任何地方會叫。
 *
 * ★ 這跟 `properties.clean_price` 那條「沒設 ≠ 免費」是同一條規則
 *   （CLAUDE.md：「沒去看欄位定義就決定空值長什麼樣」）。
 *
 * ============================================================
 * 【★★ 這一支不動任何一列既有資料】
 *
 * 只拿掉 `not null`。既有的 0 **維持 0** ——
 * 那些是人真的填過的，不能因為改了欄位定義就變成「待填」。
 *
 * 代價要知道：舊資料裡「本來想填卻填成 0」的那幾筆分不出來了。
 * 那是既成事實，不是這一支造成的 —— 從今天起才分得開。
 *
 * ★ `default 0` 也拿掉。留著的話 insert 沒帶金額會又變成 0，
 *   等於這一支白做（而症狀跟改之前一模一樣）。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
 */

begin;

alter table public.purchase_request_items
  alter column amount drop not null;

-- ★ default 也要拿掉 —— 留著的話 insert 沒帶 amount 會填成 0，
--   而 0 正是這一支要跟「待填」分開的東西
alter table public.purchase_request_items
  alter column amount drop default;

comment on column public.purchase_request_items.amount is
  '請款金額。★★★ null = **還沒填**（多半是從採購需求帶進來、還在詢價）；'
  '0 = 真的是 0 元（贈品、換貨、對方吸收）。兩者在畫面上要分得開 —— '
  '拿 0 當「待填」的話送審擋不住，而核可的人不會發現（migration_218）。'
  '★ 送審時逐項擋 null，草稿不擋。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('218_pri_amount_nullable');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① amount 現在可不可以是 null',
         coalesce((select case when is_nullable = 'YES' then '可以（YES）' else '還是 NOT NULL' end
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'purchase_request_items'
                      and column_name = 'amount'), '（找不到這一欄）'),
         case when (select is_nullable from information_schema.columns
                     where table_schema = 'public' and table_name = 'purchase_request_items'
                       and column_name = 'amount') = 'YES'
              then '✅' else '❌ 沒改成功，下面不用看' end

  union all
  -- ★★ default 沒拿掉的話這一支等於白做:insert 沒帶金額還是會變成 0
  select 2, '★★ ② default 拿掉了沒',
         coalesce((select column_default from information_schema.columns
                    where table_schema = 'public' and table_name = 'purchase_request_items'
                      and column_name = 'amount'), '（沒有 default）'),
         case when (select column_default from information_schema.columns
                     where table_schema = 'public' and table_name = 'purchase_request_items'
                       and column_name = 'amount') is null
              then '✅ 沒有 default'
              else '❌ 還有 default —— 沒帶金額的 insert 會變成 0，跟改之前一樣' end

  union all
  /*
   * ★★★ 母體要判定。這一支不動資料，所以「有幾筆是 0」改前改後應該一樣 ——
   *   而 0 筆的話代表這張表是空的，上面兩列驗的只是欄位定義，
   *   沒有任何一筆資料證明過它（CLAUDE.md:自檢的母體是空的 → 每一條都回綠）。
   */
  select 3, '★★★ ③ 現有的請款項目',
         (select count(*)::text || ' 筆，其中金額 0 的 '
                 || count(*) filter (where amount = 0)::text || ' 筆，null 的 '
                 || count(*) filter (where amount is null)::text || ' 筆'
            from public.purchase_request_items),
         case when (select count(*) from public.purchase_request_items) = 0
              then '⚠ 這張表是空的 —— 上面兩列只驗到欄位定義，沒有資料證明過'
              when (select count(*) filter (where amount is null)
                      from public.purchase_request_items) > 0
              then '⚠ 已經有 null —— 這一支跑過了？先確認那幾筆是誰建的'
              else '✅ 既有資料一列都沒動，0 還是 0' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '218_pri_amount_nullable'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '218_pri_amount_nullable')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
