/**
 * 2026-07 的真實排班資料，當作解析器的黃金測試基準。
 *
 * 為什麼用真資料而不是編的：
 * 這份資料對應的手工 Excel 結果是人算過、對過帳的（Una 42 / 庭玉 42、
 * 時兆公區 8 次、4B1 3 次）。開發時就是靠它抓到兩個真 bug —— 打掃次數
 * 用錯去重方式、「開2-1」被切成「開2」。編的資料抓不到那種東西。
 *
 * 期望值改動前請先確認是規則真的變了，不是解析器壞了。
 */

export const RAW_202607 = `2026-07-01|A18-Marlee Gaitanis-入住|月(Dianne)
2026-07-01|B2-Jordan Halpern-入住|月(Dianne)
2026-07-01|13A5-Roger-入住|花花
2026-07-01|17B5-細清（不用鋪床）|SHAO-YING HSIEH + Ayu
2026-07-01|17B5點交|Jessica
2026-07-02|B6-李瑪琍-入住 私|月(Dianne)
2026-07-02|贈-4B1*2|SHAO-YING HSIEH + Ayu
2026-07-02|時兆公區-二三四樓地板和窗框|SHAO-YING HSIEH
2026-07-03|A休|Ayu
2026-07-03|14B1入住清潔|SHAO-YING HSIEH
2026-07-04|退-開封整棟-James|SHAO-YING HSIEH + Ayu
2026-07-04|J1-Seanna-入住|唐筑萱
2026-07-04|9A5拆備品|花花 + 劉姐
2026-07-04|A4-Jacky Lin-入住|月(Dianne)
2026-07-04|開封樓梯公共區域櫃子|SHAO-YING HSIEH + Ayu
2026-07-05|退-A11-Mel Muhammad|劉姐
2026-07-05|B7-Castor Wu-入住|月(Dianne)
2026-07-05|A9-Ariel Wang-入住|月(Dianne)
2026-07-05|U休|SHAO-YING HSIEH
2026-07-05|A休|Ayu
2026-07-05|9A5-要鋪床|劉姐
2026-07-06|14B1-James-入住|花花
2026-07-06|退-A7-侯子（6/30退、7/2油漆、7/6矽利康）|Ayu
2026-07-06|開2-1-Wetphisit-入住|Carol芊芊
2026-07-06|開4-佳婕-入住|Carol芊芊
2026-07-06|U休|SHAO-YING HSIEH
2026-07-06|退-J1-Seanna|Ayu
2026-07-07|A11-종국 최-入住|月(Dianne)
2026-07-07|贈-4B5（第一次）|SHAO-YING HSIEH + Ayu
2026-07-07|14B2入住清潔|SHAO-YING HSIEH + Ayu
2026-07-07|時兆公區-二三四樓地板和窗框|SHAO-YING HSIEH + Ayu
2026-07-07|時兆公區-34樓洗衣間地板|SHAO-YING HSIEH + Ayu
2026-07-08|退-A13-Yumi Shiraishi|Ayu
2026-07-08|退-開2-1-Wetphisit|Ayu
2026-07-08|贈-4B2*1|劉姐
2026-07-08|協助行政|SHAO-YING HSIEH
2026-07-09|退-J2-Michael|SHAO-YING HSIEH
2026-07-09|A休|Ayu
2026-07-10|退-A6-Chantelle Grace|SHAO-YING HSIEH
2026-07-10|A6-卞慧儀-入住 私|月(Dianne)
2026-07-10|J2-Shih Hsuan-入住|唐筑萱
2026-07-10|亞曼尼-Joanne-入住|Carol芊芊
2026-07-10|退-開4-佳婕|SHAO-YING HSIEH
2026-07-10|A休-颱風假|Ayu
2026-07-11|A13-Betty Sit-入住|月(Dianne)
2026-07-11|U休-颱風假|SHAO-YING HSIEH
2026-07-11|A休-颱風假|Ayu
2026-07-12|A7-Gregg Zambrovitz-入住|月(Dianne)
2026-07-12|退-4B1-Joanna&Brian|Ayu
2026-07-12|9A5-Lan嵐-入住|花花
2026-07-12|U休-補（7/10）颱風假|SHAO-YING HSIEH
2026-07-12|時兆公區2、3、4樓|Ayu
2026-07-13|14B2-Erin-入住|花花
2026-07-13|退-A3-馬森兒子 私|SHAO-YING HSIEH
2026-07-13|退-台S-凱威(7/11退）|SHAO-YING HSIEH
2026-07-13|退-J2-Shih Hsuan（7/12退）|SHAO-YING HSIEH
2026-07-13|時兆公區（洗毛巾）|Ayu
2026-07-13|繼續4B1完成|Ayu
2026-07-13|台視公區|SHAO-YING HSIEH
2026-07-14|贈-台1+2|Ayu
2026-07-14|U休|SHAO-YING HSIEH
2026-07-14|贈-14B1*1|Ayu
2026-07-14|贈-4B5*2|劉姐
2026-07-15|JPR整棟-Teresa-入住|唐筑萱
2026-07-15|A休|Ayu
2026-07-15|贈-13A5（第一次）|SHAO-YING HSIEH
2026-07-15|台3-Tiger Wang-入住|唐筑萱
2026-07-16|退-B4-Samuel Tung|SHAO-YING HSIEH
2026-07-16|A休|Ayu
2026-07-16|A5-贈|SHAO-YING HSIEH
2026-07-16|時兆公區-34樓洗衣間地板|SHAO-YING HSIEH
2026-07-17|開4-Andrew-入住|Carol芊芊
2026-07-17|開2-1-Ho Yin-入住|Carol芊芊
2026-07-17|贈-4B3*1|Ayu
2026-07-17|U休|SHAO-YING HSIEH
2026-07-17|B7-贈|Ayu
2026-07-18|台S-Lance-入住|唐筑萱
2026-07-18|U休|SHAO-YING HSIEH
2026-07-18|贈-14B3*1|Ayu
2026-07-18|台2換房清潔|Ayu
2026-07-19|退-開4-Andrew（角落牆壁冷氣都要清潔）|SHAO-YING HSIEH
2026-07-19|退-開2-1-Ho Yin（角落牆壁冷氣都要清潔）|劉姐
2026-07-19|A休|Ayu
2026-07-20|退-JPR整棟-Teresa|SHAO-YING HSIEH
2026-07-20|贈-A9|Ayu
2026-07-20|時兆公區（三四樓洗衣間/三樓曬衣間/四樓/五樓）|Ayu
2026-07-20|贈-A11|Ayu
2026-07-21|A3-Max Rapp-入住|(未指派)
2026-07-21|贈-B2|Ayu
2026-07-21|贈-A2|SHAO-YING HSIEH
2026-07-21|時兆二樓公區（包含廁所/流理台/地板/辦公室）|Ayu
2026-07-21|台視公區（廚房/客廳櫃子/地板/公共洗衣機處）|SHAO-YING HSIEH
2026-07-21|退-台3-Tiger Wang|SHAO-YING HSIEH
2026-07-21|贈-A18|Ayu
2026-07-22|退-A15-Kevin Loo 私|(未指派)
2026-07-22|A15-劉令儀-入住 私|月(Dianne)
2026-07-22|A休|Ayu
2026-07-22|贈-14B1*2|(未指派)
2026-07-23|U休|SHAO-YING HSIEH
2026-07-23|A休|Ayu
2026-07-23|復興|劉姐
2026-07-24|退-B5-劉令儀（7/22退、7/22矽利康、7/23油漆）|Ayu
2026-07-24|退-A17-Jason Hu（7/19退、7/23油漆矽利康）|Ayu
2026-07-24|開封整棟-Flora-入住|Carol芊芊
2026-07-24|B5-李瑪琍-入住 私|月(Dianne)
2026-07-24|A17-Jack Yang-入住 私|月(Dianne)
2026-07-24|贈-A16|Ayu
2026-07-24|贈-A13|Ayu
2026-07-25|A6-輝代遠藤-入住|月(Dianne)
2026-07-25|退-A6-卞慧儀 私|SHAO-YING HSIEH
2026-07-25|退-B6-李瑪琍 私|SHAO-YING HSIEH
2026-07-25|J2-Judy-入住|唐筑萱
2026-07-25|19B2|Ayu + 劉姐
2026-07-25|贈-A4|SHAO-YING HSIEH
2026-07-26|B6-Eliana Montalvo-入住|月(Dianne)
2026-07-26|退-開封整棟-Flora|SHAO-YING HSIEH + Ayu
2026-07-26|開4-Nga Ki-入住|Carol芊芊
2026-07-26|6B2|劉姐
2026-07-27|退-14B5-林又千|SHAO-YING HSIEH + Ayu
2026-07-27|18B5|SHAO-YING HSIEH + Ayu
2026-07-28|退-台1+2-Tiger Wang|Ayu
2026-07-28|退-亞曼尼-Joanne|Ayu
2026-07-28|U休|SHAO-YING HSIEH
2026-07-28|4B3-贈|Ayu
2026-07-29|退-B2-Jordan Halpern|SHAO-YING HSIEH
2026-07-29|退-B5-李瑪琍 私|SHAO-YING HSIEH
2026-07-29|A休|Ayu
2026-07-29|退-B4-Emir Habul 私（7/27）|SHAO-YING HSIEH
2026-07-29|時兆公區-34樓洗衣間地板|SHAO-YING HSIEH
2026-07-29|洗烘折毛巾|SHAO-YING HSIEH
2026-07-30|退-A18-Marlee Gaitanis|SHAO-YING HSIEH
2026-07-30|退-B3-Wei Chen Lee|SHAO-YING HSIEH
2026-07-30|退-4B5-Wayne|Ayu
2026-07-30|B3-張智宜-入住|月(Dianne)
2026-07-30|復興|劉姐
2026-07-31|台3-Jen-入住|唐筑萱
2026-07-31|退-14B3-Yosep|SHAO-YING HSIEH + Ayu
2026-07-31|開2-Seng Hong-入住|Carol芊芊
2026-07-31|14A5|SHAO-YING HSIEH + Ayu`;

export const ROWS_202607 = RAW_202607.split('\n').map((l) => {
  const [date, title, assignees] = l.split('|');
  return { date, title, assignees };
});

/** 人員主檔（對應 migration_58 的種子資料） */
export const STAFF = [
  { id: 'una', source_name: 'SHAO-YING HSIEH', source_names: ['SHAO-YING HSIEH'], code: 'UNA', name: 'Una', count_mode: 'rooms' as const, count_cleans: true, color: null, leave_prefix: 'U休' },
  { id: 'ayu', source_name: 'Ayu', source_names: ['Ayu'], code: '庭玉', name: '庭玉', count_mode: 'rooms' as const, count_cleans: true, color: null, leave_prefix: 'A休' },
  { id: 'liu', source_name: '劉姐', source_names: ['劉姐'], code: 'LIU', name: '劉姐', count_mode: 'hours' as const, count_cleans: true, color: null, leave_prefix: null },
  ...['月(Dianne)', 'Carol芊芊', '唐筑萱', '花花', 'Jessica'].map((n, i) => ({
    id: 'n' + i, source_name: n, source_names: [n], code: 'N' + i, name: n,
    count_mode: 'none' as const, count_cleans: false, color: null, leave_prefix: null,
  })),
];

const mk = (code: string, aliases: string[], beds: number | null,
            g: 'kai' | 'ab' | 'zl' | 'other', common = false) =>
  ({ code, aliases, beds, linen_group: g, is_common: common });

/** 房源主檔（對應 migration_58/59 的種子資料） */
export const PROPS = [
  mk('開整棟', ['開封整棟'], 8, 'kai'), mk('開4', ['開封4'], 3, 'kai'),
  mk('開3', ['開封3'], 2, 'kai'), mk('開2', ['開封2'], 3, 'kai'),
  mk('開2-2', [], 1, 'kai'), mk('開2-1', [], 2, 'kai'), mk('南五', [], 3, 'kai'),
  mk('亞曼尼', ['亞'], 2, 'kai'), mk('RMJ', [], 4, 'kai'),
  mk('JPR1', [], 2, 'kai'), mk('JPR2', [], 2, 'kai'), mk('M', [], 3, 'kai'),
  mk('V', [], 1, 'kai'), mk('C', [], 1, 'kai'),
  mk('台1+2', ['台1', '台2+1'], 2, 'kai'), mk('台3', [], 1, 'kai'), mk('台4', [], 1, 'kai'),
  mk('復興', [], 0, 'kai'),
  mk('台視公區', [], 0, 'kai', true), mk('時兆公區', [], 0, 'kai', true),
  mk('開封公區', ['開封樓梯公共區域'], 0, 'kai', true),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 16, 17, 18].map((n) => mk('A' + n, [], 1, 'ab')),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => mk('B' + n, [], 1, 'ab')),
  ...([['3A3', 4], ['3A5', 4], ['4B1', 4], ['4B2', 4], ['4B3', 3], ['4B5', 3],
       ['7B1', 4], ['9A5', 4], ['10A5', 4], ['13A5', 4], ['14A5', 4],
       ['14B1', 4], ['14B2', 4], ['14B3', 3], ['14B5', 3]] as [string, number][])
    .map(([c, b]) => mk(c, [], b, 'zl')),
  // migration_64 之後這幾個歸位了；幾床仍待補，測試不依賴這兩個欄位
  mk('17B5', [], null, 'zl'), mk('18B5', [], null, 'zl'),
  mk('19B2', [], null, 'zl'), mk('6B2', [], null, 'zl'),
  mk('J1', [], null, 'other'), mk('J2', [], null, 'other'),
  mk('台S', [], null, 'other'), mk('台2', [], null, 'kai'),
  mk('JPR整棟', ['JPR'], null, 'kai'),
  mk('時兆二樓', ['時兆2樓', '時兆二樓公區'], 0, 'ab', true),
];
