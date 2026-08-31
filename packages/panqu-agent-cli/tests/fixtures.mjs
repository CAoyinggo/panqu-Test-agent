/**
 * 共享 fixture 文件内容（依赖零、确定性通过/失败）。
 * e2e / 集成测试用，先写入临时目录再 git init。
 */

export const fixturePassFiles = {
  'package.json': JSON.stringify({
    name: 'fixture-pass',
    version: '1.0.0',
    scripts: {
      typecheck: 'node --check index.js',
      lint: 'node lint.js',
      test: 'node --test',
      build: 'node build.js',
    },
  }, null, 2),
  'package-lock.json': JSON.stringify({
    name: 'fixture-pass',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture-pass', version: '1.0.0' } },
  }, null, 2),
  'index.js': 'module.exports = { answer: 42 };\n',
  'lint.js': 'console.log("lint ok");\n',
  'build.js': `const fs = require("fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/out.txt", "built");
console.log("build ok");
`,
  'test/check.test.js': `const test = require("node:test");
const assert = require("node:assert");
test("fixture passes", () => { assert.equal(1, 1); });
`,
};

export const fixtureFailFiles = {
  'package.json': JSON.stringify({
    name: 'fixture-fail',
    version: '1.0.0',
    scripts: {
      typecheck: 'node --check index.js',
      lint: 'node lint.js',
      test: 'node fail.js',
      build: 'node build.js',
    },
  }, null, 2),
  'package-lock.json': JSON.stringify({
    name: 'fixture-fail',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture-fail', version: '1.0.0' } },
  }, null, 2),
  'index.js': 'module.exports = {};\n',
  'lint.js': 'console.log("lint ok");\n',
  'build.js': 'console.log("build ok");\n',
  'fail.js': 'console.error("intentional failure");\nprocess.exit(1);\n',
};

export const fixtureNoGitFiles = {
  'package.json': JSON.stringify({ name: 'nongit', version: '1.0.0' }, null, 2),
};
