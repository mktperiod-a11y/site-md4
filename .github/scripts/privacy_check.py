#!/usr/bin/env python3
"""개인정보 규칙 자동 검사.

사용법:
  python3 .github/scripts/privacy_check.py files            추적 중인 파일 검사
  python3 .github/scripts/privacy_check.py commits <범위>    커밋 이메일·메시지 검사 (예: origin/main..HEAD)

금지 문자열은 환경 변수 PRIVACY_PATTERNS(한 줄에 하나, 대소문자 무시)로만 받는다.
값은 출력하지 않고 "금지 문자열 #번호"로만 알린다.
"""
import os
import re
import struct
import subprocess
import sys

SELF = ".github/scripts/privacy_check.py"
PAGES_HOST = re.compile(r"[a-z0-9-]+\.github\.io", re.I)
MERGE_MESSAGE = re.compile(r"^Merge pull request #\d+ from \S+/", re.M)
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".svg")

errors = []


def fail(message, path=None, line=None):
    errors.append(message)
    where = ""
    if path:
        where = f" file={path}" + (f",line={line}" if line else "")
    print(f"::error{where}::{message}")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def load_patterns():
    raw = os.environ.get("PRIVACY_PATTERNS", "")
    patterns = [p.strip().lower() for p in raw.splitlines() if p.strip()]
    if not patterns:
        print("::warning::PRIVACY_PATTERNS 값이 없어 금지 문자열 검사를 건너뜁니다.")
    return patterns


def find_patterns(text, patterns):
    lower = text.lower()
    for number, pattern in enumerate(patterns, 1):
        index = lower.find(pattern)
        if index >= 0:
            yield number, lower.count("\n", 0, index) + 1


def jpeg_metadata(data):
    found = set()
    i = 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker in (0xDA, 0xD9):
            break
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        segment = data[i + 4:i + 2 + length]
        if marker == 0xE1 and segment.startswith(b"Exif\0"):
            found.add("EXIF")
        elif marker == 0xE1 and segment.startswith(b"http://ns.adobe.com/x"):
            found.add("XMP")
        elif marker == 0xED and segment.startswith(b"Photoshop 3.0"):
            found.add("IPTC")
        i += 2 + length
    return found


def png_metadata(data):
    found = set()
    i = 8
    while i + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[i:i + 8])
        if kind == b"eXIf":
            found.add("EXIF")
        elif kind in (b"iTXt", b"tEXt", b"zTXt"):
            key = data[i + 8:i + 8 + length].split(b"\0", 1)[0].lower()
            if key == b"xml:com.adobe.xmp" or key.startswith(b"raw profile type xmp"):
                found.add("XMP")
            elif key.startswith(b"raw profile type exif"):
                found.add("EXIF")
            elif key.startswith(b"raw profile type iptc"):
                found.add("IPTC")
        elif kind == b"IEND":
            break
        i += 12 + length
    return found


def webp_metadata(data):
    found = set()
    i = 12
    while i + 8 <= len(data):
        kind = data[i:i + 4]
        size = struct.unpack("<I", data[i + 4:i + 8])[0]
        if kind == b"EXIF":
            found.add("EXIF")
        elif kind == b"XMP ":
            found.add("XMP")
        i += 8 + size + (size & 1)
    return found


def image_metadata(path, data):
    name = path.lower()
    if name.endswith((".jpg", ".jpeg")) and data[:2] == b"\xff\xd8":
        return jpeg_metadata(data)
    if name.endswith(".png") and data[:8] == b"\x89PNG\r\n\x1a\n":
        return png_metadata(data)
    if name.endswith(".webp") and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return webp_metadata(data)
    if name.endswith(".svg") and re.search(rb"xmpmeta|<rdf:RDF", data, re.I):
        return {"XMP"}
    return set()


def check_files():
    patterns = load_patterns()
    paths = [p for p in git("ls-files", "-z").decode().split("\0") if p]
    images = 0
    for path in paths:
        base = path.rsplit("/", 1)[-1]
        if base == "CNAME":
            fail("CNAME 파일을 두지 않습니다. 도메인은 Settings → Pages에서만 관리하세요.", path)
        if "probe" in base.lower():
            fail("확인용 임시 파일(probe)이 남아 있습니다.", path)
        for number, _ in find_patterns(path, patterns):
            fail(f"파일 경로에 금지 문자열 #{number}이 들어 있습니다.", path)
        if path == SELF or not os.path.isfile(path):
            continue
        with open(path, "rb") as f:
            data = f.read()
        if path.lower().endswith(IMAGE_EXT):
            images += 1
            found = image_metadata(path, data)
            if found:
                fix = "<metadata>를 지우세요" if path.lower().endswith(".svg") else "sharp로 다시 저장하세요"
                fail(f"이미지에 {', '.join(sorted(found))} 정보가 남아 있습니다. {fix}.", path)
        if b"\0" in data[:8000]:
            continue
        text = data.decode("utf-8", "ignore")
        match = PAGES_HOST.search(text)
        if match:
            line = text.count("\n", 0, match.start()) + 1
            fail("사이트 주소가 코드에 들어 있습니다. https://site-url.invalid 자리표시를 쓰세요.", path, line)
        for number, line in find_patterns(text, patterns):
            fail(f"금지 문자열 #{number}이 들어 있습니다.", path, line)
    print(f"파일 {len(paths)}개(이미지 {images}개) 검사, 문제 {len(errors)}건")


def allowed_email(email):
    email = email.lower()
    return email.endswith("@users.noreply.github.com") or email == "noreply@github.com"


def check_commits(revs):
    patterns = load_patterns()
    log = git("log", "--format=%H%x00%ae%x00%ce%x00%B%x1e", *revs).decode("utf-8", "ignore")
    commits = [c.strip("\n") for c in log.split("\x1e") if c.strip("\n")]
    for record in commits:
        sha, author, committer, message = record.split("\0", 3)
        short = sha[:7]
        if not allowed_email(author):
            fail(f"{short}: 작성자 이메일이 GitHub 비공개 주소(@users.noreply.github.com)가 아닙니다.")
        if not allowed_email(committer):
            fail(f"{short}: 커미터 이메일이 GitHub 비공개 주소(@users.noreply.github.com)가 아닙니다.")
        if MERGE_MESSAGE.search(message):
            fail(f"{short}: 병합 커밋 메시지에 계정 이름이 들어 있습니다. PR은 Squash 또는 Rebase로 합치세요.")
        for number, _ in find_patterns(message, patterns):
            fail(f"{short}: 커밋 메시지에 금지 문자열 #{number}이 들어 있습니다.")
    print(f"커밋 {len(commits)}개 검사, 문제 {len(errors)}건")


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "files":
        check_files()
    elif len(sys.argv) >= 3 and sys.argv[1] == "commits":
        check_commits(sys.argv[2:])
    else:
        print(__doc__)
        return 2
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
