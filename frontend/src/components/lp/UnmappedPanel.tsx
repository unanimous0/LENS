import { useLpStore } from '@/stores/lpStore'

/**
 * 베타·잔차 매핑이 없는 포지션 표시 패널.
 * 첫 빌드에서 *주식선물 / 지수선물 포지션*이 여기에 들어감 (base_stock 매핑 부재).
 * 다음 빌드에 매핑 추가하면 자동으로 #2 #3에 반영되며 이 패널은 빈 상태로.
 */
export function UnmappedPanel() {
  const bookRisk = useLpStore((s) => s.bookRisk)

  return (
    <div className="bg-bg-primary p-3">
      <div className="text-[13px] text-t2 font-medium mb-1">미매핑 포지션</div>
      <div className="text-[10px] text-t4 mb-2">
        베타·잔차에 미반영. 다음 빌드의 base_stock 매핑 도입 후 자동 포함.
      </div>
      {bookRisk?.unmapped_positions.length ? (
        <table className="w-full text-[11px] font-mono tabular-nums">
          <thead className="text-t4 text-[10px]">
            <tr>
              <th className="text-left py-1">코드</th>
              <th className="text-right py-1">수량</th>
            </tr>
          </thead>
          <tbody>
            {bookRisk.unmapped_positions.map(([code, qty]) => (
              <tr key={code} className="border-t border-bg-base/40">
                <td className="py-1 text-t2">{code}</td>
                <td className="py-1 text-right" style={{ color: qty > 0 ? '' : 'var(--color-down)' }}>
                  {qty.toLocaleString('ko-KR')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-t4 text-xs py-2">없음</div>
      )}
    </div>
  )
}
