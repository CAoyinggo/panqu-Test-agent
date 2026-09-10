/** Read-only Panqu source observations. Never execute repository code or infer product requirements. */
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import type { PanquProjectContext, PanquProjectAssessment, PanquSourceAction, PanquResponseProtocol } from './panqu-project-types.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ignored = new Set(['node_modules', '.git', '.trae', '.codex', '.next', '.nuxt', '.output', 'dist', 'build', 'coverage', 'vendor', 'devtest-results']);
const sourceExtension = /\.(?:[cm]?[jt]sx?|vue)$/;
const literal = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
function visit(node: ts.Node, callback: (node: ts.Node) => void) { callback(node); node.forEachChild(child => visit(child, callback)); }
function functionOf(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) return parent;
  }
  return undefined;
}
function symbolOf(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name) return parent.name.getText();
  }
  return '<anonymous>';
}

async function extractThinkPhpRoutes(routePath: string, relPath: string): Promise<PanquSourceAction[]> {
  const actions: PanquSourceAction[] = [];
  try {
    const text = await readFile(routePath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')) continue;
      const match = line.match(/Route::(get|post|put|delete|patch|rule)\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/i);
      if (match) {
        const rawMethod = match[1].toUpperCase();
        let p = match[2].replace(/\$$/, '');
        if (!p.startsWith('/')) p = '/' + p;
        const symbol = match[3];
        const method = rawMethod === 'RULE' ? undefined : rawMethod;
        actions.push({
          id: `${relPath}:${i + 1}`,
          symbol,
          wrapper: 'ThinkPHP::Route',
          path: p,
          method,
          methodBasis: method ? 'EXPLICIT' : 'UNRESOLVED',
          body: method === 'GET' ? 'NONE' : 'JSON',
          responseProtocol: 'PHP_CODE_1',
          source: { file: relPath, line: i + 1, sha256: hash(line) },
          wrapperSource: { file: relPath, line: i + 1, sha256: hash(line) },
          unresolved: method ? [] : ['Route::rule accepts multiple HTTP methods; requires runtime binding'],
        });
      }
    }
  } catch {}
  return actions;
}

/** Inspection bounds and omissions are part of the returned evidence, not silently treated as coverage. */
export async function inspectPanquProject(projectRoot: string, options: { changedFiles?: string[]; maxFiles?: number } = {}): Promise<PanquProjectContext> {
  const root = path.resolve(projectRoot);
  const context: PanquProjectContext = { schema: 'panqu.project.v1', provenance: 'SOURCE_OBSERVATION_ONLY', host: 'UNKNOWN', fingerprint: '', complete: true,
    sources: [], actions: [], nodes: [], changedFiles: [...new Set(options.changedFiles ?? [])].sort(), affectedFiles: [], regressionCandidates: [], diagnostics: [] };
  const issue = (code: string, message: string, file?: string) => { context.complete = false; context.diagnostics.push({ code, message, file }); };
  const files = new Map<string, { text: string; ast: ts.SourceFile }>();
  let manifest = '';
  let isMonorepo = false;
  let isThinkPhp = false;
  const detectedSubmodules: string[] = [];

  // Refuse symlink ancestors as well as children; never follow an external source tree.
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) { issue('PANQU_SOURCE_SYMLINK', 'Project ancestry contains a symlink'); context.fingerprint = hash('symlink'); return context; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; context.fingerprint = hash('missing'); return context; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  try {
    const info = await lstat(path.join(root, 'package.json'));
    if (info.isSymbolicLink() || info.size > 1024 * 1024) { issue('PANQU_MANIFEST_UNREADABLE', 'Unsafe manifest omitted'); context.fingerprint = hash('unsafe-manifest'); return context; }
    manifest = await readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(manifest); const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasVueFlow = Boolean(deps.nuxt && deps['@vue-flow/core']);
    const hasXyFlow = Boolean(deps.next && deps['@xyflow/react']);
    if (!hasVueFlow && !hasXyFlow) {
      try {
        if ((await lstat(path.join(root, 'application', 'route.php'))).isFile()) isThinkPhp = true;
      } catch {}
      if (!isThinkPhp) {
        const candidateDirs = ['aibaseos', 'aiworkflow', 'aidrawos', 'aipanqucenter', 'aipanco'];
        for (const dir of candidateDirs) {
          try {
            if ((await lstat(path.join(root, dir))).isDirectory()) detectedSubmodules.push(dir);
          } catch {}
        }
        if (detectedSubmodules.length > 0) isMonorepo = true;
        else { context.fingerprint = hash(manifest); return context; }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const candidateDirs = ['aibaseos', 'aiworkflow', 'aidrawos', 'aipanqucenter', 'aipanco'];
      for (const dir of candidateDirs) {
        try {
          if ((await lstat(path.join(root, dir))).isDirectory()) detectedSubmodules.push(dir);
        } catch {}
      }
      if (detectedSubmodules.length > 0) {
        isMonorepo = true;
      } else {
        try {
          if ((await lstat(path.join(root, 'application', 'route.php'))).isFile()) isThinkPhp = true;
        } catch {}
        if (!isThinkPhp) {
          context.fingerprint = hash('missing');
          return context;
        }
      }
    } else {
      issue('PANQU_MANIFEST_PARSE_ERROR', 'Manifest unavailable or invalid');
      context.fingerprint = hash(manifest);
      return context;
    }
  }
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 3000, 10000));
  let entries = 0;
  async function scan(directory: string): Promise<void> {
    for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 20000) { issue('PANQU_SCAN_LIMIT', 'Directory entry limit reached'); return; }
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const file = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) { issue('PANQU_SOURCE_SYMLINK', 'Symlink omitted', file); continue; }
      if (entry.isDirectory()) { await scan(file); continue; }
      if (!entry.isFile() || !(sourceExtension.test(file) || file === 'package.json')) continue;
      if (files.size >= maxFiles) { if (!context.diagnostics.some(item => item.code === 'PANQU_SCAN_LIMIT')) issue('PANQU_SCAN_LIMIT', 'Source file limit reached'); continue; }
      if ((await lstat(path.join(root, file))).size > 1024 * 1024) { issue('PANQU_SCAN_LIMIT', 'Oversized source omitted', file); continue; }
      const text = await readFile(path.join(root, file), 'utf8');
      if (file === 'package.json') { manifest = text; continue; }
      // Preserve offsets for source references in SFC scripts. Template bytes still enter the fingerprint.
      const parsedText = file.endsWith('.vue') ? text.replace(/^[\s\S]*$/, whole => {
        const chars: string[] = whole.split('').map(char => char === '\n' ? '\n' : ' ');
        for (const match of whole.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
          const start = match.index! + match[0].indexOf('>') + 1;
          for (let index = 0; index < match[1].length; index++) chars[start + index] = match[1][index];
        }
        return chars.join('');
      }) : text;
      const ast = ts.createSourceFile(file, parsedText, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      files.set(file, { text, ast });
      const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      if (diagnostics.length) issue('PANQU_SOURCE_PARSE_ERROR', 'Source syntax could not be fully parsed', file);
    }
  }
  await scan('');
  if (isMonorepo) {
    context.host = 'PANQU_HYBRID_MONOREPO';
    context.submodules = detectedSubmodules;
    const phpRoutePath = path.join(root, 'aibaseos', 'application', 'route.php');
    try {
      if ((await lstat(phpRoutePath)).isFile()) {
        const phpActions = await extractThinkPhpRoutes(phpRoutePath, 'aibaseos/application/route.php');
        context.actions.push(...phpActions);
        context.sources.push({
          file: 'aibaseos/application/route.php',
          line: 1,
          sha256: hash(await readFile(phpRoutePath, 'utf8')),
          imports: [],
          exports: [...new Set(phpActions.map(a => a.symbol))],
        });
      }
    } catch {}
    for (const sub of detectedSubmodules) {
      const subDir = path.join(root, sub);
      if (sub === 'aiworkflow') {
        try {
          const testFiles = await readdir(path.join(subDir, 'test')).catch(() => []);
          for (const tf of testFiles) {
            if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(tf)) {
              context.regressionCandidates.push({ file: `aiworkflow/test/${tf}`, status: 'NOT_EXECUTED', evidenceLevel: 'UNCLASSIFIED_LOCAL_TEST' });
            }
          }
        } catch {}
      }
    }
  } else if (isThinkPhp) {
    context.host = 'THINKPHP_BACKEND';
    const phpRoutePath = path.join(root, 'application', 'route.php');
    try {
      if ((await lstat(phpRoutePath)).isFile()) {
        const phpActions = await extractThinkPhpRoutes(phpRoutePath, 'application/route.php');
        context.actions.push(...phpActions);
        context.sources.push({
          file: 'application/route.php',
          line: 1,
          sha256: hash(await readFile(phpRoutePath, 'utf8')),
          imports: [],
          exports: [...new Set(phpActions.map(a => a.symbol))],
        });
      }
    } catch {}
  } else {
    let dependencies: Record<string, unknown> = {};
    try { const pkg = JSON.parse(manifest || '{}'); dependencies = { ...pkg.dependencies, ...pkg.devDependencies }; }
    catch { issue('PANQU_MANIFEST_PARSE_ERROR', 'Package manifest is invalid'); }
    const nuxt = Boolean(dependencies.nuxt && dependencies['@vue-flow/core'] && files.has('composables/canvas-flow/core/use-plugin-registry.ts'));
    const react = Boolean(dependencies.next && dependencies['@xyflow/react'] && [...files.keys()].some(file => file.startsWith('components/nodes/')) && files.has('lib/api/request.ts'));
    context.host = nuxt && react ? 'AMBIGUOUS' : nuxt ? 'NUXT_VUE_FLOW' : react ? 'NEXT_XYFLOW' : 'UNKNOWN';
  }
  const resolve = (from: string, specifier: string): string | undefined => {
    const base = specifier.startsWith('~/') || specifier.startsWith('@/') ? specifier.slice(2) : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : undefined;
    if (!base || base.startsWith('../')) return undefined;
    return [base, base.replace(/\.js$/, '.ts'), ...['.ts', '.tsx', '.js', '.jsx', '.vue', '/index.ts', '/index.tsx'].map(ext => base + ext)].find(candidate => files.has(candidate));
  };
  const bindings = new Map<string, Map<string, { file: string; symbol: string }>>();
  for (const [file, { text, ast }] of files) {
    const imports: string[] = []; const exports: string[] = []; const locals = new Map<string, { file: string; symbol: string }>();
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement)) {
        const target = resolve(file, literal(statement.moduleSpecifier) ?? '');
        if (target) imports.push(target);
        const named = statement.importClause?.namedBindings;
        if (target && named && ts.isNamedImports(named)) for (const item of named.elements) locals.set(item.name.text, { file: target, symbol: item.propertyName?.text ?? item.name.text });
      }
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isFunctionDeclaration(statement) && statement.name) exports.push(statement.name.text);
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) exports.push(declaration.name.getText());
      }
    }
    bindings.set(file, locals);
    context.sources.push({ file, line: 1, sha256: hash(text), imports: [...new Set(imports)].sort(), exports });
  }
  context.fingerprint = hash(JSON.stringify({ host: context.host, manifest: hash(manifest), sources: context.sources, diagnostics: context.diagnostics }));
  if (context.host === 'UNKNOWN' || context.host === 'AMBIGUOUS') return context;
  if (!options.changedFiles) {
    try {
      const { stdout } = await promisify(execFile)('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const records = stdout.split('\0');
      for (let index = 0; index < records.length; index++) {
        const record = records[index]; if (!record) continue;
        context.changedFiles.push(record.slice(3));
        if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) context.changedFiles.push(records[++index]);
      }
      context.changedFiles = [...new Set(context.changedFiles)].filter(file => sourceExtension.test(file) && !file.split('/').some(part => part.startsWith('.') || ignored.has(part))).sort();
    } catch { context.diagnostics.push({ code: 'PANQU_CHANGE_SET_UNAVAILABLE', message: 'Git change set unavailable; regressions are unscoped candidates.' }); }
  }
  const reference = (file: string, node: ts.Node) => ({ file, line: files.get(file)!.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, sha256: hash(files.get(file)!.text) });
  const wrappers = new Map<string, { getDefault: boolean; protocol: PanquResponseProtocol; source: ReturnType<typeof reference> }>();
  for (const [file, { ast }] of files) {
    if (!['lib/api/request.ts', 'utils/myFetchInstance.ts'].includes(file)) continue;
    visit(ast, node => {
      if (!(ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
      const symbol = ts.isFunctionDeclaration(node) ? node.name?.text : symbolOf(node);
      if (!symbol || !['requestPHPApi', 'requestGOApi', 'myFetch'].includes(symbol)) return;
      const optionsParameter = node.parameters[1];
      let getDefault = Boolean(optionsParameter?.initializer && ts.isObjectLiteralExpression(optionsParameter.initializer) && !optionsParameter.initializer.properties.length);
      const optionNames = new Set([optionsParameter?.name.getText()]);
      visit(node, child => {
        if (ts.isVariableDeclaration(child) && child.initializer && ts.isIdentifier(child.initializer) && child.initializer.text === optionsParameter?.name.getText() && ts.isObjectBindingPattern(child.name)) {
          for (const binding of child.name.elements) if (binding.dotDotDotToken) optionNames.add(binding.name.getText());
        }
      });
      let fetchSeen = false; let protocol: PanquResponseProtocol = 'UNVERIFIED';
      visit(node, child => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'fetch') {
          fetchSeen = true;
          const forwarded = child.arguments[1];
          const direct = forwarded && ts.isIdentifier(forwarded) && optionNames.has(forwarded.text);
          const spread = forwarded && ts.isObjectLiteralExpression(forwarded) && forwarded.properties.some(property => ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression) && optionNames.has(property.expression.text))
            && forwarded.properties.every(property => ts.isSpreadAssignment(property) ? ts.isIdentifier(property.expression) && optionNames.has(property.expression.text) : ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? ['body', 'headers'].includes(property.name.getText()) : false);
          if (!direct && !spread) getDefault = false;
        }
        // Any method write/default or option reassignment invalidates the default proof.
        if ((ts.isPropertyAssignment(child) || ts.isBindingElement(child)) && child.name.getText() === 'method') getDefault = false;
        if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) getDefault = false;
        if (ts.isIfStatement(child) && ts.isBinaryExpression(child.expression) && child.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
          && child.expression.left.getText() === '!response.ok'
          && (ts.isThrowStatement(child.thenStatement) || ts.isBlock(child.thenStatement) && child.thenStatement.statements.length === 1 && ts.isThrowStatement(child.thenStatement.statements[0]))) {
          const check = child.expression.right;
          if (ts.isBinaryExpression(check) && check.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && ts.isNumericLiteral(check.right)) {
            if (check.left.getText() === 'result.code' && check.right.text === '1') protocol = 'PHP_CODE_1';
            if (check.left.getText() === 'response.status' && check.right.text === '200') protocol = 'GO_HTTP_200';
          }
        }
      });
      wrappers.set(`${file}#${symbol}`, { getDefault: getDefault && fetchSeen, protocol, source: reference(file, node) });
    });
  }
  for (const [file, { ast }] of files) visit(ast, node => {
    if (file.includes('/plugins/') && file.endsWith('/manifest.ts') && ts.isPropertyAssignment(node) && node.name.getText() === 'kind') {
      const kind = literal(node.initializer); if (kind) context.nodes.push({ kind, source: reference(file, node) });
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const name = node.expression.text; const binding = bindings.get(file)?.get(name);
    if (!binding) return;
    const wrapper = wrappers.get(`${binding.file}#${binding.symbol}`); if (!wrapper) return;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
        if (parent.parameters.some(parameter => parameter.name.getText() === name)) return;
      }
      if (ts.isBlock(parent) && parent.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText() === name))) return;
    }
    const unresolved: string[] = [];
    const action: PanquSourceAction = { id: `${file}:${node.getStart()}`, symbol: symbolOf(node), wrapper: binding.symbol,
      path: literal(node.arguments[0]), body: 'NONE', responseProtocol: wrapper.protocol, source: reference(file, node), wrapperSource: wrapper.source, methodBasis: 'UNRESOLVED', unresolved };
    if (!action.path) unresolved.push('Dynamic path requires runtime binding');
    const optionsNode = node.arguments[1];
    let uncertainOptions = false;
    if (optionsNode && !ts.isObjectLiteralExpression(optionsNode)) uncertainOptions = true;
    if (optionsNode && ts.isObjectLiteralExpression(optionsNode)) {
      uncertainOptions = optionsNode.properties.some(property => ts.isSpreadAssignment(property) || Boolean(property.name && ts.isComputedPropertyName(property.name)));
      for (const property of optionsNode.properties) {
        if (property.name?.getText() === 'method') {
          const method = ts.isPropertyAssignment(property) ? literal(property.initializer)?.toUpperCase() : undefined;
          if (method && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(method)) { action.method = method; action.methodBasis = 'EXPLICIT'; }
          else uncertainOptions = true;
        }
        if (property.name?.getText() === 'body') {
          action.body = 'UNKNOWN';
          const body = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          if (body && ts.isCallExpression(body) && body.expression.getText() === 'JSON.stringify') action.body = 'JSON';
          if (body && ts.isNewExpression(body) && body.expression.getText() === 'FormData') action.body = 'FORM_DATA';
          if (body && ts.isIdentifier(body) && functionOf(node)?.parameters.some(parameter => parameter.name.getText() === body.text && parameter.type?.getText() === 'FormData')) action.body = 'FORM_DATA';
        }
      }
    }
    if (uncertainOptions) { action.method = undefined; action.methodBasis = 'UNRESOLVED'; unresolved.push('Dynamic or spread options require runtime binding'); }
    else if (!action.method && wrapper.getDefault) { action.method = 'GET'; action.methodBasis = 'VERIFIED_WRAPPER_DEFAULT'; }
    if (!action.method) unresolved.push('HTTP method is not statically verified');
    context.actions.push(action);
  });
  const affected = new Set(context.changedFiles);
  let expanded = true;
  while (expanded) { expanded = false; for (const source of context.sources) if (!affected.has(source.file) && source.imports.some(file => affected.has(file))) { affected.add(source.file); expanded = true; } }
  context.affectedFiles = [...affected].sort();
  const localCandidates = context.sources.filter(source => /(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(source.file) && (!context.changedFiles.length || affected.has(source.file)))
    .map(source => ({ file: source.file, status: 'NOT_EXECUTED' as const, evidenceLevel: 'UNCLASSIFIED_LOCAL_TEST' as const }));
  context.regressionCandidates = [...new Map([...context.regressionCandidates, ...localCandidates].map(c => [c.file, c])).values()];
  return context;
}

/** Conflicts block execution; source observations must never rewrite the requested method or expected result. */
export function assessPanquProject(context: PanquProjectContext, requirement: { apis: Array<{ method: string; path: string }> }): PanquProjectAssessment {
  const assessment: PanquProjectAssessment = { host: context.host, fingerprint: context.fingerprint, provenance: context.provenance,
    sourceDiagnostics: context.diagnostics,
    submodules: context.submodules,
    overview: { inspectedFiles: context.sources.length, requestCallSites: context.actions.length, nodeKinds: [...new Set(context.nodes.map(node => node.kind))] },
    relevantActions: [], blockers: [], regressionCandidates: context.regressionCandidates,
    limitations: ['Source observations are not product requirements or executed UI/API evidence.', 'Dynamic paths, Nuxt auto-imports and unverified wrapper semantics require explicit bindings.'] };
  if (context.host === 'UNKNOWN') return assessment;
  if (!context.complete || context.host === 'AMBIGUOUS') assessment.blockers.push({ code: 'PANQU_SOURCE_INCOMPLETE', message: 'Project source inspection is incomplete or ambiguous; review diagnostics before execution.' });
  const norm = (p: string) => p.startsWith('/') ? p : '/' + p;
  for (const api of requirement.apis) {
    const actions = context.actions.filter(action => action.path && norm(action.path) === norm(api.path));
    assessment.relevantActions.push(...actions);
    const operationKey = `${api.method.toUpperCase()} ${api.path}`;
    if (actions.length && !actions.some(action => action.method === api.method.toUpperCase())) assessment.blockers.push({ code: actions.some(action => !action.method) ? 'PANQU_METHOD_UNRESOLVED' : 'PANQU_METHOD_CONFLICT', operationKey, message: `${operationKey}: requested method is not supported by the inspected call sites; confirm the binding.` });
    if (actions.some(action => action.method === api.method.toUpperCase() && action.body === 'FORM_DATA')) assessment.blockers.push({ code: 'PANQU_FORM_DATA_UNSUPPORTED', operationKey, message: `${operationKey}: frontend sends FormData; the JSON HTTP executor cannot substitute a valid multipart upload.` });
  }
  return assessment;
}
