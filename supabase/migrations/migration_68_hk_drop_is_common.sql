-- migration_68：收斂 hk_property.is_common → ptype
--
-- 【問題】
-- 同一件事有兩個欄位在表達：
--   is_common = true      （migration_58 建的）
--   ptype     = 'common_area'（migration_59 建的，順便從 is_common 回填）
--
-- migration_59 之後，設定頁只編輯 ptype，is_common 再也沒有人寫。
-- 也沒有任何一行程式讀它來做判斷 —— 它只出現在 TS 的型別宣告裡。
--
-- 這種欄位的問題不是佔空間，是**下一個人不知道該信哪一個**。
-- 現在把公區改成一般房源，is_common 還是 true；誰照它寫新功能就會錯。
--
-- 【安全性】
-- drop 之前先驗證兩個欄位目前完全一致。不一致就中止 ——
-- 那代表有東西在我不知道的地方寫 is_common，得先查清楚。

do $$
declare bad int;
begin
  select count(*) into bad
  from public.hk_property
  where is_common <> (ptype = 'common_area');

  if bad > 0 then
    raise exception
      'is_common 與 ptype 有 % 筆不一致，先查清楚是誰在寫 is_common，不要直接刪欄位', bad;
  end if;

  raise notice '兩欄位一致，可以安全移除 is_common';
end $$;

alter table public.hk_property drop column if exists is_common;

comment on column public.hk_property.ptype is
  '房源類型:room 房間 / building 整棟 / common_area 公區 / other 其他。'
  '公區的唯一判斷來源（原本的 is_common 已於 migration_68 移除）。';


-- ============================================================
-- 驗證
-- ============================================================
select code, name, ptype, beds, linen_group, count_linen, active
from public.hk_property
where ptype <> 'room'
order by ptype, sort;
-- 預期:時兆公區 / 台視公區 / 開封公區 / 時兆二樓 是 common_area
--       開整棟 / JPR整棟 是 building

select ptype, count(*) from public.hk_property group by ptype order by 2 desc;


-- ── 記錄執行 ───────────────────────────────────────
-- 包在判斷裡，是因為建立 record_migration 的 migration_70 不一定先跑。
-- 順序不對只會少一筆紀錄，不該讓整支 migration 掛掉。
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('68_hk_drop_is_common'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
