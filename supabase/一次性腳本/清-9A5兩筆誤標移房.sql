/*
 * 一次性：9A5 兩筆訂單拿掉「移房」標記（2026-10-07 David：「都是 9A5 沒移房」）
 *
 *   2026-09-19 ~ 10-04　移房鏈 4B3>9A5
 *   2026-10-04 ~ 10-18　移房鏈 4B5>9A5
 *
 *   這兩筆是房號原本填成 4B3／4B5，後來用「移房」視窗改成 9A5 ——
 *   移房視窗把「改房號」也當成一次移房，於是記了移房鏈、備註多一行「移房 4B?>9A5」。
 *
 * 這支只做兩件事：
 *   ① move_chain 清成 null（列表上的「移房」標籤與「4B5>9A5」那行就不見了）
 *   ② 備註裡系統加的那一行「移房 4B?>9A5」拿掉，其他字一個都不動
 *   房號、日期、金額、收款都不動。
 *
 * ★ 只認這兩筆：房號 9A5、入住日與移房鏈都對得上、沒有拆段（move_group 是空的）。
 *   對不上的不動；超過 2 筆就整支停下來。
 * ★ 跑第二次：找不到要改的 → 什麼都不動。
 */

begin;

do $do$
declare n int;
begin
  select count(*) into n from public.orders
   where property_raw = '9A5' and move_group is null
     and ((checkin = '2026-09-19' and move_chain = '4B3>9A5')
       or (checkin = '2026-10-04' and move_chain = '4B5>9A5'));
  if n > 2 then
    raise exception '符合的訂單有 % 筆（應該最多 2 筆），停下來不動', n;
  end if;

  update public.orders o
     set move_chain = null,
         note = nullif(btrim(regexp_replace(coalesce(o.note, ''),
                  '(^|\n)移房 ' || o.move_chain || '(?=\n|$)', '', 'g'), E'\n '), '')
   where o.property_raw = '9A5' and o.move_group is null
     and ((o.checkin = '2026-09-19' and o.move_chain = '4B3>9A5')
       or (o.checkin = '2026-10-04' and o.move_chain = '4B5>9A5'));
  get diagnostics n = row_count;
  raise notice '拿掉移房標記：% 筆', n;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select checkin as 入住, checkout as 退房, property_raw as 房源,
       coalesce(move_chain, '（沒有）') as 移房鏈,
       case when coalesce(note, '') ~ '移房 4B[35]>9A5' then '❌ 還在' else '✅ 沒了' end as 備註裡的移房行
  from public.orders
 where property_raw = '9A5' and checkin in ('2026-09-19', '2026-10-04')
 order by checkin;
