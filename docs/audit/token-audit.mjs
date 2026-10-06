#!/usr/bin/env node
// 复现文章中的关键数字：读取 DSH 会话日志（session.v4.jsonl.zstd），
// 统计模型调用、输入/输出 token、缓存命中占比、缓存失效整段重算、冗余调用。
//
// 只读你本机的日志：本仓库不包含任何会话数据、对话内容或项目信息，
// 脚本跑出来的永远是你自己机器上的数字。
//
// 用法:
//   node token-audit.mjs                       # 默认读 ~/.dsh/sessions
//   node token-audit.mjs --sessions D:\path\.dsh\sessions
//   node token-audit.mjs --workspace my-project   # 只看某个工作区的会话目录
//
// 说明: fork 出来的子代理会话会复制父会话历史（session/end-seed 带 inherited: true），
// 本脚本默认剔除该前缀，避免调用数与 token 数虚高；--include-inherited 可关闭剔除。

import { readFile, readdir } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const ROOT = resolve(argOf('--sessions', join(homedir(), '.dsh', 'sessions')));
const ONLY = argOf('--workspace', null);
const INCLUDE_INHERITED = argv.includes('--include-inherited');

function decompressFrames(bytes) {
  let offset = 0; const chunks = [];
  while (offset < bytes.length) {
    const start = offset; const magic = bytes.readUInt32LE(offset); offset += 4;
    if ((magic & 0xfffffff0) === 0x184d2a50) { const length = bytes.readUInt32LE(offset); offset += 4 + length; continue; }
    if (magic !== 0xfd2fb528) throw new Error(`unknown frame at ${start}`);
    const descriptor = bytes[offset++]; const single = Boolean(descriptor & 32); const sizeFlag = descriptor >>> 6;
    if (!single) offset++;
    offset += [0, 1, 2, 4][descriptor & 3];
    offset += sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
    let last = false;
    while (!last) { const block = bytes.readUIntLE(offset, 3); offset += 3; last = Boolean(block & 1); const kind = (block >>> 1) & 3; offset += kind === 1 ? 1 : block >>> 3; }
    if (descriptor & 4) offset += 4;
    chunks.push(zstdDecompressSync(bytes.subarray(start, offset)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const typeOf = (line) => line.type ?? line.kind ?? 'unknown';
const argsOf = (d) => { const a = d?.arguments; if (a && typeof a === 'object') return a; if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return {}; };

async function collect() {
  const sessions = [];
  for (const ws of await readdir(ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    if (ONLY && !ws.name.includes(ONLY)) continue;
    const dir = join(ROOT, ws.name);
    for (const sub of await readdir(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const file = join(dir, sub.name, 'session.v4.jsonl.zstd');
      try { sessions.push({ workspace: ws.name, id: sub.name, lines: decompressFrames(await readFile(file)).split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); }
      catch { /* 没有会话文件或损坏，跳过 */ }
    }
  }
  return sessions;
}

const totals = { sessions: 0, subSessions: 0, calls: 0, input: 0, output: 0, fresh: 0, cached: 0, turns: 0, toolCalls: 0 };
const byDay = new Map(), byModel = new Map(), perSession = [];
const invalidations = [];
const redundant = { pureReread: 0, dupOnly: 0, steps: 0, tokens: 0 };
let allInput = 0;

for (const s of await collect()) {
  const meta = s.lines.find((l) => typeOf(l) === 'session') ?? {};
  const cut = INCLUDE_INHERITED ? -1 : s.lines.filter((l) => typeOf(l) === 'session/end-seed' && l.data?.inherited === true).reduce((n, l) => Math.max(n, l.seq), -1);
  const isSub = meta.origin === 'subagent' || (meta.delegationDepth ?? 0) > 0 || Boolean(meta.parentSession);
  const model = (() => { const c = s.lines.find((l) => typeOf(l) === 'request/context')?.data; return `${c?.provider ?? '?'}/${c?.model ?? '?'}`; })();
  let calls = 0, input = 0, output = 0, freshTotal = 0, cachedTotal = 0;
  let header = null, prevHeader = null;
  const pruneSeqs = [], readAt = new Map(), dupSeen = new Set();
  const steps = new Map();
  const stepOf = (t, st) => { const k = `${t}/${st}`; if (!steps.has(k)) steps.set(k, { input: 0, calls: 0, allReread: true, allDup: true }); return steps.get(k); };

  for (const l of s.lines) {
    const t = typeOf(l); const d = l.data ?? {};
    if (t === 'assistant/message') {
      const u = d.usage ?? {};
      const i = Number.isFinite(u.totalTokens) ? u.totalTokens - (u.outputTokens ?? 0) : (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0);
      allInput += i;
      if (l.seq <= cut) continue;
      calls++; input += i; output += u.outputTokens ?? 0;
      freshTotal += u.inputTokens ?? 0; cachedTotal += u.cacheReadTokens ?? 0;
      const step = stepOf(d.turn, d.step); step.input = i;
      if (u.inputTokens > 50000) {
        // 归因优先用 Harness 自己给出的 reason；只有 reason=change 时才细分是工具集还是模型/参数变化。
        const toolsChanged = header?.reason === 'change' && prevHeader && header.tools !== prevHeader.tools;
        const modelChanged = header?.reason === 'change' && !toolsChanged;
        invalidations.push({ id: s.id.slice(0, 12), fresh: u.inputTokens ?? 0, reason: header?.reason ?? '?', toolsChanged, modelChanged });
      }
      const day = l.time ? new Date(l.time).toISOString().slice(0, 10) : 'unknown';
      const e = byDay.get(day) ?? { calls: 0, input: 0 }; e.calls++; e.input += i; byDay.set(day, e);
      continue;
    }
    if (l.seq <= cut) continue;
    if (t === 'turn/start') totals.turns++;
    if (t === 'tool/call') {
      totals.toolCalls++;
      const a = argsOf(d); const step = stepOf(d.turn, d.step); step.calls++;
      const dk = `${d.name}::${JSON.stringify(a)}`;
      if (dupSeen.has(dk)) step.waitDup = true; else { dupSeen.add(dk); step.allDup = false; }
      const p = a.file_path ?? a.path;
      if ((d.name === 'read' || d.name === 'grep' || d.name === 'glob') && p) {
        if (readAt.has(p)) { if (!pruneSeqs.some((q) => q > readAt.get(p) && q < l.seq)) step.keepReread = true; else step.allReread = false; }
        else { readAt.set(p, l.seq); step.allReread = false; }
      } else step.allReread = false;
    }
    if (t === 'compaction/prune') pruneSeqs.push(l.seq);
    if (t === 'request/header') { prevHeader = header; header = { reason: d.reason, tools: d.header?.tools?.length, cfg: d.header?.config }; }
  }
  if (calls === 0) continue;
  totals.sessions++; if (isSub) totals.subSessions++;
  totals.calls += calls; totals.input += input; totals.output += output; totals.fresh += freshTotal; totals.cached += cachedTotal;
  const m = byModel.get(model) ?? { sessions: 0, calls: 0, input: 0 }; m.sessions++; m.calls += calls; m.input += input; byModel.set(model, m);
  perSession.push({ id: s.id, isSub, calls, input, output, avgContext: Math.round(input / calls) });
  for (const step of steps.values()) {
    if (step.calls === 0) continue;
    const dupOnly = step.allDup;
    const rereadOnly = step.allReread && step.keepReread;
    if (dupOnly) redundant.dupOnly++;
    if (rereadOnly) redundant.pureReread++;
    if (dupOnly || rereadOnly) { redundant.steps++; redundant.tokens += step.input; }
  }
}

const M = (n) => (n / 1e6).toFixed(2);
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
console.log(`数据源: ${ROOT}${ONLY ? ` (仅 ${ONLY})` : ''}${INCLUDE_INHERITED ? ' [含 fork 复制]' : ' [已剔除 fork 复制]'}`);
console.log(`会话 ${totals.sessions}（子代理 ${totals.subSessions}） · 模型调用 ${totals.calls} 次 · 用户轮次 ${totals.turns} · 工具调用 ${totals.toolCalls}`);
console.log(`输入 ${M(totals.input)}M（未命中 ${M(totals.fresh)}M + 缓存命中 ${M(totals.cached)}M，命中率 ${pct(totals.cached, totals.input)}）`);
console.log(`输出 ${M(totals.output)}M · 合计 ${M(totals.input + totals.output)}M token`);
console.log(`平均每次调用上下文 ${Math.round(totals.input / totals.calls)} token · 平均每轮 ${(totals.calls / Math.max(1, totals.turns)).toFixed(1)} 次调用`);
console.log('\n按天:');
for (const [day, v] of [...byDay.entries()].sort()) console.log(`  ${day}  ${String(v.calls).padStart(5)} 次  ${M(v.input).padStart(8)}M 输入`);
console.log('按模型:');
for (const [m, v] of [...byModel.entries()].sort((a, b) => b[1].input - a[1].input)) console.log(`  ${m.padEnd(34)} ${String(v.sessions).padStart(3)} 会话 ${String(v.calls).padStart(5)} 次 ${M(v.input).padStart(8)}M 输入`);
console.log('\n上下文最重的 8 个会话:');
for (const p of [...perSession].sort((a, b) => b.input - a.input).slice(0, 8)) console.log(`  ${p.id.slice(0, 14)}${p.isSub ? ' (subagent)' : '          '} ${String(p.calls).padStart(4)} 次 · 平均 ${String(p.avgContext).padStart(7)} · 合计 ${M(p.input).padStart(7)}M`);
const top5 = [...perSession].sort((a, b) => b.input - a.input).slice(0, 5).reduce((n, p) => n + p.input, 0);
console.log(`  前 5 个会话占全部输入 ${pct(top5, totals.input)}`);
console.log(`\n单次未命中 >50k 的调用（缓存前缀失效，整段重算）: ${invalidations.length} 次，合计 ${M(invalidations.reduce((n, x) => n + x.fresh, 0))}M = 全部未命中的 ${pct(invalidations.reduce((n, x) => n + x.fresh, 0), totals.fresh)}`);
const causes = new Map();
for (const x of invalidations) { const k = x.toolsChanged ? 'change: 工具集变化' : x.modelChanged ? 'change: 模型/参数切换' : x.reason === 'resume' ? 'resume: 会话恢复' : x.reason === 'series' ? 'series: 失效后的连锁重算' : x.reason; const v = causes.get(k) ?? { n: 0, f: 0 }; v.n++; v.f += x.fresh; causes.set(k, v); }for (const [k, v] of [...causes.entries()].sort((a, b) => b[1].f - a[1].f)) console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(2)} 次 ${M(v.f).padStart(7)}M`);
console.log(`\n冗余调用（整步只重复读已读文件，或全部是重复调用）: ${redundant.steps} 步 = 调用数的 ${pct(redundant.steps, totals.calls)}，占输入 token ${pct(redundant.tokens, totals.input)}`);
console.log('  其中 纯重读步 ' + redundant.pureReread + ' · 全重复步 ' + redundant.dupOnly);
