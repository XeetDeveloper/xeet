// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/* Xeet — the vault behind leverage on coins no exchange will list.
 *
 * WHAT THIS IS. A one-sided venue. Traders open small leveraged positions on
 * a memecoin; the house — whoever funded this contract — is the counterparty
 * to all of them. There is no order book, no other side to find, and no token
 * ever held: a position is margin in USDG settled against a price.
 *
 * WHY IT IS SHAPED LIKE THIS, AND NOT LIKE A PERP DEX. A perp on a two-hour-
 * old coin is a cheque written to whoever can move its pool. Moving a $20K
 * pool ten percent costs about $500, so any product where a ten percent move
 * can pay out more than that is simply funding its own attacker. Every number
 * below exists to keep the most the book can pay under the cost of moving the
 * price it settles against:
 *
 *   - a position's payout is capped at PAYOUT_CAP times its margin, so the
 *     house's liability is a number and not a hope;
 *   - margin per position and open notional per market are capped, and both
 *     are set from the pool's own depth;
 *   - and every open position is fully pre-funded: the contract refuses to
 *     open one it could not pay out in full, and the house can only ever
 *     withdraw what is left over after all of them are covered.
 *
 * THE PRICE, AND THE HONEST PART. A Solana memecoin's price cannot be read
 * from this chain, so it is signed by an operator and verified here. That is
 * a trust assumption and it is not dressed up as anything else — but it is
 * bounded in two directions. A price has to be fresh to be used at all, and
 * if the operator ever goes quiet, every trader can walk out with their
 * margin after STALE_EXIT without anybody's permission. An operator can stop
 * this venue; an operator cannot keep somebody's money in it.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract XeetVault {
    /* ------------------------------------------------------------ shape */

    struct Market {
        uint128 maxMargin;      // per position, in USDG
        uint128 maxNotional;    // open across the whole market, in USDG
        uint8 maxLeverage;
        bool live;
    }

    struct Position {
        address trader;
        bytes32 market;
        uint128 margin;         // USDG, 6 decimals
        uint64 openedAt;
        uint32 leverage;
        bool isLong;
        bool open;
        uint256 entry;          // price, 1e18
    }

    /* A price the operator put their name to. `at` is when it was observed,
       not when it is used — an old observation is refused rather than taken
       on trust. */
    struct Price {
        bytes32 market;
        uint256 value;          // 1e18
        uint64 at;
    }

    /* ----------------------------------------------------------- limits */

    uint256 public constant PAYOUT_CAP = 5;        // a position can win 5x its margin, no more
    uint256 public constant MAINTENANCE_BPS = 1000; // liquidated once 90% of margin is gone
    uint256 public constant MAX_FEE_BPS = 100;      // the house can never set a fee above 1%
    uint256 public constant MAX_FUNDING_BPS = 10;   // nor funding above 0.1% an hour
    uint64 public constant MAX_PRICE_AGE = 120;     // seconds a signed price stays usable
    uint64 public constant STALE_EXIT = 1 hours;    // silence after which traders leave at entry

    /* ------------------------------------------------------------ state */

    IERC20 public immutable usdg;
    address public owner;
    address public pendingOwner;
    address public operator;

    uint16 public openFeeBps = 10;      // 0.1% of notional, taken at open
    uint16 public fundingBpsPerHour = 1; // 0.01% of notional an hour
    bool public paused;

    /* Everything the house owes to open positions, at the worst case for the
       house. The contract's balance may never fall below it. */
    uint256 public liabilities;

    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => uint256) public openNotional;
    mapping(bytes32 => uint64) public lastPriceAt;

    bytes32 private immutable _domainSeparator;
    bytes32 private constant PRICE_TYPEHASH =
        keccak256("Price(bytes32 market,uint256 value,uint64 at)");

    uint256 private _lock = 1;

    /* ----------------------------------------------------------- events */

    event Opened(uint256 indexed id, address indexed trader, bytes32 indexed market,
        uint128 margin, uint32 leverage, bool isLong, uint256 entry);
    event Closed(uint256 indexed id, address indexed trader, uint256 exit,
        int256 pnl, uint256 payout, bool liquidated);
    event MarketSet(bytes32 indexed market, uint128 maxMargin, uint128 maxNotional, uint8 maxLeverage, bool live);
    event Funded(uint256 amount);
    event Defunded(uint256 amount);
    event OperatorSet(address operator);
    event Paused(bool paused);
    event OwnerSet(address owner);

    /* ----------------------------------------------------------- errors */

    error NotOwner();
    error NotOpen();
    error NotTrader();
    error MarketClosed();
    error BadLeverage();
    error MarginTooLarge();
    error MarketFull();
    error Undercollateralised();
    error BadSignature();
    error StalePrice();
    error WrongMarket();
    error ZeroPrice();
    error NotLiquidatable();
    error NotStale();
    error FeeTooHigh();
    error IsPaused();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier guard() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdg_, address operator_) {
        usdg = IERC20(usdg_);
        owner = msg.sender;
        operator = operator_;
        _domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("XeetVault"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    /* ------------------------------------------------------- the house */

    /* Capital in. Anyone may add; only the owner may take, and only what no
       open position depends on. */
    function fund(uint256 amount) external guard {
        _pull(msg.sender, amount);
        emit Funded(amount);
    }

    /* What the house is allowed to take out: the balance, less every payout
       it has already promised. This is the whole safety property — a trader's
       margin and their best case are both inside `liabilities`. */
    function free() public view returns (uint256) {
        uint256 bal = usdg.balanceOf(address(this));
        return bal > liabilities ? bal - liabilities : 0;
    }

    function defund(uint256 amount) external onlyOwner guard {
        if (amount > free()) revert Undercollateralised();
        _push(msg.sender, amount);
        emit Defunded(amount);
    }

    function setMarket(bytes32 market, uint128 maxMargin, uint128 maxNotional, uint8 maxLeverage, bool live)
        external onlyOwner
    {
        markets[market] = Market(maxMargin, maxNotional, maxLeverage, live);
        emit MarketSet(market, maxMargin, maxNotional, maxLeverage, live);
    }

    function setOperator(address who) external onlyOwner {
        operator = who;
        emit OperatorSet(who);
    }

    function setFees(uint16 openBps, uint16 fundingBps) external onlyOwner {
        if (openBps > MAX_FEE_BPS || fundingBps > MAX_FUNDING_BPS) revert FeeTooHigh();
        openFeeBps = openBps;
        fundingBpsPerHour = fundingBps;
    }

    /* Pausing stops NEW positions. It cannot touch open ones, which close and
       liquidate exactly as before — a pause that trapped money would be a rug
       with a nicer name. */
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function transferOwnership(address who) external onlyOwner {
        pendingOwner = who;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerSet(owner);
    }

    /* ------------------------------------------------------ the trading */

    function open(
        bytes32 market,
        uint128 margin,
        uint32 leverage,
        bool isLong,
        Price calldata p,
        bytes calldata sig
    ) external guard returns (uint256 id) {
        if (paused) revert IsPaused();
        Market memory m = markets[market];
        if (!m.live) revert MarketClosed();
        if (leverage == 0 || leverage > m.maxLeverage) revert BadLeverage();
        if (margin == 0 || margin > m.maxMargin) revert MarginTooLarge();

        uint256 price = _usePrice(market, p, sig);

        /* The fee comes out of the margin rather than being invoiced later:
           the trader pays what the button said, and the position is the rest
           of it. Taking it at close instead would mean a liquidated position
           paid no fee at all. */
        uint256 fee = (uint256(margin) * leverage * openFeeBps) / 10000;
        if (fee >= margin) revert MarginTooLarge();
        uint128 net = margin - uint128(fee);

        uint256 notional = uint256(net) * leverage;
        if (openNotional[market] + notional > m.maxNotional) revert MarketFull();

        // Pre-funded or not opened: the contract must be able to pay this
        // position's best case the moment it exists. The fee is not part of
        // the promise — it is the house's, from this moment.
        _pull(msg.sender, margin);
        liabilities += uint256(net) * PAYOUT_CAP;
        if (usdg.balanceOf(address(this)) < liabilities) revert Undercollateralised();

        openNotional[market] = openNotional[market] + notional;

        id = nextId++;
        positions[id] = Position({
            trader: msg.sender,
            market: market,
            margin: net,
            openedAt: uint64(block.timestamp),
            leverage: leverage,
            isLong: isLong,
            open: true,
            entry: price
        });

        emit Opened(id, msg.sender, market, net, leverage, isLong, price);
    }

    function close(uint256 id, Price calldata p, bytes calldata sig) external guard {
        Position memory pos = positions[id];
        if (!pos.open) revert NotOpen();
        if (pos.trader != msg.sender) revert NotTrader();
        uint256 price = _usePrice(pos.market, p, sig);
        _settle(id, pos, price, false);
    }

    /* Liquidation is open to anyone with a fresh price, because a venue where
       only the house may liquidate is a venue where the house liquidates when
       it feels like it. The condition is the same arithmetic the trader was
       shown, and the price has to pass the same freshness test. */
    function liquidate(uint256 id, Price calldata p, bytes calldata sig) external guard {
        Position memory pos = positions[id];
        if (!pos.open) revert NotOpen();
        uint256 price = _usePrice(pos.market, p, sig);
        (int256 pnl,) = _pnl(pos, price);
        if (!_dead(pos, pnl)) revert NotLiquidatable();
        _settle(id, pos, price, true);
    }

    /* The way out when the operator goes quiet. No signature, no permission,
       no price: the position never happened and the margin goes home. */
    function closeStale(uint256 id) external guard {
        Position memory pos = positions[id];
        if (!pos.open) revert NotOpen();
        if (pos.trader != msg.sender) revert NotTrader();
        uint64 last = lastPriceAt[pos.market];
        uint64 since = last > pos.openedAt ? last : pos.openedAt;
        if (block.timestamp <= uint256(since) + STALE_EXIT) revert NotStale();

        positions[id].open = false;
        openNotional[pos.market] -= uint256(pos.margin) * pos.leverage;
        liabilities -= uint256(pos.margin) * PAYOUT_CAP;
        _push(pos.trader, pos.margin);
        emit Closed(id, pos.trader, 0, int256(0), pos.margin, false);
    }

    /* Keeps a quiet market from looking abandoned: anybody holding a fresh
       signed price may refresh it. */
    function poke(Price calldata p, bytes calldata sig) external {
        _usePrice(p.market, p, sig);
    }

    /* ---------------------------------------------------------- reading */

    /* What a position is worth right now, so the panel and the chain cannot
       disagree about it. */
    function valueOf(uint256 id, uint256 price)
        external view returns (int256 pnl, uint256 payout, bool liquidatable)
    {
        Position memory pos = positions[id];
        if (!pos.open) return (0, 0, false);
        (pnl,) = _pnl(pos, price);
        liquidatable = _dead(pos, pnl);
        payout = liquidatable ? 0 : _payout(pos, pnl);
    }

    function liquidationPrice(uint256 id) external view returns (uint256) {
        Position memory pos = positions[id];
        if (!pos.open) return 0;
        // loss of (1 - maintenance) of the margin, expressed as a price move
        uint256 move = (pos.entry * (10000 - MAINTENANCE_BPS)) / (10000 * pos.leverage);
        return pos.isLong ? pos.entry - move : pos.entry + move;
    }

    /* ----------------------------------------------------------- inside */

    function _settle(uint256 id, Position memory pos, uint256 price, bool liquidated) private {
        (int256 pnl,) = _pnl(pos, price);
        bool dead = liquidated || _dead(pos, pnl);
        uint256 payout = dead ? 0 : _payout(pos, pnl);

        positions[id].open = false;
        openNotional[pos.market] -= uint256(pos.margin) * pos.leverage;
        liabilities -= uint256(pos.margin) * PAYOUT_CAP;

        if (payout > 0) _push(pos.trader, payout);
        emit Closed(id, pos.trader, price, pnl, payout, dead);
    }

    /* Profit and loss, with funding already taken out of it. Funding is the
       house's rent on the exposure and it is charged for the time the
       position was actually open. */
    function _pnl(Position memory pos, uint256 price) private view returns (int256 pnl, uint256 funding) {
        if (price == 0) revert ZeroPrice();
        uint256 notional = uint256(pos.margin) * pos.leverage;

        int256 move = int256(price) - int256(pos.entry);
        int256 gross = (int256(notional) * move) / int256(pos.entry);
        if (!pos.isLong) gross = -gross;

        uint256 elapsed = block.timestamp - pos.openedAt;
        funding = (notional * fundingBpsPerHour * elapsed) / (10000 * 3600);
        pnl = gross - int256(funding);
    }

    /* The payout, inside both of its fences: never below zero, never above
       the promise the contract set aside at open. */
    function _payout(Position memory pos, int256 pnl) private pure returns (uint256) {
        int256 net = int256(uint256(pos.margin)) + pnl;
        if (net <= 0) return 0;
        uint256 cap = uint256(pos.margin) * PAYOUT_CAP;
        return uint256(net) > cap ? cap : uint256(net);
    }

    function _dead(Position memory pos, int256 pnl) private pure returns (bool) {
        int256 limit = -int256((uint256(pos.margin) * (10000 - MAINTENANCE_BPS)) / 10000);
        return pnl <= limit;
    }

    /* A price is only a price if the operator signed THIS market's, recently.
       Using one also marks the market as alive, which is what the stale exit
       measures its silence from. */
    function _usePrice(bytes32 market, Price calldata p, bytes calldata sig) private returns (uint256) {
        if (p.market != market) revert WrongMarket();
        if (p.value == 0) revert ZeroPrice();
        if (p.at + MAX_PRICE_AGE < block.timestamp || p.at > block.timestamp + 5) revert StalePrice();

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator,
            keccak256(abi.encode(PRICE_TYPEHASH, p.market, p.value, p.at))));
        if (_recover(digest, sig) != operator) revert BadSignature();

        if (p.at > lastPriceAt[market]) lastPriceAt[market] = p.at;
        return p.value;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        // Low-s only: the other half of the curve is the same signature twice.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address who = ecrecover(digest, v, r, s);
        if (who == address(0)) revert BadSignature();
        return who;
    }

    /* USDG returns a bool; plenty of tokens do not. Both are accepted, a
       false is not. */
    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdg).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdg).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
