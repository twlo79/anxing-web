-- migration_123：房源的打掃點數（難度係數）
--
-- ============================================================
-- 【要解決什麼】
--
-- 打掃報酬不能只看間數。開封4F 四層樓爬上爬下，跟 A5 一間套房，
-- 掃一間的力氣差好幾倍 —— 用同一個「1 間」去算薪水，
-- 願意去掃開封的人會愈來愈少，而排班表上看不出這件事正在發生。
--
-- 所以每個房源帶一個**打掃點數**：
--
--     報酬點數 ＝ 打掃量 × 該房源的打掃點數
--
-- 打掃量兩人合掃各 0.5，所以點數也自動對半 —— 那是對的：
-- 兩個人分一份工，也分那份工的難度。
--
--
-- ============================================================
-- 【為什麼掛在房源，不掛在人】
--
-- 難度是房子的性質，不是人的。誰去掃開封4F 都一樣爬四層。
--
-- 掛在人身上的話，每換一個人負責就要重設一次 —— 而漏設的那次
-- 不會報錯，只會讓那個月的報酬少一截，然後那個人自己來問。
--
--
-- ============================================================
-- 【回填只填「規則講得明白的」，其餘留空】（使用者給的規則）
--
--     804        2        時兆所有   1
--     台視1+2    2        台視4      1
--     正隆（全部）3
--     開封4F     4        開封3F     3
--     開封2-1    3        開封2-2    2
--
-- 名稱對不上的**留 null，不猜**。猜錯的話那個人的薪水就是錯的，
-- 而錯的方向是少發 —— 他會來問，但要對完整個月才講得出哪裡不對。
--
-- 自檢最後會列出「還沒設點數的房源」，到「權限管理 → 房源管理」補。

alter table public.properties
  add column if not exists clean_points numeric(4,1);

comment on column public.properties.clean_points is
  '打掃點數（難度係數）。報酬點數 ＝ 打掃量 × 這個值。'
  'null = 還沒設 —— 那個房源的工作算不出報酬,而不是算成 0。';


-- ── 回填 ───────────────────────────────────────────
--
-- 逐條對，順序由細到粗：先處理指名道姓的，再處理整個物業的。
-- 反過來的話「開封4F」會先被「開封整棟系 = 某個值」蓋掉。
do $$
declare
  v_n int;
begin
  -- 1. 指名道姓的（開封那一組）
  update public.properties set clean_points = 4 where name = '開封4F'  and clean_points is null;
  update public.properties set clean_points = 3 where name = '開封3F'  and clean_points is null;
  update public.properties set clean_points = 3 where name = '開封2-1' and clean_points is null;
  update public.properties set clean_points = 2 where name = '開封2-2' and clean_points is null;

  -- 2. 804（可能寫成「804」或「亞曼尼804」之類，用包含比對）
  update public.properties set clean_points = 2
   where name like '%804%' and clean_points is null;

  -- 3. 台視：1+2 是 2 點，4 是 1 點
  update public.properties set clean_points = 2
   where clean_points is null
     and (name like '台視1%' or name like '台1%' or name like '%台視1+2%' or name like '%台1+2%');
  update public.properties set clean_points = 1
   where clean_points is null
     and (name like '台視4%' or name like '台4%');

  -- 4. 正隆全部 3 點（靠物業名，不靠房源名 —— 房源叫「4B2」看不出是正隆）
  update public.properties p set clean_points = 3
    from public.estates e
   where e.id = p.estate_id and e.name like '%正隆%' and p.clean_points is null;

  -- 5. 時兆全部 1 點
  update public.properties p set clean_points = 1
    from public.estates e
   where e.id = p.estate_id and e.name like '%時兆%' and p.clean_points is null;

  select count(*) into v_n from public.properties where clean_points is not null;
  raise notice '已填 % 間', v_n;   -- 看不到,真正的報告在下面的自檢表
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('123_clean_points');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk123;
  create temp table _chk123 (ord int, item text, result text, detail text);

  insert into _chk123 values (1, 'clean_points 欄位',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'properties'
                        and column_name = 'clean_points')
         then '✅' else '❌' end, '');

  -- 規則講明的那幾間有沒有對到
  insert into _chk123
  select 2, '★ ' || name, coalesce(clean_points::text, '❌ 沒對到'), ''
    from public.properties
   where name in ('開封4F', '開封3F', '開封2-1', '開封2-2');

  select count(*) into n from public.properties p join public.estates e on e.id = p.estate_id
   where e.name like '%正隆%' and p.clean_points = 3;
  insert into _chk123 values (3, '正隆（都算 3）', n || ' 間', '');

  select count(*) into n from public.properties p join public.estates e on e.id = p.estate_id
   where e.name like '%時兆%' and p.clean_points = 1;
  insert into _chk123 values (3, '時兆（都算 1）', n || ' 間', '');

  select count(*) into n from public.properties where name like '%804%' and clean_points = 2;
  insert into _chk123 values (3, '804（2 點）', n || ' 間',
    case when n = 0 then '⚠ 找不到名稱含 804 的房源 —— 那可能叫別的名字,要手動填' else '' end);

  select count(*) into n from public.properties
   where clean_points is not null and (name like '台%');
  insert into _chk123 values (3, '台視系列', n || ' 間',
    '1+2 給 2 點、4 給 1 點。名稱寫法不一定對得上,下面沒填的清單要看一下');

  /*
   * 還沒設的。這才是要行動的清單。
   *
   * 不自動猜一個值填進去 —— 猜錯的方向是少發薪水，
   * 而那個人要對完整個月才講得出哪裡不對。
   */
  select count(*) into n from public.properties where clean_points is null and active;
  insert into _chk123 values (9, '★★ 還沒設打掃點數的房源',
    case when n = 0 then '✅ 都有了' else '⚠ ' || n || ' 間' end,
    case when n = 0 then ''
         else (select string_agg(name, '、' order by name)
                 from public.properties where clean_points is null and active)
              || ' —— 到「權限管理 → 房源管理」填。沒填的話那幾間算不出報酬' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk123 order by ord, item;
