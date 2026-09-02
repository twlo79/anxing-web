/*
 * 房源代碼稽核 —— ★★★ 這支**只讀不寫**，跑幾次都安全
 * ============================================================
 * 2026-09-01 使用者：「房源有更名過 B4 > B04，時兆，請都對一下請統一，
 *                      幫我掃一下所有資料」
 *
 * 【為什麼先掃再改】
 *
 * 「統一」聽起來是一個動作，實際上有四種不同的情況，
 * 每一種的正確處理方式不一樣:
 *
 *   ① 房務有 B4、ERP 有 B04，只是沒對上   → 對上就好，資料不用動
 *   ② 房務同時有 B4 與 B04 兩列           → 要合併，而合併會動到歷史資料
 *   ③ 工作項寫著 B4，但 hk_property 沒有   → 孤兒，那些工時算不到任何房源
 *   ④ ERP 有房源，但房務完全沒有對應       → 那間房的清潔從來沒被記錄過
 *
 * ★★ 直接「全部改成補零」的話，②會撞主鍵、③會靜靜地繼續孤兒。
 *   **先看清單，再決定。**（CLAUDE.md:「對不上的不猜」）
 *
 * ============================================================
 * 【正規化的規則跟程式碼是同一套】
 *
 * `src/lib/hk-link.ts` 的 `normKey()`:去空白、全形轉半形、轉大寫、
 * **整組數字去掉補零**（`A07` → `A7`、`A100` → `A100`）。
 *
 * ★ 下面的 `nk()` 是它的 SQL 版。兩邊不一致的話，
 *   畫面上說對得起來而這份報告說對不起來 —— 那比沒有報告更糟。
 *
 * ============================================================
 * 用法：整支貼進 Supabase SQL Editor 執行，看回來的表。
 */

-- ── 正規化函式（暫時的，交易結束就沒了）──────────────
create or replace function pg_temp.nk(s text) returns text language sql immutable as $$
  select upper(
           regexp_replace(
             regexp_replace(
               translate(coalesce(s, ''),
                 '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ',
                 '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'),
               '[[:space:]　]', '', 'g'),
             /*
              * ★★ 只砍**每一組數字最前面**的零:`(^|[^0-9])0+([0-9])` → 保留前一個字元。
              *   直接砍 `0+` 的話 `A100` 會變成 `A1`。
              *   這條規則跟 `hk-link.ts` 的 `parseInt` 等價,但 SQL 沒有等價的簡寫。
              */
             '(^|[^0-9])0+([0-9])', '\1\2', 'g')
         );
$$;

-- ══════════════════════════════════════════════════════════
select v.ord as "#", v."項目", v."代碼", v."說明" from (

  -- ────────────────────────────────────────────────
  -- ① 房務有這個代碼，但沒對到 ERP 房源
  --    正規化之後**唯一**對得上的那個 ERP 名稱一併列出來
  -- ────────────────────────────────────────────────
  select 1 as ord,
         '① 沒對到 ERP，但找得到唯一候選' as "項目",
         h.code as "代碼",
         '→ 建議對到「' || cand.name || '」（房務設定頁按一下就好，資料不用動）' as "說明"
    from public.hk_property h
    cross join lateral (
      select p.name
        from public.properties p
       where p.active
         and pg_temp.nk(p.name) = pg_temp.nk(h.code)
       limit 2
    ) cand
   where h.property_id is null and h.active
     /* ★ 只列**唯一**候選 —— 兩個以上對得上的那些要人親自看，不該給提示 */
     and (select count(*) from public.properties p2
           where p2.active and pg_temp.nk(p2.name) = pg_temp.nk(h.code)) = 1

  union all
  -- ────────────────────────────────────────────────
  -- ★★★ ② 房務裡同時存在兩個正規化後相同的代碼（B4 與 B04）
  --    這是最麻煩的一種:要合併，而合併會動到歷史工作項
  -- ────────────────────────────────────────────────
  select 2,
         '★★★ ② 房務內部自己就撞號（要合併）',
         string_agg(h.code, ' ＝ ' order by h.code),
         '正規化後都是「' || pg_temp.nk(min(h.code)) || '」。'
           || '合併前要先看兩邊各有幾筆工作項 —— 見 ③'
    from public.hk_property h
   where h.active
   group by pg_temp.nk(h.code)
  having count(*) > 1

  union all
  -- ────────────────────────────────────────────────
  -- ③ 工作項寫著某個代碼，但 hk_property 裡沒有這一列
  --    → 那些工時算不到任何房源，也算不出打掃點數
  -- ────────────────────────────────────────────────
  select 3,
         '③ 工作項的代碼在房務主檔裡不存在',
         w.property_code,
         count(*)::text || ' 筆工作項變成孤兒。'
           || coalesce('正規化後對得上房務的「'
                || (select min(h2.code) from public.hk_property h2
                     where pg_temp.nk(h2.code) = pg_temp.nk(w.property_code)) || '」', '房務裡完全沒有相近的')
    from public.hk_work_item w
   where w.property_code is not null
     and not exists (select 1 from public.hk_property h where h.code = w.property_code)
   group by w.property_code

  union all
  -- ────────────────────────────────────────────────
  -- ④ 月份手動變數（拿床單、次數覆寫）的代碼也可能是舊的
  -- ────────────────────────────────────────────────
  select 4,
         '④ 手動變數的代碼不存在（拿床單會消失）',
         m.property_code,
         string_agg(distinct m.period, '、' order by m.period) || ' 這幾個月填過，'
           || '而房務主檔沒有這個代碼 —— 那幾個數字現在算不進小計'
    from public.hk_month_property m
   where not exists (select 1 from public.hk_property h where h.code = m.property_code)
   group by m.property_code

  union all
  -- ────────────────────────────────────────────────
  -- ⑤ 行事曆解析出的代碼，房務主檔沒有
  -- ────────────────────────────────────────────────
  select 5,
         '⑤ 行事曆解析出來但主檔沒有的代碼',
         e.parsed_code,
         count(*)::text || ' 則事件。'
           || '要嘛加進主檔，要嘛把它加成某個房源的別名'
    from public.hk_event e
   where e.parsed_code is not null
     and not exists (select 1 from public.hk_property h where h.code = e.parsed_code)
   group by e.parsed_code

  union all
  -- ────────────────────────────────────────────────
  -- ⑥ ERP 有這間房，但房務完全沒有對應的列
  --    → 那間房的清潔從來沒有被統計過
  -- ────────────────────────────────────────────────
  select 6,
         '⑥ ERP 有、房務沒有（清潔從沒被統計）',
         p.name,
         '房務主檔裡連正規化後相近的代碼都沒有'
    from public.properties p
   where p.active
     and not exists (
       select 1 from public.hk_property h
        where h.property_id = p.id
           or pg_temp.nk(h.code) = pg_temp.nk(p.name))

) v(ord, "項目", "代碼", "說明")
order by v.ord, v."代碼";
