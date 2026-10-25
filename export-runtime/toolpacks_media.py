"""Local media and controlled-document automation adapters. Never download models."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import math
import os

from flowly_tools import array, dependency, fail, integer, matrix, model_path, number, text
from toolpacks_scientific import clean

CV=set("laplacian gamma_correction gaussian_filter harris_corners median_filter bilateral_filter histogram_equalization watershed distance_transform morphology connected_components otsu canny sift optical_flow object_tracking image_segmentation object_detection computer_vision".split())
MEDIA={key:["numpy","cv2"] for key in CV}
MEDIA.update({
    "glcm":["numpy","skimage"],"lbp":["numpy","skimage"],"hog":["numpy","skimage"],"nms":["numpy"],
    "pose_estimation":["numpy","mediapipe"],"ocr":["numpy","PIL","pytesseract"],
    "ner":["spacy"],"sentiment":["transformers","torch"],"embedding":["sentence_transformers"],
    "reranking":["sentence_transformers"],"stt":["numpy","faster_whisper"],"tts":["transformers","torch"],
    "multimodal":["transformers","torch","PIL"],"vad":["numpy"],"speaker_diarization":["numpy","sklearn"],
    "content_credentials":[],"watermark":[],"rpa":["playwright"],"computer_use":["playwright"],
})


def image_array(args,key="image",gray=False):
    np=dependency("numpy")
    value=array(args.get(key),1,256)
    if any(not isinstance(row,list) for row in value):fail("영상은 픽셀 행 배열이어야 해요.")
    data=np.asarray(value)
    if data.ndim not in {2,3} or not 1<=data.shape[1]<=256 or data.dtype.kind not in {"u","i","f"}:
        fail("영상은 최대 256×256 숫자 픽셀 배열이어야 해요.")
    if data.ndim==3 and data.shape[2] not in {3,4}:fail("색상 채널은 RGB 또는 RGBA여야 해요.")
    if not np.isfinite(data).all() or (data<0).any() or (data>255).any():fail("픽셀은 0~255 숫자여야 해요.")
    data=data.astype(np.uint8)
    if gray and data.ndim==3:
        data=dependency("cv2","opencv-python-headless").cvtColor(data,dependency("cv2").COLOR_RGB2GRAY if data.shape[2]==3 else dependency("cv2").COLOR_RGBA2GRAY)
    return data


def audio_array(args):
    np=dependency("numpy")
    values=np.asarray([number(x) for x in array(args.get("samples"),1,100_000)],dtype=np.float32)
    if (abs(values)>1).any():fail("오디오 표본은 -1~1 범위여야 해요.")
    rate=integer(args.get("sampleRate",16000),8000,48000)
    return values,rate


def vision(tool_id,args):
    np=dependency("numpy")
    if tool_id=="nms":
        boxes=matrix(args.get("boxes"));scores=[number(x) for x in array(args.get("scores"),maximum=1000)];threshold=number(args.get("threshold",0.5))
        if len(boxes)!=len(scores) or len(boxes[0])!=4 or not 0<=threshold<=1:fail("NMS boxes는 x1,y1,x2,y2이고 점수 수가 같아야 해요.")
        if any(b[2]<b[0] or b[3]<b[1] for b in boxes):fail("상자의 좌표 순서를 확인해 주세요.")
        order=sorted(range(len(scores)),key=lambda i:(-scores[i],i));kept=[]
        while order:
            idx=order.pop(0);kept.append(idx);a=boxes[idx];remaining=[]
            for other in order:
                b=boxes[other];inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]));union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
                if (inter/union if union else 0)<=threshold:remaining.append(other)
            order=remaining
        return {"indices":kept,"boxes":[boxes[i] for i in kept],"scores":[scores[i] for i in kept]}
    cv=dependency("cv2","opencv-python-headless")
    data=image_array(args,gray=tool_id not in {"watershed","computer_vision"})
    kernel=integer(args.get("kernelSize",3),1,15)
    if kernel%2==0:fail("필터 크기는 홀수여야 해요.")
    if tool_id=="laplacian":result=cv.Laplacian(data,cv.CV_64F)
    elif tool_id=="gamma_correction":
        gamma=number(args.get("gamma",1))
        if not 0.05<=gamma<=20:fail("감마는 0.05~20 범위예요.")
        result=np.rint(255*(data/255.)**gamma).astype(np.uint8)
    elif tool_id=="gaussian_filter":result=cv.GaussianBlur(data,(kernel,kernel),0)
    elif tool_id=="median_filter":result=cv.medianBlur(data,kernel)
    elif tool_id=="bilateral_filter":result=cv.bilateralFilter(data,kernel,75,75)
    elif tool_id=="histogram_equalization":result=cv.equalizeHist(data)
    elif tool_id=="harris_corners":result=cv.cornerHarris(np.float32(data),2,3,0.04)
    elif tool_id=="distance_transform":result=cv.distanceTransform((data>0).astype(np.uint8),cv.DIST_L2,3)
    elif tool_id=="morphology":
        methods={"open":cv.MORPH_OPEN,"close":cv.MORPH_CLOSE,"gradient":cv.MORPH_GRADIENT,"erode":cv.MORPH_ERODE,"dilate":cv.MORPH_DILATE}
        mode=args.get("mode","open")
        if mode not in methods:fail("지원하지 않는 형태학 처리예요.")
        result=cv.morphologyEx(data,methods[mode],np.ones((kernel,kernel),np.uint8))
    elif tool_id in {"otsu","image_segmentation"}:
        threshold,result=cv.threshold(data,0,255,cv.THRESH_BINARY+cv.THRESH_OTSU)
        return {"image":clean(result),"threshold":float(threshold),"method":"otsu_binary_segmentation"}
    elif tool_id in {"connected_components","object_detection"}:
        # Classical foreground component detector: no semantic object-class claim.
        threshold=integer(args.get("threshold",127),0,255)
        count,labels,stats,centroids=cv.connectedComponentsWithStats((data>threshold).astype(np.uint8))
        components=[{"label":i,"x":int(stats[i,0]),"y":int(stats[i,1]),"width":int(stats[i,2]),"height":int(stats[i,3]),"area":int(stats[i,4]),"centroid":clean(centroids[i])} for i in range(1,count)]
        return {"labels":clean(labels),"components":components,"method":"threshold_connected_components","semanticClasses":False}
    elif tool_id=="watershed":
        if data.ndim==2:data=cv.cvtColor(data,cv.COLOR_GRAY2RGB)
        markers=np.asarray(matrix(args.get("markers")),dtype=np.int32)
        if markers.shape!=data.shape[:2]:fail("watershed 마커와 영상 크기가 달라요.")
        return {"markers":clean(cv.watershed(data,markers))}
    elif tool_id=="canny":result=cv.Canny(data,integer(args.get("low",50),0,255),integer(args.get("high",150),0,255))
    elif tool_id=="sift":
        points,descriptors=cv.SIFT_create(nfeatures=integer(args.get("maxFeatures",100),1,200)).detectAndCompute(data,None)
        return {"points":[{"x":p.pt[0],"y":p.pt[1],"size":p.size,"angle":p.angle} for p in points],"descriptors":clean(descriptors) if descriptors is not None else []}
    elif tool_id=="optical_flow":
        previous=image_array(args,"previous",gray=True)
        if previous.shape!=data.shape:fail("연속 영상 크기가 달라요.")
        result=cv.calcOpticalFlowFarneback(previous,data,None,0.5,3,15,3,5,1.2,0)
        return {"flow":clean(result),"method":"farneback"}
    elif tool_id=="object_tracking":
        template=image_array(args,"template",gray=True)
        if template.shape[0]>data.shape[0] or template.shape[1]>data.shape[1]:fail("추적할 템플릿은 영상보다 작아야 해요.")
        response=cv.matchTemplate(data,template,cv.TM_SQDIFF_NORMED);score,_,location,_=cv.minMaxLoc(response)
        return {"box":{"x":location[0],"y":location[1],"width":template.shape[1],"height":template.shape[0]},"distance":float(score),"method":"single_template_matching"}
    elif tool_id=="computer_vision":
        gray=cv.cvtColor(data,cv.COLOR_RGB2GRAY) if data.ndim==3 else data
        return {"width":data.shape[1],"height":data.shape[0],"channels":1 if data.ndim==2 else data.shape[2],"meanBrightness":float(gray.mean()),"edgePixelCount":int(np.count_nonzero(cv.Canny(gray,50,150))),"method":"image_statistics"}
    else:fail("지원하지 않는 영상 처리예요.")
    return {"image":clean(result)}


def features(tool_id,args):
    # skimage can operate without cv2 for grayscale images.
    data=image_array(args)
    if data.ndim!=2:fail("회색조 영상이 필요해요.")
    feature=dependency("skimage.feature","scikit-image")
    if tool_id=="glcm":
        np=dependency("numpy");levels=integer(args.get("levels",16),2,64);quant=(data.astype(np.float64)*levels/256).astype(np.uint8)
        result=feature.graycomatrix(quant,[1],[0,math.pi/2],levels=levels,symmetric=True,normed=True)
        return {"contrast":clean(feature.graycoprops(result,"contrast")),"homogeneity":clean(feature.graycoprops(result,"homogeneity")),"energy":clean(feature.graycoprops(result,"energy"))}
    if tool_id=="lbp":return {"image":clean(feature.local_binary_pattern(data,8,1,method="uniform"))}
    return {"descriptor":clean(feature.hog(data,orientations=9,pixels_per_cell=(8,8),cells_per_block=(2,2),feature_vector=True))}


def language(tool_id,args):
    path=model_path(tool_id)
    if tool_id=="ner":
        nlp=dependency("spacy").load(str(path),disable=["parser","textcat"])
        doc=nlp(text(args.get("text"),20_000))
        return {"entities":[{"text":entity.text,"label":entity.label_,"start":entity.start_char,"end":entity.end_char} for entity in doc.ents],"modelSource":"local"}
    if tool_id in {"embedding","reranking"}:
        package=dependency("sentence_transformers")
        if tool_id=="embedding":
            texts=[text(item,20_000) for item in array(args.get("texts"),maximum=100)]
            model=package.SentenceTransformer(str(path),local_files_only=True,trust_remote_code=False,device="cpu")
            return {"vectors":clean(model.encode(texts,normalize_embeddings=True,batch_size=8)),"modelSource":"local"}
        from flowly_tools import documents
        docs=documents(args);query=text(args.get("query"),2000)
        model=package.CrossEncoder(str(path),local_files_only=True,trust_remote_code=False,device="cpu")
        scores=model.predict([(query,doc["text"]) for doc in docs],batch_size=8)
        return {"results":sorted([{"id":doc["id"],"score":float(score)} for doc,score in zip(docs,scores)],key=lambda x:(-x["score"],x["id"])),"modelSource":"local"}
    if tool_id=="sentiment":
        module=dependency("transformers");model=module.AutoModelForSequenceClassification.from_pretrained(str(path),local_files_only=True,trust_remote_code=False,use_safetensors=True);tokenizer=module.AutoTokenizer.from_pretrained(str(path),local_files_only=True,trust_remote_code=False)
        result=module.pipeline("text-classification",model=model,tokenizer=tokenizer,device=-1)(text(args.get("text"),10000),truncation=True)
        return {"predictions":result,"modelSource":"local"}
    fail("지원하지 않는 언어 모델 도구예요.")


def audio(tool_id,args):
    np=dependency("numpy")
    if tool_id=="tts":
        module=dependency("transformers");path=model_path(tool_id)
        model=module.AutoModelForTextToWaveform.from_pretrained(str(path),local_files_only=True,trust_remote_code=False,use_safetensors=True)
        tokenizer=module.AutoTokenizer.from_pretrained(str(path),local_files_only=True,trust_remote_code=False)
        pipeline=module.pipeline("text-to-audio",model=model,tokenizer=tokenizer,device=-1)
        result=pipeline(text(args.get("text"),1000));samples=np.asarray(result["audio"]).reshape(-1)
        if len(samples)>100_000:fail("생성한 음성은 100,000개 표본 한도를 초과했어요.")
        return {"samples":clean(samples),"sampleRate":int(result["sampling_rate"]),"modelSource":"local"}
    samples,rate=audio_array(args)
    if tool_id=="stt":
        if rate!=16000:fail("STT 표본 속도는 16,000Hz여야 해요.")
        model=dependency("faster_whisper").WhisperModel(str(model_path(tool_id)),device="cpu",compute_type="int8",local_files_only=True)
        segments,info=model.transcribe(samples,beam_size=1,language=args.get("language"),vad_filter=False)
        segments=[{"start":s.start,"end":s.end,"text":s.text} for s in segments]
        return {"text":" ".join(s["text"] for s in segments),"segments":segments,"language":info.language,"modelSource":"local"}
    frame=integer(args.get("frameMs",20),10,100)*rate//1000;threshold=number(args.get("threshold",0.02))
    if not 0<=threshold<=1:fail("음성 활동 임계값은 0~1이에요.")
    frames=[samples[start:start+frame] for start in range(0,len(samples),frame)]
    energies=[float(np.sqrt((chunk**2).mean())) for chunk in frames]
    if tool_id=="vad":return {"frames":[{"start":i*frame/rate,"end":min((i+1)*frame,len(samples))/rate,"speech":energy>=threshold,"rms":energy} for i,energy in enumerate(energies)],"method":"energy_threshold","semanticSpeechDetection":False}
    # Acoustic clustering baseline, explicitly not verified speaker identity.
    active=[i for i,energy in enumerate(energies) if energy>=threshold]
    if not active:return {"segments":[],"method":"acoustic_frame_clustering","speakerIdentityVerified":False}
    vectors=[]
    for i in active:
        chunk=frames[i];spectrum=abs(np.fft.rfft(chunk));centroid=float((np.arange(len(spectrum))*spectrum).sum()/max(spectrum.sum(),1e-12));crossing=float(np.mean(np.sign(chunk[1:])!=np.sign(chunk[:-1]))) if len(chunk)>1 else 0
        vectors.append([energies[i],centroid,crossing])
    speakers=integer(args.get("speakers",2),1,min(10,len(vectors)))
    from sklearn.preprocessing import StandardScaler
    cls=dependency("sklearn.cluster").KMeans(n_clusters=speakers,random_state=0,n_init=10);labels=cls.fit_predict(StandardScaler().fit_transform(vectors))
    return {"segments":[{"start":i*frame/rate,"end":min((i+1)*frame,len(samples))/rate,"cluster":int(label)} for i,label in zip(active,labels)],"method":"acoustic_frame_clustering","speakerIdentityVerified":False}


def credentials(tool_id,args):
    if tool_id=="watermark":
        key=os.environ.get("FLOWLY_WATERMARK_KEY")
        if not key:fail("FLOWLY_WATERMARK_KEY를 실행 환경에 설정해 주세요.","missing_configuration")
        content=text(args.get("text"),empty=True);signature=hmac.new(key.encode(),content.encode(),hashlib.sha256).hexdigest()
        if args.get("operation","verify")=="sign":return {"text":content,"watermark":{"scheme":"flowly-hmac-sha256-v1","signature":signature},"aiAuthorshipProven":False}
        mark=args.get("watermark")
        if not isinstance(mark,dict) or mark.get("scheme")!="flowly-hmac-sha256-v1":fail("지원하는 Flowly 워터마크가 필요해요.")
        provided=mark.get("signature")
        return {"valid":isinstance(provided,str) and hmac.compare_digest(signature,provided),"scheme":"flowly-hmac-sha256-v1","aiAuthorshipProven":False}
    # Content credentials: supported declared HMAC manifest, not generic C2PA.
    key=os.environ.get("FLOWLY_CONTENT_CREDENTIALS_KEY")
    if not key:fail("FLOWLY_CONTENT_CREDENTIALS_KEY를 실행 환경에 설정해 주세요.","missing_configuration")
    manifest=args.get("manifest")
    if not isinstance(manifest,dict) or manifest.get("scheme")!="flowly-content-hmac-v1":fail("지원하는 콘텐츠 이력 manifest가 필요해요.")
    payload=text(args.get("text"),empty=True);digest=hashlib.sha256(payload.encode()).hexdigest();canonical=json.dumps(manifest,sort_keys=True,separators=(",",":"),ensure_ascii=False)
    expected=hmac.new(key.encode(),canonical.encode(),hashlib.sha256).hexdigest();signature=text(args.get("signature"),64)
    return {"valid":manifest.get("sha256")==digest and hmac.compare_digest(signature,expected),"scheme":"flowly-content-hmac-v1","claimsVerified":"manifest_signature_and_content_hash","c2paSupported":False}


def browser(tool_id,args):
    # Isolated supplied HTML only. External applications remain registered MCPs.
    html=text(args.get("html"),100_000);actions=array(args.get("actions",[]),0,30)
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as manager:
            browser=manager.chromium.launch(headless=True)
            context=browser.new_context(java_script_enabled=False,accept_downloads=False,service_workers="block")
            context.route("**/*",lambda route:route.abort())
            page=context.new_page();page.set_default_timeout(2000);page.set_content(html,wait_until="domcontentloaded",timeout=3000)
            observations=[]
            for action in actions:
                if not isinstance(action,dict):fail("브라우저 동작 객체가 필요해요.")
                selector=text(action.get("selector"),500);locator=page.locator(selector)
                mode=action.get("action")
                if mode=="fill":locator.fill(text(action.get("value"),2000,True));observations.append({"action":mode,"value":locator.input_value()})
                elif mode=="check":locator.check();observations.append({"action":mode,"checked":locator.is_checked()})
                elif mode=="read":observations.append({"action":mode,"text":locator.inner_text()[:10000]})
                elif mode=="count":observations.append({"action":mode,"count":locator.count()})
                else:fail("지원하는 격리 HTML 동작은 fill/check/read/count예요.")
            context.close();browser.close()
            return {"observations":observations,"mode":"isolated_supplied_html","networkAllowed":False,"externalApplicationAccess":False}
    except ImportError:fail("playwright 패키지가 필요해요.","missing_dependency")
    except Exception as exc:
        from flowly_tools import ToolError
        if isinstance(exc,ToolError):raise
        if "Executable doesn't exist" in str(exc):fail("Playwright Chromium이 미설정이에요. 실행 환경에서 브라우저를 설치해 주세요.","missing_configuration")
        fail("격리 HTML 자동화 실행에 실패했어요. 선택자와 동작을 확인해 주세요.","execution_failed")


def execute_media(tool_id,args):
    if tool_id in CV or tool_id=="nms":return vision(tool_id,args)
    if tool_id in {"glcm","hog","lbp"}:return features(tool_id,args)
    if tool_id in {"ner","sentiment","embedding","reranking"}:return language(tool_id,args)
    if tool_id in {"vad","speaker_diarization","stt","tts"}:return audio(tool_id,args)
    if tool_id in {"watermark","content_credentials"}:return credentials(tool_id,args)
    if tool_id in {"rpa","computer_use"}:
        dependency("playwright")
        return browser(tool_id,args)
    if tool_id=="ocr":
        image=dependency("PIL.Image","Pillow").fromarray(image_array(args))
        module=dependency("pytesseract")
        try:
            language=args.get("language","eng")
            if not isinstance(language,str) or len(language)>50 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_+" for c in language):fail("OCR 언어 코드를 확인해 주세요.")
            return {"text":module.image_to_string(image,lang=language,timeout=20),"engine":"local_tesseract"}
        except module.TesseractNotFoundError:fail("로컬 Tesseract 엔진이 미설정이에요.","missing_configuration")
    if tool_id=="pose_estimation":
        mp=dependency("mediapipe");np=dependency("numpy");data=image_array(args)
        if data.ndim!=3 or data.shape[2]!=3:fail("자세 추정에는 RGB 영상이 필요해요.")
        options=mp.tasks.vision.PoseLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path(tool_id))),running_mode=mp.tasks.vision.RunningMode.IMAGE,num_poses=integer(args.get("maxPoses",1),1,5))
        with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
            result=detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=data))
            return {"poses":[[{"x":point.x,"y":point.y,"z":point.z,"visibility":point.visibility} for point in pose] for pose in result.pose_landmarks],"modelSource":"local"}
    if tool_id=="multimodal":
        module=dependency("transformers");path=model_path(tool_id)
        model=module.AutoModelForVision2Seq.from_pretrained(str(path),local_files_only=True,trust_remote_code=False,use_safetensors=True)
        processor=module.AutoProcessor.from_pretrained(str(path),local_files_only=True,trust_remote_code=False)
        image=dependency("PIL.Image","Pillow").fromarray(image_array(args));prompt=text(args.get("prompt","Describe this image."),2000)
        inputs=processor(images=image,text=prompt,return_tensors="pt")
        generated=model.generate(**inputs,max_new_tokens=integer(args.get("maxTokens",100),1,256))
        return {"text":processor.batch_decode(generated,skip_special_tokens=True)[0],"modelSource":"local"}
    fail("지원하지 않는 미디어 도구예요.")
