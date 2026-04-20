"""
KB Monitor - Python 시세 수신 클라이언트 (HFT/MM 최적화)

HFT/MM 시스템 성능 최적화 적용:
- 지연시간 최소화: TCP_NODELAY, 큰 버퍼 (64KB), 최소 sleep (0.1ms)
- 메모리 효율: dict 기반 O(1) 조회, list 제거로 O(n) 연산 제거
- I/O 최소화: DEBUG_MODE로 로그 제어, 프로덕션에서 최소 출력
- 연산 최적화: 조건문 최적화 (빈번한 케이스 먼저), 불필요한 계산 제거
- JSON 최적화: orjson 우선 사용 (C 구현, 2-5배 빠름)
"""
import socket
import threading
import queue
import time
import uuid
import traceback
from typing import Tuple, Optional, List, Dict
from dataclasses import dataclass

from pydantic import BaseModel


# HFT 설정: 디버그 모드 (프로덕션에서는 False로 설정)
DEBUG_MODE = True  # True: 개발용 로그 출력, False: 프로덕션 (최소 로그)


# JSON 헬퍼 함수 정의 (빠른 라이브러리 우선 사용)
try:
    # orjson은 C로 구현된 매우 빠른 JSON 라이브러리
    # 설치되어 있다면 import에 성공
    import orjson as _json

    def json_loads(data):
        """
        JSON 데이터를 파이썬 객체(dict, list 등)으로 변환
        
        orjson의 핵심 장점:
        - bytes를 직접 받아서 처리 (decode 불필요)
        - str도 처리 가능하지만 bytes가 더 빠름
        
        Parameters:
        - data: bytes 또는 str
        
        Returns:
        - dict, list 등의 파이썬 객체
        """
        return _json.loads(data)    # loads : json 문자열 또는 bytes를 파이썬 객체(dict, list 등)로 변환

    def json_dumps(obj) -> bytes:
        """
        파이썬 객체를 JSON bytes로 직렬화
        orjson.dumps는 기본적으로 bytes를 반환
        """
        return _json.dumps(obj)

    JSON_LIB_NAME = "orjson"

except ImportError:
    # 만약 orjson이 설치되어 있지 않으면, 기본 json 모듈 사용
    import json as _json

    def json_loads(data):
        """
        JSON 데이터를 파이썬 객체로 변환 (표준 json 버전)
        
        표준 json.loads는 str만 처리 가능하므로,
        bytes가 들어오면 자동으로 decode 처리
        
        Parameters:
        - data: bytes 또는 str
        
        Returns:
        - dict, list 등의 파이썬 객체
        """
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return _json.loads(data)

    def json_dumps(obj) -> bytes:
        """
        파이썬 객체를 JSON 문자열로 만든 뒤, UTF-8 인코딩하여 bytes로 변환
        """
        return _json.dumps(obj).encode("utf-8")

    JSON_LIB_NAME = "json"


# 로그인시 서버로부터 모든 종목 정보 수신
@dataclass
class ProductRecord:
    """종목 정보 (EOS의 ProductRecord와 동일)"""
    stnd_is_cd: str          = ""           # 표준코드 (풀코드)
    shrt_is_cd: str          = ""           # 단축코드
    is_name: str             = ""           # 종목명
    is_clsf_name: str        = ""           # 종목유형: STK(주식), ETF, ETN, ELW, FTS(선물), OPT(옵션), SPD(스프레드)
    mrkt_clsf: str           = ""           # 시장구분: K(코스피), Q(코스닥), F(파생)
    bsc_asts_stnd_is_cd: str = ""           # 기초자산 표준코드
    bsc_asts_shrt_is_cd: str = ""           # 기초자산 단축코드
    bsc_asts_is_name: str    = ""           # 기초자산 종목명
    excs_prc: float          = 0.0          # 행사가
    rgt_type_cd: str         = ""           # 권리유형: 01(콜), 02(풋)
    fnl_dl_dt: str           = ""           # 만기일
    lstng_stk_qty: int       = 0            # 상장주식수
    bdy_prc: float           = 0.0          # 전일종가
    ulmt_prc: float          = 0.0          # 상한가
    llmt_prc: float          = 0.0          # 하한가

    @classmethod
    def struct_product_data(cls, data: dict) -> 'ProductRecord':
        """서버 JSON 데이터를 ProductRecord로 변환"""
        return cls(
            stnd_is_cd          = data.get('stnd_is_cd', ''),
            shrt_is_cd          = data.get('shrt_is_cd', ''),
            is_name             = data.get('is_name', ''),
            is_clsf_name        = data.get('is_clsf_name', ''),
            mrkt_clsf           = data.get('mrkt_clsf', ''),
            bsc_asts_stnd_is_cd = data.get('bsc_asts_stnd_is_cd', ''),
            bsc_asts_shrt_is_cd = data.get('bsc_asts_shrt_is_cd', ''),
            bsc_asts_is_name    = data.get('bsc_asts_is_name', ''),
            excs_prc            = float(data.get('excs_prc', 0)),
            rgt_type_cd         = data.get('rgt_type_cd', ''),
            fnl_dl_dt           = data.get('fnl_dl_dt', ''),
            lstng_stk_qty       = int(data.get('lstng_stk_qty', 0)),
            bdy_prc             = float(data.get('bdy_prc', 0)),
            ulmt_prc            = float(data.get('ulmt_prc', 0)),
            llmt_prc            = float(data.get('llmt_prc', 0)),
        )

# 잔고/매매 데이터
@dataclass
class BalanceRecord:
    """잔고/매매 데이터 (EOS의 KBMonitorBalanceRecord와 동일)"""
    gds_fnd_cd: str      = ""           # 펀드코드
    stnd_is_cd: str      = ""           # 표준코드
    shrt_is_cd: str      = ""           # 단축코드
    is_nm: str           = ""           # 종목명
    
    # 당일 매매 데이터
    thdy_buy_qty: float  = 0.0          # 당일 매수 수량
    thdy_buy_amt: float  = 0.0          # 당일 매수 금액
    thdy_sell_qty: float = 0.0          # 당일 매도 수량
    thdy_sell_amt: float = 0.0          # 당일 매도 금액
    
    # 잔고 데이터
    bdy_blnc_qty: float  = 0.0          # 전일 잔고 수량
    bdy_blnc_amt: float  = 0.0          # 전일 잔고 금액
    thdy_blnc_qty: float = 0.0          # 당일 잔고 수량
    thdy_blnc_amt: float = 0.0          # 당일 잔고 금액
    
    @classmethod
    def struct_balance_data(cls, data: dict) -> 'BalanceRecord':
        """서버 JSON 데이터를 BalanceRecord로 변환"""
        return cls(
            gds_fnd_cd    = data.get('gds_fnd_cd', ''),
            stnd_is_cd    = data.get('stnd_is_cd', ''),
            shrt_is_cd    = data.get('shrt_is_cd', ''),
            is_nm         = data.get('is_nm', ''),
            thdy_buy_qty  = float(data.get('thdy_buy_qty', 0)),
            thdy_buy_amt  = float(data.get('thdy_buy_amt', 0)),
            thdy_sell_qty = float(data.get('thdy_sell_qty', 0)),
            thdy_sell_amt = float(data.get('thdy_sell_amt', 0)),
            bdy_blnc_qty  = float(data.get('bdy_blnc_qty', 0)),
            bdy_blnc_amt  = float(data.get('bdy_blnc_amt', 0)),
            thdy_blnc_qty = float(data.get('thdy_blnc_qty', 0)),
            thdy_blnc_amt = float(data.get('thdy_blnc_amt', 0)),
        )

class ProductManager:
    """종목 정보 관리 (EOS의 SharedDataStorage와 유사)"""
    def __init__(self):
        self.product_list: List[ProductRecord] = []
        self.code_product_map: Dict[str, ProductRecord] = {}        # 풀코드 -> ProductRecord
        self.short_code_product_map: Dict[str, ProductRecord] = {}  # 단축코드 -> ProductRecord
        self.is_loading_complete = False
        self.loading_start_time = None
        self.last_batch_count = 0
        self.last_update_time = None

    def add_product(self, product: ProductRecord):
        """종목 추가"""
        self.product_list.append(product)
        self.code_product_map[product.stnd_is_cd] = product
        self.short_code_product_map[product.shrt_is_cd] = product
        self.last_update_time = time.time()

    def clear(self):
        """종목 정보 초기화"""
        self.product_list.clear()
        self.code_product_map.clear()
        self.short_code_product_map.clear()
        self.is_loading_complete = False
        self.last_batch_count = 0
        self.last_update_time = None

    def get_by_short_code(self, short_code: str) -> Optional[ProductRecord]:
        """단축코드로 종목 조회"""
        return self.short_code_product_map.get(short_code)
        
    def get_by_full_code(self, full_code: str) -> Optional[ProductRecord]:
        """풀코드로 종목 조회"""
        return self.code_product_map.get(full_code)

    def convert_to_full_code(self, code: str) -> str:
        """단축코드 또는 풀코드를 풀코드로 변환"""
        # 이미 풀코드인 경우
        if code in self.code_product_map:
            return code
        # 단축코드인 경우
        product = self.short_code_product_map.get(code)
        if product:
            return product.stnd_is_cd
        # 찾지 못한 경우 원본 반환
        return code

    def filter_by_type(self, is_clsf_name: str) -> List[ProductRecord]:
        """종목 유형으로 필터링 (STK, ETF, ETN, FTS, OPT 등)"""
        return [p for p in self.product_list if p.is_clsf_name == is_clsf_name]

    def get_statistics(self) -> dict:
        """종목 통계"""
        stats = {}
        for product in self.product_list:
            type_name = product.is_clsf_name
            stats[type_name] = stats.get(type_name, 0) + 1
        return stats

    def mark_loading_complete(self):
        """종목 로딩 완료 표시"""
        self.is_loading_complete = True
        loading_time = time.time() - self.loading_start_time if self.loading_start_time else 0

        print(f"\n{'='*60}")
        print(f"[ProductManager] 종목 정보 로딩 완료!")
        print(f"  - 총 종목 수: {len(self.product_list):,}개")
        print(f"  - 로딩 시간: {loading_time:.2f}초")
        print(f"  - 종목 유형별 통계:")

        for type_name, count in sorted(self.get_statistics().items()):
            type_desc = {
                'STK': '주식',
                'ETF': 'ETF',
                'ETN': 'ETN',
                'ELW': 'ELW',
                'FTS': '선물',
                'OPT': '옵션',
                'SPD': '스프레드'
            }.get(type_name, type_name)
            print(f"    · {type_desc}({type_name}): {count:,}개")
        print(f"{'='*60}\n")


class BalanceManager:
    """잔고/매매 데이터 관리 (HFT 최적화: O(1) 조회/업데이트)"""
    def __init__(self):
        # HFT 최적화: dict만 사용 (list 제거로 O(n) 연산 제거)
        self.balance_map: Dict[str, BalanceRecord] = {}  # (펀드코드_종목코드) -> BalanceRecord
        self._count = 0  # 빠른 카운트용
        
    def add_balance(self, balance: BalanceRecord):
        """잔고 데이터 추가/업데이트 (O(1))"""
        key = f"{balance.gds_fnd_cd}_{balance.stnd_is_cd}"
        
        # HFT 최적화: 기존 데이터 체크 없이 바로 덮어쓰기 (O(1))
        if key not in self.balance_map:
            self._count += 1
        
        self.balance_map[key] = balance
    
    def get_balance(self, fund_code: str, instrument_code: str) -> Optional[BalanceRecord]:
        """특정 펀드/종목의 잔고 조회 (O(1))"""
        key = f"{fund_code}_{instrument_code}"
        return self.balance_map.get(key)
    
    def get_balances_by_fund(self, fund_code: str) -> List[BalanceRecord]:
        """특정 펀드의 모든 잔고 조회 (O(n))"""
        # HFT: 조기 종료 최적화
        return [b for b in self.balance_map.values() if b.gds_fnd_cd == fund_code]
    
    def get_count(self) -> int:
        """잔고 건수 (O(1))"""
        return self._count
    
    def clear(self):
        """잔고 데이터 초기화"""
        self.balance_map.clear()
        self._count = 0


# 틱 데이터 표현용 데이터 클래스
class QuoteData(BaseModel):
    instrument_code     : str

    NAV                 : float
    yst_NAV             : float
    last_price          : float
    last_qty            : float
    yst_price           : float

    nav_premium         : float

    open_price          : float
    high_price          : float
    low_price           : float
    volume              : float
    volume_amount       : float

    ask_1_price         : float
    ask_1_qty           : float
    ask_2_price         : float
    ask_2_qty           : float
    ask_3_price         : float
    ask_3_qty           : float
    ask_4_price         : float
    ask_4_qty           : float
    ask_5_price         : float
    ask_5_qty           : float
    ask_6_price         : float
    ask_6_qty           : float
    bid_6_price         : float
    bid_6_qty           : float
    ask_7_price         : float
    ask_7_qty           : float
    ask_8_price         : float
    ask_8_qty           : float
    ask_9_price         : float
    ask_9_qty           : float
    ask_10_price        : float
    ask_10_qty          : float
    
    bid_1_price         : float
    bid_1_qty           : float
    bid_2_price         : float
    bid_2_qty           : float
    bid_3_price         : float
    bid_3_qty           : float
    bid_4_price         : float
    bid_4_qty           : float
    bid_5_price         : float
    bid_5_qty           : float
    bid_7_price         : float
    bid_7_qty           : float
    bid_8_price         : float
    bid_8_qty           : float
    bid_9_price         : float
    bid_9_qty           : float
    bid_10_price        : float
    bid_10_qty          : float

    ask_total_qty       : float
    bid_total_qty       : float

    sell_no1_member     : str
    sell_no1_member_qty : float
    sell_no1_member_amt : float
    sell_no2_member     : str
    sell_no2_member_qty : float
    sell_no2_member_amt : float
    sell_no3_member     : str
    sell_no3_member_qty : float
    sell_no3_member_amt : float
    sell_no4_member     : str
    sell_no4_member_qty : float
    sell_no4_member_amt : float
    sell_no5_member     : str
    sell_no5_member_qty : float
    sell_no5_member_amt : float

    buy_no1_member      : str
    buy_no1_member_qty  : float
    buy_no1_member_amt  : float
    buy_no2_member      : str
    buy_no2_member_qty  : float
    buy_no2_member_amt  : float
    buy_no3_member      : str
    buy_no3_member_qty  : float
    buy_no3_member_amt  : float
    buy_no4_member      : str
    buy_no4_member_qty  : float
    buy_no4_member_amt  : float
    buy_no5_member      : str
    buy_no5_member_qty  : float
    buy_no5_member_amt  : float


    @classmethod
    def struct_quote_data(cls, data: dict) -> "QuoteData":
        # NAV 괴리율 (premium): (현재가 - NAV) / NAV * 100
        NAV = data["thry_prc"]
        last_price = data["cls_prc"]
        nav_premium = 0.0
        if NAV != 0:
            nav_premium = ((last_price - NAV) / NAV) * 100

        return cls(
            instrument_code     = data["stnd_is_cd"],

            NAV                 = NAV,
            yst_NAV             = data["thry_prc_1"],
            last_price          = last_price,
            last_qty            = data["cls_qty"],
            yst_price           = data["bdy_prc"],

            nav_premium         = nav_premium,

            open_price          = data["opn_prc"],
            low_price           = data["lw_prc"],
            high_price          = data["hgh_prc"],
            volume              = data["dl_q"],
            volume_amount       = data["dl_amt"],

            ask_1_price         = data["ask_1_prc"],
            ask_1_qty           = data["ask_1_q"],
            bid_1_price         = data["bid_1_prc"],
            bid_1_qty           = data["bid_1_q"],
            ask_2_price         = data["ask_2_prc"],
            ask_2_qty           = data["ask_2_q"],
            bid_2_price         = data["bid_2_prc"],
            bid_2_qty           = data["bid_2_q"],
            ask_3_price         = data["ask_3_prc"],
            ask_3_qty           = data["ask_3_q"],
            bid_3_price         = data["bid_3_prc"],
            bid_3_qty           = data["bid_3_q"],
            ask_4_price         = data["ask_4_prc"],
            ask_4_qty           = data["ask_4_q"],
            bid_4_price         = data["bid_4_prc"],
            bid_4_qty           = data["bid_4_q"],
            ask_5_price         = data["ask_5_prc"],
            ask_5_qty           = data["ask_5_q"],
            bid_5_price         = data["bid_5_prc"],
            bid_5_qty           = data["bid_5_q"],
            ask_6_price         = data["ask_6_prc"],
            ask_6_qty           = data["ask_6_q"],
            bid_6_price         = data["bid_6_prc"],
            bid_6_qty           = data["bid_6_q"],
            ask_7_price         = data["ask_7_prc"],
            ask_7_qty           = data["ask_7_q"],
            bid_7_price         = data["bid_7_prc"],
            bid_7_qty           = data["bid_7_q"],
            ask_8_price         = data["ask_8_prc"],
            ask_8_qty           = data["ask_8_q"],
            bid_8_price         = data["bid_8_prc"],
            bid_8_qty           = data["bid_8_q"],
            ask_9_price         = data["ask_9_prc"],
            ask_9_qty           = data["ask_9_q"],
            bid_9_price         = data["bid_9_prc"],
            bid_9_qty           = data["bid_9_q"],
            ask_10_price        = data["ask_10_prc"],
            ask_10_qty          = data["ask_10_q"],
            bid_10_price        = data["bid_10_prc"],
            bid_10_qty          = data["bid_10_q"],

            ask_total_qty       = data["ask_tlt_q"],
            bid_total_qty       = data["bid_tlt_q"],

            sell_no1_member     = data["sell_dl_member_1"],
            sell_no1_member_qty = data["sell_dl_member_1_q"],
            sell_no1_member_amt = data["sell_dl_member_1_amt"],
            sell_no2_member     = data["sell_dl_member_2"],
            sell_no2_member_qty = data["sell_dl_member_2_q"],
            sell_no2_member_amt = data["sell_dl_member_2_amt"],
            sell_no3_member     = data["sell_dl_member_3"],
            sell_no3_member_qty = data["sell_dl_member_3_q"],
            sell_no3_member_amt = data["sell_dl_member_3_amt"],
            sell_no4_member     = data["sell_dl_member_4"],
            sell_no4_member_qty = data["sell_dl_member_4_q"],
            sell_no4_member_amt = data["sell_dl_member_4_amt"],
            sell_no5_member     = data["sell_dl_member_5"],
            sell_no5_member_qty = data["sell_dl_member_5_q"],
            sell_no5_member_amt = data["sell_dl_member_5_amt"],

            buy_no1_member      = data["buy_dl_member_1"],
            buy_no1_member_qty  = data["buy_dl_member_1_q"],
            buy_no1_member_amt  = data["buy_dl_member_1_amt"],
            buy_no2_member      = data["buy_dl_member_2"],
            buy_no2_member_qty  = data["buy_dl_member_2_q"],
            buy_no2_member_amt  = data["buy_dl_member_2_amt"],
            buy_no3_member      = data["buy_dl_member_3"],
            buy_no3_member_qty  = data["buy_dl_member_3_q"],
            buy_no3_member_amt  = data["buy_dl_member_3_amt"],
            buy_no4_member      = data["buy_dl_member_4"],
            buy_no4_member_qty  = data["buy_dl_member_4_q"],
            buy_no4_member_amt  = data["buy_dl_member_4_amt"],
            buy_no5_member      = data["buy_dl_member_5"],
            buy_no5_member_qty  = data["buy_dl_member_5_q"],
            buy_no5_member_amt  = data["buy_dl_member_5_amt"],
        )

    def split_item(self) -> Tuple[dict, dict]:
        sym_tags = self.model_dump(include={"instrument_code"})
        fields = self.model_dump(exclude={"instrument_code"})

        """
        # 위에서 사용한 pydantic의 model_dump를 사용하지 않고, 아래처럼 직접 필드를 사용하는 경우가 0.3마이크로초 빠르긴 함
        # 다만 전체 시스템 레이턴시에서 0.1% 정도만 차지 (HFT: 필요시 직접 필드 접근으로 최적화 가능)
        
        sym_tags = {
            "instrument_code": self.instrument_code,
        }

        fields = {
            "base_price": self.base_price,
            "ask_1_price": self.ask_1_price,
            "ask_1_quantity": self.ask_1_quantity,
            "bid_1_price": self.bid_1_price,
            "bid_1_quantity": self.bid_1_quantity,
            "last_trade_price": self.last_trade_price,
            "last_trade_quantity": self.last_trade_quantity,
            "total_quantity": self.total_quantity,
            "total_notional": self.total_notional,
            "NAV": self.NAV,
            "yesterday_NAV": self.yesterday_NAV,
        }
        """

        return sym_tags, fields


# ----------------------------------------------------------------------
# 3. DuplexTCPClient : 수신/송신을 동시에 처리하는 TCP 클라이언트
# ----------------------------------------------------------------------
class DuplexTCPClient:
    """
        내부적으로 두 개의 백그라운드 스레드 사용
        - recv_thraed : 데이터를 계속 읽어서 처리
        - send_thread : 큐에 쌓인 데이터를 계속 보내기
        
        EOS와 동일하게 service_type을 받아서 Control("C") 또는 Quote("S") 연결 구분
    """

    def __init__(self, host, port, service_type, product_manager=None, balance_manager=None):
        """
        Args:
            host: 서버 IP
            port: 서버 포트
            service_type: "C" (Control) 또는 "S" (Quote)
            product_manager: 종목 관리자 (Quote 클라이언트는 Control에서 공유)
            balance_manager: 잔고 관리자 (Quote 클라이언트는 Control에서 공유)
        """
        self.host = host
        self.port = port
        self.service_type = service_type  # "C" or "S"

        # IPv4(TCP) 소켓 생성
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

        # TCP_NODELAY 옵션 : Nagle 알고리즘 비활성화 -> 작은 패킷도 바로바로 전송 (HFT 최적화)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        # 서버에 연결
        self.sock.connect((self.host, self.port))

        # non-blocking 모드 설정
        # recv(), send() 호출 시, 데이터가 준비되지 않았으면 BlockingIOError 예외를 던지고 바로 반환
        self.sock.setblocking(False)

        # 다른 스레드에서 보낼 데이터를 담아둘 큐
        self.send_queue = queue.Queue()

        # 루프를 계속 돌릴지 여부를 제어하는 플래그
        self.running = True

        # 종목 관리자 (Control은 새로 생성, Quote는 공유)
        if product_manager is None:
            self.product_manager = ProductManager()
        else:
            self.product_manager = product_manager
        
        # 잔고 관리자 (Control은 새로 생성, Quote는 공유)
        if balance_manager is None:
            self.balance_manager = BalanceManager()
        else:
            self.balance_manager = balance_manager
        
        # 메시지 처리 핸들러 (service_type에 따라 다름)
        if service_type == "C":
            # Control 연결: 종목 정보 + 잔고 데이터 수신
            self.message_handlers = {
                'isinfo': self._handle_product_record,
                'monitorblnc': self._handle_balance_record,
                'monitorall': self._handle_balance_record,
                'login': self._handle_login_response,
                'l': self._handle_keepalive,
            }
        else:  # "S"
            # Quote 연결: 시세 데이터만 수신
            self.message_handlers = {
                'mrkt_prc': self._handle_quote_data,
                'login': self._handle_login_response,
                'l': self._handle_keepalive,
            }

        # background threads
        self.recv_thread = threading.Thread(target=self.recv_loop, daemon=True)
        self.send_thread = threading.Thread(target=self.send_loop, daemon=True)

        # 스레드 시작
        self.recv_thread.start()
        self.send_thread.start()

    # 수신 루프
    def recv_loop(self):
        """
        * 서버로부터 오는 데이터를 계속 읽어서 처리하는 함수 - 이 함수는 별도의 스레드에서 무한 루프처럼 돌게 됨

        * 실제 틱 처리는 recv_loop() 스레드가 담당
        - 이 스레드는 무한 루프를 돌면서 서버에서 오는 데이터를 계속 읽어옴
        - 틱 데이터를 받으면 파싱하여 처리
        - 틱 데이터를 큐에 넣어 전략 엔진 등으로 넘김

        * 이 서버는 '길이 + 메시지' 형식의 프로토콜을 사용
        - 앞의 5바이트 : 메시지 전체 길이를 나타내는 숫자 (예: b"00123")
        - 그 다음 N바이트 : 실제 JSON 메시지

        * 즉
        1) 먼저 5바이트를 읽어서 length를 파악하고
        2) 그 길이만큼 다시 읽어와서 하나의 메시지로 조립함
        """
        buffer = b""         # 아직 처리되지 않은 바이트들을 쌓아두는 (바이트)버퍼
        expected_len = None # 현재 읽어야 할 메세지의 길이 (아직 모르면 None)

        while self.running:
            try:
                # HFT 최적화: 버퍼 크기 증가 (4KB -> 64KB)
                chunk = self.sock.recv(65536)

                # 서버 연결 종료
                if not chunk:
                    self.running = False
                    break

                buffer += chunk

                # length-prefix 프로토콜 파싱
                while True:
                    if expected_len is None:
                        if len(buffer) < 5:
                            break
                        expected_len = int(buffer[:5])
                        buffer = buffer[5:]

                    if len(buffer) < expected_len:
                        break

                    msg = buffer[:expected_len]
                    buffer = buffer[expected_len:]
                    expected_len = None

                    # JSON 파싱 및 처리
                    try:
                        message = json_loads(msg)
                        self._handle_message(message)
                    except Exception:
                        # JSON 파싱 실패 시 무시 (로깅 제거로 레이턴시 최소화)
                        continue

            except BlockingIOError:
                # HFT 최적화: sleep 시간 최소화 (0.5ms -> 0.1ms)
                time.sleep(0.0001)
                continue

            except Exception as e:
                # 예외 발생 시 간단히 로깅만
                print(f"[{self.service_type}] recv_loop error: {e}")
                traceback.print_exc()
                self.running = False
                break

    def _handle_message(self, message: dict):
        """메시지 타입별 분기 처리 (EOS의 OnReceivedControlData와 유사)"""
        trcd = message.get('trcd')
        
        # 등록된 핸들러가 있으면 실행
        handler = self.message_handlers.get(trcd)
        if handler:
            handler(message)
    
    def _handle_login_response(self, message: dict):
        """로그인 응답 처리 (EOS의 LoginForm.cs와 MainForm.cs)"""
        respcd = message.get('respcd', '')
        
        if str(respcd) == '0':
            print(f"[{self.service_type}] 로그인 성공")
            
            # Control 연결에서만 종목 정보 로딩 시작 시간 기록
            if self.service_type == "C":
                self.product_manager.loading_start_time = time.time()
        else:
            respstr = message.get('respstr', 'Unknown error')
            print(f"[{self.service_type}] 로그인 실패: {respstr}")

    def _handle_keepalive(self, message: dict):
        """Keepalive 메세지 처리 (EOS MainForm.cs의 case "l"과 동일) - HFT: 로깅 제거로 레이턴시 최소화"""
        # 서버로 keepalive 응답 전송
        keepalive_response = {"trcd": "l"}
        self.put_send_queue(json_dumps(keepalive_response))
    
    def _handle_product_record(self, message: dict):
        """종목 정보 수신 처리 (EOS의 LoginForm.cs isinfo 케이스)"""
        fml = message.get('fml', '')
        
        # 첫 번째 메시지 ('f': first)
        if fml == 'f':
            # clear는 첫 번째만
            if len(self.product_manager.product_list) == 0:
                self.product_manager.clear()
                print(f"[isinfo] 종목 정보 수신 시작...")
        
        # 종목 정보 추가
        product = ProductRecord.struct_product_data(message)
        if product.is_clsf_name != 'FOR':   # 해외형 종목정보 ('FOR')는 제외외
            self.product_manager.add_product(product)
        
        # 마지막 메시지 ('l': last)
        if fml == 'l':
            # 첫 번째 'l'에서만 로딩 완료 표시
            if not self.product_manager.is_loading_complete:
                self.product_manager.mark_loading_complete()
    
    def _handle_quote_data(self, message: dict):
        """시세 데이터 수신 처리 (HFT 최적화: I/O 최소화)"""
        respcd = message.get('respcd', '')

        # HFT: 에러 체크 (빈번한 정상 케이스 먼저)
        if str(respcd) == '-1':
            if DEBUG_MODE:
                respstr = message.get('respstr', 'Unknown error')
                print(f"[mrkt_prc] 에러: {respstr}")
            return

        data_type = message.get('data_type', '')
        
        # 구독 응답
        if data_type == 'q':
            if DEBUG_MODE:
                product = self.product_manager.get_by_full_code(message.get('stnd_is_cd', ''))
                if product:
                    print(f"[구독 완료] {product.is_name}")
        else:
            # HFT: 실시간 시세 (여기에 전략 로직 추가)
            # 프로덕션에서는 로그 없음 (최대 성능)
            if DEBUG_MODE:
                stnd_is_cd = message.get('stnd_is_cd', '')
                cls_prc = message.get('cls_prc', 0)
                cls_qty = message.get('cls_qty', 0)
                product = self.product_manager.get_by_full_code(stnd_is_cd)
                product_name = product.is_name if product else stnd_is_cd
                print(f"[시세] {product_name}: {cls_prc:,.0f}원 | {cls_qty:,}주")
    
    def _handle_balance_record(self, message: dict):
        """잔고/매매 데이터 수신 처리 (HFT 최적화: I/O 최소화)"""
        fml = message.get('fml', '')
        respcd = message.get('respcd', '')
        
        # HFT: 에러 체크 (빈번한 조건 먼저)
        if str(respcd) == '2':
            return  # 데이터 없음 (로그 생략)
        
        # HFT: 잔고 데이터 추가 (최소 연산)
        balance = BalanceRecord.struct_balance_data(message)
        self.balance_manager.add_balance(balance)
        
        # HFT: I/O 최소화 - 마지막 메시지에서만 출력
        if fml == 'l' or fml == 'o':
            trcd = message.get('trcd', '')
            count = self.balance_manager.get_count()
            print(f"[{trcd}] 잔고 수신 완료: {count}건")

               

    # --------------------------------------------------------------
    # 송신 루프
    # --------------------------------------------------------------
    def send_loop(self):
        """
        send_queue에 쌓인 데이터를 서버로 보내는 루프 (별도의 스레드에서 작동)

        구조 :
        1) 큐에서 한 건씩 꺼내고
        2) "길이(5바이트) + 실제 메세지"로 프레임을 만든 후
        3) 소켓에 보냄
        4) 부분 전송 처리 : 소켓이 블로킹되면 잠시 양보하고 다시 시도
        """
        while self.running:
            try:
                # 큐에서 전송할 데이터를 꺼냄 (큐에 메세지가 들어올 때까지 최대 timeout 시간만큼 대기)
                # timeout 을 두는 이유 : 프로그램 종료 시 self.running 플래그를 확인하기 위함
                # HFT 최적화: timeout 단축 (100ms -> 50ms)
                msg = self.send_queue.get(timeout=0.05)
            except queue.Empty:
                # 타임아웃 시간 안에 아무것도 들어오지 않아 큐가 비어있으면 queue.Empty 예외를 던지고, 다시 루프로 돌아감
                continue

            # msg는 이미 bytes 형태라고 가정 (encode() 함수를 통해 이미 bytes로 변환되어 있음)
            # (아래 send() 메서드와 __main__ 부분에서 보장)
            frame = f"{len(msg):05d}".encode() + msg    # Ex. b"00042" + 실제 메세지

            # partial write handling : 부분 전송 처리를 위해 반복해서 send
            total_sent = 0
            while total_sent < len(frame):
                try:
                    sent = self.sock.send(frame[total_sent:])
                    if sent == 0:   # 0바이트를 보냈다는 것은 소켓 연결이 끊김
                        raise RuntimeError("socket connection broken")
                    total_sent += sent
                except BlockingIOError:
                    # 소켓 버퍼가 꽉 차서 현재 못 보내는 상황 -> 잠시 양보하고 다시 시도
                    # HFT 최적화: sleep 시간 최소화 (0.3ms -> 0.1ms)
                    time.sleep(0.0001)
                    continue

    def put_send_queue(self, data: bytes):
        """
        외부에서 이 메서드를 호출하면, data를 send_queue에 넣음
        실제 네트워크 전송은 send_loop 스레드가 담당

        data는 반드시 bytes 형태여야 함
        json_dumps(dict) 함수를 사용해서 bytes로 변환한 뒤에 넘겨야 함 (main 함수에서 dump 진행)
        """
        self.send_queue.put(data)   # 여기서 큐에 데이터를 넣고, 실제 전송은 send_loop 스레드가 큐에 있는 데이터를 보냄
        
    def close(self):
        """
        클라이언트를 종료할 때 호출함
        - 내부적으로 running 플래그를 False로 설정하고, 모든 스레드를 종료시킴
        - 소켓 연결도 닫음
        """
        self.running = False
        self.sock.close()   # 실제 소켓 리소스 정리

        # ========== 편의 메서드 (EOS의 QuoteSessionManager.Subscribe와 유사) ==========
    
    def subscribe(self, code: str):
        """
        시세 구독 (HFT 최적화)
        
        Args:
            code: 종목코드 (풀코드 또는 단축코드, 길이로 자동 판단)
        """
        # HFT: 조건문 최적화 (빈번한 케이스 먼저)
        full_code = code if len(code) > 7 else self.product_manager.convert_to_full_code(code)
        
        if DEBUG_MODE:
            product = self.product_manager.get_by_full_code(full_code)
            if product:
                print(f"[구독] {product.is_name}")
        
        # HFT: 구독 메시지 전송
        self.put_send_queue(json_dumps({
            "trcd": "mrkt_prc",
            "data_type": "i",
            "stnd_is_cd": full_code,
            "hash": uuid.uuid4().hex
        }))
    
    def subscribe_multiple(self, codes: List[str]):
        """여러 종목 일괄 구독 (코드 길이로 풀코드/단축코드 자동 판단)"""
        for code in codes:
            self.subscribe(code)
    
    def request_balance_all(self):
        """
        모든 잔고 조회 (HFT 최적화)
        - 서버에 monitorall TRCD 전송
        - 응답은 _handle_balance_record에서 처리
        """
        # HFT: I/O 최소화
        self.put_send_queue(json_dumps({
            "trcd": "monitorall",
            "hash": uuid.uuid4().hex
        }))
    
    def request_balance(self, fund_code: str = None, account_code: str = None, instrument_code: str = None):
        """
        특정 조건의 잔고 조회 (HFT 최적화)
        - 서버에 blncinfo TRCD 전송
        """
        # HFT: 최소 연산 (딕셔너리 한 번에 생성)
        request_params = {"trcd": "blncinfo", "hash": uuid.uuid4().hex}
        
        if fund_code:
            request_params["gds_fnd_cd"] = fund_code
        if account_code:
            request_params["act_cd"] = account_code
        if instrument_code:
            # HFT: 조건문 최적화 (빈번한 케이스 먼저)
            request_params["stnd_is_cd"] = instrument_code if len(instrument_code) > 7 else self.product_manager.convert_to_full_code(instrument_code)
        
        self.put_send_queue(json_dumps(request_params))


# ----------------------------------------------------------------------
# 4. 유틸 함수: 해시 키 생성
# ----------------------------------------------------------------------
def generate_hash_key() -> str:
    """
    서버에 보낼 때 필요한 임의의 hash 키를 생성함
    uuid4 : 128비트(16바이트)의 고유/랜덤 식별자를 생성하는 함수
    이 해시 키는 서버 쪽에서 세션 구분, 요청 트래킹 등에 사용하는 용도
    (HFT 최적화: .hex 사용으로 __str__() 대비 빠름)
    """
    return uuid.uuid4().hex


# ----------------------------------------------------------------------
# 5. 메인 실행부: EOS와 동일하게 Control + Quote 분리 연결
# ----------------------------------------------------------------------
if __name__ == "__main__":
    # 실제 접속 정보
    host = "128.19.248.101" # LIVE
    # host = "10.200.2.210"  # 개발
    port = 8872
    user_id = "SE21297"
    password = "00000000"

    print("="*60)
    print("KB Monitor - Python 시세 수신 클라이언트 (HFT 최적화)")
    print("="*60)

    # ========== 1단계: Control 연결 (종목 정보 수신용) ==========
    print("\n[1단계] Control 연결 시작...")
    control_client = DuplexTCPClient(host, port, service_type="C")

    # Control 로그인
    control_login = {
        "trcd": "login",
        "id": user_id,
        "pw": password,
        "biz_type": "C",    # Control 서비스
        "hash": generate_hash_key(),
    }
    
    control_client.put_send_queue(json_dumps(control_login))
    print(f"[Control] 로그인 시도: {user_id}")

    # 종목 정보 수신 대기 (EOS의 LoginForm 단계)
    print("[Control] 종목 정보 수신 대기 중...")
    time.sleep(5)  # 종목 정보 로딩 시간

    # ========== 2단계: Quote 연결 (시세 데이터 수신용) ==========
    print("\n[2단계] Quote 연결 시작...")
    # Control의 product_manager를 Quote와 공유 (EOS의 SharedDataStorage처럼)
    quote_client = DuplexTCPClient(host, port, service_type="S", 
                                   product_manager=control_client.product_manager)

    # Quote 로그인
    quote_login = {
        "trcd": "login",
        "id": user_id,
        "pw": password,
        "biz_type": "S",    # Quote 서비스
        "hash": generate_hash_key(),
    }
    
    quote_client.put_send_queue(json_dumps(quote_login))
    print(f"[Quote] 로그인 시도: {user_id}")

    # Quote 로그인 응답 대기
    time.sleep(2)

    # ========== 3단계: 시세 구독 (Quote 클라이언트 사용) ==========
    
    # 예제 1: 개별 구독 (Quote 클라이언트 사용!)
    print("\n[예제 1] 개별 구독")
    quote_client.subscribe("305540")  # TIGER 2차전지테마
    quote_client.subscribe("005930")  # 삼성전자
    
    # 예제 2: 일괄 구독
    print("\n[예제 2] 일괄 구독")
    etf_products = control_client.product_manager.filter_by_type("ETF")
    if etf_products:
        print(f"[ETF] 총 {len(etf_products)}개 종목 (처음 3개 구독)")
        etf_codes = [p.shrt_is_cd for p in etf_products[:3]]
        quote_client.subscribe_multiple(etf_codes)
    
    # ========== 4단계: 잔고 조회 (Control 클라이언트 사용) ==========
    print("\n[4단계] 잔고 조회 테스트")
    
    # 전체 잔고 조회
    control_client.request_balance_all()
    
    # 잔고 응답 대기
    time.sleep(3)

    print("\n" + "="*60)
    print("시세 수신 중... (Ctrl+C로 종료)")
    print("  - Control 연결: 종목 정보 + 잔고 관리")
    print("  - Quote 연결: 시세 데이터 수신")
    print("="*60 + "\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\n프로그램을 종료합니다.")
        print("[Control] 연결 종료 중...")
        control_client.close()
        print("[Quote] 연결 종료 중...")
        quote_client.close()