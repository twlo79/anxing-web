/*
 * 一次性：B03 那一筆（Airbnb，列表顯示「移房 A13>B03」）其實不是移房 —— 把移房紀錄清掉（2026-10-14）
 *
 * 【David】「只是這一個不是移房，所以拿掉」
 *
 * 【這支做什麼】只動那一筆：
 *   · move_chain（「A13>B03」）→ 清空 —— 列表的「移房」標籤與 A13>B03 就不見了
 *   · 備註裡移房時自動加的那一行「移房 A13>B03」→ 拿掉，其他備註原封不動
 *   · 房源維持 B03，金額、日期、收款都不動
 *
 * 【擋門】
 *   · 找到的不是剛好 1 筆 → 停下來、什麼都不改
 *   · 那筆有 move_group（代表真的拆成兩段，另一段在別的房）→ 停下來，那種不能只清標籤
 *
 * ★ 訂單鎖住也沒關係：move_chain 與備註是鎖住時也能改的兩欄（migration_254）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */

begin;

do $do$
declare
  n   int;
  o   public.orders;
begin
  select count(*) into n from public.orders
   where move_chain = 'A13>B03' and property_raw = 'B03';
  if n = 0 then
    raise notice '沒有標著「移房 A13>B03」的 B03 訂單 —— 已經清過了，什麼都不用改';
    return;
  end if;
  if n <> 1 then
    raise exception '找到 % 筆「B03・移房 A13>B03」的訂單，不是剛好 1 筆 —— 什麼都沒改', n;
  end if;

  select * into o from public.orders
   where move_chain = 'A13>B03' and property_raw = 'B03';
  if o.move_group is not null then
    raise exception '這筆有 move_group（真的拆成好幾段）—— 不能只清標籤，什麼都沒改';
  end if;

  update public.orders
     set move_chain = null,
         note = nullif(btrim(regexp_replace(coalesce(note, ''), '\n?移房 A13>B03[^\n]*', '', 'g'), E' \n'), '')
   where id = o.id;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '還標著「移房 A13>B03」的 B03 訂單（應該 0）' as 項目,
       count(*)::text || ' 筆' as 結果,
       case when count(*) = 0 then '✅' else '❌' end as 判定
  from public.orders where move_chain = 'A13>B03' and property_raw = 'B03'
union all
select 2, '備註還有「移房 A13>B03」的 B03 訂單（應該 0）',
       count(*)::text || ' 筆',
       case when count(*) = 0 then '✅' else '❌' end
  from public.orders where property_raw = 'B03' and note like '%移房 A13>B03%'
order by 1;
