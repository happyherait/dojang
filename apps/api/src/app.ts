import {
  claimsToPrincipal,
  JwtClaimsSchema,
  principalToClaims,
  type Principal,
} from '@dojang/contracts';
import { auditEvents, chatThreads, users, type Db } from '@dojang/db';
import fastifyJwt from '@fastify/jwt';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { connectErp } from './agent/erp-client.ts';
import { createAgentRuntime, type AgentRuntime } from './agent/runtime.ts';
import { decideStep, listInbox } from './approvals/service.ts';
import type { Config } from './config.ts';

declare module 'fastify' {
  interface FastifyInstance {
    agent: AgentRuntime | null;
  }
}

const LoginBodySchema = z.object({ userId: z.string().min(1) });
const MessageBodySchema = z.object({ content: z.string().trim().min(1).max(4000) });
const ThreadParamsSchema = z.object({ threadId: z.uuid() });
const StepParamsSchema = z.object({
  approvalId: z.uuid(),
  stepOrder: z.coerce.number().int().positive(),
});
const DecisionBodySchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(500).optional(),
});

/** 대리 실행 토큰은 MCP 호출 한 번에 필요한 만큼만 유효하다. */
const ERP_TOKEN_TTL = '60s';

type AppConfig = Pick<Config, 'JWT_SECRET' | 'DEMO_LOGIN'> &
  Partial<Pick<Config, 'DATABASE_URL' | 'MCP_URL'>>;

export async function buildApp(
  config: AppConfig,
  db: Db,
  options: { model?: BaseChatModel | undefined } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { algorithm: 'HS256', expiresIn: '1h' },
    verify: { algorithms: ['HS256'] },
  });

  const loadPrincipal = async (userId: string): Promise<Principal> => {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error('사용자를 찾을 수 없습니다.');
    return user;
  };

  let agent: AgentRuntime | null = null;
  if (options.model && config.DATABASE_URL && config.MCP_URL) {
    const mcpUrl = config.MCP_URL;
    agent = await createAgentRuntime({
      db,
      model: options.model,
      databaseUrl: config.DATABASE_URL,
      loadPrincipal,
      erpFor: (principal) =>
        connectErp(mcpUrl, app.jwt.sign(principalToClaims(principal), { expiresIn: ERP_TOKEN_TTL })),
    });
    const runtime = agent;
    app.addHook('onClose', () => runtime.close());
  }
  app.decorate('agent', agent);

  /** 토큰의 직급을 그대로 믿지 않고 요청마다 현재 사용자 정보를 읽는다. */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const claims = JwtClaimsSchema.parse(await request.jwtVerify());
      return await loadPrincipal(claims.sub);
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
      return null;
    }
  };

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

  const ownedThread = async (threadId: string, ownerId: string) => {
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.ownerId, ownerId)));
    return thread;
  };

  app.post('/chat/threads', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return reply;
    const [thread] = await db.insert(chatThreads).values({ ownerId: actor.id }).returning();
    return reply.code(201).send({ threadId: thread?.id });
  });

  app.get('/chat/threads/:threadId', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return reply;
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_PARAMS' });
    if (!agent) return reply.code(503).send({ error: 'LLM_NOT_CONFIGURED' });
    // 다른 사람의 대화는 존재 여부도 알리지 않는다.
    if (!(await ownedThread(params.data.threadId, actor.id))) {
      return reply.code(404).send({ error: 'THREAD_NOT_FOUND' });
    }
    return agent.getThread(params.data.threadId);
  });

  app.post('/chat/threads/:threadId/messages', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return reply;
    const params = ThreadParamsSchema.safeParse(request.params);
    const body = MessageBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    if (!agent) return reply.code(503).send({ error: 'LLM_NOT_CONFIGURED' });
    const { threadId } = params.data;
    if (!(await ownedThread(threadId, actor.id))) {
      return reply.code(404).send({ error: 'THREAD_NOT_FOUND' });
    }
    let current = await agent.getThread(threadId);
    if (current.status !== 'idle') {
      await agent.recover(); // 기한이 지난 결재로 대화가 묶여 있으면 먼저 푼다.
      current = await agent.getThread(threadId);
    }
    if (current.status !== 'idle') return reply.code(409).send({ error: 'THREAD_BUSY', ...current });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      if (!raw.destroyed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of agent.streamTurn(threadId, actor.id, body.data.content)) {
        send(event.type, event);
      }
      const thread = await agent.getThread(threadId);
      send('done', {
        status: thread.status,
        approvalId: thread.approvalId,
        reply: thread.messages.at(-1)?.content ?? '',
      });
    } catch (error) {
      request.log.error(error);
      send('error', { error: 'AGENT_FAILED' });
    } finally {
      raw.end();
    }
    return reply;
  });

  app.get('/approvals/inbox', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return reply;
    return listInbox(db, actor);
  });

  app.post('/approvals/:approvalId/steps/:stepOrder/decision', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return reply;
    const params = StepParamsSchema.safeParse(request.params);
    const body = DecisionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });

    const result = await decideStep(db, { actor, ...params.data, ...body.data });
    if (!result.ok) {
      const status = result.code === 'APPROVAL_NOT_FOUND' ? 404 : 403;
      return reply.code(status).send({ error: result.code });
    }

    let resumed = false;
    if (result.status !== 'pending' && agent) {
      // 결재 결과는 이미 커밋되었다. 재개에 실패해도 recover()가 이어서 처리한다.
      try {
        await agent.resume(result.threadId);
        resumed = true;
      } catch (error) {
        request.log.error(error);
      }
    }
    return { status: result.status, resumed };
  });

  return app;
}
