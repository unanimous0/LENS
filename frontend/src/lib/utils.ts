import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 한국 시간(KST, UTC+9) 기준 날짜 'YYYY-MM-DD'.
 * `new Date().toISOString().slice(0,10)`은 UTC 기준이라 자정 직후에 어제 날짜가 나옴.
 * 시장/배당 비교는 KST가 정답.
 */
export function todayKst(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

/** N일 후 날짜 'YYYY-MM-DD' (KST). */
export function kstDateOffset(daysFromToday: number, base: Date = new Date()): string {
  const offset = new Date(base.getTime() + daysFromToday * 86400000);
  return todayKst(offset);
}

/**
 * 객체 배열을 TSV(탭 구분)로 변환하여 클립보드에 복사.
 * 엑셀에 바로 붙여넣기 가능.
 */
export async function copyTableToClipboard(
  rows: Record<string, unknown>[],
  columns?: { key: string; label: string }[],
): Promise<boolean> {
  if (rows.length === 0) return false;
  const cols = columns ?? Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const header = cols.map((c) => c.label).join("\t");
  const body = rows
    .map((row) => cols.map((c) => {
      const v = row[c.key];
      return v == null ? "" : String(v);
    }).join("\t"))
    .join("\n");
  try {
    await navigator.clipboard.writeText(header + "\n" + body);
    return true;
  } catch {
    return false;
  }
}
