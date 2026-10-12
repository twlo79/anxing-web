'use client';
import { REQ_KINDS, REQ_KIND_LABEL, type ReqKind } from '@/lib/request-mix';

/*
 * 審核、狀態清單上的種類標籤與篩選藥丸（2026-10-12 David 選 A：三種混在同一張清單）。
 * ★ 藥丸規矩跟房源狀態一樣：點一下＝只看那一種，再點一下清除；數字算在篩選之前。
 * ★ 定在模組層 —— 定在元件裡的話每次 render 都是新型別，整排會拆掉重做。
 */

const TAG: Record<ReqKind, string> = {
  leave: 'bg-mor-bluelight text-mor-slatedark',
  ot: 'bg-amber-100 text-amber-800',
  fix: 'bg-violet-100 text-violet-800',
};

export function KindTag({ kind }: { kind: ReqKind }) {
  return (
    <span className={`mr-1.5 inline-block rounded px-1.5 align-[1px] text-[11px] font-medium ${TAG[kind]}`}>
      {REQ_KIND_LABEL[kind]}
    </span>
  );
}

export function KindChips({ value, onChange, counts }: {
  value: ReqKind | ''; onChange: (v: ReqKind | '') => void; counts: Record<ReqKind, number>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {REQ_KINDS.map((k) => {
        const on = value === k;
        return (
          <button key={k} type="button" aria-pressed={on} onClick={() => onChange(on ? '' : k)}
            className={`rounded-full border px-3 py-1 text-uisub whitespace-nowrap transition-colors ${
              on ? 'bg-mor-ink border-mor-ink text-white' : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
            {REQ_KIND_LABEL[k]} <span className="tabular-nums">{counts[k]}</span>
          </button>
        );
      })}
    </div>
  );
}
