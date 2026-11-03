import { connect } from '../client.ts';
import { seed } from '../seed.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL이 필요합니다.');

const { db, close } = connect(url);
await seed(db);
await close();
console.log('시드 데이터를 넣었습니다.');
