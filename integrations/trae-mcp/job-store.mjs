import {mkdir,open,rename,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const states=new Set(['RUNNING','COMPLETED','EXITED_NONZERO','START_FAILED','TIMED_OUT','OUTPUT_LIMIT']);
export class JobStore {
 constructor(root){this.root=path.join(root,'.jobs');}
 async save(job){
  if(!uuid.test(job.id))throw Error('LOCAL_JOB_INVALID');
  await mkdir(this.root,{recursive:true,mode:0o700});
  const root=await realpath(this.root);
  const target=path.join(root,job.id+'.json'),temporary=path.join(root,job.id+'.'+randomUUID()+'.tmp');
  // No command arguments, stdout, environment, session path or credential contents are persisted.
  const record={schema:1,id:job.id,program:job.program,engineSha:job.engineSha,state:job.state,
   exitCode:job.exitCode??null,signal:job.signal??null,createdAt:job.createdAt,
   ...(job.artifactDirectory?{artifactDirectory:job.artifactDirectory}:{})};
  const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
  await rename(temporary,target);
 }
 async load(id){
  if(typeof id!=='string'||!uuid.test(id))throw Error('LOCAL_JOB_NOT_FOUND');
  let file;
  try{file=await open(path.join(this.root,id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch{throw Error('LOCAL_JOB_NOT_FOUND');}
  try{
   const stat=await file.stat();if(!stat.isFile()||stat.size>16384)throw Error('LOCAL_JOB_INVALID');
   const record=JSON.parse(await file.readFile('utf8'));
   if(record.schema!==1||record.id!==id||!states.has(record.state)||!/^[a-f0-9]{40}$/.test(record.engineSha)
    ||typeof record.program!=='string'||!Number.isFinite(record.createdAt)
    ||(record.artifactDirectory&&(!path.isAbsolute(record.artifactDirectory)||path.basename(record.artifactDirectory)!=='mcp-'+id)))throw Error('LOCAL_JOB_INVALID');
   return {...record,state:record.state==='RUNNING'?'UNKNOWN_AFTER_RESTART':record.state,
    output:'',truncated:false,restored:true};
  }finally{await file.close();}
 }
}
