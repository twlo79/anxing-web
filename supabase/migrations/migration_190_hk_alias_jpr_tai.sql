/*
 * migration_190 —— 補三個行事曆的別名：J1、J2、台S
 * ============================================================
 * 2026-09-01 使用者：「J1 > JPR 1F、J2 > JPR 2F、台S > 台4，其它不用管」
 *
 * 八月的試算報告有五個房源對不到:
 *     J1（3 筆）、J2（4 筆）、台S（3 筆）、正隆（1 筆）、
 *     時兆三四樓洗衣機間和公區窗戶（1 筆）
 *
 * 前三個是**同一間房的簡寫**，後兩個使用者說不用管。
 *
 * ============================================================
 * 【★★ 加別名，不是改代碼】
 *
 * `J1` 不是一個新房源 —— 它是 `JPR1F` 在 TimeTree 上的寫法。
 * 房務主檔已經有 `JPR1F` 那一列（migration_189 剛從 `JPR1` 改過來的）。
 *
 * ★ 所以要做的是「讓解析器多認得一種寫法」，
 *   而那正是 `aliases` 的用途 —— `hkParse` 的對照表是
 *   「code ＋ aliases」一起建的。
 *
 * ★★ 反過來（把 code 改成 J1）是錯的:ERP 那邊叫 JPR1F，
 *   而使用者剛剛才定了規則「一律用 ERP 名稱」（migration_189）。
 *   改回去等於自己推翻自己。
 *
 * ============================================================
 * 【為什麼這支不用改歷史資料】
 *
 * 那 10 筆事件的 `parsed_code` 現在是 null（對不到就是 null）。
 * 加了別名之後**重新同步一次**，解析器就會把它們填上 —— 而同步本來
 * 就是整月刪掉重灌，不需要在這裡手動 update。
 *
 * ★ 所以跑完這支還要做一件事:重新同步八月。
 *   不同步的話別名有了，但那 10 筆還停在「沒有房源」的狀態。
 */

create temp table _alias190 (target_code text, alias text) on commit drop;
insert into _alias190 values
  ('JPR1F', 'J1'),
  ('JPR2F', 'J2'),
  ('台4',   '台S');

-- ══════════════════════════════════════════════════════════
-- ★★★ 前提：三個目標代碼都要存在
--
--   打錯一個字的話，`update ... where code = '台4'` 會**影響 0 列**
--   —— 不報錯、不警告，而使用者以為加好了。
--   下次同步時「台S」照樣對不到，而他會以為是別的原因。
-- ══════════════════════════════════════════════════════════
do $$
declare missing text;
begin
  select string_agg(a.target_code, '、' order by a.target_code) into missing
    from _alias190 a
   where not exists (select 1 from public.hk_property h where h.code = a.target_code);
  if missing is not null then
    raise exception
      '房務主檔裡找不到這些代碼:%。'
      '確認一下是不是拼錯，或 migration_189 還沒跑（JPR1 要先改成 JPR1F）。', missing;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════
-- ★★ 前提：這個別名不可以已經被別的房源用走
--
--   `J1` 如果已經是別間房的別名，加上去之後 `hkParse` 的對照表
--   會有兩個 `J1` —— 而 `map.set` 是後面蓋前面，
--   **那 3 筆會安靜地記到錯的房間**。記錯比記不到嚴重得多。
-- ══════════════════════════════════════════════════════════
do $$
declare taken text;
begin
  select string_agg(a.alias || '（已被 ' || h.code || ' 用走）', '、') into taken
    from _alias190 a
    join public.hk_property h on a.alias = any(h.aliases)
   where h.code <> a.target_code;
  if taken is not null then
    raise exception '這些別名已經是別的房源在用:% —— 加上去會讓那幾筆記到錯的房間。', taken;
  end if;
end $$;

-- ── 加別名 ────────────────────────────────────────
/*
 * ★ 加之前先確認還沒有 —— 重跑會加第二次。
 *   重複的別名不會壞事（Set 語意），但清單會越來越長沒有人敢刪。
 */
update public.hk_property h
   set aliases = array_append(h.aliases, a.alias)
  from _alias190 a
 where h.code = a.target_code
   and not (a.alias = any(h.aliases));


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('190_hk_alias_jpr_tai');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 三個別名都加好了',
         (select case when count(*) = 3 then '✅ 3 / 3'
                      else '⚠ 只有 ' || count(*) || ' / 3' end
            from public.hk_property h
            join _alias190 a on h.code = a.target_code
           where a.alias = any(h.aliases)),
         'J1 → JPR1F、J2 → JPR2F、台S → 台4'

  union all
  select 2, '★★ 那三間現在的別名清單',
         (select string_agg(h.code || '：' || array_to_string(h.aliases, '、'), E'\n'
                            order by h.code)
            from public.hk_property h
           where h.code in (select target_code from _alias190)),
         '★ 舊代碼（JPR1、JPR2）應該也還在 —— 那是 migration_189 加的'

  union all
  /*
   * ★★ 全站的別名不可以重複。
   *   重複的話 `hkParse` 的對照表後面蓋前面，那幾筆會記到錯的房間 ——
   *   而記錯比記不到嚴重得多（記不到看得出來，記錯看不出來）。
   */
  select 3, '★★★ 全站沒有重複的別名',
         (select case when count(*) = 0 then '✅ 沒有重複'
                      else '⚠ 這些別名被多間房共用：' || string_agg(al, '、') end
            from (
              select al from (
                select unnest(h.aliases) as al from public.hk_property h where h.active
              ) x group by al having count(*) > 1
            ) y),
         '重複的話那幾筆會安靜地記到錯的房間'

  union all
  select 4, '★ 別名跟代碼有沒有互相衝突',
         (select case when count(*) = 0 then '✅ 沒有'
                      else '⚠ ' || string_agg(h2.code, '、') || ' 的代碼同時是別間房的別名' end
            from public.hk_property h1, public.hk_property h2
           where h1.active and h2.active and h1.id <> h2.id
             and h2.code = any(h1.aliases)),
         '一個字串同時是 A 的代碼與 B 的別名時，解析會挑到哪一個沒有保證'

  union all
  select 5, '接下來要做的',
         '重新同步八月',
         '★ 別名加好了，但那 10 筆事件的 parsed_code 還是 null —— '
           || '同步是整月刪掉重灌，重跑一次才會填上'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
