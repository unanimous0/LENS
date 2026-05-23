/// ls_data_test — LS API 데이터 수신 테스트 서버
///
/// 아키텍처:
///   ls_ws::run  ──mpsc──→  state::run_updater  ──broadcast──→  http_ws
///                                                                 ↓ WebSocket
///                                                           브라우저 (index.html)
///
/// 포트: .env PORT (기본 9100)
///
/// 구독 목록 변경: SUBSCRIPTIONS 상수.
/// Phase 1: S3_ 삼성전자 + H1_ 호가

mod auth;
mod config;
mod http_ws;
mod ls_rest;
mod ls_ws;
mod state;

use std::sync::Arc;

use axum::{
    Router,
    routing::get,
    response::Html,
};
use tokio::sync::{broadcast, mpsc};
use tower_http::cors::CorsLayer;

use config::Config;
use state::WsEvent;

// ─────────────────────────────────────────────────────────────────────────────
// 구독 목록 — Phase 별로 주석 처리하면서 늘려간다
// ─────────────────────────────────────────────────────────────────────────────
//
// 형식: (TR코드, 종목코드)
//
// Phase 1 (현재): 삼성전자 체결 + 호가
// Phase 2: K3_/HA_ 추가 (KOSDAQ 종목)
// Phase 3: I5_ ETF iNAV
// Phase 4: JC0 주식선물 체결
// Phase 5: JH0 주식선물 호가 (10단 vs 5단 검증)
// Phase 6: FC9/FH9 지수선물
// Phase 7: IJ_ 지수 (tr_key 실험)

const SUBSCRIPTIONS: &[(&str, &str)] = &[
    // ── Phase 1: 삼성전자 (KOSPI) ──────────────────────────────────────────
    ("S3_", "005930"),  // 삼성전자 체결
    ("H1_", "005930"),  // 삼성전자 호가 10단 (KOSPI)

    // ── Phase 2: 나머지 주식 전종목 ────────────────────────────────────────
    // KOSPI (S3_ 체결 + H1_ 호가)
    ("S3_", "000660"),  // SK하이닉스
    ("H1_", "000660"),
    ("S3_", "009150"),  // 삼성전기
    ("H1_", "009150"),
    ("S3_", "066570"),  // LG전자
    ("H1_", "066570"),
    ("S3_", "005380"),  // 현대차
    ("H1_", "005380"),
    ("S3_", "402340"),  // SK스퀘어
    ("H1_", "402340"),
    ("S3_", "012330"),  // 현대모비스
    ("H1_", "012330"),
    // KOSDAQ (K3_ 체결 + HA_ 호가)
    ("K3_", "036930"),  // 주성엔지니어링
    ("HA_", "036930"),
    ("K3_", "036540"),  // SFA반도체
    ("HA_", "036540"),
    ("K3_", "086520"),  // 에코프로
    ("HA_", "086520"),

    // ── Phase 3: ETF iNAV ──────────────────────────────────────────────────
    ("S3_", "069500"),  ("I5_", "069500"),  // KODEX 200
    ("S3_", "122630"),  ("I5_", "122630"),  // KODEX 레버리지
    ("S3_", "233740"),  ("I5_", "233740"),  // KODEX 코스닥150 레버리지
    ("S3_", "102110"),  ("I5_", "102110"),  // TIGER 200
    ("S3_", "091160"),  ("I5_", "091160"),  // KODEX 반도체
    ("S3_", "229200"),  ("I5_", "229200"),  // KODEX 코스닥150
    ("S3_", "396500"),  ("I5_", "396500"),  // KODEX 200타겟위클리커버드콜
    ("S3_", "114800"),  ("I5_", "114800"),  // KODEX 인버스
    ("S3_", "252670"),  ("I5_", "252670"),  // KODEX 200선물인버스2X
    ("S3_", "251340"),  ("I5_", "251340"),  // KODEX 코스닥150선물인버스
    ("S3_", "364980"),  ("I5_", "364980"),  // TIGER 차이나전기차SOLACTIVE
    ("S3_", "0117V0"),  ("I5_", "0117V0"),  // 알파벳 포함 코드 — t1102 스킵 예상

    // ── Phase 4: 주식선물 체결 (JC0) ─────────────────────────────────────
    // 코드 형식: A + 품목코드(2) + 연도끝자리(1) + 월(1) + 000
    // 2026-05-23 기준: 근월=6월(6), 차월=7월(7)  ← futures_master.json 확인
    ("JC0", "A1166000"),  ("JC0", "A1167000"),  // 삼성전자
    ("JC0", "A5066000"),  ("JC0", "A5067000"),  // SK하이닉스
    ("JC0", "A2366000"),  ("JC0", "A2367000"),  // 삼성전기
    ("JC0", "A2466000"),  ("JC0", "A2467000"),  // LG전자
    ("JC0", "A1666000"),  ("JC0", "A1667000"),  // 현대차
    ("JC0", "A2066000"),  ("JC0", "A2067000"),  // 현대모비스
    ("JC0", "AFE66000"),  ("JC0", "AFE67000"),  // SK스퀘어

    // ── Phase 5: 주식선물 호가 (JH0) — 실제 레벨 수 검증 ──────────────────
    // LS API doc=10단, LENS code=5단 파싱 → raw body로 실측
    ("JH0", "A1166000"),  // 삼성전자 6월물
    ("JH0", "A5066000"),  // SK하이닉스 6월물

    // ── Phase 6: 지수선물 ────────────────────────────────────────────────
    // KOSPI200 선물: FC9(체결) + FH9(호가, 5단 — JH0의 10단과 다름)
    ("FC9", "A0166000"),  ("FC9", "A0167000"),  // KOSPI200 6월·7월물 체결
    ("FH9", "A0166000"),                        // KOSPI200 6월물 호가
    // KOSDAQ150 선물: JC0로 동작하는지 실측 (전용 TR 없음)
    ("JC0", "A0666000"),  ("JC0", "A0667000"),  // KOSDAQ150 6월·7월물

    // ── Phase 7: 지수 (IJ_) — KOSDAQ150 tr_key 실험 ───────────────────────
    ("IJ_", "001"),  // KOSPI200 지수 (확인된 tr_key)
    ("IJ_", "003"),  // KOSDAQ150 — 추정값 1 (실측 필요)
    ("IJ_", "301"),  // KOSDAQ150 — 추정값 2 (실측 필요)
];

// ─────────────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // .env 로드
    dotenvy::dotenv().ok();

    // 로깅 초기화
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("ls_data_test=debug".parse().unwrap()),
        )
        .with_target(false)
        .with_thread_ids(false)
        .init();

    // 설정
    let config = match Config::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!("ls-data-test starting on port {}", config.port);
    tracing::info!("subscriptions: {} pairs", SUBSCRIPTIONS.len());
    for (tr_cd, code) in SUBSCRIPTIONS {
        tracing::debug!("  → {tr_cd} {code}");
    }

    // 채널
    let (event_tx, event_rx) = mpsc::channel::<WsEvent>(4096);
    let (snapshot_tx, _)      = broadcast::channel::<String>(64);

    // 공유 상태
    let shared_state = state::new_state();

    // 구독 목록 전체를 빈 entry로 미리 채워넣기
    // → 장외 시간에도 모든 구독 항목이 화면에 표시됨
    state::prefill_subscriptions(shared_state.clone(), SUBSCRIPTIONS).await;

    // 태스크 1: LS API WS 연결 (재연결 루프)
    {
        let cfg   = config.clone();
        let etx   = event_tx.clone();
        let subs  = SUBSCRIPTIONS.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        tokio::spawn(async move {
            ls_ws::run(cfg, subs, etx).await;
        });
    }

    // 태스크 1-b: t1102 초기값 REST fetch — 종가 포함 (장외에도 동작)
    // WS 구독 종목 중 주식/ETF(6자리) 코드만 대상.
    {
        let cfg  = config.clone();
        let etx  = event_tx.clone();
        let codes: Vec<String> = SUBSCRIPTIONS.iter()
            .map(|(_, code)| code.to_string())
            .collect::<std::collections::HashSet<_>>() // 중복 제거 (S3_/H1_ 같은 코드 중복)
            .into_iter()
            .collect();
        tokio::spawn(async move {
            // WS 연결이 먼저 시도되는 동안 잠깐 대기 (토큰 발급 경합 최소화)
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            ls_rest::fetch_initial_prices(&cfg, &codes, &etx).await;
        });
    }

    // 태스크 2: state updater (event_rx → SharedState → snapshot broadcast)
    {
        let st  = shared_state.clone();
        let stx = snapshot_tx.clone();
        tokio::spawn(async move {
            state::run_updater(st, event_rx, stx).await;
        });
    }

    // 태스크 3: 1초 heartbeat — 장외 시간처럼 틱이 없어도 브라우저 UI 갱신
    {
        let st  = shared_state.clone();
        let stx = snapshot_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                let g = st.read().await;
                let snap = state::Snapshot {
                    ts:      state::now_us(),
                    conn:    g.conn.clone(),
                    entries: g.entries.clone(),
                };
                drop(g);
                if let Ok(json) = serde_json::to_string(&snap) {
                    let _ = stx.send(json); // receiver 없으면 무시
                }
            }
        });
    }

    // axum 서버
    let app = Router::new()
        .route("/",   get(index_html))
        .route("/ws", get(http_ws::ws_handler))
        .route("/api/snapshot", get(api_snapshot))
        .with_state(snapshot_tx)
        .layer(CorsLayer::permissive());

    // 라우터에 SharedState도 필요한 경우를 위해 별도 레이어로 추가
    // (현재 /api/snapshot에서 사용)
    let app = app.layer(axum::Extension(shared_state));

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("listening on http://{addr}");

    axum::serve(listener, app).await.unwrap();
}

/// GET / → index.html (인라인 서빙)
async fn index_html() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

/// GET /api/snapshot → 현재 상태 JSON (폴링 fallback)
async fn api_snapshot(
    axum::Extension(state): axum::Extension<state::SharedState>,
) -> axum::Json<state::Snapshot> {
    let g = state.read().await;
    axum::Json(state::Snapshot {
        ts:      state::now_us(),
        conn:    g.conn.clone(),
        entries: g.entries.clone(),
    })
}
