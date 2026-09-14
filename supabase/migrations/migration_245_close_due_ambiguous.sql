begin;

/*
 * migration_245  close_due_periods() 的 `ym` 有歧義 —— 它從來沒跑成功過
 * ------------------------------------------------------------
 * 2026-09-11 實際呼叫端點，回：
 *   HTTP 500 {"error":"column reference \"ym\" is ambiguous"}
 *
 * ★★★ 為什麼
 *
 *     returns table (ym text, action text)   ← `ym` 同時是**輸出參數名**
 *     ...
 *     on conflict (ym) do update             ← 這裡的 `ym` 是欄位還是變數？
 *
 * PL/pgSQL 會把函式的參數名當成變數，而 `on conflict (...)` 裡的
 * 識別字兩邊都說得通 —— Postgres 不猜，直接報錯。
 *
 * ★★ 這一行**每次**呼叫都會爆。也就是說這支函式
 *   **從 2026-09-07 寫好到現在，一次都沒有成功執行過**。
 *
 * ============================================================
 * 【★★★ 為什麼拖了四天才發現 —— 自檢問錯了問題】
 *
 * migration_223 的自檢有一條就是在講這支函式，而它寫著：
 *
 *     -- ★★ 今天跑 close_due_periods() 會怎樣（唯讀試算,這裡不真的呼叫）
 *
 * 它做了兩件事:①確認函式**存在** ②**自己重算一次日期邏輯**來預測結果。
 * 然後很有信心地印出「ℹ 今天呼叫 close_due_periods() 會把上個月關起來」。
 *
 * ★★★ **那句話是假的，而且它自己不可能知道** —— 因為它從頭到尾
 *   沒有問過本人。一個把答案自己算出來、而不去執行的檢查，
 *   證明的只有「我會算日期」。
 *
 * ★ 規矩:**自檢要呼叫它在檢查的那個東西。** 函式是冪等的就直接叫，
 *   有副作用而不能叫的，就老實寫「這一條沒有驗到執行」，
 *   不要印一句聽起來很確定的預測。
 *
 * ============================================================
 * 【修法：`#variable_conflict use_column`】
 *
 * 一行指示，告訴 PL/pgSQL「識別字兩邊都說得通的時候，選欄位」。
 *
 * ★ 為什麼不改輸出參數的名字:`returns table (ym text, ...)` 決定了
 *   回傳的**欄位名**，而端點是用 `r.ym` 組摘要的（route.ts）。
 *   改名字會讓那邊安靜地變成 undefined —— 修一個 bug 生一個新的。
 *
 * ★★ 這支函式裡其他的 `ym` 全部都有 `p.` 前綴，所以 `use_column`
 *   只會影響 `on conflict (ym)` 那一處。查過每一行才這樣改。
 * ------------------------------------------------------------
 */

create or replace function public.close_due_periods()
returns table (ym text, action text)
language plpgsql
security definer
set search_path to 'public'
as $fn$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_prev  text := to_char(date_trunc('month', v_today) - interval '1 day', 'YYYYMM');
begin
  if extract(day from v_today) < 5 then
    return query select v_prev, '還沒到 5 號，不關'::text; return;
  end if;

  if exists (select 1 from public.period_lock p where p.ym = v_prev and p.locked) then
    return query select v_prev, '已經關過了'::text; return;
  end if;

  /*
   * ★★★ 被人手動打開過的**不自動關回去**。
   *   不然會計打開七月正在改，隔天清晨又被鎖起來 ——
   *   而他不會知道是排程做的，只會覺得系統壞了。
   *   他改完自己關（那時 auto = false）。
   */
  if exists (select 1 from public.period_lock p
              where p.ym = v_prev and not p.locked and p.reopened_at is not null) then
    return query select v_prev, '被手動打開過，不自動關回去'::text; return;
  end if;

  insert into public.period_lock (ym, locked, auto, locked_at)
  values (v_prev, true, true, now())
  on conflict (ym) do update
    set locked = true, auto = true, locked_at = now();

  return query select v_prev, '已關帳'::text;
end $fn$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('245_close_due_ambiguous');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 這一次**真的呼叫它**。
--
--   223 的自檢是「唯讀試算」—— 自己重算日期來預測，從沒執行過，
--   於是一個每次都會丟例外的函式，在自檢上看起來一切正常四天。
--
-- ★★ 呼叫是安全的:這支函式冪等 —— 關過了回「已經關過了」，
--   沒到 5 號回「還沒到 5 號」。跑十次跟跑一次一樣。
--
-- ★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 真的呼叫一次，它說什麼',
         coalesce((select string_agg(c.ym || '：' || c.action, '、')
                     from public.close_due_periods() c), '（沒有回傳任何一列）'),
         /*
          * ★★★ 這一條就是 223 少做的那件事。
          *   跑得動、而且講得出它做了什麼 —— 才叫驗過。
          */
         case when exists (select 1 from public.close_due_periods()) 
              then '✅ 跑得動了' else '❌ 沒有回傳' end

  union all
  select 2, '②★★★ period_lock 現在有什麼',
         coalesce((select string_agg(p.ym || '（' || case when p.locked then '已關' else '開著' end
                                     || case when p.auto then '·自動' else '·手動' end || '）',
                                     '、' order by p.ym desc)
                     from public.period_lock p), '（一列都沒有）'),
         /*
          * ★★ 今天是 11 號（> 5），所以上個月**應該已經關了**。
          *   還是空的話表示函式雖然不報錯了，但沒有寫進去 ——
          *   那多半是 RLS（這支是 SECURITY DEFINER，理論上不會）。
          */
         case when exists (
                select 1 from public.period_lock p
                 where p.ym = to_char(date_trunc('month',
                         (now() at time zone 'Asia/Taipei')::date) - interval '1 day', 'YYYYMM')
                   and p.locked)
              then '✅ 上個月已關'
              when extract(day from (now() at time zone 'Asia/Taipei')::date) < 5
              then 'ℹ 今天還沒到 5 號，沒關是對的'
              else '❌ 過了 5 號卻沒關 —— 停下來查' end

  union all
  select 3, '③ 今天幾號、上個月是哪個月',
         to_char((now() at time zone 'Asia/Taipei')::date, 'YYYY-MM-DD')
           || '（' || extract(day from (now() at time zone 'Asia/Taipei')::date)::int::text || ' 號）'
           || '，上個月 = '
           || to_char(date_trunc('month', (now() at time zone 'Asia/Taipei')::date)
                      - interval '1 day', 'YYYYMM'),
         'ℹ 給第 ② 條當對照'

  union all
  select 4, '④ 函式裡有沒有那一行指示',
         case when (select prosrc from pg_proc where proname = 'close_due_periods')
                   like '%variable_conflict%' then '有' else '沒有' end,
         case when (select prosrc from pg_proc where proname = 'close_due_periods')
                   like '%variable_conflict%' then '✅' else '❌' end

  union all
  select 5, '⑤ 被鎖住的月份有幾筆訂單',
         coalesce((select count(*)::text from public.orders o
                    join public.period_lock p
                      on p.ym = to_char(coalesce(o.checkin, o.checkout), 'YYYYMM')
                   where p.locked), '0') || ' 筆',
         /*
          * ★ 不判對錯。關帳的意義是那幾筆從此改不動也刪不掉 ——
          *   跑之前先知道影響多少筆，比事後才發現好。
          */
         'ℹ 這些訂單從現在起改不動、刪不掉（要改請先到權限管理打開那個月）'

) v(ord, "檢查", "結果", "判定") order by v.ord;
