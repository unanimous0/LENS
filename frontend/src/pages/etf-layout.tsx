import { NavLink, Outlet } from 'react-router-dom'

import { cn } from '@/lib/utils'

/**
 * ETF sub-tab 레이아웃. 두 기능으로 분리:
 *  - 대시보드 (`/etf`): 전 종류 ETF의 순수 시장 데이터 (현재가/iNAV/괴리/거래량). PDF 분해 없음.
 *  - 차익거래 (`/etf/arbitrage`): 섹터형 ETF의 rNAV/fNAV 자체 산출 + 베이시스 헤지 차익.
 *    내부망(전체 구독)·외부망(t8407 REST 선별→상위만 WS) 구분.
 */
export function EtfLayout() {
  return (
    <div className="flex flex-col gap-1 p-1">
      <div className="panel flex items-center gap-1 px-3 py-2">
        <SubTab to="/etf" end>
          대시보드
        </SubTab>
        <SubTab to="/etf/arbitrage">차익거래</SubTab>
      </div>
      <Outlet />
    </div>
  )
}

function SubTab({
  to,
  end,
  children,
}: {
  to: string
  end?: boolean
  children: React.ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded-sm px-3 py-1 text-xs transition-colors',
          isActive ? 'bg-bg-surface text-t1' : 'text-t3 hover:text-t1'
        )
      }
    >
      {children}
    </NavLink>
  )
}
