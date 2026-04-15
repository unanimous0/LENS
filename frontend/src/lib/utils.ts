import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
