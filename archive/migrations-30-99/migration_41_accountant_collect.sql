-- migration_41：讓會計能登記收款
--
-- 現況：orders 對 accountant 只有 orders_accountant_read（SELECT），
-- 所以契約頁的「確認收款」按下去必定失敗 —— 它寫的是 orders.paid / paid_at。
--
-- 這個限制不合理：會計正是最該登記收款的角色。管家能寫、會計不能寫，
-- 等於把帳務作業擋在負責帳務的人之外。
--
-- 但也不能直接開放整張表：orders 存的是金額、日期、房客、房源這些
-- 影響營收認列的欄位，改動會連帶重算 revenue_recognitions。
-- 所以做法是「開放 UPDATE，但用觸發器限制只能改收款相關欄位」——
-- RLS 管得到「哪些列」，管不到「哪些欄位」，欄位層級只能靠觸發器。

-- ============================================================
-- 1. RLS：會計可以更新 orders
-- ============================================================
drop policy if exists orders_accountant_write on public.orders;
create policy orders_accountant_write on public.orders
  for update
  using (current_role_of() = 'accountant')
  with check (current_role_of() = 'accountant');


-- ============================================================
-- 2. 觸發器：限制會計只能改收款相關欄位
--
-- 用「白名單」而非列舉禁止欄位：
-- 比對 old/new 的 jsonb 找出實際變動的欄位，只要有任何一個不在白名單就擋。
-- 這樣未來 orders 加新欄位時，預設是禁止而不是放行 —— 列舉禁止欄位的寫法
-- 會讓新欄位自動變成可改，那是「忘記維護就出事」的設計。
-- ============================================================
create or replace function public.orders_guard_accountant() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  allowed text[] := array[
    'paid', 'paid_at',                                    -- 收款
    'deposit_received', 'deposit_received_at',            -- 押金已收
    'deposit_returned', 'deposit_returned_at',            -- 押金已退
    'account',                                            -- 入款帳號
    'note'                                                -- 備註
  ];
  bad text;
begin
  if current_role_of() <> 'accountant' then
    return new;
  end if;

  select n.key into bad
  from jsonb_each(to_jsonb(new)) n
  where n.value is distinct from (to_jsonb(old) -> n.key)
    and n.key <> all(allowed)
  limit 1;

  if bad is not null then
    raise exception '會計只能更新收款相關欄位,不得修改「%」。金額、日期、房源等欄位請由主管或總經理處理。', bad;
  end if;

  return new;
end $$;

drop trigger if exists trg_orders_guard_accountant on public.orders;
create trigger trg_orders_guard_accountant
  before update on public.orders
  for each row execute function public.orders_guard_accountant();


-- ============================================================
-- 3. 驗證
-- ============================================================
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'orders'
order by cmd, policyname;

select tgname from pg_trigger
where tgrelid = 'public.orders'::regclass and not tgisinternal
order by tgname;


-- ============================================================
-- 附錄：契約的押金收退寫的是 contracts 表，不是 orders。
-- 若收租視窗的押金區塊會計也按不動，先跑這句看 contracts 的 policy，
-- 再決定要不要比照辦理。
-- ============================================================
-- select policyname, cmd, qual from pg_policies
-- where schemaname = 'public' and tablename = 'contracts' order by cmd, policyname;
