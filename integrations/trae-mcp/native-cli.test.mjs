import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeCli,CLI_TOOL} from './native-cli.mjs';
import {localReport} from './local-artifacts.mjs';
const engineRoot=fileURLToPath(new URL('../../',import.meta.url));
const engineSha='0'.repeat(40);
const create=options=>new NativeCli({engineRoot,engineSha,...options});
async function wait(cli,id){for(let i=0;i<200;i++){const r=await cli.invoke({action:'status',job_id:id});if(r.state!=='RUNNING')return r;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('TEST_TIMEOUT');}

test('requires a pinned engine and exposes the full Playwright program',async()=>{
 assert.throws(()=>new NativeCli({engineRoot}),/PINNED_ENGINE_REQUIRED/);
 const catalog=await create().invoke({action:'catalog'});
 assert.equal(catalog.engineSha,engineSha);assert.equal(catalog.programs.playwright,'run-playwright-cli');
 assert.ok(catalog.devtestCommands.includes('playwright --help'));
 assert.ok(CLI_TOOL.inputSchema.properties.session_file);
});
test('help and mock-only execution produce accessible evidence and Markdown',async()=>{
 const artifactRoot=await mkdtemp(path.join(tmpdir(),'panqu-mcp-mock-'));
 const cli=create({artifactRoot});
 try{
  const help=await cli.invoke({action:'start',program:'playwright',project_root:engineRoot,args:['--help']});
  assert.equal((await wait(cli,help.jobId)).exitCode,0);
  const job=await cli.invoke({action:'start',program:'playwright',project_root:engineRoot,args:['--mock','--media','video']});
  const done=await wait(cli,job.jobId);assert.notEqual(done.state,'RUNNING');
  const report=await cli.report(job.jobId);assert.equal(report.available,true);assert.equal(report.files.length,2);
  const file=report.files.find(f=>f.endsWith('-evidence.json'));
  const part=await cli.report(job.jobId,{file,limit:65536});const evidence=JSON.parse(part.content);
  assert.equal(evidence.executionMode,'MOCK');assert.equal(done.exitCode,evidence.testAssertionStatus==='PASS'?0:1);
  const cases=await cli.cases(job.jobId);assert.equal(cases.protocol,'PLAYWRIGHT_FLOW_EVIDENCE');assert.equal(cases.total,1);
 }finally{cli.dispose();}
});
test('a prompt containing --mock cannot bypass real-execution confirmation',async()=>{
 const cli=create();
 for(const args of [['--mode','api','--prompt','--mock'],['--mode','browser']]){
  await assert.rejects(cli.invoke({action:'start',program:'playwright',project_root:engineRoot,args}),/REAL_EXECUTION_CONFIRMATION_REQUIRED/);
 }
 await assert.rejects(cli.invoke({action:'start',program:'playwright',project_root:engineRoot,args:'--mock'}),/INPUT_DENIED/);
 for(const args of [['flow','playwright-diversion','--real-submit'],['business-suite','--module','playwright']]){
  await assert.rejects(cli.invoke({action:'start',program:'devtest',project_root:engineRoot,args}),/REAL_EXECUTION_CONFIRMATION_REQUIRED/);
 }
});
test('only a session path enters the child environment and credentials are not read',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'panqu-mcp-session-'));
 const sessionFile=path.join(root,'session.json');await writeFile(sessionFile,'synthetic-not-json',{mode:0o600});
 let captured;
 const cli=create({spawnProcess:(command,args,options)=>{
  captured={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  setImmediate(()=>child.emit('close',0,null));return child;
 }});
 const job=await cli.invoke({action:'start',program:'playwright',project_root:engineRoot,args:['--help'],session_file:sessionFile});
 await wait(cli,job.jobId);
 assert.equal(captured.options.env.PANQU_SESSION_COOKIES_FILE,await realpath(sessionFile));
 assert.deepEqual(Object.keys(captured.options.env).sort(),['HOME','PANQU_SESSION_COOKIES_FILE','PATH']);
 assert.ok(!captured.args.includes(sessionFile));assert.equal(captured.options.shell,false);
});
test('report pagination redacts before slicing and rejects arbitrary files and symlinks',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'panqu-mcp-report-'));
 const file='CASE-1-evidence.json';await writeFile(path.join(root,file),JSON.stringify({authorization:'synthetic-value',message:'PHPSESSID=synthetic-session'}));
 await writeFile(path.join(root,'trace.zip'),'not-exposed');
 const job={id:'fixture',state:'COMPLETED',artifactDirectory:await realpath(root),engineSha};
 const full=await localReport(job,{file,limit:65536});assert.doesNotMatch(full.content,/synthetic-value|synthetic-session/);
 assert.equal((await localReport(job,{file,offset:5,limit:7})).content,full.content.slice(5,12));
 for(const denied of ['trace.zip','../session.json','/etc/passwd'])await assert.rejects(localReport(job,{file:denied}),/LOCAL_ARTIFACT_DENIED/);
 await symlink(path.join(root,file),path.join(root,'CASE-2-evidence.json'));
 await assert.rejects(localReport(job,{file:'CASE-2-evidence.json'}),/LOCAL_ARTIFACT_DENIED/);
 await assert.rejects(localReport(job,{file,limit:65537}),/INPUT_DENIED/);
 await assert.rejects(localReport({...job,state:'RUNNING'}),/LOCAL_JOB_STILL_RUNNING/);
});
