/*
 * migration_200 —— 房務的十張表開放給會計
 * ============================================================
 * 2026-09-02 使用者：「這些數量也開放給 會計」
 *   （圈的是排班統計頁的 劉姐 42.5 小時「手動填寫」、床單總計，
 *     以及右側「房源（開整棟系）」表格的 次數／床數／更換床數／拿床單）
 *
 * ============================================================
 * 【★★★ 畫面早就開了 —— 擋住的是 RLS】
 *
 * 上一次「開放給會計」我只改了 `housekeeping/page.tsx` 的 `canEdit`。
 * 而 `stats-tab.tsx` 裡**一個角色判斷都沒有** —— 會計本來就看得到
 * 那些輸入框、點得進去、打得了字、按得下儲存。
 *
 * 真正擋住的是這十張表的 policy（`schema-baseline.sql:1497`）:
 *
 *     using (current_role_of() = ANY (ARRAY['manager','super_admin']))
 *
 * ★★★ 而 RLS 擋下的 UPDATE／INSERT **回成功而且影響 0 列**（CLAUDE.md 的坑）。
 *
 *   所以症狀不是「被拒絕」，是:
 *     打了 42.5 → 按儲存 → 跳「已儲存」→ 重新整理 → 空的。
 *
 *   會計會以為自己按錯、或以為系統壞了，而**畫面上沒有任何地方
 *   說得出發生了什麼**。這比直接報錯糟得多。
 *
 * ============================================================
 * 【這是在推翻一個當初刻意的決定】
 *
 * baseline 那一行上面寫著:
 *
 *     -- 房務：主管與總經理。牽涉個人工作量與出勤，會計看不到。
 *
 * 使用者 2026-09-01 說「開放給會計」「都開放」，2026-09-02 再確認一次。
 * 所以這支把那句註解一起改掉 —— **不要留著一句跟現況相反的說明**，
 * 三個月後看到的人會以為 policy 被誤改。
 *
 * 涵蓋的十張表:
 *
 *   hk_staff          人員主檔（含出勤、統計方式）
 *   hk_property       房源主檔（床數、打掃點數）      ← 圈起來的「床數」
 *   hk_work_type      工作類型
 *   hk_event          行事曆事件（例外清單、按掉）
 *   hk_work_item      工作項目（補登、間數／點數）
 *   hk_day            每日每人的間數與時數            ← 圈起來的「42.5 小時」
 *   hk_month_property 每月每房源的次數／床單          ← 圈起來的「拿床單」
 *   hk_period         月份鎖定
 *   hk_setting        設定
 *   hk_audit          異動紀錄
 *
 * ============================================================
 * 【為什麼不直接 drop 再 create】
 *
 * 我手上只有 baseline 的版本，線上有沒有被改過我不知道。
 * 所以下面是**先驗形狀再 alter**:
 *
 *   · 已經有 accountant  → 跳過（重跑安全）
 *   · 形狀跟 baseline 一致 → alter
 *   · 都不是            → 收集起來，最後一起 raise exception 中止
 *
 * ★ SQL Editor 把整份腳本包在一個交易裡，中止等於什麼都沒發生。
 *   （三次失敗學到的:蓋掉一個沒看過的東西，錯了不會有人發現。）
 *
 * ============================================================
 * 【★★ 第一次跑就被自己的指紋擋下來 —— 而那是對的】
 *
 * 2026-09-02 第一版中止，訊息:
 *
 *     有 5 條 policy 的形狀跟我看過的不一樣：
 *       hk_event.hk_event_read         → using: (current_role_of() IS NOT NULL)
 *       hk_property.hk_property_read   → 同上
 *       hk_staff.hk_staff_read         → 同上
 *       hk_work_item.hk_work_item_read → 同上
 *       hk_work_type.hk_work_type_read → 同上
 *
 * ★★★ 那五條**不在 `schema-baseline.sql` 裡** —— 也就是說
 *   baseline 已經過期了，線上的 policy 比它多。
 *   我當初如果用 `drop policy ... create policy ...`，
 *   這五條會被我連根拔掉，而**症狀是房務人員突然什麼都看不到**。
 *
 * 【它們是什麼】
 *
 *   `using (current_role_of() is not null)` = 只要是登入中的人都給過。
 *   從名字（`_read`）與這個條件看，是為了讓房務阿姨看得到自己的班表
 *   而後來補的**唯讀**通道。
 *
 * 【所以這一版怎麼改】
 *
 *   只動**寫得了東西的** policy（polcmd 是 ALL／INSERT／UPDATE／DELETE）。
 *   純 SELECT 的一律不碰 —— 它們本來就沒有擋住任何人，
 *   而會計的讀取權限也正是靠它們。
 *
 * ★ 判斷用 `polcmd` 而不是「名字裡有沒有 _read」。
 *   名字是人取的，polcmd 是資料庫記的（CLAUDE.md:對不上的不猜）。
 */

do $do$
declare
  r record;
  q text;
  w text;
  v_expr  text := $q$current_role_of() = any (array['accountant','manager','super_admin'])$q$;
  n_alt   int := 0;
  n_skip  int := 0;
  n_read  int := 0;
  bad     text[] := array[]::text[];
 begin
  for r in
    select c.relname::text as tbl, p.polname::text as pol, p.polrelid,
           p.polcmd,
           coalesce(pg_get_expr(p.polqual,      p.polrelid), '') as q,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as w
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('hk_staff','hk_property','hk_work_type','hk_event',
                         'hk_work_item','hk_day','hk_month_property',
                         'hk_period','hk_setting','hk_audit')
     order by c.relname, p.polname
  loop
    q := r.q;
    w := r.w;

    /*
     * ★★★ 純 SELECT 的 policy 一律不碰。
     *
     *   那五條 `_read` 是 `using (current_role_of() is not null)` ——
     *   登入中的人都給過，本來就沒有擋住會計。
     *   而房務阿姨看得到自己班表**靠的就是它們**，動了會壞。
     */
    if r.polcmd = 'r' then
      n_read := n_read + 1;
      continue;
    end if;

    if position('accountant' in q) > 0 and position('accountant' in w) > 0 then
      n_skip := n_skip + 1;                       -- 已經開過了，重跑不會壞
    elsif position('current_role_of()' in q) > 0
      and position('manager' in q) > 0
      and position('super_admin' in q) > 0 then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     r.pol, r.tbl, v_expr, v_expr);
      n_alt := n_alt + 1;
    else
      -- ★ 形狀不認得 —— 記下來，最後一起報，不要改一半
      bad := bad || (r.tbl || '.' || r.pol || '（' || r.polcmd::text || '）→ using: ' || left(q, 120));
    end if;
  end loop;

  if array_length(bad, 1) > 0 then
    raise exception E'有 % 條**寫入** policy 的形狀跟我看過的不一樣，整支中止（什麼都沒改）：\n%',
      array_length(bad, 1), array_to_string(bad, E'\n');
  end if;

  raise notice '改了 % 條，已經開過的 % 條，唯讀不碰的 % 條', n_alt, n_skip, n_read;
 end $do$;


-- ── 把那句相反的說明一起改掉 ───────────────────────────
comment on table public.hk_day is
  '每日每人的間數與時數。**會計可讀可寫**（migration_200）—— '
  '排班統計頁的「手動填寫時數」寫在這裡。';
comment on table public.hk_month_property is
  '每月每房源的次數／床數／更換床數／拿床單。**會計可讀可寫**（migration_200）。';
comment on table public.hk_property is
  '房務房源主檔（床數、打掃點數）。**會計可讀可寫**（migration_200）。';


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('200_hk_accountant');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了幾條:第 ① 列問的是「十張表全部含 accountant 嗎」，
--   正確答案永遠是 10（CLAUDE.md:基準要用跟改動無關的量）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 十張表的「寫入」policy 都含 accountant',
         (select case when count(*) filter (where has_acc) = count(*)
                      then '✅ ' || count(*)::text || ' / ' || count(*)::text
                      else '⚠⚠ 只有 ' || count(*) filter (where has_acc)::text
                           || ' / ' || count(*)::text || '：'
                           || string_agg(tbl || '.' || pol, '、')
                              filter (where not has_acc) end
            from (
              select c.relname as tbl, p.polname as pol,
                     coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%accountant%'
                 and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%accountant%'
                       as has_acc
                from pg_policy p
                join pg_class c on c.oid = p.polrelid
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and p.polcmd <> 'r'
                 and c.relname in ('hk_staff','hk_property','hk_work_type','hk_event',
                                   'hk_work_item','hk_day','hk_month_property',
                                   'hk_period','hk_setting','hk_audit')
            ) z),
         '★★ using 與 with check **兩邊都要有**。只改 using 的話，'
           || '會計改得動既有的列，但新增會被 with check 擋掉 —— '
           || '而那一樣是回成功且影響 0 列'

  union all
  select 2, '★★ ② 全部 hk_ policy 的實際樣子',
         (select string_agg(
                   c.relname || '.' || p.polname || '　'
                   || case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                                    when 'w' then 'UPDATE' when 'd' then 'DELETE'
                                    when '*' then '全部' else p.polcmd::text end
                   || '　' || left(coalesce(pg_get_expr(p.polqual, p.polrelid), '（無）'), 90),
                   E'\n' order by c.relname, p.polname)
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%'),
         '★★★ 這一欄請整個看過。`_read` 那五條該維持 '
           || '「current_role_of() IS NOT NULL」不變 —— 房務阿姨看得到自己的班表靠它們；'
           || '「全部」那十條該變成 accountant／manager／super_admin'

  union all
  select 3, '③ policy 條數：跑之前是 15（10 全部 ＋ 5 唯讀）',
         (select count(*) filter (where p.polcmd = '*')::text || ' 條全部　＋　'
                 || count(*) filter (where p.polcmd = 'r')::text || ' 條唯讀　＝　'
                 || count(*)::text || ' 條'
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%'),
         '★ 這支只 alter，一條都不新增、不刪除 —— 條數變了就是有別的東西在動'

  union all
  select 4, '④ 十張表都還開著 RLS',
         (select case when count(*) filter (where not c.relrowsecurity) = 0
                      then '✅ 全部開著'
                      else '⚠⚠⚠ 有 ' || count(*) filter (where not c.relrowsecurity)::text
                           || ' 張被關掉了 —— 那是誰都寫得進去' end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'hk\_%' and c.relkind = 'r'),
         '★ 這支不該碰 RLS 開關。關掉的話等於對外全開，而畫面上看不出來'

  union all
  select 5, '⑤ 會計這個角色實際存在幾個人',
         (select case when count(*) = 0 then '⚠ 0 人 —— 這支等於沒有效果'
                      else count(*)::text || ' 人：' || string_agg(name, '、') end
            from public.profiles where role = 'accountant' and active),
         '★ profiles.role 的 check 約束允許 housekeeper／accountant／manager／super_admin，'
           || '所以名字沒打錯。0 人的話先去人員設定把角色設成會計'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
