/**
 * 孤兒登入帳號 —— 有帳號、名冊上沒有人接住它。
 *
 * ============================================================
 * 【這是什麼問題】
 *
 * 系統有兩張表:
 *
 *   profiles  登入帳號 —— 能不能登入、什麼權限
 *   staff     人員名冊 —— 權限管理那一頁列出來的人
 *
 * 正常情況一個人兩邊都有，靠 `staff.auth_uid` 牽起來。
 *
 * ★★★ 牽不起來的後果很具體:**那個人登得進系統、帶著權限，
 *   但權限管理頁上看不到他、改不了他、也停不掉他。**
 *   唯一提到他存在的地方是那塊橘色警告。
 *
 * ============================================================
 * 【★★ 為什麼要有這支，而不是叫人去跑 SQL】
 *
 * 原本畫面上寫的是「請執行補建 SQL(migration_31)」——
 * 那是寫給當時的開發者看的備忘，不是給使用者的指示。
 * 使用者看到只會問「我要做什麼、為什麼要跑 SQL」（2026-09-09 就是這樣問的）。
 *
 * 這一頁本來就該自己處理得了。
 *
 * ============================================================
 * 【三種情況，動作不一樣】
 *
 *   link       名冊上剛好有一個同名、而且還沒接帳號的人
 *              → 把帳號接到他身上。**最常見** ——
 *                多半是「這個人先建了名冊，帳號另外開的」
 *
 *   create     名冊上完全沒有這個人 → 用帳號的名字與權限補一列
 *
 *   ambiguous  名冊上有兩個以上同名而且都沒接帳號 → **不要猜**
 *              接錯人的話那個帳號變成別人的權限，
 *              而畫面上完全看不出來（`CLAUDE.md`:對不上的不猜）
 */

export type OrphanProfile = {
  id: string;
  name: string | null;
  role: string | null;
};

export type StaffLite = {
  id: string;
  name: string;
  auth_uid: string | null;
  active: boolean;
  staff_type?: string | null;
};

export type OrphanAction =
  | { kind: 'link'; staff: StaffLite }
  | { kind: 'create' }
  | { kind: 'ambiguous'; candidates: StaffLite[] };

/**
 * 名字比對前先正規化。
 *
 * ★ 只去頭尾空白與全形空白。**不做模糊比對** ——
 *   「月」跟「小月」是不是同一個人，只有人知道。
 *   猜錯的代價是把帳號接到別人身上。
 */
export const normName = (s: string | null | undefined) =>
  (s ?? '').replace(/[\s　]+/g, '').trim();

/**
 * 這個孤兒帳號該怎麼處理。
 *
 * ★★ 只考慮**還沒接帳號**的人。已經有帳號的同名者不是候選 ——
 *   一個人只能有一個登入帳號，接上去會蓋掉他原本那個。
 *
 * ★ 離職的**也算候選**。「月」就是離職之後帳號被撤銷、
 *   殘留一筆 profiles 的情況 —— 接上去才刪得掉那筆殘留。
 */
export function orphanAction(p: OrphanProfile, staff: StaffLite[]): OrphanAction {
  const want = normName(p.name);
  if (!want) return { kind: 'create' };
  const cands = (staff ?? []).filter((s) => !s.auth_uid && normName(s.name) === want);
  if (cands.length === 1) return { kind: 'link', staff: cands[0] };
  if (cands.length > 1) return { kind: 'ambiguous', candidates: cands };
  return { kind: 'create' };
}

/**
 * 按鈕上的字。
 *
 * ★★ 要把**對象的名字寫進按鈕**:「接到『月』身上」不是「接上」。
 *   接錯人的後果是那個帳號變成別人的權限，
 *   而按鈕上不寫名字的話，按的人沒有機會發現接錯了。
 */
export function orphanActionLabel(a: OrphanAction): string {
  switch (a.kind) {
    case 'link': return `接到「${a.staff.name}」身上`;
    case 'create': return '補進名冊';
    case 'ambiguous': return '名冊上有同名的人，先改名';
  }
}

/**
 * 按下去之前的確認文字。
 *
 * ★ 講**會發生什麼**，不是「確定嗎」。
 */
export function orphanConfirmText(p: OrphanProfile, a: OrphanAction): string {
  const who = p.name || '(未命名)';
  if (a.kind === 'link') {
    return `把登入帳號「${who}」接到名冊上的「${a.staff.name}」？\n\n`
      + `・接上之後，那一列就管得到這個帳號（改密碼、刪除帳號）\n`
      + `・${a.staff.active ? '' : '這個人目前是離職狀態 —— 接上去不會讓他變回在職。\n'}`
      + `・接錯人的話，這個帳號就變成那個人的權限。名字要核對清楚。`;
  }
  if (a.kind === 'create') {
    return `把登入帳號「${who}」補進人員名冊？\n\n`
      + `・會新增一列人員，職位預設「管家」，之後可以改\n`
      + `・這個帳號從此管得到，可以設為離職、改密碼、刪除`;
  }
  return `名冊上有 ${a.candidates.length} 個都叫「${who}」而且都還沒接帳號。\n\n`
    + `系統不猜要接哪一個 —— 接錯的話這個帳號會變成別人的權限。\n`
    + `請先把其中一個改名，再回來接。`;
}
