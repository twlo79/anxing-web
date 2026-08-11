import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feeFilterOptions, feeFilterPredicate, feeFilterLabel,
  ONEOFF_SOURCES, FEE_F_ALL, FEE_F_RENT, FEE_F_ONEOFF,
} from './order-filter.ts';
import { FEE_TYPES } from './fee-types.ts';

test('沒選就是不篩', () => {
  assert.deepEqual(feeFilterPredicate(FEE_F_ALL), { kind: 'none' });
});

test('房租與一次性費用是兩個獨立的選項', () => {
  assert.deepEqual(feeFilterPredicate(FEE_F_RENT), { kind: 'rent' });
  assert.deepEqual(feeFilterPredicate(FEE_F_ONEOFF), { kind: 'oneoffAll' });
});

test('選了某個科目就照那個科目篩', () => {
  assert.deepEqual(feeFilterPredicate('清潔費'), { kind: 'feeType', feeType: '清潔費' });
});

test('★ 房租的哨兵值不能跟任何一個科目撞名', () => {
  // 撞名的話「房租」會被當成一個 fee_type 去比對，篩出來永遠是 0 筆
  assert.ok(!FEE_TYPES.includes(FEE_F_RENT as never));
  assert.ok(!FEE_TYPES.includes(FEE_F_ONEOFF as never));
});

test('★ 一次性收入的來源要跟資料庫的科目規則一致', () => {
  // order_account_code() 只對這兩種來源看 fee_type，其餘一律 rent_income。
  // 這裡多一種或少一種，訂單頁篩出來的筆數就會跟營收報表對不上，
  // 而差在哪沒有人查得出來。
  assert.deepEqual([...ONEOFF_SOURCES].sort(), ['airbnb_cancelled', 'oneoff']);
});

test('選項清單：全部/房租/一次性費用 在最前面', () => {
  const o = feeFilterOptions(FEE_TYPES);
  assert.deepEqual(o.slice(0, 3).map((x) => x.label), ['全部', '房租', '一次性費用(全部)']);
  assert.equal(o.length, FEE_TYPES.length + 3);
});

test('個別科目的值就是科目本身 —— 存進網址或狀態時不用再轉一次', () => {
  const o = feeFilterOptions(FEE_TYPES);
  const hit = o.find((x) => x.label.trim() === '管理費');
  assert.equal(hit?.value, '管理費');
});

test('說明文字：沒篩就是空字串,不要寫「全部」', () => {
  // 畫面上會拿它來決定要不要顯示提示；回「全部」的話會多出一行沒有意義的字
  assert.equal(feeFilterLabel(FEE_F_ALL), '');
  assert.equal(feeFilterLabel(FEE_F_RENT), '房租');
  assert.equal(feeFilterLabel(FEE_F_ONEOFF), '一次性費用');
  assert.equal(feeFilterLabel('水費'), '水費');
});
