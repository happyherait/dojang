import { connect } from '@dojang/db';
import { createClaudeModel } from './agent/model.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
const model = createClaudeModel(config);
const app = await buildApp(config, db, { model });

const shutdown = async () => {
  await app.close();
  await close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: '127.0.0.1', port: config.API_PORT });
console.log(`API 서버: http://127.0.0.1:${config.API_PORT}`);

if (app.agent) {
  console.log(`Claude 모델: ${config.ANTHROPIC_MODEL}`);
  // MCP 서버가 아직 뜨지 않았을 수 있으므로 복구 실패가 API를 멈추지 않게 한다.
  const recovered = await app.agent.recover().catch((error: unknown) => {
    console.error('대화 복구에 실패했습니다.', error);
    return [];
  });
  if (recovered.length > 0) console.log(`중단된 대화 ${recovered.length}건을 재개했습니다.`);
} else {
  console.log('ANTHROPIC_API_KEY가 없어 채팅 API를 끕니다.');
}
