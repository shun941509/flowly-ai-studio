"""명시적으로 실행할 때만 공식 NLTK 언어 자료를 다운로드한다. 모델 호출 없음."""
import nltk

if __name__ == "__main__":
    for package in ("stopwords", "punkt", "punkt_tab"):
        if not nltk.download(package, quiet=False):
            raise SystemExit("언어 자료 설치 실패: 네트워크와 NLTK 다운로드 경로를 확인하세요.")
