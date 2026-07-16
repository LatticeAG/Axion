const { useState, useEffect, useCallback, useRef } = React;

const TYPE_COLORS = {
  causal: '#3b82f6',
  assumption: '#eab308',
  intention: '#22c55e',
  evidence: '#a855f7',
};

const TYPE_LABELS = {
  causal: 'Causal',
  assumption: 'Assumption',
  intention: 'Intention',
  evidence: 'Evidence',
};

const REFRESH_INTERVAL_MS = 4000;

function confidenceLevel(conf) {
  if (conf >= 0.7) return 'high';
  if (conf >= 0.4) return 'mid';
  return 'low';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Stat({ value, label }) {
  return React.createElement('div', { className: 'stat' },
    React.createElement('div', { className: 'stat-value' }, value),
    React.createElement('div', { className: 'stat-label' }, label)
  );
}

function BeliefCard({ belief }) {
  const [expanded, setExpanded] = useState(false);
  const hasConfidence = typeof belief.confidence === 'number';
  const level = hasConfidence ? confidenceLevel(belief.confidence) : null;
  const rawText = typeof belief.rawText === 'string' ? belief.rawText.trim() : '';
  const canExpand = rawText.length > 0;

  return React.createElement('div', {
    className: 'belief-card' + (expanded ? ' is-expanded' : '') + (canExpand ? ' is-clickable' : ''),
    'data-type': belief.type,
    onClick: canExpand ? () => setExpanded(v => !v) : undefined,
    role: canExpand ? 'button' : undefined,
    tabIndex: canExpand ? 0 : undefined,
    onKeyDown: canExpand
      ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v); } }
      : undefined,
    title: canExpand ? (expanded ? 'Click to collapse raw text' : 'Click to view raw text') : undefined,
  },
    React.createElement('div', { className: 'belief-header' },
      React.createElement('span', {
        className: 'belief-type-badge',
        'data-type': belief.type,
      }, TYPE_LABELS[belief.type] || belief.type),
      React.createElement('span', { className: 'belief-header-right' },
        canExpand && React.createElement('span', {
          className: 'belief-expand-hint',
          'aria-hidden': true,
        }, expanded ? '−' : '+'),
        React.createElement('span', { className: 'belief-timestamp' }, formatTime(belief.timestamp))
      )
    ),
    React.createElement('div', { className: 'belief-text' }, belief.belief),
    React.createElement('div', { className: 'belief-meta' },
      belief.evidence && React.createElement('div', null,
        React.createElement('span', { className: 'belief-meta-label' }, 'Evidence: '),
        belief.evidence
      ),
      belief.actionTaken && React.createElement('div', null,
        React.createElement('span', { className: 'belief-meta-label' }, 'Action: '),
        belief.actionTaken
      ),
      hasConfidence && React.createElement('div', { className: 'confidence-bar' },
        React.createElement('div', { className: 'confidence-track' },
          React.createElement('div', {
            className: 'confidence-fill',
            'data-level': level,
            style: { width: `${belief.confidence * 100}%` },
          })
        ),
        React.createElement('span', { className: 'confidence-value' }, belief.confidence.toFixed(2))
      )
    ),
    canExpand && expanded && React.createElement('div', { className: 'belief-raw' },
      React.createElement('div', { className: 'belief-raw-label' }, 'Raw text'),
      React.createElement('pre', { className: 'belief-raw-text' }, rawText)
    )
  );
}

const SESSION_STORAGE_KEY = 'axion.sessionId';

function readStoredSession() {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function persistSession(sessionId) {
  try {
    if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch (e) {
    /* localStorage unavailable (private mode) - non-fatal */
  }
}

function initialSessionId() {
  const fromUrl = new URLSearchParams(window.location.search).get('session');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  return readStoredSession();
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for insecure contexts / older browsers.
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function App() {
  const [beliefs, setBeliefs] = useState([]);
  const [meta, setMeta] = useState(null);
  const [sessionInput, setSessionInput] = useState('');
  const [activeSession, setActiveSession] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const [cleared, setCleared] = useState(false);

  // Track the session the interval should poll without re-arming the timer
  // on every belief update.
  const activeSessionRef = useRef('');
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);

  // Silent belief-list refresh: only touches the beliefs list + meta, never
  // the loading spinner or any input the user might be mid-typing in.
  const refreshBeliefs = useCallback((sessionId) => {
    if (!sessionId) return;
    setRefreshing(true);
    fetch(`/api/beliefs/${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then(data => {
        setBeliefs(data.beliefs || []);
        setMeta(data.meta || null);
      })
      .catch(() => { /* transient poll failure - keep last good data */ })
      .finally(() => setRefreshing(false));
  }, []);

  const loadBeliefs = useCallback((sessionId) => {
    if (!sessionId) return;
    setActiveSession(sessionId);
    setCleared(false);
    setLoading(true);
    fetch(`/api/beliefs/${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then(data => {
        setBeliefs(data.beliefs || []);
        setMeta(data.meta || null);
        setLoading(false);
        setAutoRefresh(true);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleLoad = useCallback(() => {
    const sessionId = sessionInput.trim();
    if (!sessionId) return;
    persistSession(sessionId);
    loadBeliefs(sessionId);
  }, [sessionInput, loadBeliefs]);

  const handleCopy = useCallback(() => {
    if (!activeSession) return;
    copyToClipboard(activeSession)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => { /* clipboard blocked - nothing we can do */ });
  }, [activeSession]);

  const handleExport = useCallback(() => {
    if (!activeSession) return;
    const payload = { sessionId: activeSession, beliefs };
    if (meta) payload.meta = meta;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axion-${activeSession}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeSession, beliefs, meta]);

  const handleClear = useCallback(() => {
    if (!activeSession) return;
    const ok = window.confirm(
      `Clear all stored beliefs for session "${activeSession}"?\n\nThis deletes the session's timeline on the server and cannot be undone.`
    );
    if (!ok) return;
    setAutoRefresh(false);
    fetch(`/api/beliefs/${encodeURIComponent(activeSession)}`, { method: 'DELETE' })
      .then(() => {
        setBeliefs([]);
        setMeta(null);
        setCleared(true);
      })
      .catch(() => { /* leave UI as-is on failure */ });
  }, [activeSession]);

  useEffect(() => {
    const initial = initialSessionId();
    if (initial) {
      setSessionInput(initial);
      persistSession(initial);
      loadBeliefs(initial);
    }
  }, [loadBeliefs]);

  // Auto-refresh poller. Only runs while enabled and a session is loaded.
  useEffect(() => {
    if (!autoRefresh || !activeSession) return;
    const timer = setInterval(() => {
      const id = activeSessionRef.current;
      if (id) refreshBeliefs(id);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, activeSession, refreshBeliefs]);

  const filtered = beliefs.filter(b => {
    if (filterType !== 'all' && b.type !== filterType) return false;
    const hasConfidence = typeof b.confidence === 'number';
    if (hasConfidence && b.confidence < minConfidence) return false;
    if (lowConfidenceOnly && !(hasConfidence && b.confidence < 0.4)) return false;
    return true;
  });

  const scored = beliefs.filter(b => typeof b.confidence === 'number');
  const avgConfidence = scored.length > 0
    ? (scored.reduce((s, b) => s + b.confidence, 0) / scored.length).toFixed(2)
    : '-';

  const typeCounts = beliefs.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {});

  const hasSession = !!activeSession;

  // Distinct empty-state copy for each situation.
  let emptyState = null;
  if (loading) {
    emptyState = React.createElement('div', { className: 'empty-state' },
      React.createElement('div', { className: 'empty-state-title' }, 'Loading beliefs…'),
      React.createElement('div', { className: 'empty-state-sub' }, `Fetching timeline for ${activeSession}.`)
    );
  } else if (!hasSession) {
    emptyState = React.createElement('div', { className: 'empty-state' },
      React.createElement('div', { className: 'empty-state-title' }, 'No session loaded'),
      React.createElement('div', { className: 'empty-state-sub' },
        'Paste a session id above (the ', React.createElement('code', null, 'x-axion-session'),
        ' you send through the proxy) and hit Load.')
    );
  } else if (cleared && beliefs.length === 0) {
    emptyState = React.createElement('div', { className: 'empty-state' },
      React.createElement('div', { className: 'empty-state-title' }, 'Session cleared'),
      React.createElement('div', { className: 'empty-state-sub' },
        'The timeline for this session was deleted. New agent activity will repopulate it.')
    );
  } else if (beliefs.length === 0) {
    emptyState = React.createElement('div', { className: 'empty-state' },
      React.createElement('div', { className: 'empty-state-title' }, 'No beliefs captured yet'),
      React.createElement('div', { className: 'empty-state-sub' },
        'Point an agent at this proxy with this session id to start capturing beliefs.')
    );
  } else if (filtered.length === 0) {
    emptyState = React.createElement('div', { className: 'empty-state' },
      React.createElement('div', { className: 'empty-state-title' }, 'No beliefs match your filters'),
      React.createElement('div', { className: 'empty-state-sub' },
        'Loosen the type, confidence, or low-confidence filters to see more.')
    );
  }

  return React.createElement('div', { className: 'container' },
    // Header
    React.createElement('div', { className: 'header' },
      React.createElement('div', { className: 'header-title' },
        'Axion ', React.createElement('span', { className: 'accent' }, 'Lens')
      ),
      hasSession && React.createElement('div', { className: 'header-session' },
        autoRefresh && React.createElement('span', {
          className: 'refresh-dot' + (refreshing ? ' refreshing' : ''),
          title: refreshing ? 'Refreshing…' : 'Auto-refresh on',
          'aria-hidden': true,
        }),
        React.createElement('span', { className: 'session-id-label' }, 'Session'),
        React.createElement('code', { className: 'session-id-value', title: activeSession }, activeSession),
        React.createElement('button', {
          type: 'button',
          className: 'ghost-btn copy-btn' + (copied ? ' is-copied' : ''),
          onClick: handleCopy,
        }, copied ? 'Copied' : 'Copy')
      )
    ),
    // Session selector
    React.createElement('div', { className: 'session-selector' },
      React.createElement('form', {
        className: 'session-form',
        onSubmit: e => { e.preventDefault(); handleLoad(); },
      },
        React.createElement('input', {
          type: 'text',
          className: 'filter-input session-input',
          placeholder: 'Paste session id (x-axion-session)',
          value: sessionInput,
          spellCheck: false,
          autoComplete: 'off',
          onChange: e => setSessionInput(e.target.value),
        }),
        React.createElement('button', {
          type: 'submit',
          className: 'session-load-btn',
          disabled: !sessionInput.trim(),
        }, 'Load')
      ),
      hasSession && React.createElement('div', { className: 'session-controls' },
        React.createElement('label', { className: 'filter-toggle auto-refresh-toggle' },
          React.createElement('input', {
            type: 'checkbox',
            checked: autoRefresh,
            onChange: e => setAutoRefresh(e.target.checked),
          }),
          'Auto-refresh'
        ),
        React.createElement('button', {
          type: 'button',
          className: 'ghost-btn',
          onClick: handleExport,
          disabled: beliefs.length === 0,
        }, 'Export JSON'),
        React.createElement('button', {
          type: 'button',
          className: 'ghost-btn danger-btn',
          onClick: handleClear,
        }, 'Clear session')
      )
    ),
    // Stats
    beliefs.length > 0 && React.createElement('div', { className: 'stats' },
      React.createElement(Stat, { value: beliefs.length, label: 'Total Beliefs' }),
      React.createElement(Stat, { value: avgConfidence, label: 'Avg Confidence' }),
      ...Object.entries(typeCounts).map(([type, count]) =>
        React.createElement(Stat, {
          key: type,
          value: count,
          label: TYPE_LABELS[type] || type,
        })
      ),
    ),
    // Filters
    beliefs.length > 0 && React.createElement('div', { className: 'filters' },
      React.createElement('div', { className: 'filter-group' },
        React.createElement('span', { className: 'filter-label' }, 'Type'),
        React.createElement('select', {
          className: 'filter-select',
          value: filterType,
          onChange: e => setFilterType(e.target.value),
        },
          React.createElement('option', { value: 'all' }, 'All'),
          ...Object.entries(TYPE_LABELS).map(([k, v]) =>
            React.createElement('option', { key: k, value: k }, v)
          )
        )
      ),
      React.createElement('div', { className: 'filter-group' },
        React.createElement('span', { className: 'filter-label' }, 'Min Confidence'),
        React.createElement('input', {
          type: 'number',
          className: 'filter-input',
          min: '0',
          max: '1',
          step: '0.1',
          value: minConfidence,
          onChange: e => setMinConfidence(parseFloat(e.target.value) || 0),
        })
      ),
      React.createElement('label', { className: 'filter-toggle' },
        React.createElement('input', {
          type: 'checkbox',
          checked: lowConfidenceOnly,
          onChange: e => setLowConfidenceOnly(e.target.checked),
        }),
        'Low confidence only'
      ),
    ),
    // Timeline
    emptyState
      ? emptyState
      : React.createElement('div', { className: 'timeline' },
          ...filtered.map(b => React.createElement(BeliefCard, { key: b.id, belief: b }))
        ),
    // Footer
    React.createElement('div', { className: 'footer' },
      React.createElement('div', { className: 'footer-wordmark' },
        React.createElement('a', { href: 'https://github.com/LatticeAG/Axion', target: '_blank' }, 'LatticeAG'),
        ' - Agents, together.'
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
