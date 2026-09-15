/*
 * 查-契約訂金的做法.sql　2026-09-15
 * 契約那邊的訂金是怎麼做的 —— 訂單照抄，不要自己發明
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，出來的表整個貼回來。
 *          ★ 只有 select，一個字都不會改。
 *          ★ 這是 migration_256 之前的**最後一支**。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼還要問】
 *
 * 上一支查出來 sync_contract_earnest **已經存在**，而且有分 kind。
 * 也就是「訂金自己一列、跟押金並存」這件事，契約那邊早就做完了。
 *
 * ★★★ 訂單這邊照抄就好。自己重寫一份的結果是兩邊慢慢不一樣 ——
 *   而不一樣的地方會是「契約的訂金這樣算、訂單的訂金那樣算」，
 *   那種差異沒有人會發現，直到某天兩張報表對不起來。
 *
 * 【三件要看的】
 *
 * ① sync_contract_earnest 的完整原始碼 —— 訂單版的範本。
 *
 * ② order_fee_deposit_guard 與 order_locked_reason。
 *   這兩支上一支沒撈到，因為它們的原始碼裡沒有出現 order_id
 *   （八成是吃 deposit 的 id）。那樣的話多一列訂金不會影響它們 ——
 *   但那是我的推測，而這兩支一個管「加費從押金扣」、
 *   一個管「押金退了鎖單」，都是錢的路徑。**推測不夠。**
 *
 * ③ contracts 上訂金相關的欄位叫什麼 —— 訂單要取一樣的名字。
 *   兩邊叫不同名字的話，以後每次寫查詢都要先想「這張表是哪個」。
 * ══════════════════════════════════════════════════════════
 */

select v.ord, v."類別", v."名稱", v."內容" from (

  select 1 as ord, '① 範本' as "類別", p.proname as "名稱",
         pg_get_functiondef(p.oid) as "內容"
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sync_contract_earnest'

  union all
  select 2, '② 要確認不受影響的', p.proname, pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('order_fee_deposit_guard', 'order_locked_reason')

  union all
  select 3, '③ contracts 的訂金欄位', c.column_name,
         c.data_type || '　預設 ' || coalesce(c.column_default, '（無）')
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'contracts'
     and (c.column_name ~ 'earnest' or c.column_name ~ 'deposit')

  union all
  select 4, '④ 觸發器:contracts 上跟訂金有關的', t.tgname,
         pg_get_triggerdef(t.oid)
    from pg_trigger t
   where t.tgrelid = 'public.contracts'::regclass and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ~ 'earnest'

  union all
  select 5, '⑤ 觸發器:orders 上跟押金有關的', t.tgname,
         pg_get_triggerdef(t.oid)
    from pg_trigger t
   where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ~ 'deposit'

) as v(ord, "類別", "名稱", "內容")
order by v.ord, v."名稱";
