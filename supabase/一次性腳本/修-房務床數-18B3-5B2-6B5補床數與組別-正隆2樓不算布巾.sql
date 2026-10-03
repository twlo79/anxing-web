/* 修：房務布巾統計「其他（未列於三表）」那四列                                     2026-10-03
 *
 * 【為什麼】9/30 加進房務主檔（hk_property）的 18B3／5B2／6B5／正隆2樓：
 *   · 組別一律給了 other、床數留空 → 布巾統計把它們丟進「其他」並標「待補床數」
 *   · 但床數在 ERP 房源主檔（房源設定）早就填了（18B3 3 床、5B2 4 床⋯）—— 兩個地方各存一份，房務那份沒跟上
 *   · 正隆2樓、時兆公區、開封公區是公區，沒有床（David：「正隆 2 樓沒有床，不用」「這也不用放進來」）
 *
 * 【做什麼】
 *   ① 所有公區（ptype = common_area）：不算布巾、床數 0 → 布巾統計不再列
 *   ② 房務主檔床數是空的、而對到的 ERP 房源有床數 → 抄過來（不只這三間，所有空的都補；有值的一列都不碰）
 *   ③ 組別是 other 的那三間：改成「同一個物業的其他房間」最多人用的那個組別（時兆／正隆／開封系）
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
create temp table if not exists _chg (code text, what text) on commit preserve rows;

begin;
delete from _chg;

-- 三間沒接到 ERP 房源的，用同名接上（剛好一筆才接）
update public.hk_property h
   set property_id = (select min(p.id::text)::uuid from public.properties p
                       where p.active and (p.name = h.code or h.code = any(coalesce(p.name_aliases, '{}')))
                      having count(*) = 1)
 where h.code in ('18B3', '5B2', '6B5') and h.property_id is null;

-- ① 公區一律不算布巾（正隆2樓、時兆公區、開封公區⋯ 沒有床）
--   David 2026-10-03：「正隆 2 樓沒有床，不用」、時兆公區／開封公區「這也不用放進來」
with u as (
  update public.hk_property set count_linen = false, beds = 0
   where (ptype = 'common_area' or code = '正隆2樓') and (count_linen or beds is distinct from 0)
  returning code)
insert into _chg select code, '公區：不算布巾、床數 0' from u;

-- ② 床數從 ERP 房源抄過來（只補空的）
with u as (
  update public.hk_property h set beds = p.beds
    from public.properties p
   where p.id = h.property_id and h.beds is null and p.beds is not null
  returning h.code, p.beds)
insert into _chg select code, '床數 ← ' || beds from u;

-- ③ 組別：同物業其他房間最多人用的
with tgt as (
  select h.id, h.code, p.estate_id from public.hk_property h join public.properties p on p.id = h.property_id
   where h.code in ('18B3', '5B2', '6B5') and h.linen_group = 'other'
),
grp as (
  select t.id, t.code,
         (select h2.linen_group from public.hk_property h2 join public.properties p2 on p2.id = h2.property_id
           where p2.estate_id = t.estate_id and h2.linen_group <> 'other' and h2.id <> t.id
           group by h2.linen_group order by count(*) desc limit 1) as g
    from tgt t
),
u as (
  update public.hk_property h set linen_group = grp.g from grp
   where h.id = grp.id and grp.g is not null
  returning h.code, h.linen_group)
insert into _chg select code, '組別 → ' || linen_group from u;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '這次改了什麼' as 檢查,
       coalesce((select string_agg(code || '：' || what, '；' order by code) from _chg), '（沒有要改的 —— 跑過了）') as 結果
union all
select 2, '那四間現在的樣子（公區另見第 4 列）',
       (select string_agg(h.code || ' 組別 ' || h.linen_group || '・床數 ' || coalesce(h.beds::text, '空') || '・'
                          || case when h.count_linen then '算布巾' else '不算布巾' end
                          || '・ERP ' || coalesce(p.name, '沒接'), '；' order by h.sort)
          from public.hk_property h left join public.properties p on p.id = h.property_id
         where h.code in ('18B3', '5B2', '6B5', '正隆2樓'))
union all
select 3, '還是「待補床數」的（算布巾、床數空）',
       coalesce((select string_agg(h.code || case when h.property_id is null then '（沒接 ERP）' else '（ERP 也沒填）' end, '、' order by h.sort)
                   from public.hk_property h where h.active and h.count_linen and h.beds is null), '沒有 ✅')
union all
select 4, '公區（應該全部「不算布巾」）',
       coalesce((select string_agg(code || case when count_linen then ' ❌ 還在算' else ' ✅' end, '、' order by sort)
                   from public.hk_property where ptype = 'common_area' or code = '正隆2樓'), '（沒有公區）')
order by 1;
