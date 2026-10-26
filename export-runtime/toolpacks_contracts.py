# 등록 Python 도구의 공개 스키마/예시/설명 생성 소스. 실제 도구 실행이나 모델 연결은 수행하지 않는다.
"""Build public JSON argument contracts; no provider/runtime execution."""
import json
from pathlib import Path


# 레지스트리 ID와 입력 필드를 함께 정의한다. 구현 변경 시 생성 JSON 계약/설명도 별도로 동기화한다.
def contracts():
    from flowly_tools import registry
    from toolpacks_scientific import ESTIMATORS,CLUSTER,REDUCE,METRICS
    string={"type":"string"};num={"type":"number"};obj={"type":"object"};boolean={"type":"boolean"}
    numbers={"type":"array","items":num};strings={"type":"array","items":string};rows={"type":"array","items":numbers};items={"type":"array"}
    output={}
    # 별칭이 동일 입력 계약을 공유할 수 있다. 계약 공유가 서로 다른 알고리즘을 뜻하지는 않는다.
    def add(ids,fields,required,example,note=""):
        if isinstance(ids,str):ids=ids.split()
        for identifier in ids:
            output[identifier]={"inputSchema":{"type":"object","properties":fields,"required":required.split(),"additionalProperties":False},"exampleArguments":example,"usage":note or "입력 계약에 맞는 자료를 처리하는 로컬 도구입니다."}
    add("jsonl",{"text":string},"text",{"text":'{"id":"a","value":1}\n{"id":"b","value":2}'},"text에 JSONL 원문을 전달합니다. records/count를 반환합니다.")
    add("chunking",{"text":string,"size":num,"overlap":num},"text",{"text":"사내 자료를 작은 조각으로 분할합니다.","size":8,"overlap":2},"Unicode 문자 기준 분할. chunks의 start/end는 원문 위치입니다.")
    add("tokenizer tokens",{"text":string},"text",{"text":"사내 문서 검색"},"운영자가 models/ 아래에 준비한 tokenizers JSON 파일이 필요합니다. 실제 tokenizer의 ids/tokens/count를 반환합니다.")
    add("json_schema",{"schema":obj,"value":{}},"schema value",{"schema":{"type":"object","required":["count"],"properties":{"count":{"type":"number"}}},"value":{"count":2}},"외부 참조와 임의 정규식 없이 JSON Schema 2020-12를 검증합니다.")
    docs=[{"id":"policy","text":"회의실 예약 취소 규정"},{"id":"code","text":"파이썬 코드 테스트"}]
    add("bm25 tfidf reranking",{"documents":items,"query":string,"topK":num},"documents query",{"documents":docs,"query":"회의실","topK":2},"documents는 id/text 객체 목록입니다. results에 id/score를 반환합니다. reranking은 사전에 준비한 로컬 CrossEncoder 모델이 필요합니다.")
    add("rrf",{"rankings":items,"k":num},"rankings",{"rankings":[["a","b"],["b","c"]]},"각 순위 목록은 문서 ID 문자열 또는 id 객체입니다. 중복 문서는 목록마다 한 번만 계산합니다.")
    add("hybrid_search",{"lexicalResults":items,"vectorResults":items,"k":num},"lexicalResults vectorResults",{"lexicalResults":["a","b"],"vectorResults":["b","c"]},"이미 계산한 어휘/벡터 순위를 RRF로 결합합니다. 이 도구는 자체 검색을 수행하지 않습니다.")
    add("cosine_similarity",{"a":numbers,"b":numbers},"a b",{"a":[1,0],"b":[0,1]})
    add("semantic_search",{"queryVector":numbers,"vectors":items,"topK":num},"queryVector vectors",{"queryVector":[1,0],"vectors":[{"id":"a","vector":[1,0]},{"id":"b","vector":[0,1]}]})
    add("query_expansion",{"query":string,"synonyms":obj},"query synonyms",{"query":"API","synonyms":{"api":["인터페이스"]}},"명시적으로 제공한 동의어만 질의에 추가합니다.")
    add("embedding",{"texts":strings},"texts",{"texts":["회의실 예약 규정","파이썬 코드"]})
    add("ann hnsw ivf_flat",{"data":rows,"queries":rows,"topK":num,"clusters":num,"probes":num},"data queries",{"data":[[0,0],[1,1],[2,2],[3,3]],"queries":[[0,0]],"topK":1},"행렬 벡터의 이웃 indices/distances를 반환합니다. ann은 exact 기준 구현, hnsw/ivf_flat은 근사 방식입니다.")
    add("scalar_quantization",{"data":rows,"bits":num},"data",{"data":[[0,1],[2,3]],"bits":8})
    add("product_quantization",{"data":rows,"subspaces":num,"clusters":num},"data",{"data":[[0,0],[1,1],[2,2],[3,3]],"subspaces":2,"clusters":2})
    add("ner sentiment",{"text":string},"text",{"text":"서울 연구팀은 새 시스템을 검토했습니다."},"운영자가 준비한 로컬 모델이 필요하며 다운로드하지 않습니다.")
    add("knowledge_graph",{"edges":items,"start":string,"depth":num},"edges start",{"edges":[{"from":"서비스A","to":"DB1","source":"문서1"},{"from":"DB1","to":"백업1","source":"문서2"}],"start":"서비스A","depth":2},"제공된 from/to/source 관계를 방향 그래프로 탐색합니다. 원문에서 관계를 자동 추출하지 않습니다.")
    add("data_quality",{"rows":items},"rows",{"rows":[{"id":1,"value":5},{"id":1,"value":5},{"id":2,"value":None}]},"rowCount/duplicateCount/columns(name,missing,types)를 반환합니다.")
    common={"operation":{**string,"enum":["fit","transform","fit_transform"]},"trainingData":rows,"data":rows,"state":obj,"params":obj}
    add("feature_selection feature_binarization whitening quantile_transform power_transform maxabs_scaling robust_scaling standard_scaling minmax_scaling l1_normalization l2_normalization feature_engineering features",common,"",{"trainingData":[[1,1],[2,4],[3,2],[4,3]],"data":[[2,3]]},"fit/fit_transform은 trainingData 또는 data로 학습하며, transform은 이전 state와 새 data를 사용합니다. state는 JSON 학습 레시피이며 pickle이 아닙니다.")
    add("feature_discretization",{**common,"bins":num},"",{"trainingData":[[1],[2],[3],[4]],"data":[[3]],"params":{"bins":2}})
    add("imputation",{**common,"trainingData":items,"data":items},"",{"trainingData":[[1],[3],[None]],"data":[[None]]},"숫자 행렬의 null을 학습 자료의 열별 중앙값으로 대체합니다.")
    add("label_encoding frequency_encoding ordinal_encoding onehot_encoding",{"trainingData":items,"data":items},"trainingData",{"trainingData":["a","a","b"],"data":["a","unknown"]})
    add("target_encoding",{"trainingData":items,"trainingLabels":numbers,"data":items},"trainingData trainingLabels data",{"trainingData":["a","a","b"],"trainingLabels":[1,3,9],"data":["a"]},"평가 자료 누출을 피하도록 별도 data 변환 배치를 요구합니다. 교차 적합은 별도 설계가 필요합니다.")
    add("feature_hashing",{"trainingData":items,"data":items,"nFeatures":num},"trainingData",{"trainingData":["a","b"],"data":["b"],"nFeatures":8})
    add("synthetic_data",{"count":num,"columns":num,"seed":num,"mean":num,"std":num},"",{"count":3,"columns":2,"seed":7},"독립 정규분포 표본입니다. 원본 자료의 관계를 복제하는 생성 모델이 아닙니다.")
    add("data_augmentation",{**common,"sigma":num,"seed":num},"",{"data":[[1,2],[3,4]],"sigma":0.01,"seed":7})
    add("data_labeling",{"records":items,"labels":items},"records labels",{"records":["검토 문서"],"labels":["확인됨"]})
    train=[[i,i%3] for i in range(12)];labels=[int(i>=6) for i in range(12)]
    model_fields={"operation":{**string,"enum":["fit","predict","fit_predict"]},"trainingData":rows,"trainingLabels":items,"data":rows,"state":obj,"params":obj}
    for identifier in ESTIMATORS:
        regress=identifier in {"pls","ard","omp","theil_sen","bayesian_ridge","elastic_net","poisson_regression","quantile_regression","huber_regression","gaussian_process","regression","ransac"}
        example={"trainingData":[[i] for i in range(12)] if regress else train,"trainingLabels":[2*i+1 for i in range(12)] if regress else labels,"data":[[5]] if regress else [[5,2]]}
        add([identifier],model_fields,"",example,"fit는 trainingData/trainingLabels, predict는 같은 도구의 state/data가 필요합니다. 기본 fit_predict는 별도 data를 예측합니다. 평가 배치를 학습에 사용하지 않습니다.")
    add("crf",{"trainingData":items,"trainingLabels":items,"data":items},"trainingData trainingLabels data",{"trainingData":[[{"word":"hello"},{"word":"Seoul"}],[{"word":"hi"},{"word":"Busan"}]],"trainingLabels":[["O","CITY"],["O","CITY"]],"data":[[{"word":"hello"},{"word":"Busan"}]]})
    add("hmm",{"trainingData":rows,"data":rows,"states":num},"trainingData data",{"trainingData":[[0],[0.1],[0.2],[5],[5.1],[5.2]],"data":[[0],[5]],"states":2})
    add("causal_inference",{"a":numbers,"b":numbers,"randomizedTreatment":boolean},"a b randomizedTreatment",{"a":[1,2,3],"b":[4,5,6],"randomizedTreatment":True},"무작위 배정 실험의 평균 차이만 지원합니다. 인과 가정을 자동 검증하지 않습니다.")
    add("time_series_forecast",{"values":numbers,"steps":num},"values",{"values":[1,3,5],"steps":2},"선형 추세 기준 예측입니다. 신뢰 구간 또는 복합 시계열 모델을 제공하지 않습니다.")
    add("recommender",{"ratings":rows,"user":num,"topK":num},"ratings user",{"ratings":[[5,0],[5,4]],"user":0,"topK":1},"0은 미평가 항목입니다. 사용자 간 코사인 유사도로 추천 점수를 계산합니다.")
    data=[[0,0],[0.1,0.2],[0.2,0.1],[5,5],[5.1,5.2],[5.2,5.1],[10,0],[10.1,0.2]]
    add(list(CLUSTER),{"data":rows,"params":obj},"data",{"data":data},"한 자료 배치의 군집 labels를 반환합니다. 새 자료를 기존 군집에 배정하는 영속 모델과 구분합니다.")
    add(list(REDUCE)+["umap"],{"data":rows,"params":obj,"targets":rows},"data",{"data":data,"params":{"n_components":1}},"차원 축소 결과 data를 반환합니다. CCA는 같은 행 수의 targets도 필요합니다.")
    output["cca"]["exampleArguments"]={"data":data,"targets":[[i] for i in range(len(data))],"params":{"n_components":1}}
    for identifier in METRICS:
        if identifier in {"calinski_harabasz","davies_bouldin","silhouette"}:
            add([identifier],{"data":rows,"labels":items},"data labels",{"data":[[0],[0.1],[5],[5.1]],"labels":[0,0,1,1]})
        else:add([identifier],{"expected":items,"actual":items},"expected actual",{"expected":[0,0,1,1],"actual":[0,1,1,1]},"expected는 기준 정답, actual은 예측입니다. 확률 지표는 actual에 점수를 전달합니다. precision/recall/f1은 macro 평균입니다.")
    add("wer",{"reference":string,"hypothesis":string},"reference hypothesis",{"reference":"a b c","hypothesis":"a c"})
    add("ab_test",{"a":numbers,"b":numbers},"a b",{"a":[1,2,3],"b":[4,5,6]},"독립 표본 Welch t-test입니다. 무작위 배정 및 실험 설계는 별도로 검토해야 합니다.")
    add("cross_validation feature_importance xai",{"trainingData":rows,"trainingLabels":items,"validationData":rows,"validationLabels":items,"estimator":string,"params":obj,"folds":num},"trainingData trainingLabels",{"trainingData":train,"trainingLabels":labels,"validationData":[[1,1],[9,0]],"validationLabels":[0,1]},"cross_validation은 CV 점수, feature_importance/xai는 별도 validationData/validationLabels의 순열 중요도를 반환합니다.")
    add("throughput",{"count":num,"seconds":num},"count seconds",{"count":15,"seconds":3})
    add("benchmark evals",{"cases":items},"cases",{"cases":[{"id":"a","expected":2,"actual":2},{"id":"b","expected":3,"actual":2}]},"cases의 mode는 exact/contains/numeric이며 numeric은 tolerance를 사용할 수 있습니다.")
    add("conformal_prediction",{"calibrationExpected":numbers,"calibrationPredicted":numbers,"predictions":numbers,"alpha":num},"calibrationExpected calibrationPredicted predictions",{"calibrationExpected":list(range(20)),"calibrationPredicted":[i+1 for i in range(20)],"predictions":[10],"alpha":0.1})
    add("lof isolation_forest kde ood anomaly_detection",{"trainingData":rows,"data":rows,"bandwidth":num,"threshold":num},"trainingData data",{"trainingData":[[i/10] for i in range(20)],"data":[[0.5],[99]]})
    add("data_drift model_drift",{"reference":numbers,"current":numbers,"alpha":num},"reference current",{"reference":list(range(30)),"current":list(range(100,130))},"제공된 값 분포의 두 표본 KS 검사입니다. model_drift가 모델 품질을 자동 측정하는 것은 아닙니다.")
    add("calibration",{"trainingScores":numbers,"trainingLabels":numbers,"scores":numbers},"trainingScores trainingLabels scores",{"trainingScores":[0.1,0.2,0.8,0.9],"trainingLabels":[0,0,1,1],"scores":[0.15,0.85]})
    add("classification_threshold",{"scores":numbers,"threshold":num},"scores",{"scores":[0.2,0.8],"threshold":0.7})
    add("fft dct dwt",{"values":numbers,"wavelet":string},"values",{"values":[1,0,0,0]},"dwt의 wavelet은 haar/db2/db4/sym2 중 선택합니다.")
    add("hungarian",{"costs":rows},"costs",{"costs":[[4,1],[2,3]]},"비용 행렬의 최소 비용 1:1 배정을 계산합니다. assignments(row,column,cost)/totalCost를 반환합니다.")
    add("dtw",{"a":numbers,"b":numbers},"a b",{"a":[1,2,3],"b":[1,2,3]})
    add("kalman",{"values":numbers,"processVariance":num,"measurementVariance":num,"initialMean":num,"initialVariance":num},"values",{"values":[1,2,3]},"1차원 random-walk 칼만 필터입니다.")
    add("hessenberg schur lu qr cholesky eigen",{"matrix":rows},"matrix",{"matrix":[[4,1],[1,3]]})
    image=[[255 if 5<=x<10 and 5<=y<10 else 0 for x in range(16)] for y in range(16)]
    fields={"image":items,"kernelSize":num,"gamma":num,"mode":string,"threshold":num,"markers":rows,"low":num,"high":num,"maxFeatures":num,"previous":items,"template":items,"levels":num}
    add("laplacian gamma_correction gaussian_filter harris_corners median_filter bilateral_filter histogram_equalization watershed distance_transform morphology connected_components otsu glcm canny lbp hog sift optical_flow object_tracking image_segmentation object_detection computer_vision",fields,"image",{"image":image},"image는 최대256×256의 0~255 픽셀 배열입니다. 색상 입력은 RGB입니다. 지원 범위는 도구 scope를 확인해 주세요.")
    output["watershed"]["exampleArguments"]={"image":image,"markers":[[1 if x==0 or y==0 else 2 if x==7 and y==7 else 0 for x in range(16)] for y in range(16)]}
    output["optical_flow"]["exampleArguments"]={"image":image,"previous":image}
    output["object_tracking"]["exampleArguments"]={"image":image,"template":[[255]*3]*3}
    add("nms",{"boxes":rows,"scores":numbers,"threshold":num},"boxes scores",{"boxes":[[0,0,10,10],[1,1,9,9]],"scores":[0.9,0.8]},"상자는 x1,y1,x2,y2입니다. 중복을 제거한 indices/boxes/scores를 반환합니다.")
    add("pose_estimation",{"image":items,"maxPoses":num},"image",{"image":[[[0,0,0]]*16]*16},"RGB 영상과 사전에 준비한 MediaPipe PoseLandmarker 모델이 필요합니다.")
    add("ocr",{"image":items,"language":string},"image",{"image":image,"language":"eng"},"로컬 Tesseract 엔진과 해당 언어 데이터가 필요합니다.")
    add("ssml",{"text":string,"rate":num},"text",{"text":"안녕하세요","rate":100})
    samples=[0.0]*160+[0.2,-0.2]*80
    add("vad speaker_diarization stt",{"samples":numbers,"sampleRate":num,"frameMs":num,"threshold":num,"speakers":num,"language":string},"samples",{"samples":samples,"sampleRate":16000,"frameMs":10,"speakers":1},"-1~1 PCM 표본, 최대100000개. STT는16000Hz/로컬Whisper모델 필요. VAD는에너지 기준, 화자분리는음향군집 기준입니다.")
    add("tts",{"text":string},"text",{"text":"안녕하세요"},"로컬 AutoModelForTextToWaveform 호환 모델을 사용하며 PCM samples/sampleRate를 반환합니다.")
    add("multimodal",{"image":items,"prompt":string,"maxTokens":num},"image",{"image":[[[0,0,0]]*16]*16,"prompt":"Describe this image.","maxTokens":20},"로컬 AutoModelForVision2Seq 모델과 processor가 필요합니다.")
    add("pii redaction anonymization data_classification",{"text":string},"text",{"text":"alice@example.test가 담당합니다."},"고정 패턴의 개인정보 후보를 찾거나 가립니다. 완전 탐지나 익명성을 보장하지 않습니다.")
    add("moderation",{"text":string,"blockedPhrases":strings},"text blockedPhrases",{"text":"PRIVATE 자료","blockedPhrases":["private"]})
    add("ai_citation",{"documents":items,"citations":items},"documents citations",{"documents":[{"id":"a","text":"원문 근거"}],"citations":[{"id":"a","quote":"원문"}]},"문서 ID와 인용 문자열 일치만 검사하며 의미적 사실 여부를 판정하지 않습니다.")
    add("differential_privacy",{"value":num,"epsilon":num,"sensitivity":num,"singleQueryAcknowledged":boolean},"value epsilon sensitivity singleQueryAcknowledged",{"value":10,"epsilon":1,"sensitivity":1,"singleQueryAcknowledged":True},"단일 스칼라 Laplace 메커니즘입니다. 반복 호출 예산 원장은 포함하지 않습니다.")
    add("watermark",{"text":string,"operation":{**string,"enum":["sign","verify"]},"watermark":obj},"text",{"text":"sample","operation":"sign"},"FLOWLY_WATERMARK_KEY가 필요합니다. 지원하는 HMAC 서명 체계이며 AI 작성 여부 탐지기가 아닙니다.")
    add("content_credentials",{"text":string,"manifest":obj,"signature":string},"text manifest signature",{"text":"sample","manifest":{"scheme":"flowly-content-hmac-v1","sha256":"configured-content-sha256"},"signature":"configured-hmac"},"FLOWLY_CONTENT_CREDENTIALS_KEY로 Flowly HMAC manifest를 검증합니다. C2PA 구현이 아닙니다.")
    add("rpa computer_use",{"html":string,"actions":items},"html",{"html":"<label>Name<input id='name'></label><p id='result'>ready</p>","actions":[{"action":"fill","selector":"#name","value":"Flowly"},{"action":"read","selector":"#result"}]},"제공된 HTML을 격리 브라우저에서 처리합니다. JavaScript/네트워크/외부 앱 접근을 차단하고 fill/check/read/count만 지원합니다.")
    missing=registry()-set(output)
    if missing:raise ValueError("Missing tool contracts: "+str(sorted(missing)))
    from flowly_tools import MODEL_TOOLS
    from toolpacks_scientific import SCIENTIFIC
    from toolpacks_media import MEDIA
    for identifier,contract in output.items():
        dependencies=SCIENTIFIC.get(identifier,MEDIA.get(identifier,[]))
        if identifier=="json_schema":dependencies=["jsonschema"]
        if identifier in {"tokenizer","tokens"}:dependencies=["tokenizers"]
        contract.update(dependencies=dependencies,modelRequired=identifier in MODEL_TOOLS,effect="read",limits={"inputBytes":1_000_000,"outputBytes":1_000_000,"matrixRows":1000,"matrixColumns":128,"matrixCells":32000,"imageWidth":256,"imageHeight":256,"audioSamples":100000},semantics=contract["usage"])
    return {"version":1,"tools":{key:output[key] for key in sorted(output)}}


if __name__=="__main__":
    Path(__file__).with_name("tool-contracts.json").write_text(json.dumps(contracts(),ensure_ascii=False,indent=2)+"\n",encoding="utf8")
