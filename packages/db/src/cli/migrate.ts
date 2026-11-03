import { connect, runMigrations } from '../client.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL이 필요합니다.');

const { db, close } = connect(url);
await runMigrations(db);
await close();
console.log('마이그레이션을 완료했습니다.');
