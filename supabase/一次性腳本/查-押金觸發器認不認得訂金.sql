/*
 * 查-押金觸發器認不認得訂金.sql　2026-09-15（第二版）
 * 把訂金掛到訂單上之前，先確認兩件事會不會把它洗掉
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把出來的表整個貼回來。
 *          ★ 這支一個字都不會改。只有 select。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 第一版為什麼跑不起來 —— 記下來，別再犯】
 *
 * 第一版的說明文字裡貼了兩行帶分號的 SQL 當例子。
 * Supabase 的 SQL Editor 是**先照分號切語句、再管註解**的，
 * 所以那兩行被當成真的要執行 —— 錯誤訊息是
 * 「missing FROM-clause entry for table new」。
 *
 * 那兩行剛好是 delete 與 update，而 new 在那個情境不存在，
 * 所以整句失敗、什麼都沒動。**下次沒這麼好運。**
 *
 * ★ 規則：註解裡不要出現分號。要舉例就用文字描述，不要貼可執行的句子。
 * ══════════════════════════════════════════════════════════
 *
 * 【為什麼要先查這個】
 *
 * trg_sync_order_deposits 在訂單新增或修改（押金金額、外幣押金、
 * 物業、房源、房客姓名任一欄）時會跑。我手上這份 schema 基線裡，
 * 它的收尾會把「幣別不在這張單押金清單裡」的 deposits 列
 * 標成 orphaned，而那個判斷**完全沒有提到 kind**。
 *
 * ★★★ 照那份定義，訂金一旦掛到訂單上，
 *   只要有人改那張單的房客姓名，那筆訂金就會被標成孤兒 ——
 *   而且不會報錯。畫面上只是那筆錢突然變孤兒，
 *   沒有人說得出是哪個動作造成的。
 *
 * ★★ 第二層：dep_order_cur_idx 是 unique(order_id, currency)，也沒有 kind。
 *   真是這樣的話，一張訂單不可能同時有台幣押金與台幣訂金 ——
 *   而使用者要的正是「押金另外填、訂金再轉押金」。
 *
 * 【但基線可能是舊的】
 * kind 是 migration_174 才加的，而 19B3 碩美那張契約上押金與訂金
 * 兩筆都在（9/15 查過）。索引真的沒有 kind 的話那兩筆存不進去，
 * 所以八成後來改過，只是基線沒跟上。
 *
 * ★ 所以不用猜的，直接讀資料庫現在的定義。
 * ══════════════════════════════════════════════════════════
 */

select v.ord, v."檢查", v."現在的定義" from (

  select 1 as ord, '① ' || i.indexname as "檢查", i.indexdef as "現在的定義"
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'deposits'
     and i.indexname in ('dep_order_cur_idx', 'dep_contract_cur_idx')

  union all
  select 2, '② sync_order_deposits 有沒有分 kind',
         case when p.prosrc ~ 'kind' then '有提到 kind（後來改過，好消息）'
              else '★★★ 完全沒提到 kind —— 訂金會被它標成孤兒' end
    from pg_proc p where p.oid = 'public.sync_order_deposits()'::regprocedure

  union all
  select 3, '③ sync_contract_deposits 有沒有分 kind',
         case when p.prosrc ~ 'kind' then '有提到 kind'
              else '★★★ 完全沒提到 kind' end
    from pg_proc p where p.oid = 'public.sync_contract_deposits()'::regprocedure

  union all
  /*
   * ④⑤ 最硬的證據：現有資料裡有沒有「同一張單／同一份契約，
   *   同幣別但不只一列」。有的話就證明索引一定已經含 kind ——
   *   資料不會陪我一起讀錯定義。
   */
  select 4, '④ 現有資料:同契約同幣別、不只一列',
         coalesce((select count(*)::text || ' 組'
                     from (select contract_id, currency from public.deposits
                            where contract_id is not null
                            group by contract_id, currency having count(*) > 1) x), '0 組')

  union all
  select 5, '⑤ 現有資料:同訂單同幣別、不只一列',
         coalesce((select count(*)::text || ' 組'
                     from (select order_id, currency from public.deposits
                            where order_id is not null
                            group by order_id, currency having count(*) > 1) x), '0 組')

  union all
  select 6, '⑥ 已經掛在訂單上的訂金有幾筆',
         (select count(*)::text || ' 筆' from public.deposits
           where order_id is not null and kind = 'earnest')

  union all
  select 7, '⑦ orders 現在有哪幾個押金相關欄位',
         coalesce((select string_agg(column_name, '、' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'orders'
                      and column_name in ('deposit', 'fx_deposit', 'pet_deposit',
                                          'earnest', 'fx_earnest')), '（一個都沒有？）')

) as v(ord, "檢查", "現在的定義")
order by v.ord, v."檢查";
