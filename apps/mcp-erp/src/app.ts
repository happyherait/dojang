import { claimsToPrincipal, JwtClaimsSchema, type Principal } from '@dojang/contracts';
import { users, type Db } from '@dojang/db';
import fastifyJwt from '@fastify/jwt';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { createErpServer } from './server.ts';

const toFetchRequest = (request: FastifyRequest): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else value?.forEach((item) => headers.append(name, item));
  }
  const init: RequestInit = { method: request.method, headers };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);
  return new Request(new URL(request.url, `http://${request.host}`), init);
};

export async function buildApp(config: Pick<Config, 'JWT_SECRET'>, db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    verify: { algorithms: ['HS256'] },
  });

  const mcp = createMcpHandler((context) => {
    const actor = context.authInfo?.extra?.principal as Principal | undefined;
    if (!actor) throw new Error('인증 정보 없이 MCP 서버를 만들 수 없습니다.');
    return createErpServer(db, actor);
  });
  app.addHook('onClose', () => mcp.close());

  // 토큰의 직급을 그대로 믿지 않고, 요청마다 현재 사용자 정보를 다시 읽는다.
  const authenticate = async (request: FastifyRequest): Promise<AuthInfo | null> => {
    try {
      const claims = JwtClaimsSchema.parse(await request.jwtVerify());
      const [user] = await db.select().from(users).where(eq(users.id, claims.sub));
      if (!user) return null;
      const token = request.headers.authorization?.slice('Bearer '.length) ?? '';
      return {
        token,
        clientId: user.id,
        scopes: [],
        extra: { principal: claimsToPrincipal({ ...claims, role: user.role, department: user.department }) },
      };
    } catch {
      return null;
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const authInfo = await authenticate(request);
      if (!authInfo) return reply.code(401).send({ error: 'UNAUTHORIZED' });

      const response = await mcp.fetch(toFetchRequest(request), { authInfo });
      reply.code(response.status);
      response.headers.forEach((value, name) => reply.header(name, value));
      return reply.send(response.body);
    },
  });

  return app;
}
