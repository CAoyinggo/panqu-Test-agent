#!/usr/bin/env node
// 一键执行脚本：按 SOP 流程执行功能测试，生成 HTML 报告
// 插件式架构：通用骨架（登录态/素材/影响分析/计费/报告）+ scene 路由到场景处理器
// 用法：
//   node run-test.js --task ../tasks/<任务名>.json            # 默认 test 环境
//   node run-test.js --task ../tasks/<任务名>.json --env=preonline
//   node run-test.js --help
const fs = require('fs');
const path = require('path');
const { Http } = require('./lib/http');
const { Billing } = require('./lib/billing');
const { Isolation } = require('./lib/isolation');
const { writeReport } = require('./lib/report');
const { Assets, collectAssetRefs } = require('./lib/assets');
const { VideoSceneHandler } = require('./lib/scenes/video');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ===== 场景处理器注册表（插件式：新模块在此注册即可） =====
const SCENES = {
  video: new VideoSceneHandler(),
};

function findHandler(scene) {
  for (const h of Object.values(SCENES)) {
    if (h.match(scene)) return h;
  }
  return null;
}

function parseArgs(argv) {
  const args = { task: null, env: null, func: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--func') args.func = argv[++i];
    else if (a === '--help') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`用法：
  node run-test.js --task <任务定义.json> [--env=test|preonline]

参数：
  --task   任务定义 JSON 路径（必填），示例见 tasks/_template.json
  --env    执行环境，默认 test，可选 preonline
  --func   功能名称（归档目录 output/<日期>/<功能名>/，强制约定）
  --help   显示帮助`);
    return;
  }

  if (!args.task) {
    console.error('缺少 --task 参数（任务定义 JSON 路径）。示例：node run-test.js --task ../tasks/wan3-wensheng.json');
    process.exit(1);
  }

  const env = args.env || CFG.default_env;
  if (!CFG.environments[env]) {
    console.error(`未知环境 ${env}，可选：${Object.keys(CFG.environments).join(', ')}`);
    process.exit(1);
  }

  // ===== 1. 加载任务定义 =====
  const taskPath = path.resolve(__dirname, args.task);
  if (!fs.existsSync(taskPath)) {
    console.error(`任务定义文件不存在：${taskPath}`);
    process.exit(1);
  }
  const taskDef = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
  console.log(`\n========== 开始执行：${taskDef.name}（${env} 环境） ==========`);

  // ===== 2. 场景路由 =====
  const handler = findHandler(taskDef.scene);
  const semiAuto = !handler;
  console.log(`场景类型：${taskDef.scene} → ${handler ? `已接入（${handler.name}）` : '未接入（半自动执行）'}`);

  // ===== 3. 数据需求清单检查 =====
  console.log('\n[1/10] 数据需求清单检查...');
  const session = Http.loadSession(CFG.session_cookies_path, env);
  const baseUrl = CFG.environments[env].base_url;
  if (!session.cookie_string) throw new Error('登录态为空，请检查 session-cookies.json');
  const exp = new Date(session.token_exp * 1000);
  console.log(`  登录态：${session.account || session.nickname}（过期时间 ${exp.toLocaleString('zh-CN')}）`);
  if (exp < new Date()) console.log('  ⚠ 登录态已过期，请重新提供');
  else console.log('  登录态有效');

  // ===== 4. 素材库扫描 =====
  console.log('\n[2/10] 素材库检查（Test-panqu）...');
  const assets = new Assets();
  const assetScan = assets.scan();
  if (assetScan.exists) {
    console.log('  image=' + assetScan.byType.image.length + ' | audio=' + assetScan.byType.audio.length + ' | video=' + assetScan.byType.video.length + ' | text=' + assetScan.byType.text.length);
  }

  // ===== 5. 影响分析（静态） =====
  console.log('\n[3/10] 数据隔离/影响分析...');
  const iso = new Isolation();
  const impact = iso.buildImpactList(taskDef);

  // ===== 6. 执行（通用骨架 + 场景处理器） =====
  const http = new Http(baseUrl, session.cookie_string);
  const billing = new Billing(http, CFG.environments[env].billing_url);
  const responses = [];
  let taskId = taskDef.task_id || null;
  const submit = {};

  // 6.1 素材引用收集
  console.log('\n[4/10] 素材引用解析...');
  const resolvedAssets = [];
  for (const [k, v] of Object.entries(taskDef.extra || {})) {
    for (const rp of collectAssetRefs(v)) {
      const full = assets.resolve(rp);
      resolvedAssets.push({ field: k, path: rp, full: full || '(未找到)' });
      console.log(`  ${k}: ${rp} -> ${full || '⚠ 未找到'}`);
    }
  }
  if (taskDef.uploads && Array.isArray(taskDef.uploads)) {
    for (const u of taskDef.uploads) {
      const full = assets.resolve(u.path);
      resolvedAssets.push({ field: u.field, path: u.path, full: full || '(未找到)' });
      console.log(`  ${u.field}: ${u.path} -> ${full || '⚠ 未找到'}`);
    }
  }

  // 6.2 提交任务（若有已存在 task_id 则复用）
  if (!taskId) {
    if (handler) {
      console.log('\n[5/10] 提交任务...');
      const r = await handler.submit({ http, session, taskDef, assets, CFG, env, responses });
      taskId = r.taskId;
      Object.assign(submit, r.submit);
      if (r.submit.err) console.log('  提交失败：' + r.submit.err);
    } else {
      console.log('\n[5/10] 未接入处理器，跳过自动提交（半自动执行）...');
      submit.status = '半自动（待人工）';
      submit.err = '该场景未接入脚本处理器，需人工操作或后续接入';
    }
  } else {
    console.log('\n[5/10] 使用已有任务 ID：' + taskId + '（跳过提交）');
    submit.taskId = taskId;
    submit.status = '使用已有任务';
  }

  // 6.3 查询任务详情 + 状态（仅已接入处理器且有任务 ID）
  if (taskId && handler) {
    console.log('\n[6/10] 查询任务详情（落库核对）...');
    await handler.detail({ http, session, taskDef, CFG, env, responses, submit, taskId });

    console.log('\n[7/10] 查询任务状态...');
    await handler.status({ http, session, taskDef, CFG, env, responses, submit, taskId });
  }

  // 6.4 计费核验（通用拉取 + 场景处理器分析）
  console.log('\n[8/10] 计费核验...');
  let billingData = {};
  try {
    const summary = await billing.summary();
    const trend = await billing.modelTrend();
    const top = await billing.modelTop();
    const records = await billing.records(50);
    billingData = handler
      ? handler.analyzeBilling({ summary, trend, top, records }, session)
      : { summary, trend, top, records, modelTrend: { found: false, modelName: taskDef.model_name || '' }, net: 0 };
    const mt = billingData.modelTrend || {};
    console.log('  summary: consumed_7d=' + summary.consumed_7d + ', available_points=' + summary.available_points);
    console.log('  模型趋势: ' + (mt.found ? (mt.modelName + ' 最新值=' + mt.lastValue) : '未找到对应模型系列'));
    console.log('  近50条明细净消耗=' + billingData.net);
  } catch (e) {
    console.log('  计费核验异常：' + e.message);
  }

  // ===== 7. 数据隔离核验（动态） =====
  console.log('\n[9/10] 数据隔离核验...');
  const verifyDef = { ...taskDef, account: session.account || session.nickname, project_id: session.project_id };
  const checks = iso.verify(verifyDef, submit, billingData);
  checks.forEach(c => console.log('  ' + (c.pass ? '✅' : '❌') + ' ' + c.name + '：' + c.detail));

  // ===== 8. 生成报告 =====
  console.log('\n[10/10] 生成 HTML 报告...');
  const pad2 = n => String(n).padStart(2, '0');
  const _d = new Date();
  const today = `${_d.getFullYear()}-${pad2(_d.getMonth() + 1)}-${pad2(_d.getDate())}`;
  const _func = (args.func || '').trim();
  const outputDir = _func ? `/Users/mac/agents/output/${today}/${_func}` : `/Users/mac/agents/output/${today}`;
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const manual = (taskDef.manual_cases || []).map(m => ({ id: m.id, steps: m.steps }));

  // 问题卡点
  const issues = [];
  if (submit.status === '失败') {
    issues.push({ level: '阻塞', title: '任务生成失败', desc: submit.err || '模型接入点或账号权限问题' });
  }
  if (semiAuto) {
    issues.push({ level: '待接入', title: '场景未接入脚本处理器', desc: '半自动执行：需人工完成主链路，后续在 lib/scenes/ 新增处理器接入' });
  }
  if (billingData.modelTrend && !billingData.modelTrend.found) {
    issues.push({ level: '数据异常', title: '模型趋势中未统计到本次模型', desc: '需确认计费统计是否覆盖当前模型' });
  }
  checks.filter(c => !c.pass).forEach(c => issues.push({ level: '数据异常', title: c.name, desc: c.detail }));

  const passCount = checks.filter(c => c.pass).length;
  const passRate = checks.length ? Math.round(passCount / checks.length * 100) : 100;

  const assetInfo = {
    exists: assetScan.exists,
    counts: assetScan.exists
      ? { image: assetScan.byType.image.length, audio: assetScan.byType.audio.length, video: assetScan.byType.video.length, text: assetScan.byType.text.length }
      : null,
    resolved: resolvedAssets,
  };

  const reportPath = writeReport(outputDir, taskDef.name, {
    title: taskDef.name + ' 测试报告',
    env,
    taskDef: { ...taskDef, project_id: session.project_id, account: session.account || session.nickname },
    submit,
    billingData,
    impact,
    checks,
    responses,
    manual,
    issues,
    passRate,
    assetInfo,
  });

  console.log('\n========== 执行完成 ==========');
  console.log('报告已生成：' + reportPath);
  if (semiAuto) console.log('⚠ 半自动执行：请人工完成主链路并反馈，后续可在 lib/scenes/ 接入该场景。');
  else console.log('请人工完成浏览器用例并反馈结果。');
}

main().catch(e => {
  console.error('执行出错：', e.message);
  process.exit(1);
});
