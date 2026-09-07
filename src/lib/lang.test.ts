import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChinese, needsTranslation } from './lang.ts';

test('中文判成中文', () => {
  assert.equal(isChinese('地理位置非常好。房東非常友善且熱心助人。'), true);
  assert.equal(isChinese('房间宽敞舒适，交通方便'), true); // 簡體
  assert.equal(isChinese('再次很愉快的住宿 😁'), true); // 夾 emoji
  assert.equal(isChinese('入住A6，還不錯'), true); // 夾英數
});

test('日文不算中文 —— 就算整句都是漢字也一樣要靠假名分辨', () => {
  // 2026-09-07 實際漏掉的那筆
  assert.equal(
    isChinese(
      'スタッフがとてもプロフェッショナルな対応で、安心して滞在することができました。迅速、早急に問題解決してくださった点も感謝しております。'
    ),
    false
  );
  // 漢字比例偏高的日文
  assert.equal(
    isChinese('部屋が広くて快適にでした。周辺にコンビニ、飲食店もあり生活便利。敷地内の緑、鳥の囀りに毎朝癒されました。'),
    false
  );
  assert.equal(isChinese('大変満足致しました'), false);
  assert.equal(isChinese('とてもよかったです'), false); // 純假名,沒漢字
});

test('韓文與英文不算中文', () => {
  assert.equal(isChinese('위치가 좋고 깨끗합니다'), false);
  assert.equal(isChinese('Great location. Very clean.'), false);
  assert.equal(isChinese('Very convenient location!'), false);
});

test('中文夾少量片假名外來語仍算中文 —— 否則會變成永遠清不掉的誤報', () => {
  assert.equal(isChinese('住在ドンキホーテ附近，買東西很方便，走路五分鐘就到捷運站，整體很滿意'), true);
});

test('已知極限:全漢字無假名的日文短句分不出來,當成中文', () => {
  assert.equal(isChinese('大満足'), true);
});

test('空值不算中文,也不需要翻譯', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(isChinese(v), false);
    assert.equal(needsTranslation(v), false);
  }
});

test('needsTranslation 是 isChinese 的反面(空值除外)', () => {
  assert.equal(needsTranslation('Great location.'), true);
  assert.equal(needsTranslation('とてもよかったです'), true);
  assert.equal(needsTranslation('地理位置非常好'), false);
});
