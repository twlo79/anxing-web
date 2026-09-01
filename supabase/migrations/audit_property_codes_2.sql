/*
 * 房源代碼稽核（第二輪）—— 對到了，但兩邊名字不一樣
 * ============================================================
 * ★★★ 這支**只讀不寫**。
 *
 * 2026-09-01 使用者：「不對，是時兆的」
 *
 * 【第一輪漏掉了什麼】
 *
 * `audit_property_codes.sql` 檢查的六類全部是「**對不到**」:
 *   沒對到 ERP、孤兒代碼、ERP 有房務沒有⋯
 *
 * 而 `B4 → B04` 這種**改名**根本不會出現在那六類裡 ——
 * 它們早就對上了（`property_id` 有值），只是**顯示的名字不一樣**:
 *
 *     房務主檔顯示    B4
 *     ERP 房源顯示    B04
 *
 * ★★ 系統運作完全正常（靠 `property_id` 連著，不靠名字），
 *   但人看到的是兩個名字。報表拿房務的代碼、訂單拿 ERP 的名字 ——
 *   同一間房在兩張表上長得不一樣，而**沒有任何地方會報錯**。
 *
 * ★ 這一輪就是把那些列出來。
 */

create or replace function pg_temp.nk(s text) returns text language sql immutable as $$
  select upper(
           regexp_replace(
             regexp_replace(
               translate(coalesce(s, ''),
                 '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ',
                 '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'),
               '[[:space:]　]', '', 'g'),
             '(^|[^0-9])0+([0-9])', '\1\2', 'g')
         );
$$;

select v.ord as "#", v."項目", v."房務代碼", v."ERP 名稱", v."說明" from (

  -- ────────────────────────────────────────────────
  -- ★★★ ⑦ 已經對上了，但兩邊寫法不同（B4 ↔ B04）
  --     這才是「更名過」真正的樣子
  -- ────────────────────────────────────────────────
  select 7 as ord,
         '★★★ ⑦ 對上了但名字不一樣' as "項目",
         h.code as "房務代碼",
         p.name as "ERP 名稱",
         case
           when pg_temp.nk(h.code) = pg_temp.nk(p.name)
             then '只差補零／大小寫／空白 —— 改房務代碼成「' || p.name || '」是安全的'
           else '⚠ 不只是補零的差別，要人親自確認是不是同一間'
         end as "說明"
    from public.hk_property h
    join public.properties p on p.id = h.property_id
   where h.code <> p.name

  union all
  -- ────────────────────────────────────────────────
  -- ⑧ 改代碼會不會撞到別人（改之前一定要先看）
  -- ────────────────────────────────────────────────
  select 8,
         '⚠ ⑧ 改成 ERP 名稱會撞到既有的代碼',
         h.code,
         p.name,
         '房務主檔裡已經有一列的 code 就叫「' || p.name || '」—— '
           || '直接改會違反 unique，要先決定留哪一個'
    from public.hk_property h
    join public.properties p on p.id = h.property_id
   where h.code <> p.name
     and exists (select 1 from public.hk_property h2 where h2.code = p.name and h2.id <> h.id)

  union all
  -- ────────────────────────────────────────────────
  -- ⑨ 改代碼會影響多少歷史資料
  --     hk_work_item / hk_month_property / hk_event 都用**代碼字串**存
  --     改了主檔不改它們的話，那些資料會變成孤兒
  -- ────────────────────────────────────────────────
  select 9,
         '⑨ 改這個代碼會牽動幾筆歷史資料',
         h.code,
         p.name,
         (select count(*) from public.hk_work_item w where w.property_code = h.code)::text || ' 筆工作項 ／ '
           || (select count(*) from public.hk_month_property m where m.property_code = h.code)::text || ' 筆月變數 ／ '
           || (select count(*) from public.hk_event e where e.parsed_code = h.code)::text || ' 則事件'
    from public.hk_property h
    join public.properties p on p.id = h.property_id
   where h.code <> p.name

  union all
  -- ────────────────────────────────────────────────
  -- ⑩ 別名裡有沒有已經寫著新名字了
  --     有的話行事曆解析本來就認得，改代碼的風險更低
  -- ────────────────────────────────────────────────
  select 10,
         '⑩ 別名現況',
         h.code,
         p.name,
         case
           when p.name = any(h.aliases) then '✅ 別名已含 ERP 名稱，行事曆兩種寫法都認得'
           when array_length(h.aliases, 1) is null then '（沒有別名）'
           else '別名：' || array_to_string(h.aliases, '、')
         end
    from public.hk_property h
    join public.properties p on p.id = h.property_id
   where h.code <> p.name

) v(ord, "項目", "房務代碼", "ERP 名稱", "說明")
order by v.ord, v."房務代碼";
