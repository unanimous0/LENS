import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { NetworkToggle } from './network-toggle'

const tabs = [
  { label: "대시보드", href: "/dashboard" },
  { label: "시세", href: "/market" },
  { label: "백테스팅", href: "/backtest" },
  { label: "시그널", href: "/signals" },
  { label: "대차", href: "/lending" },
  { label: "포지션", href: "/position" },
  { label: "수급", href: "/supply-demand" },
  { label: "종목차익", href: "/stock-arbitrage" },
  { label: "배당", href: "/dividends" },
]

export function TopNav() {
  const location = useLocation()
  return (
    <nav className="flex items-center justify-between border-b border-border bg-bg-primary px-4">
      <div className="flex items-center gap-1">
        <span className="mr-4 text-sm font-bold tracking-tight text-accent">LENS</span>
        {tabs.map((tab) => {
          const isActive = location.pathname === tab.href
          return (
            <Link
              key={tab.href}
              to={tab.href}
              className={cn(
                "px-3 py-2.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "text-t1 border-b-2 border-accent"
                  : "text-t3 hover:text-t2 border-b-2 border-transparent"
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
      <div className="flex items-center gap-4">
        <NetworkToggle />
      </div>
    </nav>
  )
}
