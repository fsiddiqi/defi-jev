import { createServer, IncomingMessage, ServerResponse } from 'http';
import { logger } from '@/logging';
import { eventEmitter } from './events';
import { LiquidationState } from '@/state/liquidation-state';
import { JevDecision } from '@/jev/classifier';
import { GateCheckResult } from '@/execution/risk-gates';
import { PaperFill } from '@/execution/paper';

interface DashboardData {
  status: 'starting' | 'running' | 'completed' | 'error';
  opportunities: Array<{
    state: LiquidationState;
    decision?: JevDecision;
    gates?: GateCheckResult;
    fill?: PaperFill;
    skipped?: boolean;
    reason?: string;
  }>;
  stats: {
    count: number;
    total_gas_usd: number;
    total_profit_usd: number;
    average_profit_per_liquidation: number;
  };
  currentOpportunity?: string;
  /** Most recent fill, with a monotonically increasing nonce so the UI can detect new executions. */
  lastExecuted?: PaperFill & { nonce: number };
}

let executionCounter = 0;

const clients: Set<ServerResponse> = new Set();
let dashboardData: DashboardData = {
  status: 'starting',
  opportunities: [],
  stats: { count: 0, total_gas_usd: 0, total_profit_usd: 0, average_profit_per_liquidation: 0 },
};
let dashboardServer: ReturnType<typeof createServer> | null = null;

function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

function updateDashboard(partial: Partial<DashboardData>): void {
  dashboardData = { ...dashboardData, ...partial };
  broadcast('update', dashboardData);
}

let eventsWired = false;

export function initDashboard(port: number = 3000): void {
  // Wire event listeners exactly once, even across tsx watch reloads
  if (!eventsWired) {
    wireEvents();
    eventsWired = true;
  }

  // Already listening — don't try to bind the port again
  if (dashboardServer) {
    return;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    
    if (url.pathname === '/events') {
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // Must be a named 'update' event, otherwise the client's
      // addEventListener('update') handler never sees the initial snapshot
      res.write(`event: update\ndata: ${JSON.stringify(dashboardData)}\n\n`);
      clients.add(res);
      
      req.on('close', () => clients.delete(res));
      return;
    }
    
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      return;
    }
    
    // Serve dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(DASHBOARD_HTML);
  });
  
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Dashboard port ${port} already in use — assuming previous instance still running`);
    } else {
      logger.error('Dashboard server error:', err);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`📊 Dashboard: http://localhost:${port} (or your LAN IP)`);
    logger.info(`📡 SSE endpoint: http://localhost:${port}/events`);
  });

  dashboardServer = server;
}

function wireEvents(): void {
  eventEmitter.on('state:generated', (state: LiquidationState) => {
    updateDashboard({
      status: 'running',
      currentOpportunity: state.user_address,
      opportunities: [...dashboardData.opportunities, { state }],
    });
  });

  eventEmitter.on('jev:decision', ({ decision, stateHash }: { decision: JevDecision; stateHash: string }) => {
    const idx = dashboardData.opportunities.findIndex(o => o.state.user_address === stateHash);
    if (idx >= 0) {
      const updated = [...dashboardData.opportunities];
      updated[idx] = { ...updated[idx], decision };
      updateDashboard({ opportunities: updated });
    }
  });

  eventEmitter.on('gates:checked', ({ result }: { result: GateCheckResult }) => {
    const idx = dashboardData.opportunities.findIndex(o => o.state.user_address === result.state.user_address);
    if (idx >= 0) {
      const updated = [...dashboardData.opportunities];
      updated[idx] = { ...updated[idx], gates: result, skipped: !result.should_execute, reason: result.reason };
      updateDashboard({ opportunities: updated });
    }
  });

  eventEmitter.on('liquidation:executed', ({ state, profit_usd }: { state: LiquidationState; profit_usd: number }) => {
    const fill: PaperFill = {
      timestamp: Date.now(),
      user_address: state.user_address,
      collateral_asset: state.collateral_asset,
      debt_asset: state.debt_asset,
      debt_closed_usd: parseFloat(state.debt_usd_value) * state.ltv_close_factor,
      gas_spent_usd: (state.gas_price_gwei * state.gas_estimate_units * 3000) / 1e9,
      profit_usd,
      status: 'simulated',
    };

    const idx = dashboardData.opportunities.findIndex(o => o.state.user_address === state.user_address);
    const updated = [...dashboardData.opportunities];
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], fill };
    } else {
      updated.push({ state, fill });
    }

    // Track the most recent fill so the UI can flash a banner for it
    updateDashboard({
      opportunities: updated,
      lastExecuted: { ...fill, nonce: ++executionCounter },
    });
  });

  eventEmitter.on('session:stats', (stats: DashboardData['stats']) => {
    updateDashboard({ status: 'completed', stats });
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>defi-jev Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; }
    body { margin: 0; background: #0d1117; color: #e6edf3; line-height: 1.5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #30363d; }
    h1 { margin: 0; font-size: 1.5rem; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; }
    .dot.running { background: #3fb950; animation: pulse 2s infinite; }
    .dot.completed { background: #58a6ff; }
    .dot.error { background: #f85149; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 1.5rem; font-weight: 600; margin-top: 4px; }
    .stat-value.profit { color: #3fb950; }
    .stat-value.gas { color: #f85149; }
    .stat-value.count { color: #58a6ff; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #21262d; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; color: #8b949e; }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: #1f2428; }
    .address { font-family: monospace; font-size: 0.875rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .badge-executed { background: #238636; color: #fff; }
    .badge-skipped { background: #9e6a03; color: #fff; }
    .badge-pending { background: #1f6feb; color: #fff; }
    .ltv { font-family: monospace; }
    .ltv.high { color: #f85149; }
    .ltv.med { color: #d29922; }
    .ltv.low { color: #3fb950; }
    .profit { font-family: monospace; font-weight: 600; }
    .profit.pos { color: #3fb950; }
    .profit.neg { color: #f85149; }
    .empty { text-align: center; color: #8b949e; padding: 40px; }
    .connection { font-size: 0.75rem; color: #8b949e; }
    .connection.connected { color: #3fb950; }

    /* ---- Simulation banner: permanent, unmissable ---- */
    .sim-banner { display: flex; align-items: center; gap: 14px; padding: 12px 20px; background: repeating-linear-gradient(45deg, #3d2e00, #3d2e00 12px, #4a3800 12px, #4a3800 24px); border-bottom: 2px solid #d29922; color: #f0d68a; font-size: 0.875rem; position: sticky; top: 0; z-index: 200; }
    .sim-badge { background: #d29922; color: #1c1400; font-weight: 800; font-size: 0.75rem; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px; white-space: nowrap; }
    .sim-text strong { color: #ffd479; }
    .sim-pulse { width: 10px; height: 10px; border-radius: 50%; background: #d29922; margin-left: auto; animation: simPulse 1.5s ease-in-out infinite; flex-shrink: 0; }
    @keyframes simPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
    .title-sim { color: #d29922; font-size: 0.875rem; letter-spacing: 1px; vertical-align: middle; }

    /* Last executed liquidation, always visible under the header */
    .last-exec { display: flex; align-items: center; gap: 12px; padding: 10px 16px; margin-bottom: 20px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; border-left: 4px solid #8b949e; font-size: 0.875rem; }
    .last-exec.active { border-left-color: #3fb950; background: rgba(35,134,54,0.10); }
    .last-exec.active.neg { border-left-color: #f85149; background: rgba(248,81,73,0.10); }
    .last-exec-label { font-size: 0.6875rem; font-weight: 700; letter-spacing: 1px; color: #8b949e; white-space: nowrap; }
    .last-exec-body { color: #e6edf3; }
    .last-exec-body .pos { color: #3fb950; font-weight: 700; }
    .last-exec-body .neg { color: #f85149; font-weight: 700; }

    /* ---- Execution feed: makes each liquidation obvious ---- */
    .feed { margin-bottom: 24px; max-height: 260px; overflow-y: auto; border: 1px solid #30363d; border-radius: 8px; background: #161b22; }
    .feed:empty { display: none; }
    .feed-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #21262d; border-left: 3px solid #238636; animation: slideIn 0.35s ease-out; }
    .feed-item:last-child { border-bottom: none; }
    .feed-icon { font-size: 1.25rem; line-height: 1; }
    .feed-body { flex: 1; min-width: 0; }
    .feed-title { font-weight: 600; font-size: 0.875rem; }
    .feed-meta { font-size: 0.75rem; color: #8b949e; }
    .feed-profit { font-weight: 700; font-size: 1.125rem; white-space: nowrap; }
    .feed-profit.pos { color: #3fb950; }
    .feed-profit.neg { color: #f85149; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }

    /* Flash banner for the latest fill */
    .flash { position: fixed; top: 20px; right: 20px; z-index: 100; max-width: 340px; padding: 16px 20px; border-radius: 10px; background: #161b22; border: 1px solid #238636; border-left: 4px solid #3fb950; box-shadow: 0 8px 32px rgba(0,0,0,0.6); animation: flashIn 0.4s ease-out; }
    .flash.pending { animation: flashIn 0.4s ease-out, pulseBorder 1s ease-in-out infinite; }
    .flash-title { font-weight: 700; color: #3fb950; margin-bottom: 4px; }
    .flash-row { font-size: 0.8125rem; color: #e6edf3; }
    @keyframes flashIn { from { opacity: 0; transform: translateX(40px) scale(0.95); } to { opacity: 1; transform: none; } }
    @keyframes pulseBorder { 0%, 100% { box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 0 rgba(63,185,80,0.4); } 50% { box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 10px rgba(63,185,80,0); } }

    /* Executed rows glow so they're impossible to miss in the table */
    tr.executed { background: rgba(35,134,54,0.14); box-shadow: inset 3px 0 0 #3fb950; }
    tr.executed td { font-weight: 600; }
    tr.flash-row-anim { animation: rowFlash 1.2s ease-out; }
    @keyframes rowFlash { 0% { background: rgba(63,185,80,0.55); } 100% { background: rgba(35,134,54,0.14); } }

    .badge-executed { background: #238636; color: #fff; animation: badgePulse 2s ease-in-out infinite; }
    @keyframes badgePulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(63,185,80,0.6); } 50% { box-shadow: 0 0 0 6px rgba(63,185,80,0); } }

    /* ---- Jev AI Thinking Panel ---- */
    .thinking-panel { margin-bottom: 24px; border: 1px solid #30363d; border-radius: 10px; background: #0d1117; overflow: hidden; }
    .thinking-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
    .thinking-badge { display: flex; align-items: center; gap: 6px; background: #1f6feb; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.5px; }
    .thinking-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: #58a6ff; animation: thinkPulse 0.8s ease-in-out infinite; }
    @keyframes thinkPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .thinking-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; margin-left: auto; }
    .thinking-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 16px; }
    .thinking-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; transition: all 0.2s ease; position: relative; }
    .thinking-card.updating { box-shadow: 0 0 0 2px #1f6feb; animation: thinkFlash 0.3s ease-out; }
    @keyframes thinkFlash { from { box-shadow: 0 0 0 4px #1f6feb; } to { box-shadow: 0 0 0 2px #1f6feb; } }
    .thinking-card-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; margin-bottom: 6px; }
    .thinking-card-value { font-family: 'JetBrains Mono', monospace; font-size: 1.5rem; font-weight: 700; color: #e6edf3; }
    .thinking-card-sub { font-size: 0.75rem; color: #8b949e; margin-top: 4px; }
    .thinking-card.progress { border-left: 3px solid #1f6feb; }
    .thinking-card.success { border-left: 3px solid #3fb950; }
    .thinking-card.warning { border-left: 3px solid #d29922; }
    .thinking-card.danger { border-left: 3px solid #f85149; }
    .progress-bar { height: 6px; background: #21262d; border-radius: 3px; margin-top: 8px; overflow: hidden; }
    .progress-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease-out, background 0.2s; }
    .gate-list { list-style: none; padding: 0; margin: 8px 0 0; font-size: 0.75rem; }
    .gate-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .gate-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .gate-dot.pass { background: #3fb950; }
    .gate-dot.fail { background: #f85149; }
    .gate-dot.pending { background: #8b949e; opacity: 0.5; animation: thinkPulse 0.8s ease-in-out infinite; }
    .gate-text { color: #e6edf3; }
    .gate-text.fail { color: #f85149; }
    .reasoning-step { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px dashed #21262d; font-size: 0.8125rem; line-height: 1.5; }
    .reasoning-step:last-child { border-bottom: none; }
    .reasoning-icon { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; flex-shrink: 0; margin-top: 2px; }
    .reasoning-icon.analyzing { background: #1f6feb; color: #fff; animation: thinkPulse 1s ease-in-out infinite; }
    .reasoning-icon.gate { background: #d29922; color: #1c1400; }
    .reasoning-icon.decision { background: #3fb950; color: #fff; }
    .reasoning-icon.skip { background: #f85149; color: #fff; }
    .reasoning-text { flex: 1; }
    .reasoning-text strong { color: #f0d68a; }
    .reasoning-text .dim { color: #8b949e; }
    .agent-mind { font-size: 0.75rem; color: #58a6ff; margin-top: 8px; font-style: italic; min-height: 20px; }

    /* Dual column layout */
    .main-grid { display: grid; grid-template-columns: 1fr 380px; gap: 24px; }
    @media (max-width: 1100px) { .main-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="sim-banner" id="simBanner">
    <span class="sim-badge">SIMULATED</span>
    <span class="sim-text">
      Paper trading &mdash; <strong>no real transactions are sent on-chain.</strong>
      All fills, profits, and gas costs below are synthetic estimates from mock data.
    </span>
    <span class="sim-pulse" aria-hidden="true"></span>
  </div>

  <div class="container">
    <header>
      <h1>🤖 defi-jev <span class="title-sim">· SIMULATION</span></h1>
      <div class="status">
        <span class="dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
        <span class="connection" id="connStatus">● SSE</span>
      </div>
    </header>

    <div class="last-exec" id="lastExec">
      <span class="last-exec-label">LAST SIMULATED LIQUIDATION</span>
      <span class="last-exec-body" id="lastExecBody">None yet this session</span>
    </div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Liquidations</div>
        <div class="stat-value count" id="statCount">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Profit</div>
        <div class="stat-value profit" id="statProfit">$0.00</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Gas</div>
        <div class="stat-value gas" id="statGas">$0.00</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Profit/Tx</div>
        <div class="stat-value" id="statAvg">$0.00</div>
      </div>
    </div>

    <div class="main-grid">
      <!-- Left column: Opportunities & Feed -->
      <div>
        <h2 style="font-size:0.875rem;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;margin:0 0 8px" id="feedHeading">Execution Feed</h2>
        <div class="feed" id="feed"></div>
        
        <table id="oppTable">
          <thead>
            <tr>
              <th>Account</th>
              <th>Pair</th>
              <th>LTV</th>
              <th>Urgency</th>
              <th>Profitability</th>
              <th>Safety</th>
              <th>Gas</th>
              <th>Profit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <!-- Right column: Jev AI Thinking Panel -->
      <div class="thinking-panel" id="thinkingPanel" style="display:none;">
        <div class="thinking-header">
          <span class="thinking-badge">
            <span class="dot" aria-hidden="true"></span>
            JEV SYSTEM ONE · ANALYZING
          </span>
          <span class="thinking-title" id="thinkingAccount">No active analysis</span>
        </div>
        <div class="thinking-grid" id="thinkingGrid">
          <!-- Urgency Card -->
          <div class="thinking-card" id="cardUrgency">
            <div class="thinking-card-label">Urgency</div>
            <div class="thinking-card-value" id="valUrgency">—</div>
            <div class="thinking-card-sub">Distance to liquidation threshold</div>
            <div class="progress-bar"><div class="progress-bar-fill" id="barUrgency" style="width:0%;background:#8b949e;"></div></div>
          </div>
          <!-- Profitability Card -->
          <div class="thinking-card" id="cardProf">
            <div class="thinking-card-label">Profitability</div>
            <div class="thinking-card-value" id="valProf">—</div>
            <div class="thinking-card-sub">Estimated profit potential (0-100)</div>
            <div class="progress-bar"><div class="progress-bar-fill" id="barProf" style="width:0%;background:#8b949e;"></div></div>
          </div>
          <!-- Safety Card -->
          <div class="thinking-card" id="cardSafety">
            <div class="thinking-card-label">Safety Score</div>
            <div class="thinking-card-value" id="valSafety">—</div>
            <div class="thinking-card-sub">Sandwich / frontrun risk (0-1)</div>
            <div class="progress-bar"><div class="progress-bar-fill" id="barSafety" style="width:0%;background:#8b949e;"></div></div>
          </div>
          <!-- Confidence Card -->
          <div class="thinking-card" id="cardConf">
            <div class="thinking-card-label">Confidence</div>
            <div class="thinking-card-value" id="valConf">—</div>
            <div class="thinking-card-sub">Composite certainty</div>
            <div class="progress-bar"><div class="progress-bar-fill" id="barConf" style="width:0%;background:#8b949e;"></div></div>
          </div>
          <!-- Risk Gates Card -->
          <div class="thinking-card" style="grid-column:1/-1;" id="cardGates">
            <div class="thinking-card-label">Risk Gates</div>
            <ul class="gate-list" id="gateList">
              <li><span class="gate-dot pending"></span><span class="gate-text">Waiting for Jev decision...</span></li>
            </ul>
          </div>
        </div>
        <div style="padding:0 16px 16px;">
          <div class="thinking-card-label">Reasoning Trace</div>
          <div id="reasoningSteps"></div>
          <div class="agent-mind" id="agentMind"></div>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    const evtSource = new EventSource('/events');
    const tbody = document.querySelector('#oppTable tbody');
    
    evtSource.onopen = () => {
      document.getElementById('connStatus').className = 'connection connected';
      document.getElementById('connStatus').textContent = '● SSE Connected';
    };
    
    evtSource.onerror = () => {
      document.getElementById('connStatus').className = 'connection';
      document.getElementById('connStatus').textContent = '● SSE Disconnected';
    };
    
    evtSource.addEventListener('update', (e) => {
      const data = JSON.parse(e.data);
      render(data);
    });

    // Track execution nonces so we only flash/fire once per new liquidation
    const seenNonces = new Set();
    let flashTimer = null;

    function flashFill(fill) {
      const el = document.createElement('div');
      const pos = fill.profit_usd >= 0;
      const accent = pos ? '#3fb950' : '#f85149';
      el.className = 'flash';
      el.style.borderColor = accent;
      el.style.borderLeftColor = accent;
      el.innerHTML =
        '<div class="flash-title" style="color:' + accent + '">LIQUIDATION EXECUTED</div>' +
        '<div class="flash-row"><code>' + fill.user_address.slice(0, 12) + '...</code></div>' +
        '<div class="flash-row">Closed $' + fill.debt_closed_usd.toFixed(2) + ' ' + fill.debt_asset +
          ' &middot; gas $' + fill.gas_spent_usd.toFixed(2) + '</div>' +
        '<div class="flash-row">Profit <strong style="color:' + accent + '">' +
          (pos ? '+' : '') + '$' + fill.profit_usd.toFixed(2) + '</strong> (simulated)</div>';
      document.body.appendChild(el);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.remove(), 6000);
    }

    function renderFeed(items) {
      const feed = document.getElementById('feed');
      const heading = document.getElementById('feedHeading');
      const executed = items.filter(o => o.fill);
      heading.style.display = executed.length ? '' : 'none';
      if (executed.length === 0) { feed.innerHTML = ''; return; }

      feed.innerHTML = executed.slice().reverse().map(o => {
        const f = o.fill;
        const cls = f.profit_usd >= 0 ? 'pos' : 'neg';
        return '<div class="feed-item">' +
          '<span class="feed-icon">\u{1F4B8}</span>' +
          '<div class="feed-body">' +
            '<div class="feed-title">' + f.collateral_asset + ' &rarr; ' + f.debt_asset + ' liquidation</div>' +
            '<div class="feed-meta"><code>' + f.user_address.slice(0, 10) + '...</code> &middot; closed $' +
              f.debt_closed_usd.toFixed(2) + ' &middot; gas $' + f.gas_spent_usd.toFixed(2) + '</div>' +
          '</div>' +
          '<div class="feed-profit ' + cls + '">' + (f.profit_usd >= 0 ? '+' : '') + '$' + f.profit_usd.toFixed(2) + '</div>' +
        '</div>';
      }).join('');
    }
    
    // Thinking panel state
    let currentAnalysis = null;
    let reasoningHistory = [];

    function updateThinkingPanel(d) {
      const panel = document.getElementById('thinkingPanel');
      const accountEl = document.getElementById('thinkingAccount');
      
      // Find the opportunity currently being analyzed (has decision but no fill yet, or just got decision)
      const analyzing = d.opportunities.find(o => o.decision && !o.fill && !o.skipped);
      const justDecided = d.opportunities.find(o => o.decision && o.gates && !o.fill);
      const justSkipped = d.opportunities.find(o => o.skipped && o.gates);

      if (analyzing || justDecided || justSkipped) {
        panel.style.display = '';
        const target = analyzing || justDecided || justSkipped;
        accountEl.textContent = target.state.user_address.slice(0, 10) + '... · ' + target.state.collateral_asset + '/' + target.state.debt_asset;
        
        if (target.decision) {
          const dec = target.decision;
          
          // Update cards with animated transitions
          updateCard('Urgency', 'valUrgency', 'barUrgency', 'cardUrgency', 
            (dec.urgency * 100).toFixed(1) + '%', dec.urgency, 
            dec.urgency >= 0.8 ? 'success' : dec.urgency >= 0.6 ? 'warning' : 'danger');
          updateCard('Profitability', 'valProf', 'barProf', 'cardProf',
            '$' + dec.profitability.toFixed(0), dec.profitability / 100,
            dec.profitability >= 50 ? 'success' : dec.profitability >= 25 ? 'warning' : 'danger');
          updateCard('Safety', 'valSafety', 'barSafety', 'cardSafety',
            (dec.is_safe * 100).toFixed(1) + '%', dec.is_safe,
            dec.is_safe >= 0.8 ? 'success' : dec.is_safe >= 0.7 ? 'warning' : 'danger');
          updateCard('Confidence', 'valConf', 'barConf', 'cardConf',
            (dec.confidence * 100).toFixed(1) + '%', dec.confidence,
            dec.confidence >= 0.75 ? 'success' : dec.confidence >= 0.6 ? 'warning' : 'danger');

          // Update risk gates
          if (target.gates) {
            renderGates(target.gates);
          }

          // Add reasoning trace for this decision if new
          if (currentAnalysis !== target.state.user_address) {
            currentAnalysis = target.state.user_address;
            reasoningHistory = [];
            addReasoningStep('analyzing', 'Analyzing position', 
              'LTV ' + (target.state.ltv_current * 100).toFixed(1) + '% vs threshold ' + (target.state.ltv_liquidation_threshold * 100).toFixed(1) + '%');
            addReasoningStep('analyzing', 'Fetching Jev assessment', 
              'Urgency: ' + (dec.urgency * 100).toFixed(1) + '% | Profitability: $' + dec.profitability.toFixed(0) + ' | Safety: ' + (dec.is_safe * 100).toFixed(1) + '%');
            
            if (target.gates) {
              const passed = target.gates.passed_gates.length;
              const failed = target.gates.failed_gates.length;
              addReasoningStep('gate', 'Evaluating ' + (passed + failed) + ' risk gates', 
                passed + ' passed, ' + failed + ' failed');
              if (target.gates.should_execute) {
                addReasoningStep('decision', 'APPROVED FOR EXECUTION', 
                  'All gates passed. Estimated profit: $' + target.state.profit_after_gas.toFixed(2));
              } else {
                addReasoningStep('skip', 'REJECTED: ' + target.gates.reason, 
                  'Failed gates: ' + target.gates.failed_gates.join(', '));
              }
            }
          }
        }
      } else if (d.status === 'completed' || d.opportunities.length === 0) {
        // Keep panel visible but show idle state
        panel.style.display = '';
        accountEl.textContent = 'Idle — awaiting next opportunity';
        resetCards();
        document.getElementById('gateList').innerHTML = 
          '<li><span class="gate-dot pending"></span><span class="gate-text">Waiting for Jev decision...</span></li>';
        document.getElementById('reasoningSteps').innerHTML = '';
        document.getElementById('agentMind').textContent = '';
      }
    }

    function updateCard(label, valId, barId, cardId, value, progress, state) {
      const valEl = document.getElementById(valId);
      const barEl = document.getElementById(barId);
      const cardEl = document.getElementById(cardId);
      
      valEl.textContent = value;
      barEl.style.width = (progress * 100) + '%';
      barEl.style.background = state === 'success' ? '#3fb950' : state === 'warning' ? '#d29922' : '#f85149';
      cardEl.className = 'thinking-card ' + state + ' updating';
      setTimeout(() => cardEl.className = 'thinking-card ' + state, 300);
    }

    function resetCards() {
      ['Urgency', 'Prof', 'Safety', 'Conf'].forEach(suffix => {
        const valEl = document.getElementById('val' + suffix);
        const barEl = document.getElementById('bar' + suffix);
        const cardEl = document.getElementById('card' + suffix);
        if (valEl) valEl.textContent = '—';
        if (barEl) { barEl.style.width = '0%'; barEl.style.background = '#8b949e'; }
        if (cardEl) cardEl.className = 'thinking-card';
      });
    }

    function renderGates(gates) {
      const gateEl = document.getElementById('gateList');
      if (!gates) return;
      const allGates = [
        { key: 'urgency', label: 'Urgency ≥ 60%', pass: gates.passed_gates.some(g => g.includes('urgency')) },
        { key: 'profitability', label: 'Profitability ≥ $25', pass: gates.passed_gates.some(g => g.includes('profitability')) },
        { key: 'safety', label: 'Safety ≥ 70%', pass: gates.passed_gates.some(g => g.includes('safety')) },
        { key: 'gas', label: 'Gas ≤ $200', pass: gates.passed_gates.some(g => g.includes('gas cost')) },
        { key: 'minProfit', label: 'Min Profit ≥ $10', pass: gates.passed_gates.some(g => g.includes('min profit')) },
        { key: 'ltv', label: 'LTV Improvement OK', pass: gates.passed_gates.some(g => g.includes('ltv improvement')) },
      ];
      gateEl.innerHTML = allGates.map(g => 
        '<li><span class="gate-dot ' + (g.pass ? 'pass' : 'fail') + '"></span>' +
        '<span class="gate-text ' + (g.pass ? '' : 'fail') + '">' + g.label + '</span></li>'
      ).join('');
    }

    function addReasoningStep(type, title, detail) {
      reasoningHistory.push({ type, title, detail, time: Date.now() });
      const stepsEl = document.getElementById('reasoningSteps');
      stepsEl.innerHTML = reasoningHistory.map(s => 
        '<div class="reasoning-step">' +
          '<div class="reasoning-icon ' + s.type + '">' + iconForType(s.type) + '</div>' +
          '<div class="reasoning-text"><strong>' + s.title + '</strong><br><span class="dim">' + s.detail + '</span></div>' +
        '</div>'
      ).join('');
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }

    function iconForType(type) {
      return type === 'analyzing' ? '◐' : type === 'gate' ? '⚖' : type === 'decision' ? '✓' : '✕';
    }

    function updateAgentMind(d) {
      const mindEl = document.getElementById('agentMind');
      if (d.lastExecuted) {
        const pos = d.lastExecuted.profit_usd >= 0;
        mindEl.innerHTML = '<strong>Agent:</strong> ' + (pos 
          ? 'Executed liquidation. Profit captured: +$' + d.lastExecuted.profit_usd.toFixed(2) + '. Continuing scan...'
          : 'Executed at a loss: $' + d.lastExecuted.profit_usd.toFixed(2) + '. Adjusting thresholds...');
      } else if (currentAnalysis) {
        mindEl.textContent = 'Agent: Processing risk gates for ' + currentAnalysis.slice(0, 10) + '...';
      }
    }

    function render(d) {
      // Status
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      dot.className = 'dot ' + d.status;
      text.textContent = d.status.charAt(0).toUpperCase() + d.status.slice(1);
      
      // Stats
      document.getElementById('statCount').textContent = d.stats.count;
      document.getElementById('statProfit').textContent = '$' + d.stats.total_profit_usd.toFixed(2);
      document.getElementById('statGas').textContent = '$' + d.stats.total_gas_usd.toFixed(2);
      document.getElementById('statAvg').textContent = '$' + d.stats.average_profit_per_liquidation.toFixed(2);
      
      // Thinking panel (Jev AI reflexive reasoning)
      updateThinkingPanel(d);
      updateAgentMind(d);

      // Table
      if (d.opportunities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty">Waiting for opportunities...</td></tr>';
      } else {
        renderFeed(d.opportunities);

        // Header strip: persistently shows the most recent simulated fill
        const lastBox = document.getElementById('lastExec');
        const lastBody = document.getElementById('lastExecBody');
        if (d.lastExecuted) {
          const f = d.lastExecuted;
          const pos = f.profit_usd >= 0;
          lastBox.className = 'last-exec active' + (pos ? '' : ' neg');
          lastBody.innerHTML =
            '<code>' + f.user_address.slice(0, 10) + '...</code> &middot; ' +
            f.collateral_asset + ' &rarr; ' + f.debt_asset + ' &middot; closed $' +
            f.debt_closed_usd.toFixed(2) + ' &middot; gas $' + f.gas_spent_usd.toFixed(2) +
            ' &middot; <span class="' + (pos ? 'pos' : 'neg') + '">' +
            (pos ? '+' : '') + '$' + f.profit_usd.toFixed(2) + '</span>';
        } else {
          lastBox.className = 'last-exec';
          lastBody.textContent = 'None yet this session';
        }

        // Flash the toast only for genuinely new executions
        if (d.lastExecuted && !seenNonces.has(d.lastExecuted.nonce)) {
          seenNonces.add(d.lastExecuted.nonce);
          flashFill(d.lastExecuted);
        }

        const justExecuted = d.lastExecuted ? d.lastExecuted.user_address : null;

        tbody.innerHTML = d.opportunities.map((o) => {
          const ltv = (o.state.ltv_current * 100).toFixed(1);
          const ltvClass = ltv >= 85 ? 'high' : ltv >= 75 ? 'med' : 'low';
          const urgency = o.decision ? (o.decision.urgency * 100).toFixed(1) + '%' : '—';
          const prof = o.decision ? '$' + o.decision.profitability.toFixed(0) : '—';
          const safety = o.decision ? (o.decision.is_safe * 100).toFixed(1) + '%' : '—';
          const gas = o.state.gas_price_gwei.toFixed(1) + ' gwei';
          const profit = o.fill ? o.fill.profit_usd : (o.state.profit_after_gas || 0);
          const profitClass = profit >= 0 ? 'pos' : 'neg';
          const profitStr = '$' + profit.toFixed(2);
          
          let badge = '<span class="badge badge-pending">Pending</span>';
          if (o.fill) badge = '<span class="badge badge-executed">Executed</span>';
          else if (o.skipped) badge = '<span class="badge badge-skipped">Skipped</span>';

          const rowCls = o.fill ? 'executed' : '';
          const animCls = (o.fill && o.state.user_address === justExecuted) ? ' flash-row-anim' : '';

          return '<tr class="' + rowCls + animCls + '">' +
            '<td class="address">' + o.state.user_address.slice(0, 10) + '...</td>' +
            '<td>' + o.state.collateral_asset + '/' + o.state.debt_asset + '</td>' +
            '<td class="ltv ' + ltvClass + '">' + ltv + '%</td>' +
            '<td>' + urgency + '</td>' +
            '<td>' + prof + '</td>' +
            '<td>' + safety + '</td>' +
            '<td>' + gas + '</td>' +
            '<td class="profit ' + profitClass + '">' + profitStr + '</td>' +
            '<td>' + badge + '</td>' +
          '</tr>';
        }).join('');
      }
    }
  </script>
</body>
</html>`;