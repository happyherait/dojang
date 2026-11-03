import { z } from 'zod';

const optional = (value: unknown) => (value === '' ? undefined : value);

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET은 32자 이상이어야 합니다.'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  MCP_URL: z.url().default('http://127.0.0.1:4100/mcp'),
  ANTHROPIC_API_KEY: z.preprocess(optional, z.string().min(1).optional()),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  DEMO_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ConfigSchema.parse(env);
