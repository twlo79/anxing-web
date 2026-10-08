/*
 * migration_327_purpose_fix.sql　2026-10-08
 * 這幾筆不該算「安幸辦公室」—— 改回算物業
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *
 * 【使用者 2026-10-08】查-哪些單掛在安幸辦公室.sql 的結果，勾了這三組要改回物業：
 *     · 時兆 2F-2 美商炒飯吧（契約上勾的：管理費、水電瓦斯、水費，連月租一起）
 *     · 正隆 18B5 申洸（契約上勾的：2026-10 起的月租）
 *     · 正隆私下 Jim友（13A5、14B5、18B3）＋ Yumi妹（9A5）（訂單自己勾的）
 *   房務清潔、人事費、時兆四項定期收費 —— 本來就是安幸的，不動。
 *
 * 【這一支做的事】
 *   ① 規則改一條：只有「公司登記」一定算安幸辦公室；
 *      「辦公室」類的契約**預設**勾著，但可以取消（2F-2 就是辦公室租約、租金算時兆）
 *      ★ 畫面那份規則在 src/lib/purpose.ts，兩邊一起改了
 *   ② 兩張契約改回 estate —— 觸發器（migration_247 ⑥）會把底下的月租單、加費、認列一起帶回去
 *   ③ 五筆私下訂單改回 estate
 *
 * ★ 改的只有「這筆錢算誰的」：物業、房源、金額、收款都不動。
 * ★ 已關帳月份的訂單：關帳守衛會把變更放進「待處理」，不會直接改（自檢會看到還剩幾筆）。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 規則：只有公司登記鎖死 ══════
create or replace function public.contract_purpose_normalize()
returns trigger
language plpgsql
as $fn$
begin
  -- 公司登記一定是安幸自己的生意
  if new.type = 'company' then new.purpose_type := 'office'; end if;
  -- 沒填的時候：辦公室預設 office（可以取消），其他預設 estate（migration_327）
  if new.purpose_type is null then
    new.purpose_type := case when new.type = 'office' then 'office' else 'estate' end;
  end if;
  return new;
end $fn$;

comment on function public.contract_purpose_normalize() is
  '公司登記的契約一律 purpose_type = office（migration_247）；'
  '辦公室類 migration_327 起改成「沒填預設 office、可以取消」—— 時兆 2F-2 辦公室租約算時兆。'
  '★ 畫面那份在 src/lib/purpose.ts，兩邊要一樣。';

-- ══════ ② 兩張契約 ══════
do $do$
declare n int; v_ids uuid[];
begin
  select array_agg(c.id) into v_ids
    from public.contracts c join public.estates e on e.id = c.estate_id
   where (e.name = '時兆' and c.room = '2F-2' and c.tenant_name like '美商炒飯吧%')
      or (e.name = '正隆' and c.room = '18B5' and c.tenant_name like '申洸%');
  n := coalesce(cardinality(v_ids), 0);
  if n <> 2 then
    raise exception '契約應該剛好 2 張（時兆 2F-2 美商炒飯吧、正隆 18B5 申洸），找到 % 張 —— 整支停下來沒有改任何東西', n;
  end if;
  update public.contracts set purpose_type = 'estate' where id = any(v_ids) and purpose_type is distinct from 'estate';
end $do$;

-- ══════ ③ 五筆私下訂單 ══════
do $do$
declare n int;
begin
  select count(*) into n
    from public.orders o join public.estates e on e.id = o.estate_id
   where o.purpose_type = 'office' and o.source = 'private' and o.contract_id is null
     and e.name = '正隆' and o.guest_name in ('Jim友', 'Yumi妹');
  if n > 5 then
    raise exception '正隆私下 Jim友／Yumi妹 掛安幸辦公室的有 % 筆（應該最多 5 筆）—— 整支停下來沒有改任何東西', n;
  end if;
  update public.orders o
     set purpose_type = 'estate'
    from public.estates e
   where e.id = o.estate_id
     and o.purpose_type = 'office' and o.source = 'private' and o.contract_id is null
     and e.name = '正隆' and o.guest_name in ('Jim友', 'Yumi妹');
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('327_purpose_fix');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select x.組 as 檢查,
       count(*) filter (where x.pt = 'office') as 還算安幸辦公室,
       count(*) filter (where x.pt = 'estate') as 已改回物業,
       case when count(*) filter (where x.pt = 'office') = 0 then '✅'
            else '⚠ 還有（多半是已關帳月份，變更在待處理清單）' end as 判定
  from (
    select case when e.name = '時兆' then '時兆 2F-2 美商炒飯吧（含月租）' else '正隆 18B5 申洸' end as 組, o.purpose_type as pt
      from public.orders o join public.contracts c on c.id = o.contract_id join public.estates e on e.id = c.estate_id
     where (e.name = '時兆' and c.room = '2F-2' and c.tenant_name like '美商炒飯吧%')
        or (e.name = '正隆' and c.room = '18B5' and c.tenant_name like '申洸%')
    union all
    select '正隆私下 Jim友＋Yumi妹', o.purpose_type
      from public.orders o join public.estates e on e.id = o.estate_id
     where o.source = 'private' and e.name = '正隆' and o.guest_name in ('Jim友', 'Yumi妹')
  ) x
 group by x.組
union all
select '契約本身（2 張都要是 estate）',
       count(*) filter (where c.purpose_type = 'office'), count(*) filter (where c.purpose_type = 'estate'),
       case when count(*) filter (where c.purpose_type = 'estate') = 2 then '✅' else '❌' end
  from public.contracts c join public.estates e on e.id = c.estate_id
 where (e.name = '時兆' and c.room = '2F-2' and c.tenant_name like '美商炒飯吧%')
    or (e.name = '正隆' and c.room = '18B5' and c.tenant_name like '申洸%')
order by 1;
