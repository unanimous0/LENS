//! 데이터 레이어 — Finance_Data PG 로드 + (향후) realtime 스냅샷 동기화.
//!
//! PR1: PG 연결 헬스체크만.
//! PR2: Bar/AssetSeries 타입 + 일봉/분봉 로더 + 캐시 + 워밍업.

pub mod bars;
pub mod pg_loader;
