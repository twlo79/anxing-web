-- migration_111：把三張信用卡的代號改成末四碼
--
--   中信      → 2915
--   匯豐      → 4175
--   匯豐9650  → 9650
--
-- ============================================================
-- 【為什麼不能只改 payment_accounts.code】
--
-- code 是**自然鍵**：訂單、支出、請款單、押金、收款紀錄存的都是這串文字本身，
-- 而其中只有 order_payments.account 掛了外鍵，其餘五個欄位是純文字。
--
-- 只改主檔的話，舊資料會指向一個不存在的代號 —— 而且**不會報錯**，
-- 只是那些筆在畫面上變成「沒有帳號」，報表按帳號分組時憑空多一個空白組。
--
-- 所以這支把六個地方一起改，包在同一個交易裡：要嘛全部改好，要嘛全部不動。
--
--
-- ============================================================
-- 【順手把外鍵改成 ON UPDATE CASCADE】
--
-- order_payments.account 的外鍵原本是預設的 NO ACTION —— 改主檔會直接被擋。
-- 改成 CASCADE 之後，這次與之後的每一次改代號，那張表都會自己跟上。
--
-- 剩下五個欄位沒有外鍵可掛（它們是歷史資料，掛外鍵會讓已停用的帳號刪不掉），
-- 所以仍然要手動更新 —— 這也是為什麼「代號可以直接編輯」是危險的：
-- 使用者按下去只會改到主檔那一個地方。
--
--
-- ============================================================
-- 【為什麼用 = 而不是 like】
--
-- 「匯豐」是「匯豐9650」的前綴。用 like '匯豐%' 的話會把 匯豐9650 一起改掉，
-- 而它自己還有另一個目標值 —— 兩條規則會打架，結果取決於執行順序。
-- 全部用完全相等比對。
-- ============================================================

do $$
declare
  fk_name text;
  r record;
  n int;
  total int := 0;
begin
  drop table if exists _rename111;
  -- 欄位不能叫 n —— 那是下面的變數名，plpgsql 遇到同名會直接報錯（而不是猜）
  create temp table _rename111 (ord int, item text, result text, detail text);

  -- ── 對照表 ──────────────────────────────────────
  drop table if exists _map111;
  create temp table _map111 (old_code text primary key, new_code text not null);
  insert into _map111 values ('中信', '2915'), ('匯豐', '4175'), ('匯豐9650', '9650');

  -- ── 先擋掉會出事的情況 ───────────────────────────
  -- 新代號已經被別人用了的話，改下去會撞唯一鍵，整個交易回滾。
  -- 與其讓 Postgres 丟一句看不懂的錯，不如自己講清楚是哪一個。
  if exists (
    select 1 from _map111 m
     where exists (select 1 from public.payment_accounts p
                    where p.code = m.new_code and p.code <> m.old_code)
  ) then
    insert into _rename111
    select 0, '新代號已被使用', '❌ 中止',
      string_agg(m.new_code, '、')
    from _map111 m
    where exists (select 1 from public.payment_accounts p
                   where p.code = m.new_code and p.code <> m.old_code);
    return;
  end if;

  -- 舊代號找不到就沒必要往下做（可能已經改過了）
  insert into _rename111
  select 1, '找到要改的帳號',
    case when count(*) = 3 then '✅ 3 個'
         when count(*) = 0 then '－ 都不存在（可能已經改過）'
         else '⚠ 只找到 ' || count(*) || ' 個' end,
    coalesce(string_agg(p.code || ' → ' || m.new_code, '、'), '')
  from _map111 m join public.payment_accounts p on p.code = m.old_code;

  if not exists (select 1 from _map111 m
                  join public.payment_accounts p on p.code = m.old_code) then
    return;
  end if;

  -- ── 外鍵改成 ON UPDATE CASCADE ───────────────────
  select c.conname into fk_name
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
   where cl.relname = 'order_payments' and c.contype = 'f'
     and c.confrelid = 'public.payment_accounts'::regclass
   limit 1;

  if fk_name is not null then
    execute format('alter table public.order_payments drop constraint %I', fk_name);
  end if;
  alter table public.order_payments
    add constraint order_payments_account_fkey
    foreign key (account) references public.payment_accounts(code)
    on update cascade;
  insert into _rename111 values (2, '外鍵改成 ON UPDATE CASCADE', '✅',
    'order_payments.account 之後會自己跟著主檔改');

  -- ── 主檔（order_payments 靠 CASCADE 自己跟上）─────
  update public.payment_accounts p
     set code = m.new_code
    from _map111 m
   where p.code = m.old_code;
  get diagnostics n = row_count;
  insert into _rename111 values (3, 'payment_accounts.code', '✅', n || ' 筆');

  -- ── 五個沒有外鍵的歷史欄位 ───────────────────────
  for r in
    select * from (values
      ('orders',            'account'),
      ('expenses',          'pay_account'),
      ('purchase_requests', 'payout_account'),
      ('deposits',          'received_account'),
      ('deposits',          'returned_account')
    ) v(tbl, col)
  loop
    execute format(
      'update public.%I t set %I = m.new_code from _map111 m where t.%I = m.old_code',
      r.tbl, r.col, r.col);
    get diagnostics n = row_count;
    total := total + n;
    insert into _rename111 values (4, r.tbl || '.' || r.col,
      case when n > 0 then '✅' else '－' end, n || ' 筆');
  end loop;

  insert into _rename111 values (5, '歷史資料合計', '✅', total || ' 筆已改');

  -- ── 確認沒有漏 ───────────────────────────────────
  -- 六個地方都改完之後，這些欄位不該再出現任何一個舊代號。
  for r in
    select * from (values
      ('orders', 'account'), ('expenses', 'pay_account'),
      ('purchase_requests', 'payout_account'),
      ('deposits', 'received_account'), ('deposits', 'returned_account'),
      ('order_payments', 'account'), ('payment_accounts', 'code')
    ) v(tbl, col)
  loop
    execute format(
      'select count(*) from public.%I t join _map111 m on t.%I = m.old_code',
      r.tbl, r.col) into n;
    if n > 0 then
      insert into _rename111 values (6, '★ ' || r.tbl || '.' || r.col || ' 還有舊代號',
        '❌ ' || n || ' 筆', '這個欄位沒有被更新到');
    end if;
  end loop;

  if not exists (select 1 from _rename111 where ord = 6) then
    insert into _rename111 values (6, '★ 全部欄位都沒有殘留舊代號', '✅', '');
  end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('111_rename_card_codes');
  end if;
end $$;


select item as "項目", result as "結果", detail as "說明"
from _rename111 order by ord, item;
