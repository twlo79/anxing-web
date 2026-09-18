/*
 * migration_271_url_by_service.sql　2026-09-17
 * 補 270 沒對到的網址：改照「服務名稱」認，不照整個標題比
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_270 要先跑完（你 2026-09-17 跑了）。
 *
 * ══════════════════════════════════════════════════════════
 * 【270 為什麼只對到 18 筆】
 *
 * 270 的回填是 `where b.title = seed.title` —— **整個標題完全相同**。
 * 而使用者在那之後把幾筆改名了：
 *
 *     帳號｜justwork            → 帳號｜justwork google
 *     社群｜安幸 FB             → 社群｜安幸 FB Estia
 *     社群｜時兆 IG             → 社群｜時兆 IG @shizhao.estia
 *     社群｜正隆官邸 IG         → 社群｜正隆官邸 IG @zhenglong.estia
 *     （新增）                   社群｜ESTIA IG @estia.residences.taipei
 *
 * 改名是對的 —— 標題本來就該寫清楚是哪一個帳號。
 * **錯的是我把回填綁在完整標題上**：那等於要求使用者永遠不要改名。
 *
 * ★★★ 這一支改成認**服務名稱**（FB／IG／Zoho／Google）。
 *   之後再怎麼改名，只要那幾個字還在就對得到。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼用詞邊界不用 ilike '%ig%'】
 *
 * `ilike '%ig%'` 會掃到 `Signal`、`config`、`Origin`⋯ 任何含 ig 的字。
 * 而**誤填一個網址不會報錯** —— 使用者點下去到一個不相干的網站，
 * 他會以為是那個服務搬家了。
 *
 * 所以用 `~* '(^|[^a-z])ig([^a-z]|$)'`：前後不可以是英文字母。
 * 跟 README 那條「掃約束用詞邊界 `\mqty\M` 不是 `ilike '%qty%'`」同一件事。
 *
 * ══════════════════════════════════════════════════════════
 * 【只填空的，而且一筆只配一條規則】
 *
 * ★ `coalesce(url,'') = ''` —— 人填過的一律不碰。
 * ★★ 規則有優先順序（`ord`），一筆標題就算同時像兩種也只會拿到一個網址。
 *   不排的話 `update ... from` 會隨機挑一列，而**每次跑結果可能不一樣**。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這兩筆我不猜】
 *
 *     安幸電子合約        不知道是哪一家（訊光？點點簽？）
 *     其他｜南10 網路     不知道是哪一台機器的管理介面
 *
 * 猜一個填進去的話，使用者點下去到一個不相干的網站 ——
 * 而他不會知道那是我猜的。自檢第 ④ 列會把它們列出來請他自己填。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】只填空的，第二次那幾列已經有值了 → 影響 0 列。
 * ══════════════════════════════════════════════════════════
 */

begin;

with rule(ord, pat, url) as (values
  /*
   * ★ 順序＝優先權。Zoho 與 Google 排在前面 ——
   *   「Zoho email」這種標題裡沒有 FB/IG，但先排掉比較不用想。
   */
  (1, '(^|[^a-z])zoho([^a-z]|$)',      'mail.zoho.com'),
  (2, '(^|[^a-z])google([^a-z]|$)',    'mail.google.com'),
  (3, '(^|[^a-z])(fb|facebook)([^a-z]|$)', 'www.facebook.com'),
  (4, '(^|[^a-z])(ig|instagram)([^a-z]|$)', 'www.instagram.com'),
  (5, '(^|[^a-z])airbnb([^a-z]|$)',    'www.airbnb.com.tw'),
  (6, '(^|[^a-z])agoda([^a-z]|$)',     'www.agoda.com'),
  (7, '(^|[^a-z])vrbo([^a-z]|$)',      'www.vrbo.com'),
  (8, '蝦皮',                           'shopee.tw'),
  (9, '酷澎',                           'www.tw.coupang.com'),
  (10, '(^|[^a-z])ikea([^a-z]|$)',     'www.ikea.com.tw'),
  (11, '(^|[^a-z])dhl([^a-z]|$)',      'www.dhl.com'),
  (12, '(^|[^a-z])ez\s?way([^a-z]|$)', 'www.ezway.com.tw'),
  (13, '綠界',                          'www.ecpay.com.tw'),
  (14, '電子發票整合平台',               'www.einvoice.nat.gov.tw'),
  (15, '工商憑證',                       'moeaca.nat.gov.tw'),
  (16, '591',                           'www.591.com.tw'),
  (17, '(^|[^a-z])apple([^a-z]|$)',    'appleid.apple.com'),
  (18, '(^|[^a-z])ring([^a-z]|$)',     'account.ring.com')
),
pick as (
  /*
   * ★★ 一筆只配一條:`distinct on (b.id)` ＋ `order by ord`。
   *   不加的話同一筆會被更新好幾次，而**最後留下哪一個是隨機的**。
   */
  select distinct on (b.id) b.id, r.url
    from public.board_secrets b
    join rule r on b.title ~* r.pat
   where coalesce(b.url, '') = ''          -- ★ 人填過的不碰
   order by b.id, r.ord
)
update public.board_secrets b
   set url = pick.url
  from pick
 where pick.id = b.id;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('271_url_by_service');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢　★★★ 一樣不印任何密碼
-- ══════════════════════════════════════════════════════════

with s as (
  select title, account, secret, url, note,
         case when position('｜' in title) > 0
              then split_part(title, '｜', 1) else '' end as cat
    from public.board_secrets
),
/*
 * ★★ 「本來就不該有網址」的那幾種。統編、電話、WiFi、身分證、
 *   標語、集運注意事項 —— 它們不是登入用的。
 *   沒有這一份的話，第 ③ 列會把它們算成「還沒填」而永遠紅。
 */
noweb as (
  select title from s
   where cat = '公司資料'
      or title ~ '(WiFi|wifi|集運|統編|統一編號|電話|身分證|標語)'
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 271) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 母體：帳密共幾列' as "檢查",
         (select count(*)::text from s) || ' 列' as "結果",
         case when (select count(*) from s) = 0
              then '⚠ **一列都沒有 —— 下面全部不算數**'
              else '參考' end as "判定"

  union all
  select 2, '② 有網址的',
         (select count(*) filter (where coalesce(btrim(url), '') <> '') from s)::text
         || ' 筆　│ 沒有的 '
         || (select count(*) filter (where coalesce(btrim(url), '') = '') from s)::text || ' 筆',
         case when (select count(*) from s) = 0 then '⚠ 母體是空的,不算數'
              else '參考 —— 第 ③ 列在判它' end

  union all
  /*
   * ★★★ 這一列是這支的目的:**「該有網址卻沒有」的剩幾筆**。
   *   不是問「有幾筆有網址」—— 那個數字永遠到不了 100%,
   *   因為統編、電話那些本來就沒有（README:母體要問對）。
   */
  select 3, '③ 還有幾筆「該有卻沒有」',
         (select count(*) from s
           where coalesce(btrim(url), '') = ''
             and title not in (select title from noweb))::text || ' 筆',
         case when (select count(*) from s) = 0 then '⚠ 母體是空的,不算數'
              when (select count(*) from s
                     where coalesce(btrim(url), '') = ''
                       and title not in (select title from noweb)) = 0
              then '✅ 都填好了'
              else '⚠ 還有幾筆 —— 看第 ④ 列,那幾個服務我不認得,請自己填' end

  union all
  /*
   * ★★ 列出來而不是只給數字。
   *   「安幸電子合約」「南10 網路」我**不知道**是哪一家 ——
   *   猜一個填進去的話使用者會點到不相干的網站,而他不知道那是我猜的。
   */
  select 4, '④ 那幾筆是哪些（請自己填網址）',
         coalesce((select string_agg(title, E'\n' order by title) from s
                    where coalesce(btrim(url), '') = ''
                      and title not in (select title from noweb)), '（沒有）'),
         '參考 —— 在畫面上點進去按「編輯」填網址就好'

  union all
  /*
   * ★ 本來就不該有網址的那幾筆。印出來是為了讓人確認
   *   「這幾筆沒有網址是對的」,而不是默默地把它們排除掉。
   */
  select 5, '⑤ 本來就沒有網址的（這是對的）',
         (select count(*)::text from noweb) || ' 筆：'
         || coalesce((select string_agg(title, '　' order by title) from noweb), ''),
         '參考 —— 統編、電話、WiFi、身分證那種不是拿來登入的'

  union all
  select 6, '⑥ 還有幾筆未分類',
         (select count(*) filter (where cat = '') from s)::text || ' 筆'
         || coalesce((select '：' || string_agg(title, '　') from s where cat = ''), ''),
         case when (select count(*) filter (where cat = '') from s) > 0
              then '⚠ 未分類的排在清單最後面 —— 在畫面上編輯挑一個類別就歸位'
              else '✅ 每一筆都有類別' end

  union all
  /*
   * ★★ 有沒有被填成同一個網址而其實不該一樣的。
   *   FB 那幾筆都是 www.facebook.com 是對的（同一個站不同帳號），
   *   所以這一列只報數不判錯 —— 但要看得到。
   */
  select 7, '⑦ 同一個網址被幾筆共用',
         coalesce((select string_agg(url || ' × ' || n, '　' order by n desc, url)
                     from (select url, count(*) as n from s
                            where coalesce(btrim(url), '') <> ''
                            group by url having count(*) > 1) d), '（沒有重複的）'),
         '參考 —— 同一個站不同帳號本來就會重複（FB、IG、Google）'

  union all
  select 8, '⑧ 200～271 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '271_url_by_service'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '271_url_by_service')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
