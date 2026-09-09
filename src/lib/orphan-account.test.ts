import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  orphanAction, orphanActionLabel, orphanConfirmText, normName,
  type StaffLite,
} from './orphan-account.ts';

/**
 * 孤兒登入帳號。
 *
 * 【這支在防什麼】
 * 接錯人的後果是**那個帳號變成別人的權限**，而畫面上完全看不出來。
 * 所以「什麼時候可以自動接」這條界線要有測試釘住。
 */

const S = (o: Partial<StaffLite> = {}): StaffLite => ({
  id: 's1', name: '月', auth_uid: null, active: true, ...o,
});
const P = { id: 'p1', name: '月', role: 'housekeeper' };

describe('★★★ 孤兒帳號要怎麼處理', () => {
  test('★★★ 剛好一個同名、沒接帳號 → 接到他身上', () => {
    const a = orphanAction(P, [S(), S({ id: 's2', name: '花', auth_uid: 'u2' })]);
    assert.equal(a.kind, 'link');
    assert.equal(a.kind === 'link' && a.staff.id, 's1');
  });

  test('★★★ 離職的也算候選 —— 「月」正是離職之後帳號被撤銷剩下殘留', () => {
    /*
     * 2026-09-09 使用者:「月以前是管家 離職後把帳號撤銷了」。
     * 不接上去的話那筆殘留刪不掉（刪除帳號要 staff.auth_uid 有值）。
     */
    const a = orphanAction(P, [S({ active: false })]);
    assert.equal(a.kind, 'link');
  });

  test('★★★ 已經有帳號的同名者不是候選 —— 接上去會蓋掉他原本那個', () => {
    const a = orphanAction(P, [S({ auth_uid: 'other-uid' })]);
    assert.equal(a.kind, 'create');
  });

  test('★★★ 兩個以上同名而且都沒接 → 不要猜', () => {
    /*
     * 猜錯 = 帳號變成別人的權限，而畫面上看不出來。
     * `CLAUDE.md`：對不上的不猜。
     */
    const a = orphanAction(P, [S(), S({ id: 's2' })]);
    assert.equal(a.kind, 'ambiguous');
    assert.equal(a.kind === 'ambiguous' && a.candidates.length, 2);
  });

  test('名冊上沒有這個人 → 補進名冊', () => {
    assert.equal(orphanAction(P, [S({ name: '花' })]).kind, 'create');
  });

  test('★★ 帳號沒有名字 → 只能補進名冊，不要跟空字串比對', () => {
    // 用 '' 去比的話，名冊上任何沒名字的人都會被當成同一個人
    const a = orphanAction({ id: 'p9', name: null, role: null }, [S({ name: '' })]);
    assert.equal(a.kind, 'create');
  });

  test('★ 空白不算差異 —— 「月 」跟「月」是同一個人', () => {
    assert.equal(normName(' 月 '), '月');
    assert.equal(normName('月　'), '月');
    assert.equal(orphanAction({ ...P, name: ' 月 ' }, [S()]).kind, 'link');
  });

  test('★★ 不做模糊比對 —— 「小月」不是「月」', () => {
    assert.equal(orphanAction(P, [S({ name: '小月' })]).kind, 'create');
  });

  test('★★★ 按鈕上要寫出對象的名字', () => {
    // 不寫名字的話，按的人沒有機會發現接錯了
    const a = orphanAction(P, [S({ name: '月' })]);
    assert.equal(orphanActionLabel(a), '接到「月」身上');
    assert.equal(orphanActionLabel({ kind: 'create' }), '補進名冊');
  });

  test('★★ 確認文字要講會發生什麼，不是「確定嗎」', () => {
    const a = orphanAction(P, [S()]);
    const t = orphanConfirmText(P, a);
    assert.match(t, /改密碼、刪除帳號/);
    assert.match(t, /接錯人/);
  });

  test('★★ 接到離職的人身上時要講「不會讓他變回在職」', () => {
    const a = orphanAction(P, [S({ active: false })]);
    assert.match(orphanConfirmText(P, a), /不會讓他變回在職/);
  });

  test('★ 同名太多的時候，確認文字要說怎麼解', () => {
    const a = orphanAction(P, [S(), S({ id: 's2' })]);
    assert.match(orphanConfirmText(P, a), /先把其中一個改名/);
  });
});
