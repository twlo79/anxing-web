/*
 * 查-deposits索引與訂單同步函式.sql　2026-09-15（第二版）
 * 寫 migration_256 之前差的最後兩塊
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，出來的表整個貼回來。
 *          ★ 只有 select，一個字都不會改。
 *          ★ 欄位標題是「類別／名稱／內容」—— 跟前兩支不一樣，
 *            貼回來之前看一眼標題就知道有沒有跑錯支。
 *
 * ══════════════════════════════════════════════════════════
 * 【第一版為什麼要重寫】
 *
 * 第一版寫成兩段 select。Supabase 的 SQL Editor 一次跑多句時
 * **只顯示最後一句的結果** —— 所以第一張表（索引）根本看不到。
 * 這一版合併成一張。
 *
 * ★ 跟上一支那個「註解裡不要放分號」是同一類的教訓:
 *   腳本要配合工具的行為，而不是假設工具會照我想的方式跑。
 *
 * ══════════════════════════════════════════════════════════
 * 【要看什麼】
 *
 * ① deposits 上所有索引。重點是**訂單那個唯一索引含不含 kind**。
 *   上一支用名字找 dep_order_cur_idx 一列都沒有，表示名字已經換過。
 *   不含 kind 的話，一張訂單放不下「台幣押金」＋「台幣訂金」兩列，
 *   而那正是要做的（押金另外填、訂金再轉押金）。
 *
 * ② sync_order_deposits 現在真正在跑的原始碼。
 *   我手上那份 schema 基線是舊的（它連索引名字都對不上了），
 *   照舊的改等於把別人後來修好的東西蓋回去。
 * ══════════════════════════════════════════════════════════
 */

select v.ord, v."類別", v."名稱", v."內容" from (

  select 1 as ord, '① 索引' as "類別", i.indexname as "名稱", i.indexdef as "內容"
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename = 'deposits'

  union all
  select 2, '② 函式', 'sync_order_deposits',
         pg_get_functiondef('public.sync_order_deposits()'::regprocedure)

) as v(ord, "類別", "名稱", "內容")
order by v.ord, v."名稱";
