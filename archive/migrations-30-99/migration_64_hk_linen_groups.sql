-- migration_64：房源歸入正確的布巾表
--
-- migration_58 建檔時，這幾個房源因為還沒確認歸屬，一律先丟進 other
-- （「其他（未列於三表）」）。現在確認了，歸位。
--
-- 順帶把第二張表的名稱從「A、B 系」改成「時兆」—— A1~A18 與 B1~B8
-- 全部都在時兆，用棟別命名比用房號範圍命名清楚，而且之後加新房號
-- 不用改標題。

update public.hk_property set linen_group = 'zl'
 where code in ('17B5', '18B5', '19B2', '6B2');

update public.hk_property set linen_group = 'kai'
 where code in ('JPR整棟', '台2');

update public.hk_property set linen_group = 'ab'
 where code = '時兆二樓';


-- ============================================================
-- 驗證
-- ============================================================

-- 各組的房源數與待補幾床的數量
select linen_group,
       count(*) as 房源數,
       count(*) filter (where beds is null) as 待補幾床,
       string_agg(code, '、' order by sort) filter (where beds is null) as 待補清單
from public.hk_property
where active
group by linen_group
order by case linen_group when 'kai' then 1 when 'ab' then 2 when 'zl' then 3 else 4 end;

-- other 現在應該只剩 J1、J2、台S
select code, beds, linen_group
from public.hk_property
where linen_group = 'other' and active
order by sort;
