/* ══════════════════════════════════════════════════════════════════════
 * 房務房源主檔：加 18B3、5B2、6B5、正隆2樓；時兆公區加別名「時兆三樓儲藏室」     2026-09-30
 *
 * 【為什麼】9 月 TimeTree 匯入前對主檔，8 筆對不到房源。David 決定：
 *   1. 18B3 加一間  2. 5B2 加  3. 6B5 加  4. 正隆2樓 加（公區）  5. 時兆三樓儲藏室 算時兆公區
 *
 * 【做什麼】
 *   · hk_property 加 4 列（跑第二次不會重複：on conflict (code) do nothing）
 *   · 三間房若 ERP 的 properties 裡有同名房源就順手接上 property_id（打掃點數要靠它）；
 *     沒有就留空，自檢會列出來 —— 之後到「房務設定」再接
 *   · 時兆公區的 aliases 多一個「時兆三樓儲藏室」（已經有就不重複加）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 排在 A/B 那些房間後面：拿現在最大的 sort 往後接
with mx as (select coalesce(max(sort), 0) as s from public.hk_property)
insert into public.hk_property (code, name, aliases, ptype, linen_group, count_linen, active, sort, property_id)
select v.code, v.code, '{}'::text[], v.ptype, 'other', true, true, mx.s + v.n,
       -- 同名的 ERP 房源只有剛好一筆時才接（兩筆以上不猜）
       (select min(p.id::text)::uuid from public.properties p
         where p.active and (p.name = v.code or v.code = any(coalesce(p.name_aliases, '{}')))
         having count(*) = 1)
  from (values ('18B3', 'room', 1), ('5B2', 'room', 2), ('6B5', 'room', 3), ('正隆2樓', 'common_area', 4)) as v(code, ptype, n), mx
on conflict (code) do nothing;

update public.hk_property
   set aliases = array_append(aliases, '時兆三樓儲藏室')
 where code = '時兆公區' and not ('時兆三樓儲藏室' = any(aliases));

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '四間都在主檔了' as 檢查,
       (select string_agg(code || '（' || ptype || '）', '、' order by sort) from public.hk_property where code in ('18B3','5B2','6B5','正隆2樓')) as 結果,
       case when (select count(*) from public.hk_property where code in ('18B3','5B2','6B5','正隆2樓') and active) = 4 then '✅' else '❌' end as 判定
union all
select 2, '三間房有沒有接到 ERP 房源（打掃點數靠它）',
       (select string_agg(code || '→' || coalesce((select name from public.properties p where p.id = h.property_id), '沒接'), '、' order by sort)
          from public.hk_property h where code in ('18B3','5B2','6B5')),
       case when (select count(*) from public.hk_property where code in ('18B3','5B2','6B5') and property_id is not null) = 3
            then '✅' else 'ℹ 沒接的到「房務設定」把它對到 ERP 房源；沒接只影響打掃點數，間數照算' end
union all
select 3, '時兆公區的別名',
       (select array_to_string(aliases, '、') from public.hk_property where code = '時兆公區'),
       case when exists (select 1 from public.hk_property where code = '時兆公區' and '時兆三樓儲藏室' = any(aliases)) then '✅' else '❌' end
union all
select 4, '母體：主檔房源總數（之前 70）',
       (select count(*)::text from public.hk_property), 'ℹ 要是 74'
order by 1;
