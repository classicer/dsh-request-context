import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped plain-JS module without installing another React or contacting a model.
const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const states = [];
let cursor = 0;
const React = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value != null) }),
  useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
  useMemo: fn => fn(), useRef: () => ({ current: null }), useEffect: () => {},
};
let components;
const context = vm.createContext({ window: { __ModuleLoader__: { load(module) {
  module.factory(name => name === 'react' ? React : { createPortal: node => node });
} } }, document: { body: {} }, URLSearchParams, AbortController, console });
vm.runInContext(source.replace('    return {\n      inject:', '    window.__components = { trendGeometry, turnSegments, turnDescription, RoundSummary, Trend, Breakdown, Dashboard, Viewer };\n    return {\n      inject:'), context);
components = context.window.__components;
const nodes = tree => typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(nodes)] : [];
const text = tree => typeof tree === 'object' && tree ? tree.children.map(text).join(' ') : String(tree);
const render = (component, props, initial = []) => { states.length = 0; states.push(...initial); cursor = 0; return component(props); };
const categories = ['system','developer','toolDefinitions','toolCalls','toolResults','subagent','user','assistant','context','other'];
const analytics = total => ({ version:1, method:'heuristic-v1', estimatedInputTokens:total, categories:categories.map(id => ({ id, tokens:id === 'user' ? total : 0, messageCount:id === 'user' ? 1 : 0 })), toolHistoryTokens:0, attachmentCount:0, unknownBlockCount:0 });
const record = (id, count, total, purpose = 'assistant') => ({ id, messageCount:count, analytics:total == null ? undefined : analytics(total), purpose, provider:'test-provider', model:'test-model', capturedAt:'2026-01-01T00:00:00.000Z' });

test('trend geometry handles empty, singleton, drops and missing estimates without invented zeros', () => {
  assert.equal(components.trendGeometry([], 'tokens').path, '');
  const one = components.trendGeometry([record('a',1,0)], 'tokens');
  assert.equal(one.coords[0].x,252);
  assert.equal(one.coords[0].value,0);
  const trend = components.trendGeometry([record('a',1,100), record('b',2,null), record('c',1,30)], 'tokens');
  assert.equal(trend.coords[1],null);
  assert.equal((trend.path.match(/M/g) ?? []).length,2);
  assert.ok(trend.coords[2].y > trend.coords[0].y);
  assert.ok(!/NaN|Infinity/.test(trend.path));
});

test('chart selection supports click, Enter and Space with bounded focus targets', () => {
  const records = Array.from({length:1000},(_,index) => record(String(index),index,index));
  const selected = [];
  const tree = render(components.Trend,{records,field:'tokens',selected:'501',onSelect:id => selected.push(id),firstOrdinal:1});
  const points = nodes(tree).filter(node => node.type === 'circle');
  assert.ok(points.length <= 182);
  const point = points.find(node => node.props['aria-pressed']);
  assert.ok(point);
  point.props.onClick();
  let prevented = 0;
  point.props.onKeyDown({key:'Enter',preventDefault(){prevented++;}});
  point.props.onKeyDown({key:' ',preventDefault(){prevented++;}});
  assert.deepEqual(selected,['501','501','501']);
  assert.equal(prevented,2);
  assert.ok(points.some(node => node.props['aria-label'].startsWith('调用 1000')));
});

test('breakdown handles zero, missing and populated statistics accessibly', () => {
  for (const value of [undefined,{}, {version:1,method:'heuristic-v1',estimatedInputTokens:4}, analytics(0),analytics(500)]) {
    const tree = render(components.Breakdown,{analytics:value});
    assert.ok(!/NaN|Infinity/.test(text(tree)));
    if (value?.categories) {
      assert.equal(nodes(tree).filter(node => node.type === 'tr').length,11);
      const bar = nodes(tree).find(node => node.props.className === 'dsh-rc-stack');
      assert.ok(bar.props['aria-label']);
      if (value.estimatedInputTokens) assert.equal(bar.children[0].props.style.width,'100%');
    }
  }
});

test('dashboard defaults to main calls, oldest-first, and distinguishes cumulative from per-call tokens', () => {
  const a = record('a',2,100), b = record('b',4,150), title = record('title',1,900,'session-title');
  const selected = [];
  const tree = render(components.Dashboard,{listing:{records:[title,b,a]},snapshot:{meta:b},selected:'b',onSelect:id => selected.push(id)});
  const trends = nodes(tree).filter(node => node.type === components.Trend);
  assert.equal(trends.length,2);
  assert.deepEqual(Array.from(trends[0].props.records,row => row.id),['a','b']);
  assert.match(text(tree),/250/);
  assert.match(text(tree),/\+50/);
  assert.match(text(tree),/累计量不是当前上下文大小/);
  const button = nodes(tree).find(node => node.props['aria-label'] === '回看调用 1');
  button.props.onClick(); assert.deepEqual(selected,['a']);
});

test('range and pagination retain all rows; selected outside filter is explicitly indicated', () => {
  const records = Array.from({length:150},(_,index) => record(String(index),index,index)).reverse();
  const tree = render(components.Dashboard,{listing:{records},snapshot:{meta:record('title',1,3,'session-title')},selected:'title',onSelect(){}},['assistant','100',4]);
  assert.match(text(tree),/当前所选调用不在此类型筛选中/);
  const trend = nodes(tree).find(node => node.type === components.Trend);
  assert.equal(trend.props.records.length,100);
  assert.equal(trend.props.firstOrdinal,51);
  const buttons = nodes(tree).filter(node => node.props['aria-label']?.startsWith('回看调用'));
  assert.equal(buttons.length,20);
  assert.equal(buttons[0].props['aria-label'],'回看调用 131');
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === '下一页').props.disabled,true);
});

test('viewer keeps dashboard mounted while reading a selected request, and selecting disables follow', () => {
  const listing = {records:[record('a',1,10)],failures:[],notice:'test'};
  const tree = render(components.Viewer,{sessionId:'test',onClose(){}},[listing,'a',true,0,null,'','','analytics',false,true]);
  const dashboard = nodes(tree).find(node => node.type === components.Dashboard);
  assert.ok(dashboard);
  assert.equal(dashboard.props.snapshot,null);
  dashboard.props.onSelect('previous');
  assert.equal(states[1],'previous');
  assert.equal(states[2],false);
});

test('viewer retains the same dashboard component under a hidden wrapper on non-chart tabs', () => {
  const listing = {records:[record('a',1,10)],failures:[],notice:'test'};
  for (const tab of ['analytics','messages','json','config','tools']) {
    const tree = render(components.Viewer,{sessionId:'test',onClose(){}},[listing,'a',false,0,null,'','',tab,false,false]);
    const wrapper = nodes(tree).find(node => node.type === 'div' && node.children.some(child => child?.type === components.Dashboard));
    assert.ok(wrapper);
    assert.equal(wrapper.props.hidden,tab !== 'analytics');
    assert.equal(wrapper.children[0].props.key,undefined);
  }
});

const withTurn = (value, turn, startSeq, callInTurn, status = 'running') => ({ ...value, turnInfo:{ key:'turn:' + startSeq, turn, startSeq, step:callInTurn, callInTurn, status, source:'session-events' } });

test('turn segments use explicit associations, cover plotted coordinates and never infer unknown turns', () => {
  const records = [withTurn(record('a',2,10),1,5,3,'completed'),withTurn(record('b',4,20),1,5,4,'completed'),record('unknown',5,30),withTurn(record('c',6,40),2,20,1)];
  const segments = components.turnSegments(records);
  assert.deepEqual(Array.from(segments,row => [row.key,row.start,row.end,row.count]),[['turn:5',0,2,2],[null,2,3,1],['turn:20',3,4,1]]);
  assert.equal(segments[0].left,52);
  assert.equal(segments.at(-1).right,452);
  assert.equal(segments[0].right,segments[1].left);
  assert.equal(segments[1].right,segments[2].left);
  const one = components.turnSegments([withTurn(record('single',2,10),9,90,22)]);
  assert.equal(one[0].left,52); assert.equal(one[0].right,452);
  assert.equal(components.turnSegments([]).length,0);
  assert.match(components.turnDescription(records[0]),/第 1 轮.*第 3 次/);
  assert.equal(components.turnDescription(records[2]),'轮次未关联');
});

test('chart annotates real turns and tooltip keeps global per-turn ordinal when view starts mid-turn', () => {
  const records = [withTurn(record('a',2,10),1,5,9,'completed'),withTurn(record('b',4,20),2,20,1)];
  const selected = [];
  const tree = render(components.Trend,{records,field:'messages',selected:'a',onSelect:id => selected.push(id),firstOrdinal:99});
  assert.match(text(tree),/轮 1/); assert.match(text(tree),/轮 2/);
  const point = nodes(tree).find(node => node.type === 'circle' && node.props['aria-pressed']);
  assert.match(point.props['aria-label'],/调用 99.*第 1 轮.*第 9 次模型调用/);
  point.props.onClick(); assert.deepEqual(selected,['a']);
  const boundaries = nodes(tree).filter(node => node.type === 'line' && node.props.strokeDasharray);
  assert.equal(boundaries.length,1);
});

test('round summary uses captured completed rounds, excludes current from average and supports round navigation', () => {
  const selected = [];
  const rounds = {version:1,available:true,turns:[
    {key:'turn:5',turn:1,startSeq:5,status:'completed',mainCallCount:4,firstRequestId:'a'},
    {key:'turn:20',turn:2,startSeq:20,status:'completed',mainCallCount:2,firstRequestId:'b'},
    {key:'turn:30',turn:3,startSeq:30,status:'running',mainCallCount:12,firstRequestId:'c'},
  ],completedTurnCount:2,completedCallCount:6,averageCompletedCalls:3,currentTurnKey:'turn:30',currentTurn:3,currentCallCount:12,unassignedMainCallCount:1,notice:'捕获记录可能不完整'};
  const tree = render(components.RoundSummary,{rounds,selectedRecord:withTurn(record('c',2,10),3,30,12),onSelect:id => selected.push(id)});
  const values = nodes(tree).filter(node => node.props.className === 'dsh-rc-value').map(text);
  assert.deepEqual(values,['3','12','1']);
  assert.match(text(tree),/6 次捕获调用 \/ 2 个已完成轮次/);
  assert.match(text(tree),/第 3 轮.*第 12 次/);
  const button = nodes(tree).find(node => node.type === 'button' && node.props['aria-pressed']);
  button.props.onClick(); assert.deepEqual(selected,['c']);
  assert.match(text(tree),/不受图表范围或类型筛选影响/);
});

test('unknown or missing round log renders dashes rather than invented averages or current turn', () => {
  for (const rounds of [undefined,{version:1,available:false,turns:[],unassignedMainCallCount:5},{version:1,available:true,turns:[],averageCompletedCalls:null,currentTurn:null,currentCallCount:null,unassignedMainCallCount:0,completedTurnCount:0,completedCallCount:0}]) {
    const tree = render(components.RoundSummary,{rounds,selectedRecord:record('a',2,10),onSelect(){}});
    const values = nodes(tree).filter(node => node.props.className === 'dsh-rc-value').map(text);
    assert.equal(values[0],'—'); assert.equal(values[1],'—');
    assert.match(text(tree),/轮次未关联/);
    assert.ok(!/NaN|Infinity/.test(text(tree)));
  }
});

test('dashboard uses fresh listing round association even if unchanged selected snapshot has stale status', () => {
  const current = withTurn(record('a',2,10),1,5,1,'completed');
  const snapshot = {meta:withTurn(record('a',2,10),1,5,1,'running')};
  const rounds = {version:1,available:true,turns:[],completedTurnCount:1,completedCallCount:1,averageCompletedCalls:1,currentTurn:null,currentCallCount:null,unassignedMainCallCount:0};
  const tree = render(components.Dashboard,{listing:{records:[current],rounds},snapshot,selected:'a',onSelect(){}},['compaction','30',0]);
  const summary = nodes(tree).find(node => node.type === components.RoundSummary);
  assert.equal(summary.props.rounds,rounds);
  assert.equal(summary.props.selectedRecord.turnInfo.status,'completed');
});

test('round navigation reveals older calls by switching to all main calls and locating the table page', () => {
  const records = Array.from({length:150},(_,index) => withTurn(record(String(index),index,index),Math.floor(index / 10) + 1,Math.floor(index / 10) * 20,index % 10 + 1)).reverse();
  const selected = [];
  const tree = render(components.Dashboard,{listing:{records},snapshot:{meta:records[0]},selected:'149',onSelect:id => selected.push(id)},['assistant','30',0]);
  const summary = nodes(tree).find(node => node.type === components.RoundSummary);
  summary.props.onSelect('80');
  assert.deepEqual(states.slice(0,3),['assistant','all',4]);
  assert.deepEqual(selected,['80']);
});

test('request selection outside the recent range offers a reveal button without altering selected request', () => {
  const records = Array.from({length:150},(_,index) => record(String(index),index,index)).reverse();
  const selected = [];
  const tree = render(components.Dashboard,{listing:{records},snapshot:{meta:records[69]},selected:'80',onSelect:id => selected.push(id)},['assistant','30',0]);
  assert.match(text(tree),/所选调用位于当前图表范围之外/);
  const button = nodes(tree).find(node => node.type === 'button' && text(node) === '显示所选调用');
  button.props.onClick();
  assert.deepEqual(states.slice(0,3),['assistant','all',4]);
  assert.deepEqual(selected,[]);
});
