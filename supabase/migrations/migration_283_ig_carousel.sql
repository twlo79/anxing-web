/*
 * migration_283_ig_carousel.sql　2026-09-18
 * 社群模擬：IG 一則可以放多張圖（照片全部搬到 `images` 這一欄）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「可以放多張圖片 像 IG 一則貼文可以放多張滑過去」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一支只搬資料，沒有新欄位】
 *
 * `social_posts.images text[]` 本來就在（migration_261，FB 拼貼用的）。
 * IG 走的是 `image_path` —— 同一件事兩個地方存。
 *
 * 這一支把 `image_path` 的值搬進 `images`，之後:
 *
 *     寫　只寫 `images`
 *     讀　只走 `photosOf()`（fb-wall.tsx，全站唯一一份）
 *
 * ★★ `image_path` **不刪也不清空**。它是保險絲 ——
 *   `photosOf()` 在 `images` 是空的時候會退回去讀它，
 *   所以萬一這支哪一列沒搬到，那一則的照片也不會不見。
 *   （2026-09-03 `hk_day.rooms_override` 踩過反過來的版本:
 *     欄位不存在、`select('*')` 只回 undefined，一聲都不叫。）
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不加「最多 10 張」的 check】
 *
 * 10 張是 **IG 自己的限制**。FB 用同一欄而且沒有這個上限
 * （拼貼只露前 5 張，其餘照樣存著）。
 * 加在欄位上的話，FB 那邊會莫名其妙存不進第 11 張，
 * 而錯誤訊息是一句看不懂的 `violates check constraint`。
 *
 * ★ 上限擋在 `lib/social-carousel.ts`（只有 IG 的畫面呼叫），有測試。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】
 *   條件是「`images` 還是空的」——
 *   第二次跑的時候已經不空了，所以掃不到、不做事。
 * ══════════════════════════════════════════════════════════
 */

begin;

/*
 * ★★★ 只搬「`images` 是空的」那些。
 *   不加這個條件的話，FB 那些已經有好幾張的會被壓成一張 ——
 *   而那是**真的把資料弄丟**，不是顯示問題。
 *
 * ★ `coalesce(array_length(images,1), 0) = 0` 同時涵蓋 null 與 '{}'。
 *   `images = '{}'` 這樣比對在 null 上會回 null（不是 false），
 *   於是那幾列安靜地掃不到。
 */
update public.social_posts
   set images = array[image_path]
 where image_path is not null
   and btrim(image_path) <> ''
   and coalesce(array_length(images, 1), 0) = 0;

comment on column public.social_posts.images is
  '這一則的照片,照順序。第 1 張是封面(九宮格上顯示的那一張)。'
  '★★★ 讀一律走 photosOf()(fb-wall.tsx,全站唯一一份):'
  '  images 有東西就用它,空的才退回 image_path。'
  '★★ FB 拼貼與 IG 輪播**共用這一欄**(migration_283)。'
  '  IG 上限 10 張是 IG 自己的限制,擋在 lib/social-carousel.ts,'
  '  **沒有**寫成 check —— FB 沒有這個上限。';

comment on column public.social_posts.image_path is
  '舊的單張照片欄位。migration_283 之後**不再是真實來源** —— 照片存在 images。'
  '★ 留著當保險絲:photosOf() 在 images 是空的時候會退回來讀它,'
  '  所以萬一有哪一列沒搬到,那一則的照片也不會不見。'
  '★★ 不要再寫這一欄。寫了的話同一張圖存在兩個地方,'
  '  改了一邊另一邊留在原地(migration_195 那條坑)。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('283_ig_carousel');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  /*
   * ★★★ 母體要判定。一則都沒有的話下面每一條都會自動成立，
   *   而三個綠勾會讓人以為做完了（CLAUDE.md 2026-09-03）。
   */
  select 1 as ord, '★★★ ① 一共有幾則貼文' as "檢查",
         (select count(*)::text || ' 則' from public.social_posts) as "結果",
         case when (select count(*) from public.social_posts) = 0
              then '⚠ 一則都沒有 —— 下面全部不算數'
              else '✅ 有東西可以檢查' end as "判定"

  union all
  /*
   * ★★★ 這一列問的是**結果對不對**（還有沒有搬漏的），
   *   不是「這次跑改了幾列」—— 後者跑第二次會變 0，看起來像壞掉
   *   （CLAUDE.md 2026-09-05）。跑第十次答案都一樣。
   */
  select 2, '★★★ ② 還有沒有「有 image_path 但 images 是空的」',
         (select count(*)::text || ' 則'
            from public.social_posts
           where image_path is not null and btrim(image_path) <> ''
             and coalesce(array_length(images, 1), 0) = 0),
         case when (select count(*) from public.social_posts
                     where image_path is not null and btrim(image_path) <> ''
                       and coalesce(array_length(images, 1), 0) = 0) = 0
              then '✅ 都搬完了'
              else '❌ 還有沒搬到的 —— 那幾則現在靠 photosOf() 的保險絲在撐' end

  union all
  /*
   * ★★★ **搬不可以把資料弄少**。
   *   這一列數的是「有照片的則數」——
   *   搬之前跟搬之後應該一模一樣（搬只是換一個欄位放）。
   */
  select 3, '★★ ③ 有照片的則數（搬前搬後要一樣）',
         (select count(*) filter (
                   where coalesce(array_length(images, 1), 0) > 0
                      or (image_path is not null and btrim(image_path) <> ''))::text
                 || ' 則有照片，共 '
                 || coalesce(sum(coalesce(array_length(images, 1), 0)), 0)::text || ' 張'
            from public.social_posts),
         case when (select count(*) from public.social_posts) = 0
              then '⚠ 沒有東西可檢查'
              else '✅ 這個數字要跟你印象中的一樣 —— 變少就是搬壞了' end

  union all
  /*
   * ★★★ FB 那些本來就有好幾張的**不可以被壓成一張**。
   *   這一列數的是「images 有兩張以上」的則數 ——
   *   搬之前是幾則，搬完還要是幾則（甚至更多，因為 IG 開始用了）。
   */
  select 4, '★★★ ④ 多圖的則數（FB 拼貼不可以被壓扁）',
         (select count(*)::text || ' 則有兩張以上，最多的那一則 '
                 || coalesce(max(array_length(images, 1)), 0)::text || ' 張'
            from public.social_posts
           where coalesce(array_length(images, 1), 0) > 1),
         case when (select count(*) from public.social_posts
                     where coalesce(array_length(images, 1), 0) > 1) = 0
              then '⚠ 一則多圖都沒有 —— FB 如果本來有拼貼，那就是被壓扁了，回頭查'
              else '✅ 多圖還在' end

  union all
  /*
   * ★ `images` 裡不該有空字串。有的話畫面上會出現一格永遠讀不到的破圖。
   */
  select 5, '⑤ images 裡有沒有空字串',
         (select count(*)::text || ' 則'
            from public.social_posts
           where exists (select 1 from unnest(coalesce(images, '{}')) x
                          where x is null or btrim(x) = '')),
         case when (select count(*) from public.social_posts
                     where exists (select 1 from unnest(coalesce(images, '{}')) x
                                    where x is null or btrim(x) = '')) = 0
              then '✅ 沒有'
              else '❌ 有 —— 那幾格會是讀不到的破圖' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '283_ig_carousel'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '283_ig_carousel')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
