const { useState, useEffect, useCallback } = React;

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
  const level = confidenceLevel(belief.confidence);
  return React.createElement('div', {
    className: 'belief-card',
    'data-type': belief.type,
  },
    React.createElement('div', { className: 'belief-header' },
      React.createElement('span', {
        className: 'belief-type-badge',
        'data-type': belief.type,
      }, TYPE_LABELS[belief.type]),
      React.createElement('span', { className: 'belief-timestamp' }, formatTime(belief.timestamp))
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
      React.createElement('div', { className: 'confidence-bar' },
        React.createElement('div', { className: 'confidence-track' },
          React.createElement('div', {
            className: 'confidence-fill',
            'data-level': level,
            style: { width: `${belief.confidence * 100}%` },
          })
        ),
        React.createElement('span', { className: 'confidence-value' }, belief.confidence.toFixed(2))
      )
    )
  );
}

function App() {
  const [beliefs, setBeliefs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [wrongOnly, setWrongOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/sessions')
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {});
  }, []);

  const loadBeliefs = useCallback((sessionId) => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`/api/beliefs/${sessionId}`)
      .then(r => r.json())
      .then(data => {
        setBeliefs(data.beliefs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedSession) loadBeliefs(selectedSession);
  }, [selectedSession, loadBeliefs]);

  const filtered = beliefs.filter(b => {
    if (filterType !== 'all' && b.type !== filterType) return false;
    if (b.confidence < minConfidence) return false;
    if (wrongOnly && b.confidence >= 0.4) return false;
    return true;
  });

  const avgConfidence = beliefs.length > 0
    ? (beliefs.reduce((s, b) => s + b.confidence, 0) / beliefs.length).toFixed(2)
    : '-';

  const typeCounts = beliefs.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {});

  return React.createElement('div', { className: 'container' },
    // Header
    React.createElement('div', { className: 'header' },
      React.createElement('div', { className: 'header-title' },
        'Axion ', React.createElement('span', { className: 'accent' }, 'Lens')
      ),
    ),
    // Session selector
    React.createElement('div', { className: 'session-selector' },
      React.createElement('select', {
        className: 'filter-select',
        value: selectedSession,
        onChange: e => setSelectedSession(e.target.value),
      },
        React.createElement('option', { value: '' }, '- Select Session -'),
        ...sessions.map(s => React.createElement('option', { key: s, value: s }, s))
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
          checked: wrongOnly,
          onChange: e => setWrongOnly(e.target.checked),
        }),
        'Wrong beliefs only'
      ),
    ),
    // Timeline
    loading
      ? React.createElement('div', { className: 'empty-state' }, 'Loading beliefs...')
      : filtered.length === 0 && beliefs.length > 0
        ? React.createElement('div', { className: 'empty-state' }, 'No beliefs match the current filters.')
        : filtered.length === 0
          ? React.createElement('div', { className: 'empty-state' },
              'No beliefs yet. Point an agent at this proxy to start capturing.'
            )
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
