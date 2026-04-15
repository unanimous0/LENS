"""지정 경로에서 파일 자동 탐색."""
import os
import fnmatch
import unicodedata


def find_files_in_folder(folder: str, patterns: list[str]) -> dict[str, str]:
    """폴더에서 패턴에 맞는 파일을 찾아 {key: filepath} 반환.
    patterns: [("key", "패턴"), ...] 예: [("office", "5264*"), ("esafe", "대차내역*")]
    한글 파일명의 NFC/NFD 차이를 처리하기 위해 정규화 후 매칭.
    scandir로 OS가 반환한 실제 경로를 사용하여 open() 호환성 보장.
    """
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return {}

    result = {}
    for key, pattern in patterns:
        pat_nfc = unicodedata.normalize("NFC", pattern)
        matches = []
        for entry in entries:
            if not entry.is_file():
                continue
            if not entry.name.lower().endswith((".xlsx", ".xls")):
                continue
            name_nfc = unicodedata.normalize("NFC", entry.name)
            if fnmatch.fnmatch(name_nfc, pat_nfc):
                matches.append(entry.path)
        if matches:
            matches.sort(key=os.path.getmtime, reverse=True)
            result[key] = matches[0]
    return result


def read_file_bytes(filepath: str) -> bytes:
    """파일을 bytes로 읽기."""
    with open(filepath, "rb") as f:
        return f.read()
