/*
 * migration_259_social_editor.sql　2026-09-16
 * IG 版面模擬：加一個「小編」勾，只有小編與總經理改得動
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ migration_258 要先跑完。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-16：「可以指定誰能編輯嗎？芊和 super admin 可以編輯，
 * 其他人只能讀」「還是權限管理裡面可以指定」「有小編這角色」「沒開不能編輯」。
 *
 *   ★ 所以是**一個人一個勾**，不是一種權限。
 *     同樣是管家，有的人是小編有的不是 —— 用 role 分不出來。
 *
 *   ★★ **不把某個人的 uuid 寫死在 policy 裡**。寫死的話換人就要再跑一次
 *     migration，而那個 uuid 會躺在資料庫定義裡，三個月後沒有人知道它是誰。
 *     改成一個欄位，總經理在權限設定頁上勾 —— 換人是一個點擊。
 *
 *   ★ 預設 **false**（使用者:「沒開不能編輯」）。
 *     預設 true 的話，這支一跑完全公司就都變成小編了。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 一份規則，兩邊共用】
 *
 * `can_edit_social()` 同時給兩邊用:
 *     資料庫　policy 的 using / with check
 *     前端　　social 那一頁用 rpc 叫它，決定按鈕要不要能按
 *
 * ★ 這是刻意的。同一條規則寫在兩個地方就會有一邊沒跟上（README 坑 A），
 *   而那種錯的症狀是「畫面讓你按、存檔卻回一句看不懂的話」，
 *   或反過來「明明有權限卻是灰的」。**只有一份定義就不會有這種事。**
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼是 security definer】
 *
 * policy 裡直接 `select … from profiles` 的話，那個查詢會再被
 * profiles 自己的 RLS 檢查一次 —— 讀不到就回 0 列，
 * 而 0 列在這裡會被當成「不是小編」。症狀是**勾了卻還是不能編輯**，
 * 沒有錯誤訊息（README 坑 C）。security definer 繞過那一層。
 *
 * ★ 讀 role 也直接從同一列拿，不呼叫 current_role_of() ——
 *   一次查詢拿兩個欄位，少一個相依。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ drop policy 在這裡安全，但要說清楚為什麼】
 *
 * README 那條警告講的是**既有的表**:照舊 dump 抄表名去 drop，
 * 會拔掉那份 dump 裡沒有的那幾條，症狀是房務阿姨什麼都看不到。
 *
 * 這裡三張表是 258 自己建的、policy 名字是 258 自己取的、**逐條指名**，
 * 沒有掃表也沒有萬用字元。`storage.objects` 上只碰 `social_obj_*` 那兩條，
 * 別的 bucket 一條都不動 —— 自檢第 ⑤ 列會去數它們還在不在。
 *
 * ★★★ 為什麼不是改 258 重跑:258 的 policy 是
 *   `exception when duplicate_object then null` 包起來的，意思是
 *   「已經有了就跳過」。改內容再重跑**什麼都不會發生**，
 *   而且會給你一張全綠的自檢表 —— 那比報錯糟。
 */

create temp table if not exists _m259_test (ord int, name text, detail text, verdict text);

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
          else '⚠ 跟 258 留下的不一樣（該是 6 ＋ 3）—— 多出來的這支不會動，但要看是誰加的' end);
end $do$;

begin;

/* ══════════════════════════════════════════════════════════
 * ① profiles 加一個「小編」欄位
 *
 * ★ 放在 profiles 不是 staff:RLS 認的是 `auth.uid()`，
 *   而那個值對到的是 `profiles.id`（lib/profile.tsx 就是 `.eq('id', user.id)`）。
 *   放在 staff 的話每次判斷都要多繞一次 join，而那一跳會被 staff 的 RLS 擋。
 * ══════════════════════════════════════════════════════════ */

alter table public.profiles
  add column if not exists is_social_editor boolean not null default false;

comment on column public.profiles.is_social_editor is
  '小編:可以編輯 IG 版面模擬（migration_259）。'
  '★ 預設 false —— 沒勾就不能編輯，只能讀。'
  '★★ 這是**一個人一個勾**不是一種權限:同樣是管家，有的人是小編有的不是。'
  '★★★ 總經理在「權限設定 → 人員」那一欄勾。';


/* ══════════════════════════════════════════════════════════
 * ② can_edit_social()：整個功能只有這一份規則
 * ══════════════════════════════════════════════════════════ */

create or replace function public.can_edit_social()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select p.role = 'super_admin' or p.is_social_editor
       from public.profiles p
      where p.id = auth.uid()),
    false)
$fn$;

comment on function public.can_edit_social() is
  '誰改得動 IG 版面模擬:小編，或總經理（migration_259）。'
  '★ policy 與前端**共用這一份** —— 前端用 rpc 叫它決定按鈕能不能按。'
  '  同一條規則寫兩次的話，遲早會出現「畫面讓你按、存檔卻擋下來」。'
  '★★ security definer:policy 裡直接讀 profiles 會再被 profiles 自己的 RLS '
  '  檢查一次，讀不到就回 0 列 —— 而 0 列在這裡會被當成「不是小編」，'
  '  症狀是勾了卻還是不能編輯，而且沒有錯誤訊息。';


/* ══════════════════════════════════════════════════════════
 * ③ 三張表的「寫」改成問 can_edit_social()
 *   （「讀」不動 —— 258 訂的四種權限照舊）
 * ══════════════════════════════════════════════════════════ */

drop policy if exists social_accounts_write on public.social_accounts;
create policy social_accounts_write on public.social_accounts
  for all using (can_edit_social()) with check (can_edit_social());

drop policy if exists social_splits_write on public.social_splits;
create policy social_splits_write on public.social_splits
  for all using (can_edit_social()) with check (can_edit_social());

drop policy if exists social_posts_write on public.social_posts;
create policy social_posts_write on public.social_posts
  for all using (can_edit_social()) with check (can_edit_social());


/* ══════════════════════════════════════════════════════════
 * ④ storage：上傳與刪除也問同一支
 *
 * ★★★ 這一段**不能漏**。只改表不改 bucket 的話，症狀是:
 *   九宮格排得動、文案存得進去，但**照片一張都上傳不了** ——
 *   那看起來會像「這一頁壞了」，不像「權限沒開完」。
 * ══════════════════════════════════════════════════════════ */

drop policy if exists social_obj_write on storage.objects;
create policy social_obj_write on storage.objects
  for insert with check (bucket_id = 'social' and public.can_edit_social());

drop policy if exists social_obj_del on storage.objects;
create policy social_obj_del on storage.objects
  for delete using (bucket_id = 'social' and public.can_edit_social());

commit;


/* ── 自檢表 ─────────────────────────────────────────────── */

select v.ord, v."檢查", v."結果", v."判定" from (

  select t.ord, t.name, t.detail, t.verdict from _m259_test t

  union all
  select 1, '① profiles.is_social_editor',
         coalesce((select data_type || '　預設 ' || coalesce(column_default, '（無）')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'profiles'
                      and column_name = 'is_social_editor'), '★ 沒有這一欄'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'profiles'
                              and column_name = 'is_social_editor'
                              and column_default like '%false%')
              then '✅ 有，而且預設是 false'
              when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'profiles'
                              and column_name = 'is_social_editor')
              then '❌ 有，但預設不是 false —— 全公司都變小編了'
              else '❌ 沒有' end

  union all
  select 2, '② can_edit_social() 存在而且是 security definer',
         coalesce((select case when p.prosecdef then 'security definer' else '★ 不是 definer' end
                          || '　' || pg_get_function_result(p.oid)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'can_edit_social'), '★ 沒有這支函式'),
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = 'can_edit_social'
                              and p.prosecdef)
              then '✅ 有' else '❌ 沒有或不是 definer（勾了也會編輯不了）' end

  union all
  /*
   * ★★★ 這一列才是真的在驗事情。
   *   `pg_policies` 存的是**展開後的定義文字** —— 裡面有沒有
   *   `can_edit_social`，就是這支有沒有生效的唯一答案。
   *   只數條數不算數:258 留下的也是一樣的條數。
   */
  select 3, '③ 三張表的 write 都改成問 can_edit_social()',
         coalesce((select string_agg(policyname || ' '
                          || case when (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                                       ilike '%can_edit_social%' then '✅' else '❌ 還是舊的' end,
                          '　' order by tablename)
                     from pg_policies
                    where schemaname = 'public'
                      and policyname in ('social_accounts_write', 'social_splits_write',
                                         'social_posts_write')), '★ 一條都沒有'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and policyname in ('social_accounts_write', 'social_splits_write',
                                          'social_posts_write')
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                           ilike '%can_edit_social%') = 3
              then '✅ 3/3' else '❌' end

  union all
  select 4, '④ storage 的上傳與刪除也問同一支',
         coalesce((select string_agg(policyname || ' '
                          || case when (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                                       ilike '%can_edit_social%' then '✅' else '❌ 還是舊的' end,
                          '　' order by policyname)
                     from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname in ('social_obj_write', 'social_obj_del')),
                  '★ 一條都沒有 —— 照片會上傳不了'),
         case when (select count(*) from pg_policies
                     where schemaname = 'storage' and tablename = 'objects'
                       and policyname in ('social_obj_write', 'social_obj_del')
                       and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                           ilike '%can_edit_social%') = 2
              then '✅ 2/2' else '❌' end

  union all
  /*
   * ★★ 「讀」那三條沒有動過，要證明它沒有被順手改壞 ——
   *   一條看門的規則安靜地變了，比它壞掉更難發現。
   */
  select 5, '⑤ 讀的那三條沒被動到（258 訂的四種權限）',
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
  select 6, '⑥ storage.objects 上別的 policy 還在幾條',
         coalesce((select count(*)::text || ' 條：'
                          || string_agg(policyname, '　' order by policyname)
                     from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname not like 'social\_obj\_%'), '★ 一條都沒有'),
         case when (select count(*) from pg_policies
                     where schemaname = 'storage' and tablename = 'objects'
                       and policyname not like 'social\_obj\_%') > 0
              then '✅ 還在（請款單附件那幾條沒被動到）'
              else '⚠ 一條都沒有 —— 本來就有的話那是被誤刪了，馬上講' end

  union all
  /*
   * ⑦ 現在有幾個小編。
   *   ★ 這一列**要判定**，不能只當參考值（README:自檢的母體要判定）——
   *     跑完是 0 個是**正常的**（這支只開路，誰是小編由總經理決定），
   *     但要講出來,不然會有人以為自己已經設好了。
   */
  select 7, '⑦ 現在有幾個小編',
         coalesce((select count(*)::text from public.profiles where is_social_editor), '0') || ' 人'
         || '　│ 總經理 '
         || coalesce((select count(*)::text from public.profiles where role = 'super_admin'), '0') || ' 人',
         case when (select count(*) from public.profiles where is_social_editor) = 0
              then '⚠ 還沒有人被勾成小編 —— 目前只有總經理編輯得了。'
                   || '去「權限設定 → 人員」把芊那一列的「小編」打勾。'
              else '✅ 已經有小編了' end

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
