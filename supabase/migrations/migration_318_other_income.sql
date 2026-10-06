/* ══════════════════════════════════════════════════════════════════════
 * migration_318：會計科目「其他收入」—— Airbnb 取消費、訂金沒收、取消訂單的沒入都歸這裡       2026-10-06
 *
 * 【為什麼】David：「會計科目也創一個其他收入，把 Airbnb 取消預定跟這個沒入歸在這」「訂金沒收 > 要」
 *
 * 【做什麼】
 *   ① 新科目 other_income「其他收入」（收入端）
 *   ② order_account_code()：名目「取消費」「取消入住」→ other_income（原本都落在 other「其他」）
 *   ③ forfeit_earnest()：之後沒收訂金的收入單，名目從「其他」改「取消入住」
 *   ④ 以前沒收訂金產生的那幾筆（名目「其他」＋項目「取消入住」）改成名目「取消入住」—— 已關帳月份不動
 *
 * ★★ 營收**總額不變**；損益表上那幾筆從「其他」搬到「其他收入」。
 *    科目是查報表時才算的，所以 Airbnb 取消費**連已關帳月份也會跟著搬**（自檢第 4 列列出筆數與金額）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

create temp table if not exists _m (k text, v text) on commit preserve rows;

begin;
delete from _m;

-- ① 科目
insert into public.account_codes (code, name, sort, active, kind)
values ('other_income', '其他收入', 899, true, 'income')
on conflict (code) do update set name = excluded.name, active = true, kind = excluded.kind;

-- ② 名目 → 科目
create or replace function public.order_account_code(p_source text, p_fee_type text)
returns text language sql immutable as $fn$
  select case
    -- 一次性收入：名目計入對應科目。名目本身照舊存在 fee_type，不動。
    when p_source in ('oneoff', 'airbnb_cancelled') then
      case coalesce(p_fee_type, '其他')
        when '水費'     then 'utility'
        when '電費'     then 'utility'
        when '瓦斯費'   then 'utility'
        when '水電瓦斯' then 'utility'   -- migration_148
        when '修繕費'   then 'repair'
        when '網路費'   then 'internet'
        when '管理費'   then 'mgmtfee'
        when '清潔費'   then 'cleaning'
        when '停車費'   then 'parking'
        when '設備費'   then 'equipment'
        when '保證金'   then 'guarantee'
        when '運費'     then 'freight'   -- migration_148
        when '稅費'     then 'tax_fee'   -- migration_204
        /*
         * ★★ 房務（migration_229）。
         *   房務清潔 = 安幸對物業收的清潔服務費，跟物業那邊的支出**同一個科目**
         *              （hk_cleaning 於 228 改成 kind=both）。
         *   人事費   = 只有收入端有這個科目;支出端走既有的 salary 薪資勞務。
         *
         * ★ 不可以用 `cleaning 清潔費` —— 那是向**房客**收的,
         *   跟安幸向**物業**收的是兩門生意。混在一起報表就分不出來了
         *   （migration_206 特地分開的理由）。
         */
        when '房務清潔' then 'hk_cleaning'
        when '人事費'   then 'hk_labor'
        /*
         * ★ migration_318（2026-10-06 David：「會計科目也創一個其他收入，把 Airbnb 取消預定跟沒入歸在這」）
         *   取消費   ＝ Airbnb 取消但房客仍付錢（airbnb-sync.ts 寫的）
         *   取消入住 ＝ 訂金沒收、取消訂單結算的沒入（forfeit_earnest、cancel_order_settle）
         */
        when '取消費'   then 'other_income'
        when '取消入住' then 'other_income'
        -- 認不得的一律計入「其他」
        else 'other'
      end
    -- 其餘全部計入租金收入
    else 'rent_income'
  end
$fn$;

-- ③ 沒收訂金
create or replace function public.forfeit_earnest(p_dep uuid, p_on date)
returns jsonb language plpgsql as $fn$
declare
  d      public.deposits;
  oid    uuid;
  n      int;
  uid    uuid := auth.uid();
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_on is null then p_on := (now() at time zone 'Asia/Taipei')::date; end if;

  select * into d from public.deposits where id = p_dep;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆訂金（可能剛被別人刪了）');
  end if;
  if d.kind <> 'earnest' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EARNEST', 'message', '這一筆不是訂金');
  end if;
  -- ★ 冪等：已經沒收過就不再產生第二筆（前端也擋，這裡是最後一道）
  if d.forfeit_order_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'message', '這筆訂金已經沒收過了。');
  end if;
  if d.converted_to_deposit_id is not null then
    return jsonb_build_object('ok', false, 'code', 'CONVERTED', 'message', '這筆訂金已經轉成押金了，不能再沒收。');
  end if;
  if d.returned_on is not null then
    return jsonb_build_object('ok', false, 'code', 'RETURNED', 'message', '這筆訂金已經退了，不能再沒收。');
  end if;

  -- ① 收入單（欄位逐字照 lib/earnest.ts 的 forfeitOrder()；318 起 fee_type 改「取消入住」）
  insert into public.orders
    (source, fee_type, item_name, amount, checkin, checkout, deposit_id,
     estate_id, property_id, property_raw, guest_name, note,
     nights, order_key, imported_via)
  values
    ('oneoff', '取消入住', '取消入住',   -- migration_318：科目「取消入住」→ 其他收入（原本是「其他」）
     greatest(0, coalesce(d.amount, 0)), p_on, p_on, d.id,
     d.estate_id, d.property_id, d.room, d.guest_name, format('沒收訂金（%s）', p_on),
     0, format('FEIT_%s_%s', left(d.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint), 'manual')
  returning id into oid;
  if oid is null then
    raise exception '收入單沒有建起來（多半是權限）—— 什麼都沒寫進去';
  end if;

  -- ② 回寫訂金
  update public.deposits
     set forfeited_on = p_on, forfeit_order_id = oid, forfeited_by = uid
   where id = d.id;
  get diagnostics n = row_count;
  if n <> 1 then
    -- ★★★ 這一句 raise 就是整支的重點：以前是「收入建好了但訂金沒更新」，現在收入也退回
    raise exception '訂金狀態沒有更新（多半是權限）—— 收入單也一起退回，什麼都沒寫進去';
  end if;

  return jsonb_build_object('ok', true, 'code', 'OK', 'order_id', oid, 'amount', d.amount,
    'message', format('已沒收，並產生一筆 NT$ %s 的「取消入住」收入', to_char(coalesce(d.amount,0), 'FM999,999,999')));
end $fn$;
grant execute on function public.forfeit_earnest(uuid, date) to authenticated;

-- ④ 舊的沒收訂金收入單：名目「其他」→「取消入住」（已關帳月份不動）
insert into _m select '④ 改名目的沒收訂金收入單', count(*)::text || ' 筆・$' || to_char(coalesce(sum(amount), 0), 'FM999,999,999')
  from public.orders
 where source = 'oneoff' and fee_type = '其他' and item_name = '取消入住'
   and not public.is_period_locked(to_char(checkin, 'YYYYMM'));
update public.orders set fee_type = '取消入住'
 where source = 'oneoff' and fee_type = '其他' and item_name = '取消入住'
   and not public.is_period_locked(to_char(checkin, 'YYYYMM'));

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('318_other_income');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '科目「其他收入」在' as 檢查,
       coalesce((select code || ' ' || name || '・' || kind from public.account_codes where code = 'other_income'), '★ 沒有') as 結果,
       case when exists (select 1 from public.account_codes where code = 'other_income' and active) then '✅' else '❌' end as 判定
union all
select 2, '名目對照：取消費、取消入住 → 其他收入；其他、清潔費不變',
       public.order_account_code('oneoff', '取消費') || '、' || public.order_account_code('oneoff', '取消入住') || '、'
         || public.order_account_code('oneoff', '其他') || '、' || public.order_account_code('oneoff', '清潔費'),
       case when public.order_account_code('oneoff', '取消費') = 'other_income'
             and public.order_account_code('oneoff', '取消入住') = 'other_income'
             and public.order_account_code('oneoff', '其他') = 'other'
             and public.order_account_code('oneoff', '清潔費') = 'cleaning' then '✅' else '❌' end
union all
select 3, '沒收訂金函式新版（名目取消入住）',
       case when pg_get_functiondef('public.forfeit_earnest(uuid, date)'::regprocedure) like '%migration_318%' then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.forfeit_earnest(uuid, date)'::regprocedure) like '%migration_318%' then '✅' else '❌' end
union all
select 4, 'Airbnb 取消費：從「其他」搬到「其他收入」（總額不變，參考）',
       (select count(*) || ' 筆・$' || to_char(coalesce(sum(amount), 0), 'FM999,999,999') from public.orders
         where source in ('oneoff', 'airbnb_cancelled') and fee_type = '取消費'),
       'ℹ'
union all
select 5, (select k from _m), (select v from _m), 'ℹ'
union all
select 6, '還沒改到的沒收訂金收入單（已關帳月份，參考）',
       (select count(*)::text || ' 筆' from public.orders where source = 'oneoff' and fee_type = '其他' and item_name = '取消入住'),
       'ℹ'
order by 1;
