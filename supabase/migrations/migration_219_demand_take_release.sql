/*
 * migration_219 —— 送審翻「已採購」＋ 補上刪除請款單的洞
 * ============================================================
 * 2026-09-05 使用者選了：「已採購」＝**請款單送出審核**那一刻。
 *
 * 這一支裝兩支觸發器，都是唯一寫入者，前端不碰這兩個狀態轉換。
 *
 * ============================================================
 * 【① trg_pr_take_demands —— 送審就算已採購】
 *
 *   draft → pending   接到的需求項目 requested → done（已採購）
 *   pending → draft   退回去，done → requested
 *
 * 被駁回不用管 —— 既有的 `trg_pr_reject_demands` 會把它們退回
 * `pending` 並清掉 `request_item_id`。兩支的觸發條件互斥
 * （一支認 'pending'/'draft'，一支認 'rejected'）。
 *
 * ★ 為什麼要處理「退回草稿」：不處理的話，會計把送出的單抽回來改，
 *   需求單那邊還顯示「已採購」—— 而那張單根本還沒送審。
 *   一個假的已採購比沒有狀態更糟，因為它讓人以為事情辦完了。
 *
 * ★ 代價講清楚：送審之後、核可付款之前，需求單顯示「已採購」
 *   而錢還沒出去。使用者接受 —— 他要的是「會計處理完了」。
 *   要改成「填出款日才算」的話，把 ① 的條件換成
 *   `new.purchased_on is not null and old.purchased_on is null`
 *   （跟 `gen_expenses_from_pr` 同一刻），其餘不用動。
 *
 * ============================================================
 * 【★★★ ② trg_pri_release_demands —— 刪掉請款單時退回】
 *
 * 外鍵是 `on delete set null`，所以刪掉請款項目時
 * `request_item_id` 會被清成 null，**可是 `status` 沒有人改**。
 *
 * 那一項會卡在「已進請款」而接不到任何請款單：
 *   · 畫面顯示「已進請款」卻點不到單號
 *   · `isTakeable('requested')` 是 false → **再也不能被帶進請款單**
 *   · 沒有任何一個按鈕救得回來
 *
 * 既有的退回觸發器只認 `status = 'rejected'`，**不認 delete**。
 *
 * ★★ 必須是 BEFORE DELETE。
 *   AFTER 的話外鍵的 set null 可能已經先跑掉 ——
 *   那時 `request_item_id` 已經是 null，這支 update 會找不到任何一列，
 *   而它**回成功、影響 0 列、沒有錯誤**。
 *   （內部 RI 觸發器與使用者 AFTER 觸發器的先後靠名字排，不能賭。）
 *
 * ============================================================
 * 【★ 兩支都要 SECURITY DEFINER】
 *
 * 觸發器裡的 UPDATE 一樣吃 RLS。`purchase_demand_items` 的
 * `pdi_write` 只放行 accountant / manager / super_admin，
 * 而刪自己那張請款單的可能是管家 —— 那時 update 會**回成功且 0 列**
 * （CLAUDE.md：RLS 擋下的 UPDATE 回成功且影響 0 列）。
 *
 * `gen_expenses_from_pr` 本來就是這樣寫的，照抄。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- ① 送審 → 已採購；退回草稿 → 已進請款
-- ══════════════════════════════════════════════════════════
create or replace function public.trg_pr_take_demands()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.status = 'pending' and coalesce(old.status, '') <> 'pending' then
    -- ★ 只翻 requested 的。已經被會計手動改成別的狀態就不要覆蓋他
    update public.purchase_demand_items i
       set status = 'done'
      from public.purchase_request_items ri
     where ri.request_id = new.id
       and i.request_item_id = ri.id
       and i.status = 'requested';

  elsif new.status = 'draft' and coalesce(old.status, '') = 'pending' then
    update public.purchase_demand_items i
       set status = 'requested'
      from public.purchase_request_items ri
     where ri.request_id = new.id
       and i.request_item_id = ri.id
       and i.status = 'done';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_pr_take_demands on public.purchase_requests;
create trigger trg_pr_take_demands
  after update on public.purchase_requests
  for each row execute function public.trg_pr_take_demands();

-- ══════════════════════════════════════════════════════════
-- ★★★ ② 刪掉請款項目 → 需求項目退回未採購
-- ══════════════════════════════════════════════════════════
create or replace function public.trg_pri_release_demands()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  /*
   * ★ 退回 `pending` 而不是 `quoted` —— 詢價的結果跟著那張被刪掉的
   *   請款單一起沒了，說它「已詢價」是假的。
   * ★ `request_item_id` 一起清掉：留著會指向一列馬上就不存在的資料。
   */
  update public.purchase_demand_items
     set status = 'pending', request_item_id = null
   where request_item_id = old.id;
  return old;
end $fn$;

drop trigger if exists trg_pri_release_demands on public.purchase_request_items;
create trigger trg_pri_release_demands
  before delete on public.purchase_request_items
  for each row execute function public.trg_pri_release_demands();

-- ══════════════════════════════════════════════════════════
-- ★ 修既有的孤兒（狀態說已進請款，卻接不到任何請款項目）
-- ══════════════════════════════════════════════════════════
/*
 * 這次跑的時候應該是 0 筆（這條路還沒被走過）。
 * 寫在這裡是因為以後補跑時它會是對的 ——
 * 而 0 筆的話這一行什麼都不會做。
 */
update public.purchase_demand_items
   set status = 'pending'
 where status in ('requested', 'done')
   and request_item_id is null;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('219_demand_take_release');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 送審觸發器裝上了沒',
         coalesce((select t.tgname::text || '（' ||
                     case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end || ' UPDATE）'
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'purchase_requests'
                      and t.tgname::text = 'trg_pr_take_demands'), '（沒裝上）'),
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'purchase_requests'
                             and t.tgname::text = 'trg_pr_take_demands')
              then '✅' else '❌ 沒裝上，下面不用看' end

  union all
  -- ★★ AFTER 的話外鍵的 set null 可能先跑，這支就會回成功且 0 列
  select 2, '★★ ② 刪除觸發器是不是 BEFORE',
         coalesce((select case when (t.tgtype & 2) <> 0 then 'BEFORE DELETE' else 'AFTER DELETE' end
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'purchase_request_items'
                      and t.tgname::text = 'trg_pri_release_demands'), '（沒裝上）'),
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'purchase_request_items'
                             and t.tgname::text = 'trg_pri_release_demands'
                             and (t.tgtype & 2) <> 0)
              then '✅ 是 BEFORE'
              else '❌ 不是 BEFORE DELETE —— 會靜默失效' end

  union all
  -- ★ 兩支都要 SECURITY DEFINER，不然管家刪自己的單時 RLS 會擋掉且不叫
  select 3, '★ ③ 兩支函式都是 SECURITY DEFINER 嗎',
         coalesce((select string_agg(p.proname::text || '：' ||
                     case when p.prosecdef then 'definer' else 'invoker ❌' end, '、' order by p.proname)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f', 'p')
                      and p.proname::text in ('trg_pr_take_demands', 'trg_pri_release_demands')),
                  '（找不到函式）'),
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f', 'p')
                      and p.proname::text in ('trg_pr_take_demands', 'trg_pri_release_demands')
                      and p.prosecdef) = 2
              then '✅ 兩支都是'
              else '❌ 有 invoker —— RLS 會靜默擋掉' end

  union all
  -- ★ 既有的退回觸發器不能被弄壞:它負責「駁回」那條路
  select 4, '★ ④ 既有的駁回退回還在嗎',
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'purchase_requests'
                             and t.tgname::text = 'trg_pr_reject_demands')
              then '在' else '不見了' end,
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'purchase_requests'
                             and t.tgname::text = 'trg_pr_reject_demands')
              then '✅ 駁回那條路沒被動到'
              else '❌ 被弄不見了 —— 駁回不會退回需求單' end

  union all
  -- ★★★ 母體要判定。0 的話上面四條只驗到形狀，沒有資料證明過
  select 5, '★★★ ⑤ 這條路走過幾次',
         (select count(*)::text from public.purchase_demand_items) || ' 個需求項目，其中接到請款項目的 '
           || (select count(*) filter (where request_item_id is not null)::text
                 from public.purchase_demand_items) || ' 筆',
         case when (select count(*) from public.purchase_demand_items) = 0
              then '⚠ 一個項目都沒有 —— 上面驗的只是形狀'
              when (select count(*) filter (where request_item_id is not null)
                      from public.purchase_demand_items) = 0
              then '⚠ 還沒有任何一筆走過這條路 —— 觸發器裝好了但沒跑過。'
                   || '第一次用完要回頭確認狀態有變'
              else '✅ 有實績' end

  union all
  select 6, '⑥ 修掉幾個孤兒',
         (select count(*)::text from public.purchase_demand_items
           where status in ('requested', 'done') and request_item_id is null) || ' 筆還是孤兒',
         case when (select count(*) from public.purchase_demand_items
                     where status in ('requested', 'done') and request_item_id is null) = 0
              then '✅ 沒有卡住的' else '❌ 還有孤兒 —— 上面那段 update 沒生效' end

  union all
  select 7, '⑦ 項目的狀態分佈',
         coalesce((select string_agg(status::text || '：' || n::text, '、' order by status)
                     from (select status, count(*) as n
                             from public.purchase_demand_items group by status) s), '（空的）'),
         'ℹ 參考'

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '219_demand_take_release'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '219_demand_take_release')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
