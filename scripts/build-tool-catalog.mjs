/**
 * 도구화 후보·기능군·예제 연결 및 공개 계약의 카탈로그 산출물을 만든다. 연결 목록 자체는 실제 서비스 호출이나 사용자에게 주어진 실행 권한이 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const families = [
  ['F01', '입력·텍스트 준비', 'stdlib', `jsonl|JSONL;chunking|문서 분할;tokenizer|토크나이저;tokens|토큰 계산;json_schema|JSON Schema`],
  ['F02', '검색·순위 결합', 'search', `scalar_quantization|스칼라 양자화;product_quantization|제품 양자화;ivf_flat|IVF Flat;hnsw|HNSW;rrf|RRF;bm25|BM25;tfidf|TF-IDF;ann|근사 최근접 탐색;query_expansion|질문 확장;hybrid_search|하이브리드 검색;reranking|리랭킹;semantic_search|의미 검색;cosine_similarity|코사인 유사도;embedding|임베딩`],
  ['F03', '지식 추출·그래프', 'nlp', `ner|개체명 인식;sentiment|감성 분석;knowledge_graph|지식 그래프`],
  ['F04', '데이터 준비·특징 변환', 'science', `feature_selection|특징 선택;feature_binarization|특징 이진화;feature_discretization|특징 구간화;label_encoding|레이블 인코딩;frequency_encoding|빈도 인코딩;ordinal_encoding|순서 인코딩;target_encoding|타깃 인코딩;feature_hashing|특징 해싱;whitening|화이트닝;quantile_transform|분위수 변환;power_transform|거듭제곱 변환;maxabs_scaling|최대 절댓값 스케일링;robust_scaling|강건 스케일링;standard_scaling|표준화;minmax_scaling|최소·최대 스케일링;l1_normalization|L1 정규화;l2_normalization|L2 정규화;feature_engineering|특징 공학;data_quality|데이터 품질;imputation|결측값 대체;onehot_encoding|원핫 인코딩;synthetic_data|합성 데이터;features|특징;data_augmentation|데이터 증강;data_labeling|데이터 라벨링`],
  ['F05', '통계·예측 모델', 'science', `perceptron|퍼셉트론;pls|부분 최소 제곱;ard|자동 관련성 결정;omp|직교 매칭 추구;nearest_centroid|최근접 중심 분류;theil_sen|Theil-Sen 회귀;qda|이차 판별 분석;extra_trees|엑스트라 트리;bayesian_ridge|베이지안 릿지;elastic_net|엘라스틱넷;poisson_regression|포아송 회귀;quantile_regression|분위수 회귀;huber_regression|Huber 회귀;gaussian_process|가우시안 프로세스;crf|조건부 무작위장;hmm|은닉 마르코프 모델;gradient_boosting|그래디언트 부스팅;adaboost|에이다부스트;decision_tree|결정 트리;lda|선형 판별 분석;knn|K 최근접 이웃;logistic_regression|로지스틱 회귀;naive_bayes|나이브 베이즈;svm|서포트 벡터 머신;random_forest|랜덤 포레스트;causal_inference|인과 추론;time_series_forecast|시계열 예측;recommender|추천 시스템;regression|회귀;classification|분류;ransac|RANSAC`],
  ['F06', '군집·차원 축소', 'science', `sparse_pca|희소 PCA;kernel_pca|커널 PCA;random_projection|무작위 투영;factor_analysis|요인 분석;lle|국소 선형 임베딩;isomap|Isomap;cca|정준 상관 분석;kmeans|K-means;birch|BIRCH;hdbscan|HDBSCAN;optics|OPTICS;affinity_propagation|친화도 전파;mean_shift|평균 이동;spectral_clustering|스펙트럴 군집;hierarchical_clustering|계층 군집;gmm|가우시안 혼합;umap|UMAP;tsne|t-SNE;dbscan|DBSCAN;ica|독립 성분 분석;nmf|비음수 행렬 분해;svd|특잇값 분해;pca|주성분 분석;clustering|군집화`],
  ['F07', '평가·실험·설명', 'science', `hamming_loss|해밍 손실;average_precision|평균 정밀도;brier_score|Brier 점수;cohen_kappa|Cohen 카파;mcc|Matthews 상관계수;balanced_accuracy|균형 정확도;pair_confusion_matrix|쌍 혼동 행렬;contingency_matrix|분할표;fowlkes_mallows|Fowlkes-Mallows 지수;adjusted_mutual_info|조정 상호정보;v_measure|V-measure;adjusted_rand|조정 Rand 지수;calinski_harabasz|Calinski-Harabasz 지수;davies_bouldin|Davies-Bouldin 지수;silhouette|실루엣;wer|단어 오류율;roc_auc|ROC-AUC;recall|재현율;precision|정밀도;ab_test|A/B 테스트;cross_validation|교차 검증;throughput|처리량;feature_importance|특징 중요도;f1|F1 점수;accuracy|정확도;confusion_matrix|혼동 행렬;xai|설명 가능한 AI;benchmark|벤치마크;evals|평가`],
  ['F08', '이상·변화·불확실성', 'science', `conformal_prediction|컨포멀 예측;lof|국소 이상치 인자;isolation_forest|격리 숲;kde|커널 밀도 추정;ood|분포 밖 탐지;anomaly_detection|이상 탐지;data_drift|데이터 드리프트;calibration|확률 보정;classification_threshold|분류 임계값;model_drift|모델 드리프트`],
  ['F09', '배정·신호·수치 계산', 'science', `fft|고속 푸리에 변환;dct|이산 코사인 변환;dwt|이산 웨이블릿 변환;hungarian|헝가리안 배정;dtw|동적 시간 왜곡;kalman|칼만 필터;hessenberg|Hessenberg 분해;schur|Schur 분해;lu|LU 분해;qr|QR 분해;cholesky|Cholesky 분해;eigen|고윳값 분해`],
  ['F10', '영상 처리·시각 분석', 'vision', `laplacian|라플라시안;gamma_correction|감마 보정;gaussian_filter|가우시안 필터;harris_corners|Harris 코너;median_filter|중앙값 필터;bilateral_filter|양방향 필터;histogram_equalization|히스토그램 평활화;watershed|워터셰드;distance_transform|거리 변환;morphology|형태학 연산;connected_components|연결 성분;otsu|Otsu 이진화;glcm|회색조 동시발생 행렬;canny|Canny 경계;lbp|국소 이진 패턴;hog|방향 기울기 히스토그램;sift|SIFT;nms|비최대 억제;optical_flow|광학 흐름;pose_estimation|자세 추정;object_tracking|객체 추적;image_segmentation|영상 분할;object_detection|객체 탐지;ocr|광학 문자 인식;computer_vision|컴퓨터 비전`],
  ['F11', '음성·멀티모달', 'audio', `ssml|음성 합성 마크업;vad|음성 활동 감지;speaker_diarization|화자 분리;tts|음성 합성;stt|음성 인식;multimodal|멀티모달 AI`],
  ['F12', '민감정보·콘텐츠 검증', 'privacy', `redaction|민감정보 가림;content_credentials|콘텐츠 자격 증명;ai_citation|AI 인용;data_classification|자료 민감도 분류;differential_privacy|차등 개인정보보호;moderation|콘텐츠 검토;anonymization|비식별화;pii|개인식별정보;watermark|워터마크`],
  ['F13', '프로그램·화면 자동화', 'automation', `rpa|업무 자동화;computer_use|컴퓨터 사용`],
];

const assignments = [
  ['F01 F07', '003 004 013 017 018 020 021 023 031 032 036 050 093 100'],
  ['F01 F07 F12', '001 005 015 016 033 034 041 096 097 098 099'],
  ['F02 F03 F07 F12', '002 007 008 009 010 012 024'],
  ['F01 F02 F04 F07 F12', '011 045 052 053 054 055 059 077'],
  ['F02 F03 F12', '057'],
  ['F01 F02 F04 F09', '025 056 058'],
  ['F04 F05 F06 F07 F08', '026 039 048 049'],
  ['F01 F04 F07 F08 F12', '014 019 022 028 037 040 051'],
  ['F01 F02 F12', '030 042 044'],
  ['F07 F12', '006 029'],
  ['F10 F11 F12', '027 038 062 063 064'],
  ['F02 F03 F07 F13', '046 060 061 065 066 067 068 069 070 071 072 073 074 075 076 078'],
  ['F04 F05 F07 F08 F09 F12', '079 080 081 082 083 084 085 086 087 088 089 090'],
  ['F01 F02 F03 F04 F05 F06 F07 F08 F09 F10 F11 F12 F13', '047 091 092 094 095'],
  ['F07 F09', '035 043'],
];
const mapDocument = fs.readFileSync(path.join(root, 'docs/EXAMPLE_99_IMPLEMENTATION_MAP.md'), 'utf8');
const rows = [...mapDocument.matchAll(/^\| (\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)];
const sourceDesigns = JSON.parse(fs.readFileSync(path.join(root, 'domain/generated/workflow-designs.json'), 'utf8'));
const sourceIds = new Set(sourceDesigns.map(value => value.id));
function hasAgent(value) { return !!value&&typeof value==='object'&&(value.type==='agent'||Object.values(value).some(item=>Array.isArray(item)?item.some(hasAgent):hasAgent(item))); }
const examples = rows.map(([, id, title, status, source, requirement]) => ({
  id, title: title.trim(), status: status.trim(), sourceIds: [...source.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(id => sourceIds.has(id)),
  families: assignments.find(([, ids]) => ids.split(' ').includes(id))?.[0].split(' ') ?? [],
  requirement: requirement.trim(), toolIds: [], integrationStatus: 'mapped',
}));
examples.push({id:'100', title:'공유 상태 기반 다음 참여자 선택 협업', status:'신규 개발', sourceIds:[], families:['F01','F07'], requirement:'작업 상태·산출물 버전 확인 → 조정 Agent가 다음 전문 역할 선택 → 도구 실행 → 결과 검증 → 충돌 확인·상태 반영 → 완료 조건 또는 제한된 다음 작업', toolIds:[], integrationStatus:'mapped'});
const integrations = {
  '007':['integrated-007-hybrid-tools','BM25·제공 벡터 코사인 검색·순위 결합·인용 대조의 실제 로컬 도구 경로. 벡터 생성·실제 모델 품질 별도.'],
  '039':['integrated-039-signal-comparison','기준·후보 FFT 실제 계산과 관측 한계 검토. 일반 업무 계산기·민감도 모델 전체는 추가 필요.'],
  '043':['integrated-043-cost-allocation','일대일 비용 배정·예산 비교·보완 입력·재개. 범용 다자 협상과 일반 제약 해결은 추가 필요.'],
  '048':['integrated-048-redacted-agent-input','패턴 가림·재검사 후 최소 텍스트만 Agent 입력. 완전 비식별화·분산 권한 정책을 보증하지 않음.'],
  '057':['integrated-057-graph-evidence','제공된 관계의 깊이 제한 탐색·출처 설명·독립 검토. 자동 추출·외부 그래프 DB·관계별 권한 확장 필요.'],
  '085':['integrated-085-data-quality-review','실제 행 품질 계산·Agent 교정안·사람 검토. 이 예제에서 실제 DB 수정은 수행하지 않음.'],
  '100':['integrated-100-adaptive-shared-board','단일 실행 내 공유 메모리·관측 기반 다음 역할 선택·독립 완료 검사. 분산 작업 점유·CAS는 추가 필요.'],
};
for(const source of sourceDesigns) {
  const planned=source.id.match(/^integrated-(\d{3})-/)?.[1];
  if(planned&&!integrations[planned])integrations[planned]=[source.id,source.description+' 기존 기획의 전체 업무 범위와 사내 서비스 구현·실모델 품질은 별도 검증 대상입니다.'];
}
for(const example of examples) {
  example.baselineStatus=example.status;
  const integration=integrations[example.id];
  if(integration&&sourceIds.has(integration[0])) {
    example.sourceIds=[integration[0],...example.sourceIds];
    example.integrationStatus='representative_implemented';
    example.integrationScope=integration[1];
    if(example.status!=='구현됨')example.status='보강 필요';
  } else example.integrationScope='기존 소스·공통 기반 대응이며 도구 후보 목록만으로 이 기획의 전체 구현 완료를 의미하지 않습니다.';
  example.agentCriterionMet=example.sourceIds.some(id=>hasAgent(sourceDesigns.find(source=>source.id===id)?.definition));
  if(example.status==='구현됨'&&!example.agentCriterionMet) {
    example.status='보강 필요';
    example.integrationScope+=' 기존 핵심 실행 경로에 명시적인 Agent 역할을 추가해야 새 AI Agent 필수 기준을 충족합니다.';
  }
}
const completionDirectory = path.join(root, 'domain/planned-completions');
const completions = fs.existsSync(completionDirectory) ? fs.readdirSync(completionDirectory).filter(name => name.endsWith('.json')).flatMap(name => JSON.parse(fs.readFileSync(path.join(completionDirectory, name), 'utf8'))) : [];
if (new Set(completions.map(item => item.id)).size !== completions.length || new Set(completions.map(item => item.sourceId)).size !== completions.length) throw new Error('Completion mappings must have distinct plan IDs and distinct authored workflows');
for (const completion of completions) {
  const example = examples.find(item => item.id === completion.id), source = sourceDesigns.find(item => item.id === completion.sourceId);
  if (!example || !source || !hasAgent(source.definition) || !Array.isArray(completion.acceptance) || completion.acceptance.length < 2 || !completion.implementedScope || !Array.isArray(completion.remainingSetup)) throw new Error(`Invalid completion acceptance mapping: ${completion.id}`);
  example.sourceIds = [completion.sourceId, ...example.sourceIds.filter(id => id !== completion.sourceId)];
  example.status = '구현됨'; example.integrationStatus = 'acceptance_implemented'; example.agentCriterionMet = true;
  example.acceptance = completion.acceptance; example.remainingSetup = completion.remainingSetup;
  example.integrationScope = completion.implementedScope + ' 사용자 설정: ' + (completion.remainingSetup.join(' · ') || '추가 없음') + '. 실제 모델 품질·사내 서비스 연결은 별도이며, 두 언어 실행 검증 상태는 현재 지문의 workflow-verification.json을 확인합니다.';
}
const modelTools = new Set('tokenizer tokens embedding reranking ner sentiment pose_estimation stt tts multimodal'.split(' '));
const configurationTools = new Set('content_credentials watermark rpa computer_use ocr'.split(' '));
const scopes = {
  ann:'정확 최근접 탐색 기준선입니다. 근사 탐색 엔진은 hnsw를 선택하세요.',
  semantic_search:'사용자가 제공한 벡터의 정확 코사인 검색입니다. 임베딩 생성은 별도 도구입니다.',
  object_detection:'임계값 연결 성분의 영역 탐지이며 의미 객체 분류 모델이 아닙니다.',
  image_segmentation:'Otsu 기반 분할이며 의미 분할 모델이 아닙니다.',
  object_tracking:'단일 템플릿 대응 범위이며 일반 다중 객체 추적이 아닙니다.',
  computer_vision:'영상의 수치 통계 계산 범위입니다.',
  speaker_diarization:'음향 프레임 군집이며 개인 화자 신원 확인을 제공하지 않습니다.',
  rpa:'제공한 HTML의 fill/check/read/count 작업만 수행합니다. JavaScript와 네트워크는 차단됩니다.',
  computer_use:'격리된 제공 HTML 조작 범위이며 일반 데스크톱 조작을 제공하지 않습니다.',
  content_credentials:'Flowly HMAC 형식의 출처 서명 확인이며 C2PA 호환 검증이 아닙니다.',
  watermark:'Flowly HMAC 형식의 표식 확인이며 모든 AI 생성물 탐지 기능이 아닙니다.',
  differential_privacy:'민감도와 단일 질의 예산을 명시한 스칼라 Laplace 처리입니다. 누적 개인정보 예산 관리는 별도입니다.',
  knowledge_graph:'제공된 관계를 깊이 제한 방향 탐색합니다. 자동 개체·관계 추출은 별도 모델 도구입니다.',
  redaction:'제한된 정규식 패턴을 가립니다. 모든 개인정보 탐지·익명성을 보증하지 않습니다.',
  anonymization:'패턴 기반 가림이며 재식별 불가능성을 보증하지 않습니다.',
  moderation:'명시한 금지 문구 검사이며 일반 의미 기반 안전성 분류가 아닙니다.',
};
const descriptions = {
  F01:'입력 레코드·텍스트의 형식을 검사하고 다음 단계에서 사용할 자료를 준비합니다.',
  F02:'검색용 표현·색인·순위를 계산합니다. 검색 점수만으로 사실 여부를 판정하지 않습니다.',
  F03:'명시적인 개체·관계·분석 결과와 근거를 반환합니다.',
  F04:'명시한 열과 설정에 따라 자료를 변환하고 변환 계약을 반환합니다.',
  F05:'학습·추론 입력을 구분해 지원하는 모델의 결과를 계산합니다.',
  F06:'자료를 군집 또는 축소 표현으로 변환합니다. 군집에 임의의 업무 의미를 붙이지 않습니다.',
  F07:'제공된 정답·예측·관측 자료로 평가 결과를 계산합니다.',
  F08:'기준 자료와 비교하여 이상·변화·불확실성의 관측값을 반환합니다.',
  F09:'입력 제약과 행렬·신호에 대한 결정적 수치 결과를 계산합니다.',
  F10:'입력 이미지의 처리 결과·좌표·영역 또는 구성한 로컬 모델의 관측 결과를 반환합니다.',
  F11:'설정한 로컬 엔진 또는 명시적 입력 자료로 음성·멀티모달 처리를 수행합니다.',
  F12:'지원하는 규칙·표준·설정 범위에서 민감정보와 콘텐츠를 검사합니다. 보안 보증을 대체하지 않습니다.',
  F13:'등록된 자동화 어댑터로 허용된 작업을 수행합니다. 임의 업로드 코드를 실행하지 않습니다.',
};
const toolFamilies=new Map(families.flatMap(([family,,,entries])=>entries.split(';').map(entry=>[entry.split('|')[0],family])));
function selectedToolIds(value) {
  if(!value||typeof value!=='object')return [];
  return [...(Array.isArray(value.pythonTools)?value.pythonTools:[]),...(value.program?.name==='python_tool'?[value.program.arguments?.toolId]:[]),...Object.values(value).flatMap(item=>Array.isArray(item)?item.flatMap(selectedToolIds):selectedToolIds(item))].filter(id=>typeof id==='string');
}
for(const example of examples) {
  const used=example.sourceIds.flatMap(id=>selectedToolIds(sourceDesigns.find(source=>source.id===id)?.definition));
  example.families=[...new Set([...example.families,...used.map(id=>toolFamilies.get(id)).filter(Boolean)])].sort();
}
const tools = families.flatMap(([family,,dependencyGroup, entries]) => entries.split(';').map(entry => {
  const [id,name] = entry.split('|');
  return {id,name,label:name,family,description:`${name}: ${scopes[id]??descriptions[family]}`,implementation:modelTools.has(id)?'model':'python',dependencyGroup,exampleIds:examples.filter(example=>example.families.includes(family)).map(example=>example.id),inputSchema:{type:'object',additionalProperties:true},effect:'read',status:modelTools.has(id)||configurationTools.has(id)?'configuration_required':'available'};
}));
const contracts=JSON.parse(fs.readFileSync(path.join(root,'export-runtime/tool-contracts.json'),'utf8'));
const contractList=Array.isArray(contracts)?contracts:Array.isArray(contracts.tools)?contracts.tools:Object.entries(contracts.tools).map(([id,contract])=>({id,...contract}));
for(const tool of tools) {
  const contract=contractList.find(item=>item.id===tool.id);
  if(!contract)throw new Error(`Python 실행 계약이 없습니다: ${tool.id}`);
  for(const field of ['inputSchema','exampleArguments','usage','dependencies','modelRequired','limits'])if(contract[field]!==undefined)tool[field]=contract[field];
  if(contract.modelRequired)tool.status='configuration_required';
}
for (const example of examples) example.toolIds = tools.filter(tool => tool.exampleIds.includes(example.id)).map(tool=>tool.id);
const expectedCounts=[5,14,3,25,31,24,29,10,12,25,6,9,2];
if (tools.length !== 195 || new Set(tools.map(tool=>tool.id)).size !== 195) throw new Error('195 distinct candidates required');
if (examples.length !== 100 || new Set(examples.map(example=>example.id)).size !== 100) throw new Error('100 unique planned examples required');
families.forEach(([id],index)=>{if(tools.filter(tool=>tool.family===id).length!==expectedCounts[index])throw new Error(`Unexpected ${id} count`)});
const catalog={version:1,source:'https://potato-ai.xyz/category/glossary/',classificationNote:'392개 제목 중 도구화 후보195개를 분류한 설계 목록. 도구ID는 등록 후보이며 실행 지원 범위는 Python dispatcher check 결과가 우선합니다. 기획100개는 소스 카탈로그와 별도 목록입니다.',families:families.map(([id,name,dependencyGroup])=>({id,name,dependencyGroup,count:tools.filter(tool=>tool.family===id).length})),tools,examples};
fs.writeFileSync(path.join(root,'domain/tool-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
const toolRows=tools.map(tool=>`| ${tool.family} | \`${tool.id}\` | ${tool.name} | ${tool.implementation==='model'?'로컬 모델 설정':'Python 도구'} | ${tool.exampleIds.join('·')} | ${tool.description} |`).join('\n');
fs.writeFileSync(path.join(root,'docs/TOOL_CANDIDATE_MAP.md'),`# 도구화 후보 195개 대응표\n\n생성 원본: \`scripts/build-tool-catalog.mjs\`, 실행 등록: \`export-runtime/flowly_tools.py\`. 목록을 추가했다고 의존성 설치·모델 연결·업무 예제 전체 구현이 완료되는 것은 아니다. 각 항목의 \`check\` 결과가 현재 실행 환경의 준비 상태다.\n\n기획 번호는 추천 연결이며 실제 워크플로에 195개 도구를 자동으로 넣거나 권한을 부여하지 않는다. 기술 제목의 범위보다 좁은 구현은 아래 설명에 명시한다.\n\n| 기능군 | ID | 항목 | 구현 방식 | 연결 기획 | 지원 범위 |\n|---|---|---|---|---|---|\n${toolRows}\n\n합계: ${tools.length}개, 기능군 ${families.length}개. 실제 모델·MCP 호출 검증과 구분한다.\n`);
const exampleRows=examples.map(example=>`| ${example.id} | ${example.title} | ${example.status} | ${example.sourceIds.map(id=>'\`'+id+'\`').join('<br>')||'직접 대응 없음'} | ${example.families.join('·')} | ${example.agentCriterionMet?'포함':'추가 필요'} | ${example.integrationScope} |`).join('\n');
fs.writeFileSync(path.join(root,'docs/EXAMPLE_100_IMPLEMENTATION_MAP.md'),`# 기획 100개와 공통 도구 대응표\n\n완료 상태는 로컬 실행 계약의 구현 범위입니다. 실모델 정답률이나 회사 시스템 연결 성공을 뜻하지 않습니다. 명시된 수용조건과 실패·대기 시나리오는 실제 내보낸 두 실행기로 별도 검증합니다.\n\n99개 기존 기획과 공유 상태 협업100을 합친 목록이다. 현재 소스의 ${sourceDesigns.length}개 설계와 다른 집합이며, 대표 경로를 기획 전체의 완성으로 세지 않는다. 기존99대응표는 역사적 기준을 보존한다. 이 표는 명시적 Agent 포함 기준을 추가 적용하며, 일반 모델 호출 노드·후보 탐색만으로 Agent 블록 조건을 충족한 것으로 간주하지 않는다.\n\n전체 후보 연결은 [195개 대응표](TOOL_CANDIDATE_MAP.md), 실제 연결 설정은 \`domain/tool-catalog.json\`을 따른다. 현재 전체 소스 실행 증거는 \`examples/workflow-verification.json\`에 기록한다. 문서 생성 자체는 실행 검증이 아니다.\n\n| 기획 | 제목 | 상태 | 관련 소스 | 기능군 | 명시적 Agent | 구현 범위·남은 작업 |\n|---|---|---|---|---|---|---|\n${exampleRows}\n\n총 ${examples.length}개 기획. 이번 통합 도구 대표 경로는 ${examples.filter(example=>example.integrationStatus==='representative_implemented').length}개 기획에 연결했다. 상태는 실제 모델 정답률·사내 MCP·운영 배포 검증 완료를 뜻하지 않는다.\n`);
const completionRows = examples.map(item => `| ${item.id} | ${item.title} | ${item.status} | ${item.requirement} | ${(item.acceptance ?? []).join('<br>') || '기존 실행 계약'} | ${item.sourceIds.map(id => '`'+id+'`').join('<br>')} | ${(item.remainingSetup ?? ['.env 모델 및 선택한 사내 연결']).join('<br>')} |`).join('\n');
fs.writeFileSync(path.join(root, 'docs/EXAMPLE_100_ACCEPTANCE_SPEC.md'), `# 100개 예제 통합 수용 명세\n\n원래 기획 요구를 보존하고, 고유 워크플로의 실제 계산·입력·분기·상태 변화와 대응한다. ‘원래 요구’ 열은 당시 기획 설명을 보존한 것으로 과거의 미구현 표현을 포함할 수 있다. 현재 제공 범위는 ‘구현 상태’와 ‘검증할 수용조건’ 열을 기준으로 확인한다. 예제의 Agent 응답은 검증에서만 경계 대역으로 공급하며, 프로그램 계산·체크포인트·승인·재개·내보내기 파일은 제품 코드를 실행한다. AI_PROMPT.md·AGENTS.md·Skill은 같은 workflow.json에서 생성된다. 실제 서비스 호출은 하지 않는다.\n\n| 번호 | 예제 | 구현 상태 | 원래 요구 | 검증할 수용조건 | 소스 | 사용자 설정 |\n|---|---|---|---|---|---|---|\n${completionRows}\n`);
console.log(`Generated ${tools.length} candidates, ${families.length} families, ${examples.length} planned examples; ${completions.length} completed acceptance mappings`);
