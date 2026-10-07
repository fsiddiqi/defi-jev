// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * Morpho-compatible price oracle (interface: `price()`) for a self-liquidation
 * test market. price = loan-token wei per whole collateral unit at the Morpho
 * oracle scale (ORACLE_PRICE_SCALE = 1e36):
 *
 *     collValue(loanWei) = collateralWei * price / 1e36
 *
 * The owner can move the price on demand — that is the point: the live-trade
 * test needs a position that is healthy on borrow and unhealthy on demand.
 * Used only with a market this script creates itself (permissionless
 * `Morpho.createMarket`); it is never wired into an existing market.
 */
contract TestPriceOracle {
    address public owner;
    uint256 public price; // == IOracle.price()

    constructor(uint256 initialPrice, address owner_) {
        owner = owner_;
        price = initialPrice;
    }

    function setPrice(uint256 newPrice) external {
        require(msg.sender == owner, "TestPriceOracle: not owner");
        price = newPrice;
    }
}
