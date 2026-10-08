// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ILiveOracle {
    function price() external view returns (uint256);
}

/**
 * Keeper-proof price oracle (v2) for the app's end-to-end self-test.
 *
 * v1 (`TestPriceOracle`) exposed its manipulated price to EVERY caller, so a
 * competing keeper could liquidate our test position using our own oracle.
 * v2 serves two different prices depending on who is calling:
 *
 *   - tx.origin == owner (our EOA, i.e. our own liquidations + setup txs):
 *     returns the owner-set attack price (after the borrow, to push HF < 1).
 *   - any other caller (competing keepers, MEV searchers):
 *     returns the LIVE market price via a real Morpho-compatible oracle (on
 *     Base: the WETH/USDC oracle contract), against which the position is
 *     healthy — Morpho.liquidate reverts with HEALTHY_POSITION.
 *
 * Because Morpho's health check runs inside the liquidate() call, the oracle
 * read happens with the liquidator's tx.origin: only OUR attestation sees the
 * attack price. Competition cannot touch the test position, which is exactly
 * the property the --self-test gate has to prove end-to-end.
 *
 * attackPrice starts 0 ("unarmed"): the setup txs (borrow etc.) read the live
 * price and can still health-check. Only after the borrow does the runner arm
 * the attack price, and only our txs ever see it.
 */
contract TestPriceOracleV2 {
    address public immutable owner;
    address public immutable liveOracle;
    uint256 public attackPrice; // armed by owner after the borrow

    constructor(address owner_, address liveOracle_) {
        owner = owner_;
        liveOracle = liveOracle_;
    }

    function armAttackPrice(uint256 newAttackPrice) external {
        require(msg.sender == owner, "V2: not owner");
        attackPrice = newAttackPrice;
    }

    function price() external view returns (uint256) {
        if (tx.origin == owner && attackPrice != 0) return attackPrice;
        return ILiveOracle(liveOracle).price();
    }
}