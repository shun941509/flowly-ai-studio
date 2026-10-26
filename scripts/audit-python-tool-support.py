"""현재 Python 분기와 반환 계약을 읽어 사용자용 지원 범위 대응표를 만든다.

알고리즘·모델·브라우저는 실행하지 않는다. 아래 분류는 소스를 검토한 명시적
매핑이며, 함수 AST 지문과 레지스트리 전수 대조로 오래된 설명을 찾는다.
출력 필드는 가능한 최상위 키의 합집합이다. 필수 출력 스키마나 성공 보증이 아니다.
"""
from __future__ import annotations

import argparse
import ast
import collections
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "export-runtime"))
import flowly_tools as base
import toolpacks_scientific as science
import toolpacks_media as media

CATALOG = json.loads((ROOT / "domain/tool-catalog.json").read_text(encoding="utf-8-sig"))
DESCRIPTIONS = {item["id"]: item for item in base.describe_tools()}
TREES = {module: ast.parse((ROOT / "export-runtime" / (module + ".py")).read_text(encoding="utf-8-sig")) for module in ("flowly_tools", "toolpacks_scientific", "toolpacks_media")}
AUDITS = {}


def register(ids, module, handler, fields, explanation, limit, algorithm=None):
    """같은 분기를 공유하는 ID만 묶고 각 항목의 설명을 명시해 등록한다."""
    if isinstance(ids, str):
        ids = ids.split()
    function = next(node for node in TREES[module].body if isinstance(node, ast.FunctionDef) and node.name == handler)
    digest = hashlib.sha256(ast.dump(function, include_attributes=False).encode()).hexdigest()
    source_strings = {node.value for node in ast.walk(function) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
    missing_fields = set(fields.split()) - source_strings
    if missing_fields:
        raise ValueError(f"출력 설명에 실제 함수의 키가 없음: {handler}: {sorted(missing_fields)}")
    for tool_id in sorted(ids):
        if tool_id in AUDITS:
            raise ValueError("duplicate audit: " + tool_id)
        AUDITS[tool_id] = {
            "source": f"export-runtime/{module}.py", "handler": handler,
            "sourceLine": function.lineno, "sourceFingerprint": digest,
            "algorithm": algorithm or tool_id, "outputFields": fields.split(),
            "outputDescription": explanation, "limitation": limit,
            "scope": DESCRIPTIONS[tool_id]["scope"], "verification": "source_audited",
        }


def simple(ids, handler, fields, explanation, limit, algorithm=None):
    register(ids, "flowly_tools", handler, fields, explanation, limit, algorithm)


def scientific(ids, handler, fields, explanation, limit, algorithm=None):
    register(ids, "toolpacks_scientific", handler, fields, explanation, limit, algorithm)


def medium(ids, handler, fields, explanation, limit, algorithm=None):
    register(ids, "toolpacks_media", handler, fields, explanation, limit, algorithm)


simple("jsonl", "basic", "records count", "각 행의 JSON을 records로 묶고 빈 행을 제외한 개수를 count로 반환합니다.", "최대 2,000행. 잘못된 한 행이 있으면 전체 호출을 거절합니다.")
simple("chunking", "basic", "chunks unit", "분할된 글과 각 조각의 시작·끝 위치를 chunks에 반환합니다.", "유니코드 코드 포인트 길이로 분할하며 문단·의미·모델 토큰 경계를 해석하지 않습니다.")
simple("tokenizer tokens", "basic", "count ids tokens offsets", "로컬 토크나이저로 토큰 수·ID·문자열·원문 위치를 함께 반환합니다.", "사용자가 제공한 tokenizer 파일 기준입니다. 선택한 외부 AI 서비스의 실제 과금 토큰 수와 같다고 보장하지 않습니다.", "local_tokenizer_encode")
simple("json_schema", "basic", "valid errors draft", "JSON 형식 검사 결과와 실패 위치·검사 규칙을 반환합니다.", "Draft 2020-12. 외부 참조와 임의 정규식 스키마는 허용하지 않습니다.")
simple("data_quality", "basic", "rowCount duplicateCount columns", "행 수·완전히 같은 행 수·열별 누락 수와 Python 값 종류를 반환합니다.", "업무 규칙·값의 사실 여부·자동 정제는 검사하지 않습니다.")
simple("classification_threshold", "basic", "predictions threshold", "확률이 임계값 이상이면 1, 미만이면 0인 목록을 반환합니다.", "확률 생성·모델 학습·확률 보정은 별도입니다.")
simple("wer", "basic", "distance referenceWords wer", "공백으로 구분한 단어의 편집 거리와 단어 오류율을 반환합니다.", "기준 문장이 필요하며 음성 인식이나 의미 평가를 실행하지 않습니다.")
simple("throughput", "basic", "itemsPerSecond count seconds", "사용자가 제공한 건수 ÷ 초로 초당 처리량을 계산합니다.", "실행 시간을 직접 측정하거나 부하를 발생시키지 않습니다.")
simple("benchmark evals", "basic", "results passed total", "예상값과 실제값을 exact·contains·numeric 방식으로 비교한 항목별 통과 여부와 합계를 반환합니다.", "모델·테스트 프로그램을 직접 실행하지 않습니다. 비교할 실제값을 앞 단계에서 전달해야 합니다.", "provided_case_comparison")
simple("knowledge_graph", "basic", "nodes edges method extraction", "제공된 관계에서 시작 노드의 연결을 깊이 제한으로 탐색합니다.", "관계 자동 추출·그래프 DB·문서별 권한 검사는 이 도구 범위에 포함되지 않습니다.")
simple("ssml", "basic", "ssml", "입력 문장을 이스케이프하여 말하기 속도가 포함된 SSML 문자열을 만듭니다.", "음성을 생성하지 않습니다. 실제 음성 합성은 별도 엔진이 필요합니다.")
simple("cosine_similarity", "search", "score zeroVector", "두 벡터의 코사인 점수와 영벡터 포함 여부를 반환합니다.", "차원이 같은 수치 벡터가 필요합니다. 영벡터의 점수는 0입니다.")
simple("rrf hybrid_search", "search", "results", "제공된 순위 목록을 역순위 융합한 ID·점수 목록을 반환합니다.", "hybrid_search는 이미 계산한 lexicalResults·vectorResults 두 목록의 RRF입니다. 검색·임베딩을 자동 실행하지 않습니다.", "reciprocal_rank_fusion")
simple("query_expansion", "search", "queries method", "명시한 동의어 사전으로 확장한 질문 문자열 목록을 반환합니다.", "최대 50개이며 AI가 동의어를 생성하지 않습니다.")
simple("bm25", "search", "results method", "제공 문서의 토큰 빈도·길이에 따른 BM25 점수 순서를 반환합니다.", "현재 호출의 문서만 대상으로 하며 외부 검색 서비스·영구 색인을 만들지 않습니다.")
simple("tfidf", "search", "results method", "질문 토큰별 빈도와 역문서 빈도의 합으로 문서 순서를 반환합니다.", "정규화된 TF-IDF 벡터의 코사인 계산이 아니라 구현에 정의된 빈도 가중 합입니다.")
simple("semantic_search", "search", "results method", "제공한 질문 벡터와 문서 벡터의 정확 코사인 검색 순위를 반환합니다.", "임베딩 생성·근사 벡터 DB 검색은 별도입니다.")
simple("pii", "privacy", "findings sensitive method completeDetection", "등록된 패턴에 일치한 민감정보 위치와 종류를 반환합니다.", "이메일·전화번호·주민번호·비밀 형식 패턴의 부분 탐지이며 완전한 탐지를 보장하지 않습니다.")
simple("redaction anonymization", "privacy", "findings sensitive method completeDetection text anonymityGuaranteed", "패턴에 일치한 위치를 종류 이름으로 가린 문자열과 탐지 내역을 반환합니다.", "익명성을 보장하지 않습니다. 의미·문맥·이미지에 포함된 민감정보는 검사하지 않습니다.", "pattern_redaction")
simple("data_classification", "privacy", "findings sensitive method completeDetection classification", "탐지 패턴으로 restricted·personal·unclassified 값을 반환합니다.", "패턴이 없는 자료를 안전한 공개 자료로 판정하지 않습니다. 조직의 분류 정책을 대신하지 않습니다.")
simple("moderation", "privacy", "blocked ruleIndexes method completeDetection", "입력에 금지 문구가 포함됐는지와 해당 규칙 번호를 반환합니다.", "대소문자를 무시하는 문자열 검사이며 일반 의미 기반 안전성 모델이 아닙니다.")
simple("ai_citation", "privacy", "valid citations checks", "인용 ID의 문서에 인용 문자열이 그대로 있는지 검사합니다.", "주장의 진실성·인용의 적절성·출처 신뢰도를 판단하지 않습니다.")
simple("differential_privacy", "privacy", "value epsilonSpent mechanism compositionManaged", "단일 수치 질의에 Laplace 잡음을 더하고 사용한 epsilon을 반환합니다.", "사용자가 민감도와 단일 질의를 확인해야 합니다. 누적 개인정보 예산 관리와 익명성 보증은 제공하지 않습니다.")

for tool_id, (module, cls) in science.ESTIMATORS.items():
    scientific([tool_id], "model", "state stateFormat trainingRows predictions probabilities", f"sklearn.{module}.{cls}로 학습한 JSON 학습 레시피와, fit 외 동작에서 예측값을 반환합니다.", "predict는 state의 학습 자료로 모델을 다시 구성합니다. probabilities는 해당 추정기가 predict_proba를 지원할 때만 반환합니다. 평가 자료로 학습하지 않습니다.", f"sklearn.{module}.{cls}")
for tool_id, (module, cls) in science.CLUSTER.items():
    scientific([tool_id], "cluster_reduce", "labels centers", f"sklearn.{module}.{cls}로 입력 행의 군집 번호를 반환합니다.", "centers는 알고리즘이 cluster_centers_를 제공할 때만 포함됩니다. 군집 번호에 업무 의미나 실제 신원을 부여하지 않습니다.", f"sklearn.{module}.{cls}")
for tool_id, (module, cls) in {**science.REDUCE, "umap": ("umap", "UMAP")}.items():
    scientific([tool_id], "cluster_reduce", "data targets" if tool_id == "cca" else "data explainedVarianceRatio", f"{module}.{cls}로 축소·변환된 수치 배열을 반환합니다.", "CCA는 두 입력의 변환 data·targets를 반환합니다." if tool_id == "cca" else "explainedVarianceRatio는 추정기가 해당 속성을 제공할 때만 포함됩니다. 각 호출에서 새로 적합합니다.")
for tool_id, metric in science.METRICS.items():
    scientific([tool_id], "metric", "value metric", f"{metric}의 결과를 value에 반환합니다. 지표에 따라 숫자 또는 행렬입니다.", "앞 단계의 실제값·정답 또는 군집 자료가 필요합니다. F1·정밀도·재현율은 macro 평균이며 모델을 실행하지 않습니다.", "sklearn.metrics." + metric)

encoding = "label_encoding ordinal_encoding frequency_encoding target_encoding onehot_encoding".split()
for tool_id in encoding:
    scientific([tool_id], "preprocess", "data categories unknownCount", "학습 범주를 기준으로 변환한 값·범주 목록·알 수 없는 범주 수를 반환합니다.", "label·ordinal은 정렬한 범주의 순번이며 사용자 순서를 입력받지 않습니다. target은 별도 data 배치가 필요하고 알 수 없는 범주는 전체 평균을 사용합니다. frequency는 빈도, onehot은 지시자 배열입니다.", "sorted_category_indices" if tool_id in {"label_encoding", "ordinal_encoding"} else tool_id)
scientific("feature_hashing", "preprocess", "data hash nFeatures", "범주 문자열을 SHA-256 기반 부호 해시 벡터로 변환합니다.", "해시 충돌이 가능하며 범주의 원래 의미를 복원하지 않습니다.")
scientific("data_labeling", "preprocess", "records method", "사용자가 제공한 자료와 같은 순서의 라벨을 묶어 반환합니다.", "AI나 규칙으로 라벨을 새로 예측하지 않습니다.")
scientific("synthetic_data", "preprocess", "data method preservesRealDistribution", "설정한 평균·표준편차의 독립 정규분포 수치 자료를 생성합니다.", "원자료의 분포·상관관계나 개인정보보호를 보장하는 합성 데이터 엔진이 아닙니다.")
scientific("data_augmentation", "preprocess", "data method", "입력 수치 배열에 지정한 크기의 정규 잡음을 더합니다.", "이미지·언어 증강이 아닌 수치 배열 잡음 증강입니다.")
transformers = {"feature_binarization":"Binarizer", "feature_discretization":"KBinsDiscretizer", "quantile_transform":"QuantileTransformer", "power_transform":"PowerTransformer", "maxabs_scaling":"MaxAbsScaler", "robust_scaling":"RobustScaler", "standard_scaling":"StandardScaler", "minmax_scaling":"MinMaxScaler", "l1_normalization":"Normalizer(l1)", "l2_normalization":"Normalizer(l2)", "feature_engineering":"PolynomialFeatures", "features":"PolynomialFeatures", "whitening":"PCA(whiten)", "feature_selection":"VarianceThreshold", "imputation":"SimpleImputer(median)"}
for tool_id, algorithm in transformers.items():
    scientific([tool_id], "preprocess", "state stateFormat data", f"{algorithm}의 학습 레시피를 반환하고 fit 이외 동작에서 변환 data를 제공합니다.", "transform은 저장한 학습 자료로 변환기를 재구성합니다. 특징 선택은 분산 기준, 특징 공학은 제한된 다항 확장, 결측 대체는 중앙값 기준입니다.", algorithm)

signal_outputs = {
    "fft":("real imag magnitudes", "주파수 변환의 실수·허수·크기를 반환합니다."),
    "dct":("values", "이산 코사인 변환 수치를 반환합니다."),
    "dwt":("approximation detail wavelet", "지정 웨이블릿의 근사·상세 계수를 반환합니다."),
    "hungarian":("assignments totalCost", "일대일 최소 비용 배정과 총비용을 반환합니다."),
    "dtw":("distance localCost", "두 수치 시퀀스의 동적 시간 왜곡 누적 거리를 반환합니다."),
    "kalman":("states model", "1차원 무작위 보행 모형의 평균·분산 필터 추정값을 반환합니다."),
    "eigen":("values vectors", "행렬의 고윳값과 고유벡터를 반환합니다."),
    "cholesky":("lower", "양의 정부호 행렬의 하삼각 인자를 반환합니다."),
    "hessenberg":("h q", "Hessenberg 분해 행렬을 반환합니다."),
    "schur":("t z", "Schur 분해 행렬을 반환합니다."),
    "lu":("p l u", "순열·하삼각·상삼각 분해 행렬을 반환합니다."),
    "qr":("q r", "직교·상삼각 분해 행렬을 반환합니다."),
}
for tool_id, (fields, explanation) in signal_outputs.items():
    scientific([tool_id], "signal", fields, explanation, "입력 차원·유한 수치·알고리즘별 행렬 조건을 만족해야 합니다. 실패 시 오류를 반환하며 업무 의미를 해석하지 않습니다.")

extended = {
    "scalar_quantization":("codes minimum scale reconstructed bits", "열별 최소값과 폭을 이용해 양자화 코드·복원값을 반환합니다.", "손실이 있는 수치 압축이며 원래 값을 정확히 복원한다고 보장하지 않습니다."),
    "product_quantization":("codes codebooks reconstructed", "부분공간별 KMeans 코드북·코드·복원값을 반환합니다.", "호출마다 새로 학습하며 영구 벡터 DB를 만들지 않습니다."),
    "hnsw":("indices distances metric", "로컬 HNSW 색인으로 이웃 번호와 제곱 L2 거리를 반환합니다.", "근사 검색이며 영구 색인 저장·접근 제어는 없습니다."),
    "ivf_flat":("indices distances metric approximate", "KMeans 군집을 일부 탐색하여 이웃 번호와 제곱 L2 거리를 반환합니다.", "선택한 군집의 후보 수가 적으면 topK보다 적은 결과를 반환할 수 있습니다."),
    "ann":("indices distances method approximate", "정확 최근접 이웃 기준선의 번호·거리를 반환합니다.", "이 이름의 구현은 근사 검색이 아닙니다. 근사 검색은 hnsw·ivf_flat을 선택합니다."),
    "lof":("scores predictions inlier outlier", "기준 자료로 적합한 LOF의 새 자료 점수와 정상1·이상-1 판정을 반환합니다.", "통계적 이상 판정이며 실제 오류·위협의 증명이 아닙니다."),
    "isolation_forest":("scores predictions inlier outlier", "격리 숲의 이상 점수와 정상1·이상-1 판정을 반환합니다.", "기준 학습 자료가 필요하며 모든 이상을 탐지한다고 보장하지 않습니다."),
    "kde":("logDensity", "기준 자료의 커널 밀도로 검사 자료의 로그 밀도를 계산합니다.", "밀도 점수만 반환하며 임계값 기반 업무 판정은 별도입니다."),
    "ood":("scores outOfDistribution method threshold", "열별 z점수 절댓값의 최댓값과 임계값 초과 여부를 반환합니다.", "다변량 의미 분석이나 모델 신뢰도 추정이 아닌 수치 기준선입니다."),
    "data_drift":("statistic pValue driftDetected method scope modelQualityMeasured", "제공된 두 수치 분포의 KS 통계·유의확률·변화 판정을 반환합니다.", "모델 정답률 하락을 직접 측정하지 않습니다. 비교 자료와 유의수준을 사용자가 정합니다."),
    "calibration":("probabilities method trainingRows", "보정용 확률·이진 정답으로 적합한 등위 회귀 보정 확률을 반환합니다.", "별도 보정 자료가 필요하며 모델의 정확도를 보장하지 않습니다."),
    "conformal_prediction":("intervals radius alpha assumption", "보정 오차의 분위수로 새 예측값의 구간을 반환합니다.", "보정·검사 자료의 교환가능성 가정이 필요합니다. 필요한 보정 표본 수가 부족하면 거절합니다."),
    "ab_test":("statistic pValue meanDifference method assumption", "독립 표본 Welch t검정과 평균 차이를 반환합니다.", "실험 배정·표본 수집을 하지 않으며 통계 가정의 충족을 검증하지 않습니다."),
    "causal_inference":("statistic pValue meanDifference method assumption estimand causalAssumptionsVerified", "무작위 배정 확인을 받은 두 집단의 평균 차이와 Welch 검정을 반환합니다.", "관측 자료의 일반 인과 추론이 아닙니다. 무작위 배정·인과 가정을 실제로 검증하지 않습니다."),
    "time_series_forecast":("predictions method confidenceInterval", "일차 선형 추세를 연장한 다음 값들을 반환합니다.", "계절성·외생 변수·신뢰구간은 지원하지 않습니다."),
    "recommender":("recommendations method missingRating", "사용자 평점 코사인 유사도로 미평가 항목의 추천 순위를 계산합니다.", "0을 미평가 값으로 취급하며 온라인 학습·후보 DB를 제공하지 않습니다."),
    "cross_validation":("scores mean estimator", "허용된 추정기를 교차 검증한 분할별 점수와 평균을 반환합니다.", "일반 코드 평가가 아닙니다. 입력 자료 수와 알고리즘별 라벨 조건이 필요합니다."),
    "feature_importance":("mean std method explains", "별도 검증 자료에서 열을 섞었을 때의 예측 점수 변화 평균·표준편차를 반환합니다.", "모든 설명 가능한 AI 기법이나 인과적 중요도 분석을 제공하지 않습니다."),
    "hmm":("states logLikelihood transitionMatrix", "가우시안 HMM의 예측 상태·로그 가능도·전이행렬을 반환합니다.", "숨은 상태에 업무 의미를 자동 부여하지 않으며 호출마다 학습합니다."),
    "crf":("labels", "제공한 토큰 특징·정답 시퀀스로 학습해 새 시퀀스의 라벨을 반환합니다.", "단순 특징 객체만 허용하며 원문 특징 생성·범용 언어 모델은 포함되지 않습니다."),
}
for alias, target in {"anomaly_detection":"isolation_forest", "model_drift":"data_drift", "xai":"feature_importance"}.items():
    extended[alias] = extended[target]
for tool_id, (fields, explanation, limitation) in extended.items():
    scientific([tool_id], "extended", fields, explanation, limitation, {"anomaly_detection":"isolation_forest", "model_drift":"data_drift", "xai":"feature_importance"}.get(tool_id, tool_id))

vision_filters = set(media.CV) - {"otsu", "image_segmentation", "connected_components", "object_detection", "watershed", "sift", "optical_flow", "object_tracking", "computer_vision"}
for tool_id in vision_filters:
    medium([tool_id], "vision", "image", "설정한 영상 연산을 적용한 픽셀·수치 배열을 image에 반환합니다.", "작은 입력 영상의 고전적 처리입니다. 객체 의미·이미지 설명을 생성하지 않습니다.")
medium("otsu image_segmentation", "vision", "image threshold method", "Otsu 임계값과 이진 분할 영상을 반환합니다.", "의미 분할·객체 분류 모델이 아닙니다.", "otsu_binary_segmentation")
medium("connected_components object_detection", "vision", "labels components method semanticClasses", "임계값 이상의 연결 성분 라벨·상자·면적·중심을 반환합니다.", "사람·차량 같은 의미 클래스를 인식하지 않습니다.", "threshold_connected_components")
medium("nms", "vision", "indices boxes scores", "이미 주어진 상자·점수에서 중복 상자를 억제한 결과를 반환합니다.", "객체를 직접 검출하지 않습니다. 입력은 x1,y1,x2,y2 좌표입니다.")
medium("watershed", "vision", "markers", "사용자가 제공한 시작 마커로 분할한 라벨 배열을 반환합니다.", "마커 생성과 의미 분류는 별도입니다.")
medium("sift", "vision", "points descriptors", "특징점의 좌표·크기·각도와 기술자 배열을 반환합니다.", "특징이 없으면 빈 목록입니다. 객체 신원·대응을 자동 확정하지 않습니다.")
medium("optical_flow", "vision", "flow method", "같은 크기의 이전·현재 영상에서 Farneback 이동 벡터를 계산합니다.", "카메라 이동과 실제 객체 이동을 의미적으로 구분하지 않습니다.")
medium("object_tracking", "vision", "box distance method", "하나의 템플릿과 가장 가까운 영상 영역을 반환합니다.", "단일 템플릿 매칭이며 다중 객체·장기 추적·재식별을 제공하지 않습니다.")
medium("computer_vision", "vision", "width height channels meanBrightness edgePixelCount method", "영상 크기·채널·밝기 평균·경계 픽셀 수를 반환합니다.", "영상의 의미 설명이나 범용 비전 모델이 아닌 수치 통계입니다.")
medium("glcm", "features", "contrast homogeneity energy", "회색조 동시발생 행렬의 대비·균질성·에너지를 반환합니다.", "회색조 이미지의 제한된 방향·거리 텍스처 특징입니다.")
medium("lbp", "features", "image", "국소 이진 패턴 배열을 반환합니다.", "회색조 8방향·반경1·uniform 패턴 설정입니다.")
medium("hog", "features", "descriptor", "방향 기울기 히스토그램의 1차원 특징 벡터를 반환합니다.", "회색조 영상의 고정 셀·블록 설정이며 객체 분류를 수행하지 않습니다.")
for tool_id, fields, explanation in [
    ("ner", "entities modelSource", "로컬 spaCy 모델의 개체 문자열·라벨·시작·끝 위치를 반환합니다."),
    ("embedding", "vectors modelSource", "로컬 SentenceTransformer 모델로 정규화한 문장 벡터를 반환합니다."),
    ("reranking", "results modelSource", "로컬 CrossEncoder의 질문·문서 점수 순위를 반환합니다."),
    ("sentiment", "predictions modelSource", "로컬 분류 모델의 라벨·점수 목록을 반환합니다."),
]:
    medium([tool_id], "language", fields, explanation, "사용자가 준비한 호환 로컬 모델과 패키지가 필요합니다. 모델 다운로드·외부 AI API 호출·모델 품질 검증은 수행하지 않습니다.")
medium("tts", "audio", "samples sampleRate modelSource", "로컬 모델의 음성 표본과 표본 속도를 반환합니다.", "호환 로컬 모델이 필요하며 출력은 최대 100,000개 표본입니다. 파일 저장·재생은 별도입니다.")
medium("stt", "audio", "text segments language modelSource", "로컬 Whisper 모델의 전체 텍스트와 시간 구간을 반환합니다.", "16,000Hz 표본 입력과 로컬 모델이 필요합니다. 실제 인식 품질은 별도 검증 대상입니다.")
medium("vad", "audio", "frames method semanticSpeechDetection", "구간별 RMS 에너지가 임계값을 넘는지와 시간 범위를 반환합니다.", "사람의 말을 의미적으로 인식하지 않으며 소음도 활성 구간이 될 수 있습니다.")
medium("speaker_diarization", "audio", "segments method speakerIdentityVerified", "활성 음향 구간을 특징값으로 군집화한 시간·군집 번호를 반환합니다.", "개인 화자 신원 확인·검증된 다화자 분리 모델이 아닌 음향 군집 기준선입니다.")
medium("watermark", "credentials", "text watermark valid scheme aiAuthorshipProven", "sign은 HMAC 서명·본문을, verify는 제공한 서명의 일치 여부를 반환합니다.", "Flowly 전용 텍스트 서명입니다. AI 저작 여부나 일반 워터마크 검출을 증명하지 않습니다.")
medium("content_credentials", "credentials", "valid scheme claimsVerified c2paSupported", "Flowly manifest의 서명과 콘텐츠 해시 일치 여부를 반환합니다.", "C2PA 호환 검증이나 콘텐츠 주장 자체의 사실 확인은 지원하지 않습니다.")
medium("rpa computer_use", "browser", "observations mode networkAllowed externalApplicationAccess", "제공된 HTML에서 fill·check·read·count 동작의 관측 목록을 반환합니다.", "JavaScript·네트워크를 끈 격리 HTML만 처리합니다. 실제 회사 사이트·데스크톱 조작은 등록한 MCP가 필요합니다.", "isolated_supplied_html")
medium("ocr", "execute_media", "text engine", "로컬 Tesseract 엔진의 인식 텍스트를 반환합니다.", "Tesseract 실행 파일과 선택 언어 자료가 필요합니다. 표 구조·문서 레이아웃 복원은 제공하지 않습니다.")
medium("pose_estimation", "execute_media", "poses modelSource", "로컬 MediaPipe 모델의 자세 점 x·y·z·가시성을 반환합니다.", "RGB 영상과 호환 로컬 모델이 필요하며 실제 모델 정확도는 별도 검증 대상입니다.")
medium("multimodal", "execute_media", "text modelSource", "로컬 Vision2Seq 모델에 영상과 프롬프트를 넣어 텍스트를 반환합니다.", "호환 로컬 모델이 필요하며 최대 생성 토큰은 256입니다. 외부 AI 연결이나 모델 자동 다운로드는 수행하지 않습니다.")


def build():
    catalog_ids = {tool["id"] for tool in CATALOG["tools"]}
    if set(AUDITS) != catalog_ids or catalog_ids != set(base.registry()) or len(catalog_ids) != 195:
        raise ValueError(f"전수 대응 불일치: missing={sorted(catalog_ids-set(AUDITS))}, extra={sorted(set(AUDITS)-catalog_ids)}")
    groups = collections.defaultdict(list)
    for tool_id, value in AUDITS.items():
        groups[(value["source"], value["handler"], value["algorithm"])].append(tool_id)
    for tool_id, value in AUDITS.items():
        value["sharedImplementationIds"] = sorted(item for item in groups[(value["source"], value["handler"], value["algorithm"])] if item != tool_id)
    result = {"version": 1, "basis": "source_only", "count": len(AUDITS), "tools": dict(sorted(AUDITS.items()))}
    rows = []
    for tool in CATALOG["tools"]:
        value = AUDITS[tool["id"]]
        reference = f"[{value['handler']}:{value['sourceLine']}](../{value['source']})"
        rows.append(f"| `{tool['id']}` | {tool['name']} | {reference} | {', '.join(value['outputFields'])} | {value['outputDescription']} | {value['limitation']} | {', '.join(value['sharedImplementationIds']) or '—'} |")
    counts = collections.Counter((value["source"], value["handler"]) for value in AUDITS.values())
    summary = "\n".join(f"- `{source}:{handler}`: {count}개" for (source, handler), count in sorted(counts.items()))
    report = """# Python 도구 195개 소스 지원 범위 감사

생성: `python scripts/audit-python-tool-support.py`. 일치 검사: 같은 명령에 `--check`를 붙인다.
`flowly_tools.py` 레지스트리·공개 계약, 과학·미디어 분기와 실제 반환문을 대조했다. 이 문서와 화면의 설명은 **소스 감사**이며 195개 도구의 실행 성공·품질·현재 PC 설치 상태를 뜻하지 않는다.

출력 열은 해당 도구에서 가능한 최상위 키의 합집합이다. 동작·추정기 속성에 따라 일부 키만 반환한다. 상세 입력 예시는 기존 `tool-contracts.json` 계약을 따른다. 누락 패키지·로컬 모델·Tesseract·브라우저·HMAC 설정은 내려받은 실행 환경의 `check`에서 확인해야 한다. 웹은 이 도구와 OpenAI를 실행하지 않는다.

도구 195개는 195개의 독립 알고리즘을 의미하지 않는다. 같은 알고리즘·분기를 공유하는 항목은 마지막 열에 표시했다. 같은 처리 함수라도 알고리즘이 다른 경우는 별칭으로 표시하지 않았다. 예제 연결 기획은 추천 관계이며 자동 도구 허가·실제 호출 증거가 아니다.

## 분기별 전수 분류

""" + summary + "\n\n## 항목별 반환값과 한계\n\n| ID | 이름 | 구현 함수 | 가능한 출력 키 | 결과 의미 | 현재 제약 | 같은 구현 ID |\n|---|---|---|---|---|---|---|\n" + "\n".join(rows) + """

## 미검증 범위

- 이번 감사 생성기는 모델·알고리즘·브라우저를 실행하지 않았으며 실제 OpenAI·MCP 호출은 없다.
- 사용자 제공 로컬 모델의 호환성·정확도, 전체 선택 패키지 버전 조합, 설치 상태, 실자료 성능·품질은 별도 검증 대상이다.
- 입출력 크기 제한과 오류 처리는 기존 실행기의 책임이다. 이 표는 새 실행 기능이나 자료 권한을 부여하지 않는다.
- 함수 AST 지문·레지스트리·산출물 일치 검사는 설명이 소스와 함께 갱신되도록 돕지만, 모든 경로의 동적 테스트를 대체하지 않는다.
"""
    return {ROOT / "domain/tool-support.json": json.dumps(result, ensure_ascii=False, indent=2) + "\n", ROOT / "docs/PYTHON_TOOL_SUPPORT_AUDIT.md": report}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for target, content in build().items():
        if args.check:
            if not target.exists() or target.read_text(encoding="utf-8") != content:
                raise SystemExit(f"지원 범위 대응표 갱신 필요: {target.relative_to(ROOT)}")
        else:
            target.write_text(content, encoding="utf-8", newline="\n")
    print(f"Source audit {'checked' if args.check else 'generated'}: {len(AUDITS)} registered tools; algorithm executions: 0; external API calls: 0")
