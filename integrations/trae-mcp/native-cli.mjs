import {spawn} from 'node:child_process';
import {realpath,stat,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {localReport,localCases,redactLocal} from './local-artifacts.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const PROGRAMS=Object.freeze({validate:'panqu-agent-cli',devtest:'run-devtest',playwright:'run-playwright-cli',agent:'run-agent',acceptance:'run-acceptance',self_test:'run-self-test',test:'run-test',plan:'run-plan',preflight:'preflight',health:'health',evaluation:'eval-cli',ai_quality:'ai-quality-cli',autonomous:'run-autonomous',autonomous_pipeline:'run-autonomous-pipeline',platform:'platform-cli',operations:'phase51-cli',cost:'cost-cli',pilot:'run-pilot',release_gate:'release-gate',dashboard:'dashboard'});
export const CLI_TOOL={name:'panqu_native_cli',description:'运行 GitHub 固定提交的原生 CLI（LOCAL_MAC），覆盖 mission、源码观察、API 分流、评估、平台和成本工具。catalog 查看入口；start 按原生参数运行；status 取结果。先读该命令文档。参数不是 shell。涉及业务写入、费用、发布或部署时必须有用户对该具体操作的明确授权及原生批准文件；接入工具不代表允许实际执行。不得在参数中传 Cookie/API Key，使用项目安全配置。',inputSchema:{type:'object',additionalProperties:false,properties:{action:{enum:['catalog','start','status']},program:{enum:Object.keys(PROGRAMS)},project_root:{type:'string'},args:{type:'array',items:{type:'string'},maxItems:80},job_id:{type:'string'},timeout_ms:{type:'integer',minimum:1000,maximum:600000}},required:['action']}};
CLI_TOOL.inputSchema.properties.session_file={type:'string',description:'可选的会话 JSON 文件绝对路径。只传路径，禁止凭据正文。覆盖 PANQU_SESSION_COOKIES_FILE。'};
CLI_TOOL.inputSchema.properties.confirm_real_execution={type:'boolean',description:'只有用户明确授权本次真实 Playwright 操作及费用后才可为 true；--mock/--help 不需要。'};
CLI_TOOL.description+=' program=playwright 暴露完整 CLI（先用 --help）。本地报告通过 panqu_report/panqu_cases 的 local_job_id 读取；原始 trace 不通过 MCP 返回。';
const redact=redactLocal;
export class NativeCli {
 constructor({spawnProcess=spawn,engineRoot,engineSha,artifactRoot=path.join(homedir(),'panqu-remote-reports','local')}={}){if(!path.isAbsolute(engineRoot??'')||!/^[a-f0-9]{40}$/.test(engineSha??''))throw Error('PINNED_ENGINE_REQUIRED');this.engineSha=engineSha;this.jobs=new Map();this.spawn=spawnProcess;this.engineRoot=engineRoot;this.artifactRoot=artifactRoot;}
 snapshot(j){return {jobId:j.id,program:j.program,state:j.state,exitCode:j.exitCode??null,signal:j.signal??null,output:redact(j.output),truncated:j.truncated,executionLocation:'LOCAL_MAC',engineSha:this.engineSha,...(j.artifactDirectory?{report:{tool:'panqu_report',local_job_id:j.id}}:{})};}
 report(id,args={}){return localReport(this.jobs.get(id),args);}
 cases(id,args={}){return localCases(this.jobs.get(id),args);}
 async invoke(input){
  if(!input||Object.keys(input).some(k=>!['action','program','project_root','args','job_id','timeout_ms','session_file','confirm_real_execution'].includes(k)))throw Error('INPUT_DENIED');
  if(input.action==='catalog')return {engineSha:this.engineSha,executionLocation:'LOCAL_MAC',programs:PROGRAMS,devtestCommands:['doctor','plan','execute','status','inspect-project','mission','playwright --help','flow api-diversion','flow playwright-diversion','flow real-video-submit','flow real-image-submit','flow real-canvas-submit','flow business-suite'],note:'这些是仓库原生入口，不表示所需服务、凭据和测试数据已经配置。start 是实际运行，先确认范围和原生命令参数。Playwright 和 real-* 流程可能真实提交并产生费用，必须取得该具体操作授权；Mock 通过不代表业务验收通过。'};
  if(input.action==='status'){const j=this.jobs.get(input.job_id);if(!j)throw Error('LOCAL_JOB_NOT_FOUND');return this.snapshot(j);}
  if(input.action!=='start'||!Object.hasOwn(PROGRAMS,input.program)||typeof input.project_root!=='string'||!path.isAbsolute(input.project_root))throw Error('INPUT_DENIED');
  if(!Array.isArray(input.args??[]))throw Error('INPUT_DENIED');
  const args=[...(input.args??[])];if(args.length>80||args.some(x=>typeof x!=='string'||x.length>4096||/[\x00\r\n]/.test(x)))throw Error('INPUT_DENIED');
  if(args.some(x=>/PHPSESSID|Bearer\s|(?:^|[-_])(?:api[-_]?key|password|cookie|token|secret)(?:=|$)|\b(?:sk-|ghp_|github_pat_)/i.test(x)))throw Error('SECRETS_NOT_ALLOWED_IN_ARGUMENTS');
  const timeout=input.timeout_ms??120000;if(!Number.isInteger(timeout)||timeout<1000||timeout>600000)throw Error('INPUT_DENIED');
  if([...this.jobs.values()].some(j=>j.state==='RUNNING'))throw Error('LOCAL_JOB_ALREADY_RUNNING');
  const cwd=await realpath(input.project_root);if(!(await stat(cwd)).isDirectory())throw Error('PROJECT_DIRECTORY_REQUIRED');
  const script=input.program==='validate'?path.join(this.engineRoot,'packages/panqu-agent-cli/bin/panqu-test-agent.mjs'):input.program==='playwright'?path.join(this.engineRoot,'dist/src/devtest/run-playwright-cli.js'):path.join(this.engineRoot,'dist/bin',PROGRAMS[input.program]+'.js');
  const env={PATH:process.env.PATH,HOME:process.env.HOME};
  const sessionFile=input.session_file??process.env.PANQU_SESSION_COOKIES_FILE;
  if(sessionFile!==undefined){
   if(typeof sessionFile!=='string'||!path.isAbsolute(sessionFile)||/[\x00\r\n]/.test(sessionFile))throw Error('SESSION_PATH_INVALID');
   const resolved=await realpath(sessionFile);if(!(await stat(resolved)).isFile())throw Error('SESSION_PATH_INVALID');
   env.PANQU_SESSION_COOKIES_FILE=resolved;
  }
  const playwright=input.program==='playwright'||(input.program==='devtest'&&args[0]==='playwright');
  const flowPlaywright=input.program==='devtest'&&args[0]==='flow'&&(args[1]==='playwright-diversion'||(args[1]==='api-diversion'&&args.includes('--playwright')));
  const businessSuite=input.program==='devtest'&&(args[0]==='business-suite'||(args[0]==='flow'&&args[1]==='business-suite'));
  const reportable=playwright||flowPlaywright||businessSuite;
  const help=args.includes('--help')||args.includes('-h');
  let mock=false;
  if(playwright&&!help){
   const {parseCliArgs}=await import(pathToFileURL(path.join(this.engineRoot,'dist/src/devtest/run-playwright-cli.js')).href);
   mock=parseCliArgs(input.program==='playwright'?args:args.slice(1)).isMock;
  }
  if(flowPlaywright)mock=!args.includes('--real-submit');
  if(reportable&&!help&&!mock&&input.confirm_real_execution!==true)throw Error('REAL_EXECUTION_CONFIRMATION_REQUIRED');
  const id=randomUUID(),j={id,program:input.program,state:'RUNNING',output:'',truncated:false,engineSha:this.engineSha};
  if(reportable&&!help){
   // A private per-job subdirectory keeps old files and unrelated credentials out of report reads.
   const outputIndex=args.lastIndexOf('--output');
   if(outputIndex>=0&&(!args[outputIndex+1]||args[outputIndex+1].startsWith('--')))throw Error('INPUT_DENIED');
   const parent=outputIndex>=0?path.resolve(cwd,args[outputIndex+1]):this.artifactRoot;
   const directory=path.join(parent,'mcp-'+id);await mkdir(directory,{recursive:true,mode:0o700});
   j.artifactDirectory=await realpath(directory);
   if(outputIndex>=0)args[outputIndex+1]=j.artifactDirectory;else args.push('--output',j.artifactDirectory);
  }
  this.jobs.set(id,j);
  const child=this.spawn(process.execPath,[script,...args],{cwd,shell:false,detached:true,stdio:['ignore','pipe','pipe'],env});j.child=child;
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{};j.kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);j.kill.unref();};
  const timer=setTimeout(()=>{j.state='TIMED_OUT';stop();},timeout);timer.unref();
  const collect=buf=>{const left=1048576-Buffer.byteLength(j.output);if(left>0)j.output+=buf.subarray(0,left).toString();if(buf.length>left){j.truncated=true;j.state='OUTPUT_LIMIT';stop();}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.on('error',()=>{j.state='START_FAILED';clearTimeout(timer);});
  child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(j.kill);if(j.state==='RUNNING')j.state=code===0?'COMPLETED':'EXITED_NONZERO';j.exitCode=code;j.signal=signal;delete j.child;});
  return this.snapshot(j);
 }
 dispose(){for(const j of this.jobs.values())if(j.child){try{process.kill(-j.child.pid,'SIGTERM');}catch{}}}
}
