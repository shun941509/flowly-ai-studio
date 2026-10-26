"use client";
/**
 * 명시적인 블록 입출력 계약을 편집한다. 표시된 후보와 예시 값은 정적 스키마 안내이며 실제 모델 응답을 보장하지 않는다.
 */

import { useState } from "react";
import type { Definition, FlowNode } from "../lib/model";
import type { DataSchema } from "../../runtime/types";
import { safeField } from "../../domain/schema";
import { safeDataPath } from "../../domain/node-config";
import { dataTypeNames, effectiveBindings, mappingIssues, outputFields, setOutputField } from "../../domain/data-contract";
import { GuideHelp } from "./workflow-guide";
import { IconButton } from "./common";

/** 연결선이 있는 앞 단계에서 경로를 고르고 입력 형식·필수 여부를 설정한다. 기본 추론 매핑을 수정하면 명시적인 inputBindings로 저장한다. */
export function InputMappings({node,definition,onChange}:{node:FlowNode;definition:Definition;onChange:(node:FlowNode)=>void}) {
  const [newField,setNewField]=useState("");
  const bindings=effectiveBindings(definition,node), sources=definition.nodes.filter(source=>definition.edges.some(edge=>edge.source===source.id&&edge.target===node.id));
  const fields=[...new Set(["text",...Object.keys(bindings),...Object.keys(node.inputSchema?.properties??{})])], issues=mappingIssues(definition,node);
  function change(field:string,source:string,path:string){const next={...bindings};if(source)next[field]={nodeId:source,path};else delete next[field];onChange({...node,inputBindings:next});}
  function inputType(field:string,type:string){const schema:DataSchema=structuredClone(node.inputSchema??{type:"object"});schema.properties??={};if(type&&schema.properties[field]?.type!==type)schema.properties[field]={type:type as DataSchema["type"]};else if(!type)delete schema.properties[field];onChange({...node,inputBindings:{...bindings},inputSchema:schema});}
  function required(field:string,checked:boolean){const schema:DataSchema=structuredClone(node.inputSchema??{type:"object"});schema.required=checked?[...new Set([...(schema.required??[]),field])]:(schema.required??[]).filter(key=>key!==field);onChange({...node,inputSchema:schema});}
  return <section className="mapping-assistant"><div className="field-separator"/><h4 className="context-title">입력 연결</h4><GuideHelp term="mapping"/><p className="field-help">앞 단계 → 결과 항목 → 이 블록의 입력을 연결해요. 목록은 설정에서 확인한 형식이며 실제 응답이 아니에요. 조건에서 건너뛴 경로와 비어 있는 목록은 값을 제공하지 않을 수 있어요.</p>
    {!sources.length&&<p className="soft-note">먼저 앞 블록에서 이 블록으로 연결선을 이어 주세요.</p>}
    <div className="input-mappings">{fields.map(field=>{
      const binding=bindings[field],source=sources.find(item=>item.id===binding?.nodeId),available=source?outputFields(source,definition):[],chosen=available.find(item=>item.path===binding?.path);
      return <section key={field}><details open={!binding||issues.some(issue=>issue.field===field&&issue.severity==='error')}><summary className="mapping-row-summary">{source?.title??'앞 단계 미선택'} · {binding?.path??'결과 항목 선택'} → {field}{node.inputSchema?.required?.includes(field)?' · 필수':''}</summary><div><strong>{field==="text"?"작업 내용 (text)":field}{node.inputSchema?.required?.includes(field)?" · 필수":""}</strong>{field!=="text"&&<IconButton icon="x" label={`${field} 전달 해제`} onClick={()=>change(field,"","")}/>}</div>
        <label className="field-label">가져올 앞 단계<select aria-label={`${field} 가져올 앞 단계`} value={binding?.nodeId??""} onChange={event=>{const selected=sources.find(item=>item.id===event.target.value);const options=selected?outputFields(selected,definition):[];change(field,event.target.value,options.find(item=>item.path===binding?.path)?.path??options.find(item=>item.path==="text")?.path??options[0]?.path??"text");}}><option value="">앞 단계 선택</option>{sources.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}{binding&&!source&&<option value={binding.nodeId}>연결되지 않은 단계 · 다시 선택</option>}</select></label>
        <label className="field-label">사용할 결과 항목<select aria-label={`${field} 사용할 결과 항목`} disabled={!binding} value={chosen?.path??"__custom"} onChange={event=>{if(event.target.value!=="__custom")change(field,binding.nodeId,event.target.value);}}>{available.map(item=><option key={item.path} value={item.path}>{item.path} · {item.label}{item.declared?" · 선언된 형식":""}</option>)}<option value="__custom">직접 경로 입력</option></select></label>
        <label className="field-label">결과 경로<input aria-label={`${field} 결과의 항목 이름`} disabled={!binding} value={binding?.path??""} maxLength={500} placeholder="data.title 또는 results.0.output.text" onChange={event=>change(field,binding.nodeId,event.target.value)}/></label>
        {binding&&source&&<p className="soft-note">{source.title}의 {binding.path} → 이 블록의 {field}<br/>설명용 예시: {chosen?.type==="number"?"80":chosen?.type==="boolean"?"true":chosen?.type==="array"?'["근거 A", "근거 B"]':chosen?.type==="object"?'{"title":"요약"}':"회의 일정 요약"} · 실제 응답이 아닙니다.</p>}
        {binding&&!safeDataPath(binding.path)&&<p className="form-error">사용할 결과 경로를 입력해 주세요. 예: data.title</p>}
        {binding&&!chosen&&safeDataPath(binding.path)&&<p className="field-help">설정에서 형식을 알 수 없는 경로예요. 실제 응답에 해당 항목이 있어야 해요.</p>}
        <label className="field-label">받을 형식<select aria-label={`${field} 받을 형식`} value={node.inputSchema?.properties?.[field]?.type??""} onChange={event=>inputType(field,event.target.value)}><option value="">별도 형식 제한 없음</option>{Object.entries(dataTypeNames).map(([type,label])=><option key={type} value={type}>{label}</option>)}</select></label>
        <label className="inline-check"><input type="checkbox" aria-label={`${field} 필수 입력`} checked={node.inputSchema?.required?.includes(field)??false} onChange={event=>required(field,event.target.checked)}/><span>이 입력이 없으면 중단 (필수)</span></label><p className="field-help">빈 문장·빈 목록도 값입니다. 내용이 충분한지는 조건·평가 블록으로 확인하세요.</p>
        {issues.filter(issue=>issue.field===field).map((issue,index)=><p key={index} className={issue.severity==="error"?"form-error":"mapping-warning"} role="status">{issue.message}</p>)}
      </details></section>;
    })}</div>
    <div className="mapping-add"><input aria-label="추가할 입력 항목 이름" placeholder="추가 입력 이름" value={newField} maxLength={80} onChange={event=>setNewField(event.target.value)}/><button type="button" className="text-btn" disabled={!safeField(newField)||Object.hasOwn(bindings,newField)||Object.keys(bindings).length>=40||!sources.length} onClick={()=>{change(newField,sources[0].id,outputFields(sources[0],definition).find(item=>item.path==="text")?.path??outputFields(sources[0],definition)[0]?.path??"text");setNewField("");}}>추가</button></div>
  </section>;
}

/** 다음 블록에 보여줄 출력 필드의 형식을 선언한다. 선언 자체가 데이터를 생성하거나 Agent의 출력 내용을 수정하지 않는다. */
export function OutputContractEditor({node,onChange}:{node:FlowNode;onChange:(node:FlowNode)=>void}) {
  const [path,setPath]=useState(""),[type,setType]=useState<DataSchema["type"]>("string"),[error,setError]=useState("");
  const declared=outputFields({...node,inputBindings:{},outputSchema:node.outputSchema}).filter(field=>field.declared);
  function update(path:string,type?:DataSchema["type"]){try{onChange({...node,outputSchema:setOutputField(node.outputSchema,path,type)});setError("");}catch(error){setError((error as Error).message);}}
  return <details className="output-contract"><summary>고급 설정 · 출력 형식 선언{declared.length?` · ${declared.length}개 항목`:" · 선택 사항"}</summary><p className="field-help">다음 블록에서 선택할 결과 항목을 선언해요. 데이터를 만드는 설정은 아니며, 실제 출력에 해당 항목이 있으면 형식을 검사합니다. Agent의 JSON 세부 항목은 data.title처럼 지정하세요.</p>
    {declared.map(field=><div className="output-contract-row" key={field.path}><code>{field.path}</code><span>{field.label}</span><IconButton icon="x" label={`${field.path} 출력 형식 해제`} onClick={()=>update(field.path)}/></div>)}
    <label className="field-label">선언할 출력 항목<input aria-label="선언할 출력 항목" value={path} placeholder="data.title" maxLength={200} onChange={event=>setPath(event.target.value)}/></label><label className="field-label">출력 항목 형식<select aria-label="출력 항목 형식" value={type} onChange={event=>setType(event.target.value as DataSchema["type"])}>{Object.entries(dataTypeNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button type="button" className="text-btn" disabled={!path.trim()} onClick={()=>update(path.trim(),type)}>출력 형식 적용</button>{error&&<p className="form-error" role="alert">{error}</p>}
    {node.outputSchema&&<button type="button" className="text-btn" onClick={()=>{const next={...node};delete next.outputSchema;onChange(next);setError("");}}>전체 출력 형식 제한 해제</button>}
  </details>;
}
