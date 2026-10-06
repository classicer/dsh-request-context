window.__ModuleLoader__.load({
  id: '@local/dsh-request-context',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const ROUTE = '/api/local-request-context';
    const css = `
      .dsh-rc-trigger,.dsh-rc button,.dsh-rc select { font:inherit; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:6px 10px; cursor:pointer; }
      .dsh-rc-trigger { font-size:12px; white-space:nowrap; }
      .dsh-rc { box-sizing:border-box; padding:0; width:min(1200px,96vw); height:92vh; max-width:96vw; max-height:92vh; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-family:inherit; font-size:13px; line-height:1.6; }
      .dsh-rc::backdrop { background:rgba(0,0,0,.5); }
      .dsh-rc-shell { height:100%; display:flex; flex-direction:column; min-height:0; }
      .dsh-rc header,.dsh-rc-controls { padding:12px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
      .dsh-rc h2 { margin:0; font-size:18px; flex:1; }
      .dsh-rc p { margin:0 0 10px; }
      .dsh-rc-controls select { flex:1; min-width:160px; max-width:100%; }
      .dsh-rc-body { flex:1; overflow:auto; min-height:0; padding:16px; }
      .dsh-rc-muted { color:var(--dsw-alias-label-secondary); }
      .dsh-rc-warning { color:var(--dsw-alias-state-warn-primary); }
      .dsh-rc-error { color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
      .dsh-rc-tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      .dsh-rc-tabs [aria-pressed=true] { border-color:var(--dsw-alias-brand-primary); }
      .dsh-rc pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0; padding:12px; background:var(--dsw-alias-bg-layer-1); border-radius:6px; font:12px/1.6 ui-monospace,Consolas,monospace; }
      .dsh-rc details { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px 12px; margin:8px 0; }
      .dsh-rc summary { cursor:pointer; overflow-wrap:anywhere; }
      .dsh-rc label { display:inline-flex; align-items:center; gap:5px; }
      .dsh-rc [disabled] { cursor:default; opacity:.5; }
      .dsh-rc-message-tag { color:var(--dsw-alias-brand-primary); margin-right:8px; }
      .dsh-rc-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin:12px 0; }
      .dsh-rc-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:8px; padding:12px; min-width:0; }
      .dsh-rc-card h3 { margin:0 0 8px; font-size:14px; }
      .dsh-rc-value { display:block; font-size:24px; font-weight:650; font-variant-numeric:tabular-nums; }
      .dsh-rc-chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr)); gap:12px; }
      .dsh-rc-chart { width:100%; height:auto; display:block; overflow:visible; }
      .dsh-rc-chart text { fill:var(--dsw-alias-label-secondary); font:11px sans-serif; }
      .dsh-rc-chart .dsh-rc-point { cursor:pointer; }
      .dsh-rc-chart .dsh-rc-point:focus { outline:none; stroke:var(--dsw-alias-label-primary); stroke-width:3; }
      .dsh-rc-table-scroll { overflow:auto; }
      .dsh-rc table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
      .dsh-rc th,.dsh-rc td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
      .dsh-rc tr[aria-selected=true] { background:var(--dsw-alias-bg-layer-2); }
      .dsh-rc-stack { display:flex; height:24px; border-radius:5px; overflow:hidden; margin:10px 0; background:var(--dsw-alias-bg-layer-2); }
      .dsh-rc-key { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; }
      .dsh-rc-bar { width:100%; height:6px; min-width:80px; background:var(--dsw-alias-bg-layer-2); border-radius:3px; overflow:hidden; }
      .dsh-rc-analytics-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:10px 0; }
      .dsh-rc-analytics-controls select { max-width:240px; }
      .dsh-rc-turn-legend { display:flex; gap:6px; overflow-x:auto; padding:6px 0 10px; }
      .dsh-rc-turn-legend button { flex:none; font-size:12px; }
      .dsh-rc-turn-note { padding:8px 10px; border-left:3px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); margin:10px 0; }
      @media(max-width:640px) { .dsh-rc { width:98vw; height:96vh; max-height:96vh; } .dsh-rc-controls select { flex-basis:100%; } }
    `;
    const pretty = value => JSON.stringify(value, null, 2);
    const isHuman = message => message.role === 'user' && ['user', 'user-rpc'].includes(message.source?.kind);
    const sourceName = message => message.source?.kind ?? (message.role === 'user' ? '未标明来源' : message.role);
    const preview = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 90);
    async function fetchData(sessionId, requestId, signal) {
      const params = new URLSearchParams({ sessionId });
      if (requestId) params.set('requestId', requestId);
      const response = await fetch(ROUTE + '?' + params, { credentials:'same-origin', cache:'no-store', signal });
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）。请确认插件已启用且浏览器仍已连接 Harness。`);
      return response.json();
    }
    function JsonDetails({ title, value, initiallyOpen = false }) {
      const [open, setOpen] = React.useState(initiallyOpen);
      return h('details', { open, onToggle:event => setOpen(event.currentTarget.open) },
        h('summary', null, title), open ? h('pre', null, pretty(value)) : null);
    }
    function Message({ message, index }) {
      const instructions = message.role === 'system' || message.role === 'developer' || ['agent-instructions', 'skill-invocation', 'goal', 'cordis-host-runner'].includes(sourceName(message));
      const [open, setOpen] = React.useState(instructions);
      return h('details', { open, onToggle:event => setOpen(event.currentTarget.open) },
        h('summary', null, h('strong', { className:'dsh-rc-message-tag' }, `#${index + 1} ${message.role}`),
          h('span', null, sourceName(message)), h('span', { className:'dsh-rc-muted' }, ' · ' + preview(message))),
        open ? h(React.Fragment, null,
          message.source ? h(JsonDetails, { title:'来源 source', value:message.source }) : null,
          ...(message.content ?? []).map((block, blockIndex) => h('section', { key:blockIndex },
            h('strong', null, `块 #${blockIndex + 1} · ${block.type}`),
            block.type === 'text' ? h('pre', null, block.text) : h('pre', null, pretty(block)))),
          h(JsonDetails, { title:'完整消息结构', value:message })) : null);
    }
    const categoryStyles = [
      ['system','System','brand-primary'], ['developer','Developer','state-warn-primary'],
      ['toolDefinitions','工具定义 / Schema','state-idle-primary'], ['toolCalls','工具调用','state-warn-primary'],
      ['toolResults','工具结果','state-success-primary'], ['subagent','Sub-agent 相关内容','brand-primary'],
      ['user','User','state-success-primary'], ['assistant','Assistant 历史','state-idle-primary'],
      ['context','自动注入上下文','state-warn-primary'], ['other','其他','label-secondary'],
    ];
    const colorFor = id => ({
      developer:'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 65%, var(--dsw-alias-brand-primary))',
      subagent:'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-error-primary))',
      user:'color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-brand-primary))',
      context:'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 65%, var(--dsw-alias-state-success-primary))',
      assistant:'color-mix(in srgb, var(--dsw-alias-state-idle-primary) 60%, var(--dsw-alias-brand-primary))',
    }[id] ?? `var(--dsw-alias-${categoryStyles.find(row => row[0] === id)?.[2] ?? 'label-secondary'})`);
    const validAnalytics = value => value?.version === 1 && value.method === 'heuristic-v1' && Number.isSafeInteger(value.estimatedInputTokens) && value.estimatedInputTokens >= 0 && Array.isArray(value.categories) && categoryStyles.every(([id]) => value.categories.some(row => row?.id === id && Number.isSafeInteger(row.tokens) && row.tokens >= 0));
    const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
    const delta = (current, previous) => Number.isFinite(current) && Number.isFinite(previous) ? `${current - previous >= 0 ? '+' : ''}${number(current - previous)}` : '—';
    function trendGeometry(records, field) {
      const values = records.map(record => field === 'messages' ? record.messageCount : record.analytics?.estimatedInputTokens);
      const max = values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 1);
      const coords = values.map((value, index) => Number.isFinite(value) ? { x:52 + (records.length < 2 ? 200 : index / (records.length - 1) * 400), y:174 - value / max * 140, value, index } : null);
      let started = false;
      const path = coords.map(point => { if (!point) { started = false; return ''; } const op = started ? 'L' : 'M'; started = true; return `${op}${point.x},${point.y}`; }).join(' ');
      return { max, coords, path };
    }
    const statusLabels = Object.freeze({ running:'未结束', completed:'已完成', aborted:'已取消', error:'失败', blocked:'受阻', 'max-tokens':'达到输出上限', interrupted:'已中断', forked:'分叉结束', unknown:'状态未知' });
    const statusName = status => Object.hasOwn(statusLabels, status) ? statusLabels[status] : '状态未知';
    const validTurnInfo = info => info && typeof info.key === 'string' && Number.isSafeInteger(info.turn) && info.turn >= 0 && Number.isSafeInteger(info.startSeq) && info.startSeq >= 0 && info.source === 'session-events';
    function turnDescription(record) {
      const info = record?.turnInfo;
      if (!validTurnInfo(info)) return '轮次未关联';
      const ordinal = Number.isSafeInteger(info.callInTurn) && info.callInTurn > 0 ? `本轮第 ${info.callInTurn} 次模型调用` : '辅助调用';
      return `第 ${info.turn} 轮 · ${ordinal}${Number.isSafeInteger(info.step) ? ` · 执行步骤 ${info.step}` : ''} · ${statusName(info.status)}`;
    }
    function turnSegments(records) {
      const segments = [];
      records.forEach((record, index) => {
        const info = validTurnInfo(record.turnInfo) ? record.turnInfo : null;
        const key = info?.key ?? null;
        const previous = segments.at(-1);
        if (previous && previous.key === key) { previous.end = index + 1; previous.count++; }
        else segments.push({ key, turn:info?.turn ?? null, status:info?.status ?? 'unknown', start:index, end:index + 1, count:1, firstRequestId:record.id });
      });
      const x = index => 52 + (records.length < 2 ? 200 : index / (records.length - 1) * 400);
      return segments.map(segment => ({ ...segment,
        left:segment.start === 0 ? 52 : (x(segment.start - 1) + x(segment.start)) / 2,
        right:segment.end === records.length ? 452 : (x(segment.end - 1) + x(segment.end)) / 2,
      }));
    }
    function RoundSummary({ rounds, selectedRecord, onSelect }) {
      const available = rounds?.version === 1 && rounds.available === true && Array.isArray(rounds.turns);
      const average = available && Number.isFinite(rounds.averageCompletedCalls) ? rounds.averageCompletedCalls.toLocaleString(undefined, { maximumFractionDigits:2 }) : '—';
      const turns = available ? rounds.turns.filter(turn => turn && typeof turn.key === 'string' && Number.isSafeInteger(turn.turn) && turn.turn >= 0 && Number.isSafeInteger(turn.mainCallCount) && turn.mainCallCount > 0) : [];
      return h('section', { className:'dsh-rc-card', style:{ marginBottom:12 } },
        h('h3', null, '对话执行轮次 · 模型调用统计'),
        h('div', { className:'dsh-rc-stats' },
          h('div', null, h('span', { className:'dsh-rc-muted' }, '已完成轮次平均模型调用次数'), h('strong', { className:'dsh-rc-value' }, average),
            h('span', { className:'dsh-rc-muted' }, available ? `${number(rounds.completedCallCount)} 次捕获调用 / ${number(rounds.completedTurnCount)} 个已完成轮次` : '暂无可靠轮次记录')),
          h('div', null, h('span', { className:'dsh-rc-muted' }, '当前未结束轮次 · 模型调用次数'), h('strong', { className:'dsh-rc-value' }, available ? number(rounds.currentCallCount) : '—'),
            h('span', { className:'dsh-rc-muted' }, available && Number.isSafeInteger(rounds.currentTurn) ? `第 ${rounds.currentTurn} 轮，按最近观察到的轮次事件` : '未观察到未结束轮次')),
          h('div', null, h('span', { className:'dsh-rc-muted' }, '未关联轮次的主对话调用'), h('strong', { className:'dsh-rc-value' }, number(rounds?.unassignedMainCallCount)),
            h('span', { className:'dsh-rc-muted' }, '不猜测轮次，不纳入平均值'))),
        h('p', { className:'dsh-rc-turn-note' }, `所选调用：${turnDescription(selectedRecord)}`),
        h('details', null, h('summary', null, '统计口径与历史覆盖'),
          h('p', { className:'dsh-rc-muted' }, rounds?.notice ?? '轮次来自 Session 的 turn/start 与 turn/end；新版后端加载后可将旧快照的事件前缀关联到真实轮次，没有可靠日志的历史记录仍显示未关联。'),
          h('p', { className:'dsh-rc-muted' }, '以上只统计本会话已捕获的主对话模型调用，不受图表范围或类型筛选影响。仅正常完成且有捕获调用的轮次纳入平均；未结束、取消、失败的轮次不纳入。标题生成/压缩不计入，同一步骤的不同请求各计一次。执行轮次不一定与手动用户消息一一对应。')),
        turns.length ? h('div', { className:'dsh-rc-turn-legend', 'aria-label':'按对话轮次回看调用' },
          ...turns.map(turn => h('button', { key:turn.key, type:'button', disabled:!turn.firstRequestId,
            'aria-pressed':selectedRecord?.turnInfo?.key === turn.key, onClick:() => onSelect(turn.firstRequestId),
            title:`回看该轮首个捕获的主对话模型请求；${statusName(turn.status)}` }, `第 ${turn.turn} 轮 · ${number(turn.mainCallCount)} 次 · ${statusName(turn.status)}`))) : null);
    }
    function Trend({ records, field, selected, onSelect, firstOrdinal }) {
      const title = field === 'messages' ? '每次请求内消息数变化' : '每次请求上下文 token · 估算';
      const color = field === 'messages' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)';
      const { max, coords, path } = trendGeometry(records, field);
      const segments = turnSegments(records);
      // Bound SVG focus targets for long sessions; the paged table retains every call.
      const stride = Math.max(1, Math.ceil(records.length / 180));
      return h('section', { className:'dsh-rc-card' }, h('h3', null, title),
        !records.length ? h('p', { className:'dsh-rc-muted' }, '此筛选下暂无调用。') : h(React.Fragment, null,
          h('svg', { className:'dsh-rc-chart', viewBox:'0 0 480 250', role:'group', 'aria-label':`${title}，横轴为筛选后的调用序号，分区标记真实执行轮次。点击或键盘选择圆点回看请求。` },
            ...segments.map((segment, index) => h('g', { key:'turn-' + segment.start, 'aria-label':segment.turn === null ? '轮次未关联区间' : `第 ${segment.turn} 轮，当前图表范围 ${segment.count} 次调用，${statusName(segment.status)}` },
              h('title', null, segment.turn === null ? '缺少可靠轮次关联，不按消息数推测' : `第 ${segment.turn} 轮 · 当前图表范围 ${segment.count} 次调用 · ${statusName(segment.status)}`),
              h('rect', { x:segment.left, y:28, width:Math.max(0, segment.right - segment.left), height:146,
                fill:index % 2 ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-brand-primary)', opacity:index % 2 ? .65 : .07 }),
              index > 0 ? h('line', { x1:segment.left, x2:segment.left, y1:28, y2:174, stroke:'var(--dsw-alias-label-secondary)', strokeDasharray:'3 3', opacity:.5 }) : null,
              h('rect', { x:segment.left, y:216, width:Math.max(0, segment.right - segment.left), height:22, fill:'var(--dsw-alias-bg-layer-2)', stroke:'var(--dsw-alias-border-l1)' }),
              segment.right - segment.left >= (segment.turn === null ? 60 : 34) ? h('text', { x:(segment.left + segment.right) / 2, y:231, textAnchor:'middle' }, segment.turn === null ? '未关联' : `轮 ${segment.turn}`) : null)),
            ...[0, .5, 1].map(ratio => h('g', { key:ratio },
              h('line', { x1:52, x2:452, y1:174 - ratio * 140, y2:174 - ratio * 140, stroke:'var(--dsw-alias-border-l1)' }),
              h('text', { x:46, y:178 - ratio * 140, textAnchor:'end' }, number(Math.round(max * ratio))))),
            h('path', { d:path, fill:'none', stroke:color, strokeWidth:2, vectorEffect:'non-scaling-stroke' }),
            ...coords.flatMap((point, index) => !point || (index % stride && index !== records.length - 1 && records[index].id !== selected) ? [] : [
              h('circle', { key:records[index].id, cx:point.x, cy:point.y, r:records[index].id === selected ? 6 : 3.5, fill:records[index].id === selected ? 'var(--dsw-alias-label-primary)' : color,
                className:'dsh-rc-point', tabIndex:0, role:'button', 'aria-pressed':records[index].id === selected,
                'aria-label':`调用 ${firstOrdinal + index}，${number(point.value)}，${turnDescription(records[index])}，${records[index].provider}/${records[index].model}`,
                onClick:() => onSelect(records[index].id), onKeyDown:event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(records[index].id); } } },
                h('title', null, `#${firstOrdinal + index} · ${turnDescription(records[index])} · ${new Date(records[index].capturedAt).toLocaleString()} · ${records[index].provider}/${records[index].model} · ${number(point.value)}`)),
            ]),
            h('text', { x:52, y:198 }, `#${firstOrdinal}`),
            records.length > 1 ? h('text', { x:452, y:198, textAnchor:'end' }, `#${firstOrdinal + records.length - 1}`) : null),
          h('p', { className:'dsh-rc-muted' }, '横轴：筛选后的模型调用序号；底部“轮 N”与背景分区标记真实执行轮次。范围可能从某轮中途开始，未关联区间不猜测轮次。圆点可回看，悬停可见本轮调用次序。')));
    }
    function Breakdown({ analytics }) {
      if (!validAnalytics(analytics)) return h('p', { className:'dsh-rc-muted' }, '该快照暂无可用统计。读取中或后端尚未加载新版时请稍后刷新；若快照缺失/损坏，请查看捕获失败提示。');
      const total = analytics.estimatedInputTokens;
      const rows = categoryStyles.map(([id, label]) => ({ ...analytics.categories.find(row => row?.id === id), id, label }));
      return h('section', { className:'dsh-rc-card' }, h('h3', null, '所选调用 · 输入 token 分类占比（估算）'),
        h('div', { className:'dsh-rc-stack', role:'img', 'aria-label':rows.filter(row => row.tokens).map(row => `${row.label} ${(row.tokens / total * 100).toFixed(1)}%`).join('，') || '空输入，无 token 占比' },
          ...rows.filter(row => row.tokens > 0).map(row => h('span', { key:row.id, style:{ width:`${row.tokens / total * 100}%`, background:colorFor(row.id), borderRight:'1px solid var(--dsw-alias-bg-base)' }, title:`${row.label}：${number(row.tokens)} (${(row.tokens / total * 100).toFixed(1)}%)` }))),
        h('div', { className:'dsh-rc-table-scroll' }, h('table', null,
          h('thead', null, h('tr', null, ...['分类','本次估算 token','本次占比','本次涉及消息数',''].map((text, index) => h('th', { key:index, scope:'col' }, text)))),
          h('tbody', null, ...rows.map(row => h('tr', { key:row.id },
            h('th', { scope:'row' }, h('span', { className:'dsh-rc-key', style:{ background:colorFor(row.id) } }), row.label),
            h('td', null, number(row.tokens)), h('td', null, total > 0 ? `${((row.tokens ?? 0) / total * 100).toFixed(1)}%` : '—'),
            h('td', null, number(row.messageCount)), h('td', null, h('div', { className:'dsh-rc-bar', 'aria-hidden':true }, h('div', { style:{ height:'100%', width:`${total > 0 ? (row.tokens ?? 0) / total * 100 : 0}%`, background:colorFor(row.id) } })))))))),
        h('p', { className:'dsh-rc-muted' }, '分类 token 互斥且加总为估算总量；一条消息若含文本与工具调用，可涉及多个类别，因此“涉及消息数”不可相加。Sub-agent 只含明确来源或调用关联的内容，不是子会话消耗。'),
        h('p', { className:'dsh-rc-muted' }, `工具历史另计约 ${number(analytics.toolHistoryTokens)} token（不加入总量，避免重复工具定义）。图片/文件块 ${number(analytics.attachmentCount)} 个，未估视觉或附件展开 token；未知块 ${number(analytics.unknownBlockCount)} 个。`));
    }
    function Dashboard({ listing, snapshot, selected, onSelect }) {
      const [purpose, setPurpose] = React.useState('assistant');
      const [range, setRange] = React.useState('100');
      const [page, setPage] = React.useState(0);
      const chronological = React.useMemo(() => [...(listing?.records ?? [])].reverse(), [listing]);
      const filtered = chronological.filter(record => purpose === 'all' || record.purpose === purpose);
      const visible = range === 'all' ? filtered : filtered.slice(-Number(range));
      const firstOrdinal = filtered.length - visible.length + 1;
      const current = snapshot?.meta;
      const selectedRecord = chronological.find(record => record.id === selected) ?? current;
      const currentIndex = filtered.findIndex(record => record.id === selected);
      const previous = currentIndex > 0 ? filtered[currentIndex - 1] : null;
      const analytics = validAnalytics(current?.analytics) ? current.analytics : undefined;
      const measured = filtered.filter(record => validAnalytics(record.analytics));
      const cumulative = measured.reduce((sum, record) => sum + record.analytics.estimatedInputTokens, 0);
      const maxPage = Math.max(0, Math.ceil(visible.length / 20) - 1);
      const safePage = Math.min(page, maxPage);
      const rows = visible.slice(safePage * 20, safePage * 20 + 20);
      const choose = id => onSelect(id);
      const chooseRound = id => {
        const index = chronological.filter(record => record.purpose === 'assistant').findIndex(record => record.id === id);
        setPurpose('assistant'); setRange('all'); setPage(Math.floor(Math.max(0, index) / 20));
        choose(id);
      };
      return h(React.Fragment, null,
        h('div', { className:'dsh-rc-analytics-controls' },
          h('label', null, '调用类型', h('select', { value:purpose, onChange:event => { setPurpose(event.target.value); setPage(0); } },
            ...[['assistant','主对话'],['compaction','压缩'],['session-title','标题生成'],['all','全部类型']].map(([id,label]) => h('option', { key:id, value:id }, label)))),
          h('label', null, '图表范围', h('select', { value:range, onChange:event => { setRange(event.target.value); setPage(0); } },
            ...[['30','最近 30 次'],['100','最近 100 次'],['all','全部捕获调用']].map(([id,label]) => h('option', { key:id, value:id }, label))))),
        currentIndex < 0 && selectedRecord ? h('p', { className:'dsh-rc-warning' }, '当前所选调用不在此类型筛选中；下方分类仍显示所选快照。') : null,
        currentIndex >= 0 && !visible.some(record => record.id === selected) ? h('p', { className:'dsh-rc-warning' },
          '所选调用位于当前图表范围之外。 ', h('button', { type:'button', onClick:() => { setRange('all'); setPage(Math.floor(currentIndex / 20)); } }, '显示所选调用')) : null,
        h('div', { className:'dsh-rc-stats' },
          ...[
            ['所选调用 · 消息数', current?.messageCount, `较前次 ${delta(current?.messageCount, previous?.messageCount)}`],
            ['所选调用 · 输入 token（估算）', analytics?.estimatedInputTokens, `较前次 ${delta(analytics?.estimatedInputTokens, previous?.analytics?.estimatedInputTokens)}`],
            ['筛选后 · 捕获调用数', filtered.length, `图表显示 ${visible.length} 次`],
            ['筛选后 · 累计输入 token（估算）', cumulative, `${measured.length}/${filtered.length} 次有统计；历史输入逐次重复计算`],
          ].map(([label,value,note]) => h('section', { key:label, className:'dsh-rc-card' }, h('span', { className:'dsh-rc-muted' }, label), h('strong', { className:'dsh-rc-value' }, number(value)), h('span', { className:'dsh-rc-muted' }, note)))),
        h('p', { className:'dsh-rc-muted' }, '估算口径：脱敏后的逻辑输入，ASCII 约 4 字符/token、非 ASCII 约 1 字符/token，加消息 framing 和工具 Schema。不是模型 tokenizer 或供应商 usage，不代表计费量；推理历史、适配器转换及图片会产生偏差。累计量不是当前上下文大小。'),
        h(RoundSummary, { rounds:listing?.rounds, selectedRecord, onSelect:chooseRound }),
        h('div', { className:'dsh-rc-chart-grid' },
          h(Trend, { records:visible, field:'messages', selected, onSelect:choose, firstOrdinal }),
          h(Trend, { records:visible, field:'tokens', selected, onSelect:choose, firstOrdinal })),
        h(Breakdown, { analytics }),
        h('section', { className:'dsh-rc-card', style:{ marginTop:12 } }, h('h3', null, '逐次调用数据 · 点击回看完整上下文'),
          h('div', { className:'dsh-rc-table-scroll' }, h('table', null,
            h('thead', null, h('tr', null, ...['调用','轮次 / 本轮调用','时间','类型 / 模型','消息数','变化','输入 token（估算）','变化'].map(label => h('th', { key:label, scope:'col' }, label)))),
            h('tbody', null, ...rows.map((record,index) => {
              const absolute = safePage * 20 + index;
              const prev = absolute > 0 ? visible[absolute - 1] : filtered[firstOrdinal - 2];
              return h('tr', { key:record.id, 'aria-selected':selected === record.id },
                h('td', null, h('button', { type:'button', onClick:() => choose(record.id), 'aria-label':`回看调用 ${firstOrdinal + absolute}` }, `#${firstOrdinal + absolute}`)),
                h('td', { title:turnDescription(record) }, validTurnInfo(record.turnInfo) ? `第 ${record.turnInfo.turn} 轮 / ${record.turnInfo.callInTurn == null ? '辅助' : '#' + record.turnInfo.callInTurn}` : '未关联'),
                h('td', null, new Date(record.capturedAt).toLocaleString()), h('td', null, `${record.purpose} · ${record.provider}/${record.model}`),
                h('td', null, number(record.messageCount)), h('td', null, delta(record.messageCount, prev?.messageCount)),
                h('td', null, number(record.analytics?.estimatedInputTokens)), h('td', null, delta(record.analytics?.estimatedInputTokens, prev?.analytics?.estimatedInputTokens)));
            })))),
          h('div', { className:'dsh-rc-analytics-controls' },
            h('button', { type:'button', disabled:safePage === 0, onClick:() => setPage(safePage - 1) }, '上一页'),
            h('span', null, `${safePage + 1} / ${maxPage + 1}`),
            h('button', { type:'button', disabled:safePage >= maxPage, onClick:() => setPage(safePage + 1) }, '下一页'))));
    }
    function Viewer({ sessionId, onClose }) {
      const dialog = React.useRef(null);
      const [listing, setListing] = React.useState(null);
      const [selected, setSelected] = React.useState('');
      const [follow, setFollow] = React.useState(true);
      const [refresh, setRefresh] = React.useState(0);
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState('');
      const [readError, setReadError] = React.useState('');
      const [tab, setTab] = React.useState('analytics');
      const [onlyExtra, setOnlyExtra] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const followed = React.useRef(follow);
      followed.current = follow;
      React.useEffect(() => {
        dialog.current.showModal();
        return () => { if (dialog.current?.open) dialog.current.close(); };
      }, []);
      React.useEffect(() => {
        const abort = new AbortController();
        let timer;
        async function update() {
          try {
            const value = await fetchData(sessionId, undefined, abort.signal);
            if (abort.signal.aborted) return;
            setListing(value); setError('');
            setSelected(old => followed.current ? (value.records[0]?.id ?? '') : old || (value.records[0]?.id ?? ''));
          } catch (error) {
            if (!abort.signal.aborted) setError(error.message);
          } finally {
            if (!abort.signal.aborted) timer = setTimeout(update, 2000);
          }
        }
        update();
        return () => { abort.abort(); clearTimeout(timer); };
      }, [sessionId, refresh]);
      React.useEffect(() => {
        if (!selected) { setSnapshot(null); setBusy(false); return; }
        const abort = new AbortController();
        setBusy(true); setSnapshot(null); setReadError('');
        fetchData(sessionId, selected, abort.signal).then(value => {
          if (!abort.signal.aborted) setSnapshot(value);
        }).catch(error => { if (!abort.signal.aborted) setReadError(error.message); })
          .finally(() => { if (!abort.signal.aborted) setBusy(false); });
        return () => abort.abort();
      }, [sessionId, selected, refresh]);
      const exportJson = () => {
        if (!snapshot || !window.confirm('即使已脱敏，快照仍包含完整对话、指令及工具结果。仅保存到你信任的位置，不要公开分享。继续导出？')) return;
        const url = URL.createObjectURL(new Blob([pretty(snapshot)], { type:'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `request-context-${snapshot.meta.id}.json`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const request = snapshot?.request;
      const json = (value, key) => h('pre', { key }, pretty(value));
      const content = React.useMemo(() => {
      let content = null;
      if (request) {
        if (tab === 'json') content = json(snapshot, 'full');
        else if (tab === 'config') {
          const { messages, tools, toolHistory, ...config } = request;
          content = h(React.Fragment, null,
            h('p', { className:'dsh-rc-muted' }, '调用参数按实际传入值展示。缺省参数可能由适配器决定；system 未出现时，系统内容保留在 messages 中。'), json(config, 'config'),
            h('h3', null, '观察边界'), json(snapshot.meta, 'meta'));
        } else if (tab === 'tools') {
          content = h(React.Fragment, null,
            h('p', null, `本次有效工具：${request.tools?.length ?? 0} 个。名称、说明与参数 Schema 均可展开。`),
            ...(request.tools ?? []).map((tool, index) => h(JsonDetails, { key:index, title:tool.name, value:tool })),
            h('h3', null, '工具历史（toolHistory）'),
            h('p', { className:'dsh-rc-muted' }, '历史初始声明与后续新增定义，不等同于当前有效工具。适配器可据此投影工具更新。'),
            json(request.toolHistory ?? null, 'history'));
        } else if (tab === 'messages') {
          content = h(React.Fragment, null,
            h('label', null, h('input', { type:'checkbox', checked:onlyExtra, onChange:event => setOnlyExtra(event.target.checked) }), '只看非手动用户输入（过滤仅影响这个视图，不影响完整 JSON）'),
            request.system !== undefined ? h('details', { open:true }, h('summary', null, '独立 system 字段'), h('pre', null, request.system)) : null,
            ...(request.messages ?? []).flatMap((message, index) => {
              if (onlyExtra && isHuman(message)) return [];
              return [h(Message, { key:message.id + '-' + index, message, index })];
            }));
        }
      }
      return content;
      }, [snapshot, tab, onlyExtra]);
      return createPortal(h('dialog', { ref:dialog, className:'dsh-rc', 'aria-labelledby':'dsh-rc-title', onCancel:event => { event.preventDefault(); onClose(); } },
        h('div', { className:'dsh-rc-shell' },
          h('header', null, h('h2', { id:'dsh-rc-title' }, '每次调用 · 完整请求上下文'), h('button', { type:'button', onClick:onClose, autoFocus:true }, '关闭')),
          h('div', { className:'dsh-rc-controls' },
            h('select', { value:selected, 'aria-label':'选择模型调用', onChange:event => { setFollow(false); setSelected(event.target.value); } },
              !listing?.records.length ? h('option', { value:'' }, '尚无现场捕获') : null,
              ...(listing?.records ?? []).map((record, index) => h('option', { key:record.id, value:record.id },
                `#${listing.records.length - index} · ${new Date(record.capturedAt).toLocaleString()} · ${record.purpose} · ${record.provider}/${record.model} · ${record.messageCount} 消息 · ${validTurnInfo(record.turnInfo) ? '轮 ' + record.turnInfo.turn + (record.turnInfo.callInTurn == null ? ' / 辅助' : ' / #' + record.turnInfo.callInTurn) : '轮次未关联'}`))),
            h('label', null, h('input', { type:'checkbox', checked:follow, onChange:event => { setFollow(event.target.checked); if (event.target.checked) setSelected(listing?.records[0]?.id ?? ''); } }), '跟随最新'),
            h('button', { type:'button', onClick:() => setRefresh(value => value + 1) }, '刷新'),
            h('button', { type:'button', onClick:exportJson, disabled:!snapshot || busy }, '导出脱敏 JSON')),
          h('div', { className:'dsh-rc-body' },
            h('p', { className:'dsh-rc-muted' }, listing?.notice ?? '读取本会话的现场捕获记录……'),
            h('p', { className:'dsh-rc-warning' }, '这是供应商转换前的逻辑输入，非 HTTP 抓包。包含私人对话；常见秘密会尽力脱敏，但请勿公开分享。'),
            error ? h('p', { role:'alert', className:'dsh-rc-error' }, error) : null,
            readError ? h('p', { role:'alert', className:'dsh-rc-error' }, readError) : null,
            listing?.failures.length ? h('p', { role:'alert', className:'dsh-rc-error' }, `有 ${listing.failures.length} 项快照捕获、写入或读取/统计失败，部分调用或统计不可用；其他正常记录仍可查看。请检查磁盘权限/空间及快照完整性。`) : null,
            busy ? h('p', { role:'status' }, '读取完整结构……') : null,
            listing && !listing.records.length ? h('p', null, '插件启用前的调用没有现场快照。继续发送一条消息，下一次 Harness 模型调用会自动出现在这里。') : null,
            snapshot ? h('p', null, `${request.messages.length} 条有序消息 · ${request.messages.filter(message => message.role === 'system').length} 条 system · ${request.tools?.length ?? 0} 个有效工具 · ${snapshot.meta.redactions} 处脱敏`) : null,
            h('div', { className:'dsh-rc-tabs', role:'group', 'aria-label':'请求结构视图' }, ...[['analytics','可视化概览'],['messages','有序消息与指令'],['config','模型与调用参数'],['tools','工具定义与历史'],['json','完整 JSON']].map(([id, label]) =>
              h('button', { type:'button', key:id, 'aria-pressed':tab === id, onClick:() => setTab(id) }, label))),
            h('div', { hidden:tab !== 'analytics' }, h(Dashboard, { listing, snapshot, selected, onSelect:id => { setFollow(false); setSelected(id); } })),
            tab !== 'analytics' ? content : null))
      ), document.body);
    }
    function Action({ sessionId }) {
      const [open, setOpen] = React.useState(false);
      return h(React.Fragment, null,
        h('button', { type:'button', className:'dsh-rc-trigger', onClick:() => setOpen(true), title:'查看每次模型调用的完整组装输入', 'aria-haspopup':'dialog' }, '请求上下文'),
        open ? h(Viewer, { key:sessionId, sessionId, onClose:() => setOpen(false) }) : null);
    }
    return {
      inject:['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = css;
          document.head.appendChild(style); return () => style.remove();
        });
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name:'conversation.session.header.actions', id:'local-request-context', order:30, label:'请求上下文',
        }, Action));
      },
    };
  },
});
