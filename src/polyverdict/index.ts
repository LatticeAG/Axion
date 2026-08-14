/**
 * PolyVerdict v1 - public entrypoint.
 *
 * Opt-in structured-output enforcement for the Axion proxy. Import from
 * this in-repo module. There is no published `axion/polyverdict` package.
 */

export {
  validateAndCoerce,
  stripMarkdownFences,
  parseJsonFromAssistant,
} from './schema.js';

export {
  detectSchemaTrigger,
  enforceOnce,
  buildViolationHint,
  buildRetryMessages,
  buildRetryMessagesAnthropic,
  runEnforceLoop,
  MAX_ENFORCE_ATTEMPTS,
  type EnforceResult,
  type EnforceLoopResult,
  type RetryContext,
} from './enforce.js';

export type {
  SchemaTrigger,
  Ok,
  Err,
  ValidationResult,
  ParseResult,
  JsonSchema,
  JsonSchemaType,
  OpenAiMessage,
  AnthropicMessage,
  AnthropicTextBlock,
} from './types.js';
