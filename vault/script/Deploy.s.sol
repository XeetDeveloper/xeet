// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {XeetVault} from "../src/XeetVault.sol";

/* Deploying the vault to Robinhood Chain.
 *
 *   PRIVATE_KEY   the house — owns the vault, funds it, sets the markets
 *   OPERATOR      the address that signs prices (the price service's key)
 *   USDG          0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 on chain 4663
 *
 * The owner key and the operator key should NOT be the same key. The operator
 * one lives on a server because it has to sign every minute; the owner one
 * moves the capital and belongs nowhere near a server.
 */
contract Deploy is Script {
    function run() external {
        address usdg = vm.envOr("USDG", address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168));
        address operator = vm.envAddress("OPERATOR");

        vm.startBroadcast();
        XeetVault vault = new XeetVault(usdg, operator);
        vm.stopBroadcast();

        console.log("XeetVault:", address(vault));
        console.log("USDG:     ", usdg);
        console.log("operator: ", operator);
        console.log("Next: approve USDG to the vault, call fund(), then setMarket() per coin.");
    }
}
