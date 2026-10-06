// Pure estimates of the already-redacted logical input; never provider billing or a tokenizer.
export const CATEGORIES = Object.freeze([
  ['system', '系统指令'], ['developer', '开发者指令'], ['toolDefinitions', '工具定义'],
  ['toolCalls', '工具调用'], ['toolResults', '工具结果'], ['subagent', '子代理协作'],
  ['user', '用户输入'], ['assistant', '助手历史'], ['context', '自动上下文'], ['other', '其他内容'],
].map(([id, label]) => Object.freeze({ id, label })));

const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'send_message', 'list_agents', 'interrupt_agent']);
const SUBAGENT_SOURCES = new Set(['subagent', 'subagent-fork', 'subagent_fork', 'subagent-message', 'subagent-result', 'subagent-response', 'subagent-completion', 'subagent-notification', 'subagent-update', 'workflow']);
const INSTRUCTION_SOURCES = new Set(['developer', 'developer-prompt', 'agent-instructions', 'skill-invocation', 'goal', 'cordis-host-runner']);
// Namespaced tool names are accepted only for known Harness namespaces, not arbitrary suffixes.
const isSubagentTool = name => typeof name === 'string' && SUBAGENT_TOOLS.has(name.replace(/^(?:functions|tools)\./, ''));
const sourceKind = source => typeof source === 'string' ? source : source?.kind;
const explicitSubagent = source => SUBAGENT_SOURCES.has(sourceKind(source));

export function isValidAnalytics(value) {
  if (!value || typeof value !== 'object' || value.version !== 1 || value.method !== 'heuristic-v1') return false;
  const count = number => Number.isSafeInteger(number) && number >= 0;
  if (!['estimatedInputTokens', 'messageCount', 'toolHistoryTokens', 'attachmentCount', 'unknownBlockCount'].every(key => count(value[key]))) return false;
  if (!Array.isArray(value.categories) || value.categories.length !== CATEGORIES.length) return false;
  if (!CATEGORIES.every((expected, index) => {
    const category = value.categories[index];
    return category && category.id === expected.id && typeof category.label === 'string' && count(category.tokens) && count(category.messageCount) && category.messageCount <= value.messageCount;
  })) return false;
  const total = value.categories.reduce((sum, category) => sum + category.tokens, 0);
  return count(total) && total === value.estimatedInputTokens;
}

export function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  let quarters = 0;
  for (const character of text) quarters += character.codePointAt(0) <= 0x7f ? 1 : 4;
  return Math.ceil(quarters / 4);
}
const compactTokens = value => estimateTextTokens(JSON.stringify(value) ?? '');
const valueTokens = value => typeof value === 'string' ? estimateTextTokens(value) : compactTokens(value);

function baseCategory(message) {
  const kind = sourceKind(message?.source);
  if (message?.role === 'system' || kind === 'system-prompt') return 'system';
  if (message?.role === 'developer' || INSTRUCTION_SOURCES.has(kind)) return 'developer';
  if (explicitSubagent(message?.source)) return 'subagent';
  if (message?.role === 'tool') return 'toolResults';
  if (message?.role === 'user') return message.source == null || kind === 'user' || kind === 'user-rpc' ? 'user' : 'context';
  if (message?.role === 'assistant') return 'assistant';
  return 'other';
}

// The cache stores compact contributions, not whole message bodies. Its key is the CAS hash
// plus semantic kind: identical blobs shared by requests cost one content estimate, but each
// occurrence still contributes tokens and one message to the request's totals.
export function summarizeChunk(value, kind) {
  if (kind === 'system') return { tokens: valueTokens(value) };
  if (kind === 'tools') return { tokens: Array.isArray(value) && value.length === 0 ? 0 : compactTokens(value) };
  if (kind === 'toolHistory') return { tokens: compactTokens(value) };
  if (kind !== 'message') throw new Error('Unknown analytics chunk kind');
  const base = baseCategory(value);
  const content = value?.content;
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
  return {
    base, resultCallId: value?.toolCallId ?? value?.source?.callId,
    isToolResult: value?.role === 'tool',
    blocks: blocks.map(block => {
      if (typeof block === 'string') return { tokens: estimateTextTokens(block) };
      if (block?.type === 'text' || block?.type === 'reasoning') return { tokens: valueTokens(block.text ?? '') };
      if (block?.type === 'image' || block?.type === 'file') return { tokens: 0, attachment: 1 };
      if (block?.type === 'tool-call') return {
        tokens: estimateTextTokens(block.name ?? '') + valueTokens(block.arguments ?? ''),
        call: true, callId: block.id ?? block.callId,
        category: isSubagentTool(block.name) || explicitSubagent(block.source) ? 'subagent' : 'toolCalls',
      };
      // Tool history update blocks describe visible tool names, not a second schema copy.
      if (block?.type === 'tool-addition' || block?.type === 'tool-removal') return { tokens: estimateTextTokens(block.toolName ?? ''), category: 'toolDefinitions' };
      return { tokens: compactTokens(block), unknown: 1 };
    }),
  };
}

export function estimateAnalytics(refs, summaryFor) {
  const categories = CATEGORIES.map(({ id, label }) => ({ id, label, tokens: 0, messageCount: 0 }));
  const byId = Object.fromEntries(categories.map(category => [category.id, category]));
  const callCategories = new Map();
  let attachmentCount = 0, unknownBlockCount = 0;
  for (const hash of refs.messages ?? []) {
    const summary = summaryFor(hash, 'message');
    let base = summary.base;
    // Resolve only preceding calls, and never infer subagents from result text.
    if (summary.isToolResult && base !== 'subagent') base = callCategories.get(summary.resultCallId) === 'subagent' ? 'subagent' : 'toolResults';
    const contributions = new Set();
    let framingCategory;
    const calls = [];
    for (const block of summary.blocks) {
      const category = block.category ?? base;
      byId[category].tokens += block.tokens;
      contributions.add(category);
      // Prefer the ordinary content's category for framing. Call-only messages use
      // their first call's category. The fixed four tokens are charged exactly once.
      if (!block.call && framingCategory === undefined) framingCategory = category;
      attachmentCount += block.attachment ?? 0;
      unknownBlockCount += block.unknown ?? 0;
      if (block.call && block.callId !== undefined) calls.push([block.callId, category]);
    }
    framingCategory ??= summary.blocks[0]?.category ?? base;
    byId[framingCategory].tokens += 4;
    contributions.add(framingCategory);
    // A category's messageCount is the number of messages contributing to that
    // category, not a partition: a mixed assistant/tool-call message counts in both.
    for (const category of contributions) byId[category].messageCount++;
    for (const [id, category] of calls) callCategories.set(id, category);
  }
  if (refs.systemRef !== undefined) byId.system.tokens += summaryFor(refs.systemRef, 'system').tokens;
  if (refs.toolsRef !== undefined) byId.toolDefinitions.tokens += summaryFor(refs.toolsRef, 'tools').tokens;
  // toolHistory is adapter diagnostic context; tools already represent the effective
  // schema set. Never add history schemas to estimatedInputTokens a second time.
  const toolHistoryTokens = refs.toolHistoryRef === undefined ? 0 : summaryFor(refs.toolHistoryRef, 'toolHistory').tokens;
  return {
    version: 1, method: 'heuristic-v1', estimatedInputTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
    messageCount: refs.messages?.length ?? 0, categories, toolHistoryTokens, attachmentCount, unknownBlockCount,
  };
}
