/*
 * migration_207 —— JPR整棟 單價 5000；亞曼尼→804、開3→開封3F
 * ============================================================
 * 2026-09-02 使用者看完產生預覽後指定：
 *
 *   JPR整棟 > 5000
 *   亞曼尼  > ERP 804
 *   開3     > ERP 開封3F
 *
 * ★ 後兩個是**房務代碼對應 ERP 房源**（`hk_property.property_id`）。
 *   設定頁點得到，寫成 migration 是因為名字對不起來（亞曼尼 vs 804），
 *   下拉裡要自己找 —— 而且寫成 migration 才留得下「為什麼是這樣對」。
 *
 * ============================================================
 * 【★★ 對應之後會發生什麼】
 *
 *   亞曼尼 → 804      804 的單價已經是 800（migration_206 種的）
 *   開3    → 開封3F   開封3F 的單價已經是 2500
 *
 * 所以這三筆下次按「產生本月支出」就會有錢了。
 * ★ 而且它們的**打掃點數**也會跟著算得出來（同一條橋）——
 *   卡片上的「⚠ N 筆未計」會少掉。
 *
 * ============================================================
 * 【★★★ 一個 ERP 房源只能被一個房務代碼對應】
 *
 * 設定頁的下拉會把已被對應的選項鎖起來（`settings/page.tsx:334`）。
 * 那個鎖是對的:一個 ERP 房源被兩個代碼對應的話，
 * 床單與點數會算兩次，而總數看起來只是「多了一點」。
 *
 * ★ 資料庫沒有這條約束，所以下面每一個對應**都先檢查有沒有被佔用**，
 *   被佔用就中止 —— 不覆蓋別人的對應。
 */

-- ══════════════════════════════════════════════════════════
-- ① JPR整棟 的清潔費
-- ══════════════════════════════════════════════════════════
/*
 * ★ 不加 `where clean_price is null` —— 這次是使用者**指定**要設成 5000，
 *   不是種子。已經有別的值也要蓋過去。
 */
do $do$
declare n int;
 begin
  update public.properties set clean_price = 5000 where name = 'JPR整棟';
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'ERP 找不到房源「JPR整棟」—— 中止，什麼都沒改';
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ② 房務代碼 → ERP 房源
-- ══════════════════════════════════════════════════════════
do $do$
declare
  v_pairs constant text[][] := array[
    array['亞曼尼', '804'],
    array['開3',   '開封3F']
  ];
  v_hk text; v_erp text; v_pid uuid; v_taken text;
 begin
  for i in 1 .. array_length(v_pairs, 1) loop
    v_hk  := v_pairs[i][1];
    v_erp := v_pairs[i][2];

    -- 房務代碼要存在
    if not exists (select 1 from public.hk_property where code = v_hk) then
      raise exception '房務主檔沒有「%」—— 中止', v_hk;
    end if;

    -- ERP 房源要存在而且唯一（同名兩間的話對哪一間是不確定的）
    select p.id into v_pid from public.properties p where p.name = v_erp and p.active;
    if v_pid is null then
      raise exception 'ERP 找不到啟用中的房源「%」—— 中止', v_erp;
    end if;
    if (select count(*) from public.properties p where p.name = v_erp and p.active) > 1 then
      raise exception 'ERP 有兩個以上叫「%」的房源 —— 中止，我不猜是哪一間', v_erp;
    end if;

    /*
     * ★★★ 已經被別的房務代碼對應就中止。
     *   覆蓋的話那個代碼會變成沒對應，而它的工作量會安靜地掉出物業統計。
     */
    select code into v_taken from public.hk_property
     where property_id = v_pid and code <> v_hk;
    if v_taken is not null then
      raise exception 'ERP 房源「%」已經被房務代碼「%」對應了 —— 中止', v_erp, v_taken;
    end if;

    update public.hk_property set property_id = v_pid where code = v_hk;
  end loop;
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('207_hk_link_price');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① JPR整棟 的清潔費',
         (select coalesce(clean_price::text, '⚠ 還是 null')
            from public.properties where name = 'JPR整棟'),
         '★ 要看到 5000'

  union all
  select 2, '★★★ ② 兩個對應都接上了',
         (select string_agg(
                   hp.code || ' → ' || coalesce(pr.name, '⚠ 還沒對應')
                   || case when pr.id is null then ''
                           else '（單價 ' || coalesce(pr.clean_price::text, '未設')
                                || '・點數 ' || coalesce(pr.clean_points::text, '未設') || '）' end,
                   E'\n' order by hp.code)
            from public.hk_property hp
            left join public.properties pr on pr.id = hp.property_id
           where hp.code in ('亞曼尼', '開3')),
         '★ 亞曼尼 → 804（單價 800）、開3 → 開封3F（單價 2500）。'
           || '★★ 點數也會跟著算得出來 —— 走的是同一條橋'

  union all
  select 3, '★★ ③ 沒有一個 ERP 房源被兩個代碼對應',
         (select case when count(*) = 0 then '✅ 沒有重複'
                      else '⚠⚠⚠ ' || string_agg(x.line, '、') end
            from (select pr.name || ' 被 ' || string_agg(hp.code, '＋') || ' 同時對應' as line
                    from public.hk_property hp
                    join public.properties pr on pr.id = hp.property_id
                   where hp.active
                   group by pr.id, pr.name
                  having count(*) > 1) x),
         '★★★ 一個 ERP 房源被兩個代碼對應的話，床單與點數會算兩次，'
           || '而總數看起來只是「多了一點」'

  union all
  select 4, '★★ ④ 八月還有幾份工算不出錢',
         (select coalesce(string_agg(x.line, E'\n' order by x.n desc, x.nm), '✅ 沒有了')
            from (
              select coalesce(pr.name, w.property_code, '（沒填房源）') as nm,
                     count(distinct (w.work_date, w.work_type)) as n,
                     coalesce(pr.name, w.property_code, '（沒填房源）')
                       || '：' || count(distinct (w.work_date, w.work_type))::text || ' 份・'
                       || case when hp.code is null then '主檔沒有這個代碼'
                               when hp.property_id is null then '沒接上 ERP'
                               when pr.clean_price is null then '沒設單價'
                               else '?' end as line
                from public.hk_work_item w
                left join public.hk_property hp on hp.code = w.property_code
                left join public.properties  pr on pr.id = hp.property_id
               where w.period = '202608'
                 and w.staff_id is not null
                 and w.work_type <> '贈品補充'
                 and (hp.property_id is null or pr.clean_price is null)
               group by pr.name, w.property_code, hp.code, hp.property_id, pr.clean_price
            ) x),
         '★ 這是下次按「產生本月支出」時，預覽裡「算不出錢」那一區會列的東西。'
           || '★★ 時兆公區還沒對應（13 筆，最大宗）—— 那個要你去設定頁點'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
