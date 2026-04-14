import * as XLSX from "xlsx"

/**
 * 시트 내 모든 셀에 숫자 서식 + 컬럼 너비 자동 맞춤 적용:
 * - 정수: #,##0 (천단위 쉼표)
 * - 소수점 있는 숫자: #,##0.00 (소수점 둘째자리)
 * - 컬럼 너비: 헤더와 데이터 중 가장 긴 값 기준
 */
export function formatSheet(ws: XLSX.WorkSheet) {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1")

  // 컬럼별 최대 너비 추적
  const colWidths: number[] = []

  for (let c = range.s.c; c <= range.e.c; c++) {
    let maxLen = 0
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (!cell) continue

      // 숫자 서식 (헤더 제외)
      if (r > range.s.r && typeof cell.v === "number") {
        cell.z = Number.isInteger(cell.v) ? "#,##0" : "#,##0.00"
      }

      // 너비 계산: 표시될 문자열 길이
      const val = cell.v != null ? String(cell.v) : ""
      // 한글은 약 2칸, 숫자/영문은 1칸
      const len = [...val].reduce((s, ch) => s + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)
      if (len > maxLen) maxLen = len
    }
    colWidths.push(Math.min(Math.max(maxLen + 2, 6), 40))
  }

  ws["!cols"] = colWidths.map((w) => ({ wch: w }))
}
