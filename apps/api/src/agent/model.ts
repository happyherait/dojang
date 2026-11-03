import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Config } from '../config.ts';

export const createClaudeModel = (
  config: Pick<Config, 'ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL'>,
  options: { baseUrl?: string } = {},
): BaseChatModel | undefined =>
  config.ANTHROPIC_API_KEY
    ? new ChatAnthropic({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
        maxTokens: 1024,
        maxRetries: 2,
        ...(options.baseUrl ? { anthropicApiUrl: options.baseUrl } : {}),
      })
    : undefined;
