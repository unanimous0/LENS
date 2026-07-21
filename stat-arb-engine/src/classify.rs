//! ETF 분류 레이어.
//!
//! 통계 발굴 결과가 지수형·레버리지 ETF로 도배되는 문제를 응답단에서 걸러내기 위한
//! **순수 부가 메타데이터**. 발굴 게이팅(corr/R²/ADF/half-life)엔 절대 개입하지 않는다.
//!
//! DB(`etf_master_daily`)에 유형 컬럼이 없어 분류 후크는 3개뿐:
//!   - `underlying_index` (문자열, 최신 스냅샷 기준 ~62%만 채워짐)
//!   - `kr_name`          (주 신호)
//!   - `replication`      ('실물/합성(패시브/액티브)')
//!
//! 판정은 우선순위 리스트(위→아래) — 먼저 매칭되는 카테고리로 확정.
//! regex 없이 정규화(대문자화 + 공백제거) + 부분문자열 매칭으로 처리(신규 의존성 회피,
//! 내부망 빌드 호환). 패턴은 최신 스냅샷 전체(681 ETF)에 대해 `other` 최소화하도록 튜닝.

use serde::Serialize;

/// ETF 카테고리. serde 태그는 안정적 문자열(프론트 필터 칩·API 파라미터에 그대로 사용).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EtfCategory {
    /// 광범위 지수 (코스피200/코스닥150 등 시장 대표).
    BroadIndex,
    /// 레버리지·인버스 (2X/곱버스/인버스). 배수형은 성격이 완전히 달라 최우선 분리.
    LeverageInverse,
    /// 섹터 (반도체/은행/자동차 등 산업 분류).
    Sector,
    /// 테마·전략 (2차전지/바이오/커버드콜/TOP10 등).
    Theme,
    /// 채권·금리 (국고채/회사채/머니마켓/KOFR 등).
    BondRates,
    /// 팩터 (배당/밸류업/모멘텀/저변동 등).
    Factor,
    /// 해외 (미국/나스닥/차이나/글로벌 등).
    Overseas,
    /// 원자재 (골드/원유/구리 등).
    Commodity,
    /// 액티브·무지수 (ui 비어있고 replication 액티브).
    Active,
    /// 기타 — 위 어디에도 안 걸림.
    Other,
}

impl EtfCategory {
    /// 안정적 문자열 태그. API 파라미터(`exclude_categories`)·프론트 칩과 1:1.
    pub fn as_tag(&self) -> &'static str {
        match self {
            EtfCategory::BroadIndex => "broad_index",
            EtfCategory::LeverageInverse => "leverage_inverse",
            EtfCategory::Sector => "sector",
            EtfCategory::Theme => "theme",
            EtfCategory::BondRates => "bond_rates",
            EtfCategory::Factor => "factor",
            EtfCategory::Overseas => "overseas",
            EtfCategory::Commodity => "commodity",
            EtfCategory::Active => "active",
            EtfCategory::Other => "other",
        }
    }
}

/// 대문자화 + 공백 제거. 스펙의 `?`(선택 공백) 패턴을 정규화 한 번으로 흡수.
/// 한글은 대문자화 영향 없음, 라틴(GOLD/WTI/MSCI/S&P/CD…)만 통일.
/// `is_same_underlying`(베이시스형 판정)도 이 정규화를 공유 — 발행사별 표기 공백/대소문자
/// 차이("코스피 200" vs "코스피200")를 흡수하되, 다른 지수(선물지수 등)는 그대로 구분.
pub(crate) fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase()
}

/// 정규화된 haystack에 needle(이미 정규화 상태) 중 하나라도 포함되면 true.
fn has_any(hay: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| hay.contains(n))
}

// --- 카테고리별 키워드 (모두 정규화 상태: 대문자 + 공백 없음) ---

const KW_LEVERAGE: &[&str] = &["레버리지", "인버스", "2X", "2배", "곱버스", "-1X", "3X"];

const KW_BOND: &[&str] = &[
    "채권", "국고채", "회사채", "통안", "CD금리", "KOFR", "SOFR", "머니마켓", "MMF",
    "종합채권", "스트립", "STRIP", "국채", "크레딧", "단기자금", "MSB", "KTB", "은행채",
    "금리액티브", "단기통안", "물가채", "TIPS", "하이일드", "IBOXX",
];

const KW_COMMODITY: &[&str] = &[
    "골드", "GOLD", "금선물", "금현물", "금액티브", "국제금", "KRX금", "은선물", "은현물",
    "원유", "WTI", "천연가스", "구리", "농산물", "귀금속", "팔라듐", "플래티넘", "커머디티",
    "원자재",
];

const KW_OVERSEAS: &[&str] = &[
    "미국", "나스닥", "S&P500", "필라델피아", "차이나", "중국", "일본", "유럽", "유로",
    "글로벌", "선진국", "신흥국", "베트남", "인도", "다우", "홍콩", "니케이", "항셍", "항생",
    "대만", "CSI", "STOXX", "월드", "이머징", "브라질", "아시아", "ASIA", "라틴", "LATIN",
    "AMERICA", "심천", "SZSE", "CHINEXT", "DAX", "독일", "TSMC", "선진",
];

/// 광범위 지수 토큰 — ui/name 어느 쪽에 있어도 인정. 라틴·한글 표기 둘 다.
/// 바 `200`은 lev/bond/commodity/overseas를 먼저 claim한 뒤라 KOSPI200 계열만 남는다.
const KW_BROAD: &[&str] = &[
    "코스피200", "KOSPI200", "코스닥150", "KOSDAQ150", "코스피100", "KOSPI100",
    "코스피지수", "코스닥지수", "대형주", "KRX300", "KRX100", "코스피50", "코스피TR",
    "MSCIKOREA", "중형주", "중소형", "200",
];

/// 섹터 토큰 — 산업 분류. 스펙의 KRX/코스피200 접두 조합 + 표기상 접두 없이도 명확한 산업어.
const KW_SECTOR: &[&str] = &[
    "반도체", "은행", "자동차", "보험", "증권", "철강", "미디어", "건설", "운송", "조선",
    "금융", "정보기술", "산업재", "중공업", "에너지화학", "철강소재", "생활소비재",
    "경기소비재", "필수소비재", "기계장비", "소프트웨어", "의료기기", "지주회사",
    "IT하드웨어", "IT소프트웨어", "IT플러스",
];

const KW_THEME: &[&str] = &[
    "2차전지", "뉴딜", "소부장", "바이오", "게임", "메타버스", "플랫폼", "친환경", "원자력",
    "원전", "SMR", "방산", "우주", "로봇", "AI", "인공지능", "K-", "BBIG", "커버드콜",
    "TOP10", "TOP3", "TOP30", "TOP5", "TOP2", "수소", "전기차", "리츠", "부동산", "인프라",
    "화장품", "엔터", "테크", "디지털", "클라우드", "헬스케어", "CDMO", "바이오시밀러",
    "그룹", "포커스", "KPOP", "TDF", "TRF", "ESG", "여행", "레저", "커머스", "농업", "웹툰",
    "드라마", "콘텐츠", "골프", "테마", "태양광", "신재생", "기후", "배터리", "전고체",
    "밸류체인", "설비투자", "CAPEX", "소비", "5G", "수출", "내수", "모빌리티", "업종",
    "전략기술",
];

const KW_FACTOR: &[&str] = &[
    "배당", "밸류업", "밸류", "가치", "성장", "퀄리티", "모멘텀", "저변동", "로우볼",
    "동일가중", "멀티팩터", "변동성", "블루칩", "우선주",
];

/// ETF 1건 분류. 우선순위대로 첫 매칭 카테고리 확정.
///
/// - `underlying_index`: DB 컬럼(빈 문자열 가능)
/// - `kr_name`: 종목명(주 신호)
/// - `replication`: '실물/합성(패시브/액티브)'
pub fn classify_etf(underlying_index: &str, kr_name: &str, replication: &str) -> EtfCategory {
    let ui = norm(underlying_index);
    let nm = norm(kr_name);
    // 대부분 패턴은 이름·지수 양쪽 어디에 있어도 인정 (이름에만 있는 경우가 다수).
    let both = format!("{ui}|{nm}");

    // 1) 레버리지·인버스 — 배수형은 최우선 분리.
    if has_any(&both, KW_LEVERAGE) {
        return EtfCategory::LeverageInverse;
    }
    // 2) 채권·금리.
    if has_any(&both, KW_BOND) {
        return EtfCategory::BondRates;
    }
    // 3) 원자재 ('금융'의 '금' 오탐 방지 위해 구체 토큰만 — 골드/금선물/금현물/국제금 등).
    if has_any(&both, KW_COMMODITY) {
        return EtfCategory::Commodity;
    }
    // 4) 해외. MSCI는 국내(MSCI Korea) 제외.
    if has_any(&both, KW_OVERSEAS) || (both.contains("MSCI") && !both.contains("MSCIKOREA")) {
        return EtfCategory::Overseas;
    }
    // 5) 광범위 지수 — 광범위 토큰이 있고 섹터/팩터 키워드가 없을 때만.
    if has_any(&both, KW_BROAD) && !has_any(&both, KW_SECTOR) && !has_any(&both, KW_FACTOR) {
        return EtfCategory::BroadIndex;
    }
    // 6) 섹터.
    if has_any(&both, KW_SECTOR) {
        return EtfCategory::Sector;
    }
    // 7) 테마·전략.
    if has_any(&both, KW_THEME) {
        return EtfCategory::Theme;
    }
    // 8) 팩터.
    if has_any(&both, KW_FACTOR) {
        return EtfCategory::Factor;
    }
    // 9) 액티브·무지수 — ui 비어있고 replication에 '액티브'.
    if underlying_index.trim().is_empty() && replication.contains("액티브") {
        return EtfCategory::Active;
    }
    // 10) 기타.
    EtfCategory::Other
}

/// 광범위 지수 **복제 패밀리** — 베이시스형(복제) 페어 판정용. 순수 시장대표 복제만 Some.
///
/// 사용자 결정(2026-07): `200·200TR·150·150TR·코스피100·선물레버리지·200액티브` 등 같은 광범위
/// 노출의 복제 계열은 전부 베이시스로 분리. 커버드콜/채권혼합/동일가중/중소형/롱숏/섹터/테마/
/// 팩터/해외/원자재는 별상품이라 None(통계차익 유지) — 액티브라도 이런 별상품이면 None.
///
/// underlying_index가 비어도(인포맥스가 액티브·TR엔 값을 안 줌) 종목명으로 기준지수를 유추.
/// 반환값은 `"KOSPI_BROAD"` / `"KOSDAQ_BROAD"` — 두 leg의 패밀리가 같으면 베이시스.
pub fn benchmark_family(underlying_index: &str, kr_name: &str) -> Option<&'static str> {
    let ui = norm(underlying_index);
    let nm = norm(kr_name);
    let both = format!("{ui}|{nm}");

    // 순수 광범위 복제가 아닌 별상품 제외. 레버리지/인버스/선물/TR/액티브는 **제외 안 함**(베이시스 포함 대상).
    const DISQ_EXTRA: &[&str] = &[
        "위클리", "타겟", "혼합", "동일가중", "중소형", "중형주", "롱", "숏",
    ];
    if has_any(&both, DISQ_EXTRA)
        || has_any(&both, KW_BOND)
        || has_any(&both, KW_COMMODITY)
        || has_any(&both, KW_OVERSEAS)
        || has_any(&both, KW_SECTOR)
        || has_any(&both, KW_THEME)
        || has_any(&both, KW_FACTOR)
    {
        return None;
    }
    // 기준지수 판정 — 위 제외를 통과한 순수 광범위만 남음(선물/레버리지/인버스/TR 변종 포함).
    if both.contains("코스피100") || both.contains("KOSPI100") {
        return Some("KOSPI_BROAD");
    }
    if both.contains("코스피200") || both.contains("KOSPI200") || both.contains("200") {
        return Some("KOSPI_BROAD");
    }
    if both.contains("코스닥150") || both.contains("KOSDAQ150") || both.contains("150") {
        return Some("KOSDAQ_BROAD");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 최신 스냅샷 전체(psql 덤프 TSV)에 대해 분류 분포를 찍는 검증 테스트.
    /// 환경변수 `CLASSIFY_TEST_TSV`로 TSV 경로 지정 시에만 동작(미지정 시 skip).
    /// TSV 포맷: etf_code<TAB>kr_name<TAB>underlying_index<TAB>replication.
    /// 실행: `CLASSIFY_TEST_TSV=/path/etf_latest.tsv cargo test classify_distribution -- --nocapture`
    #[test]
    fn classify_distribution() {
        let Ok(path) = std::env::var("CLASSIFY_TEST_TSV") else {
            eprintln!("CLASSIFY_TEST_TSV 미지정 — skip");
            return;
        };
        let text = std::fs::read_to_string(&path).expect("TSV 읽기 실패");
        let mut counts: std::collections::BTreeMap<&'static str, usize> = Default::default();
        let mut others: Vec<String> = Vec::new();
        let mut total = 0usize;
        for line in text.lines() {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 2 {
                continue;
            }
            let code = cols[0];
            let name = cols[1];
            let ui = cols.get(2).copied().unwrap_or("");
            let repl = cols.get(3).copied().unwrap_or("");
            let cat = classify_etf(ui, name, repl);
            *counts.entry(cat.as_tag()).or_insert(0) += 1;
            if cat == EtfCategory::Other {
                others.push(format!("{code}\t{name}\t[{ui}]\t{repl}"));
            }
            total += 1;
        }
        eprintln!("=== 분류 분포 (총 {total}) ===");
        let mut sorted: Vec<_> = counts.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (tag, n) in sorted {
            eprintln!("  {tag:18} {n:4}  ({:.1}%)", *n as f64 / total as f64 * 100.0);
        }
        eprintln!("=== other {} 건 ===", others.len());
        for o in &others {
            eprintln!("  {o}");
        }
    }
}
