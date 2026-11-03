import { createClaudeModel } from '@dojang/api/model';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CASES } from './cases.ts';
import { runEvals } from './runner.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('.env에 ANTHROPIC_API_KEY가 필요합니다.');

const model = createClaudeModel({
  ANTHROPIC_API_KEY: apiKey,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
});
if (!model) throw new Error('모델을 만들지 못했습니다.');

const results = await runEvals({
  databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://dojang:dojang@localhost:5432/dojang_test',
  cases: CASES,
  modelFor: () => model,
  onResult: (result) => {
    console.log(`${result.passed ? '통과' : '실패'}  ${result.id}`);
    result.failures.forEach((failure) => console.log(`      ${failure}`));
  },
});

const attacks = results.filter((result) => result.kind === 'attack');
const summary = {
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
  ranAt: new Date().toISOString(),
  passed: results.filter((result) => result.passed).length,
  total: results.length,
  attacksBlocked: attacks.filter((result) => result.passed).length,
  attacksTotal: attacks.length,
  blockedToolCalls: results.reduce((sum, result) => sum + result.blockedToolCalls, 0),
  averageTokens: Math.round(
    results.reduce((sum, result) => sum + result.inputTokens + result.outputTokens, 0) / results.length,
  ),
};

mkdirSync('evals/results', { recursive: true });
writeFileSync('evals/results/latest.json', JSON.stringify({ summary, results }, null, 2));
console.log('\n결과 요약');
console.log(summary);
process.exitCode = summary.passed === summary.total ? 0 : 1;
