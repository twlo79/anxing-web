// 判斷一段留言「是不是已經是中文」。
//
// ★ 這裡原本三個檔案各寫一次 `/[一-鿿]/`(translate 那支還寫成 `/[一-鿿]/`,
//   同一條規則兩種寫法)。那個區間是 CJK 統一表意文字 —— **日文漢字也在裡面**。
//   於是日文留言被判成「已經是中文」,永遠不會進待翻清單,畫面上就一直是日文原文,
//   而且沒有任何地方會叫(2026-09-07 踩到:輝代那筆日文評價匯入後沒翻譯)。
//
// 分辨中文與日文靠的是**假名**,不是漢字:
//   平假名/片假名 → 日文;諺文 → 韓文;都沒有而有漢字 → 中文。
//
// 假名比例而不是「有沒有假名」:中文留言偶爾夾一個外來語片假名
//   (「住ドンキ附近很方便」),用存在與否判斷會把它永遠標成待翻,
//   翻譯端看它已經是中文又跳過 —— 一筆永遠清不掉的誤報。
//   誤報會把真警報淹掉,所以這裡用比例。

const RE_HAN = /[一-鿿㐀-䶿]/g; // 漢字(中日共用)
const RE_KANA = /[぀-ゟ゠-ヿ]/g; // 平假名 + 片假名
const RE_HANGUL = /[가-힯ᄀ-ᇿ]/; // 諺文

// 假名佔「假名+漢字」的比例達到這個值就當日文。
// 實測:日文散文在 0.4 以上(連漢字最多的「大変満足致しました」都有 0.44);
// 中文夾一個片假名店名(「住在ドンキホーテ附近⋯」)是 0.19。0.25 落在中間。
//
// 已知極限:全部是漢字、一個假名都沒有的日文短句(「大満足」)分不出來,
// 會被當成中文。那種長度的留言翻不翻差別不大,不為它增加誤報。
const KANA_RATIO = 0.25;

const count = (t: string, re: RegExp) => (t.match(re) || []).length;

/** 這段文字是不是中文(繁或簡)。日文、韓文、英文都回 false。 */
export function isChinese(t: string | null | undefined): boolean {
  if (!t || !t.trim()) return false;
  if (RE_HANGUL.test(t)) return false; // 諺文 → 韓文
  const kana = count(t, RE_KANA);
  const han = count(t, RE_HAN);
  if (han === 0) return false; // 沒漢字 → 英文/純假名/其他
  return kana / (kana + han) < KANA_RATIO;
}

/** 這段留言需不需要翻成中文。空字串不算(沒東西可翻)。 */
export function needsTranslation(t: string | null | undefined): boolean {
  return !!t && !!t.trim() && !isChinese(t);
}
