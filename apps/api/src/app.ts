import { claimsToPrincipal, JwtClaimsSchema, principalToClaims } from '@dojang/contracts';
import { auditEvents, users, type Db } from '@dojang/db';
import fastifyJwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';

const LoginBodySchema = z.object({ userId: z.string().min(1) });

export async function buildApp(
  config: Pick<Config, 'JWT_SECRET' | 'DEMO_LOGIN'>,
  db: Db,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { algorithm: 'HS256', expiresIn: '1h' },
    verify: { algorithms: ['HS256'] },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // 시연에서 역할을 바꾸기 위한 로그인. 설정으로 켠 경우에만 경로가 존재한다.
  if (config.DEMO_LOGIN) {
    app.get('/auth/demo-users', async () => db.select().from(users).orderBy(users.id));

    app.post('/auth/demo-login', async (request, reply) => {
      const body = LoginBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'INVALID_BODY' });

      const [user] = await db.select().from(users).where(eq(users.id, body.data.userId));
      if (!user) return reply.code(401).send({ error: 'UNKNOWN_USER' });

      await db.insert(auditEvents).values({
        actorType: 'user',
        actorId: user.id,
        action: 'auth.demo_login',
        subjectType: 'user',
        subjectId: user.id,
      });
      return { token: app.jwt.sign(principalToClaims(user)), user };
    });
  }

  app.get('/me', async (request, reply) => {
    try {
      const claims = JwtClaimsSchema.parse(await request.jwtVerify());
      return claimsToPrincipal(claims);
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  return app;
}
