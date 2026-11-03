import { connect, runMigrations, seed } from '@dojang/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const url =
  process.env.TEST_DATABASE_URL ?? 'postgres://dojang:dojang@localhost:5432/dojang_test';
const JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
const { db, close } = connect(url);

let app: FastifyInstance;
let locked: FastifyInstance;

beforeAll(async () => {
  await runMigrations(db);
  await seed(db);
  app = await buildApp({ JWT_SECRET, DEMO_LOGIN: true }, db);
  locked = await buildApp({ JWT_SECRET, DEMO_LOGIN: false }, db);
});

afterAll(async () => {
  await app.close();
  await locked.close();
  await close();
});

const login = (userId: unknown) =>
  app.inject({ method: 'POST', url: '/auth/demo-login', payload: { userId } });

describe('데모 로그인', () => {
  it('토큰을 발급하고 /me에서 신원을 돌려준다', async () => {
    const { token } = (await login('u-park')).json();
    const me = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ id: 'u-park', name: '박팀장', role: 'team_lead', department: '재무팀' });
  });

  it('없는 사용자는 거부한다', async () => {
    expect((await login('u-nobody')).statusCode).toBe(401);
  });

  it('잘못된 요청 본문은 거부한다', async () => {
    expect((await login(123)).statusCode).toBe(400);
  });

  it('설정을 끄면 경로가 사라진다', async () => {
    const response = await locked.inject({
      method: 'POST',
      url: '/auth/demo-login',
      payload: { userId: 'u-park' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('/me', () => {
  it('토큰이 없으면 거부한다', async () => {
    expect((await app.inject({ url: '/me' })).statusCode).toBe(401);
  });

  it('위조된 토큰을 거부한다', async () => {
    const { token } = (await login('u-kim')).json();
    const [header, payload] = (token as string).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u-kim', name: '김사원', role: 'ceo', department: '재무팀' }),
    ).toString('base64url');
    const response = await app.inject({
      url: '/me',
      headers: { authorization: `Bearer ${header}.${forged}.${payload}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('서명 없는 alg=none 토큰을 거부한다', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'u-han',
      name: '한대표',
      role: 'ceo',
      department: '경영진',
    })}.`;
    const response = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(401);
  });
});
