const $ = (id) => document.getElementById(id);

let debugStocks = [];
let selectedSymbol = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

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

function fmtDateTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-TW');
}

function changeClass(value) {
  const num = Number(value || 0);
  if (num > 0) return 'up-text';
  if (num < 0) return 'down-text';
  return 'flat-text';
}

function riskClass(label) {
  const text = String(label || '');
  if (text.includes('高度恐慌')) return 'risk-danger';
  if (text.includes('偏恐慌')) return 'risk-warning';
  if (text.includes('熱門')) return 'risk-hot';
  if (text.includes('波動')) return 'risk-warning';
  return 'risk-normal';
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function getFilteredStocks() {
  const keyword = $('debugSearch').value.trim().toUpperCase();

  return debugStocks.filter((stock) => {
    return !keyword
      || String(stock.symbol || '').toUpperCase().includes(keyword)
      || String(stock.name || '').toUpperCase().includes(keyword)
      || String(stock.sector || '').toUpperCase().includes(keyword);
  });
}

function renderStockList() {
  const list = getFilteredStocks();

  $('debugStockCount').textContent = `${list.length} 檔`;

  if (!list.length) {
    $('debugStockList').innerHTML = `<div class="debug-empty">找不到符合條件的股票。</div>`;
    return;
  }

  $('debugStockList').innerHTML = list.map((stock) => {
    const active = stock.symbol === selectedSymbol ? 'active' : '';
    const stockChangeClass = changeClass(stock.change_pct);

    return `
      <button class="debug-stock-row ${active}" type="button" data-symbol="${escapeHtml(stock.symbol)}">
        <div>
          <strong>${escapeHtml(stock.symbol)}</strong>
          <span>${escapeHtml(stock.name || '-')}</span>
        </div>
        <div class="debug-stock-row-price">
          <b>${fmtNumber(stock.price)}</b>
          <small class="${stockChangeClass}">${fmtPct(stock.change_pct)}</small>
        </div>
      </button>
    `;
  }).join('');

  document.querySelectorAll('.debug-stock-row').forEach((button) => {
    button.addEventListener('click', () => {
      selectedSymbol = button.dataset.symbol;
      renderDebugPage();
    });
  });
}

function metric(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderSelectedStock(stock) {
  const debug = stock.debug || {};
  const label = debug.riskLabel || '正常';
  const stockChangeClass = changeClass(stock.change_pct);

  $('debugSector').textContent = stock.sector || '--';
  $('debugTitle').textContent = `${stock.symbol}｜${stock.name || '-'}`;
  $('debugSubtitle').textContent = stock.description || '此股票目前沒有描述。';

  $('debugRiskBadge').textContent = label;
  $('debugRiskBadge').className = `debug-risk ${riskClass(label)}`;

  $('debugPrice').textContent = fmtNumber(stock.price);
  $('debugChange').className = `debug-change-text ${stockChangeClass}`;
  $('debugChange').textContent = `${fmtNumber(stock.change)}　${fmtPct(stock.change_pct)} 今日`;
  $('debugUpdateTime').textContent = `最後更新：${fmtDateTime(stock.updated_at)}`;

  const buyPressure = clampPct(debug.buyPressurePct);
  const sellPressure = clampPct(debug.sellPressurePct);

  $('debugBuyPressure').textContent = `${fmtNumber(buyPressure, 1)}%`;
  $('debugSellPressure').textContent = `${fmtNumber(sellPressure, 1)}%`;
  $('debugBuyBar').style.width = `${buyPressure}%`;
  $('debugSellBar').style.width = `${sellPressure}%`;

  $('debugOverviewGrid').innerHTML = [
    metric('現價', fmtNumber(stock.price)),
    metric('開盤價', fmtNumber(stock.open_price)),
    metric('昨收', fmtNumber(stock.previous_close)),
    metric('最高價', fmtNumber(stock.high_price)),
    metric('最低價', fmtNumber(stock.low_price)),
    metric('合理價', fmtNumber(stock.fair_price)),
    metric('總市值', fmtMoney(stock.market_cap)),
    metric('總股數', fmtMoney(stock.total_shares)),
    metric('今日成交量', fmtMoney(stock.today_volume)),
    metric('交易次數', fmtMoney(stock.trade_count)),
    metric('漲跌限制', `${fmtNumber(stock.daily_limit_pct, 1)}%`),
    metric('狀態', stock.status || '--')
  ].join('');

  $('debugEmotionGrid').innerHTML = [
    metric('恐慌值', fmtNumber(debug.panicValue, 1)),
    metric('熱度值', fmtNumber(debug.heatValue, 1)),
    metric('買入金額', fmtMoney(stock.buy_value)),
    metric('賣出金額', fmtMoney(stock.sell_value)),
    metric('買賣壓差', fmtMoney(debug.pressureDiff)),
    metric('偏離合理價', fmtPct(debug.priceToFairPct)),
    metric('盤中震盪', fmtPct(debug.intradayRangePct)),
    metric('風險狀態', label)
  ].join('');

  const formulas = debug.formulas || {};

  $('debugFormulaList').innerHTML = [
    ['漲跌幅', formulas.changePct],
    ['買壓', formulas.buyPressurePct],
    ['賣壓', formulas.sellPressurePct],
    ['偏離合理價', formulas.priceToFairPct],
    ['盤中震盪', formulas.intradayRangePct],
    ['恐慌值', formulas.panicValue],
    ['熱度值', formulas.heatValue]
  ].map(([name, formula]) => {
    return `
      <div>
        <span>${escapeHtml(name)}</span>
        <code>${escapeHtml(formula || '-')}</code>
      </div>
    `;
  }).join('');
}

function renderEmptySelected() {
  $('debugSector').textContent = '--';
  $('debugTitle').textContent = '沒有可顯示的股票';
  $('debugSubtitle').textContent = '請確認 /api/debug/market 是否有回傳 stocks。';
  $('debugRiskBadge').textContent = '--';
  $('debugRiskBadge').className = 'debug-risk risk-normal';
  $('debugPrice').textContent = '--';
  $('debugChange').textContent = '--';
  $('debugUpdateTime').textContent = '--';
  $('debugOverviewGrid').innerHTML = '';
  $('debugEmotionGrid').innerHTML = '';
  $('debugFormulaList').innerHTML = '';
}

function renderDebugPage() {
  renderStockList();

  const list = getFilteredStocks();

  if (!selectedSymbol && list.length) {
    selectedSymbol = list[0].symbol;
  }

  const stock = debugStocks.find((item) => item.symbol === selectedSymbol) || list[0];

  if (!stock) {
    renderEmptySelected();
    return;
  }

  selectedSymbol = stock.symbol;
  renderSelectedStock(stock);
  renderStockList();
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

    if (!selectedSymbol && debugStocks.length) {
      selectedSymbol = debugStocks[0].symbol;
    }

    $('debugStatus').textContent = `最後更新：${fmtDateTime(data.serverTime)}｜股票數：${debugStocks.length}`;

    renderDebugPage();
  } catch (err) {
    $('debugStatus').textContent = `載入失敗：${err.message}`;
    renderEmptySelected();
  }
}

$('debugSearch').addEventListener('input', () => {
  const list = getFilteredStocks();

  if (!list.some((stock) => stock.symbol === selectedSymbol)) {
    selectedSymbol = list[0]?.symbol || null;
  }

  renderDebugPage();
});

$('debugRefreshBtn').addEventListener('click', loadDebugMarket);

loadDebugMarket();