import {open,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

const flowReports=['panqu-business-suite-report.json','业务全模块综合自测报告.md',
 'real-video-flow-report.json','真实视频提交流程测试报告.md',
 'real-image-flow-report.json','真实生图提交流程测试报告.md',
 'real-canvas-flow-report.json','真实画布节点提交流程测试报告.md'];
const allowed=name=>/^[A-Za-z0-9_-]+-(?:evidence\.json|playwright-report\.md)$/.test(name)||flowReports.includes(name);
export const redactLocal=text=>text
 .replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]')
 .replace(/((?:PHPSESSID|fastadmin_sid)=)[^\s;"']+/gi,'$1[REDACTED]')
 .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g,'[REDACTED]')
 .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
const sensitive=/^(?:cookie|cookies|cookie_string|authorization|token|access_token|refresh_token|api[_-]?key|secret|password|session|headers)$/i;
const sanitize=value=>Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':sanitize(v)]))
 :typeof value==='string'?redactLocal(value):value;

export async function localReport(job,{file,offset=0,limit=32768}={}) {
 if(!job)throw Error('LOCAL_JOB_NOT_FOUND');
 if(job.child||job.state==='RUNNING')throw Error('LOCAL_JOB_STILL_RUNNING');
 if(!job.artifactDirectory)throw Error('LOCAL_REPORT_NOT_AVAILABLE');
 if(await realpath(job.artifactDirectory)!==job.artifactDirectory)throw Error('LOCAL_ARTIFACT_DENIED');
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>65536)throw Error('INPUT_DENIED');
 const names=(await readdir(job.artifactDirectory)).filter(allowed).sort();
 if(file!==undefined&&(!allowed(file)||!names.includes(file)))throw Error('LOCAL_ARTIFACT_DENIED');
 const base={localJobId:job.id,executionLocation:'LOCAL_MAC',engineSha:job.engineSha,files:names,directory:job.artifactDirectory,state:job.state,incomplete:job.state==='UNKNOWN_AFTER_RESTART',
  note:'仅提供本地任务产生的脱敏 Markdown/JSON；不读取原始 trace、会话文件或任意路径。'};
 if(file===undefined)return {...base,available:names.length>0};
 // Never follow a symlink to a session/config file, even if it uses an allowed filename.
 let handle;
 try{handle=await open(path.join(job.artifactDirectory,file),constants.O_RDONLY|constants.O_NOFOLLOW);}
 catch{throw Error('LOCAL_ARTIFACT_DENIED');}
 try{
  const metadata=await handle.stat();
  if(!metadata.isFile()||metadata.size>16777216)throw Error('LOCAL_ARTIFACT_TOO_LARGE');
  const raw=await handle.readFile('utf8');
  // Redact before pagination so a boundary cannot split a credential pattern.
  const text=file.endsWith('.json')?JSON.stringify(sanitize(JSON.parse(raw)),null,2):redactLocal(raw);
  return {...base,file,offset,totalCharacters:text.length,content:text.slice(offset,offset+limit),
   nextOffset:offset+limit<text.length?offset+limit:null};
 }finally{await handle.close();}
}

export async function localCases(job,{offset=0,limit=5}={}) {
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw Error('INPUT_DENIED');
 const listing=await localReport(job);
 const files=listing.files.filter(f=>f.endsWith('.json'));
 // Each flow is an evidence record, not a fabricated TEST_CASE_V2 case.
 return {...listing,protocol:files.every(f=>f.endsWith('-evidence.json'))?'PLAYWRIGHT_FLOW_EVIDENCE':'PANQU_FLOW_EVIDENCE',total:files.length,offset,
  cases:files.slice(offset,offset+limit).map(file=>({file,readWith:'panqu_report',local_job_id:job.id})),
  nextOffset:offset+limit<files.length?offset+limit:null};
}
