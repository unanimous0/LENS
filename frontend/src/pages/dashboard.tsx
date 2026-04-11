function GradientChart({ data, height = 200 }: { data: number[]; height?: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 600;
  const h = height;
  const padding = 2;

  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - padding - ((v - min) / range) * (h - padding * 2),
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${w} ${h} L 0 ${h} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <defs>
        <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34c759" stopOpacity="0.4" />
          <stop offset="50%" stopColor="#34c759" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#34c759" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#30d158" />
          <stop offset="100%" stopColor="#34c759" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#greenGrad)" />
      <path d={linePath} fill="none" stroke="url(#lineGrad)" strokeWidth="2" />
    </svg>
  );
}

function MiniChart({ data, up = true }: { data: number[]; up?: boolean }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 32;

  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");

  const color = up ? "#34c759" : "#ff3b30";

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={80} height={32}>
      <defs>
        <linearGradient id={`mini-${up}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${h} ${points} ${w},${h}`}
        fill={`url(#mini-${up})`}
      />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

const portfolioData = Array.from({ length: 90 }, (_, i) => {
  return 10000 + Math.sin(i * 0.07) * 1500 + i * 30 + Math.sin(i * 0.3) * 500;
});

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      {/* Top Row */}
      <div className="flex gap-1">
        <div className="flex-1 panel p-4">
          <div className="grid grid-cols-4 gap-3">
            {[
              {
                label: "총 포지션",
                value: "12,432,000,000",
                unit: "\u20A9",
                change: "+2.31%",
                isUp: true,
                spark: [40, 42, 41, 45, 48, 46, 50, 52, 54, 53, 55],
              },
              {
                label: "일간 P&L",
                value: "284,500,000",
                unit: "\u20A9",
                change: "+1.82%",
                isUp: true,
                spark: [10, 8, 12, 15, 11, 14, 18, 16, 20, 22, 21],
              },
              {
                label: "대차 잔고",
                value: "3,215,000,000",
                unit: "\u20A9",
                change: "-0.53%",
                isUp: false,
                spark: [30, 32, 29, 28, 31, 27, 26, 28, 25, 24, 23],
              },
              {
                label: "활성 시그널",
                value: "7",
                unit: "",
                change: "+3 today",
                isUp: true,
                spark: [2, 3, 2, 4, 3, 5, 4, 6, 5, 7, 7],
              },
            ].map((card) => (
              <div
                key={card.label}
                className="panel-inner rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <p className="text-xs text-t3 mb-1.5">{card.label}</p>
                  <p className="font-mono text-lg font-semibold text-t1">
                    {card.unit}{card.value}
                  </p>
                  <span
                    className={`font-mono text-xs font-medium ${
                      card.isUp ? "text-up" : "text-down"
                    }`}
                  >
                    {card.change}
                  </span>
                </div>
                <MiniChart data={card.spark} up={card.isUp} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Middle Row */}
      <div className="flex gap-1" style={{ height: "380px" }}>
        {/* Main Chart */}
        <div className="flex-[2] panel flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-light">
            <div className="flex items-center gap-6">
              <span className="text-sm font-semibold text-t1">포트폴리오 성과</span>
              <div className="flex text-xs">
                {["1D", "1W", "1M", "3M", "1Y"].map((p, i) => (
                  <button
                    key={p}
                    className={`px-3 py-1 rounded-full ${
                      i === 2
                        ? "bg-green text-black font-semibold"
                        : "text-t3 hover:text-t2"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-xl font-semibold text-t1">{"\u20A9"}12.43B</span>
              <span className="font-mono text-sm font-medium text-up">+2.31%</span>
            </div>
          </div>
          <div className="flex-1 px-4 py-2 flex items-end">
            <GradientChart data={portfolioData} height={280} />
          </div>
        </div>

        {/* Signals */}
        <div className="w-80 panel flex flex-col">
          <div className="px-4 py-3 border-b border-border-light flex items-center justify-between">
            <span className="text-sm font-semibold text-t1">시그널</span>
            <span className="text-xs text-green font-mono">7 active</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {[
              { name: "KODEX 200", code: "069500", type: "BUY", price: "35,420", time: "14:32:15", pct: "+1.2%" },
              { name: "TIGER 반도체", code: "091160", type: "SELL", price: "142,800", time: "13:15:42", pct: "-0.8%" },
              { name: "KODEX 인버스", code: "114800", type: "BUY", price: "5,215", time: "11:48:03", pct: "+2.4%" },
              { name: "TIGER 200", code: "102110", type: "SELL", price: "42,150", time: "10:22:31", pct: "-0.3%" },
              { name: "KODEX 레버리지", code: "122630", type: "BUY", price: "18,740", time: "09:45:08", pct: "+3.1%" },
              { name: "KODEX 삼성그룹", code: "102780", type: "BUY", price: "9,850", time: "09:32:44", pct: "+0.5%" },
              { name: "TIGER 미국S&P", code: "360750", type: "SELL", price: "15,320", time: "09:12:55", pct: "-1.1%" },
            ].map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-4 py-2.5 border-b border-border hover:bg-bg-hover transition-colors"
              >
                <div>
                  <p className="text-[13px] text-t1">{s.name}</p>
                  <p className="font-mono text-[11px] text-t4">{s.code}</p>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-2 justify-end">
                    <span className="font-mono text-[13px] text-t1">{s.price}</span>
                    <span className={`font-mono text-[11px] font-medium ${s.type === "BUY" ? "text-up" : "text-down"}`}>
                      {s.pct}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 justify-end mt-0.5">
                    <span className="font-mono text-[10px] text-t4">{s.time}</span>
                    <span
                      className={`font-mono text-[10px] font-semibold px-1.5 py-px rounded-sm ${
                        s.type === "BUY" ? "bg-up-bg text-up" : "bg-down-bg text-down"
                      }`}
                    >
                      {s.type}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="flex gap-1" style={{ height: "300px" }}>
        {/* Position */}
        <div className="flex-1 panel flex flex-col">
          <div className="px-4 py-3 border-b border-border-light">
            <span className="text-sm font-semibold text-t1">포지션</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-bg-surface">
                <tr className="text-xs text-t3 border-b border-border-light">
                  <th className="text-left px-4 py-2 font-medium">종목</th>
                  <th className="text-right px-4 py-2 font-medium">수량</th>
                  <th className="text-right px-4 py-2 font-medium">평균가</th>
                  <th className="text-right px-4 py-2 font-medium">현재가</th>
                  <th className="text-right px-4 py-2 font-medium">손익</th>
                  <th className="text-right px-4 py-2 font-medium">수익률</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: "KODEX 200", qty: "150,000", avg: "35,200", cur: "35,420", pnl: "+33,000,000", pct: "+0.63%" },
                  { name: "TIGER 반도체", qty: "45,000", avg: "143,500", cur: "142,800", pnl: "-31,500,000", pct: "-0.49%" },
                  { name: "KODEX 레버리지", qty: "200,000", avg: "18,200", cur: "18,740", pnl: "+108,000,000", pct: "+2.97%" },
                  { name: "TIGER 200", qty: "80,000", avg: "41,800", cur: "42,150", pnl: "+28,000,000", pct: "+0.84%" },
                  { name: "KODEX 인버스", qty: "120,000", avg: "5,280", cur: "5,215", pnl: "-7,800,000", pct: "-1.23%" },
                ].map((p) => (
                  <tr key={p.name} className="border-b border-border hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-t1 font-medium">{p.name}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-t2">{p.qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-t2">{p.avg}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-t1">{p.cur}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${p.pnl.startsWith("+") ? "text-up" : "text-down"}`}>
                      {p.pnl}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono font-semibold ${p.pct.startsWith("+") ? "text-up" : "text-down"}`}>
                      {p.pct}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Lending */}
        <div className="w-96 panel flex flex-col">
          <div className="px-4 py-3 border-b border-border-light">
            <span className="text-sm font-semibold text-t1">대차 현황</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-bg-surface">
                <tr className="text-xs text-t3 border-b border-border-light">
                  <th className="text-left px-4 py-2 font-medium">종목</th>
                  <th className="text-right px-4 py-2 font-medium">수량</th>
                  <th className="text-right px-4 py-2 font-medium">요율</th>
                  <th className="text-right px-4 py-2 font-medium">구분</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: "삼성전자", qty: "50,000", rate: "0.50%", type: "차입" },
                  { name: "SK하이닉스", qty: "12,000", rate: "1.20%", type: "대여" },
                  { name: "NAVER", qty: "8,500", rate: "0.80%", type: "차입" },
                  { name: "카카오", qty: "25,000", rate: "0.60%", type: "대여" },
                  { name: "LG에너지솔루션", qty: "3,200", rate: "1.50%", type: "차입" },
                ].map((r) => (
                  <tr key={r.name} className="border-b border-border hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-t1 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-t2">{r.qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green">{r.rate}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`font-mono text-[11px] font-semibold px-1.5 py-px rounded-sm ${
                          r.type === "차입" ? "bg-down-bg text-down" : "bg-up-bg text-up"
                        }`}
                      >
                        {r.type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
