"""Actual local algorithm and negative-boundary checks; no model or MCP service."""
import hashlib
import hmac
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"export-runtime"))
from flowly_tools import ToolError,check_tools,describe_tools,execute_tool,registry


class CoreToolTests(unittest.TestCase):
    def test_exact_catalog_registration(self):
        catalog=json.loads((ROOT/"domain/tool-catalog.json").read_text(encoding="utf8"))
        self.assertEqual({x["id"] for x in catalog["tools"]},registry())
        self.assertEqual(len(registry()),195)
        self.assertTrue(all(x["effect"]=="read" for x in describe_tools()))

    def test_jsonl_preserves_records_and_reports_invalid_line(self):
        self.assertEqual(execute_tool("jsonl",{"text":'{"a":1}\n\n{"a":2}'})["records"],[{"a":1},{"a":2}])
        with self.assertRaisesRegex(ToolError,"2행"):execute_tool("jsonl",{"text":'{}\n{broken}'})

    def test_chunking_unicode_offsets_and_overlap(self):
        result=execute_tool("chunking",{"text":"가나다라마","size":3,"overlap":1})
        self.assertEqual(result["chunks"],[{"id":"0","start":0,"end":3,"text":"가나다"},{"id":"1","start":2,"end":5,"text":"다라마"}])
        with self.assertRaises(ToolError):execute_tool("chunking",{"text":"abc","size":1,"overlap":1})

    def test_retrieval_actual_rank_changes_with_query(self):
        docs=[{"id":"policy","text":"회의실 예약 취소 규정"},{"id":"code","text":"파이썬 코드 테스트"}]
        for tool in ["bm25","tfidf"]:
            with self.subTest(tool=tool):
                a=execute_tool(tool,{"documents":docs,"query":"회의실"})["results"]
                b=execute_tool(tool,{"documents":docs,"query":"코드"})["results"]
                self.assertEqual(a[0]["id"],"policy");self.assertEqual(b[0]["id"],"code")
        self.assertEqual(execute_tool("rrf",{"rankings":[["a","b","a"],["b"]]})["results"][0]["id"],"b")
        self.assertEqual(execute_tool("hybrid_search",{"lexicalResults":["a","b"],"vectorResults":["b"]})["results"][0]["id"],"b")

    def test_vectors_and_explicit_expansion(self):
        self.assertEqual(execute_tool("cosine_similarity",{"a":[1,0],"b":[0,1]})["score"],0)
        self.assertTrue(execute_tool("cosine_similarity",{"a":[0],"b":[1]})["zeroVector"])
        self.assertEqual(execute_tool("semantic_search",{"queryVector":[1,0],"vectors":[{"id":"b","vector":[0,1]},{"id":"a","vector":[1,0]}]})["results"][0]["id"],"a")
        self.assertEqual(execute_tool("query_expansion",{"query":"API","synonyms":{"api":["인터페이스"]}})["queries"],["API","API 인터페이스"])

    def test_quality_and_evaluation(self):
        result=execute_tool("data_quality",{"rows":[{"a":1},{"a":1},{"a":None}]})
        self.assertEqual(result["duplicateCount"],1);self.assertEqual(result["columns"][0]["missing"],1)
        self.assertEqual(execute_tool("classification_threshold",{"scores":[0.2,0.8],"threshold":0.7})["predictions"],[0,1])
        self.assertEqual(execute_tool("wer",{"reference":"a b c","hypothesis":"a c"})["wer"],1/3)
        self.assertEqual(execute_tool("throughput",{"count":15,"seconds":3})["itemsPerSecond"],5)
        for tool in ["benchmark","evals"]:
            self.assertEqual(execute_tool(tool,{"cases":[{"expected":2,"actual":2},{"expected":3,"actual":2}]})["passed"],1)

    def test_graph_traversal_keeps_citation_and_depth(self):
        edges=[{"from":"a","to":"b","source":"doc1"},{"from":"b","to":"c","source":"doc2"},{"from":"c","to":"a","source":"doc3"}]
        one=execute_tool("knowledge_graph",{"edges":edges,"start":"a","depth":1})
        self.assertEqual(one["nodes"],["a","b"]);self.assertEqual(one["edges"][0]["source"],"doc1")
        self.assertEqual(len(execute_tool("knowledge_graph",{"edges":edges,"start":"a","depth":8})["edges"]),3)

    def test_privacy_does_not_return_original_secrets_in_findings(self):
        for tool in ["pii","redaction","anonymization","data_classification"]:
            result=execute_tool(tool,{"text":"문의 alice@example.com"})
            self.assertTrue(result["sensitive"])
            self.assertNotIn("alice",json.dumps(result["findings"]))
            if "text" in result:self.assertNotIn("alice",result["text"])
        self.assertTrue(execute_tool("moderation",{"text":"keep PRIVATE","blockedPhrases":["private"]})["blocked"])
        self.assertFalse(execute_tool("ai_citation",{"documents":[{"id":"a","text":"original"}],"citations":[{"id":"a","quote":"made up"}]})["valid"])

    def test_signed_local_protocols_are_explicit(self):
        with patch.dict(os.environ,{"FLOWLY_WATERMARK_KEY":"test-only","FLOWLY_CONTENT_CREDENTIALS_KEY":"test-only"}):
            signed=execute_tool("watermark",{"operation":"sign","text":"sample"})
            verify={"text":signed["text"],"watermark":signed["watermark"]}
            self.assertTrue(execute_tool("watermark",verify)["valid"])
            self.assertFalse(execute_tool("watermark",{**verify,"text":"tampered"})["valid"])
            manifest={"scheme":"flowly-content-hmac-v1","sha256":hashlib.sha256(b"sample").hexdigest()}
            signature=hmac.new(b"test-only",json.dumps(manifest,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode(),hashlib.sha256).hexdigest()
            result=execute_tool("content_credentials",{"text":"sample","manifest":manifest,"signature":signature})
            self.assertTrue(result["valid"]);self.assertFalse(result["c2paSupported"])

    def test_dp_requires_explicit_single_query_contract(self):
        with self.assertRaises(ToolError):execute_tool("differential_privacy",{"value":10,"epsilon":1,"sensitivity":1})
        result=execute_tool("differential_privacy",{"value":10,"epsilon":1,"sensitivity":1,"singleQueryAcknowledged":True})
        self.assertTrue(math.isfinite(result["value"]));self.assertFalse(result["compositionManaged"])

    def test_ssml_escapes_xml(self):
        self.assertIn("&lt;script&gt;",execute_tool("ssml",{"text":"<script>"})["ssml"])

    def test_unknown_nonfinite_forbidden_and_oversize_rejected(self):
        cases=[("__import__",{}),("jsonl",{"__proto__":1}),("throughput",{"count":1,"seconds":float("inf")}), ("jsonl",{"text":"a"*1_000_001})]
        for tool,args in cases:
            with self.subTest(tool=tool):
                with self.assertRaises(ToolError):execute_tool(tool,args)

    def test_check_no_model_download_and_no_secret_echo(self):
        with patch.dict(os.environ,{"FLOWLY_TOOL_MODELS":"{}"}):
            result=check_tools(["jsonl","embedding"])
        self.assertEqual(result["tools"][0]["status"],"ready")
        self.assertEqual(result["tools"][1]["status"],"unconfigured")
        self.assertFalse(result["networkProbed"])
        self.assertTrue(any(x["code"]=="missing_model" for x in result["missing"]))

    def test_contract_snapshot_and_unknown_arguments(self):
        from toolpacks_contracts import contracts
        self.assertEqual(contracts(),json.loads((ROOT/"export-runtime/tool-contracts.json").read_text(encoding="utf8")))
        with self.assertRaises(ToolError):execute_tool("jsonl",{"text":"{}","shell":"danger"})

    def test_model_paths_reject_escape_and_report_missing(self):
        from flowly_tools import model_path
        with patch.dict(os.environ,{"FLOWLY_TOOL_MODELS":json.dumps({"embedding":"../outside"})}):
            with self.assertRaises(ToolError) as result:model_path("embedding")
            self.assertEqual(result.exception.code,"missing_configuration")
        with patch.dict(os.environ,{"FLOWLY_TOOL_MODELS":json.dumps({"embedding":"missing-model"})}):
            with self.assertRaises(ToolError) as result:model_path("embedding")
            self.assertEqual(result.exception.code,"missing_model")

    @unittest.skipUnless(importlib.util.find_spec("tokenizers"),"tokenizers optional dependency not installed")
    def test_real_local_tokenizer_without_download(self):
        from tokenizers import Tokenizer,models,pre_tokenizers
        from flowly_tools import model_path
        original=Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/"models").mkdir()
            tokenizer=Tokenizer(models.WordLevel({"[UNK]":0,"hello":1,"world":2},unk_token="[UNK]"));tokenizer.pre_tokenizer=pre_tokenizers.Whitespace();tokenizer.save(str(root/"models"/"tiny.json"))
            try:
                os.chdir(root)
                with patch.dict(os.environ,{"FLOWLY_TOOL_MODELS":json.dumps({"tokenizer":"tiny.json","tokens":"tiny.json"})}):
                    self.assertEqual(check_tools(["tokenizer","tokens"])["status"],"ready")
                    for tool in ["tokenizer","tokens"]:
                        result=execute_tool(tool,{"text":"hello world"})
                        self.assertEqual(result["ids"],[1,2]);self.assertEqual(result["count"],2)
            finally:os.chdir(original)

    def test_every_ready_contract_executes_or_configuration_is_explicit(self):
        from flowly_tools import tool_contracts
        for identifier,contract in tool_contracts().items():
            with self.subTest(tool=identifier):
                state=check_tools([identifier])
                if state["status"]=="ready":
                    result=execute_tool(identifier,contract["exampleArguments"])
                    self.assertIsInstance(result,dict)
                else:
                    self.assertTrue(state["missing"])
                    self.assertTrue(all(reason["code"] in {"missing_dependency","missing_model","missing_configuration"} for reason in state["missing"]))

    def test_cli_json_protocol(self):
        result=subprocess.run([sys.executable,str(ROOT/"export-runtime/flowly_tools.py")],input=json.dumps({"toolId":"jsonl","arguments":{"text":"{}"}}),text=True,encoding="utf-8",capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout),{"ok":True,"result":{"records":[{}],"count":1}})
        bad=subprocess.run([sys.executable,str(ROOT/"export-runtime/flowly_tools.py")],input='{bad',text=True,encoding="utf-8",capture_output=True,timeout=15)
        self.assertEqual(json.loads(bad.stdout)["error"]["code"],"invalid_input")

    @unittest.skipUnless(importlib.util.find_spec("jsonschema"),"jsonschema not installed")
    def test_json_schema_local_only(self):
        result=execute_tool("json_schema",{"schema":{"type":"object","required":["x"],"properties":{"x":{"type":"number"}}},"value":{"x":"wrong"}})
        self.assertFalse(result["valid"]);self.assertEqual(result["errors"][0]["path"],["x"])
        with self.assertRaises(ToolError):execute_tool("json_schema",{"schema":{"$ref":"https://example.test/schema.json"},"value":{}})


@unittest.skipUnless(importlib.util.find_spec("sklearn"),"scientific dependencies not installed")
class ScientificToolTests(unittest.TestCase):
    def test_fitted_preprocessor_does_not_fit_inference_batch(self):
        fitted=execute_tool("standard_scaling",{"operation":"fit","trainingData":[[0],[2]]})
        result=execute_tool("standard_scaling",{"operation":"transform","state":fitted["state"],"data":[[100]]})
        self.assertAlmostEqual(result["data"][0][0],99)

    def test_preprocessors(self):
        tools="feature_selection feature_binarization feature_discretization whitening quantile_transform power_transform maxabs_scaling robust_scaling standard_scaling minmax_scaling l1_normalization l2_normalization feature_engineering features".split()
        for tool in tools:
            with self.subTest(tool=tool):
                result=execute_tool(tool,{"trainingData":[[1,1],[2,4],[3,2],[4,3]],"data":[[2,3]]})
                self.assertEqual(len(result["data"]),1)
        self.assertEqual(execute_tool("imputation",{"trainingData":[[1],[3],[None]],"data":[[None]]})["data"],[[2]])
        with self.assertRaises(ToolError):execute_tool("features",{"data":[[1]*128],"params":{"degree":3}})

    def test_discretization_state_preserves_bins(self):
        first=execute_tool("feature_discretization",{"operation":"fit","trainingData":[[0],[1],[2],[3]],"params":{"bins":2}})
        transformed=execute_tool("feature_discretization",{"operation":"transform","state":first["state"],"data":[[3]]})
        self.assertEqual(transformed["data"],[[1]])

    def test_category_transforms_and_target_leak_guard(self):
        for tool in ["label_encoding","frequency_encoding","ordinal_encoding","onehot_encoding","feature_hashing"]:
            with self.subTest(tool=tool):self.assertEqual(len(execute_tool(tool,{"trainingData":["a","a","b"],"data":["a","c"]})["data"]),2)
        result=execute_tool("target_encoding",{"trainingData":["a","a","b"],"trainingLabels":[1,3,9],"data":["a"]})
        self.assertEqual(result["data"],[2])
        with self.assertRaises(ToolError):execute_tool("target_encoding",{"trainingData":["a"],"trainingLabels":[1]})
        self.assertEqual(execute_tool("data_labeling",{"records":["doc"],"labels":["reviewed"]})["records"],[{"value":"doc","label":"reviewed"}])
        self.assertEqual(execute_tool("synthetic_data",{"count":3,"columns":2,"seed":5}),execute_tool("synthetic_data",{"count":3,"columns":2,"seed":5}))
        self.assertEqual(execute_tool("data_augmentation",{"data":[[1,2]],"sigma":0})["data"],[[1,2]])

    def test_regression_state_predicts_without_evaluation_leak(self):
        fit=execute_tool("regression",{"operation":"fit","trainingData":[[0],[1],[2]],"trainingLabels":[1,3,5]})
        out=execute_tool("regression",{"operation":"predict","state":fit["state"],"data":[[10]]})
        self.assertAlmostEqual(out["predictions"][0],21)

    def test_registered_classifiers(self):
        training=[[i,i%3] for i in range(12)];labels=[int(i>=6) for i in range(12)]
        for tool in "perceptron nearest_centroid qda extra_trees gradient_boosting adaboost decision_tree lda knn logistic_regression naive_bayes svm random_forest classification".split():
            with self.subTest(tool=tool):
                result=execute_tool(tool,{"trainingData":training,"trainingLabels":labels,"data":[[0,0],[11,2]]})
                self.assertEqual(len(result["predictions"]),2)

    def test_registered_regressors(self):
        training=[[i] for i in range(12)];labels=[2*i+1 for i in range(12)]
        for tool in "pls ard omp theil_sen bayesian_ridge elastic_net poisson_regression quantile_regression huber_regression gaussian_process regression ransac".split():
            with self.subTest(tool=tool):
                result=execute_tool(tool,{"trainingData":training,"trainingLabels":labels,"data":[[5],[9]]})
                self.assertEqual(len(result["predictions"]),2)

    def test_clustering_and_reduction(self):
        data=[[0,0],[0.1,0.2],[0.2,0.1],[5,5],[5.1,5.2],[5.2,5.1],[10,0],[10.1,0.2]]
        for tool in "kmeans clustering birch hdbscan optics affinity_propagation mean_shift spectral_clustering hierarchical_clustering gmm dbscan".split():
            with self.subTest(tool=tool):self.assertEqual(len(execute_tool(tool,{"data":data})["labels"]),len(data))
        for tool in "sparse_pca kernel_pca random_projection factor_analysis lle isomap tsne ica nmf svd pca".split():
            with self.subTest(tool=tool):self.assertEqual(len(execute_tool(tool,{"data":data,"params":{"n_components":1}})["data"]),len(data))
        self.assertEqual(len(execute_tool("cca",{"data":data,"targets":[[i] for i in range(len(data))],"params":{"n_components":1}})["data"]),len(data))

    def test_metrics_and_clusters(self):
        for tool in "hamming_loss average_precision brier_score cohen_kappa mcc balanced_accuracy pair_confusion_matrix contingency_matrix fowlkes_mallows adjusted_mutual_info v_measure adjusted_rand roc_auc recall precision f1 accuracy confusion_matrix".split():
            with self.subTest(tool=tool):self.assertIn("value",execute_tool(tool,{"expected":[0,0,1,1],"actual":[0,1,1,1]}))
        for tool in ["calinski_harabasz","davies_bouldin","silhouette"]:
            with self.subTest(tool=tool):self.assertIn("value",execute_tool(tool,{"data":[[0],[0.1],[5],[5.1]],"labels":[0,0,1,1]}))

    def test_spectral_and_assignment_algorithms(self):
        self.assertEqual(execute_tool("hungarian",{"costs":[[4,1],[2,3]]})["totalCost"],3)
        fft=execute_tool("fft",{"values":[1,0,0,0]})
        self.assertEqual(fft["real"],[1,1,1,1]);self.assertEqual(fft["imag"],[0,0,0,0])
        self.assertAlmostEqual(execute_tool("dct",{"values":[1,1]})["values"][0],math.sqrt(2))
        self.assertEqual(execute_tool("dtw",{"a":[1,2,3],"b":[1,2,3]})["distance"],0)
        self.assertEqual(len(execute_tool("kalman",{"values":[1,2,3]})["states"]),3)
        for tool in ["hessenberg","schur","lu","qr","cholesky","eigen"]:
            with self.subTest(tool=tool):self.assertTrue(execute_tool(tool,{"matrix":[[4,1],[1,3]]}))

    def test_search_quantization(self):
        data=[[0,0],[1,1],[2,2],[3,3]]
        for tool in ["scalar_quantization","product_quantization"]:
            self.assertEqual(len(execute_tool(tool,{"data":data})["reconstructed"]),4)
        for tool in ["ann","ivf_flat"]:
            self.assertEqual(execute_tool(tool,{"data":data,"queries":[[0,0]],"topK":1})["indices"][0][0],0)

    def test_anomalies_drift_and_calibration(self):
        training=[[i/10] for i in range(20)]
        for tool in ["lof","isolation_forest","kde","ood","anomaly_detection"]:
            self.assertTrue(execute_tool(tool,{"trainingData":training,"data":[[0.5],[99]]}))
        for tool in ["data_drift","model_drift"]:
            self.assertTrue(execute_tool(tool,{"reference":list(range(30)),"current":list(range(100,130))})["driftDetected"])
        self.assertEqual(execute_tool("calibration",{"trainingScores":[0.1,0.2,0.8,0.9],"trainingLabels":[0,0,1,1],"scores":[0.15,0.85]})["probabilities"],[0,1])
        out=execute_tool("conformal_prediction",{"calibrationExpected":list(range(20)),"calibrationPredicted":[i+1 for i in range(20)],"predictions":[10],"alpha":0.1})
        self.assertEqual(out["intervals"],[{"lower":9,"upper":11}])

    def test_experiments_and_explanations(self):
        self.assertEqual(execute_tool("ab_test",{"a":[1,2,3],"b":[4,5,6]})["meanDifference"],3)
        with self.assertRaises(ToolError):execute_tool("causal_inference",{"a":[1,2],"b":[3,4]})
        self.assertEqual(execute_tool("causal_inference",{"a":[1,2,3],"b":[4,5,6],"randomizedTreatment":True})["meanDifference"],3)
        forecast=execute_tool("time_series_forecast",{"values":[1,3,5],"steps":1})
        self.assertAlmostEqual(forecast["predictions"][0],7)
        self.assertEqual(execute_tool("recommender",{"ratings":[[5,0],[5,4]],"user":0})["recommendations"][0]["item"],1)
        args={"trainingData":[[i] for i in range(12)],"trainingLabels":[int(i>=6) for i in range(12)],"validationData":[[1],[9]],"validationLabels":[0,1]}
        self.assertEqual(len(execute_tool("cross_validation",args)["scores"]),3)
        for tool in ["feature_importance","xai"]:self.assertEqual(execute_tool(tool,args)["method"],"heldout_permutation_importance")

    def test_vad_diarization_and_nms(self):
        samples=[0.0]*160+[0.2,-0.2]*80
        self.assertFalse(execute_tool("vad",{"samples":samples,"sampleRate":16000,"frameMs":10})["frames"][0]["speech"])
        self.assertTrue(execute_tool("vad",{"samples":samples,"sampleRate":16000,"frameMs":10})["frames"][1]["speech"])
        self.assertFalse(execute_tool("speaker_diarization",{"samples":samples,"sampleRate":16000,"frameMs":10,"speakers":1})["speakerIdentityVerified"])
        self.assertEqual(execute_tool("nms",{"boxes":[[0,0,10,10],[1,1,9,9],[20,20,30,30]],"scores":[0.9,0.8,0.7]})["indices"],[0,2])


@unittest.skipUnless(importlib.util.find_spec("cv2"),"OpenCV optional dependency not installed")
class VisionToolTests(unittest.TestCase):
    def test_actual_image_algorithms(self):
        image=[[255 if 5<=x<10 and 5<=y<10 else 0 for x in range(16)] for y in range(16)]
        for tool in "laplacian gamma_correction gaussian_filter harris_corners median_filter bilateral_filter histogram_equalization distance_transform morphology otsu canny image_segmentation".split():
            with self.subTest(tool=tool):self.assertEqual(len(execute_tool(tool,{"image":image})["image"]),16)
        self.assertEqual(len(execute_tool("connected_components",{"image":image})["components"]),1)
        self.assertFalse(execute_tool("object_detection",{"image":image})["semanticClasses"])
        self.assertEqual(execute_tool("computer_vision",{"image":image})["width"],16)
        self.assertIn("points",execute_tool("sift",{"image":image}))
        flow=execute_tool("optical_flow",{"image":image,"previous":image})
        self.assertEqual(len(flow["flow"]),16)
        tracked=execute_tool("object_tracking",{"image":image,"template":[[255]*3]*3})
        self.assertEqual(tracked["box"]["width"],3)
        markers=[[1 if x==0 or y==0 else 2 if x==7 and y==7 else 0 for x in range(16)] for y in range(16)]
        self.assertEqual(len(execute_tool("watershed",{"image":image,"markers":markers})["markers"]),16)

    @unittest.skipUnless(importlib.util.find_spec("pywt"),"PyWavelets optional dependency not installed")
    def test_actual_wavelet(self):
        self.assertEqual(len(execute_tool("dwt",{"values":[1,2,3,4]})["approximation"]),2)


if __name__=="__main__":unittest.main()
