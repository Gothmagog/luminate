/**
 * Story context extraction for use as generation background.
 *
 * Reads all editor paragraph blocks, and — if the total word count exceeds
 * STORY_SUMMARY_THRESHOLD_WORDS — returns a compact concept summary generated
 * by Haiku rather than the raw text.
 *
 * Rationale: this tool is an idea-generation tool, so the model needs the
 * conceptual skeleton (characters, setting, conflict) rather than prose style.
 * A concise structured summary is more signal-dense than thousands of words of
 * draft prose for this purpose.
 *
 * The summary is cached by a hash of the raw text so it is only regenerated
 * when the story content actually changes.
 */

import useEditorStore from '../store/use-editor-store';
import { callBedrock } from './bedrock-client';
import { STORY_CONTEXT_SYSTEM_PROMPT } from './prompts';

export const STORY_SUMMARY_THRESHOLD_WORDS = 1000;

/** Module-level cache — persists for the session, resets on page reload. */
const _cache: { hash: string | null; summary: string | null } = {
  hash: null,
  summary: null,
};

/** Fast non-cryptographic string hash, sufficient for cache keying. */
function hashString(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function summarizeStoryContext(storyText: string): Promise<string> {
  const userMessage =
    `Summarise the following story content into a structured concept reference.\n\n` +
    `${storyText}\n\n` +
    `Cover all of the following that are present:\n` +
    `- Characters: who they are and what they want, fear, or need\n` +
    `- Setting: time, place, genre or tone\n` +
    `- Conflict: the central problem or tension driving the story\n` +
    `- Current situation: where things stand at this point in the narrative\n\n` +
    `Keep the total under 150 words. Use concise notes, not prose.`;

  return callBedrock({
    system: STORY_CONTEXT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    useHaiku: true,
    temperature: 0.2,
    maxTokens: 300,
  });
}

/**
 * Returns a cached concept summary, regenerating via Haiku only when the
 * story text has changed since the last call.
 * Falls back to a word-count truncation if the Haiku call fails.
 */
export async function getCachedStoryContextSummary(storyText: string): Promise<string> {
  const hash = hashString(storyText);

  if (_cache.hash === hash && _cache.summary) {
    return _cache.summary;
  }

  try {
    const summary = await summarizeStoryContext(storyText);
    _cache.hash = hash;
    _cache.summary = summary;
    return summary;
  } catch (e: any) {
    console.warn('[storyContext] Summarisation failed, falling back to truncation:', e.message);
    const words = storyText.split(/\s+/);
    return words.slice(-STORY_SUMMARY_THRESHOLD_WORDS).join(' ');
  }
}

/**
 * Reads the editor content and returns it ready for injection into a prompt.
 * Long text (> STORY_SUMMARY_THRESHOLD_WORDS words) is replaced with a cached
 * concept summary. An optional inline context string (selected text) is
 * appended if provided.
 */
export async function getEditorContext(inlineContext = ''): Promise<string> {
  const { api } = useEditorStore.getState();
  const ejData = await api.save();

  const storyText = ejData.blocks
    .filter((b: any) => b.type === 'paragraph')
    .map((b: any) => b.data.text ?? '')
    .filter((t: string) => t.trim() !== '')
    .join('\n\n');

  let contextText = storyText;

  if (storyText.split(/\s+/).filter(Boolean).length > STORY_SUMMARY_THRESHOLD_WORDS) {
    contextText = await getCachedStoryContextSummary(storyText);
  }

  const parts = [contextText, inlineContext].filter((p) => p.trim() !== '');
  return parts.length > 0 ? parts.join('\n\n') : '';
}
