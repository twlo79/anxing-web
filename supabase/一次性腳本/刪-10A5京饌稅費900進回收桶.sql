/* ══════════════════════════════════════════════════════════════════════
 * 刪-10A5京饌稅費900進回收桶.sql　2026-10-20
 * 【David】「拿掉這個」—— 收入列表上那一筆「其他收入・稅費 $900」（10A5・京饌企業有限公司・2026/10）
 *
 * 【為什麼不要它】
 *   那 900 現在記在折讓退款的「扣除」裡（migration_337：折讓 18,000 − 稅金 900 ＝ 實退 17,100），
 *   這一筆 +$900 的其他收入再留著就重複算了。
 *   ★ 折讓那一筆（−$18,000）不動。
 *
 * 【守衛】條件寫死：10A5、京饌企業有限公司、+900、一次性收入、名稱含「稅費」、2026 年 10 月。
 *   不是剛好 1 筆就整支停下來，一列都不動。
 *   這一筆如果有收款紀錄（order_payments），一起收進回收桶（復原時會一起回來）。
 *
 * 【收進回收桶】跟其他「刪-…進回收桶」同一招：整列存進 trash，可以到回收桶復原。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════════════════ */

begin;

create temp table _del_result (order_id uuid, item text, amount numeric, n_pay int);

do $do$
declare
  n     int;
  r     public.orders;
  kids  jsonb := '[]'::jsonb;
  pays  jsonb;
  n_pay int := 0;
  n_del int;
begin
  select count(*) into n
    from public.orders o
   where btrim(o.property_raw) = '10A5'
     and btrim(o.guest_name) = '京饌企業有限公司'
     and o.amount = 900
     and o.source = 'oneoff'
     and (coalesce(o.fee_type, '') like '%稅費%' or coalesce(o.item_name, '') like '%稅費%')
     and o.checkin >= '2026-10-01' and o.checkin <= '2026-10-31';
  if n <> 1 then
    raise exception '預期剛好 1 筆（10A5／京饌／+900／稅費／2026-10），實際 % 筆 —— 整支停下來，一列都沒動', n;
  end if;

  select o.* into r
    from public.orders o
   where btrim(o.property_raw) = '10A5'
     and btrim(o.guest_name) = '京饌企業有限公司'
     and o.amount = 900
     and o.source = 'oneoff'
     and (coalesce(o.fee_type, '') like '%稅費%' or coalesce(o.item_name, '') like '%稅費%')
     and o.checkin >= '2026-10-01' and o.checkin <= '2026-10-31';

  if to_regclass('public.order_payments') is not null then
    select jsonb_agg(to_jsonb(t)), count(*) into pays, n_pay from public.order_payments t where t.order_id = r.id;
    if pays is not null then
      kids := kids || jsonb_build_array(jsonb_build_object('table', 'order_payments', 'rows', pays));
    end if;
  end if;

  insert into public.trash (table_name, record_id, label, payload, children, child_count, reason, deleted_by)
  values ('orders', r.id,
          '10A5 京饌企業有限公司 其他收入・稅費 $900（2026-10）',
          to_jsonb(r), kids, n_pay,
          '重複（2026-10-20 David）：900 已記在折讓退款的扣除（實退 17,100）',
          null);

  if n_pay > 0 then delete from public.order_payments where order_id = r.id; end if;
  delete from public.orders where id = r.id;
  get diagnostics n_del = row_count;
  if n_del <> 1 then
    raise exception '刪除影響 % 列（預期 1）—— 整支退回', n_del;
  end if;

  insert into _del_result values (r.id, coalesce(r.fee_type, '') || '・' || coalesce(r.item_name, ''), r.amount, n_pay);
end
$do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '這次收進回收桶的' as 檢查,
       (select item || ' $' || to_char(amount, 'FM999,990') || '・收款紀錄 ' || n_pay || ' 筆' from _del_result) as 結果,
       '✅' as 判定
union all
select 2, '回收桶裡找得到',
       coalesce((select '有' from public.trash where table_name = 'orders'
                  and record_id = (select order_id from _del_result) and restored_at is null limit 1), '沒有'),
       case when exists (select 1 from public.trash where table_name = 'orders'
                  and record_id = (select order_id from _del_result) and restored_at is null) then '✅' else '❌' end
union all
select 3, '10A5 京饌 10 月的折讓還在（−18,000）',
       (select count(*) from public.orders where btrim(property_raw) = '10A5' and fee_type = '折讓'
          and amount = -18000 and checkin >= '2026-10-01' and checkin <= '2026-10-31')::text || ' 筆',
       case when exists (select 1 from public.orders where btrim(property_raw) = '10A5' and fee_type = '折讓'
          and amount = -18000 and checkin >= '2026-10-01' and checkin <= '2026-10-31') then '✅' else '⚠ 對一下' end
order by 1;
