/*
 * 一次性-會計報表上傳者補成Cindy.sql　2026-09-18
 * 會計報表：之前那幾份沒有上傳者的，補成 Cindy
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「進資料庫改 之前上傳 是Cindy 上傳的」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 只補空的，不動已經有值的】
 *
 * 用 `coalesce(欄位, Cindy)` —— 已經有人的那幾筆一個字不動。
 * 無條件蓋過去的話，今天新傳的那幾份（本來就記著誰傳的）
 * 會被改成 Cindy，而**畫面上看不出來有東西被改掉**。
 *
 * ★ 所以這一支跑幾次結果都一樣（冪等）:第二次跑的時候
 *   已經沒有 null 了，掃不到、不做事。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 名字對不到就整支停下來】
 *
 * `profiles.name` 叫「Cindy」的**必須剛好一個**。
 * 零個 → 名字可能不是這樣拼（Cindy／辛蒂／王小明…）;
 * 兩個以上 → 我挑不出來是哪一個。
 * 兩種情況都 `raise exception`，錯誤訊息會**把候選名單印出來**，
 * 貼回對話裡我改成指名道姓的 id。
 *
 * ★ 猜一個填進去的話，那幾筆會掛在錯的人頭上，
 *   而畫面看起來完全正常（CLAUDE.md:對不上的不猜）。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
declare
  v_id   uuid;
  v_n    int;
  v_list text;
begin
  select count(*) into v_n from public.profiles where btrim(name) = 'Cindy';

  if v_n <> 1 then
    select coalesce(string_agg(name, '、' order by name), '（一個都沒有）')
      into v_list
      from public.profiles
     where name ilike '%cindy%' or name ilike '%辛%';

    raise exception
      '叫「Cindy」的有 % 個，不是剛好 1 個 —— 整支停下來沒有改任何東西。'
      '長得像的名字有：%。把這句話貼回對話裡，我改成指名道姓的 id。',
      v_n, v_list;
  end if;

  select id into v_id from public.profiles where btrim(name) = 'Cindy';

  /*
   * ★★★ `coalesce` —— 只補 null，已經有值的一個字不動。
   */
  update public.accounting_reports
     set created_by = coalesce(created_by, v_id),
         updated_by = coalesce(updated_by, v_id)
   where created_by is null or updated_by is null;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  /*
   * ★★★ 母體要判定（CLAUDE.md 2026-09-03）——
   *   一份都沒有的話，下面每一條都會自動成立。
   */
  select 1 as ord, '★★★ ① 一共有幾份報表' as "檢查",
         (select count(*)::text || ' 份' from public.accounting_reports) as "結果",
         case when (select count(*) from public.accounting_reports) = 0
              then '⚠ 一份都沒有 —— 下面全部不算數'
              else '✅ 有東西可以檢查' end as "判定"

  union all
  /*
   * ★★★ 問的是**結果對不對**（還有沒有空的），
   *   不是「這次改了幾列」—— 後者跑第二次會變 0，看起來像壞掉
   *   （CLAUDE.md 2026-09-05）。跑第十次答案都一樣。
   */
  select 2, '★★★ ② 還有沒有沒填上傳者的',
         (select count(*)::text || ' 份'
            from public.accounting_reports
           where created_by is null or updated_by is null),
         case when (select count(*) from public.accounting_reports
                     where created_by is null or updated_by is null) = 0
              then '✅ 都有人了 —— 清單上不會再出現那個空白'
              else '❌ 還有空的' end

  union all
  /*
   * ★★ 誰名下有幾份。**這一列要你自己看一眼** ——
   *   Cindy 的份數應該等於「之前那幾份」＋「她自己傳的那幾份」。
   *   多出來的話就是 coalesce 沒擋住（不該發生，但看得到比較安心）。
   */
  select 3, '★★ ③ 每個人名下各幾份（自己看一眼對不對）',
         coalesce((select string_agg(nm || ' ' || c::text || ' 份', '、' order by c desc, nm)
                     from (select coalesce(p.name, '（查不到這個人）') as nm, count(*) as c
                             from public.accounting_reports r
                             left join public.profiles p on p.id = r.created_by
                            group by 1) g), '（沒有資料）'),
         '參考 —— ✅／❌ 看上面兩列'

  union all
  /*
   * ★ Cindy 這個人真的存在、而且只有一個。
   */
  select 4, '④ 叫 Cindy 的剛好一個嗎',
         (select count(*)::text || ' 個' from public.profiles where btrim(name) = 'Cindy'),
         case when (select count(*) from public.profiles where btrim(name) = 'Cindy') = 1
              then '✅' else '❌ 不是 1 個 —— 上面那段應該已經擋下來了' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
