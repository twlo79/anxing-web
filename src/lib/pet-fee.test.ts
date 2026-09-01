import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultOf, petAllowed, depositItems, feePresets,
  autoDepositAmount, autoFeeAmount, startsLocked,
  onItemChange, onFeeLabelChange, validatePetLines, itemLabel,
  PET_FEE_LABEL, type FeeDefault,
} from './pet-fee.ts';

const SZ = 'e-shizhao';   // 時兆   10000 / 1000
const ZL = 'e-zhenglong'; // 正隆   30000 / 3000
const KF = 'e-kaifeng';   // 開封   禁止
const TS = 'e-taishi';    // 台視   沒有列 = 未設定
const AM = 'e-amani';     // 亞曼尼 有列但金額 null

const LIST: FeeDefault[] = [
  { estate_id: SZ, pet_allowed: true,  pet_deposit: 10000, pet_fee: 1000 },
  { estate_id: ZL, pet_allowed: true,  pet_deposit: 30000, pet_fee: 3000 },
  { estate_id: KF, pet_allowed: false, pet_deposit: null,  pet_fee: null },
  { estate_id: AM, pet_allowed: true,  pet_deposit: null,  pet_fee: null },
];

const PRESETS = [
  { label: '清潔費' }, { label: PET_FEE_LABEL }, { label: '其它' },
];

describe('defaultOf —— 找不到就是找不到', () => {
  test('對得上', () => assert.equal(defaultOf(LIST, ZL)?.pet_deposit, 30000));

  /*
   * ★★★ 這是最重要的一條。退而用「第一筆」或「最像的」
   *   會讓某個物業拿到別人的金額 —— 數字合理，只是收錯了。
   */
  test('沒有列 → null，不退而用別人的', () => assert.equal(defaultOf(LIST, TS), null));
  test('estateId 是 null → null', () => assert.equal(defaultOf(LIST, null), null));
  test('estateId 是空字串 → null', () => assert.equal(defaultOf(LIST, ''), null));
  test('清單是空的 → null', () => assert.equal(defaultOf([], ZL), null));
});

describe('petAllowed —— 未知不等於禁止', () => {
  test('明確允許', () => assert.equal(petAllowed(LIST, SZ), true));
  test('明確禁止', () => assert.equal(petAllowed(LIST, KF), false));

  /*
   * ★★ 沒設定回 true。擋住的話真的有人帶寵物來時記不了這筆錢，
   *   使用者會塞進別的欄位，然後報表上就看不見了。
   */
  test('沒有列 → true（未設定不擋）', () => assert.equal(petAllowed(LIST, TS), true));
  test('沒有物業 → true', () => assert.equal(petAllowed(LIST, null), true));
});

describe('depositItems —— 禁止時選項根本不出現', () => {
  test('允許 → 兩項', () => assert.deepEqual(depositItems(LIST, SZ), ['一般押金', '寵物押金']));
  test('禁止 → 只有一般押金', () => assert.deepEqual(depositItems(LIST, KF), ['一般押金']));
  test('未設定 → 兩項', () => assert.deepEqual(depositItems(LIST, TS), ['一般押金', '寵物押金']));

  // 「一般押金」永遠排第一 —— 它是最常用的那一種
  test('一般押金永遠在第一個', () => {
    for (const e of [SZ, ZL, KF, TS, AM]) assert.equal(depositItems(LIST, e)[0], '一般押金');
  });
});

describe('feePresets —— 只拿掉寵物費，其餘原封不動', () => {
  test('允許 → 三項都在', () => assert.equal(feePresets(PRESETS, LIST, SZ).length, 3));
  test('禁止 → 少了寵物費', () => {
    const out = feePresets(PRESETS, LIST, KF);
    assert.deepEqual(out.map((p) => p.label), ['清潔費', '其它']);
  });

  /*
   * ★ 傳進來的是模組層級的常數。就地過濾的話，
   *   看完開封的訂單之後，下一個物業會拿到被砍過的清單。
   */
  test('不改動傳進來的陣列', () => {
    const before = PRESETS.map((p) => p.label);
    feePresets(PRESETS, LIST, KF);
    assert.deepEqual(PRESETS.map((p) => p.label), before);
  });
  test('回傳的是新陣列', () => assert.notEqual(feePresets(PRESETS, LIST, SZ), PRESETS));
});

describe('autoDepositAmount —— 三種情況都回 null', () => {
  test('時兆的寵物押金', () => assert.equal(autoDepositAmount(LIST, SZ, '寵物押金'), 10000));
  test('正隆的寵物押金', () => assert.equal(autoDepositAmount(LIST, ZL, '寵物押金'), 30000));

  /*
   * ★★★ 回 0 的話使用者選了項目金額會被清成 0，而 0 看起來像一個決定。
   *   這三條釘住「不知道就別動」。
   */
  test('一般押金沒有預設', () => assert.equal(autoDepositAmount(LIST, ZL, '一般押金'), null));
  test('未設定的物業', () => assert.equal(autoDepositAmount(LIST, TS, '寵物押金'), null));
  test('有列但金額是 null', () => assert.equal(autoDepositAmount(LIST, AM, '寵物押金'), null));
  test('禁止的物業', () => assert.equal(autoDepositAmount(LIST, KF, '寵物押金'), null));
  test('項目是 null', () => assert.equal(autoDepositAmount(LIST, ZL, null), null));
});

describe('autoFeeAmount', () => {
  test('時兆 1000', () => assert.equal(autoFeeAmount(LIST, SZ, PET_FEE_LABEL), 1000));
  test('正隆 3000', () => assert.equal(autoFeeAmount(LIST, ZL, PET_FEE_LABEL), 3000));
  test('清潔費不帶入', () => assert.equal(autoFeeAmount(LIST, SZ, '清潔費'), null));
  test('禁止的物業', () => assert.equal(autoFeeAmount(LIST, KF, PET_FEE_LABEL), null));
});

describe('startsLocked —— 有預設才鎖', () => {
  test('有預設 → 鎖', () => assert.equal(startsLocked(10000), true));
  test('沒預設 → 不鎖', () => assert.equal(startsLocked(null), false));

  // ★ 0 是一個真的預設值（「可以帶，但這次不收」），要鎖
  test('預設是 0 也要鎖', () => assert.equal(startsLocked(0), true));
});

describe('onItemChange —— 金額與鎖一起決定', () => {
  test('選寵物押金 → 帶入並鎖', () => {
    assert.deepEqual(onItemChange(LIST, ZL, '寵物押金', 0), { amount: 30000, locked: true });
  });

  /*
   * ★★ 沒有預設時**原封不動**帶回使用者已經打的數字。
   *   清成 0 的話，切一下項目又切回來，打好的金額就沒了。
   */
  test('未設定 → 保留原本打的金額、不鎖', () => {
    assert.deepEqual(onItemChange(LIST, TS, '寵物押金', 8888), { amount: 8888, locked: false });
  });
  test('切回一般押金 → 保留金額、不鎖', () => {
    assert.deepEqual(onItemChange(LIST, ZL, '一般押金', 30000), { amount: 30000, locked: false });
  });
  test('禁止的物業 → 保留金額、不鎖', () => {
    assert.deepEqual(onItemChange(LIST, KF, '寵物押金', 500), { amount: 500, locked: false });
  });
});

describe('onFeeLabelChange', () => {
  test('選寵物費 → 帶入並鎖', () => {
    assert.deepEqual(onFeeLabelChange(LIST, SZ, PET_FEE_LABEL, 0), { amount: 1000, locked: true });
  });
  test('選清潔費 → 保留金額、不鎖', () => {
    assert.deepEqual(onFeeLabelChange(LIST, SZ, '清潔費', 777), { amount: 777, locked: false });
  });
});

describe('validatePetLines —— 最後一道', () => {
  test('允許的物業一律過', () => {
    assert.equal(validatePetLines(LIST, ZL, ['一般押金', '寵物押金'], [PET_FEE_LABEL]), null);
  });
  test('未設定的物業也過', () => {
    assert.equal(validatePetLines(LIST, TS, ['寵物押金'], []), null);
  });

  /*
   * ★★★ 下拉不是唯一的入口 —— 切換房源、改別的欄位都可能讓
   *   一筆「開封 ＋ 寵物押金」走到存檔。存進去之後就只剩一個合理的金額。
   */
  test('開封 ＋ 寵物押金 → 擋', () => {
    assert.match(validatePetLines(LIST, KF, ['寵物押金'], []) ?? '', /禁止帶寵物/);
  });
  test('開封 ＋ 寵物費 → 擋', () => {
    assert.match(validatePetLines(LIST, KF, ['一般押金'], [PET_FEE_LABEL]) ?? '', /禁止帶寵物/);
  });
  test('開封 ＋ 只有一般押金 → 過', () => {
    assert.equal(validatePetLines(LIST, KF, ['一般押金'], ['清潔費']), null);
  });
  test('加費清單沒傳也不會爆', () => {
    assert.equal(validatePetLines(LIST, KF, ['一般押金']), null);
  });
});

describe('itemLabel —— 舊資料顯示成一般押金但不回填', () => {
  test('null', () => assert.equal(itemLabel(null), '一般押金'));
  test('undefined', () => assert.equal(itemLabel(undefined), '一般押金'));
  test('空字串', () => assert.equal(itemLabel(''), '一般押金'));
  test('有值就照原樣', () => assert.equal(itemLabel('寵物押金'), '寵物押金'));
});
