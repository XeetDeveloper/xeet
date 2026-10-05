/* Xeet — the panel's skeleton.
 *
 * This is the product's own markup, the same file the marketing site loads,
 * kept as one template rather than a hundred createElement calls. Every field
 * the panel fills is addressed by data-el, so filling it is a lookup table and
 * a row that appears or disappears never shifts a selector.
 *
 * Nothing here is user content. Everything written into it is escaped or set
 * with textContent by panel.js — a token "name" arrives from a third-party
 * index and is treated as hostile. */

window.XEET_PANEL_HTML = `
<div class="scene"><div class="loupe safe">
  <div class="face front">
    <div class="pincorner" data-el="pincorner" hidden></div>
    <button class="closecorner" data-el="closecorner" type="button" aria-label="Close" title="Close"></button>
    <div class="intel">
      <div class="ihead">
        <div class="bezelwrap">
          <div class="bezel" data-el="bezel"></div>
          <button class="seal" data-el="seal" type="button" aria-label="Safety screening"></button>
        </div>
        <div class="tk etch" data-el="sym"><span class="tkline"><span class="tksym" data-el="tksym"></span><span class="chainbadge" data-el="chainbadge" title=""></span><span class="tkage" data-el="tkage" title="Age"></span></span><span class="name" data-el="name"></span></div>
        <!-- Price sits ON the identity row, at the ticker's own size. They are
             the two things the panel was opened for; as separate rows in
             different sizes they read as a heading with a number stuck under
             it rather than one line of two equal facts. -->
        <div class="pricecol"><div class="price etch" data-el="price"></div><div class="chg up" data-el="chg"></div></div>
      </div>
      <div class="riskbar" data-el="riskbar" hidden></div>
      <!-- Equities only. The token trades 24/7 on an AMM; the underlying does
           not. When the market is shut nothing arbitrages this price back to
           the real share, which is a fact a buyer is entitled to before they
           hover a tile — so it sits ABOVE the price, not in a tooltip. -->
      <div class="mktbar" data-el="mktbar" hidden>
        <span class="lbl" data-el="mktlbl"></span>
        <span class="cd num" data-el="mktcd"></span>
      </div>
      <!-- CHROME. The exits and the ranges are the same kind of object — small
           controls that are not the point — so they share one row at one size,
           at opposite ends. The links used to sit inside the ticker line, where
           four logos squeezed the token's own name; here they cost nothing and
           the chart keeps its full height with nothing sitting on it. -->
      <div class="chrome">
        <span class="linkrow" data-el="linkrow"><a class="lnk chartlink" data-el="chartlink" target="_blank" rel="noopener noreferrer" hidden></a><a class="lnk chartlink pumplink" data-el="pumplink" target="_blank" rel="noopener noreferrer" hidden></a></span>
        <div class="range" data-el="range">
          <button data-r="30s">30S</button><button data-r="5m">5M</button><button data-r="1h">1H</button><button data-r="24h" class="on">24H</button><button data-r="7d">7D</button>
        </div>
        <!-- What the chart is measured in. Hidden until we know what the pair
             is quoted against, because "USD / —" is not a choice. -->
        <div class="denom" data-el="denom" hidden>
          <button data-d="usd" class="on">USD</button><button data-d="token" data-el="denomtok">ETH</button>
        </div>
      </div>
      <div class="chart" data-el="chartbox"><span class="readout" data-el="readout" hidden></span><svg viewBox="0 0 360 44" preserveAspectRatio="none" data-el="chartsvg">
        <defs>
          <linearGradient id="xeetg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#F2F4F3" stop-opacity=".26"/><stop offset="1" stop-color="#F2F4F3" stop-opacity="0"/></linearGradient>
          <linearGradient id="xeetgr" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8A9199" stop-opacity=".30"/><stop offset="1" stop-color="#F2F4F3" stop-opacity="0"/></linearGradient>
        </defs>
        <path data-el="area" fill="url(#xeetg)"></path><path data-el="line" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-opacity=".9"></path><circle data-el="dot" r="2.6" fill="#FFFFFF"></circle>
        <line data-el="xrule" class="xrule" x1="0" y1="0" x2="0" y2="44" hidden></line>
        <circle data-el="xdot" class="xdot" r="2.8" hidden></circle>
      </svg></div>
      <div class="statsRow">
        <div class="s"><div class="l" data-el="mcapl">MCAP</div><div class="v" data-el="mcap">—</div></div>
        <div class="s"><div class="l">LIQ</div><div class="v" data-el="liq">—</div></div>
        <div class="s"><div class="l" data-el="voll">24H VOL</div><div class="v" data-el="vol">—</div></div>
        <div class="s" data-el="holders-s" hidden><div class="l">HOLDERS</div><div class="v" data-el="holders">—</div></div>
      </div>
      <!-- Flow. Its own row now that the drawer freed the height for one. It
           was folded into the ticker line, where it squeezed the name and
           pushed the link icons sideways for the sake of three numbers. -->
      <!-- Flow. Always present and always the same shape: a dot, the state, the
           numbers behind it, tags on the right. It used to be a conditional
           string that changed length and sometimes vanished, so the eye never
           learned where to look for it. -->
      <div class="flowBar" data-el="flowrow" hidden>
        <span class="fico" data-el="fico"></span>
        <span class="fstage" data-el="fstage"></span>
        <span class="ftags" data-el="ftags"></span>
        <span class="fnums" data-el="fnums"></span>
        <button class="fwin" data-el="fwin" type="button" title="Change the window"></button>
      </div>
    </div>
    <div class="xeettip" data-el="tipbox" hidden></div>
    <div class="deck">
      <div class="swapzone" data-el="swapzone">
        <!-- THE SPLIT. Direction is the button, not a mode you set: hover the
             left half to buy, the right to sell, and the drawer below opens in
             that direction's colour. The solo .swapbtn under it still carries
             every state that has its own copy — connect, view-only, approve,
             swaps paused — because those are sentences, not a choice of two. -->
        <div class="split" data-el="split" hidden>
          <div class="half buy solo" data-el="halfbuy" data-side="buy">BUY</div>
          <div class="half sell" data-el="halfsell" data-side="sell" hidden>SELL</div>
        </div>
        <!-- Live HP campaign, stated where the buy decision happens. Its own
             strip rather than text inside .swapbtn: the button's copy is
             rewritten by connect/approve/view-only states and a chip in there
             would be overwritten by the first state change. -->
        <div class="hpboostline" data-el="hpboost" hidden></div>
        <div class="swapbtn" data-el="swapbtn">BUY</div>
        <!-- Everything you only need at the moment you commit lives in here and
             is closed by default. The panel was carrying four rows of swap
             detail on screen at all times, which is most of its height spent on
             something nobody reads until they are already buying. -->
        <div class="drawer" data-el="drawer">
      <div class="payfrom">
        <div class="paybox">
          <div class="seg pick" data-el="segt"><span class="k">Selling</span><span class="main" data-el="tname">—</span><span class="sellchain" data-el="tchain" hidden></span><span class="bal" data-el="tbal"></span><span class="cv" data-el="tfiat"></span><svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          <div class="seg" data-el="segb"><span class="k">Buying</span><span class="main" data-el="bname">—</span><span class="bal ca" data-el="bca"></span><button class="cabtn" data-el="cacopy" type="button" title="Copy contract address"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
          <div class="seg pick" data-el="segs"><span class="k">Slippage</span><span class="main" data-el="slp">1%</span><svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          <div class="seg pick" data-el="segw"><span class="k">Wallet</span><span class="main" data-el="wname">—</span><span class="waddr" data-el="waddr"></span><span class="wtag" data-el="wtag" hidden></span><svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
        </div>
        <div class="sellbox" data-el="sellbox" hidden>
          <div class="seg"><span class="k">Selling</span><span class="main" data-el="sname">—</span><span class="bal" data-el="sbal"></span><span class="cv" data-el="sfiat"></span><span class="pnl" data-el="spnl" hidden></span><button class="cabtn" data-el="scacopy" type="button" title="Copy contract address"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
          <div class="seg"><span class="k">Receiving</span><span class="main" data-el="rname">—</span></div>
          <div class="seg pick" data-el="rsegs"><span class="k">Slippage</span><span class="main" data-el="rslp">1%</span><svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          <div class="seg"><span class="k">Wallet</span><span class="main" data-el="rwname">—</span><span class="waddr" data-el="rwaddr"></span></div>
          <div class="gasnote" data-el="gasnote" hidden></div>
        </div>
      </div>
          <div class="amounts"><div class="tiles" data-el="tiles"></div></div>
        </div>
      </div>
    </div>
  </div>
  <div class="face back"><div class="review" data-el="review"></div></div>
</div></div>
`;
