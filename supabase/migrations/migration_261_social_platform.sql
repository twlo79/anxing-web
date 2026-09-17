/*
 * migration_261_social_platform.sql　2026-09-17
 * 社群模擬：分成 IG 跟 FB
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *            自檢在 commit 後面，成功就一定看得到。把錯誤訊息整段貼回來。
 *          ★★ migration_259_social_editor 要先跑完（你 2026-09-17 跑了）。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-17：「改成社群模擬」「分成 IG 跟 FB」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ platform 預設一定要是 'ig'，不能留 null】
 *
 * 現在那 2 個帳號本來就是 IG，不是「還沒設定」。
 *
 *   留 null 的話，前端照 platform 分組時它們**兩邊都不會出現** ——
 *   畫面上是一個很正常的「還沒有帳號」，沒有任何錯誤訊息，
 *   而使用者看到的是「跑完 migration 帳號不見了」。
 *
 * ★ `add column ... not null default 'ig'` 會把現有的列一起填掉。
 *   自檢第 ③ 列會數還有沒有漏的。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ social_posts.images 是新的一欄，不是拿來取代 image_path】
 *
 *   IG　一則 ＝ 一格 ＝ **一張圖**（切圖是把一張原圖切成 N 片,
 *       每一片還是一格一張）→ 繼續用 `image_path`
 *   FB　一則 ＝ **一張拼貼**，N 張圖擠在一起 → 用 `images text[]`
 *
 * ★ 這不是「同一份資料存兩個地方」（README 那條坑）——
 *   是兩個平台本來就不同形狀的東西。同一則貼文只會用其中一支:
 *   帳號是 IG 就讀 image_path，是 FB 就讀 images。
 *
 * ★★ 所以**帳號建好之後不給改平台**（前端擋）。
 *   改了的話，那個帳號底下的貼文會突然去讀另一支空的欄位 ——
 *   照片沒有不見，但畫面上全部變成空格，而且不會有錯誤。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支不刪任何東西】
 *
 * 只 add column。沒有 drop、沒有 update 既有資料的內容、
 * 沒有動 policy。跑兩次第二次會被 `if not exists` 擋掉，結果一樣。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ── ① 帳號：平台、封面照、類別 ──────────────────────────

alter table public.social_accounts
  add column if not exists platform text not null default 'ig';

alter table public.social_accounts
  add column if not exists cover_path text;

alter table public.social_accounts
  add column if not exists category text;

comment on column public.social_accounts.platform is
  '這個帳號是哪個平台：ig / fb。'
  '★ 不給改 —— 貼文的照片欄位是照平台分的（IG 讀 image_path、FB 讀 images），'
  '改了的話底下的貼文會讀到空的那一支，畫面全空而且不報錯。';

comment on column public.social_accounts.cover_path is
  '封面照，storage 的 social bucket。FB 粉專用，IG 沒有這個東西。'
  '★ 它佔掉 FB 第一屏一半,不畫的話「整體感覺」就是錯的。';

comment on column public.social_accounts.category is
  '檔案頭上那一行類別（例：Serviced Apartments）。純顯示。';

/*
 * ★★ check 約束 —— 擋掉打錯字。
 *   沒有它的話，前端寫進一個 'Facebook'（而不是 'fb'），
 *   那個帳號一樣會在兩邊都消失，而且不報錯。
 *
 * ★ 用 exception 包起來:SQL Editor 把整份腳本包在一個交易裡，
 *   重跑時「約束已存在」會讓**整支回滾**（README §7）。
 */
do $do$ begin
  alter table public.social_accounts
    add constraint social_accounts_platform_chk check (platform in ('ig', 'fb'));
exception when duplicate_object then null;
end $do$;

-- ── ② 貼文：FB 的多張照片 ──────────────────────────────

/*
 * ★ 預設是 '{}' 不是 null —— 空陣列與 null 在畫面上是同一件事
 *   （「沒有照片」），但在程式裡不是:`.length` 對 null 會炸。
 *   資料庫先選好形狀，前端就不用每個地方判一次
 *   （2026-09-03 的 expenses.tags 踩過反過來的版本）。
 */
alter table public.social_posts
  add column if not exists images text[] not null default '{}';

comment on column public.social_posts.images is
  'FB 拼貼的照片，順序就是拼貼的順序。storage 的 social bucket。'
  '★ IG 的貼文不用這一欄（IG 一格一張，走 image_path）。'
  '★★ FB 只有前 5 張看得到,第 6 張以後蓋在「+N」底下 —— lib/social-fb.ts。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('261_social_platform');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with cols as (
  /* ★ 一定要帶 table_schema='public' —— 別的 schema 也有同名的表（README） */
  select table_name::text as t, column_name::text as c,
         data_type::text as ty, is_nullable::text as nul,
         coalesce(column_default, '')::text as def
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('social_accounts', 'social_posts')
),
acc as (
  select
    count(*) as n,
    count(*) filter (where platform = 'ig') as ig,
    count(*) filter (where platform = 'fb') as fb,
    count(*) filter (where platform is null) as nul
  from public.social_accounts
),
pol as (
  select count(*) as n from pg_policies
  where schemaname = 'public' and tablename like 'social\_%'
)

select * from (

  select 1 as ord, '① 帳號的三個新欄位' as "檢查",
         coalesce((select string_agg(c || '（' || ty || '）', '　' order by c)
                     from cols where t = 'social_accounts'
                      and c in ('platform', 'cover_path', 'category')),
                  '★ 一個都沒有') as "結果",
         case when (select count(*) from cols where t = 'social_accounts'
                     and c in ('platform', 'cover_path', 'category')) = 3
              then '✅ 3/3' else '❌ 沒加完' end as "判定"

  union all
  select 2, '② platform 不可為空、預設 ig',
         coalesce((select 'is_nullable=' || nul || '　default=' || def
                     from cols where t = 'social_accounts' and c = 'platform'),
                  '★ 這一欄不存在'),
         case when exists (select 1 from cols
                            where t = 'social_accounts' and c = 'platform'
                              and nul = 'NO' and def like '%ig%')
              then '✅ 現有的列會被填成 ig'
              else '❌ 可為空或沒有預設 —— 帳號會在兩個平台底下都消失' end

  union all
  /*
   * ★★★ 這一列是這支的**母體**，一定要判定。
   *   帳號數是 0 的話，下面每一條「都是 ig」都自動成立 ——
   *   六個綠勾讓人以為做完了（2026-09-03 踩過 migration_210 那次）。
   */
  select 3, '③ 現有帳號都分到平台了嗎',
         '共 ' || (select n from acc) || ' 個帳號　│ ig ' || (select ig from acc)
         || '　fb ' || (select fb from acc) || '　空白 ' || (select nul from acc),
         case when (select n from acc) = 0
              then '⚠ 一個帳號都沒有 —— 沒有東西可以檢查，下面那幾條不算數'
              when (select nul from acc) > 0
              then '❌ 有 ' || (select nul from acc) || ' 個沒有平台 —— 它們在畫面上會消失'
              when (select ig from acc) = (select n from acc)
              then '✅ 全部是 ig（本來就是 IG 帳號，對的）'
              else '✅ 都有平台' end

  union all
  select 4, '④ 打錯字擋得住嗎（check 約束）',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.social_accounts'::regclass
                      and conname = 'social_accounts_platform_chk'),
                  '★ 沒有這條約束'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.social_accounts'::regclass
                              and conname = 'social_accounts_platform_chk')
              then '✅ 寫進 Facebook 之類的值會被擋下來'
              else '❌ 沒擋 —— 打錯的帳號會安靜地在兩邊都消失' end

  union all
  select 5, '⑤ 貼文的 images 欄位',
         coalesce((select c || '（' || ty || '）　is_nullable=' || nul
                          || '　default=' || def
                     from cols where t = 'social_posts' and c = 'images'),
                  '★ 這一欄不存在'),
         case when exists (select 1 from cols
                            where t = 'social_posts' and c = 'images'
                              and ty = 'ARRAY' and nul = 'NO')
              then '✅ text[] 且不可為空（預設空陣列，前端不用每次判 null）'
              else '❌ 沒加到或可為空' end

  union all
  /*
   * ★★ 「讀」那幾條 policy 沒有動過,要證明它沒被順手改壞 ——
   *   一條看門的規則安靜地變了，比它壞掉更難發現（259 的自檢同一個理由）。
   *   ★ 掃 like 'social\_%' 不列表名 —— 列表名會漏掉沒看過的那幾條（README）。
   */
  select 6, '⑥ social 的 policy 還在幾條',
         (select n from pol)::text || ' 條',
         case when (select n from pol) > 0
              then '✅ 還在（這支只 add column，本來就不該動到）'
              else '⚠ 一條都沒有 —— 那是被誤刪了，馬上講' end

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '261_social_platform'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '261_social_platform')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
