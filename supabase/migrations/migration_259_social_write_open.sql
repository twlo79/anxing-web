/*
 * migration_259_social_write_open.sql　2026-09-16
 * IG 版面模擬：管家與會計也能編輯
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ migration_258 要先跑完。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-16：「開放給 管家 經理 會計 總經理，所有人都可以編輯。」
 * （「經理」在權限那一欄叫**主管** `manager` —— 經理是職位的名字。）
 *
 *   目標　管家 housekeeper／會計 accountant／主管 manager／總經理 super_admin
 *   ★ 房務 cleaner **不開** —— 使用者列的四種裡沒有它。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 只改「寫」，不動「讀」】
 *
 * 258 訂的讀就已經是這四種了，一個字都不用動。
 * 要改的只有五條:
 *
 *     social_accounts_write / social_splits_write / social_posts_write
 *     social_obj_write / social_obj_del          ← storage
 *
 * ★★ storage 那兩條**不能漏**。只開表不開 bucket 的話，症狀是:
 *   九宮格排得動、文案存得進去，但**照片一張都上傳不了** ——
 *   那看起來會像「這一頁壞了」，而不是「權限沒開完」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼是 drop 再 create，而不是改 258 重跑】
 *
 * 258 那幾條 policy 是用
 *     do $do$ begin create policy … exception when duplicate_object then null end
 * 包起來的 —— 那個寫法的意思是「已經有了就跳過」。
 *
 *   ★ 所以把 258 的 policy 內容改一改再重跑，**什麼事都不會發生**:
 *     它會安靜地跳過，跑完還給你一張全綠的自檢表，
 *     而畫面上的權限一點都沒變。這比報錯糟 —— 報錯至少會讓人停下來。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ drop policy 在這裡是安全的，但要說清楚為什麼】
 *
 * README 那條警告（`drop policy` 絕對不行）講的是**既有的表**:
 * 照一份舊 dump 抄表名去 drop，會拔掉那份 dump 裡沒有的那幾條，
 * 而症狀是房務阿姨什麼都看不到。
 *
 * 這裡不一樣:三張表是 258 自己建的、policy 的名字是 258 自己取的，
 * 而且**逐條指名**，沒有掃表也沒有萬用字元。
 * `storage.objects` 上只碰 `social_obj_*` 那兩條，別的 bucket 一條都不動 ——
 * 自檢的第 ③ 列會去數它們還在不在。
 */

create temp table if not exists _m259_test (ord int, name text, detail text, verdict text);

/*
 * ★ 先記下動手之前的狀態。
 *   自檢要能回答「這支到底改到了沒」，而不是只回答「現在長什麼樣」。
 */
do $do$
declare
  v_tbl int;
  v_obj int;
begin
  select count(*) into v_tbl from pg_policies
   where schemaname = 'public'
     and tablename in ('social_accounts', 'social_splits', 'social_posts');
  select count(*) into v_obj from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'social\_obj\_%';
  insert into _m259_test values
    (0, '⓪ 動手前：三張表 / storage 各有幾條 policy',
     v_tbl || ' 條　＋　storage ' || v_obj || ' 條',
     case when v_tbl = 6 and v_obj = 3 then '✅ 就是 258 留下的那幾條'
          else '⚠ 跟 258 留下的不一樣（該是 6 ＋ 3）—— 多出來的這支不會動，但要看一下是誰加的' end);
end $do$;

begin;

/* ══════════════════════════════════════════════════════════
 * ① 三張表的「寫」開給四種權限
 *
 * ★ 角色老實寫出來不抽成變數:policy 存的是**展開後的定義文字**，
 *   自檢要拿那段文字去比對有沒有 housekeeper／accountant。
 * ══════════════════════════════════════════════════════════ */

drop policy if exists social_accounts_write on public.social_accounts;
create policy social_accounts_write on public.social_accounts
  for all using (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  ) with check (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  );

drop policy if exists social_splits_write on public.social_splits;
create policy social_splits_write on public.social_splits
  for all using (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  ) with check (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  );

drop policy if exists social_posts_write on public.social_posts;
create policy social_posts_write on public.social_posts
  for all using (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  ) with check (
    current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  );


/* ══════════════════════════════════════════════════════════
 * ② storage：上傳與刪除也開給四種
 *   （讀那一條 258 就已經是四種了，不動）
 * ══════════════════════════════════════════════════════════ */

drop policy if exists social_obj_write on storage.objects;
create policy social_obj_write on storage.objects
  for insert with check (
    bucket_id = 'social'
    and current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  );

drop policy if exists social_obj_del on storage.objects;
create policy social_obj_del on storage.objects
  for delete using (
    bucket_id = 'social'
    and current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
  );

commit;


/* ── 自檢表 ─────────────────────────────────────────────── */

select v.ord, v."檢查", v."結果", v."判定" from (

  select t.ord, t.name, t.detail, t.verdict from _m259_test t

  union all
  /*
   * ★★★ 這一列才是真的在驗事情。
   *   `pg_policies` 存的是**展開後的定義文字** —— 裡面有沒有
   *   housekeeper 與 accountant，就是這支有沒有生效的唯一答案。
   *   只數「有幾條 policy」不算數:258 留下的那幾條也是一樣的條數。
   */
  select 1, '① 三張表的 write policy 都含管家與會計',
         coalesce((select string_agg(policyname || ' '
                          || case when (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                                       ilike '%housekeeper%'
                                   and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                                       ilike '%accountant%'
                                  then '✅' else '❌ 還是舊的' end,
                          '　' order by tablename)
                     from pg_policies
                    where schemaname = 'public'
                      and policyname in ('social_accounts_write', 'social_splits_write',
                                         'social_posts_write')),
                  '★ 一條都沒有'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and policyname in ('social_accounts_write', 'social_splits_write',
                                          'social_posts_write')
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%housekeeper%'
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%accountant%') = 3
              then '✅ 3/3' else '❌' end

  union all
  select 2, '② storage 的上傳與刪除也含管家與會計',
         coalesce((select string_agg(policyname || ' '
                          || case when (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                                       ilike '%housekeeper%'
                                  then '✅' else '❌ 還是舊的' end, '　' order by policyname)
                     from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname in ('social_obj_write', 'social_obj_del')),
                  '★ 一條都沒有 —— 照片會上傳不了'),
         case when (select count(*) from pg_policies
                     where schemaname = 'storage' and tablename = 'objects'
                       and policyname in ('social_obj_write', 'social_obj_del')
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%housekeeper%'
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ilike '%accountant%') = 2
              then '✅ 2/2' else '❌' end

  union all
  /*
   * ★★ 「讀」這一支沒有動過。要證明它沒有被我順手改壞 ——
   *   一條看門的規則安靜地變了，比它壞掉更難發現。
   */
  select 3, '③ 讀的那三條沒被動到（258 訂的就是這四種）',
         coalesce((select string_agg(policyname || ' '
                          || case when qual ilike '%housekeeper%' then '✅' else '❌' end,
                          '　' order by tablename)
                     from pg_policies
                    where schemaname = 'public'
                      and policyname in ('social_accounts_read', 'social_splits_read',
                                         'social_posts_read')), '★ 不見了'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and policyname in ('social_accounts_read', 'social_splits_read',
                                          'social_posts_read')
                       and qual ilike '%housekeeper%') = 3
              then '✅ 3/3 完好' else '❌ 被動到了' end

  union all
  /*
   * ★★★ 這支 drop 了兩條 storage policy。要證明它沒有誤傷別的 bucket ——
   *   請款單附件那幾條就掛在同一張 `storage.objects` 上。
   */
  select 4, '④ storage.objects 上別的 policy 還在幾條',
         coalesce((select count(*)::text || ' 條：'
                          || string_agg(policyname, '　' order by policyname)
                     from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname not like 'social\_obj\_%'), '★ 一條都沒有'),
         case when (select count(*) from pg_policies
                     where schemaname = 'storage' and tablename = 'objects'
                       and policyname not like 'social\_obj\_%') > 0
              then '✅ 還在（請款單附件那幾條沒被動到）'
              else '⚠ 一條都沒有 —— 如果本來就有，那是被誤刪了，馬上講' end

  union all
  /*
   * ⑤ 這次開放實際影響到幾個人。
   *   ★ 母體是 0 的話上面全綠也沒有意義（README:自檢的母體要判定）——
   *     一個管家或會計的帳號都沒有的話，這支等於什麼都沒開放。
   */
  select 5, '⑤ 各種權限現在有幾個人',
         coalesce((select string_agg(x.s, '　' order by x.n desc)
                     from (select coalesce(role, '（沒設）') || ' ' || count(*)::text || ' 人' as s,
                                  count(*) as n
                             from public.profiles group by role) x), '★ 查不到 profiles'),
         case when (select count(*) from public.profiles
                     where role in ('housekeeper', 'accountant')) > 0
              then '✅ 有管家或會計的帳號，這次開放對他們有意義'
              else '⚠ 目前沒有管家／會計權限的帳號 —— 開了但還沒有人會用到' end

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
