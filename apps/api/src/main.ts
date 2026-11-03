import { connect } from '@dojang/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
const app = await buildApp(config, db);

const shutdown = async () => {
  await app.close();
  await close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: '127.0.0.1', port: config.API_PORT });
console.log(`API 서버: http://127.0.0.1:${config.API_PORT}`);
