-- migration_165：修掉 164 的部分索引（ON CONFLICT 對不到）
--
-- ============================================================
-- 【症狀】（2026-08-22）
--
--     存不進去：there is no unique or exclusion constraint
--               matching the ON CONFLICT specification
--
-- 收款填了手續費之後按「確認收款」就出這句話。
--
--
-- ============================================================
-- 【原因 —— 這是今天第二次犯同一個錯】
--
-- migration_164 建的是**部分索引**:
--
--     create unique index expenses_fee_payment_uidx
--       on expenses (fee_payment_id) where fee_payment_id is not null;
--                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
--
-- 而 `sync_op_fee_expense()` 裡寫的是:
--
--     on conflict (fee_payment_id) do update ...
--
-- **`ON CONFLICT (欄位)` 推不出部分索引。** 要用部分索引的話，
-- 那個 ON CONFLICT 必須帶一模一樣的 WHERE 條件才對得上。
--
-- 這正是 migration_150 / 151 / 152 那一整串的成因
-- （「主管按確認付款日沒反應」查了一整天）。
-- 151 當初的結論就是**改成完整唯一索引**:
--
--     create unique index expenses_fee_request_uidx
--       on expenses (fee_request_id);        ← 沒有 WHERE
--
-- 我在 164 沒照那個結論做。
--
--
-- ============================================================
-- 【為什麼完整唯一索引不會有問題】
--
-- 直覺會擔心「那 4000 多筆 fee_payment_id 是 null 的列會撞在一起」。
-- 不會 —— **Postgres 的唯一索引允許多個 NULL**
-- （NULL 之間不算相等）。所以完整索引的效果跟部分索引一樣，
-- 只是多幾筆索引項，而且 ON CONFLICT 對得到。
--
-- 唯一的代價是索引稍微大一點。跟「功能整個壞掉」比，不用考慮。
-- ============================================================

drop index if exists public.expenses_fee_payment_uidx;

create unique index if not exists expenses_fee_payment_uidx
  on public.expenses (fee_payment_id);

comment on index public.expenses_fee_payment_uidx is
  '一筆收款最多一筆手續費支出。**不能加 WHERE** —— '
  'ON CONFLICT (fee_payment_id) 推不出部分索引（migration_165，'
  '跟 151 同一個結論）。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('165_fix_fee_payment_index');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 先做一次**真的 upsert**。
 *
 * 只有 select 的驗證抓不到這個錯 —— 索引存在、名字對、
 * 一切看起來都好，而 ON CONFLICT 就是對不到它。
 * （CLAUDE.md:「驗證段要有真的寫入，不能只有 select」。）
 *
 * 寫完故意 raise 讓整段回滾，所以不會留下測試資料。
 */
do $$
declare v_op uuid; v_code text;
begin
  select id into v_op from public.order_payments limit 1;
  select code into v_code from public.account_codes
   where book = 'anxing' and (code = 'postage' or name like '%郵電%') limit 1;

  if v_op is null or v_code is null then
    raise notice '★ 跳過 upsert 測試（沒有收款或找不到郵電費科目）';
    return;
  end if;

  -- 跑兩次。第二次會走 on conflict —— 那正是原本失敗的地方
  for i in 1..2 loop
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, payment_method, fee_payment_id, book
    ) values (
      current_date, '__索引測試__', 1, 1, 'TWD', 1,
      v_code, 'office', 'transfer', v_op, 'anxing'
    )
    on conflict (fee_payment_id) do update set amount = excluded.amount;
  end loop;

  raise notice '★★ upsert 兩次都成功 —— ON CONFLICT 對得到索引了';
  -- 故意失敗讓整個 do 區塊回滾，不留測試資料
  raise exception using errcode = 'restrict_violation', message = '__rollback__';
exception
  when restrict_violation then
    if sqlerrm = '__rollback__' then
      raise notice '★ 測試資料已回滾';
    else
      raise;
    end if;
end $$;

select "檢查項目", "結果", "說明" from (

  /*
   * ★★ 這一項是重點:索引**不能有 WHERE**。
   *   有的話 ON CONFLICT 就對不到，而症狀是使用者按不下去。
   */
  select 1 as ord, '★★ 完整唯一索引（沒有 WHERE）' as "檢查項目",
         case when exists (
           select 1 from pg_indexes
            where schemaname = 'public'
              and indexname = 'expenses_fee_payment_uidx'
              and indexdef not ilike '%where%')
         then '✅' else '❌ 還是部分索引，ON CONFLICT 對不到' end as "結果",
         (select indexdef from pg_indexes
           where schemaname = 'public' and indexname = 'expenses_fee_payment_uidx') as "說明"

  union all
  /*
   * ★ 跟 151 建的那顆對照 —— 兩顆的形狀應該一樣。
   *   不一樣的話表示我又寫了一個特例。
   */
  select 2, '★ 跟 fee_request 那顆一致',
         case when (select count(*) from pg_indexes
                     where schemaname = 'public'
                       and indexname in ('expenses_fee_payment_uidx', 'expenses_fee_request_uidx')
                       and indexdef not ilike '%where%') = 2
              then '✅ 2 / 2' else '❌ 兩顆形狀不同' end,
         '請款單與收款的手續費用同一套做法'

  union all
  select 4, '既有的手續費支出', count(*)::text || ' 筆',
         '這支只換索引，一筆資料都沒動'
    from public.expenses where fee_payment_id is not null

) v order by ord;
