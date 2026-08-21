-- migration_154：契約與訂單編輯的全部功能開放給管家
--
-- ============================================================
-- 【為什麼】（2026-08-21 使用者指定：「契約與訂單編輯裡面所有功能都要開放給管家」）
--
-- 管家的側邊選單本來就有「契約 | 收入」與「訂單 | 收入」，
-- contracts 與 orders 的 RLS 也早就放行 —— 但編輯視窗裡有三塊
-- **看得到、按得下、存不進去**：
--
--   contract_recurring_charges  固定加費   accountant/manager/super_admin
--   order_payments              訂單收款   同上
--   attachments (op/)           收款證明   can_*_receipt() 只認請款單
--
-- 而 PostgREST 遇到 RLS 擋下的 insert/update 是**回成功、影響 0 列**。
-- 固定加費那塊前端 canEdit 又是寫死 true，所以管家會看到
-- 「已儲存，各期已更新」，重整之後什麼都沒有。
--
-- 更麻煩的是**讀**也被擋：加費清單永遠是空的，而「空的」跟
-- 「這張契約真的沒設加費」長得一模一樣 —— 他會以為沒設過，
-- 於是重設一次，而那一次也不會存進去。
--
--
-- ============================================================
-- 【這支開放了什麼 —— 請先確認這是你要的】
--
-- 跑完之後管家可以：
--   · 新增／修改／刪除契約的固定加費（會連帶重算各期應收）
--   · 新增／刪除訂單收款（等於可以把一筆訂單標成已收款）
--   · 看見與上傳訂單的收款證明照片
--
-- 也就是**管家碰得到錢**。這是這支唯一一個開了不好收回的決定
-- （政策可以 drop，但這段期間他改過的金額不會自己變回來）。
--
--
-- ============================================================
-- 【為什麼是追加政策，不是改寫既有的】
--
-- permissive policy 之間是 OR —— 追加一條只會讓可見範圍變大，
-- 不可能讓誰失去既有的權限。改寫既有那幾條的風險是
-- 「本來看得到的東西突然看不到」，而那種退步通常要等
-- 某個人某天打不開某一頁才會發現（migration_153 同樣的理由）。
--
-- 所以這支從頭到尾**沒有 drop 任何既有政策**。
--
--
-- ============================================================
-- 【沒有開放的（刻意）】
--
--   · attachments 的 exp/ 與 pr/ 前綴 —— 支出憑證與別人的請款單，
--     不在「契約與訂單」的範圍裡
--   · attachments 的 dp/ 前綴 —— 押金收款證明。管家的選單裡雖然
--     有「押金管理」，但那是另一件事，要開請另外講
--   · estates / properties / payment_accounts 的**寫入** ——
--     兩個頁面都只 select（下拉選單），不需要
--   · profiles 的寫入 —— 改角色仍然只有 super_admin
-- ============================================================


-- ── ① 固定加費 ─────────────────────────────────────
/*
 * 既有的 crc_read / crc_write 原封不動，這裡追加管家專用的兩條。
 *
 * 分成 read 與 write 兩條而不是一條 for all，是為了跟既有的
 * 命名與結構對齊 —— 哪天要單獨收回寫入權限時 drop 一條就好。
 */
drop policy if exists crc_read_housekeeper  on public.contract_recurring_charges;
drop policy if exists crc_write_housekeeper on public.contract_recurring_charges;

create policy crc_read_housekeeper on public.contract_recurring_charges
  for select using (public.current_role_of() = 'housekeeper');

create policy crc_write_housekeeper on public.contract_recurring_charges
  for all
  using       (public.current_role_of() = 'housekeeper')
  with check  (public.current_role_of() = 'housekeeper');

comment on policy crc_read_housekeeper on public.contract_recurring_charges is
  '管家讀得到固定加費。沒有這條的話清單永遠是空的，而那跟「真的沒設定」'
  '長得一模一樣（migration_154）。';


-- ── ② 訂單收款 ─────────────────────────────────────
drop policy if exists op_housekeeper on public.order_payments;

create policy op_housekeeper on public.order_payments
  for all
  using       (public.current_role_of() = 'housekeeper')
  with check  (public.current_role_of() = 'housekeeper');

comment on policy op_housekeeper on public.order_payments is
  '管家可以收款。前端 shortterm 的 canCollect 要同步放行，'
  '不然畫面上還是沒有收款按鈕（migration_154）。';


-- ── ③ 訂單收款證明的照片 ───────────────────────────
/*
 * attachments 的政策是 can_see_receipt(path) / can_edit_receipt(path)，
 * 角色判斷藏在函式裡，加政策沒有用，要改函式本體。
 *
 * 路徑格式是 `<kind>/<母層id>/<uuid>.<副檔名>`（見 Receipts.tsx），
 * kind 有 pr / exp / dep / op / dp 五種。訂單收款證明是 `op/`。
 *
 * ★ 為什麼原本管家看不到:
 *   既有的 else 分支拿 split_part(path,'/',2) 去比對 purchase_requests。
 *   對 `op/<收款id>/…` 來說那是一個合法的 uuid（所以不會報錯），
 *   但永遠對不到任何一張請款單 —— 於是**安靜地回 false**。
 *   沒有錯誤訊息，照片就是不見。
 *
 * ★ 為什麼新分支放在 else 之前而不是加進 in(...) 那一行:
 *   管家只該看到 `op/`，不是全部。寫進第一行的角色清單等於
 *   連支出憑證與別人的請款單都一起開了。
 *
 * ★ CREATE OR REPLACE FUNCTION 不能改參數名字 —— p_path 維持原名。
 */
create or replace function public.can_see_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 管家:訂單的收款證明（migration_154）
    when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
    -- 其他人只看得到自己送的請款單底下的附件
    else exists (
      select 1
      from public.attachments a
      join public.purchase_requests p on p.id = a.request_id
      where a.path = p_path and p.requester_id = auth.uid()
    )
  end;
$function$;

create or replace function public.can_edit_receipt(p_path text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 管家:訂單的收款證明（migration_154）
    when current_role_of() = 'housekeeper' and p_path like 'op/%' then true
    else exists (
      select 1
      from public.purchase_requests p
      where p.id = nullif(split_part(p_path, '/', 2), '')::uuid
        and p.requester_id = auth.uid()
        and p.status in ('draft','rejected','pending')
    )
  end;
$function$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('154_housekeeper_contract_order');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk154;
  create temp table _chk154 (ord int, item text, result text, detail text);

  -- ① 新政策都在
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'contract_recurring_charges'
     and p.polname in ('crc_read_housekeeper','crc_write_housekeeper');
  insert into _chk154 values (1, '★★ 固定加費：管家政策', n || ' / 2',
    case when n = 2 then '✅ 讀與寫都建好了' else '❌ 沒建起來' end);

  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'order_payments' and p.polname = 'op_housekeeper';
  insert into _chk154 values (2, '★★ 訂單收款：管家政策', n || ' / 1',
    case when n = 1 then '✅' else '❌ 沒建起來' end);

  /*
   * ★★ 既有政策一條都不能少。
   *   這支只追加。少掉任何一條的症狀都是「某個角色某一頁突然打不開」，
   *   而那要等有人真的去點才會發現。
   */
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'contract_recurring_charges'
     and p.polname in ('crc_read','crc_write');
  insert into _chk154 values (3, '★★ 既有的 crc 政策', n || ' / 2',
    case when n = 2 then '✅ 都還在（會計與主管沒受影響）' else '❌ 有政策不見了' end);

  /*
   * ★★ 有沒有 restrictive policy。
   *   permissive 是 OR、加一條就變寬；但 restrictive 是 AND，
   *   只要存在一條，這支加的政策就完全沒有效果 ——
   *   而症狀會是「政策建好了、管家還是存不進去」，很難查。
   */
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname in ('contract_recurring_charges','order_payments','attachments')
     and not p.polpermissive;
  insert into _chk154 values (4, '★★ restrictive 政策', n || ' 條',
    case when n = 0 then '✅ 沒有，追加的政策會生效'
         else '❌ 有 restrictive，追加的政策會被 AND 掉，要另外處理' end);

  -- ③ 函式真的改到了
  insert into _chk154 values (5, '★ 附件函式已放行 op/',
    case when (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                where ns.nspname = 'public'
                  and p.proname in ('can_see_receipt','can_edit_receipt')
                  and pg_get_functiondef(p.oid) like '%housekeeper%op/%') = 2
         then '✅ 2 / 2' else '❌' end,
    '管家看得到也傳得了訂單的收款證明');

  /*
   * ★ 支出與押金的憑證仍然擋著 —— 這支刻意沒開。
   *   放行條件寫死 `p_path like 'op/%'`，其他前綴走原本的 else。
   */
  insert into _chk154 values (6, '★ exp/ 與 dp/ 仍未開放',
    case when (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                where ns.nspname = 'public'
                  and p.proname in ('can_see_receipt','can_edit_receipt')
                  and pg_get_functiondef(p.oid) like '%housekeeper%exp/%') = 0
         then '✅' else '❌ 不小心開到支出憑證了' end,
    '只放行訂單收款證明');

  select count(*) into n from public.profiles where role = 'housekeeper' and active;
  insert into _chk154 values (7, '受影響的人', n || ' 位管家',
    '這些人現在可以改固定加費、收款、看收款證明');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk154 order by ord;


-- ============================================================
-- 管家現在碰得到什麼（跑完對照用）
-- ============================================================
/*
 * 這張表是「政策的字面上有沒有放行 housekeeper」，
 * 不是真的用管家帳號跑一次 —— 最後還是要請一位管家實際點一遍。
 */
with t(ord, tbl, 用途) as (values
  (1,'contracts','契約主檔'),
  (2,'contract_recurring_charges','固定加費'),
  (3,'orders','訂單／收入單'),
  (4,'order_payments','訂單收款'),
  (5,'invoices','發票'),
  (6,'contract_payments','契約收款')
)
select t.ord as "#", t.tbl as "資料表", t.用途 as "用途",
       count(p.polname) filter (
         where coalesce(pg_get_expr(p.polwithcheck, p.polrelid),
                        pg_get_expr(p.polqual, p.polrelid)) like '%housekeeper%'
       ) as "放行管家的政策數"
from t
join pg_class c on c.relname = t.tbl and c.relnamespace = 'public'::regnamespace
left join pg_policy p on p.polrelid = c.oid
group by t.ord, t.tbl, t.用途
order by t.ord;
