/**
 * Thin frontend client for the Bedrock proxy that runs in vite.config.js.
 * All actual AWS credential handling happens server-side; the browser only
 * calls the local /api/chat endpoint.
 */

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BedrockOptions {
  system: string;
  messages: BedrockMessage[];
  useHaiku?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Core call — returns the raw text response from the model.
 */
export async function callBedrock(options: BedrockOptions): Promise<string> {
  const { system, messages, useHaiku = false, temperature = 0.7, maxTokens = 4096 } = options;

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, useHaiku, temperature, maxTokens }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Bedrock ${response.status}: ${body}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.text as string;
}

/**
 * Calls the model using Bedrock's native structured output feature
 * (output_config.format with type: "json_schema").
 *
 * The schema must comply with Bedrock's JSON Schema Draft 2020-12 subset:
 * - Every object type must have `additionalProperties: false`
 * - No recursive schemas, no external $ref
 * - No numerical or string length constraints
 *
 * The model response is a plain text message whose content is guaranteed to
 * be valid JSON matching the schema.  This function parses and returns that
 * JSON as type T — no extraction heuristics or tool_use response handling.
 */
export async function callBedrockStructured<T extends Record<string, unknown>>(
  options: BedrockOptions,
  schema: Record<string, unknown>,
): Promise<T> {
  const { system, messages, useHaiku = false, temperature = 0.7, maxTokens = 4096 } = options;

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, useHaiku, temperature, maxTokens, jsonSchema: schema }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new Error(`Bedrock ${response.status}: ${body}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return JSON.parse(data.text) as T;
}
