// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockUSDG {
    string public symbol = "USDG"; uint8 public decimals = 6;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address to,uint256 a) external { balanceOf[to]+=a; }
    function approve(address s,uint256 a) external returns(bool){ allowance[msg.sender][s]=a; return true; }
    function transfer(address to,uint256 a) external returns(bool){ balanceOf[msg.sender]-=a; balanceOf[to]+=a; return true; }
    function transferFrom(address f,address to,uint256 a) external returns(bool){ allowance[f][msg.sender]-=a; balanceOf[f]-=a; balanceOf[to]+=a; return true; }
}
