"""엑셀 파일 읽기 — openpyxl 우선, 실패 시 xlwings fallback."""
import io
import tempfile
import os
import pandas as pd


def read_excel(file_bytes: bytes, sheet_name=0, **kwargs) -> pd.DataFrame:
    """openpyxl/xlrd로 먼저 시도하고, 보안 프로그램 등으로 실패 시 xlwings로 읽기."""
    buf = io.BytesIO(file_bytes)

    # 1차: openpyxl (xlsx) 또는 xlrd (xls)
    try:
        try:
            return pd.read_excel(buf, sheet_name=sheet_name, engine="openpyxl", **kwargs)
        except Exception:
            buf.seek(0)
            return pd.read_excel(buf, sheet_name=sheet_name, engine="xlrd", **kwargs)
    except Exception:
        pass

    # 2차: xlwings fallback (Windows + Excel 필요)
    try:
        import xlwings as xw
    except ImportError:
        raise RuntimeError("openpyxl/xlrd 모두 실패했고, xlwings가 설치되어 있지 않습니다.")

    # 임시 파일로 저장 후 xlwings로 읽기
    suffix = ".xlsx" if file_bytes[:4] == b"PK\x03\x04" else ".xls"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        app = xw.App(visible=False)
        app.display_alerts = False
        try:
            wb = app.books.open(tmp_path)
            if isinstance(sheet_name, int):
                ws = wb.sheets[sheet_name]
            else:
                ws = wb.sheets[sheet_name]
            df = ws.used_range.options(pd.DataFrame, header=True, index=False).value
            wb.close()
            return df
        finally:
            app.quit()
    finally:
        os.unlink(tmp_path)


