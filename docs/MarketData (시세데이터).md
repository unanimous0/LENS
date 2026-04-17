#### Imports


```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import sys
import os
import yaml
import json

# Library path
sys.path.append(f"/home/kboms/code")

import libpy as py

# Initialize library logger
py.init_logger()
```

# ObPrinter
* 지정한 종목(들)의 tick data (시세데이터 및 real NAV)를 dict 형식으로 반환


* `ObPrinter(file_patterns, uids)`
  * `uids`: 12자리 ISIN (Ticker not supported)
  * 종목정보 파일에서 검색하거나 `universe.find_instrument()`를 이용해 UID로 변환


```python
uids = [
    "KR7005930003",   # 삼성전자
    "KR4111WC0001",   # 삼성전자 12월물
    "KR7252670005",   # 곱버스
    "KR4101WC0003",   # KOSPI200 12월물
    "KR49999999KP",   # KOSPI200 지수
]

ob = py.ObPrinter(
    [
        "/nomad/ob/kr/krx.20260105.zip",       # KRX 시세데이터
        "/nomad/ob/kr/real_nav.20260105.zip",  # 우리가 계산한 rnav 틱 데이터
    ],
    uids,
)
```

### `for` loop를 이용해 데이터를 순차적으로 로드 혹은 `next(ob)`
* `ObPrinter` is a Python generator


```python
next(ob)
```




    {'et': 1767569400147190,
     'ex': 'XKRX',
     'fl': 289,
     'rt': 1767569400147730,
     's': 'KR7252670005',
     'tp': '579',
     'ts': '16149',
     'ty': 'Trade'}




```python
next(ob)
```




    {'et': 1767569400147190,
     'ex': 'XKRX',
     'fl': 10,
     'i1': '579.2787',
     'i2': '',
     'rt': 1767569400147730,
     's': 'KR7252670005',
     'ty': 'Index'}




```python
count = 0
example_messages = {}

for tick in ob:
    count += 1
    
    if tick["ty"] not in example_messages:
        example_messages[tick["ty"]] = tick
        
print(f"Consumed {count} tick events")
```

    Consumed 3000462 tick events



```python
example_messages
```




    {'Index': {'et': 1767569401239825,
      'ex': 'XKRX',
      'fl': 10,
      'i1': '579.2787',
      'i2': '',
      'rt': 1767569401240021,
      's': 'KR7252670005',
      'ty': 'Index'},
     'Trade': {'et': 1767569401239825,
      'ex': 'XKRX',
      'fl': 289,
      'rt': 1767569401240021,
      's': 'KR7252670005',
      'tp': '579',
      'ts': '6',
      'ty': 'Trade'},
     'LpBookSnapshot': {'a': [['564', '672464', '0'],
       ['565', '200910', '0'],
       ['566', '200942', '0']],
      'b': [['563', '964455', '0'],
       ['562', '980304', '0'],
       ['561', '1015826', '0']],
      'et': 1767570600021849,
      'ex': 'XKRX',
      'fl': 4,
      'ma': '0',
      'mb': '0',
      'mp': '0',
      'rt': 1767570600046895,
      's': 'KR7252670005',
      'ty': 'LpBookSnapshot'},
     'Auction': {'as': '1074316',
      'bs': '2960585',
      'et': 1767570600021849,
      'ex': 'XKRX',
      'fl': 4,
      'ip': '564',
      'is': '10218190',
      'rt': 1767570600046895,
      's': 'KR7252670005',
      'ty': 'Auction'}}



# 시세데이터 형식

# Trade


```python
tick = {
    'ty': 'Trade',
    's': 'KR7005930003',       # UID
    'rt': 1767571255048380,    # 받은 시각, in microseconds since epoch
    'et': 1767571255048197,    # 거래소 시각, in microseconds since epoch
    'ex': 'XKRX',              # 거래소: XKRX, NXTE, XKRF (부산 파생시장)
    'tp': '134200',            # 체결가격
    'ts': '1',                 # 체결수량
    'fl': 1,                   # Flags (see below)
}
```


```python
# 시각 변환
pd.to_datetime(tick["rt"], unit='us').tz_localize('utc').tz_convert('Asia/Seoul')
```




    Timestamp('2026-01-05 09:00:55.048380+0900', tz='Asia/Seoul')



# `fl`: Flags
* (`fl` 필드 값) & (아래의 bit mask) > 0 인 경우 해당 값은 True
* (예시 1) 34 = 100010 (이진수) 이므로: 
  * 장 개시 전 (PRE_MARKET) 시장가매도주문(SELL)로 인한 체결
* (예시 2) 1 = 1 (이진수) 이므로: 
  * 시장가매수주문(BUY)로 인한 체결


```python
_ = """
pub struct Flags: u32 {
    // 시장가매수주문
    const BUY = 0b1;
    
    // 시장가매도주문
    const SELL = 0b10;
    
    // 시초단일가
    const OPEN_AUCTION = 0b100;
    
    // 종가단일가
    const CLOSE_AUCTION = 0b1000;
    
    // 장중단일가, e.g. VI
    const MIDDAY_AUCTION = 0b10000;
    
    // 장 개시 전
    const PRE_MARKET = 0b100000;
    
    // 장 마감 후
    const POST_MARKET = 0b1000000;
    
    // 대량매매
    const BLOCK_DEAL = 0b10000000;
    
    // 장외거래
    const OTC = 0b100000000;
}
"""
```

# LpBookSnapshot
* 호가 N 레벨
* (가격, 잔량, LP잔량)
* LP잔량은 ETF만 제공. 여타 경우에는 0.


```python
tick = {
    "ty": "LpBookSnapshot",
    "s": "KR7005930003",           # UID
    "rt": 1767571255048452,        # 받은 시각, in microseconds since epoch
    "et": 1767571255048197,        # 거래소 시각, in microseconds since epoch
    "ex": 'XKRX',                  # 거래소: XKRX, NXTE, XKRF (부산 파생시장)
    
    "a": [                         # 매도호가: (가격, 잔량, LP잔량). 주식은 LP잔량 없음. 첫 아이템이 최유리호가.
        ["134200", "2318", "0"],
        ["134300", "736", "0"],
        ["134400", "2371", "0"],
        ["134500", "13568", "0"],
        ["134600", "4976", "0"],
        ["134700", "1658", "0"],
        ["134800", "4026", "0"],
        ["134900", "18721", "0"],
        ["135000", "84417", "0"],
        ["135100", "10245", "0"]
    ],
    
    "b": [
        ["134100", "1010", "0"],    # 매수호가: (가격, 잔량, LP잔량). 주식은 LP잔량 없음. 첫 아이템이 최유리호가.
        ["134000", "59067", "0"],
        ["133900", "26893", "0"],
        ["133800", "6665", "0"],
        ["133700", "22395", "0"],
        ["133600", "13180", "0"],
        ["133500", "51315", "0"],
        ["133400", "141167", "0"],
        ["133300", "35656", "0"],
        ["133200", "13037", "0"]
    ],
    
    "ma": "0",                      # 중간가 매도잔량
    "mb": "0",                      # 중간가 매수잔량
    "mp": "134150",                 # 중간가
    "fl": 0,                        # Flags (Trade와 동일)
}
```

# Index
* iNav, rNav, 지수 값, 선물 이론가 등


```python
tick = {
    "ty": "Index",
    "s": "KR7252670005",       # UID
    "rt": 1767571255111665,    # 받은 시각, in microseconds since epoch
    "et": 1767571255111414,    # 거래소 시각, in microseconds since epoch
    "ex": "XKRX",              # 거래소: XKRX, NXTE, XKRF (부산 파생시장)
    "i1": "554.4522",          # Index 1 값 (flags 값에 따라 다름, e.g. NAV의 경우 현재값)
    "i2": "554.4868",          # Index 2 값 (flags 값에 따라 다름, e.g. NAV의 경우 어제종가값)
    "fl": 18,                  # IndexFlags (see below)
}
```

# `fl`: IndexFlags
* (`fl` 필드 값) & (아래의 bit mask) > 0 인 경우 해당 값은 True
* `EXCHANGE_NAV`: iNav (거래소값)
  * `i1`: 현재가 NAV
  * `i2`: 전일종가 NAV
  * If `INDICATIVE`: 단일가 시 예상값
  
* `REAL_NAV`: rNav (자체계산값)
  * If `TRADE`: `i1`은 각 PDF 현재가로 계산된 NAV, `i2`는 invalid
  * If `QUOTE`: `i1`은 각 PDF 매수호가로 계산된 NAV, `i2`는 매도호가
  
* `FUTURES_IDEAL`: 선물이론가 (자체계산값)
  * If `TRADE`: `i1`은 기초자산의 현재가로 계산된 이론가
  * If `QUOTE`: `i1`은 기초자산의 매수호가로 계산된 이론가, `i2`는 매도호가
  * 무위험이자율은 `/nomad/yield/rate.%Y%m%d.csv` 참조
  
* `TRADE`, `QUOTE`: 위 참조

* `INDICATIVE`: 예상가(`EXCHANGE_NAV`)에 사용

* `OPEN_AUCTION`: 시초단일가

* `CLOSE_AUCTION`: 종가단일가


```python
_ = """
pub struct IndexFlags: u16 {
    // INAV (거래소값)
    const EXCHANGE_NAV = 0b1;
    
    // RNAV (자체 계산값)
    const REAL_NAV = 0b10;
    
    // 선물 이론가 (자체 계산값)
    const FUTURES_IDEAL = 0b100;
    
    // 체결 (REAL_NAV, FUTURES_IDEAL의 경우 i1 값에 사용)
    const TRADE = 0b1000;
    
    // 호가 (REAL_NAV, FUTURES_IDEAL의 경우 i1, i2 값에 각각 매수/매도 값에 사용)
    const QUOTE = 0b10000;
    
    // 예상가
    const INDICATIVE = 0b100000;
    
    // 시초단일가
    const OPEN_AUCTION = 0b1000000;
    
    // 종가단일가
    const CLOSE_AUCTION = 0b10000000;
}
"""
```


```python
0b100000
```




    32



# Auction
* 단일가 시 예상체결가 및 총 매수매도호가잔량
* **실 체결은 `Trade`에 발생**
  * `fl = OPEN_AUCTION or CLOSE_AUCTION`


```python
tick = {
    "ty": "Auction",
    "s": "KR7252670005",          # UID
    "rt": 1767570600046895,       # 받은 시각, in microseconds since epoch
    "et": 1767570600021849,       # 거래소 시각, in microseconds since epoch
    "ex": "XKRX",                 # 거래소: XKRX, NXTE, XKRF (부산 파생시장)
    "ip": "564",                  # 예상체결가 (Indicative Price)
    "is": "10218190",             # 예상체결수량 (Indicative Size)
    "as": "1074316",              # 총 매도호가잔량
    "bs": "2960585",              # 총 매수호가잔량 
    "fl": 4,                      # Flags (see `Trade`)
}
```

# Status
* 매매정지/재개 시 전파


```python
tick = {
    "ty": "Status",
    "s": "KR7252670005",          # UID
    "rt": 1767570600046895,       # 받은 시각, in microseconds since epoch
    "et": 1767570600021849,       # 거래소 시각, in microseconds since epoch
    "ex": "XKRX",                 # 거래소: XKRX, NXTE, XKRF (부산 파생시장)
    "fl": 6,                      # Flags (see  below)
}
```

# `fl`: StatusFlags
* (`fl` 필드 값) & (아래의 bit mask) > 0 인 경우 해당 값은 True
* `RESUME`: 거래재개
* `HALT`: 거래정지
* `VI`: VI
  * If `RESUME`: VI 해제
  * If `HALT`: VI 발동

## 예시 : 인버스2X (R.NAV - mid)
* 1초 샘플링
* 중간가 R.NAV - 중간가


```python
def to_float(s) -> float:
    if s:
        return float(s)
    else:
        return np.nan
```


```python
date = 20260105

uids = [
    "KR7252670005",   # 곱버스
]

ob = py.ObPrinter(
    [
        f"/nomad/ob/kr/krx.{date}.zip",       # KRX 시세데이터
        f"/nomad/ob/kr/real_nav.{date}.zip",  # 우리가 계산한 rnav 틱 데이터
    ],
    uids,
)
```


```python
last_mid_price = np.nan
last_nav = np.nan
last_time = 0
second = 10 ** 6

# 09:30 KST in microseconds since epoch
market_open = pd.to_datetime(f"{date} 09:30").tz_localize("Asia/Seoul").value // 1000

# 15:20 KST in microseconds since epoch - before close auction
market_close = pd.to_datetime(f"{date} 15:20").tz_localize("Asia/Seoul").value // 1000

# (time, mid_price, nav)
samples = []

# IndexFlags to bitmask on
TARGET_INDEX_FLAGS = 0b10000 | 0b10

for tick in ob:
    assert(tick["s"] == uids[0])    
    timestamp = tick["et"]
    
    if timestamp > last_time + second and (market_open < timestamp < market_close) and last_mid_price > 0 and last_nav > 0:
        sample_time = timestamp // second * second
        samples.append((sample_time, last_mid_price, last_nav))
    
    if tick["ty"] == "LpBookSnapshot":
        flags = tick["fl"]
        
        # Restrict to non-auction, regular-market quotes
        if flags == 0:
            best_bid = to_float(tick["b"][0][0])
            best_ask = to_float(tick["a"][0][0])
            
            if best_bid > 0 and best_ask > 0:
                last_mid_price = (best_bid + best_ask) / 2
            
    elif tick["ty"] == "Index":
        flags = tick["fl"]
        
        if flags & TARGET_INDEX_FLAGS == TARGET_INDEX_FLAGS:
            bid_nav = to_float(tick["i1"])
            ask_nav = to_float(tick["i2"])
            
            if bid_nav > 0 and ask_nav > 0:
                last_nav = (bid_nav + ask_nav) / 2
             

samples = np.array(samples)
print(f"Sampled {len(samples)} times")
```

    Sampled 940749 times



```python
samples
```




    array([[1.767573e+15, 5.455000e+02, 5.457459e+02],
           [1.767573e+15, 5.455000e+02, 5.457459e+02],
           [1.767573e+15, 5.455000e+02, 5.457459e+02],
           ...,
           [1.767594e+15, 5.355000e+02, 5.351098e+02],
           [1.767594e+15, 5.355000e+02, 5.351098e+02],
           [1.767594e+15, 5.355000e+02, 5.351098e+02]])




```python
# r.nav - price (원)
gaps = samples[:, 2] - samples[:, 1]

# r.nav - price (bps)
gaps_bps = gaps / samples[:, 2] * 10000.0
```


```python
gaps
```




    array([ 0.2459,  0.2459,  0.2459, ..., -0.3902, -0.3902, -0.3902])




```python
gaps_bps
```




    array([ 4.50575992,  4.50575992,  4.50575992, ..., -7.29196139,
           -7.29196139, -7.29196139])




```python
print(f"mean = {np.mean(gaps):.3f}원 / {np.mean(gaps_bps):.3f} bps")
print(f"std  = {np.std(gaps):.3f}원 / {np.std(gaps_bps):.3f} bps")
print(f"max  = {np.max(gaps):.3f}원 / {np.max(gaps_bps):.3f} bps")
print(f"min  = {np.min(gaps):.3f}원 / {np.min(gaps_bps):.3f} bps")

plt.plot(gaps)
plt.title("MID R.NAV - MID (WON) : 09:30 - 15:20")
plt.ylabel("MID R.NAV - MID (WON)")
plt.xlabel("Second")
plt.show()

plt.hist(gaps, bins=30)
plt.title("MID R.NAV - MID (WON) : HISTOGRAM")
plt.xlabel("MID R.NAV - MID (WON)")
plt.ylabel("Frequency")
plt.show()
```

    mean = -0.066원 / -1.227 bps
    std  = 0.378원 / 6.950 bps
    max  = 0.832원 / 15.097 bps
    min  = -1.393원 / -25.094 bps



    
![png](output_35_1.png)
    



    
![png](output_35_2.png)
    

