"use client";
import { useId, useRef } from "react";

export type FilePickerProps = { label: string; accept?: string; multiple?: boolean; disabled?: boolean; files?: { name: string; size: number }[]; error?: string; help?: string; onFiles: (files: File[]) => void | Promise<void> };

/** 네이티브 선택과 드롭을 같은 콜백으로 보낸다. 여기서는 업로드·추출·실행 성공을 판단하지 않는다. */
export function FilePicker({ label, accept, multiple = false, disabled, files = [], error, help, onFiles }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null), id = useId();
  function choose(selected: FileList | null) { if (!selected || disabled) return; const items = Array.from(selected); if (items.length) void onFiles(multiple ? items : items.slice(0, 1)); }
  return <section className={`file-picker ${error ? "file-picker-error" : ""}`} aria-labelledby={`${id}-label`} onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files); }}><strong id={`${id}-label`}>{label}</strong><input ref={input} id={id} type="file" accept={accept} multiple={multiple} disabled={disabled} hidden onChange={event => { choose(event.target.files); event.target.value = ""; }} /><button type="button" className="btn secondary" disabled={disabled} onClick={() => input.current?.click()} aria-describedby={`${id}-help`}>파일 선택</button><p id={`${id}-help`} className="field-help">{help || "파일을 선택하거나 이 영역에 끌어 놓으세요."}</p>{files.length > 0 && <ul className="file-picker-files">{files.map((file, index) => <li key={`${file.name}:${index}`}><span>{file.name}</span><small>{file.size.toLocaleString()} bytes</small></li>)}</ul>}{error && <p className="form-error" role="alert">{error}</p>}</section>;
}
