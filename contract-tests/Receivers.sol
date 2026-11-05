// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IConsentCraft {
    function withdraw(address payable recipient) external;
}
contract RejectEther { receive() external payable { revert("reject"); } }
contract ReenterWithdrawal {
    IConsentCraft public target;
    constructor(IConsentCraft target_) { target = target_; }
    receive() external payable { target.withdraw(payable(address(this))); }
}
