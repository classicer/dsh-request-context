import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextStore } from './store.js';
import { isTurnBoundary } from './turns.js';

export const inject = ['connection', 'sessions'];
export const ROUTE = '/api/local-request-context';

// The operator-authenticated Connection transport owns Origin/Host/auth checks.
// No independent unauthenticated Web route is created.
export function apply(ctx, config = {}) {
  const dataDir = resolve(config.dataDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '.state', 'default'));
  const store = new ContextStore(dataDir);
  ctx.effect(() => () => store.dispose());
  const syncTurns = (sessionId, session) => {
    try {
      const live = session ?? ctx.sessions.get(sessionId);
      const state = store.syncSessionTurns(live, sessionId);
      return { session:live, verified:Boolean(state?.live && state.liveSession === live && state.problem !== 'sync') };
    } catch { store.noteTurnFailure(sessionId); return { session:undefined, verified:false }; }
  };
  ctx.on('session/event', (session, event) => {
    if (isTurnBoundary(event) && typeof session?.id === 'string') syncTurns(session.id, session);
  });
  ctx.on('llm/stream', function observeRequest(options, next) {
    // IMPORTANT: a synchronous hook, before next()/await/first generator iteration.
    // Observe immutable call arguments without rewriting options or injecting content.
    let boundary = { turnAssociationVerified:false };
    // Tracking errors (including Session getter failures) are isolated from capture.
    try {
      if (typeof options?.sessionId === 'string') {
        const { session, verified } = syncTurns(options.sessionId);
        boundary.inputEventCount = session?.seq;
        if (verified) Object.assign(boundary, store.turnBoundary(options.sessionId, boundary.inputEventCount));
      }
    } catch { store.noteTurnFailure(options?.sessionId); }
    try {
      store.capture(options, boundary);
    } catch (error) {
      store.captureFailure(options?.sessionId, error.code ?? 'NON_JSON_REQUEST');
      console.warn('[request-context] capture failed:', error.code ?? 'NON_JSON_REQUEST');
    }
    return next();
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId');
      const requestId = url.searchParams.get('requestId');
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (!sessionId || sessionId.length > 256 || /[\u0000-\u001f]/.test(sessionId)) {
        return Response.json({ error: 'Invalid sessionId' }, { status: 400, headers });
      }
      if (requestId !== null && !/^[a-f0-9-]{36}$/.test(requestId)) {
        return Response.json({ error: 'Invalid requestId' }, { status: 400, headers });
      }
      try {
        syncTurns(sessionId);
        const value = requestId === null ? await store.list(sessionId) : await store.get(sessionId, requestId);
        return Response.json(value, { headers });
      } catch (error) {
        const status = error.code === 'ENOENT' ? 404 : 500;
        return Response.json({ error: status === 404 ? 'Snapshot not found' : 'Snapshot cannot be read; storage or integrity error' }, { status, headers });
      }
    },
  }));
}
