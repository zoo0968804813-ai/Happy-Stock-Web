const $ = (id) => document.getElementById(id);

let debugStocks = [];

function fmtMoney(value) {
  return Number(value || 0).toLocaleString('zh-TW', {
    maximumFractionDigits: 0
  });
}

function fmtNumber(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function fmtPct(value) {
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function riskClass(label) {
  if (label.includes('高度恐慌')) return 'risk-danger';
  if (label.includes('偏恐慌')) return 'risk-warning';
  if (label.includes('熱門')) return 'risk-hot';
  if (label.includes('波動')) return 'risk-warning';
  return 'risk-normal';
}

function renderDebugStocks() {
  const keyword = $('debugSearch').value.trim().toUpperCase();

  const list = debugStocks.filter((stock) => {
    return !keyword
      || String(stock.symbol || '').toUpperCase().includes(keyword)
      || String(stock.name || '').toUpperCase().includes(keyword);
  });

  $('debugGrid').innerHTML = list.map((stock) => {
    const debug = stock.debug || {};
    const label = debug.riskLabel || '正常';

    return `
      <article class="debug-stock-card">
        <div class="debug-stock-head">
          <div>
            <h2>${stock.symbol}</h2>
            <p>${stock.name || '-'}</p>
          </div>
          <span class="debug-risk ${riskClass(label)}">${label}</span>
        </div>

        <div class="debug-metrics">
          <div>
            <span>現價</span>
            <strong>${fmtNumber(stock.price)}</strong>
          </div>
          <div>
            <span>漲跌幅</span>
            <strong>${fmtPct(stock.change_pct)}</strong>
          </div>
          <div>
            <span>恐慌值</span>
            <strong>${fmtNumber(debug.panicValue, 1)}</strong>
          </div>
          <div>
            <span>熱度值</span>
            <strong>${fmtNumber(debug.heatValue, 1)}</strong>
          </div>
        </div>

        <div class="debug-bars">
          <div class="debug-bar-row">
            <span>買壓 ${fmtNumber(debug.buyPressurePct, 1)}%</span>
            <div class="debug-bar">
              <i style="width:${Math.max(0, Math.min(100, debug.buyPressurePct || 0))}%"></i>
            </div>
          </div>

          <div class="debug-bar-row">
            <span>賣壓 ${fmtNumber(debug.sellPressurePct, 1)}%</span>
            <div class="debug-bar sell">
              <i style="width:${Math.max(0, Math.min(100, debug.sellPressurePct || 0))}%"></i>
            </div>
          </div>
        </div>

        <div class="debug-detail-table">
          <div><span>開盤價</span><b>${fmtNumber(stock.open_price)}</b></div>
          <div><span>昨收</span><b>${fmtNumber(stock.previous_close)}</b></div>
          <div><span>最高</span><b>${fmtNumber(stock.high_price)}</b></div>
          <div><span>最低</span><b>${fmtNumber(stock.low_price)}</b></div>
          <div><span>合理價</span><b>${fmtNumber(stock.fair_price)}</b></div>
          <div><span>市值</span><b>${fmtMoney(stock.market_cap)}</b></div>
          <div><span>今日成交量</span><b>${fmtMoney(stock.today_volume)}</b></div>
          <div><span>交易次數</span><b>${fmtMoney(stock.trade_count)}</b></div>
          <div><span>買入金額</span><b>${fmtMoney(stock.buy_value)}</b></div>
          <div><span>賣出金額</span><b>${fmtMoney(stock.sell_value)}</b></div>
          <div><span>買賣壓差</span><b>${fmtMoney(debug.pressureDiff)}</b></div>
          <div><span>偏離合理價</span><b>${fmtPct(debug.priceToFairPct)}</b></div>
          <div><span>盤中震盪</span><b>${fmtPct(debug.intradayRangePct)}</b></div>
        </div>

        <details class="debug-formula">
          <summary>公式計算說明</summary>
          <p>漲跌幅：${debug.formulas?.changePct || '-'}</p>
          <p>買壓：${debug.formulas?.buyPressurePct || '-'}</p>
          <p>賣壓：${debug.formulas?.sellPressurePct || '-'}</p>
          <p>偏離合理價：${debug.formulas?.priceToFairPct || '-'}</p>
          <p>盤中震盪：${debug.formulas?.intradayRangePct || '-'}</p>
          <p>恐慌值：${debug.formulas?.panicValue || '-'}</p>
          <p>熱度值：${debug.formulas?.heatValue || '-'}</p>
        </details>
      </article>
    `;
  }).join('');

  if (!list.length) {
    $('debugGrid').innerHTML = `<div class="debug-empty">找不到符合條件的股票。</div>`;
  }
}

async function loadDebugMarket() {
  $('debugStatus').textContent = '載入中...';

  try {
    const res = await fetch('/api/debug/market');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    debugStocks = data.stocks || [];

    $('debugStatus').textContent = `最後更新：${new Date(data.serverTime).toLocaleString('zh-TW')}｜股票數：${debugStocks.length}`;
    renderDebugStocks();
  } catch (err) {
    $('debugStatus').textContent = `載入失敗：${err.message}`;
  }
}

$('debugSearch').addEventListener('input', renderDebugStocks);
$('debugRefreshBtn').addEventListener('click', loadDebugMarket);

loadDebugMarket();