/*
 * migration_205 —— 「時兆二樓」併進「時兆公區」
 * ============================================================
 * 2026-09-02 使用者：「時兆二樓是時兆公區」
 *
 * ============================================================
 * 【★★ 為什麼不能用「對應」解決】
 *
 * 兩個房務代碼指向**同一個** ERP 房源是不行的 ——
 * 設定頁的下拉會把已經被別人對應的選項鎖起來
 * （`housekeeping/settings/page.tsx:334` 的 `disabled`）。
 *
 * 那個鎖是對的:一個 ERP 房源被兩個代碼對應的話，
 * 床單與點數會算兩次，而總數看起來只是「多了一點」。
 *
 * ★ 所以正解是**讓它們合成一個**:把工作項目改指到「時兆公區」，
 *   「時兆二樓」變成它的別名，那一列停用。
 *
 * ============================================================
 * 【★★★ 別名解決不了已經存在的資料】
 *
 * `hk_property.aliases` 只影響**匯入當下怎麼解析**
 * （`hk_event.parsed_code` 是那時候算好存進去的）。
 * 加了別名之後，已經存在的 `hk_work_item.property_code = '時兆二樓'`
 * 一個字都不會變 —— 而停用主檔那一列之後，它會從
 * 「未歸物業・沒接上 ERP」變成「未歸物業・主檔沒有」，
 * **數字完全沒動，只是原因換了一個**。
 *
 * ★ 所以這支要真的去改那幾筆的 property_code。
 *
 * ============================================================
 * 【這支不猜「還有哪些是同一個地方」】
 *
 * 「時兆二樓 = 時兆公區」是使用者才知道的事，SQL 看不出來。
 * 所以檔尾第 ⑤ 段只**列出剩下還沒歸位的代碼與筆數**給人看，
 * 不自動合併任何東西（CLAUDE.md:「建議，不自動」）。
 */

-- ══════════════════════════════════════════════════════════
-- ① 先數，數字進自檢表
-- ══════════════════════════════════════════════════════════
create temp table _chk205 (item text, val text) on commit drop;

insert into _chk205
select '① 改之前：property_code = 時兆二樓',
       coalesce((select count(*)::text || ' 筆工作項目（'
                        || string_agg(distinct period, '、' order by period) || '）'
                   from public.hk_work_item where property_code = '時兆二樓'),
                '（沒有）');

insert into _chk205
select '① 改之前：parsed_code = 時兆二樓',
       (select count(*)::text || ' 筆行事曆事件'
          from public.hk_event where parsed_code = '時兆二樓');


-- ══════════════════════════════════════════════════════════
-- ② 目標代碼要先存在，不然改過去等於改到一個不存在的地方
-- ══════════════════════════════════════════════════════════
do $do$ begin
  if not exists (select 1 from public.hk_property where code = '時兆公區') then
    raise exception '房務主檔沒有「時兆公區」—— 中止，什麼都沒改';
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- ③ 改指過去
-- ══════════════════════════════════════════════════════════
/*
 * ★ 兩張表都要改:
 *     hk_work_item.property_code  排班表那一格顯示什麼、點數算哪一間
 *     hk_event.parsed_code        事件對到哪個房源（例外清單看這個）
 *   只改一張的話，例外清單與排班表會對同一天給出不同答案。
 */
update public.hk_work_item set property_code = '時兆公區'
 where property_code = '時兆二樓';

update public.hk_event set parsed_code = '時兆公區'
 where parsed_code = '時兆二樓';


-- ══════════════════════════════════════════════════════════
-- ④ 別名 ＋ 停用舊代碼
-- ══════════════════════════════════════════════════════════
/*
 * 別名是給**以後**用的:行事曆上再寫「時兆二樓」時，
 * 匯入就會直接解析到時兆公區，不用再補一次。
 *
 * ★ 用 `array_append` 前先檢查，重跑不會變成兩個一樣的別名。
 */
update public.hk_property
   set aliases = array_append(coalesce(aliases, '{}'), '時兆二樓')
 where code = '時兆公區'
   and not ('時兆二樓' = any(coalesce(aliases, '{}')));

/*
 * ★★ **停用不刪除**。刪掉的話，三個月後有人問「時兆二樓那些工作去哪了」，
 *   查不到任何痕跡。停用的那一列還在，而且設定頁會用淡色顯示。
 */
update public.hk_property set active = false
 where code = '時兆二樓';


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('205_hk_merge_code');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了幾筆:第 ② 列問的是「還剩幾筆」，
--   正確答案永遠是 0（CLAUDE.md）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① 改之前的狀況',
         (select string_agg(item || '　' || val, E'\n') from _chk205),
         '★ 這是跑之前的數字，留著對照'

  union all
  select 2, '★★★ ② 沒有任何一筆還指著「時兆二樓」',
         (select case when a + b = 0 then '✅ 都改完了'
                      else '⚠⚠⚠ 還剩 ' || (a + b)::text || ' 筆' end
            from (select (select count(*) from public.hk_work_item where property_code = '時兆二樓') a,
                         (select count(*) from public.hk_event where parsed_code = '時兆二樓') b) z),
         '★ 兩張表都要改。只改一張的話，例外清單與排班表會對同一天給出不同答案'

  union all
  select 3, '★★ ③ 時兆公區接上 ERP 了嗎',
         (select case when hp.property_id is null
                      then '⚠⚠ 還沒對應 —— 去設定頁把它對到 ERP 的「時兆公區」，'
                           || '不然這些工作還是歸不了物業、也算不出點數'
                      else '✅ 已對應 ' || coalesce(pr.name, '?')
                           || '（' || coalesce(e.name, '無物業') || '）・點數 '
                           || coalesce(pr.clean_points::text, '⚠ 未設')
                           || '・床數 ' || coalesce(pr.beds::text, '⚠ 未填') end
            from public.hk_property hp
            left join public.properties pr on pr.id = hp.property_id
            left join public.estates e on e.id = pr.estate_id
           where hp.code = '時兆公區'),
         '★★★ 這一步**這支 migration 做不到** —— 對應是在設定頁點的。'
           || '這裡只是提醒你還沒做'

  union all
  select 4, '④ 別名與停用',
         (select '時兆公區的別名：' || array_to_string(coalesce(hp.aliases, '{}'), '、')
                 || E'\n時兆二樓：'
                 || coalesce((select case when active then '⚠ 還啟用著' else '✅ 已停用' end
                                from public.hk_property where code = '時兆二樓'), '（已不存在）')
            from public.hk_property hp where hp.code = '時兆公區'),
         '★ 別名是給以後匯入用的。停用不刪除 —— 刪了就查不到那些工作原本叫什麼'

  union all
  select 5, '★★ ⑤ 還沒歸位的房務代碼（**這支不自動處理**）',
         (select coalesce(string_agg(
                   hp.code || '：' || cnt::text || ' 筆'
                   || case when hp.property_id is null then '（沒接上 ERP）' else '' end,
                   E'\n' order by cnt desc, hp.code), '✅ 沒有了')
            from public.hk_property hp
            join lateral (select count(*) cnt from public.hk_work_item w
                           where w.property_code = hp.code) c on true
           where hp.active and hp.property_id is null and c.cnt > 0),
         '★★★ 「哪兩個代碼其實是同一個地方」只有你知道，SQL 看不出來 —— '
           || '所以這裡只列出來，不自動合併（CLAUDE.md:「建議，不自動」）'

  union all
  select 6, '⑥ 工作項目總筆數沒變',
         (select count(*)::text || ' 筆' from public.hk_work_item),
         '★ 這支只改 property_code，不新增也不刪除任何一列'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
