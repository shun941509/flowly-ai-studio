# 두 실행기의 로컬 문서 읽기/추출/출력 생성기. 경로와 크기를 제한하며 외부 서비스나 자격 증명을 사용하지 않는다.
"""Bounded local file operations shared by both exported runtimes. No network or credentials."""
from __future__ import annotations
import csv
from contextlib import closing
import hashlib
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import sys
import zipfile

MAX_FILE = 10_000_000
MAX_TEXT = 200_000
MAX_CELLS = 10_000
EXTENSIONS = {"txt", "md", "csv", "json", "pdf", "docx", "xlsx", "png", "jpg", "jpeg", "tif", "tiff"}

class FileFault(Exception):
    def __init__(self, message, kind="invalid"):
        super().__init__(message)
        self.kind = kind

def dependency(module, package=None):
    try:
        return importlib.import_module(module)
    except ImportError:
        raise FileFault(f"파일 처리 미설정: {package or module} 패키지를 requirements-files.txt 안내에 따라 설치해 주세요.", "unconfigured") from None

def value_at(value, path):
    if not isinstance(path, str) or not path:
        raise FileFault("파일 또는 데이터의 입력 경로를 확인해 주세요.")
    for part in path.split("."):
        if part in ("__proto__", "prototype", "constructor"):
            raise FileFault("허용되지 않은 입력 경로예요.", "policy")
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise FileFault("앞 단계에서 파일 또는 저장할 데이터를 찾지 못했어요.")
    return value

def no_links(path):
    for current in (path, *path.parents):
        try: reparse = bool(getattr(current.lstat(), "st_file_attributes", 0) & 0x400)
        except FileNotFoundError: reparse = False
        if current.is_symlink() or reparse:
            raise FileFault("파일 처리 경로의 심볼릭 링크·정션은 사용할 수 없어요.", "policy")

# 허용 폴더의 실제 경로만 사용한다. 상위 이동과 심볼릭 링크/정션을 통한 경계 이탈을 거절한다.
def relative_file(root, name, prefixes=("inputs",)):
    if not isinstance(name, str) or not name or name.startswith(("/", "\\")) or len(name) > 500 or "\x00" in name or ":" in name:
        raise FileFault("입력 파일은 inputs 폴더 안의 상대 경로로 지정해 주세요.", "policy")
    parts = PurePosixPath(name.replace("\\", "/")).parts
    if not parts or any(p in ("..", ".", "/") or p.endswith((".", " ")) for p in parts):
        raise FileFault("입력 폴더 밖으로 나가는 파일 경로는 허용하지 않아요.", "policy")
    if parts[0] not in prefixes:
        parts = ("inputs", *parts)
    candidate = root.joinpath(*parts)
    no_links(candidate)
    resolved = candidate.resolve()
    if not any(resolved.is_relative_to(root / prefix) for prefix in prefixes):
        raise FileFault("허용된 파일 폴더를 벗어났어요.", "policy")
    if resolved.suffix.lower().lstrip(".") not in EXTENSIONS:
        raise FileFault("지원하는 문서·이미지 파일 형식을 선택해 주세요.")
    return resolved

def read_bytes(path, limit=MAX_FILE):
    if not path.is_file():
        raise FileFault("입력 파일이 없어요. 내보낸 폴더의 inputs에 파일을 복사해 주세요.")
    if path.stat().st_size > limit:
        raise FileFault("입력 파일이 설정한 크기 한도를 넘었어요.")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise FileFault("입력 파일이 설정한 크기 한도를 넘었어요.")
    return data

def descriptor(root, path, data):
    return {"path": path.relative_to(root).as_posix(), "name": path.name, "extension": path.suffix[1:].lower(), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def bounded_text(text):
    if len(text.encode("utf-16-le")) // 2 > MAX_TEXT:
        raise FileFault("추출한 텍스트가 200,000자를 넘어요. 문서를 나누어 주세요.")
    return text

# 압축 문서의 내부 파일 수/확장 크기/암호화를 먼저 확인한다.
def safe_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        items = archive.infolist()
        if len(items) > 10000 or sum(i.file_size for i in items) > 30_000_000:
            raise FileFault("압축된 문서의 내부 크기가 처리 한도를 넘어요.", "policy")
        if any(i.flag_bits & 1 for i in items):
            raise FileFault("암호화된 문서는 지원하지 않아요.")

def clean_rows(rows):
    result = []
    count = 0
    for row in rows:
        if not isinstance(row, (tuple, list)):
            raise FileFault("표의 각 행은 배열이어야 해요.")
        count += len(row)
        if count > MAX_CELLS:
            raise FileFault("표는 10,000셀까지 처리할 수 있어요.")
        result.append(["" if cell is None else cell if isinstance(cell, (str, int, float, bool)) else str(cell) for cell in row])
    return result

def ocr_image(image, root, language):
    tessdata = root / "tessdata"
    no_links(tessdata)
    if not re.fullmatch(r"[A-Za-z_+\-]{1,80}", language):
        raise FileFault("OCR 언어 코드를 확인해 주세요.")
    if not all((tessdata / (lang + ".traineddata")).is_file() for lang in language.split("+")):
        raise FileFault("OCR 미설정: tessdata 폴더에 선택한 언어의 .traineddata 파일을 설치해 주세요.", "unconfigured")
    try:
        import tesserocr
    except ImportError:
        tesserocr = None
    if tesserocr:
        with tesserocr.PyTessBaseAPI(path=str(tessdata), lang=language) as api:
            api.SetImage(image)
            return api.GetUTF8Text()
    if not shutil.which("tesseract"):
        raise FileFault("OCR 미설정: tesserocr 또는 Tesseract 실행 파일을 설치해 주세요.", "unconfigured")
    engine = dependency("pytesseract")
    os.environ["TESSDATA_PREFIX"] = str(tessdata)
    return engine.image_to_string(image, lang=language, timeout=60)

# 형식과 text/table/ocr별 로컬 라이브러리를 선택한다. 의존성 누락은 미설정 오류다.
def extract(root, source, config):
    file = value_at(source, config["filePath"])
    if not isinstance(file, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(file.get("sha256", ""))):
        raise FileFault("파일 입력 블록의 검증된 파일 값을 연결해 주세요.")
    path = relative_file(root, file.get("path"), ("inputs", "outputs"))
    data = read_bytes(path)
    if hashlib.sha256(data).hexdigest() != file["sha256"]:
        raise FileFault("실행 도중 파일이 변경됐어요. 새 실행에서 다시 입력해 주세요.", "policy")
    ext, mode = path.suffix[1:].lower(), config["mode"]
    max_pages = config["maxPages"]
    if type(max_pages) is not int or not 1 <= max_pages <= 100:
        raise FileFault("문서 페이지 한도는 1~100이에요.")
    pages, tables = [], []
    def page(text, number, **extra):
        pages.append({"page": number, "text": bounded_text(text), "source": file["path"], **extra})
    def table(rows, number, sheet=""):
        tables.append({"page": number, "sheet": sheet, "rows": clean_rows(rows)})
        if sum(sum(len(row) for row in t["rows"]) for t in tables) > MAX_CELLS:
            raise FileFault("문서 전체의 표가 10,000셀을 넘어요.")
    if mode == "ocr":
        Image = dependency("PIL.Image", "Pillow")
        Image.MAX_IMAGE_PIXELS = 20_000_000
        if ext == "pdf":
            pdfium = dependency("pypdfium2")
            pdf = pdfium.PdfDocument(data)
            try:
                if len(pdf) > max_pages:
                    raise FileFault("문서가 설정한 페이지 한도를 넘어요.")
                for i in range(len(pdf)):
                    pdf_page = pdf[i]
                    width, height = pdf_page.get_size()
                    if width * height * 4 > 20_000_000:
                        raise FileFault("OCR 이미지 크기가 처리 한도를 넘어요.")
                    bitmap = pdf_page.render(scale=2)
                    try:
                        page(ocr_image(bitmap.to_pil(), root, config["language"]), i + 1)
                    finally:
                        bitmap.close()
                        pdf_page.close()
            finally:
                pdf.close()
        elif ext in ("png", "jpg", "jpeg", "tif", "tiff"):
            with Image.open(io.BytesIO(data)) as image:
                count = getattr(image, "n_frames", 1)
                if count > max_pages or image.width * image.height > 20_000_000:
                    raise FileFault("이미지의 페이지 또는 픽셀 한도를 넘어요.")
                for i in range(count):
                    image.seek(i)
                    if image.width * image.height > 20_000_000:
                        raise FileFault("이미지가 픽셀 한도를 넘어요.")
                    page(ocr_image(image.convert("RGB"), root, config["language"]), i + 1)
        else:
            raise FileFault("OCR에는 PDF 또는 이미지 파일을 연결해 주세요.")
    elif ext == "pdf":
        if mode == "table":
            plumber = dependency("pdfplumber")
            with plumber.open(io.BytesIO(data)) as pdf:
                if len(pdf.pages) > max_pages:
                    raise FileFault("문서가 설정한 페이지 한도를 넘어요.")
                for i, p in enumerate(pdf.pages):
                    for rows in p.extract_tables():
                        table(rows, i + 1)
                    page(p.extract_text() or "", i + 1)
        else:
            reader = dependency("pypdf").PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise FileFault("암호화된 PDF는 지원하지 않아요.")
            if len(reader.pages) > max_pages:
                raise FileFault("문서가 설정한 페이지 한도를 넘어요.")
            for i, p in enumerate(reader.pages):
                page(p.extract_text() or "", i + 1)
    elif ext == "docx":
        safe_archive(data)
        doc = dependency("docx", "python-docx").Document(io.BytesIO(data))
        # DOCX has no stable pagination without a layout engine; keep paragraph/table positions.
        if mode == "table":
            for i, t in enumerate(doc.tables):
                table([[c.text for c in row.cells] for row in t.rows], None, f"table-{i + 1}")
        page("\n".join(p.text for p in doc.paragraphs), None, location="paragraphs", pagination="not_available")
    elif ext == "xlsx":
        safe_archive(data)
        book = dependency("openpyxl").load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
        try:
            if len(book.sheetnames) > max_pages:
                raise FileFault("시트 개수가 설정한 문서 한도를 넘어요.")
            for i, sheet in enumerate(book):
                if sheet.max_row and sheet.max_column and sheet.max_row * sheet.max_column > MAX_CELLS:
                    raise FileFault("시트가 10,000셀 한도를 넘어요.")
                rows = clean_rows(sheet.iter_rows(values_only=True))
                table(rows, i + 1, sheet.title)
                page("\n".join("\t".join(map(str, row)) for row in rows), i + 1, sheet=sheet.title)
        finally:
            book.close()
    elif ext in ("txt", "md", "csv", "json"):
        text = data.decode("utf-8-sig")
        if mode == "table":
            if ext != "csv":
                raise FileFault("이 텍스트 형식에서 표 추출은 지원하지 않아요. CSV를 사용해 주세요.")
            table(list(csv.reader(io.StringIO(text))), 1)
        page(text, 1)
    else:
        raise FileFault("이미지의 글자를 읽으려면 OCR 방식을 선택해 주세요.")
    text = bounded_text("\n\n".join(p["text"] for p in pages))
    if mode == "table":
        text = bounded_text("\n\n".join("\n".join("\t".join(map(str, row)) for row in t["rows"]) for t in tables))
    return {**source, "text": text, "pages": pages, "tables": tables, "source": {"name": path.name, "sha256": file["sha256"]}}

# 표를 정규화하고 수식으로 해석될 수 있는 스프레드시트 문자열을 데이터로 다룬다.
def tabular(value):
    if not isinstance(value, list):
        raise FileFault("CSV·Excel 저장에는 객체 배열이나 행 배열을 연결해 주세요.")
    if value and all(isinstance(row, dict) for row in value):
        headers = list(dict.fromkeys(key for row in value for key in row))
        value = [headers, *[[row.get(key) for key in headers] for row in value]]
    rows = clean_rows(value)
    def safe(cell):
        if isinstance(cell, str) and (cell.lstrip().startswith(("=", "+", "-", "@")) or cell.startswith(("\t", "\r", "\n"))):
            return "'" + cell
        return cell
    return [[safe(c) for c in row] for row in rows]

def render_output(value, format):
    buffer = io.BytesIO()
    if format == "csv":
        text = io.StringIO(newline="")
        csv.writer(text).writerows(tabular(value))
        return text.getvalue().encode("utf-8-sig")
    if format == "xlsx":
        book = dependency("openpyxl").Workbook(write_only=True)
        sheet = book.create_sheet("결과")
        for row in tabular(value):
            sheet.append(row)
        book.save(buffer)
        book.close()
    elif format == "docx":
        if not isinstance(value, str):
            raise FileFault("Word 저장에는 텍스트를 연결해 주세요.")
        document = dependency("docx", "python-docx").Document()
        for line in bounded_text(value).splitlines():
            document.add_paragraph(line)
        document.save(buffer)
    elif format == "pdf":
        if not isinstance(value, str):
            raise FileFault("PDF 저장에는 텍스트를 연결해 주세요.")
        dependency("reportlab")
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from xml.sax.saxutils import escape
        pdfmetrics.registerFont(UnicodeCIDFont("HYSMyeongJo-Medium"))
        style = ParagraphStyle("Korean", fontName="HYSMyeongJo-Medium", fontSize=10, leading=16, wordWrap="CJK")
        story = []
        for line in bounded_text(value).splitlines():
            story.append(Paragraph(escape(line) or "&#160;", style))
            story.append(Spacer(1, 3))
        SimpleDocTemplate(buffer).build(story or [Paragraph("&#160;", style)])
    else:
        raise FileFault("지원하는 출력 형식을 선택해 주세요.")
    return buffer.getvalue()

# 실행/노드별 요청/결과 해시로 재개 시 기존 산출물을 확인한다. 결과를 무조건 덮어쓰지 않는다.
def write_output(root, request):
    config, source = request["config"], request["input"]
    filename, format = config["filename"], config["format"]
    if not isinstance(filename, str) or len(filename) > 120 or re.search(r'[\\/:*?"<>|\x00-\x1f]', filename) or filename.startswith(".") or filename.endswith((".", " ")) or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", filename, re.I) or not filename.lower().endswith("." + format):
        raise FileFault("안전한 출력 파일명과 확장자를 지정해 주세요.", "policy")
    operation = hashlib.sha256((str(request["runId"]) + ":" + str(request["nodeId"])).encode()).hexdigest()
    value = value_at(source, config["dataPath"])
    request_hash = hashlib.sha256(json.dumps([config, value], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    target = root / "outputs" / operation[:24] / filename
    no_links(target)
    state = Path(request["stateDirectory"]).absolute()
    no_links(state)
    state.mkdir(parents=True, exist_ok=True)
    db_path = state / "file-operations.sqlite"
    no_links(db_path)
    with closing(sqlite3.connect(db_path, timeout=5)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        saved = db.execute("SELECT request_hash,result FROM operations WHERE id=?", (operation,)).fetchone()
        if saved:
            if saved[0] != request_hash:
                raise FileFault("같은 파일 작업의 입력이 달라졌어요. 새 실행을 시작해 주세요.", "policy")
            result = json.loads(saved[1])
            if not target.is_file() or hashlib.sha256(read_bytes(target)).hexdigest() != result["sha256"]:
                raise FileFault("이전 파일 작업의 결과가 없거나 변경됐어요. 자동으로 덮어쓰지 않아요.", "policy")
            return {**source, "file": result, "text": result["path"]}
        data = render_output(value, format)
        if len(data) > MAX_FILE:
            raise FileFault("생성할 파일이 10MB 한도를 넘어요.")
        result = descriptor(root, target, data)
        # Persist the expected result before the create-only local effect.
        db.execute("INSERT INTO operations VALUES (?,?,?)", (operation, request_hash, json.dumps(result)))
        db.commit()
        target.parent.mkdir(parents=True, exist_ok=True)
        no_links(target)
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            raise FileFault("같은 이름의 파일이 이미 있어요. 덮어쓰지 않고 중단했어요.", "policy") from None
    return {**source, "file": result, "text": result["path"]}

# 파일 작업의 의존성 검사다. 실제 파일 변환 결과나 외부 연결 검증 성공을 뜻하지 않는다.
def check(config, root):
    required = set()
    needs_ocr = False
    for node in config.get("nodes", []):
        c = node.get("config", {})
        if node.get("type") == "document_extract":
            required.update([("pypdf", "pypdf"), ("docx", "python-docx"), ("openpyxl", "openpyxl"), ("pdfplumber", "pdfplumber")])
            if c.get("mode") == "ocr":
                required.update([("PIL", "Pillow"), ("pypdfium2", "pypdfium2")])
                needs_ocr = True
        if node.get("type") == "file_output":
            module = {"pdf": ("reportlab", "reportlab"), "docx": ("docx", "python-docx"), "xlsx": ("openpyxl", "openpyxl")}.get(c.get("format"))
            if module:
                required.add(module)
    missing = [package for module, package in sorted(required) if importlib.util.find_spec(module) is None]
    if needs_ocr:
        if importlib.util.find_spec("tesserocr") is None:
            if not shutil.which("tesseract"): missing.append("tesserocr 또는 Tesseract")
            if importlib.util.find_spec("pytesseract") is None: missing.append("pytesseract")
        for node in config.get("nodes", []):
            if node.get("config", {}).get("mode") == "ocr":
                for lang in node["config"].get("language", "kor+eng").split("+"):
                    if not re.fullmatch(r"[A-Za-z_-]+", lang) or not (root / "tessdata" / (lang + ".traineddata")).is_file():
                        missing.append("tessdata/" + lang + ".traineddata")
    return {"status": "unconfigured" if missing else "ready", "missing": sorted(set(missing))}

def execute(request):
    if not isinstance(request, dict):
        raise FileFault("파일 처리 요청 형식이 올바르지 않아요.")
    root = Path(request["root"]).absolute()
    no_links(root)
    root = root.resolve()
    operation = request["operation"]
    if operation == "check":
        return check(request.get("config", {}), root)
    config, source = request["config"], request["input"]
    if not isinstance(config, dict) or not isinstance(source, dict):
        raise FileFault("파일 처리 설정과 입력은 객체여야 해요.")
    if operation == "input":
        limit = config["maxBytes"]
        if type(limit) is not int or not 1 <= limit <= MAX_FILE:
            raise FileFault("파일 크기 한도는 1~10,000,000 바이트예요.")
        path = relative_file(root, value_at(source, config["path"]))
        file = descriptor(root, path, read_bytes(path, limit))
        return {**source, "file": file, "text": file["name"]}
    if operation == "extract":
        return extract(root, source, config)
    if operation == "output":
        return write_output(root, request)
    raise FileFault("지원하지 않는 파일 처리 작업이에요.")

def main():
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise FileFault("파일 처리 입력이 너무 커요.")
        result = execute(json.loads(raw))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > 2_000_000:
            raise FileFault("파일 처리 결과가 너무 커요.")
        sys.stdout.buffer.write(encoded)
    except Exception as exc:
        error = str(exc) if isinstance(exc, FileFault) else "파일 처리에 실패했어요. 파일의 형식·손상·암호화 여부를 확인해 주세요."
        sys.stdout.buffer.write(json.dumps({"error": error, "kind": getattr(exc, "kind", "invalid")}, ensure_ascii=False).encode("utf-8"))
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
