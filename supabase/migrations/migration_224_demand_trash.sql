-- migration_224：採購需求單可以刪（進回收桶）
--
-- ============================================================
-- 【為什麼現在刪不掉】（2026-09-07 使用者:「可以刪 採購單」）
--
-- 採購需求單從頭到尾**沒有刪除功能** —— 送錯、重複、測試留下來的單子
-- 只能一直掛在清單上。而且 `purchase_demands` / `purchase_demand_items`
-- 兩張表**都不在 `trash_deletable_tables()` 裡**，
-- 所以就算前端加一顆按鈕，`soft_delete` 也會直接拒絕
-- （回收桶是預設拒絕:沒列在白名單的表一律不能刪）。
--
-- 這一支只做一件事:把那兩張表加進白名單。
--
--
-- ============================================================
-- 【★★★ 為什麼是回收桶不是硬刪】（2026-09-07 使用者選「可復原」）
--
-- 採購需求單是**別人送來的東西** —— 房務填的、寫了要買什麼、寄到哪。
-- 硬刪之後那些字沒有任何地方找得回來，只能請他重填一次,
-- 而他多半已經忘記當初寫了什麼。
--
-- 回收桶連 payload 整列存著,`trash` 也記了 `deleted_by` ——
-- 而這件事特別重要,因為 `purchase_demands` **沒有掛稽核觸發器**
-- （`data_audit` 只蓋七張表）。回收桶是這張表唯一留得下
-- 「誰刪的、刪掉的原本是什麼」的地方。
--
--
-- ============================================================
-- 【子列不用另外註冊】
--
-- `trash_collect_children()` 是**照外鍵自己走的**（migration_107）——
-- 刪一張 `purchase_demands`，它會自己找到指著它的
-- `purchase_demand_items` 一起收進回收桶，復原時一起回來。
--
-- ★ 所以這裡兩張表都要列:整張單走第一條，
--   單獨刪掉某一個項目（例如拆錯了多出來的那一列）走第二條。
--
--
-- ============================================================
-- 【為什麼是 accountant 不是 housekeeper】
--
-- 需求單一旦被請款單領走就牽涉到錢（`request_item_id`）。
-- 訂單當初降到 housekeeper 是因為管家每天在處理短租訂單,
-- 而需求單刪掉會影響會計看得到什麼、要不要建請款單 —— 那是會計的事。
--
-- ★ 前端另外擋一層:**已經被請款單領走的項目不給刪**,
--   刪了的話那張請款單指著的東西不見了,而不會有任何地方叫。
--   資料庫這裡擋不住那個（它只看表跟角色），所以前端一定要擋。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。

begin;

-- ══════════════════════════════════════════════════════════
-- 白名單:加兩張表
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 這支函式是**整份重寫**的（不能只 append）。
 *   所以底下這份清單必須跟 migration_167 那一份一字不差,
 *   只多兩行 —— 少抄一行就等於把那張表的刪除權限**默默拿掉**,
 *   而症狀是「某一頁的刪除鍵按了說沒有權限」，沒有人會聯想到這一支。
 */
create or replace function public.trash_deletable_tables()
returns table (tbl text, min_role text) language sql immutable as $fn$
  select * from (values
    -- 訂單降到管家（migration_167）
    ('orders', 'housekeeper'),
    ('contracts', 'accountant'), ('expenses', 'accountant'),
    ('purchase_requests', 'accountant'), ('purchase_request_items', 'accountant'),
    ('deposits', 'accountant'), ('invoices', 'accountant'),
    ('order_payments', 'accountant'), ('contract_payments', 'accountant'),
    ('deposit_payments', 'accountant'),
    ('contract_recurring_charges', 'accountant'), ('recurring_charges', 'accountant'),
    ('estates', 'accountant'), ('properties', 'accountant'),
    ('payment_accounts', 'accountant'), ('payee_presets', 'accountant'),
    ('hk_work_item', 'manager'), ('hk_event', 'manager'), ('cleaning_records', 'manager'),
    ('reviews', 'manager'), ('customers', 'manager'), ('announcements', 'manager'),
    -- ★ 採購需求（migration_224）。整張單與單一項目都要能刪
    ('purchase_demands', 'accountant'), ('purchase_demand_items', 'accountant'),
    ('attachments', 'any')
  ) v(tbl, min_role);
$fn$;

comment on function public.trash_deletable_tables() is
  '哪些表可以走 soft_delete，以及最低角色。沒列在這裡的表一律不能刪（預設拒絕）。'
  'orders 於 migration_167 降到 housekeeper。'
  'purchase_demands / purchase_demand_items 於 migration_224 加入 —— '
  '這兩張表沒有稽核觸發器，回收桶是唯一留得下「誰刪的、原本是什麼」的地方。';

-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('224_demand_trash');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★ 只看「有沒有列進去」不夠 —— migration_167 的那幾張如果被我抄漏了,
--   這裡要當場叫出來。所以第 ② 條數的是**總數**。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩張表進白名單了',
         coalesce((select string_agg(tbl || '(' || min_role || ')', '、' order by tbl)
                     from public.trash_deletable_tables()
                    where tbl in ('purchase_demands', 'purchase_demand_items')), '（都沒有）'),
         case when (select count(*) from public.trash_deletable_tables()
                     where tbl in ('purchase_demands', 'purchase_demand_items')) = 2
              then '✅ 過' else '❌ 沒進去' end

  union all
  -- ★★ 抄漏 migration_167 那一份的話,這裡會少
  select 2, '②★★ 白名單總數（167 的 23 張 ＋ 這次 2 張 = 25）',
         (select count(*)::text from public.trash_deletable_tables()),
         case when (select count(*) from public.trash_deletable_tables()) = 25
              then '✅ 過' else '⚠ 數量不對 —— 對一下有沒有抄漏' end

  union all
  -- ★ orders 一定要還在 housekeeper。掉回 accountant 的話管家從此刪不了訂單
  select 3, '③ orders 仍然是 housekeeper（不可以被這支改掉）',
         coalesce((select min_role from public.trash_deletable_tables() where tbl = 'orders'), '（不見了）'),
         case when (select min_role from public.trash_deletable_tables() where tbl = 'orders') = 'housekeeper'
              then '✅ 過' else '❌ 被改掉了' end

  union all
  select 4, '④ trash_can_delete 對兩張新表回 true（用現在登入的角色判定）',
         coalesce(public.trash_can_delete('purchase_demands')::text, 'null')
           || ' / ' || coalesce(public.trash_can_delete('purchase_demand_items')::text, 'null'),
         case when public.trash_can_delete('purchase_demands')
               and public.trash_can_delete('purchase_demand_items')
              then '✅ 過'
              else 'ℹ 你現在這個角色刪不了（在 SQL Editor 裡 current_role_of() 可能是 null）' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
