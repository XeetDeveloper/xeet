// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XeetVault} from "../src/XeetVault.sol";

/* USDG as it really is: six decimals, returns a bool. */
contract MockUSDG {
    string public symbol = "USDG";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract XeetVaultTest is Test {
    XeetVault vault;
    MockUSDG usdg;

    uint256 opKey = 0xA11CE;
    address operator;
    address house = address(0x4005);
    address alice = address(0xA11CE0);
    address bob = address(0xB0B);

    bytes32 constant MKT = keccak256("solana:XEET");
    uint256 constant P1 = 1e18;           // $1, in 1e18
    uint128 constant USD = 1e6;           // one dollar of USDG

    function setUp() public {
        operator = vm.addr(opKey);
        usdg = new MockUSDG();
        vm.prank(house);
        vault = new XeetVault(address(usdg), operator);

        // the house puts up capital
        usdg.mint(house, 10_000 * USD);
        vm.startPrank(house);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(10_000 * USD);
        vault.setMarket(MKT, 25 * USD, 2_500 * USD, 5, true);
        vm.stopPrank();

        for (uint160 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            usdg.mint(who, 1_000 * USD);
            vm.prank(who);
            usdg.approve(address(vault), type(uint256).max);
        }
        vm.warp(1_700_000_000);
    }

    /* ------------------------------------------------------- the helper */

    function signed(uint256 price, uint256 key, bytes32 market, uint64 at)
        internal view returns (XeetVault.Price memory p, bytes memory sig)
    {
        p = XeetVault.Price({market: market, value: price, at: at});
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("XeetVault"), keccak256("1"), block.chainid, address(vault)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(
            keccak256("Price(bytes32 market,uint256 value,uint64 at)"), market, price, at))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function price(uint256 v) internal view returns (XeetVault.Price memory p, bytes memory s) {
        return signed(v, opKey, MKT, uint64(block.timestamp));
    }

    function openFor(address who, uint128 margin, uint32 lev, bool isLong, uint256 at)
        internal returns (uint256 id)
    {
        (XeetVault.Price memory p, bytes memory s) = price(at);
        vm.prank(who);
        return vault.open(MKT, margin, lev, isLong, p, s);
    }

    /* --------------------------------------------------------- the money */

    function test_LongInProfitPaysOut() public {
        uint256 before = usdg.balanceOf(alice);
        uint256 id = openFor(alice, 10 * USD, 2, true, P1);

        vm.warp(block.timestamp + 60);
        (XeetVault.Price memory p, bytes memory s) = price((P1 * 11) / 10);   // +10%
        vm.prank(alice);
        vault.close(id, p, s);

        // $10 margin less a 0.1%-of-notional fee, 2x, +10% => about +$1.98
        uint256 got = usdg.balanceOf(alice);
        assertGt(got, before, "a winning long should come back with more");
        assertApproxEqAbs(got - before, 1_960_000 / 1000 * 1000, 20_000);
    }

    function test_ShortProfitsWhenPriceFalls() public {
        uint256 before = usdg.balanceOf(alice);
        uint256 id = openFor(alice, 10 * USD, 2, false, P1);
        (XeetVault.Price memory p, bytes memory s) = price((P1 * 9) / 10);    // -10%
        vm.prank(alice);
        vault.close(id, p, s);
        assertGt(usdg.balanceOf(alice), before, "a short should profit on the way down");
    }

    function test_LossIsTakenFromMargin() public {
        uint256 before = usdg.balanceOf(alice);
        uint256 id = openFor(alice, 10 * USD, 2, true, P1);
        (XeetVault.Price memory p, bytes memory s) = price((P1 * 95) / 100);  // -5%
        vm.prank(alice);
        vault.close(id, p, s);
        assertLt(usdg.balanceOf(alice), before, "a losing long should come back with less");
        assertGt(usdg.balanceOf(alice), before - 10 * USD, "but not with nothing");
    }

    /* The fence that makes the house's risk a number. */
    function test_PayoutIsCappedAtFiveTimesMargin() public {
        uint256 before = usdg.balanceOf(alice);
        uint256 id = openFor(alice, 10 * USD, 5, true, P1);
        (XeetVault.Price memory p, bytes memory s) = price(P1 * 100);         // 100x
        vm.prank(alice);
        vault.close(id, p, s);
        uint256 gained = usdg.balanceOf(alice) - before;
        assertLe(gained, 40 * USD, "profit above 4x the margin is not owed");
        assertGt(gained, 39 * USD, "but the cap itself should pay");
    }

    /* ---------------------------------------------------- the solvency */

    function test_HouseCannotWithdrawWhatPositionsNeed() public {
        uint256 freeBefore = vault.free();
        openFor(alice, 25 * USD, 5, true, P1);

        // the trader's margin went in, but five times it was promised out
        assertLt(vault.free(), freeBefore, "an open position must reduce what is free");

        // free() is itself a call, so it is read BEFORE the prank is armed —
        // otherwise the view eats the prank and the defund runs as the test.
        uint256 surplus = vault.free();
        vm.prank(house);
        vm.expectRevert(XeetVault.Undercollateralised.selector);
        vault.defund(surplus + 1);

        vm.prank(house);
        vault.defund(surplus);                           // exactly the surplus is allowed

        // and the position still pays in full
        (XeetVault.Price memory p, bytes memory s) = price(P1 * 2);
        vm.prank(alice);
        vault.close(1, p, s);
        assertGe(usdg.balanceOf(alice), 1_000 * USD + 100 * USD - 1 * USD, "the win is still payable");
    }

    function test_OpenRefusedWhenTheHouseCannotCoverIt() public {
        uint256 surplus = vault.free();
        vm.prank(house);
        vault.defund(surplus);                           // strip the vault bare
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.prank(alice);
        vm.expectRevert(XeetVault.Undercollateralised.selector);
        vault.open(MKT, 25 * USD, 5, true, p, s);
    }

    function test_BalanceNeverFallsBelowLiabilities() public {
        openFor(alice, 25 * USD, 5, true, P1);
        openFor(bob, 20 * USD, 3, false, P1);
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities());

        vm.warp(block.timestamp + 3600);
        (XeetVault.Price memory p, bytes memory s) = price((P1 * 12) / 10);
        vm.prank(alice);
        vault.close(1, p, s);
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities(), "still covered after a payout");
    }

    /* --------------------------------------------------------- the caps */

    function test_MarketCaps() public {
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.prank(alice);
        vm.expectRevert(XeetVault.MarginTooLarge.selector);
        vault.open(MKT, 26 * USD, 2, true, p, s);

        vm.prank(alice);
        vm.expectRevert(XeetVault.BadLeverage.selector);
        vault.open(MKT, 10 * USD, 6, true, p, s);

        vm.prank(alice);
        vm.expectRevert(XeetVault.MarketClosed.selector);
        vault.open(keccak256("nope"), 10 * USD, 2, true, p, s);
    }

    function test_BookFillsUp() public {
        // 2,500 of notional at 5x is 500 of margin; the 21st 25-dollar position fails
        for (uint256 i = 0; i < 20; i++) {
            address t = address(uint160(1000 + i));
            usdg.mint(t, 100 * USD);
            vm.prank(t);
            usdg.approve(address(vault), type(uint256).max);
            openFor(t, 25 * USD, 5, true, P1);
        }
        address last = address(uint160(2000));
        usdg.mint(last, 100 * USD);
        vm.startPrank(last);
        usdg.approve(address(vault), type(uint256).max);
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.expectRevert(XeetVault.MarketFull.selector);
        vault.open(MKT, 25 * USD, 5, true, p, s);
        vm.stopPrank();
    }

    /* --------------------------------------------------- the liquidation */

    function test_LiquidationTakesTheMarginAndAnyoneMayCallIt() public {
        uint256 id = openFor(alice, 10 * USD, 5, true, P1);
        uint256 lost = usdg.balanceOf(alice);

        (XeetVault.Price memory p, bytes memory s) = price((P1 * 80) / 100);  // -20% at 5x
        vm.prank(bob);                                                        // a stranger
        vault.liquidate(id, p, s);

        assertEq(usdg.balanceOf(alice), lost, "a liquidated position pays nothing");
        (int256 pnl, uint256 payout, bool liq) = vault.valueOf(id, P1);
        assertEq(pnl, 0); assertEq(payout, 0); assertFalse(liq, "and it is closed");
    }

    function test_HealthyPositionCannotBeLiquidated() public {
        uint256 id = openFor(alice, 10 * USD, 2, true, P1);
        (XeetVault.Price memory p, bytes memory s) = price((P1 * 95) / 100);  // -5% at 2x
        vm.prank(bob);
        vm.expectRevert(XeetVault.NotLiquidatable.selector);
        vault.liquidate(id, p, s);
    }

    function test_LiquidationPriceMatchesTheArithmetic() public {
        uint256 id = openFor(alice, 10 * USD, 5, true, P1);
        uint256 liq = vault.liquidationPrice(id);
        // 5x, 10% maintenance => dead at an 18% move
        assertApproxEqAbs(liq, (P1 * 82) / 100, 1e15);
    }

    /* ---------------------------------------------------------- the price */

    function test_OnlyTheOperatorsPriceIsAccepted() public {
        (XeetVault.Price memory p, bytes memory s) = signed(P1, 0xBEEF, MKT, uint64(block.timestamp));
        vm.prank(alice);
        vm.expectRevert(XeetVault.BadSignature.selector);
        vault.open(MKT, 10 * USD, 2, true, p, s);
    }

    function test_StalePriceIsRefused() public {
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.warp(block.timestamp + 121);
        vm.prank(alice);
        vm.expectRevert(XeetVault.StalePrice.selector);
        vault.open(MKT, 10 * USD, 2, true, p, s);
    }

    function test_FuturePriceIsRefused() public {
        (XeetVault.Price memory p, bytes memory s) =
            signed(P1, opKey, MKT, uint64(block.timestamp + 60));
        vm.prank(alice);
        vm.expectRevert(XeetVault.StalePrice.selector);
        vault.open(MKT, 10 * USD, 2, true, p, s);
    }

    function test_APriceForAnotherMarketIsRefused() public {
        (XeetVault.Price memory p, bytes memory s) =
            signed(P1, opKey, keccak256("solana:OTHER"), uint64(block.timestamp));
        vm.prank(alice);
        vm.expectRevert(XeetVault.WrongMarket.selector);
        vault.open(MKT, 10 * USD, 2, true, p, s);
    }

    /* ------------------------------------------------------- the escape */

    function test_SilenceLetsTheTraderOut() public {
        uint256 id = openFor(alice, 10 * USD, 3, true, P1);
        uint256 after_ = usdg.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(XeetVault.NotStale.selector);
        vault.closeStale(id);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(alice);
        vault.closeStale(id);

        // the margin comes back whole (the fee was taken at open)
        assertEq(usdg.balanceOf(alice) - after_, 10 * USD - 30_000, "margin returned");
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities());
    }

    function test_AFreshPriceKeepsTheMarketAlive() public {
        uint256 id = openFor(alice, 10 * USD, 3, true, P1);
        vm.warp(block.timestamp + 59 minutes);
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vault.poke(p, s);
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(alice);
        vm.expectRevert(XeetVault.NotStale.selector);
        vault.closeStale(id);
    }

    /* --------------------------------------------------------- the rules */

    function test_FundingIsChargedForTimeOpen() public {
        uint256 id = openFor(alice, 10 * USD, 5, true, P1);
        vm.warp(block.timestamp + 10 hours);
        (int256 pnl,,) = vault.valueOf(id, P1);
        // ~$49.75 of notional (the fee came out of the margin first), 0.01%
        // an hour, ten hours => just under five cents
        assertApproxEqAbs(pnl, -49_750, 500);
        assertLt(pnl, 0, "funding is paid even when the price has not moved");
    }

    function test_PauseStopsOpeningButNotClosing() public {
        uint256 id = openFor(alice, 10 * USD, 2, true, P1);
        vm.prank(house);
        vault.setPaused(true);

        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.prank(bob);
        vm.expectRevert(XeetVault.IsPaused.selector);
        vault.open(MKT, 10 * USD, 2, true, p, s);

        vm.prank(alice);
        vault.close(id, p, s);                      // still closable
    }

    function test_OnlyTheTraderClosesTheirOwnPosition() public {
        uint256 id = openFor(alice, 10 * USD, 2, true, P1);
        (XeetVault.Price memory p, bytes memory s) = price(P1);
        vm.prank(bob);
        vm.expectRevert(XeetVault.NotTrader.selector);
        vault.close(id, p, s);
    }

    function test_FeesHaveACeiling() public {
        vm.startPrank(house);
        vm.expectRevert(XeetVault.FeeTooHigh.selector);
        vault.setFees(101, 1);
        vm.expectRevert(XeetVault.FeeTooHigh.selector);
        vault.setFees(10, 11);
        vault.setFees(100, 10);                     // the ceiling itself is allowed
        vm.stopPrank();
    }

    function test_OnlyOwnerRuns() public {
        vm.startPrank(alice);
        vm.expectRevert(XeetVault.NotOwner.selector);
        vault.defund(1);
        vm.expectRevert(XeetVault.NotOwner.selector);
        vault.setMarket(MKT, 1, 1, 1, true);
        vm.expectRevert(XeetVault.NotOwner.selector);
        vault.setOperator(alice);
        vm.stopPrank();
    }

    /* The property that has to hold whatever anybody does. */
    function testFuzz_VaultStaysSolvent(uint128 margin, uint8 lev, bool isLong, uint256 move) public {
        margin = uint128(bound(margin, 1 * USD, 25 * USD));
        lev = uint8(bound(lev, 1, 5));
        move = bound(move, 1, 1000);                 // 0.01x to 10x the entry
        uint256 id = openFor(alice, margin, lev, isLong, P1);
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities());

        vm.warp(block.timestamp + 7 hours);
        uint256 exit = (P1 * move) / 100;
        (XeetVault.Price memory p, bytes memory s) = price(exit);
        (, , bool dead) = vault.valueOf(id, exit);
        if (dead) vault.liquidate(id, p, s);
        else { vm.prank(alice); vault.close(id, p, s); }
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities(), "solvent after settlement");
    }
}
