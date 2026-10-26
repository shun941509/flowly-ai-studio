# 수치/통계/전처리/학습 도구팩. 로컬 의존성을 지연 로드하고 모수와 자료 크기를 제한한다.
"""Bounded scientific algorithms. Scientific dependencies are loaded per tool.

Model state is an explicit, versioned JSON training recipe, never pickle. A
predict/transform request reconstructs the fitted estimator from training data;
the evaluation batch is never used to fit. No supplied Python classes execute.
"""
from __future__ import annotations
import collections
import hashlib
import json
import math

from flowly_tools import array, dependency, fail, integer, matrix, number, text


PREPROCESS=set("feature_selection feature_binarization feature_discretization label_encoding frequency_encoding ordinal_encoding target_encoding feature_hashing whitening quantile_transform power_transform maxabs_scaling robust_scaling standard_scaling minmax_scaling l1_normalization l2_normalization feature_engineering imputation onehot_encoding synthetic_data features data_augmentation data_labeling".split())
ESTIMATORS={
    "perceptron":("linear_model","Perceptron"),"pls":("cross_decomposition","PLSRegression"),
    "ard":("linear_model","ARDRegression"),"omp":("linear_model","OrthogonalMatchingPursuit"),
    "nearest_centroid":("neighbors","NearestCentroid"),"theil_sen":("linear_model","TheilSenRegressor"),
    "qda":("discriminant_analysis","QuadraticDiscriminantAnalysis"),"extra_trees":("ensemble","ExtraTreesClassifier"),
    "bayesian_ridge":("linear_model","BayesianRidge"),"elastic_net":("linear_model","ElasticNet"),
    "poisson_regression":("linear_model","PoissonRegressor"),"quantile_regression":("linear_model","QuantileRegressor"),
    "huber_regression":("linear_model","HuberRegressor"),"gaussian_process":("gaussian_process","GaussianProcessRegressor"),
    "gradient_boosting":("ensemble","GradientBoostingClassifier"),"adaboost":("ensemble","AdaBoostClassifier"),
    "decision_tree":("tree","DecisionTreeClassifier"),"lda":("discriminant_analysis","LinearDiscriminantAnalysis"),
    "knn":("neighbors","KNeighborsClassifier"),"logistic_regression":("linear_model","LogisticRegression"),
    "naive_bayes":("naive_bayes","GaussianNB"),"svm":("svm","SVC"),"random_forest":("ensemble","RandomForestClassifier"),
    "regression":("linear_model","LinearRegression"),"classification":("linear_model","LogisticRegression"),
    "ransac":("linear_model","RANSACRegressor"),
}
CLUSTER={
    "kmeans":("cluster","KMeans"),"clustering":("cluster","KMeans"),"birch":("cluster","Birch"),
    "hdbscan":("cluster","HDBSCAN"),"optics":("cluster","OPTICS"),"affinity_propagation":("cluster","AffinityPropagation"),
    "mean_shift":("cluster","MeanShift"),"spectral_clustering":("cluster","SpectralClustering"),
    "hierarchical_clustering":("cluster","AgglomerativeClustering"),"gmm":("mixture","GaussianMixture"),
    "dbscan":("cluster","DBSCAN"),
}
REDUCE={
    "sparse_pca":("decomposition","SparsePCA"),"kernel_pca":("decomposition","KernelPCA"),
    "random_projection":("random_projection","GaussianRandomProjection"),"factor_analysis":("decomposition","FactorAnalysis"),
    "lle":("manifold","LocallyLinearEmbedding"),"isomap":("manifold","Isomap"),"cca":("cross_decomposition","CCA"),
    "tsne":("manifold","TSNE"),"ica":("decomposition","FastICA"),"nmf":("decomposition","NMF"),
    "svd":("decomposition","TruncatedSVD"),"pca":("decomposition","PCA"),
}
METRICS={
    "hamming_loss":"hamming_loss","average_precision":"average_precision_score","brier_score":"brier_score_loss",
    "cohen_kappa":"cohen_kappa_score","mcc":"matthews_corrcoef","balanced_accuracy":"balanced_accuracy_score",
    "pair_confusion_matrix":"pair_confusion_matrix","contingency_matrix":"contingency_matrix",
    "fowlkes_mallows":"fowlkes_mallows_score","adjusted_mutual_info":"adjusted_mutual_info_score",
    "v_measure":"v_measure_score","adjusted_rand":"adjusted_rand_score","calinski_harabasz":"calinski_harabasz_score",
    "davies_bouldin":"davies_bouldin_score","silhouette":"silhouette_score","roc_auc":"roc_auc_score",
    "recall":"recall_score","precision":"precision_score","f1":"f1_score","accuracy":"accuracy_score","confusion_matrix":"confusion_matrix",
}
SIGNAL=set("fft dct hungarian dtw kalman hessenberg schur lu qr cholesky eigen".split())
OTHER=set("scalar_quantization product_quantization ivf_flat ann causal_inference time_series_forecast recommender ab_test cross_validation feature_importance xai conformal_prediction lof isolation_forest kde ood anomaly_detection data_drift calibration model_drift".split())
SCIENTIFIC={key:["numpy","sklearn"] for key in PREPROCESS|set(ESTIMATORS)|set(CLUSTER)|set(REDUCE)|set(METRICS)|OTHER}
SCIENTIFIC.update({key:["numpy","scipy"] for key in SIGNAL})
SCIENTIFIC.update({"dwt":["numpy","pywt"],"hnsw":["numpy","hnswlib"],"umap":["numpy","umap"],"crf":["sklearn_crfsuite"],"hmm":["numpy","hmmlearn"]})


def clean(value):
    if hasattr(value,"tolist"): return clean(value.tolist())
    if isinstance(value,dict): return {str(k):clean(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)): return [clean(v) for v in value]
    if isinstance(value,complex): return {"real":value.real,"imag":value.imag}
    if isinstance(value,float) and not math.isfinite(value): fail("자료 조건으로 인해 유한한 계산 결과를 얻지 못했어요.")
    if isinstance(value,float) and value==0:return 0
    return value


def params(args,allowed):
    config=args.get("params",{})
    if not isinstance(config,dict) or any(k not in allowed for k in config): fail("이 도구에 허용되지 않은 모수예요.")
    for key,val in config.items():
        if key in {"n_estimators","max_iter","max_trials","n_quantiles"}: integer(val,1,500)
        elif key in {"n_components","n_clusters","n_neighbors","n_features","degree","max_depth","min_samples","min_cluster_size","n_nonzero_coefs"}: integer(val,1,100)
        elif key=="perplexity":
            if not 1<=number(val)<=100: fail("perplexity는 1~100이에요.")
        elif key in {"alpha","eps","threshold","C","quantile","l1_ratio","reg_param","bandwidth"}: number(val)
    return config


# 등록 sklearn 클래스만 선택하고 기본 seed/단일 작업자를 고정한다. 사용자 클래스는 로드하지 않는다.
def make_estimator(tool_id,config):
    mod,name=ESTIMATORS[tool_id]
    cls=getattr(dependency("sklearn."+mod,"scikit-learn"),name)
    allowed={"alpha","n_estimators","max_iter","max_depth","n_neighbors","n_components","n_nonzero_coefs","quantile","l1_ratio","reg_param","C","max_trials"}
    config=params({"params":config},allowed)
    defaults={}
    available=cls().get_params()
    if "random_state" in available: defaults["random_state"]=0
    if "n_jobs" in available: defaults["n_jobs"]=1
    if "n_estimators" in available: defaults["n_estimators"]=30
    if "max_iter" in available: defaults["max_iter"]=300
    if tool_id=="knn": defaults["n_neighbors"]=3
    if tool_id=="pls": defaults["n_components"]=1
    return cls(**{**defaults,**config})


# 상태는 pickle 대신 버전 있는 학습 자료/모수 JSON이다. predict는 저장 학습 자료로 재구성하며 평가 data로 학습하지 않는다.
def model(tool_id,args):
    operation=args.get("operation","fit_predict")
    if operation not in {"fit","predict","fit_predict"}: fail("모델 동작은 fit/predict/fit_predict예요.")
    config=args.get("params",{})
    training=args.get("trainingData"); labels=args.get("trainingLabels")
    if operation=="predict":
        state=args.get("state")
        if not isinstance(state,dict) or state.get("version")!=1 or state.get("toolId")!=tool_id: fail("같은 도구로 만든 version 1 모델 상태가 필요해요.")
        training=state.get("trainingData"); labels=state.get("trainingLabels"); config=state.get("params",{})
    training=matrix(training)
    labels=array(labels,maximum=1000)
    if len(training)!=len(labels): fail("학습 행과 정답의 수가 달라요.")
    if any(isinstance(x,(dict,list)) or x is None for x in labels): fail("학습 정답은 숫자·문자열 값이어야 해요.")
    estimator=make_estimator(tool_id,config)
    estimator.fit(training,labels)
    state={"version":1,"toolId":tool_id,"params":config,"trainingData":training,"trainingLabels":labels}
    result={"state":state,"stateFormat":"json_training_recipe","trainingRows":len(training)}
    if operation!="fit":
        data=matrix(args.get("data"))
        if len(data[0])!=len(training[0]): fail("학습 자료와 예측 자료의 열 수가 달라요.")
        result["predictions"]=clean(estimator.predict(data))
        if hasattr(estimator,"predict_proba"): result["probabilities"]=clean(estimator.predict_proba(data))
    return result


# 전처리 종류별 학습/변환 자료를 구분한다. 출력 상태 의미는 해당 알고리즘 분기를 확인한다.
def preprocess(tool_id,args):
    np=dependency("numpy")
    if tool_id=="data_labeling":
        records=array(args.get("records"),0,1000); labels=array(args.get("labels"),0,1000)
        if len(records)!=len(labels): fail("자료와 라벨 수가 달라요.")
        return {"records":[{"value":value,"label":label} for value,label in zip(records,labels)],"method":"provided_labels"}
    if tool_id=="synthetic_data":
        count=integer(args.get("count",100),1,1000); columns=integer(args.get("columns",2),1,32)
        mean=number(args.get("mean",0)); std=number(args.get("std",1))
        if std<0: fail("표준편차는 0 이상이어야 해요.")
        return {"data":clean(np.random.default_rng(integer(args.get("seed",0),0,2**31-1)).normal(mean,std,(count,columns))),"method":"independent_gaussian","preservesRealDistribution":False}
    if tool_id in {"frequency_encoding","label_encoding","ordinal_encoding","onehot_encoding","target_encoding","feature_hashing"}:
        training=array(args.get("trainingData"),maximum=1000); data=array(args.get("data",training),maximum=1000)
        if any(not isinstance(x,(str,int,float,bool)) for x in training+data): fail("범주 입력은 1차원 값 목록이어야 해요.")
        training=[str(x) for x in training]; data=[str(x) for x in data]
        categories=sorted(set(training)); mapping={value:index for index,value in enumerate(categories)}
        if tool_id=="feature_hashing":
            width=integer(args.get("nFeatures",16),1,128)
            result=[]
            for value in data:
                digest=hashlib.sha256(value.encode()).digest(); row=[0]*width; row[int.from_bytes(digest[:4],"big")%width]=1 if digest[4]%2 else -1; result.append(row)
            return {"data":result,"hash":"sha256","nFeatures":width}
        if tool_id=="frequency_encoding":
            counts=collections.Counter(training); values=[counts.get(x,0)/len(training) for x in data]
        elif tool_id=="target_encoding":
            labels=[number(x) for x in array(args.get("trainingLabels"),maximum=1000)]
            if len(labels)!=len(training): fail("학습 범주와 정답 수가 달라요.")
            # Require a separate transform batch; no target leakage into training output.
            if "data" not in args: fail("타깃 인코딩에는 별도의 data 변환 배치가 필요해요.")
            groups=collections.defaultdict(list)
            for value,label in zip(training,labels): groups[value].append(label)
            overall=sum(labels)/len(labels); means={key:sum(vals)/len(vals) for key,vals in groups.items()}
            values=[means.get(x,overall) for x in data]
        elif tool_id=="onehot_encoding": values=[[int(value==category) for category in categories] for value in data]
        else: values=[mapping.get(value,-1) for value in data]
        return {"data":values,"categories":categories,"unknownCount":sum(x not in mapping for x in data)}
    operation=args.get("operation","fit_transform")
    if operation not in {"fit","transform","fit_transform"}: fail("전처리 동작은 fit/transform/fit_transform예요.")
    training=args.get("trainingData",args.get("data")); config=args.get("params",{})
    if operation=="transform":
        state=args.get("state")
        if not isinstance(state,dict) or state.get("version")!=1 or state.get("toolId")!=tool_id: fail("같은 도구의 전처리 상태가 필요해요.")
        training=state.get("trainingData"); config=state.get("params",{})
    if tool_id=="imputation":
        rows=array(training,maximum=1000); width=len(array(rows[0],maximum=128))
        for row in rows:
            if not isinstance(row,list) or len(row)!=width: fail("입력 열 수가 달라요.")
            for val in row:
                if val is not None: number(val)
        transformer=dependency("sklearn.impute").SimpleImputer(strategy="median",keep_empty_features=True)
        source=np.asarray([[np.nan if x is None else x for x in row] for row in rows])
        target=args.get("data",training)
        if not isinstance(target,list) or any(not isinstance(row,list) or len(row)!=width for row in target): fail("변환 자료 열 수를 확인해 주세요.")
        for row in target:
            for val in row:
                if val is not None:number(val)
        target=np.asarray([[np.nan if x is None else x for x in row] for row in target])
    else:
        source=np.asarray(matrix(training),dtype=float); target=np.asarray(matrix(args.get("data",training)),dtype=float)
        if source.shape[1]!=target.shape[1]: fail("학습 자료와 변환 자료의 열 수가 달라요.")
        pp=dependency("sklearn.preprocessing")
        config=params({"params":config},{"threshold","degree","n_quantiles","bins"})
        if tool_id=="feature_discretization":
            config={**config,"bins":integer(config.get("bins",args.get("bins",5)),2,20)}
        if tool_id in {"features","feature_engineering"}:
            degree=integer(config.get("degree",2),1,3)
            if math.comb(source.shape[1]+degree,degree)>4096:fail("다항 특징 출력은 4,096개 열 이하여야 해요.")
        constructors={
            "feature_binarization":lambda:pp.Binarizer(threshold=config.get("threshold",0)),
            "feature_discretization":lambda:pp.KBinsDiscretizer(n_bins=config["bins"],encode="ordinal",strategy="quantile",subsample=None),
            "quantile_transform":lambda:pp.QuantileTransformer(n_quantiles=min(config.get("n_quantiles",100),len(source)),random_state=0),
            "power_transform":lambda:pp.PowerTransformer(),"maxabs_scaling":lambda:pp.MaxAbsScaler(),
            "robust_scaling":lambda:pp.RobustScaler(),"standard_scaling":lambda:pp.StandardScaler(),"minmax_scaling":lambda:pp.MinMaxScaler(),
            "l1_normalization":lambda:pp.Normalizer(norm="l1"),"l2_normalization":lambda:pp.Normalizer(norm="l2"),
            "feature_engineering":lambda:pp.PolynomialFeatures(degree=config.get("degree",2),include_bias=False),
            "features":lambda:pp.PolynomialFeatures(degree=config.get("degree",2),include_bias=False),
            "whitening":lambda:dependency("sklearn.decomposition").PCA(whiten=True,random_state=0),
            "feature_selection":lambda:dependency("sklearn.feature_selection").VarianceThreshold(threshold=config.get("threshold",0)),
        }
        if tool_id=="data_augmentation":
            sigma=number(args.get("sigma",0.01))
            if not 0<=sigma<=1000: fail("증강 잡음 크기는 0~1000이에요.")
            return {"data":clean(target+np.random.default_rng(integer(args.get("seed",0),0,2**31-1)).normal(0,sigma,target.shape)),"method":"numeric_gaussian_jitter"}
        transformer=constructors[tool_id]()
    transformer.fit(source)
    state={"version":1,"toolId":tool_id,"trainingData":training,"params":config}
    result={"state":state,"stateFormat":"json_training_recipe"}
    if operation!="fit": result["data"]=clean(transformer.transform(target))
    return result


def cluster_reduce(tool_id,args):
    np=dependency("numpy");data=np.asarray(matrix(args.get("data")),dtype=float)
    config=params(args,{"n_components","n_clusters","n_neighbors","eps","min_samples","min_cluster_size","perplexity","max_iter","bandwidth"})
    if tool_id=="umap": cls=dependency("umap","umap-learn").UMAP
    else:
        mod,name=(CLUSTER if tool_id in CLUSTER else REDUCE)[tool_id]
        module=dependency("sklearn."+mod)
        if not hasattr(module,name): fail(f"설치된 scikit-learn 버전에서 {name}을 지원하지 않아요.","missing_dependency")
        cls=getattr(module,name)
    defaults={}; available=cls().get_params()
    if "random_state" in available: defaults["random_state"]=0
    if "n_jobs" in available: defaults["n_jobs"]=1
    if "n_clusters" in available: defaults["n_clusters"]=min(2,len(data))
    if "n_components" in available: defaults["n_components"]=min(2,len(data[0]),len(data))
    if "n_neighbors" in available: defaults["n_neighbors"]=min(5,max(1,len(data)-1))
    if tool_id=="tsne": defaults.update(perplexity=min(5,max(1,len(data)-1)),init="random")
    estimator=cls(**{**defaults,**config})
    if tool_id in CLUSTER:
        result={"labels":clean(estimator.fit_predict(data))}
        if hasattr(estimator,"cluster_centers_"): result["centers"]=clean(estimator.cluster_centers_)
        return result
    if tool_id=="cca":
        targets=matrix(args.get("targets"))
        if len(targets)!=len(data): fail("CCA의 두 자료 행 수가 달라요.")
        x,y=estimator.fit_transform(data,targets)
        return {"data":clean(x),"targets":clean(y)}
    transformed=estimator.fit_transform(data)
    result={"data":clean(transformed)}
    if hasattr(estimator,"explained_variance_ratio_"): result["explainedVarianceRatio"]=clean(estimator.explained_variance_ratio_)
    return result


def metric(tool_id,args):
    if tool_id in {"pair_confusion_matrix","contingency_matrix"}: module=dependency("sklearn.metrics.cluster")
    else: module=dependency("sklearn.metrics")
    kwargs={}
    if tool_id in {"recall","precision","f1"}: kwargs.update(average="macro",zero_division=0)
    if tool_id in {"calinski_harabasz","davies_bouldin","silhouette"}:
        first=matrix(args.get("data")); second=array(args.get("labels"),maximum=1000)
    else:
        first=array(args.get("expected"),maximum=2000); second=array(args.get("actual"),maximum=2000)
    if len(first)!=len(second): fail("평가 대상과 기준의 수가 달라요.")
    score=getattr(module,METRICS[tool_id])(first,second,**kwargs)
    return {"value":clean(score),"metric":tool_id}


def signal(tool_id,args):
    np=dependency("numpy")
    if tool_id in {"fft","dct","dwt"}:
        values=np.asarray([number(x) for x in array(args.get("values"),maximum=4096)])
        if tool_id=="dwt":
            wavelet=args.get("wavelet","haar")
            if wavelet not in {"haar","db2","db4","sym2"}: fail("지원하는 웨이블릿은 haar/db2/db4/sym2예요.")
            a,d=dependency("pywt","PyWavelets").dwt(values,wavelet)
            return {"approximation":clean(a),"detail":clean(d),"wavelet":wavelet}
        if tool_id=="dct": return {"values":clean(dependency("scipy.fft").dct(values,norm="ortho"))}
        result=dependency("scipy.fft").fft(values)
        return {"real":clean(result.real),"imag":clean(result.imag),"magnitudes":clean(np.abs(result))}
    if tool_id=="hungarian":
        costs=np.asarray(matrix(args.get("costs")))
        rows,cols=dependency("scipy.optimize").linear_sum_assignment(costs)
        return {"assignments":[{"row":int(row),"column":int(col),"cost":float(costs[row,col])} for row,col in zip(rows,cols)],"totalCost":float(costs[rows,cols].sum())}
    if tool_id=="dtw":
        a=[number(x) for x in array(args.get("a"),maximum=1000)]; b=[number(x) for x in array(args.get("b"),maximum=1000)]
        prev=[float("inf")]* (len(b)+1);prev[0]=0
        for x in a:
            current=[float("inf")]
            for j,y in enumerate(b,1): current.append(abs(x-y)+min(prev[j],current[j-1],prev[j-1]))
            prev=current
        return {"distance":prev[-1],"localCost":"absolute"}
    if tool_id=="kalman":
        observations=[number(x) for x in array(args.get("values"))]
        q=number(args.get("processVariance",1e-5));r=number(args.get("measurementVariance",0.1))
        if q<0 or r<=0: fail("분산은 process>=0, measurement>0이어야 해요.")
        mean=number(args.get("initialMean",observations[0])); variance=number(args.get("initialVariance",1))
        if variance<0: fail("초기 분산은 0 이상이어야 해요.")
        results=[]
        for observation in observations:
            variance+=q;gain=variance/(variance+r);mean+=gain*(observation-mean);variance*=1-gain;results.append({"mean":mean,"variance":variance})
        return {"states":results,"model":"scalar_random_walk"}
    data=np.asarray(matrix(args.get("matrix")))
    if data.shape[0]!=data.shape[1] and tool_id not in {"qr","lu"}: fail("정방 행렬이 필요해요.")
    la=dependency("scipy.linalg")
    if tool_id=="eigen":
        vals,vecs=la.eig(data);return {"values":clean(vals),"vectors":clean(vecs)}
    if tool_id=="cholesky":return {"lower":clean(la.cholesky(data,lower=True))}
    if tool_id=="hessenberg":
        h,q=la.hessenberg(data,calc_q=True);return {"h":clean(h),"q":clean(q)}
    if tool_id=="schur":
        t,z=la.schur(data);return {"t":clean(t),"z":clean(z)}
    if tool_id=="lu":
        p,l,u=la.lu(data);return {"p":clean(p),"l":clean(l),"u":clean(u)}
    q,r=la.qr(data);return {"q":clean(q),"r":clean(r)}


def extended(tool_id,args):
    np=dependency("numpy")
    if tool_id in {"ann","hnsw","ivf_flat","product_quantization","scalar_quantization"}:
        data=np.asarray(matrix(args.get("data")),dtype=float)
        if tool_id=="scalar_quantization":
            bits=integer(args.get("bits",8),1,16);lo=data.min(axis=0);hi=data.max(axis=0);scale=np.where(hi>lo,(hi-lo)/(2**bits-1),1)
            quant=np.rint((data-lo)/scale).astype(int)
            return {"codes":clean(quant),"minimum":clean(lo),"scale":clean(scale),"reconstructed":clean(quant*scale+lo),"bits":bits}
        if tool_id=="product_quantization":
            pieces=integer(args.get("subspaces",2),1,data.shape[1]); k=integer(args.get("clusters",min(4,len(data))),1,min(64,len(data)))
            model_cls=dependency("sklearn.cluster").KMeans;chunks=np.array_split(data,pieces,axis=1);codes=[];books=[];reconstructed=[]
            for chunk in chunks:
                m=model_cls(n_clusters=k,random_state=0,n_init=10).fit(chunk); codes.append(m.labels_);books.append(m.cluster_centers_);reconstructed.append(m.cluster_centers_[m.labels_])
            return {"codes":clean(np.column_stack(codes)),"codebooks":clean(books),"reconstructed":clean(np.column_stack(reconstructed))}
        query=np.asarray(matrix(args.get("queries")),dtype=float)
        if query.shape[1]!=data.shape[1]: fail("질의 벡터 차원이 달라요.")
        k=integer(args.get("topK",min(5,len(data))),1,len(data))
        if tool_id=="hnsw":
            index=dependency("hnswlib").Index(space="l2",dim=data.shape[1]);index.init_index(max_elements=len(data),ef_construction=100,M=16,random_seed=0);index.set_num_threads(1);index.add_items(data);index.set_ef(max(k,50));labels,dist=index.knn_query(query,k=k)
            return {"indices":clean(labels),"distances":clean(dist),"metric":"squared_l2"}
        if tool_id=="ivf_flat":
            clusters=integer(args.get("clusters",min(4,len(data))),1,len(data));m=dependency("sklearn.cluster").KMeans(n_clusters=clusters,random_state=0,n_init=10).fit(data)
            probes=integer(args.get("probes",1),1,clusters);indices=[];distances=[]
            for q in query:
                chosen=np.argsort(((m.cluster_centers_-q)**2).sum(axis=1))[:probes];ids=np.flatnonzero(np.isin(m.labels_,chosen));ds=((data[ids]-q)**2).sum(axis=1);order=np.argsort(ds)[:k];indices.append(ids[order]);distances.append(ds[order])
            return {"indices":clean(indices),"distances":clean(distances),"metric":"squared_l2","approximate":True}
        model=dependency("sklearn.neighbors").NearestNeighbors(n_neighbors=k,algorithm="auto").fit(data);ds,ids=model.kneighbors(query)
        return {"indices":clean(ids),"distances":clean(ds),"method":"exact_nearest_neighbors_baseline","approximate":False}
    if tool_id in {"lof","isolation_forest","kde","ood","anomaly_detection"}:
        training=np.asarray(matrix(args.get("trainingData")),dtype=float);data=np.asarray(matrix(args.get("data")),dtype=float)
        if training.shape[1]!=data.shape[1]:fail("기준 자료와 검사 자료의 열 수가 달라요.")
        if tool_id in {"isolation_forest","anomaly_detection"}:
            m=dependency("sklearn.ensemble").IsolationForest(random_state=0,n_estimators=50,n_jobs=1).fit(training)
            return {"scores":clean(m.decision_function(data)),"predictions":clean(m.predict(data)),"inlier":1,"outlier":-1}
        if tool_id=="lof":
            m=dependency("sklearn.neighbors").LocalOutlierFactor(novelty=True,n_neighbors=min(20,len(training)-1)).fit(training)
            return {"scores":clean(m.decision_function(data)),"predictions":clean(m.predict(data)),"inlier":1,"outlier":-1}
        if tool_id=="kde":
            bandwidth=number(args.get("bandwidth",1))
            if bandwidth<=0:fail("bandwidth는 0보다 커야 해요.")
            m=dependency("sklearn.neighbors").KernelDensity(bandwidth=bandwidth).fit(training)
            return {"logDensity":clean(m.score_samples(data))}
        mean=training.mean(axis=0);std=training.std(axis=0);scale=np.where(std>0,std,1);scores=np.max(abs((data-mean)/scale),axis=1);threshold=number(args.get("threshold",3))
        if threshold<=0:fail("OOD 임계값은 0보다 커야 해요.")
        return {"scores":clean(scores),"outOfDistribution":clean(scores>threshold),"method":"max_absolute_zscore","threshold":threshold}
    if tool_id in {"data_drift","model_drift"}:
        reference=[number(x) for x in array(args.get("reference"))];current=[number(x) for x in array(args.get("current"))]
        alpha=number(args.get("alpha",0.05))
        if not 0<alpha<1:fail("유의 수준은 0~1 사이여야 해요.")
        statistic,p=dependency("scipy.stats").ks_2samp(reference,current)
        return {"statistic":float(statistic),"pValue":float(p),"driftDetected":bool(p<alpha),"method":"two_sample_ks","scope":"provided_values","modelQualityMeasured":False}
    if tool_id=="calibration":
        scores=[number(x) for x in array(args.get("trainingScores"))];labels=[number(x) for x in array(args.get("trainingLabels"))];new=[number(x) for x in array(args.get("scores"))]
        if len(scores)!=len(labels) or any(x not in (0,1) for x in labels) or any(not 0<=x<=1 for x in scores+new):fail("보정에는 같은 수의 확률·이진 정답이 필요해요.")
        m=dependency("sklearn.isotonic").IsotonicRegression(out_of_bounds="clip").fit(scores,labels)
        return {"probabilities":clean(m.predict(new)),"method":"isotonic","trainingRows":len(scores)}
    if tool_id=="conformal_prediction":
        expected=np.array([number(x) for x in array(args.get("calibrationExpected"))]);pred=np.array([number(x) for x in array(args.get("calibrationPredicted"))]);new=np.array([number(x) for x in array(args.get("predictions"))]);alpha=number(args.get("alpha",0.1))
        if len(expected)!=len(pred) or not 0<alpha<1:fail("보정 자료 수와 alpha(0,1)를 확인해 주세요.")
        level=math.ceil((len(expected)+1)*(1-alpha))/len(expected)
        if level>1:fail("요청한 보장 수준에 필요한 보정 자료가 부족해요.")
        q=float(np.quantile(abs(expected-pred),level,method="higher"))
        return {"intervals":[{"lower":float(x-q),"upper":float(x+q)} for x in new],"radius":q,"alpha":alpha,"assumption":"exchangeable_calibration_and_test_data"}
    if tool_id=="ab_test":
        a=[number(x) for x in array(args.get("a"),2)];b=[number(x) for x in array(args.get("b"),2)]
        result=dependency("scipy.stats").ttest_ind(a,b,equal_var=False)
        return {"statistic":clean(float(result.statistic)),"pValue":clean(float(result.pvalue)),"meanDifference":sum(b)/len(b)-sum(a)/len(a),"method":"welch_t_test","assumption":"independent_samples"}
    if tool_id=="causal_inference":
        if args.get("randomizedTreatment") is not True:fail("이 도구는 무작위 배정 실험의 평균 차이만 지원해요. randomizedTreatment 확인이 필요해요.","missing_configuration")
        result=extended("ab_test",args)
        return {**result,"estimand":"randomized_difference_in_means","causalAssumptionsVerified":False}
    if tool_id=="time_series_forecast":
        values=[number(x) for x in array(args.get("values"),2,1000)];steps=integer(args.get("steps",5),1,100)
        slope,intercept=np.polyfit(np.arange(len(values)),values,1)
        return {"predictions":clean(intercept+slope*np.arange(len(values),len(values)+steps)),"method":"linear_trend_baseline","confidenceInterval":None}
    if tool_id=="recommender":
        interactions=np.asarray(matrix(args.get("ratings")),dtype=float);user=integer(args.get("user"),0,len(interactions)-1)
        norms=np.linalg.norm(interactions,axis=1);similarities=(interactions@interactions[user])/np.maximum(norms*norms[user],1e-12);similarities[user]=0;denominator=max(float(abs(similarities).sum()),1e-12);scores=similarities@interactions/denominator
        candidates=[{"item":i,"score":float(score)} for i,score in enumerate(scores) if interactions[user,i]==0]
        return {"recommendations":sorted(candidates,key=lambda x:(-x["score"],x["item"]))[:integer(args.get("topK",5),1,100)],"method":"user_cosine_collaborative_filtering","missingRating":0}
    if tool_id in {"cross_validation","feature_importance","xai"}:
        tool=args.get("estimator","random_forest")
        if tool not in ESTIMATORS:fail("허용된 추정기를 선택해 주세요.")
        data=matrix(args.get("trainingData"));labels=array(args.get("trainingLabels"),maximum=1000)
        if len(data)!=len(labels):fail("학습 자료와 정답 수가 달라요.")
        m=make_estimator(tool,args.get("params",{}))
        if tool_id=="cross_validation":
            folds=integer(args.get("folds",3),2,min(10,len(data)));scores=dependency("sklearn.model_selection").cross_val_score(m,data,labels,cv=folds,n_jobs=1)
            return {"scores":clean(scores),"mean":float(scores.mean()),"estimator":tool}
        m.fit(data,labels)
        validation=matrix(args.get("validationData"));expected=array(args.get("validationLabels"),maximum=1000)
        if len(validation)!=len(expected):fail("검증 자료와 정답 수가 달라요.")
        result=dependency("sklearn.inspection").permutation_importance(m,validation,expected,n_repeats=5,random_state=0,n_jobs=1)
        return {"mean":clean(result.importances_mean),"std":clean(result.importances_std),"method":"heldout_permutation_importance","explains":"prediction_score_change"}
    if tool_id=="hmm":
        data=matrix(args.get("trainingData"));query=matrix(args.get("data"));states=integer(args.get("states",2),1,20)
        m=dependency("hmmlearn.hmm","hmmlearn").GaussianHMM(n_components=states,n_iter=100,random_state=0).fit(data)
        return {"states":clean(m.predict(query)),"logLikelihood":float(m.score(query)),"transitionMatrix":clean(m.transmat_)}
    if tool_id=="crf":
        sequences=array(args.get("trainingData"),maximum=100);labels=array(args.get("trainingLabels"),maximum=100);data=array(args.get("data"),maximum=100)
        if len(sequences)!=len(labels):fail("CRF 학습 시퀀스와 정답 수가 달라요.")
        for index,sequence in enumerate(sequences+data):
            array(sequence,maximum=100)
            if any(not isinstance(token,dict) or any(not isinstance(v,(str,int,float,bool)) for v in token.values()) for token in sequence):fail("CRF 토큰은 단순 특징 객체여야 해요.")
            if index<len(sequences) and len(sequence)!=len(array(labels[index],maximum=100)):fail("CRF 토큰과 정답 수가 달라요.")
        m=dependency("sklearn_crfsuite").CRF(max_iterations=100,all_possible_transitions=True);m.fit(sequences,labels)
        return {"labels":m.predict(data)}
    fail("지원하지 않는 과학 계산 도구예요.")


# ID를 알고리즘에 매핑한다. 넓은 용어는 기준선/별칭일 수 있으므로 describe_tools의 scope도 확인한다.
def execute_scientific(tool_id,args):
    if tool_id in PREPROCESS:return preprocess(tool_id,args)
    if tool_id in ESTIMATORS:return model(tool_id,args)
    if tool_id in CLUSTER or tool_id in REDUCE or tool_id=="umap":return cluster_reduce(tool_id,args)
    if tool_id in METRICS:return metric(tool_id,args)
    if tool_id in SIGNAL or tool_id=="dwt":return signal(tool_id,args)
    return extended(tool_id,args)
