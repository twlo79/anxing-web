/**
 * 選單要顯示哪幾項。
 *
 * ============================================================
 * 【為什麼獨立成一支 .ts】
 *
 * 原本這一行寫在 layout.tsx 裡:
 *
 *     NAV.filter((n) => !profile?.role || n.roles.includes(profile.role))
 *                       ^^^^^^^^^^^^^^
 *
 * 那個 `!profile?.role ||` 是**還在查的時候整份選單全開**。
 * 寫在 .tsx 裡的判斷式測不到（測試環境不處理 JSX），
 * 所以它錯了一整段時間都沒有人發現。
 *
 *
 * ============================================================
 * 【載入中要關起來，不是打開】（2026-08-22 使用者回報）
 *
 * 使用者的話:「管家進安幸每次都會讀權限，很不穩，容易有時不小心開放」。
 *
 * 症狀就是這個 —— 每次進站要先問 auth 再查 profiles，
 * 那 300～600ms 之間 `role` 是 null，於是**十七項全部顯示**:
 * 營收表、支出明細、帳戶明細、其他收支帳、權限管理。
 * 管家看得到、也點得進去（點進去是空的，因為 RLS 擋著）。
 *
 * 原本的註解說「少顯示會讓人以為功能不見了」—— 方向反了:
 *
 *   · 多顯示 300ms:管家看到「權限管理」四個字。他不知道那是載入中，
 *     他會以為自己有權限，然後問「為什麼點進去是空的」。
 *   · 少顯示 300ms:選單晚 300ms 出現。那是一次閃爍。
 *
 * **看到不該看的，比晚一點看到嚴重。** 所以 loading 一律回空陣列，
 * 畫面那邊顯示骨架而不是「沒有權限」——
 * 「沒有權限」那四個字會讓人以為自己被降權了。
 *
 * 至於那 300ms 的空白，解法不是把選單打開，是**把等待縮短**:
 * lib/profile.tsx 用 sessionStorage 記住上次查到的角色，
 * 下次進站第一畫格就有選單。
 *
 *
 * ============================================================
 * 【這不是安全機制】
 *
 * 藏起選單擋不住知道網址的人 —— 真正的權限在 RLS。
 * 這裡處理的是**誤會**:讓畫面說的話跟資料庫說的話一致。
 */

export type NavItem = {
  href: string;
  roles: string[];
  /**
   * 這一項屬於哪一群（2026-08-28，17 項之後）。
   *
   * ★ 空字串或沒填 = **只畫一條分隔線，不寫標題**。
   *   「系統」那一組（設定、權限管理）就是這樣 —— 它是「其餘」,
   *   而給「其餘」取一個名字反而要人多讀兩個字。
   */
  group?: string;
};

/**
 * 把選單切成一群一群。
 *
 * ============================================================
 * 【★★ 用「連續相同」分群，不是「收集同名」】
 *
 * 收集同名的話,有人在中間插一項 `group: '收入'`,
 * 它會被抓到上面那一群去 —— 而 NAV 陣列裡它明明在下面。
 * 順序應該完全由陣列決定,那是唯一一份可讀的真相。
 *
 *
 * ============================================================
 * 【★★ 整群被權限篩空時，標題也要跟著不見】
 *
 * `visibleNav` 會先照角色濾掉項目。管家看不到「支出」與「財務管理」那幾項,
 * 若標題還留著,他會看到一個**底下什麼都沒有的標題** ——
 * 那比不顯示更糟:它明說有這個東西,只是不給你。
 *
 * 所以這支只對**已經濾過**的清單分群,空的群自然不會產生。
 */
export function groupNav<T extends NavItem>(
  items: readonly T[],
): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = it.group ?? '';
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

/**
 * 這一群現在該不該把項目畫出來。
 *
 * ============================================================
 * 【★★ 收合狀態不是唯一的依據 —— 「我在哪」優先】
 *
 * 使用者收起「收入」，然後從別的地方（書籤、通知、或別頁的連結）
 * 進到 /shortterm。這時若照收合狀態畫，側邊欄會**完全看不出他在哪一頁** ——
 * 沒有任何一項是選取狀態，整條選單看起來像是進錯地方了。
 *
 * ★ 所以規則是:**目前所在的那一群一律展開**，不管有沒有被收起來。
 *   收合是「我平常不看這些」，不是「我不想知道自己在哪」。
 *
 * ★ 而且不去改存起來的收合狀態 —— 離開那一頁之後它要回到收起來的樣子。
 *   順手幫使用者「展開並記住」的話，他下次進來會發現自己收好的東西又開了。
 *
 * ============================================================
 * 【沒有標題的那一群不能收】
 *
 * 設定與權限管理那一組沒有標題（只有一條分隔線），
 * 沒有標題就沒有地方放那顆三角形 —— 收起來之後**打不開**。
 */
export function groupOpen<T extends NavItem>(
  group: { label: string; items: readonly T[] },
  collapsed: readonly string[],
  pathname: string,
): boolean {
  if (!group.label) return true;                       // 沒標題 = 收不了
  if (!collapsed.includes(group.label)) return true;   // 沒被收起來
  // 被收起來了，但目前這一頁在裡面 → 還是要開
  return group.items.some((n) => pathname.startsWith(n.href));
}

/** 按一下標題:有就拿掉、沒有就加上。回新陣列,不改原本那個。 */
export function toggleGroup(collapsed: readonly string[], label: string): string[] {
  return collapsed.includes(label)
    ? collapsed.filter((l) => l !== label)
    : [...collapsed, label];
}

/**
 * localStorage 讀回來的東西**不能信**。
 *
 * ★ 使用者手動改過、或舊版存的是別的形狀（例如物件），
 *   直接 `JSON.parse` 之後當陣列用，畫面會在 `.includes` 那一行整個掛掉 ——
 *   而那是側邊欄，掛掉等於**全站白畫面**。
 *
 * 所以解析失敗、不是陣列、或裡面有非字串的，一律當作「沒收合任何東西」。
 */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * @param role    profiles.role。查完了但沒設角色是 null
 * @param loading 還在查。**不要拿 role === null 當載入中**
 */
export function visibleNav<T extends NavItem>(
  items: readonly T[], role: string | null, loading: boolean,
): T[] {
  // 還在查 —— 先不給。見檔頭「載入中要關起來」
  if (loading) return [];
  /*
   * 查完了、但這個帳號沒有角色（新建帳號還沒指派）。
   * 一樣不給 —— 沒有角色就是沒有權限，而 RLS 那邊也是這樣看的
   * （current_role_of() 是 null，每一條 policy 都不成立）。
   */
  if (!role) return [];
  return items.filter((n) => n.roles.includes(role));
}

/**
 * 目前在哪一項。用 startsWith 而不是相等 —— /attendance/xxx 也要算在出勤。
 *
 * ★ 只在**看得到的項目**裡找。在 NAV 全表裡找的話，
 *   管家打 /revenues 時側邊欄會把「營收表」標成選取中，
 *   等於在畫面上承認那一頁存在。
 */
export function currentNav<T extends NavItem>(visible: readonly T[], pathname: string): T | undefined {
  return visible.find((n) => pathname.startsWith(n.href));
}
