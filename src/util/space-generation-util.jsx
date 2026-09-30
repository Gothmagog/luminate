import useCurrStore from "../store/use-curr-store";
import useResponseStore from "../store/use-response-store";
import DatabaseManager from "../db/database-manager";
import useSelectedStore from "../store/use-selected-store";
import * as bootstrap from 'bootstrap';
import { uuid } from "./util";
import { callBedrock, callBedrockStructured } from "./bedrock-client";
import { getEditorContext } from "./story-context";
import {
  CREATIVE_WRITING_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  LABEL_SYSTEM_PROMPT,
} from "./prompts";

// ─── Module-level counters (legacy — kept for callers that read them) ─────────
let fail_count = 0;
let total_count = 0;
let firstId = '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showErrorToast(message) {
  const toastEl = document.getElementById('error-toast');
  const textEl = document.getElementById('error-toast-text');
  if (toastEl && textEl) {
    textEl.textContent = message;
    new bootstrap.Toast(toastEl).show();
  }
}

/**
 * Thin wrapper around getEditorContext so internal call sites read naturally.
 * All threshold/cache/summarisation logic lives in story-context.ts.
 */
const editorBackgroundPrompt = getEditorContext;

/**
 * Builds the user-facing message for a creative generation call.
 *
 * Requirements are reformatted as a bulleted mandatory list so the model
 * treats them as hard constraints rather than soft suggestions.
 */
function buildCreativeUserMessage(background, userPrompt, requirements) {
  const backgroundSection = background
    ? `Background context (incorporate naturally if relevant):\n${background}\n\n`
    : '';

  const reqLines = requirements
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `- ${l.trim()}`)
    .join('\n');

  return (
    `${backgroundSection}Writing prompt: ${userPrompt}\n\n` +
    `The following stylistic requirements are MANDATORY. Your response MUST unmistakably embody ` +
    `ALL of them — a reader should be able to identify each requirement from the response alone ` +
    `without being told:\n\n${reqLines}\n\n` +
    `Respond in the form that best suits the prompt — prose, a list of ideas, plot hooks, ` +
    `dialogue, story beats, or any other form it implies. ` +
    `Keep your response under 150 words. Output only the response, no preamble or commentary.`
  );
}

/**
 * Builds the user message for the "More Like This" / variation case.
 * Same requirements as the original but explicitly asks for different content.
 */
function buildVariationUserMessage(background, userPrompt, requirements) {
  const backgroundSection = background
    ? `Background context:\n${background}\n\n`
    : '';

  if (!requirements || requirements.trim() === '') {
    return (
      `${backgroundSection}Writing prompt: ${userPrompt}\n\n` +
      `Respond in the form that best suits the prompt. ` +
      `Keep your response under 150 words. Output only the response, no preamble or commentary.`
    );
  }

  const reqLines = requirements
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `- ${l.trim()}`)
    .join('\n');

  return (
    `${backgroundSection}Generate a VARIATION on the following writing prompt. ` +
    `The variation must satisfy the same stylistic requirements but explore entirely different ` +
    `content, angles, or approaches — it should feel genuinely distinct.\n\n` +
    `Writing prompt: ${userPrompt}\n\n` +
    `Mandatory stylistic requirements:\n${reqLines}\n\n` +
    `Respond in the form that best suits the prompt. ` +
    `Keep your response under 150 words. Output only the response, no preamble or commentary.`
  );
}

// ─── Core generation ──────────────────────────────────────────────────────────

/**
 * Returns true when a model response looks like a clarification request or
 * meta-refusal rather than creative output.  Requires at least two independent
 * signals to avoid false positives from legitimate story content that happens
 * to use words like "contradiction" or "option".
 */
function isMetaResponse(text) {
  const t = text.toLowerCase();
  const signals = [
    t.includes('contradiction in the requirement'),
    t.includes('cannot simultaneously'),
    t.includes('mutually exclusive') && t.includes('constraint'),
    t.includes('before i can'),
    t.includes('please clarify'),
    // "Option A ... Option B" pattern is a strong indicator of a clarification fork
    /option a\b/.test(t) && /option b\b/.test(t),
    t.includes('these two constraints'),
    t.includes('which serves your story'),
  ];
  return signals.filter(Boolean).length >= 2;
}

async function generateResponse(userMessage, temperature = 0.9) {
  let text;
  try {
    text = await callBedrock({
      system: CREATIVE_WRITING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature,
      maxTokens: 512,
    });
  } catch (error) {
    fail_count++;
    total_count++;
    console.error('[generateResponse] API error:', error);
    throw error;
  }

  total_count++;
  const trimmed = text.trim();

  if (isMetaResponse(trimmed)) {
    fail_count++;
    console.warn('[generateResponse] Meta-response discarded — model requested clarification instead of generating');
    throw new Error('Non-creative meta-response');
  }

  return trimmed;
}

// ─── Summarisation ────────────────────────────────────────────────────────────

// ─── Shared JSON Schemas ──────────────────────────────────────────────────────
// All object types carry additionalProperties: false — Bedrock's structured
// output rejects any value other than false (docs: "Supported JSON Schema
// features" — additionalProperties set to anything other than false is NOT
// supported and causes a 400 error).

const SUMMARY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keywords', 'summary', 'structure', 'title'],
  properties: {
    keywords:  { type: 'array', items: { type: 'string' } },
    summary:   { type: 'string' },
    structure: { type: 'string' },
    title:     { type: 'string' },
  },
};

const BATCH_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summaries'],
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keywords', 'summary', 'structure', 'title'],
        properties: {
          keywords:  { type: 'array', items: { type: 'string' } },
          summary:   { type: 'string' },
          structure: { type: 'string' },
          title:     { type: 'string' },
        },
      },
    },
  },
};

const LABEL_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['labels'],
  properties: {
    labels: { type: 'array', items: { type: 'string' } },
  },
};

const ASSIGN_LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label'],
  properties: { label: { type: 'string' } },
};

// ─── Summarisation ────────────────────────────────────────────────────────────

/**
 * Summarises an array of texts in a SINGLE Haiku call (structured output).
 * Falls back to individual calls only if the batch call throws entirely.
 */
async function batchAbstraction(texts) {
  if (texts.length === 0) return [];

  const fragments = texts
    .map((t, i) => `Fragment ${i + 1}:\n${t}`)
    .join('\n\n---\n\n');

  const userMessage =
    `Analyse these ${texts.length} responses and extract metadata for each. ` +
    `Responses may be prose, idea lists, plot hooks, dialogue, outlines, or other forms.\n\n` +
    `${fragments}\n\n` +
    `Return exactly ${texts.length} summary objects in order.\n` +
    `For each:\n` +
    `- keywords: up to 5 strings capturing dominant content, style, mood, or theme\n` +
    `- summary: max 20 words capturing what this response contains and its distinctive angle\n` +
    `- structure: the overall form or pattern (e.g. "prose", "bullet-list", "dialogue", "premise-hook-twist")\n` +
    `- title: max 5 words, DISTINCTIVE — what makes this response unique, no quotes`;

  try {
    const result = await callBedrockStructured(
      { system: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], useHaiku: true, temperature: 0.2, maxTokens: 2048 },
      BATCH_SUMMARY_SCHEMA,
    );
    const summaries = result.summaries;
    if (Array.isArray(summaries) && summaries.length === texts.length) {
      return summaries.map(normalizeSummary);
    }
    throw new Error(`Expected ${texts.length} items, got ${summaries?.length}`);
  } catch (e) {
    console.warn('[batchAbstraction] Falling back to individual summarisation:', e.message);
    return Promise.all(texts.map((text) => abstraction(text)));
  }
}

function normalizeSummary(s) {
  return {
    Keywords:  Array.isArray(s.keywords) ? s.keywords : [],
    Summary:   s.summary   || '',
    Structure: s.structure || '',
    Title:     (s.title    || '').replace(/(^['<"])|(['>"]$)/g, ''),
  };
}

/** Single-item summarisation — fallback from batchAbstraction. */
export async function abstraction(text) {
  try {
    const result = await callBedrockStructured(
      { system: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: 'user', content: summarizeUserMessage(text) }], useHaiku: true, temperature: 0.2, maxTokens: 512 },
      SUMMARY_ITEM_SCHEMA,
    );
    return normalizeSummary(result);
  } catch (e) {
    console.warn('[abstraction] failed:', e.message);
    showErrorToast(`Summary generation failed: ${e.message}`);
    return { Keywords: [], Summary: '', Structure: '', Title: '' };
  }
}

function summarizeUserMessage(text) {
  return (
    `Extract metadata from the following response (which may be prose, a list of ideas, ` +
    `dialogue, plot hooks, or another form):\n\n${text}\n\n` +
    `keywords: up to 5 strings capturing dominant content, style, mood, or theme\n` +
    `summary: max 20 words capturing what this response contains and its distinctive angle\n` +
    `structure: the overall form or pattern (e.g. "prose", "bullet-list", "dialogue", "premise-hook-twist")\n` +
    `title: max 5 words, DISTINCTIVE — captures what makes this response unique, no quotes`
  );
}

// ─── Dimension-requirement helpers ────────────────────────────────────────────

function genDimRequirements(dimensions, numResponses) {
  let dimReqs = [];
  let data = {};
  for (let i = 0; i < numResponses; i++) {
    let req = '';
    const datum = { ID: uuid(), Dimension: { categorical: {}, numerical: {}, ordinal: {} } };

    if (useResponseStore.getState().responseId === null) {
      useResponseStore.getState().setResponseId(datum.ID);
      useCurrStore.getState().setCurrDataId(datum.ID);
    }

    Object.entries(dimensions.categorical || {}).forEach(([d, v]) => {
      const randVal = v[Math.floor(Math.random() * v.length)];
      req += `${d}: ${randVal}\n`;
      datum.Dimension.categorical[d] = randVal;
    });
    Object.entries(dimensions.ordinal || {}).forEach(([d, v]) => {
      const randVal = v[Math.floor(Math.random() * v.length)];
      req += `${d}: ${randVal}\n`;
      datum.Dimension.ordinal[d] = randVal;
    });

    dimReqs.push({ ID: datum.ID, Requirements: req });
    data[datum.ID] = datum;
  }
  return { dimReqs, data };
}

function genFilteredDimRequirements(dimensionMap, numResponses) {
  let dimReqs = [];
  let data = {};
  for (let i = 0; i < numResponses; i++) {
    let req = '';
    const datum = { ID: uuid(), Dimension: { categorical: {}, numerical: {}, ordinal: {} } };

    Object.values(dimensionMap).forEach((dimension) => {
      const values =
        dimension.filtered && dimension.filtered.length > 0
          ? dimension.filtered
          : dimension.values;
      const randVal = values[Math.floor(Math.random() * values.length)];
      req += `${dimension.name}: ${randVal}\n`;
      datum.Dimension[dimension.type][dimension.name] = randVal;
    });

    dimReqs.push({ ID: datum.ID, Requirements: req });
    data[datum.ID] = datum;
  }
  return { dimReqs, data };
}

function genLabelDimRequirements(dimensionMap, label, numResponses) {
  let dimReqs = [];
  let data = {};
  for (let i = 0; i < numResponses; i++) {
    let req = '';
    const datum = { ID: uuid(), Dimension: { categorical: {}, numerical: {}, ordinal: {} } };

    Object.values(dimensionMap).forEach((dimension) => {
      const values =
        dimension.id === label.dimensionId ? [label.name] : dimension.values;
      const randVal = values[Math.floor(Math.random() * values.length)];
      req += `${dimension.name}: ${randVal}\n`;
      datum.Dimension[dimension.type][dimension.name] = randVal;
    });

    dimReqs.push({ ID: datum.ID, Requirements: req });
    data[datum.ID] = datum;
  }
  return { dimReqs, data };
}

// ─── Space-building functions ─────────────────────────────────────────────────

/**
 * Generates the initial full design space.
 *
 * Architecture: parallel response generation → single batch summarisation call.
 * Previously, each response triggered its own summarisation call (N calls).
 * Now N responses → 1 summarisation call (Haiku), cutting API costs dramatically.
 */
export async function buildSpace(currBlockId, dimensions, numResponses, prompt, context) {
  const { dimReqs, data } = genDimRequirements(dimensions, numResponses);
  const { maxBlockId, setMaxBlockId } = useCurrStore.getState();
  const { setSelectedResponse } = useSelectedStore.getState();

  fail_count = 0;
  total_count = dimReqs.length;
  firstId = dimReqs[0]?.ID ?? '';

  // Await the editor background ONCE (previously called without await — bug fix)
  // Pass the inline context (selected text) so it also reaches the generation prompt
  const background = await editorBackgroundPrompt(context);

  const BATCH_SIZE = 20;
  for (let i = 0; i < dimReqs.length; i += BATCH_SIZE) {
    const batch = dimReqs.slice(i, i + BATCH_SIZE);

    // Phase 1 — generate all responses in parallel
    const batchResults = await Promise.all(
      batch.map(async (req) => {
        try {
          const userMessage = buildCreativeUserMessage(background, prompt, req.Requirements);
          const response = await generateResponse(userMessage);
          return { id: req.ID, requirements: req.Requirements, userMessage, response, ok: true };
        } catch (err) {
          console.error(`[buildSpace] response error for ${req.ID}:`, err);
          fail_count++;
          // Ensure the node has all required fields so the visualisation never
          // crashes on undefined Keywords / Title etc.
          data[req.ID] = {
            ...data[req.ID],
            Prompt: '', UserPrompt: prompt, Requirements: req.Requirements,
            Context: context, Result: '', IsMyFav: false,
            Summary: '', Keywords: [], Structure: '', Title: '(failed)',  // Keywords already correct
          };
          return { id: req.ID, ok: false };
        }
      }),
    );

    const successful = batchResults.filter((r) => r.ok);

    // Phase 2 — batch summarise (single Haiku call)
    const summaries = await batchAbstraction(successful.map((r) => r.response));

    // Phase 3 — assemble node data
    successful.forEach(({ id, requirements, userMessage, response }, idx) => {
      const summary = summaries[idx] ?? { Keywords: [], Summary: '', Structure: '', Title: '' };
      data[id] = {
        ...data[id],
        Prompt: userMessage,
        UserPrompt: prompt,     // stored for "More Like This" variation calls
        Requirements: requirements,
        Context: context,
        Result: response,
        IsMyFav: false,
        Summary: summary.Summary,
        Keywords: summary.Keywords,
        Structure: summary.Structure,
        Title: summary.Title,
      };
      if (id === firstId) setSelectedResponse(currBlockId, data[id]);
      if (id === useResponseStore.getState().responseId) {
        useResponseStore.getState().setResponse(response);
      }
    });
  }

  DatabaseManager.putAllData(currBlockId, data);
  useCurrStore.getState().setCurrBlockId(currBlockId);
  setMaxBlockId(maxBlockId + 1);

  return { fail_count, total_count };
}

export async function growSpace(currBlockId, dimensionMap, labels, numResponses, prompt, nodeMap, setNodeMap) {
  const { dimReqs, data } = genFilteredDimRequirements(dimensionMap, numResponses);
  const inlineContext = useResponseStore.getState().context ?? '';
  const background = await editorBackgroundPrompt(inlineContext);

  // Phase 1 — generate responses in parallel
  const responseResults = await Promise.all(
    dimReqs.map(async (req) => {
      try {
        const userMessage = buildCreativeUserMessage(background, prompt, req.Requirements);
        const response = await generateResponse(userMessage);
        return { id: req.ID, requirements: req.Requirements, userMessage, response, ok: true };
      } catch (err) {
        console.error('[growSpace] response error:', err);
        fail_count++;
        return { id: req.ID, ok: false };
      }
    }),
  );

  const successful = responseResults.filter((r) => r.ok);

  // Phase 2 — batch summarise
  const summaries = await batchAbstraction(successful.map((r) => r.response));

  // Phase 3 — assemble
  successful.forEach(({ id, requirements, userMessage, response }, idx) => {
    const summary = summaries[idx] ?? { Keywords: [], Summary: '', Structure: '', Title: '' };
    data[id] = {
      ...data[id],
      Prompt: userMessage,
      UserPrompt: prompt,
      Requirements: requirements,
      Result: response,
      Summary: summary.Summary,
      Keywords: summary.Keywords,
      Structure: summary.Structure,
      Title: summary.Title,
      IsMyFav: false,
    };
  });

  setNodeMap({ ...nodeMap, ...data });
  DatabaseManager.addBatchData(currBlockId, data);
  return { fail_count, total_count };
}

export async function addLabelToSpace(dimensionMap, newLabel, numResponses, prompt, nodeMap, setNodeMap) {
  const { dimReqs, data } = genLabelDimRequirements(dimensionMap, newLabel, numResponses);
  const { currBlockId } = useCurrStore.getState();
  const inlineContext = useResponseStore.getState().context ?? '';
  const background = await editorBackgroundPrompt(inlineContext);

  // Phase 1 — generate responses in parallel
  const responseResults = await Promise.all(
    dimReqs.map(async (req) => {
      try {
        const userMessage = buildCreativeUserMessage(background, prompt, req.Requirements);
        const response = await generateResponse(userMessage);
        return { id: req.ID, requirements: req.Requirements, userMessage, response, ok: true };
      } catch (err) {
        console.error('[addLabelToSpace] response error:', err);
        fail_count++;
        return { id: req.ID, ok: false };
      }
    }),
  );

  const successful = responseResults.filter((r) => r.ok);

  // Phase 2 — batch summarise
  const summaries = await batchAbstraction(successful.map((r) => r.response));

  // Phase 3 — assemble
  successful.forEach(({ id, requirements, userMessage, response }, idx) => {
    const summary = summaries[idx] ?? { Keywords: [], Summary: '', Structure: '', Title: '' };
    data[id] = {
      ...data[id],
      Prompt: userMessage,
      UserPrompt: prompt,
      Requirements: requirements,
      Result: response,
      Summary: summary.Summary,
      Keywords: summary.Keywords,
      Structure: summary.Structure,
      Title: summary.Title,
      IsMyFav: false,
    };
  });

  setNodeMap({ ...nodeMap, ...data });
  DatabaseManager.addBatchData(currBlockId, data);
  return { fail_count, total_count };
}

/**
 * "More Like This" — generates 5 variations that share the same requirements
 * but explore different content/angles.  Temperature raised to 1.0 for maximum
 * variation.
 */
export async function addSimilarNodesToSpace(node, nodeMap, setNodeMap) {
  const background = await editorBackgroundPrompt();

  // Fall back gracefully for nodes created before UserPrompt/Requirements were stored
  const userPrompt = node.UserPrompt || node.Prompt || '';
  const requirements = node.Requirements || '';

  const responseResults = await Promise.allSettled(
    [0, 1, 2, 3, 4].map(async () => {
      const id = uuid();
      const userMessage = buildVariationUserMessage(background, userPrompt, requirements);
      const response = await generateResponse(userMessage, 1.0);
      return { id, userMessage, response };
    }),
  );

  const successful = responseResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  const summaries = await batchAbstraction(successful.map((r) => r.response));

  const data = {};
  successful.forEach(({ id, userMessage, response }, idx) => {
    const summary = summaries[idx] ?? { Keywords: [], Summary: '', Structure: '', Title: '' };
    data[id] = {
      ...node,
      ID: id,
      Prompt: userMessage,
      UserPrompt: userPrompt,
      Requirements: requirements,
      Result: response,
      Summary: summary.Summary,
      Keywords: summary.Keywords,
      Structure: summary.Structure,
      Title: summary.Title,
      IsMyFav: false,
      IsNew: true,
    };
  });

  setNodeMap({ ...nodeMap, ...data });
  const { currBlockId } = useCurrStore.getState();
  DatabaseManager.addBatchData(currBlockId, data);
  return { fail_count, total_count };
}

// ─── Add New Dimension ────────────────────────────────────────────────────────

export async function addNewDimension(prompt, dimensionName, dimensionMap, setDimensionMap, nodeMap, setNodeMap) {
  // Step 1 — generate labels (tool use returns an object directly, no JSON.parse needed)
  let newDimension = null;
  for (let i = 0; i < 3; i++) {
    try {
      const result = await createLabelsFromDimension(prompt, dimensionName);
      if (validateFormatForAddingDimensions(result)) {
        newDimension = result;
        break;
      }
    } catch (e) {
      console.warn('[addNewDimension] label generation attempt', i, e.message);
    }
  }

  if (!newDimension) {
    showErrorToast('Failed to add new dimension. Please try again.');
    return;
  }

  new bootstrap.Toast(document.getElementById('fav-toast')).show();
  document.getElementById('toast-text').textContent = 'New dimension added.';

  const name = Object.keys(newDimension)[0];
  const values = Object.values(newDimension)[0];

  // Register dimension
  dimensionMap[name] = { id: Object.keys(dimensionMap).length, name, type: 'categorical', values, filtered: [] };
  setDimensionMap(dimensionMap);
  const { currBlockId } = useCurrStore.getState();
  DatabaseManager.postDimension(currBlockId, name, { name, type: 'categorical', values });

  // Step 2 — for each existing node: assign a label then revise the response
  const data = {};
  await Promise.allSettled(
    Object.entries(nodeMap).map(async ([id, node]) => {
      try {
        // 2a — label assignment (Haiku, cheap classification)
        const assignMessage =
          `Assign exactly one label from the list to the following creative writing piece.\n\n` +
          `Dimension: ${dimensionName}\n` +
          `Available labels: ${values.join(', ')}\n\n` +
          `Creative writing:\n${node.Result}\n\n` +
          `Select the single best-fitting label.`;

        const labelResult = await callBedrockStructured(
          { system: LABEL_SYSTEM_PROMPT, messages: [{ role: 'user', content: assignMessage }], useHaiku: true, temperature: 0.2, maxTokens: 128 },
          ASSIGN_LABEL_SCHEMA,
        );
        const label = labelResult.label || values[0];

        // 2b — revision (Sonnet, creative rewrite)
        const reviseMessage =
          `Revise the following response so that it clearly and unmistakably embodies ` +
          `"${label}" in the dimension of "${dimensionName}". ` +
          `Preserve the general form and approximate length of the original (under 150 words). ` +
          `The dimension quality must be evident throughout, not just in one line.\n\n` +
          `Original:\n${node.Result}\n\n` +
          `Output only the revised response.`;

        const revised = await callBedrock({
          system: CREATIVE_WRITING_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: reviseMessage }],
          temperature: 0.85,
          maxTokens: 512,
        });

        const result = revised.trim();
        const summary = await abstraction(result);

        node.Dimension.categorical[dimensionName] = label;
        data[id] = {
          ...node,
          ID: id,
          Result: result,
          Summary: summary.Summary,
          Keywords: summary.Keywords,
          Structure: summary.Structure,
          Title: summary.Title,
        };
      } catch (err) {
        console.error('[addNewDimension] node error:', err);
      }
    }),
  );

  setNodeMap({ ...data });
  DatabaseManager.addBatchData(currBlockId, data);

  const toast2 = new bootstrap.Toast(document.getElementById('fav-toast'));
  document.getElementById('toast-text').textContent = 'Current responses updated.';
  toast2.show();
}

async function createLabelsFromDimension(prompt, dimensionName) {
  const userMessage =
    `Generate 5-6 distinct, meaningful labels for the creative writing dimension "${dimensionName}", ` +
    `for pieces about:\n\n${prompt}\n\n` +
    `Labels must:\n` +
    `- Be concrete and mutually distinct from each other\n` +
    `- Span the full range of what "${dimensionName}" could represent\n` +
    `- Be useful as creative descriptors for writers`;

  const result = await callBedrockStructured(
    { system: LABEL_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }], temperature: 0.6, maxTokens: 512 },
    LABEL_MAP_SCHEMA,
  );
  // Reconstruct the {dimensionName: [labels]} shape the rest of addNewDimension expects
  return { [dimensionName]: result.labels };
}

export function validateFormatForAddingDimensions(response) {
  return response !== null && typeof response === 'object';
}
