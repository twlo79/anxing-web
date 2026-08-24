-- migration_161：認列只跑安幸（修正 migration_160 沒做到的那一條）
--
-- ============================================================
-- 【160 為什麼沒做到】
--
-- 那支用 `proname ~ 'recogn'` 去找認列觸發器，
-- 而函式真正的名字是 **`trg_orders_recog`** —— 少一個 n，一支都沒中。
--
-- 好消息是它因此**什麼都沒改**，`orders_recognize` 完好無缺。
--
--
-- ============================================================
-- 【而且 160 那段本來就是錯的】
--
-- 原始定義是:
--
--     CREATE TRIGGER orders_recognize
--       AFTER INSERT OR DELETE OR UPDATE ON public.orders
--       FOR EACH ROW EXECUTE FUNCTION trg_orders_recog();
--
-- 160 寫的是 `after insert or update` —— **把 DELETE 弄丟了**。
-- 症狀會是:刪掉一張訂單，它的認列紀錄留在 revenue_recognitions 裡，
-- 而營收表繼續算那筆錢。**不會報錯，只有月營收莫名其妙變高。**
--
-- 更根本的問題:DELETE 時 `new` 是 null，
-- 所以 `when (new.book = 'anxing')` 這種寫法**根本不能用在含 DELETE 的觸發器上**。
--
--
-- ============================================================
-- 【正確做法：拆成兩支】
--
--   orders_recognize      INSERT / UPDATE   when (new.book = 'anxing')   ← 只有安幸產生認列
--   orders_recognize_del  DELETE            無條件                        ← 清理一律要跑
--
-- ★ 刪除那支**不加條件**是刻意的:
--   清理是冪等的（`delete ... where order_id = old.id`），
--   非安幸的訂單本來就沒有認列紀錄，跑一次刪掉 0 列，沒有代價。
--   而加了條件的話，萬一有一筆歷史資料的 book 值怪掉，
--   它的認列紀錄就再也清不掉了 —— 為了省一次 no-op 而留一個死角，不划算。
--
-- ★ 函式本體一個字都不動。`trg_orders_recog()` 是這系統最複雜的一支
--   （長租、短租、折讓、移房各有算法），重抄等於把每種算法都重賭一次。
-- ============================================================


do $$
declare v_fn text;
begin
  -- 從既有的觸發器把函式名字撈出來，不寫死 ——
  -- baseline 已經被證實過期好幾次，寫死的話可能指到一支不存在的函式
  select p.proname into v_fn
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc  p on p.oid = t.tgfoid
   where c.relname = 'orders' and t.tgname = 'orders_recognize'
     and not t.tgisinternal;

  if v_fn is null then
    raise exception '找不到 orders_recognize 這支觸發器 —— 名字可能改過，請貼 orders 上的觸發器清單給我';
  end if;

  raise notice '認列函式: %', v_fn;

  execute 'drop trigger if exists orders_recognize on public.orders';
  execute 'drop trigger if exists orders_recognize_del on public.orders';

  -- ① 產生認列：只有安幸
  execute format(
    'create trigger orders_recognize after insert or update on public.orders '
    'for each row when (new.book = ''anxing'') execute function public.%I()', v_fn);

  -- ② 清理：無條件（見檔頭說明）
  execute format(
    'create trigger orders_recognize_del after delete on public.orders '
    'for each row execute function public.%I()', v_fn);
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('161_recog_skip_other_books');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 產生認列的觸發器限定安幸' as "檢查項目",
         case when exists (
           select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where c.relname = 'orders' and t.tgname = 'orders_recognize'
              and pg_get_triggerdef(t.oid) like '%book%anxing%')
         then '✅' else '❌ 條件沒加上' end as "結果",
         '愛皮洪鯊的訂單不會被拆成月認列' as "說明"

  union all
  /*
   * ★★ 這一項是 160 差點釀成的錯。
   *   DELETE 那支不見的話，刪掉訂單後認列紀錄會留著，
   *   而營收表繼續算那筆錢 —— 不報錯，只有月營收莫名變高。
   */
  select 2, '★★ 刪除時的清理還在',
         case when exists (
           select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where c.relname = 'orders' and t.tgname = 'orders_recognize_del'
              and pg_get_triggerdef(t.oid) ilike '%delete%')
         then '✅' else '❌ DELETE 的清理不見了 —— 刪訂單後營收會虛高' end,
         '刪訂單時要把它的認列紀錄一起清掉'

  union all
  select 3, '★ 兩支都指到同一個函式',
         (select count(distinct p.proname)::text from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_proc  p on p.oid = t.tgfoid
           where c.relname = 'orders'
             and t.tgname in ('orders_recognize', 'orders_recognize_del')) || ' 個函式',
         '應該是 1 —— 函式本體完全沒動'

  union all
  /*
   * ★★ 既有的認列筆數不能變。
   *   這支只換觸發器條件，沒有重算 —— 數字變了就表示動到不該動的東西。
   *   ⚠ 跑之前先記下這個數字。
   */
  select 4, '★★ 認列總筆數', count(*)::text || ' 列',
         '★ 跟跑之前對照，必須一模一樣'
    from public.revenue_recognitions

  union all
  select 5, '認列表裡的非安幸資料', count(*)::text || ' 列',
         case when count(*) = 0 then '✅ 乾淨' else '❌ 有漏網的' end
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
   where o.book <> 'anxing'

) v order by ord;
