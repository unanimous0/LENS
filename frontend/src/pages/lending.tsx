import { useState } from "react"
import { cn } from "@/lib/utils"
import { LendingAvailabilityPage } from "./lending-availability"
import { RepaymentCheckPage } from "./repayment-check"

const subTabs = [
  { key: "borrow", label: "차입", group: "manage" },
  { key: "repay", label: "상환", group: "manage" },
  { key: "lend", label: "대여", group: "manage" },
  { key: "lend-repay", label: "대여상환", group: "manage" },
  { key: "availability", label: "대여가능확인", group: "check" },
  { key: "repay-check", label: "상환가능확인", group: "check" },
] as const

type SubTabKey = (typeof subTabs)[number]["key"]

function StubContent({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-t3">{label} -- 준비 중</p>
    </div>
  )
}

export function LendingPage() {
  const [activeTab, setActiveTab] = useState<SubTabKey>("availability")

  const manageTabs = subTabs.filter((t) => t.group === "manage")
  const checkTabs = subTabs.filter((t) => t.group === "check")

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div className="flex items-center gap-1 bg-bg-primary px-4 py-1 border-b border-border">
        {manageTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded transition-colors",
              activeTab === tab.key
                ? "bg-bg-surface-2 text-t1"
                : "text-t3 hover:text-t2"
            )}
          >
            {tab.label}
          </button>
        ))}
        <span className="mx-2 h-3 w-px bg-bg-surface-3" />
        {checkTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded transition-colors",
              activeTab === tab.key
                ? "bg-bg-surface-2 text-t1"
                : "text-t3 hover:text-t2"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === "availability" && <LendingAvailabilityPage />}
        {activeTab === "borrow" && <StubContent label="차입" />}
        {activeTab === "repay" && <StubContent label="상환" />}
        {activeTab === "lend" && <StubContent label="대여" />}
        {activeTab === "lend-repay" && <StubContent label="대여상환" />}
        {activeTab === "repay-check" && <RepaymentCheckPage />}
      </div>
    </div>
  )
}
