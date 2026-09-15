/*
 * 查-誰靠訂單的起訖日活著.sql　2026-09-15
 * 把 orders.checkin / checkout 改成可空之前，先列出所有靠它活著的東西
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，出來的表整個貼回來。
 *          ★ 只有 select，一個字都不會改。
 *          ★ 欄位標題是「類別／名稱／內容」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要先查】
 *
 * 使用者 2026-09-15：「勾了訂金的可以先不填起訖。」
 *
 * 前端有 373 處碰 checkin / checkout，資料庫這邊我只看得到舊基線
 * （27 處提到 checkin，而基線已經舊到連索引名字都對不上了）。
 *
 * ★★★ 「改成可空」真正的風險不是報錯，是**算錯而不報錯**:
 *   關帳月份算不出來 → 那筆單永遠鎖不住
 *   營收認列拿 null 去算 → 認列筆數少一筆，報表只是變小
 *   晚數變 null → 平均房價的分母錯
 *   日曆少畫一段 → 有人照著它排房
 *
 * 【要做的設計（先講，這支只是驗證它安不安全）】
 *
 *   ① orders 加 earnest_only boolean（跟 contracts 同名同義）
 *   ② checkin / checkout 放寬成可空
 *   ③ 加一條 CHECK:earnest_only 為真，或者兩個日期都有
 *
 * ★★ ③ 是整個設計的重點。有了它，**只有訂金階段的單可能沒有日期** ——
 *   其餘每一張單的日期照樣保證存在。
 *   於是要審的問題從「373 處都可能吃到 null」
 *   縮成「哪幾處要把訂金階段的單排除掉」。
 *
 * ★ 這支要回答的就是後面那個問題:資料庫這邊有哪幾處。
 * ══════════════════════════════════════════════════════════
 */

select v.ord, v."類別", v."名稱", v."內容" from (

  /* ① 函式：誰讀 orders 的日期 */
  select 1 as ord, '① 函式提到 checkin／checkout' as "類別",
         p.proname as "名稱",
         (case when p.prosrc ~ 'checkin' then 'checkin ' else '' end)
         || (case when p.prosrc ~ 'checkout' then 'checkout ' else '' end)
         || (case when p.prosrc ~ 'nights' then 'nights ' else '' end)
         || '｜'
         || (case when p.prosrc ~ 'earnest' then '　已經知道有訂金這回事' else '' end)
           as "內容"
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.prosrc ~ 'checkin' or p.prosrc ~ 'checkout')

  union all
  /* ② orders 身上所有的 CHECK ——  ③ 那條新的不能跟既有的打架 */
  select 2, '② orders 的 CHECK 約束', con.conname,
         pg_get_constraintdef(con.oid)
    from pg_constraint con
   where con.conrelid = 'public.orders'::regclass and con.contype = 'c'

  union all
  /* ③ 索引：日期欄上的索引，改成可空之後行為要確認 */
  select 3, '③ orders 上跟日期有關的索引', i.indexname, i.indexdef
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'orders'
     and (i.indexdef ~ 'checkin' or i.indexdef ~ 'checkout')

  union all
  /* ④ 觸發器：哪幾支會在日期變動時跑 */
  select 4, '④ orders 上的觸發器', t.tgname, pg_get_triggerdef(t.oid)
    from pg_trigger t
   where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal

  union all
  /* ⑤ 檢視表 */
  select 5, '⑤ 提到 orders 日期的檢視表', c.relname,
         left(pg_get_viewdef(c.oid, true), 400)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
     and (pg_get_viewdef(c.oid, true) ~ 'checkin'
       or pg_get_viewdef(c.oid, true) ~ 'checkout')

  union all
  /* ⑥ 欄位現況：nights 有沒有預設值、日期是不是真的 NOT NULL */
  select 6, '⑥ orders 欄位現況', c.column_name,
         c.data_type || '　' || (case when c.is_nullable = 'NO' then 'NOT NULL' else '可空' end)
           || '　預設 ' || coalesce(c.column_default, '（無）')
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'orders'
     and c.column_name in ('checkin', 'checkout', 'nights', 'earnest_only', 'earnest_amount')

  union all
  /* ⑦ 有沒有現成的「訂金階段」單可以參考 —— 契約那邊怎麼標的 */
  select 7, '⑦ contracts 的 earnest_only', c.column_name,
         c.data_type || '　預設 ' || coalesce(c.column_default, '（無）')
           || '　目前 '
           || (select count(*)::text from public.contracts where earnest_only) || ' 張是訂金階段'
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'contracts'
     and c.column_name = 'earnest_only'

) as v(ord, "類別", "名稱", "內容")
order by v.ord, v."名稱";
