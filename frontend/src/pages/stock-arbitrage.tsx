export function StockArbitragePage() {
  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      <div className="panel px-4 py-3">
        <span className="text-sm font-semibold text-t1">종목차익</span>
        <span className="ml-2 text-[11px] text-t4">주식선물 베이시스 현황</span>
      </div>
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <p className="text-t3 text-sm">데이터 소스 연결 후 구현 예정</p>
          <p className="text-t4 text-xs mt-1">내부망: 거래소 실시간 데이터 / 외부망: DB 일별 종가</p>
        </div>
      </div>
    </div>
  )
}
