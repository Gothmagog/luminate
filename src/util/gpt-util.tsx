import DatabaseManager from "../db/database-manager";
import { DIMENSION_SYSTEM_PROMPT, HIGHLIGHT_SYSTEM_PROMPT } from "./prompts";
import { callBedrock, callBedrockStructured } from "./bedrock-client";
import { getEditorContext } from "./story-context";
import * as bootstrap from 'bootstrap';

const TEMPERATURE_DIMENSIONS = 0.7;
const TEMPERATURE_HIGHLIGHT = 0.1;

// ─── Schemas ─────────────────────────────────────────────────────────────────
// All object types carry additionalProperties: false — required by Bedrock's
// JSON Schema Draft 2020-12 subset (anything other than false is unsupported).

/** Dimensions as an array of {name, values} objects.
 *  Dynamic keys are unsupported in Bedrock schemas; we convert to a map after. */
const NAMED_DIMENSIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions'],
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'values'],
        properties: {
          name:   { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['1', '2', '3'],
  properties: {
    '1': { type: 'string' },
    '2': { type: 'string' },
    '3': { type: 'string' },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showErrorToast(message: string) {
  const toastEl = document.getElementById('error-toast');
  const textEl = document.getElementById('error-toast-text');
  if (toastEl && textEl) {
    textEl.textContent = message;
    new bootstrap.Toast(toastEl).show();
  }
}

// ─── Dimension Generation ─────────────────────────────────────────────────────

export async function generateDimensions(query: string, context: string) {
  const background = await getEditorContext(context);

  const promptText = background !== ''
    ? `Existing story context:\n\n${background}\n\n---\n\nWriting prompt: ${query}`
    : `Writing prompt: ${query}`;

  const dimSize = DatabaseManager.getDimensionSize();

  const [categorical, ordinal] = await Promise.all([
    attemptWithRetry(() => generateCategoricalDimensions(promptText, dimSize, 6), 'categorical dimensions'),
    attemptWithRetry(() => generateOrdinalDimensions(promptText, dimSize), 'ordinal dimensions'),
  ]);

  if (!categorical || !ordinal) {
    return { categorical: {}, ordinal: {}, status: 1 };
  }

  return { categorical, ordinal, status: 0 };
}

async function attemptWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3,
): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.error(`[${label}] attempt ${i + 1} failed:`, e);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  showErrorToast(`Failed to generate ${label}: ${msg}`);
  return null;
}

export async function generateCategoricalDimensions(
  promptText: string,
  catNum: number,
  valNum: number,
): Promise<Record<string, string[]>> {
  const userMessage =
    `Generate ${catNum} nominal (unordered, categorical) dimensions for the following writing task. ` +
    `Each dimension must have exactly ${valNum} meaningfully distinct values.\n\n` +
    `${promptText}\n\n` +
    `Rules:\n` +
    `- All ${catNum} dimensions must be mutually independent — no overlap in meaning.\n` +
    `- Forbidden: Quality, Clarity, Grammar, Length.\n` +
    `- Good types: Tone, Setting, Narrative Style, Perspective, Time Period, Character Voice, Mood.\n` +
    `- Values within each dimension must be genuinely distinct, not synonyms.`;

  const result = await callBedrockStructured<{ dimensions: Array<{ name: string; values: string[] }> }>(
    { system: DIMENSION_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], temperature: TEMPERATURE_DIMENSIONS, maxTokens: 1024 },
    NAMED_DIMENSIONS_SCHEMA,
  );

  return Object.fromEntries(result.dimensions.map((d) => [d.name, d.values]));
}

export async function generateOrdinalDimensions(
  promptText: string,
  catNum: number,
): Promise<Record<string, string[]>> {
  const userMessage =
    `Generate ${catNum} ordinal (spectrum) dimensions for the following writing task. ` +
    `Each dimension represents a creative property that ranges from less to more.\n\n` +
    `${promptText}\n\n` +
    `Rules:\n` +
    `- All ${catNum} dimensions must be mutually independent — no overlap.\n` +
    `- Forbidden: Quality, Creativity, Length.\n` +
    `- Good types: Concreteness, Emotional Intensity, Narrative Distance, Realism, Subjectivity, Formality.\n` +
    `- Each dimension must have exactly 5 ordered values from least to most.`;

  const result = await callBedrockStructured<{ dimensions: Array<{ name: string; values: string[] }> }>(
    { system: DIMENSION_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], temperature: TEMPERATURE_DIMENSIONS, maxTokens: 1024 },
    NAMED_DIMENSIONS_SCHEMA,
  );

  return Object.fromEntries(result.dimensions.map((d) => [d.name, d.values]));
}

// ─── Text Highlighting ────────────────────────────────────────────────────────

export async function highlightTextBasedOnDimension(dimension: string, val: string, text: string) {
  return attemptWithRetry(
    () => getRelatedTextBasedOnDimension(dimension, val, text),
    'text highlight',
    2,
  );
}

export async function getRelatedTextBasedOnDimension(
  dimension: string,
  val: string,
  text: string,
): Promise<string> {
  const userMessage =
    `Identify up to 3 verbatim excerpts from the text below that most clearly demonstrate ` +
    `the dimension "${dimension}: ${val}".\n\n` +
    `Text:\n${text}\n\n` +
    `If fewer than 3 strong examples exist, repeat the best excerpt to fill all three slots.`;

  const result = await callBedrockStructured<Record<string, string>>(
    { system: HIGHLIGHT_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], useHaiku: true, temperature: TEMPERATURE_HIGHLIGHT, maxTokens: 512 },
    HIGHLIGHT_SCHEMA,
  );
  return JSON.stringify(result);
}

export async function getKeyTextBasedOnDimension(
  kvPairs: Array<{ dimension: string; value: string }>,
  text: string,
): Promise<string> {
  const dimList = kvPairs.map((kv) => `${kv.dimension}: ${kv.value}`).join(', ');

  const userMessage =
    `Identify up to 3 verbatim excerpts from the text below that best demonstrate ` +
    `the following combination of stylistic qualities: ${dimList}.\n\nText:\n${text}`;

  const result = await callBedrockStructured<Record<string, string>>(
    { system: HIGHLIGHT_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], useHaiku: true, temperature: TEMPERATURE_HIGHLIGHT, maxTokens: 512 },
    HIGHLIGHT_SCHEMA,
  );
  return JSON.stringify(result);
}

export async function reviseResponseWithNewDimensionLabel(
  dimensionName: string,
  labels: string[],
  response: string,
) {
  return getRelatedTextBasedOnDimension(dimensionName, labels[0], response);
}

// ─── Validation (largely ceremonial now; structured output enforces schema) ──

export function validateFormatForDimensions(response: unknown, showToast = false): boolean {
  if (response && typeof response === 'object') return true;
  try {
    JSON.parse(response as string);
    return true;
  } catch (e) {
    if (showToast) showErrorToast('Error parsing dimension response. Please try again.');
    return false;
  }
}

export function validateFormatForHighlight(response: string): boolean {
  try {
    const result = JSON.parse(response);
    return ['1', '2', '3'].every((k) => k in result);
  } catch {
    return false;
  }
}
