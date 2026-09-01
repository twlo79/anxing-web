/*
 * migration_189 —— 房務代碼一律改用 ERP 名稱
 * ============================================================
 * 2026-09-01 使用者：「房源有更名過 B4 > B04，請都對一下請統一」
 *                     「一律用 ERP 名稱」
 *
 * 稽核（audit_property_codes_2.sql）掃出 23 筆「對上了但名字不一樣」:
 *
 *     A1 → A01 … A9 → A09、B1 → B01 … B8 → B08   （時兆，純補零）
 *     JPR1 → JPR1F、JPR2 → JPR2F
 *     開2 → 開封2F、開2-1 → 開封2-1、開4 → 開封4F、開整棟 → 開封整棟
 *
 * ============================================================
 * 【★★ 清單是「算出來的」，不是寫死的】
 *
 * 第一版把 17 組寫死在檔案裡 —— 那樣看得懂改了什麼，但規則變成
 * 「這 17 個」而不是「一律用 ERP 名稱」。
 *
 * 使用者要的是後者，所以改成:
 *     凡是 `hk_property.code <> properties.name` 的，一律改成 name。
 *
 * ★ 好處是**以後 ERP 再改名，重跑這支就對回來了**。
 * ★ 代價是「這次到底改了什麼」要靠自檢印出來 —— 所以自檢第 1 列
 *   會把每一組 `舊 → 新` 完整列出來，不是只給一個數字。
 *
 * ★★ 重跑安全:跑完 `code = name`，第二次跑清單是空的，什麼都不做。
 *
 * ============================================================
 * 【★★★ 為什麼不是「改一個欄位」那麼簡單】
 *
 * `hk_property.code` 是**字串主鍵的角色**，另外三張表用它的**文字**去指:
 *
 *     hk_work_item.property_code       工作項是哪一間（間數、點數靠它）
 *     hk_month_property.property_code  拿床單、次數覆寫（主鍵的一部分）
 *     hk_event.parsed_code             行事曆解析出來的代碼
 *
 * ★★ 只改主檔不改這三張的話，那些列會**全部變成孤兒**——
 *   而且**不會有任何錯誤訊息**（沒有外鍵擋著），
 *   只會讓那幾間房的統計突然變成 0。
 *
 * ============================================================
 * 【★★★ 舊代碼一定要進 aliases，而且要先做】
 *
 * TimeTree 上人手打的還是 `退-A7-Ariel`、`贈-B3`、`開4-Anja-入住`
 * —— **行事曆不會跟著改名**。
 *
 * `hkParse` 的對照表是「code ＋ aliases」一起建的。
 * 改完 code 而沒把舊寫法加進 aliases 的話:
 *
 *     下一次同步 → `A7` 對不到任何房源 → parsed_code 是 null
 *                → 那筆進得去但沒有房源 → 「⚠ N 筆未計」
 *
 * **而且每個月都會發生一次。**
 *
 * ★ 所以順序是:先加別名（保住解析），再改代碼。
 */

create temp table _chk189 (ord int, item text, result text, note text) on commit drop;

-- ══════════════════════════════════════════════════════════
-- 這次要改哪些 —— 照 ERP 推導
-- ══════════════════════════════════════════════════════════
create temp table _pad189 (old_code text primary key, new_code text not null) on commit drop;

insert into _pad189 (old_code, new_code)
select h.code, p.name
  from public.hk_property h
  join public.properties p on p.id = h.property_id
 where h.code <> p.name;

-- 跑之前的樣子（拿來對照）
insert into _chk189
select 0, '跑之前',
       (select count(*) from public.hk_work_item w join _pad189 p on p.old_code = w.property_code)::text
         || ' 筆工作項 ／ '
         || (select count(*) from public.hk_month_property m join _pad189 p on p.old_code = m.property_code)::text
         || ' 筆月變數 ／ '
         || (select count(*) from public.hk_event e join _pad189 p on p.old_code = e.parsed_code)::text
         || ' 則事件',
       '這些數字改完之後要一模一樣地出現在新代碼底下';

insert into _chk189
select -1, '要改幾組', count(*)::text || ' 組', '照 ERP 名稱推導出來的' from _pad189;

-- ══════════════════════════════════════════════════════════
-- ★★★ 前提檢查 ①：新代碼不可以已經被別人用了
--
--   `hk_property.code` 是 unique。`A01` 已經有別的列在用的話，
--   改 `A1 → A01` 會違反唯一約束 —— 那表示「A1 與 A01 是兩列」，
--   是**合併**不是改名，這支不處理。
--   中止總比把兩間房合成一間好。
-- ══════════════════════════════════════════════════════════
do $$
declare clash text;
begin
  select string_agg(p.old_code || ' → ' || p.new_code, '、' order by p.old_code) into clash
    from _pad189 p
   where exists (select 1 from public.hk_property h
                  where h.code = p.new_code and h.code <> p.old_code);
  if clash is not null then
    raise exception
      '這幾組的新代碼在房務主檔裡已經有別的列在用:%。'
      '那是「要合併兩列」而不是「改個名字」—— 請人工判斷。', clash;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ★★ 前提檢查 ②：兩個舊代碼指到同一個新名字
--
--   `hk_property_property_id_uniq`（migration_124）應該擋住了，
--   但那個索引哪天被拿掉的話，這裡會靜靜地把兩列改成同一個 code
--   —— 然後撞 unique，錯誤訊息看不出原因。先明白地講。
-- ══════════════════════════════════════════════════════════
do $$
declare dup text;
begin
  select string_agg(new_code, '、') into dup
    from (select new_code from _pad189 group by new_code having count(*) > 1) x;
  if dup is not null then
    raise exception '有兩個以上的舊代碼要改成同一個名字:% —— 那是合併，請人工判斷。', dup;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ★★ 前提檢查 ③：月變數同一個月同時有新舊兩種代碼
--
--   `hk_month_property` 的主鍵是 (period, property_code)，
--   直接 update 會撞主鍵。前面兩個檢查看的是 hk_property，
--   這張表的資料是**獨立的**，要自己再擋一次。
-- ══════════════════════════════════════════════════════════
do $$
declare dup text;
begin
  select string_agg(m.period || '／' || p.old_code || '→' || p.new_code, '、') into dup
    from public.hk_month_property m
    join _pad189 p on p.old_code = m.property_code
   where exists (select 1 from public.hk_month_property m2
                  where m2.period = m.period and m2.property_code = p.new_code);
  if dup is not null then
    raise exception '月變數裡同一個月同時有新舊兩種代碼:% —— 要先決定哪一筆才算數。', dup;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ① 先把舊代碼加進 aliases（保住行事曆解析）
-- ══════════════════════════════════════════════════════════
/*
 * ★ 加之前先確認還沒有 —— 重跑會加第二次，
 *   重複的別名不會壞事，但清單會越來越長沒有人敢刪。
 */
update public.hk_property h
   set aliases = array_append(h.aliases, p.old_code)
  from _pad189 p
 where h.code = p.old_code
   and not (p.old_code = any(h.aliases));

-- ══════════════════════════════════════════════════════════
-- ② 三張用「字串」指過來的表，全部改
--    ★ 主檔放最後 —— 前面幾張還在用舊值比對
-- ══════════════════════════════════════════════════════════
update public.hk_work_item w
   set property_code = p.new_code
  from _pad189 p
 where w.property_code = p.old_code;

update public.hk_month_property m
   set property_code = p.new_code
  from _pad189 p
 where m.property_code = p.old_code;

update public.hk_event e
   set parsed_code = p.new_code
  from _pad189 p
 where e.parsed_code = p.old_code;

-- ③ 最後才改主檔
update public.hk_property h
   set code = p.new_code
  from _pad189 p
 where h.code = p.old_code;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('189_hk_code_pad');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  /*
   * ★★ 清單是算出來的，所以**一定要印出來**——
   *   只給一個數字的話，「這次到底改了什麼」三個月後查不到。
   */
  select 1, '★★★ 這次改了哪幾組',
         coalesce((select string_agg(old_code || ' → ' || new_code, '、' order by old_code)
                     from _pad189), '（沒有要改的，可能是已經跑過了）'),
         (select '共 ' || count(*) || ' 組' from _pad189)

  union all
  select 2, '★★ 主檔已經改成 ERP 名稱',
         (select case when count(*) = (select count(*) from _pad189)
                      then '✅ ' || count(*) || ' / ' || (select count(*) from _pad189)
                      else '⚠ 只有 ' || count(*) || ' / ' || (select count(*) from _pad189) end
            from public.hk_property h join _pad189 p on p.new_code = h.code),
         '少的話是有幾列在改的過程中被別的東西擋住了'

  union all
  /*
   * ★★★ 這一項最重要:舊寫法還認不認得。
   *   TimeTree 上人打的還是 `退-A7-Ariel`、`開4-Anja-入住`,
   *   別名沒進去的話**下一次同步那幾筆全部變成「沒有房源」**,
   *   而且每個月一次。
   */
  select 3, '★★★ 舊寫法還認得（別名）',
         (select case when count(*) = (select count(*) from _pad189)
                      then '✅ ' || count(*) || ' / ' || (select count(*) from _pad189) || ' 都加了別名'
                      else '⚠ 只有 ' || count(*) || ' —— 少的那幾個下次同步會對不到' end
            from public.hk_property h
            join _pad189 p on p.new_code = h.code
           where p.old_code = any(h.aliases)),
         '行事曆不會跟著改名，舊寫法要靠別名才對得回來'

  union all
  select 4, '★★ 歷史資料跟著搬過來了',
         (select count(*) from public.hk_work_item w join _pad189 p on p.new_code = w.property_code)::text
           || ' 筆工作項 ／ '
           || (select count(*) from public.hk_month_property m join _pad189 p on p.new_code = m.property_code)::text
           || ' 筆月變數 ／ '
           || (select count(*) from public.hk_event e join _pad189 p on p.new_code = e.parsed_code)::text
           || ' 則事件',
         (select '跑之前是：' || result from _chk189 where ord = 0)

  union all
  /*
   * ★★★ 沒有任何一列還停在舊代碼。
   *   有的話那幾列現在是孤兒 —— 而孤兒不會報錯，只會讓統計少一截。
   */
  select 5, '★★★ 沒有任何一列還停在舊代碼',
         (select case when count(*) = 0 then '✅ 0 筆'
                      else '⚠ 還有 ' || count(*) || ' 筆是舊代碼（已經變成孤兒）' end
            from (
              select 1 from public.hk_work_item w join _pad189 p on p.old_code = w.property_code
              union all
              select 1 from public.hk_month_property m join _pad189 p on p.old_code = m.property_code
              union all
              select 1 from public.hk_event e join _pad189 p on p.old_code = e.parsed_code
              union all
              select 1 from public.hk_property h join _pad189 p on p.old_code = h.code
            ) x),
         '三張表 ＋ 主檔都要改乾淨'

  union all
  /*
   * ★★★ 收尾:全站現在還有幾組對不起來。
   *   應該是 0 —— 不是 0 的話代表有幾組被前提檢查跳過了，
   *   而那幾組需要人工處理。
   */
  select 6, '★★★ 全站還有幾組名字不一樣',
         (select case when count(*) = 0 then '✅ 0 組，全部統一了'
                      else '⚠ 還有 ' || count(*) || ' 組：'
                           || string_agg(h.code || ' ↔ ' || pr.name, '、' order by h.code) end
            from public.hk_property h
            join public.properties pr on pr.id = h.property_id
           where h.code <> pr.name),
         '★ 這是「一律用 ERP 名稱」有沒有做到的最終答案'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
