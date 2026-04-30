
import os
import ctypes
import pandas as pd
import xlwings as xw


file_office = "5264.xlsx"
file_esafe = "대차내역.xls"

book_office = xw.Book("./" + file_office)
book_esafe = xw.Book("./" + file_esafe)

sheet_office_5264 = book_office.sheets["Sheet1"]
sheet_esafe_list = book_esafe.sheets["Sheet1"]

office_5264_range = "A1:N50000"
esafe_range = "A1:AE50000"

office_5264_df = sheet_office_5264.range(office_5264_range).options(pd.DataFrame, index=False).value
office_5264_df = office_5264_df[office_5264_df.담보가능수량 > 0]
columns_for_repayment2 = ["펀드코드", "펀드명", "종목번호", "종목명", "담보가능수량"]
office_5264_df = office_5264_df[columns_for_repayment2]
office_5264_df["종목번호"] = office_5264_df["종목번호"].str.replace('A','')

esafe_list_df = sheet_esafe_list.range(esafe_range).options(pd.DataFrame, index=False).value
esafe_list_df = esafe_list_df[esafe_list_df.대차수량 > 0]
columns_for_repayment1 = ["단축코드", "종목명", "수수료율(%)", "대차수량", "체결일", "체결번호", "대여자계좌", "대여자명", "기준가액", "대차가액"]
esafe_list_df = esafe_list_df[columns_for_repayment1]

# 컬럼명
# 오피스 : ["펀드코드", "펀드명", "종목번호", "종목명", "담보가능수량"]
# 예탁원 : ["단축코드", "종목명", "수수료율(%)", "대차수량", "체결일", "체결번호", "대여자계좌", "대여자명", "기준가액", "대차가액"]

# 종목코드&종목명 세트 (예탁원 체결내역 기준이라 내부에서만 차입한 종목이면 오피스에는 있어도 이 세트에는 없을 수 있음)
code_name_set = esafe_list_df.drop_duplicates(["단축코드"])[["단축코드", "종목명"]].set_index("단축코드").to_dict()["종목명"]

# 반복문을 위해 갚을 대상이 되는 오피스5264에서 종목 중복 제거
repayment_list = office_5264_df['종목번호'].drop_duplicates().values

# 상환할 리스트 저장용 빈 딕셔너리
repayment_dict = {
        "펀드코드" : [],
        "펀드명" : [],
        "종목코드" : [],
        "종목명" : [],
        "상환수량" : [],
        "체결일" : [],
        "체결번호" : [],
        "대여자계좌" : [],
        "대여자명" : [],
        "수수료율(%)" : [],
        "기준가액" : [],
        "대차금액" : []
    }

# 상환하고 남은 오피스5264 데이터프레임과 예탁원 데이터프레임 저장용 빈 데이터프레임
post_office_df = pd.DataFrame()
post_esafe_df = pd.DataFrame()
zero_esafe_df = pd.DataFrame()      # 예탁원 내역에 없는 대차수량 (내부 PBS 차입 저장용)

# 반목문 실행 전 확인사항
print("\n해당 프로그램은 사용자가 상환가능한 오피스 내역과 예탁원 내역 엑셀 파일을 직접 편집 후, 대상 폴더에 업로드 해야합니다. (펀드코드&차입처 구분 X)")


for stock_code in repayment_list:
    # one_office_df = office_5264_df[office_5264_df.종목번호 == stock_code].reset_index(drop=True)
    # one_esafe_df = esafe_list_df[esafe_list_df.단축코드 == stock_code].reset_index(drop=True)
    one_office_df = office_5264_df[office_5264_df.종목번호 == stock_code]
    one_esafe_df = esafe_list_df[esafe_list_df.단축코드 == stock_code]
    
    # 오피스 상환수량 - 담보가능수량 작은 순으로 정렬 (순차적으로 상환할 것이므로, 수량이 적은 순으로 정렬해야 짜투리 수량이 사라짐)
    # 정렬 기준 : 1. 담보가능수량 작은 순서 2. 펀드코드 작은 순서 (2번은 큰 의미 없음)
    one_office_df = one_office_df.sort_values(by=["담보가능수량", "펀드코드"], ascending=True).reset_index(drop=True)
    
    # 예탁원 대차내역 - 요율 높은 순으로 정렬 (순차적으로 상환할 것이므로, 요율 높은 순으로 정렬해야 높은 요율 종목부터 상환함)
    # 정렬 기준 : 1. 수수료율 높은 순서 2. 수량 작은 순서
    one_esafe_df = one_esafe_df.sort_values(by=["수수료율(%)", "대차수량"], ascending=[False, True]).reset_index(drop=True)
    
    # 종목별 오피스와 예탁원 수량 합 계산 
    office_stock_num = one_office_df["담보가능수량"].sum()
    esafe_stock_num = one_esafe_df["대차수량"].sum()

    # 예탁원 체결내역에 갚을 내역 있는지 확인 (없으면 패스)
    if esafe_stock_num == 0:
        one_office_df = one_office_df[one_office_df.담보가능수량 > 0].reset_index(drop=True)
        zero_esafe_df = pd.concat([zero_esafe_df, one_office_df]).reset_index(drop=True)        # 오피스에는 있지만 예탁원에 없는 종목은 오피스 내역을 zero_esafe_df에 저장해서 따로 엑셀에 저장
        continue
    
    # 반복문 내 인덱스 초기화
    i = 0           # 반복문 인덱스
    idx_x = 0       # 오피스 인덱스
    idx_y = 0       # 예탁원 인덱스
    
    # 예탁원 체결내역에 갚을 내역 있으면 해당 종목의 담보가능수량과 예탁원내역 비교
    # for i in range(0, max_len): 
    while ((one_office_df["담보가능수량"].sum() > 0) or (one_esafe_df["대차수량"].sum() > 0)):
    
        # print(f"\nidx : {i}")
        i += 1
        # print(f"오피스 수량 합 : {one_office_df['담보가능수량'].sum()}")
        # print(f"예탁원 수량 합 : {one_esafe_df['대차수량'].sum()}")
        
        if one_office_df["담보가능수량"].sum() == 0:
            # print(f"{code_name_set[stock_code]}({stock_code}) 종목의 오피스 수량이 모두 상환되었습니다.")
            break
        
        elif one_esafe_df["대차수량"].sum() == 0:
            # print(f"{code_name_set[stock_code]}({stock_code}) 종목의 예탁원 수량이 모두 상환되었습니다.")
            break
            
        elif one_office_df["담보가능수량"].sum() < 0:
            # print(f"{code_name_set[stock_code]}({stock_code}) 종목의 오피스 담보가능수량이 마이너스 입니다.")
            ctypes.windll.user32.MessageBoxW(0, f"{code_name_set[stock_code]}({stock_code}) 종목의 오피스 담보가능수량이 마이너스 입니다.", "담보가능수량 마이너스", 16)
            break
            
        elif one_esafe_df["대차수량"].sum() < 0:
            # print(f"{code_name_set[stock_code]}({stock_code}) 종목의 예탁원 대차수량이 마이너스 입니다.")
            ctypes.windll.user32.MessageBoxW(0, f"{code_name_set[stock_code]}({stock_code}) 종목의 예탁원 대차수량이 마이너스 입니다.", "예탁원 대차수량 마이너스", 16)
            break
            
        
        # print(f"idx_x : {idx_x}, idx_y : {idx_y}")
        x = one_office_df.loc[idx_x, "담보가능수량"]
        y = one_esafe_df.loc[idx_y, "대차수량"]
        
        repay_amount = min(x, y)
        repayment_dict["펀드코드"].append(one_office_df.iloc[idx_x]["펀드코드"])
        repayment_dict["펀드명"].append(one_office_df.iloc[idx_x]["펀드명"])
        repayment_dict["종목코드"].append(one_office_df.iloc[idx_x]["종목번호"])
        repayment_dict["종목명"].append(one_office_df.iloc[idx_x]["종목명"])
        repayment_dict["상환수량"].append(repay_amount)
        repayment_dict["체결일"].append(one_esafe_df.iloc[idx_y]["체결일"])
        repayment_dict["체결번호"].append(one_esafe_df.iloc[idx_y]["체결번호"])
        repayment_dict["대여자계좌"].append(one_esafe_df.iloc[idx_y]["대여자계좌"])
        repayment_dict["대여자명"].append(one_esafe_df.iloc[idx_y]["대여자명"])
        repayment_dict["수수료율(%)"].append(one_esafe_df.iloc[idx_y]["수수료율(%)"])
        repayment_dict["기준가액"].append(one_esafe_df.iloc[idx_y]["기준가액"])
        repayment_dict["대차금액"].append(one_esafe_df.iloc[idx_y]["기준가액"] * repay_amount)
        
        one_office_df.loc[idx_x, "담보가능수량"] -= repay_amount
        one_esafe_df.loc[idx_y, "대차수량"] -= repay_amount
              
        if x > y:
            idx_y += 1
            
        elif x < y:     
            idx_x += 1
           
        # x == y
        else:   
            idx_x += 1
            idx_y += 1
            
    # 상환하고 수량이 0이 된 행은 삭제해서, 상환 후의 데이터프레임에 추가 (오피스 및 예탁원 내역 둘 다)
    one_office_df = one_office_df[one_office_df.담보가능수량 > 0].reset_index(drop=True)
    one_esafe_df = one_esafe_df[one_esafe_df.대차수량 > 0].reset_index(drop=True)
    
    post_office_df = pd.concat([post_office_df, one_office_df]).reset_index(drop=True)
    post_esafe_df = pd.concat([post_esafe_df, one_esafe_df]).reset_index(drop=True)
    

# 상환 내역 (Dict -> DataFrame)
repayment_df = pd.DataFrame(repayment_dict)

# 최종 상환 수량 및 금액
print(f"\n상환 수량 : {int(repayment_df['상환수량'].sum()):,}주  &  상환 금액 : {int(repayment_df['대차금액'].sum()):,}원\n")

# 상환 결과 엑셀로 저장
with pd.ExcelWriter("./상환 결과.xlsx") as writer:
    repayment_df.to_excel(writer, sheet_name="상환 내역", index=False)
    post_office_df.to_excel(writer, sheet_name="상환 후 오피스 내역", index=False)
    post_esafe_df.to_excel(writer, sheet_name="상환 후 예탁원 내역", index=False)
    zero_esafe_df.to_excel(writer, sheet_name="예탁원 상환불가 (내부차입)", index=False)

os.system('pause')





#TODO 상환 후 엑셀 파일에 상환 내역을 종목별로 합산한 내역도 보여주는 시트 추가
#TODO 5264에 수량이 있지만 내부 차입이라 상환 안되는 종목 필터링 (기존 코드에는 예탁원에 해당 종목이 없는 경우만 내부차입으로 필터링하는데, 반대로 예탁원에 있지만 오피스 수량은 내부 차입만 있으면 이것도 필터링해야함)