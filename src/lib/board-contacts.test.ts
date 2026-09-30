import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canWriteContacts, CONTACT_WRITE_ROLES, sortContacts, matchContact, telHref, mailHref,
  contactProblem, contactBody, type Contact,
} from './board-contacts.ts';

const c = (o: Partial<Contact>): Contact => ({
  id: 'x', name: '正隆股份有限公司', phone: '02-2345-6789', email: 'acc@zhenglong.com.tw',
  note: 'A 棟房東。窗口陳小姐（分機 12）', created_by: null, created_at: '', updated_by: null, updated_at: '', ...o,
});

describe('誰能寫', () => {
  test('會計、主管、總經理可以；管家、房務不行', () => {
    assert.deepEqual([...CONTACT_WRITE_ROLES], ['accountant', 'manager', 'super_admin']);
    for (const r of CONTACT_WRITE_ROLES) assert.equal(canWriteContacts(r), true);
    assert.equal(canWriteContacts('housekeeper'), false);
    assert.equal(canWriteContacts('cleaner'), false);
    assert.equal(canWriteContacts(null), false);
  });
});

describe('排序與搜尋', () => {
  test('照名字排（中文照筆畫：大 3 畫在王 4 畫前）', () => {
    const names = sortContacts([{ name: '王師傅' }, { name: 'ABC' }, { name: '大都會' }]).map((x) => x.name);
    assert.ok(names.indexOf('大都會') < names.indexOf('王師傅'));
    assert.equal(names.length, 3);
  });
  test('四個欄位都找；空關鍵字全部通過', () => {
    assert.equal(matchContact(c({}), ''), true);
    assert.equal(matchContact(c({}), '正隆'), true);
    assert.equal(matchContact(c({}), 'ZHENGLONG'), true);
    assert.equal(matchContact(c({}), '陳小姐'), true);
    assert.equal(matchContact(c({}), '水電'), false);
  });
  test('電話用純數字比：打 23456789 找得到 02-2345-6789；兩位數不算', () => {
    assert.equal(matchContact(c({}), '23456789'), true);
    assert.equal(matchContact(c({}), '2345 6789'), true);
    assert.equal(matchContact(c({}), '99'), false);
  });
});

describe('撥號與寄信連結', () => {
  test('市話、手機、分機', () => {
    assert.equal(telHref('02-2345-6789'), 'tel:0223456789');
    assert.equal(telHref('0912-345-678'), 'tel:0912345678');
    assert.equal(telHref('02-2345-6789 #12'), 'tel:0223456789;ext=12');
    assert.equal(telHref('02-2345-6789 分機12'), 'tel:0223456789;ext=12');
    assert.equal(telHref('+886 2 2345 6789'), 'tel:+886223456789');
  });
  test('不是電話的字不畫成可撥', () => {
    assert.equal(telHref('LINE 找她'), null);
    assert.equal(telHref(''), null);
    assert.equal(telHref(null), null);
  });
  test('email 要像 email', () => {
    assert.equal(mailHref(' acc@zhenglong.com.tw '), 'mailto:acc@zhenglong.com.tw');
    assert.equal(mailHref('acc@'), null);
    assert.equal(mailHref(null), null);
  });
});

describe('存檔檢查', () => {
  const ok = { name: '王師傅', phone: '0933-111-222', email: '', note: '' };
  test('正常可存', () => assert.equal(contactProblem(ok), null));
  test('沒名字不行', () => assert.match(contactProblem({ ...ok, name: ' ' }) ?? '', /姓名／公司名/));
  test('email 壞掉不行', () => assert.match(contactProblem({ ...ok, email: 'abc' }) ?? '', /email/));
  test('三個欄位全空不行 —— 那筆什麼都查不到', () => assert.match(contactProblem({ name: 'x', phone: '', email: '', note: '' }) ?? '', /至少填一個/));
  test('只有備註可以（「LINE 找她」那種）', () => assert.equal(contactProblem({ name: 'x', phone: '', email: '', note: 'LINE' }), null));
  test('空字串存成 null、email 小寫', () => {
    assert.deepEqual(contactBody({ name: ' 王師傅 ', phone: '', email: 'A@B.COM', note: ' ' }),
      { name: '王師傅', phone: null, email: 'a@b.com', note: null });
  });
});
