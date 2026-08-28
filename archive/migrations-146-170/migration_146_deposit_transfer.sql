-- migration_146：押金移房（A 房的押金轉到 B 房）
--
-- ============================================================
-- 【要解決什麼】（2026-08-19 使用者指定）
--
--   房客原本住 A 房，押金收了、錢在我們手上。
--   換到 B 房 → B 開了一張新訂單 → 觸發器長出一列「押金未收」。
--
--   實際上不會真的退 A 的錢再跟他收一次 —— 那筆錢從頭到尾沒有動過，
--   只是換了一個名目。所以要的是「移轉」，不是「退款 ＋ 收款」。
--
--   移完之後：A 變已退押金、B 變已收押金，兩邊備註互相指認。
--
--
-- ============================================================
-- 【為什麼要四個欄位，備註寫中文字不夠】
--
-- 備註是給人看的，**程式對不上**。有欄位才做得到三件事：
--
--   ① 畫面上點 A 直接跳到 B（不用人去讀那句中文再自己搜）
--   ② Excel 帶得出對應的那一筆
--   ③ ★★ 報表把移轉排除在「本月收款／本月退款」之外
--
-- ③ 是真正的理由。移轉會讓 A 有 returned_on、B 有 received_on ——
-- 分不出來的話，八月的押金報表就會憑空多一筆退款和一筆收款，
-- 而總額又剛好對得起來（錢沒有離開公司），**不會有任何跡象**。
-- 靠 `note like '%移轉%'` 去濾是在賭沒有人手打過那兩個字。
--
--
-- ============================================================
-- 【為什麼 refund_status 會變成 approved】
--
-- 看起來很怪:移轉根本沒有走兩票審核，怎麼會是「已核可」?
--
-- 那是資料庫的約束逼的 —— `dep_refund_chk` 規定
-- 「returned_on 有值就必須 refund_status = 'approved'」。
-- 要讓 A 變成已退，這一欄就只能是 approved。
--
-- **它記的是「這筆押金可以出去了」，不是「兩個人投過票」。**
-- 判斷一筆退款有沒有經過審核，看 manager_approved_at / admin_approved_at,
-- 那兩欄移轉時是空的。
--
--
-- ============================================================
-- 【為什麼移轉不用兩票審核】（使用者確認：「移轉 不用兩票」）
--
-- 兩票在擋的是「錢被匯到不該去的帳戶」。移轉的錢**沒有離開公司**,
-- 沒有收款帳號可填，payee_name / payee_account 那幾個必填欄位
-- 也填不出東西來。硬套流程只會逼人亂填一個帳號進去,
-- 而那個假帳號將來看起來跟真的一模一樣。
--
-- 代價是要留人證:transferred_by / transferred_at 記誰在什麼時候移的。
--
--
-- ============================================================
-- 【為什麼金額不同就擋掉】（使用者選 (a)）
--
-- 因為 `deposits.amount` 是觸發器從 `orders.deposit` / `contracts.deposit`
-- 同步過來的（sync_order_deposits）。移轉時**不能**順手把 B 那列改小 ——
-- 下次那張訂單一存檔就被蓋回去。
--
-- 結果會是：B 顯示「已收 40,000」，實際只有 30,000 進來，
-- 差額不在任何地方，而畫面上完全看不出來。
--
-- 所以差額要嘛先去訂單把金額改對，要嘛等「押金收款多筆」做完
-- 再把差額當第二筆收款記進去。這裡不猜。


-- ── ① 四個欄位 ─────────────────────────────────────
alter table public.deposits
  add column if not exists transfer_to_id   uuid references public.deposits(id) on delete set null,
  add column if not exists transfer_from_id uuid references public.deposits(id) on delete set null,
  add column if not exists transferred_by   uuid references public.profiles(id),
  add column if not exists transferred_at   timestamptz;

comment on column public.deposits.transfer_to_id is
  '這筆押金移轉到哪一筆（A 指向 B）。有值 = 這筆的 returned_on 是移轉不是真的退款,'
  '**押金退款報表要把它排除**,否則那個月會多一筆從來沒發生過的匯出（migration_146）。';
comment on column public.deposits.transfer_from_id is
  '這筆押金移轉自哪一筆（B 指向 A）。有值 = 這筆的 received_on 是移轉不是真的收款。';
comment on column public.deposits.transferred_by is
  '誰按的移轉。移轉不走兩票審核（錢沒離開公司）,所以人證只剩這一欄。';


-- ── ② 移轉 ─────────────────────────────────────────
/*
 * 【為什麼是一支 RPC，不在前端做兩次 update】
 *
 * ★★ RLS 擋下的 UPDATE **會回成功且影響 0 列**。
 *
 * 前端分兩句寫的話，第二句被擋掉時畫面會說「移轉成功」，
 * 而實際上 A 已退、B 還是未收 —— **那筆錢在系統裡人間蒸發**,
 * 押金總額少一筆，沒有任何錯誤訊息。
 *
 * 一支函式一個交易，要嘛兩列都改、要嘛都不動。
 *
 * 回傳 ok 布林而不是只回文字：前端要靠字串比對來判斷成功與否的話,
 * 哪天訊息改一個字就會變成「失敗也顯示成功」。
 */
create or replace function public.transfer_deposit(
  p_from uuid, p_to uuid, p_on date default current_date
) returns table(ok boolean, item text, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  f public.deposits;
  t public.deposits;
  v_from_name text;
  v_to_name   text;
begin
  /*
   * 權限。使用者指定「只有會計 super_admin 有權限可以轉」——
   * **經理不在內**（他能改押金、能投退款票，但不能移房）。
   *
   * SECURITY DEFINER 會繞過 RLS，所以這裡不檢查就等於誰都能移。
   */
  if current_role_of() not in ('accountant', 'super_admin') then
    return query select false, '權限不足'::text, '只有會計與總管理員能移轉押金'::text;
    return;
  end if;

  if p_from is null or p_to is null or p_from = p_to then
    return query select false, '來源與目的不能是同一筆'::text, ''::text;
    return;
  end if;

  select * into f from public.deposits where id = p_from;
  select * into t from public.deposits where id = p_to;
  if f.id is null then
    return query select false, '找不到來源押金'::text, ''::text; return;
  end if;
  if t.id is null then
    return query select false, '找不到目的押金'::text, ''::text; return;
  end if;

  v_from_name := coalesce(nullif(f.room, ''), nullif(f.guest_name, ''), '（未填房號）');
  v_to_name   := coalesce(nullif(t.room, ''), nullif(t.guest_name, ''), '（未填房號）');

  -- ── 來源要是「錢真的在我們手上」的狀態 ──
  if f.received_on is null then
    return query select false, '來源還沒收到押金'::text,
      v_from_name || ' 這筆是「尚未收」—— 沒有錢可以移'::text; return;
  end if;
  if f.returned_on is not null then
    return query select false, '來源已經退款了'::text,
      v_from_name || ' 於 ' || f.returned_on || ' 已退' ||
      case when f.transfer_to_id is not null then '（移轉出去）' else '' end; return;
  end if;
  if f.orphaned then
    return query select false, '來源是孤兒紀錄'::text,
      '來源訂單／契約已經不在了,請先確認這筆押金的歸屬'::text; return;
  end if;

  -- ── 目的要是「還沒收」的狀態 ──
  if t.received_on is not null then
    return query select false, '目的已經收過押金了'::text,
      v_to_name || ' 於 ' || t.received_on || ' 已收 —— 重複收兩次押金是錯的'::text; return;
  end if;
  if t.returned_on is not null then
    return query select false, '目的已經退款了'::text, ''::text; return;
  end if;
  if t.orphaned then
    return query select false, '目的是孤兒紀錄'::text, ''::text; return;
  end if;

  -- ── 幣別與金額要完全一樣 ──
  if coalesce(f.currency, 'TWD') <> coalesce(t.currency, 'TWD') then
    return query select false, '幣別不同'::text,
      coalesce(f.currency,'TWD') || ' → ' || coalesce(t.currency,'TWD') ||
      ' —— 換匯是另一件事,不能靠移轉帶過'::text; return;
  end if;
  /*
   * ★ 金額不同一律擋。理由見檔頭:B 那一欄改不動（觸發器會蓋回去）,
   *   放行的話畫面會顯示一個從來沒收到的數字。
   *
   *   訊息要把兩個數字跟差額都講出來 —— 只說「金額不同」的話,
   *   人得自己開兩個視窗對照才知道差多少、該往哪邊改。
   */
  if round(coalesce(f.amount, 0), 2) <> round(coalesce(t.amount, 0), 2) then
    return query select false, '金額不同,不能移轉'::text,
      v_from_name || ' 收了 ' || to_char(coalesce(f.amount,0), 'FM999,999,999') ||
      '，' || v_to_name || ' 要 ' || to_char(coalesce(t.amount,0), 'FM999,999,999') ||
      '，差 ' || to_char(abs(coalesce(t.amount,0) - coalesce(f.amount,0)), 'FM999,999,999') ||
      '。請先到' || case when t.order_id is not null then '訂單' else '契約' end ||
      '把押金金額改成一致,再回來移轉'::text; return;
  end if;
  /*
   * 多幣別明細（deposits.lines，migration_87）也要一樣。
   *
   * 用 to_jsonb(row)->'lines' 而不是直接寫 f.lines —— **那一欄不一定存在**
   * （schema-baseline 裡沒有它）。直接引用的話，沒有這欄的環境會整支噴
   * column does not exist,而那時已經是上線之後了。
   * to_jsonb 取不到的鍵回 NULL,兩邊都是 NULL 就自然相等。
   */
  if to_jsonb(f)->'lines' is distinct from to_jsonb(t)->'lines' then
    return query select false, '多幣別明細不同,不能移轉'::text,
      '兩邊的外幣組成要一模一樣'::text; return;
  end if;

  -- ── 動手 ───────────────────────────────────────────
  /*
   * refund_status 設成 approved 是 dep_refund_chk 逼的（見檔頭）。
   * manager_approved_* / admin_approved_* 刻意留空 ——
   * 那兩欄是「有沒有經過兩票」的唯一證據,填了就分不出真假審核。
   */
  update public.deposits set
    returned_on      = p_on,
    returned_method  = 'internal',
    returned_account = null,
    refund_status    = 'approved',
    transfer_to_id   = t.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉至 ' || v_to_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = f.id;

  update public.deposits set
    received_on      = p_on,
    received_method  = 'internal',
    received_account = null,
    transfer_from_id = f.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉自 ' || v_from_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = t.id;

  return query select true, '已移轉'::text,
    v_from_name || ' → ' || v_to_name || '，NT$ ' ||
    to_char(coalesce(f.amount, 0), 'FM999,999,999') || '，' ||
    to_char(p_on, 'YYYY-MM-DD') || '。錢沒有實際進出,兩邊備註都已註記'::text;
end $fn$;

grant execute on function public.transfer_deposit(uuid, uuid, date) to authenticated;

comment on function public.transfer_deposit(uuid, uuid, date) is
  '押金移房:A 房收過的押金轉到 B 房的新訂單。一個交易改兩列 —— '
  '分兩次做的話第二句被 RLS 擋下會回成功且 0 列,結果是 A 已退 B 未收,'
  '那筆錢在系統裡消失而沒有任何錯誤訊息（migration_146）。';


-- ── ③ 撤銷 ─────────────────────────────────────────
/*
 * 【為什麼一定要有這一支】
 *
 * 移錯了（選錯 A、選錯 B）之後，前端**沒有任何地方能清掉 returned_on** ——
 * 押金頁的 settle() 只會填日期不會清，編輯視窗刻意不碰 returned_*。
 *
 * 沒有這支的話，選錯一次就只能請人去改資料庫。
 * 而「只能改資料庫」的下場通常是沒有人去改，那筆錯的就一直留著。
 *
 * 備註**不刪原文**，追加一行撤銷紀錄 —— 移過又撤掉本身就是要留痕的事。
 */
create or replace function public.undo_deposit_transfer(
  p_id uuid
) returns table(ok boolean, item text, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  f      public.deposits;  -- 來源（A）
  t      public.deposits;  -- 目的（B）
  me_row public.deposits;  -- 使用者按的那一列,可能是 A 也可能是 B
begin
  if current_role_of() not in ('accountant', 'super_admin') then
    return query select false, '權限不足'::text, '只有會計與總管理員能撤銷移轉'::text;
    return;
  end if;

  -- 兩邊按哪一邊都可以撤 —— 使用者看到的是「這一筆不對」,
  -- 不會去想「我該從來源還是目的按」
  select * into me_row from public.deposits where id = p_id;
  if me_row.id is null then
    return query select false, '找不到這筆押金'::text, ''::text; return;
  end if;
  if me_row.transfer_from_id is not null then
    t := me_row;                                                   -- 按的是目的（B）
    select * into f from public.deposits where id = me_row.transfer_from_id;
  else
    f := me_row;                                                   -- 按的是來源（A）
    select * into t from public.deposits where id = me_row.transfer_to_id;
  end if;

  if f.id is null or t.id is null or f.transfer_to_id is distinct from t.id
     or t.transfer_from_id is distinct from f.id then
    return query select false, '這筆不是移轉來的'::text,
      '找不到成對的另一半 —— 只有移轉產生的那兩列才能撤銷'::text; return;
  end if;

  /*
   * ★ B 已經退款出去就不能撤。
   *
   * 撤銷會把 B 打回「尚未收」,而一筆從來沒收過的押金卻有退款紀錄
   * 是講不通的 —— 且那筆錢是真的匯出去了,撤了帳就對不起來。
   */
  if t.returned_on is not null then
    return query select false, '目的那筆已經退款了,不能撤銷'::text,
      coalesce(nullif(t.room,''), '目的') || ' 於 ' || t.returned_on ||
      ' 已退款 —— 錢已經出去了,要調整請走一般退款流程'::text; return;
  end if;

  update public.deposits set
    returned_on = null, returned_method = null, returned_account = null,
    refund_status = 'none',
    transfer_to_id = null, transferred_by = null, transferred_at = null,
    note = concat_ws('・', nullif(note, ''),
             '撤銷移轉 ' || to_char(current_date, 'YYYY-MM-DD'))
  where id = f.id;

  update public.deposits set
    received_on = null, received_method = null, received_account = null,
    transfer_from_id = null, transferred_by = null, transferred_at = null,
    note = concat_ws('・', nullif(note, ''),
             '撤銷移轉 ' || to_char(current_date, 'YYYY-MM-DD'))
  where id = t.id;

  return query select true, '已撤銷移轉'::text,
    coalesce(nullif(f.room,''), '來源') || ' 回到暫收中，' ||
    coalesce(nullif(t.room,''), '目的') || ' 回到尚未收。備註保留兩邊的紀錄'::text;
end $fn$;

grant execute on function public.undo_deposit_transfer(uuid) to authenticated;

comment on function public.undo_deposit_transfer(uuid) is
  '撤銷押金移轉,兩列一起復原。備註不刪原文,追加一行撤銷紀錄。'
  '目的那筆已經退款出去就擋下 —— 撤了會變成「沒收過卻退了款」。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('146_deposit_transfer');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk146;
  create temp table _chk146 (ord int, item text, result text, detail text);

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'deposits'
     and column_name in ('transfer_to_id','transfer_from_id','transferred_by','transferred_at');
  insert into _chk146 values (1, '四個移轉欄位', n || ' / 4',
    case when n = 4 then '✅' else '❌ 少了欄位' end);

  insert into _chk146 values (2, 'transfer_deposit 函式',
    case when to_regprocedure('public.transfer_deposit(uuid, uuid, date)') is not null
         then '✅' else '❌' end, '移轉');

  insert into _chk146 values (3, 'undo_deposit_transfer 函式',
    case when to_regprocedure('public.undo_deposit_transfer(uuid)') is not null
         then '✅' else '❌' end, '撤銷 —— 沒有它,選錯一次就只能改資料庫');

  /*
   * ★★ 現有資料一筆都不能被動到。
   *
   * 這支 migration 只加欄位與函式，**沒有任何 update 既有列**。
   * 有值就代表哪裡寫錯了 —— 而那會讓一批既有押金憑空變成「移轉」,
   * 從此被退款報表排除。
   */
  select count(*) into n from public.deposits
   where transfer_to_id is not null or transfer_from_id is not null;
  insert into _chk146 values (4, '★★ 既有資料被標成移轉的', n || ' 筆',
    case when n = 0 then '✅ 沒有 —— 這支不碰既有資料' else '❌ 不該有,查一下' end);

  select count(*) into n from public.deposits where received_on is not null and returned_on is null;
  select count(*) into m from public.deposits where received_on is null and returned_on is null and not orphaned;
  insert into _chk146 values (5, '現在可以當來源／目的的筆數',
    n || ' 筆暫收中 ・ ' || m || ' 筆尚未收',
    '暫收中的可以當 A，尚未收的可以當 B');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk146 order by ord;


-- ============================================================
-- 移轉之後拿這一段對帳
-- ============================================================
/*
 * 【★★ 總額不變是這件事的定義】
 *
 * 移轉的錢沒有離開公司,所以「我們手上有多少押金」移轉前後必須一模一樣。
 * 變了就是寫錯了 —— 而且是**唯一**看得出來的地方:
 * 兩列各自看都很正常，只有加起來才發現少了一筆。
 */
select
  coalesce(nullif(f.room, ''), f.guest_name, '（未填）')  as "來源房",
  coalesce(nullif(t.room, ''), t.guest_name, '（未填）')  as "目的房",
  f.currency                                            as "幣別",
  f.amount                                              as "來源金額",
  t.amount                                              as "目的金額",
  case when f.amount = t.amount then '✅' else '❌ 不一致' end as "金額對得上",
  f.returned_on                                         as "移轉日",
  p.name                                                as "經手人",
  case when f.returned_method = 'internal' and t.received_method = 'internal'
       then '✅' else '❌ 方式不是 internal' end          as "收退方式"
from public.deposits f
join public.deposits t on t.id = f.transfer_to_id
left join public.profiles p on p.id = f.transferred_by
order by f.transferred_at desc nulls last;
