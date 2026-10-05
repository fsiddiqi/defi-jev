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
}

const clients: Set<ServerResponse> = new Set();
let dashboardData: DashboardData = {
  status: 'starting',
  opportunities: [],
  stats: { count: 0, total_gas_usd: 0, total_profit_usd: 0, average_profit_per_liquidation: 0 },
};

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

export function initDashboard(port: number = 3000): void {
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
      res.write(`data: ${JSON.stringify(dashboardData)}\n\n`);
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
  
  server.listen(port, () => {
    logger.info(`📊 Dashboard: http://localhost:${port}`);
    logger.info(`📡 SSE endpoint: http://localhost:${port}/events`);
  });
  
  // Wire up event listeners
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
  
  eventEmitter.on('liquidation:executed', ({ state, decision, profit_usd }: { state: LiquidationState; decision: JevDecision; profit_usd: number }) => {
    const idx = dashboardData.opportunities.findIndex(o => o.state.user_address === state.user_address);
    if (idx >= 0) {
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
      const updated = [...dashboardData.opportunities];
      updated[idx] = { ...updated[idx], fill };
      updateDashboard({ opportunities: updated });
    }
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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 defi-jev Dashboard</h1>
      <div class="status">
        <span class="dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
        <span class="connection" id="connStatus">● SSE</span>
      </div>
    </header>
    
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
      
      // Table
      if (d.opportunities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty">Waiting for opportunities...</td></tr>';
        return;
      }
      
      tbody.innerHTML = d.opportunities.map((o, i) => {
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
        
        return '<tr>' +
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
  </script>
</body>
</html>`;