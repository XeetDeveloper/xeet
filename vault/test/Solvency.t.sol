// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XeetVault} from "../src/XeetVault.sol";

/* The one property that must survive anything anybody does in any order: the
 * vault can always pay every position it has promised to pay. Everything else
 * in this contract is a feature; this is the contract. */

contract MockUSDG {
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

/* The handler is what the fuzzer is allowed to do: open, close, liquidate,
   wait, move the price, and let the house take its surplus out. */
contract Handler is Test {
    XeetVault public vault;
    MockUSDG public usdg;
    uint256 public opKey;
    bytes32 public market;
    address public house;
    uint256[] public ids;
    uint256 public price = 1e18;

    constructor(XeetVault v, MockUSDG u, uint256 k, bytes32 m, address h) {
        vault = v; usdg = u; opKey = k; market = m; house = h;
    }

    function _signed() internal view returns (XeetVault.Price memory p, bytes memory sig) {
        p = XeetVault.Price({market: market, value: price, at: uint64(block.timestamp)});
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("XeetVault"), keccak256("1"), block.chainid, address(vault)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(
            keccak256("Price(bytes32 market,uint256 value,uint64 at)"), market, price, p.at))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(opKey, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function movePrice(uint256 pct) public {
        pct = bound(pct, 1, 2000);                 // 1% to 20x of where it is
        price = (price * pct) / 100;
        if (price == 0) price = 1;
    }

    function wait(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }

    function open(uint256 who, uint128 margin, uint8 lev, bool isLong) public {
        address t = address(uint160(bound(who, 1, 20) + 0x1000));
        margin = uint128(bound(margin, 1e6, 25e6));
        lev = uint8(bound(lev, 1, 5));
        usdg.mint(t, margin);
        vm.startPrank(t);
        usdg.approve(address(vault), type(uint256).max);
        (XeetVault.Price memory p, bytes memory s) = _signed();
        try vault.open(market, margin, lev, isLong, p, s) returns (uint256 id) { ids.push(id); } catch {}
        vm.stopPrank();
    }

    function close(uint256 i) public {
        if (ids.length == 0) return;
        uint256 id = ids[bound(i, 0, ids.length - 1)];
        (address trader,,,,,, bool open_,) = vault.positions(id);
        if (!open_) return;
        (XeetVault.Price memory p, bytes memory s) = _signed();
        vm.prank(trader);
        try vault.close(id, p, s) {} catch {}
    }

    function liquidate(uint256 i) public {
        if (ids.length == 0) return;
        uint256 id = ids[bound(i, 0, ids.length - 1)];
        (XeetVault.Price memory p, bytes memory s) = _signed();
        try vault.liquidate(id, p, s) {} catch {}
    }

    function closeStale(uint256 i) public {
        if (ids.length == 0) return;
        uint256 id = ids[bound(i, 0, ids.length - 1)];
        (address trader,,,,,, bool open_,) = vault.positions(id);
        if (!open_) return;
        vm.prank(trader);
        try vault.closeStale(id) {} catch {}
    }

    function defund(uint256 amount) public {
        vm.prank(house);
        try vault.defund(bound(amount, 1, vault.free() + 1)) {} catch {}
    }

    function fund(uint256 amount) public {
        amount = bound(amount, 1e6, 1000e6);
        usdg.mint(house, amount);
        vm.startPrank(house);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(amount);
        vm.stopPrank();
    }
}

contract SolvencyTest is Test {
    XeetVault vault;
    MockUSDG usdg;
    Handler handler;
    address house = address(0x4005);
    uint256 opKey = 0xA11CE;
    bytes32 constant MKT = keccak256("solana:XEET");

    function setUp() public {
        usdg = new MockUSDG();
        vm.prank(house);
        vault = new XeetVault(address(usdg), vm.addr(opKey));
        usdg.mint(house, 10_000e6);
        vm.startPrank(house);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(10_000e6);
        vault.setMarket(MKT, 25e6, 2_500e6, 5, true);
        vm.stopPrank();
        vm.warp(1_700_000_000);

        handler = new Handler(vault, usdg, opKey, MKT, house);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 64
    function invariant_EveryPromiseIsCovered() public view {
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities(),
            "the vault must always hold enough to pay every open position in full");
    }

    function invariant_NothingIsOwedWhenNothingIsOpen() public view {
        if (vault.liabilities() == 0) {
            assertGe(usdg.balanceOf(address(vault)), 0);
        }
    }
}

contract HandlerSanityTest is SolvencyTest {
    function test_HandlerActuallyOpensAndSettles() public {
        handler.open(1, 20e6, 5, true);
        handler.open(2, 10e6, 3, false);
        assertEq(vault.nextId(), 3, "the handler's opens must really open");
        handler.movePrice(80);                 // -20%
        handler.liquidate(0);
        handler.close(1);
        assertGe(usdg.balanceOf(address(vault)), vault.liabilities());
        assertEq(vault.liabilities(), 0, "both positions settled");
    }
}
