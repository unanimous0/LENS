import { NavLink, Outlet } from 'react-router-dom'

import { cn } from '@/lib/utils'

/**
 * 통계차익 sub-tab 레이아웃. 페어 발굴 / 대여요율 2개 탭.
 * 페어 상세 페이지(`/stat-arb/pair/:left/:right`)는 layout 밖이라 탭 숨김.
 */
export function StatArbLayout() {
  return (
    <div className="flex flex-col gap-1 p-1">
      <div className="panel flex items-center gap-1 px-3 py-2">
        <SubTab to="/stat-arb" end>
          페어 발굴
        </SubTab>
        <SubTab to="/stat-arb/loan-rates">대여요율</SubTab>
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
