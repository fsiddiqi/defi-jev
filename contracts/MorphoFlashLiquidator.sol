// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * MorphoFlashLiquidator — zero-capital liquidations on Morpho Blue (Base).
 *
 * Morpho's `liquidate()` transfers seized collateral to the caller BEFORE
 * calling `onMorphoLiquidate(repaidAssets, data)`, then pulls the repay:
 *
 *     IERC20(collateral).safeTransfer(msg.sender, seizedAssets);   // 1. we get paid first
 *     IMorphoLiquidateCallback(msg.sender).onMorphoLiquidate(...); // 2. we swap here
 *     IERC20(loanToken).safeTransferFrom(msg.sender, morpho, ...); // 3. we repay
 *
 * So no external flash loan is needed at all: inside the callback we swap the
 * already-received collateral through UniV3-style pools (exact-in, chained)
 * and pay the repay out of the proceeds. The incentive factor guarantees
 * proceeds >= repay whenever the sale price clears the oracle price / f.
 * Capital required: 0. Only gas.
 *
 * Route is owner-supplied as (pool, direction) hops; the contract derives
 * token continuity on-chain (hop input must equal previous hop's output, final
 * output must be the loan token), so a bad path reverts instead of draining
 * unrelated balances. Swap slippage is enforced by the post-conditions:
 * proceeds >= repaidAssets (callback) and profit >= minProfit (caller).
 *
 * Callback signature MUST match Morpho's IMorphoLiquidateCallback:
 *     onMorphoLiquidate(uint256 repaidAssets, bytes data)
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Morpho Blue MarketParams (see morpho-org/morpho-blue IMorpho.sol).
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256, uint256);
}

/// @dev Uniswap V3-style pool (also Aerodrome Slipstream / any V3 fork).
interface IUniV3LikePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract MorphoFlashLiquidator {
    // storage layout — slot 0 and 1 are overridden in fork simulations
    address public owner; // slot 0
    address public morpho; // slot 1
    bool private executing; // slot 2 (packed with the two below)
    address private currentPool;
    bool private currentZeroForOne;

    /// @notice One exact-in hop: sell into `pool`, `zeroForOne` = input is token0.
    struct Hop {
        address pool;
        bool zeroForOne;
    }

    error NotOwner();
    error NotMorpho();
    error NotExecuting();
    error Reentrancy();
    error BadRoute();
    error UnexpectedPool();
    error WrongDirection();
    error InsufficientProceeds(uint256 balance, uint256 repaid);
    error Unprofitable(uint256 profit, uint256 minProfit);
    error TransferFailed(address token, address to, uint256 amount, bool ok, bytes ret);
    error ApproveFailed(bytes ret);

    event Liquidated(
        address indexed borrower,
        address indexed loanToken,
        address indexed collateralToken,
        uint256 seizedCollateral,
        uint256 repaidAssets,
        uint256 profit
    );

    constructor(address morpho_, address owner_) {
        morpho = morpho_;
        owner = owner_ == address(0) ? msg.sender : owner_;
    }

    /**
     * Repay `repaidShares` of `borrower`'s debt (seizing the collateral Morpho
     * computes for it) and swap the seized collateral to the loan token through
     * `hops`. Reverts unless at least `minProfit` lands in this contract.
     *
     * Pass repaidShares = the position's full borrowShares for a full repay.
     * Owner-only: profit can only ever be withdrawn by `owner`, but a
     * permissionless entry would let a griefer pick a fee-skimming route.
     */
    function executeLiquidation(
        MarketParams calldata marketParams,
        address borrower,
        uint256 repaidShares,
        Hop[] calldata hops,
        uint256 minProfit
    ) external returns (uint256 seizedCollateral, uint256 repaidAssets, uint256 profit) {
        if (msg.sender != owner) revert NotOwner();
        if (executing) revert Reentrancy();
        executing = true;

        uint256 initial = IERC20(marketParams.loanToken).balanceOf(address(this));

        (seizedCollateral, repaidAssets) = IMorpho(morpho).liquidate(
            marketParams,
            borrower,
            0,
            repaidShares,
            abi.encode(hops, marketParams.collateralToken, marketParams.loanToken)
        );

        uint256 finalBalance = IERC20(marketParams.loanToken).balanceOf(address(this));
        // callback guaranteed finalBalance >= repaidAssets, so this cannot underflow
        profit = finalBalance - initial;
        executing = false;

        if (profit < minProfit) revert Unprofitable(profit, minProfit);

        emit Liquidated(
            borrower, marketParams.loanToken, marketParams.collateralToken, seizedCollateral, repaidAssets, profit
        );
    }

    /// @dev Morpho IMorphoLiquidateCallback — called with the collateral already
    /// received and BEFORE the repay is pulled from this contract.
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != morpho) revert NotMorpho();
        if (!executing) revert NotExecuting();

        (Hop[] memory hops, address collateralToken, address loanToken) =
            abi.decode(data, (Hop[], address, address));
        if (hops.length == 0) revert BadRoute();

        address expectedIn = collateralToken;
        for (uint256 i = 0; i < hops.length; i++) {
            address pool = hops[i].pool;
            bool zf1 = hops[i].zeroForOne;
            currentPool = pool;
            currentZeroForOne = zf1;

            IUniV3LikePool p = IUniV3LikePool(pool);
            address t0 = p.token0();
            address t1 = p.token1();
            address input = zf1 ? t0 : t1;
            address output = zf1 ? t1 : t0;

            // strict route continuity: next input == previous output, and we
            // never feed the loan token back in (would drain held profit)
            if (input != expectedIn || input == loanToken) revert BadRoute();

            uint256 amountIn = IERC20(input).balanceOf(address(this));
            if (amountIn == 0) revert BadRoute();

            // exact-in (positive amountSpecified in V3 core), no price limit
            // (final proceeds are checked below); limit must be strictly
            // inside [MIN_SQRT_RATIO, MAX_SQRT_RATIO]
            p.swap(
                address(this),
                zf1,
                int256(amountIn),
                zf1 ? 4295128740 : 1461446703485210103287273052203988822378723970341,
                ""
            );
            expectedIn = output;
        }
        if (expectedIn != loanToken) revert BadRoute();

        uint256 balance = IERC20(loanToken).balanceOf(address(this));
        if (balance < repaidAssets) revert InsufficientProceeds(balance, repaidAssets);

        // exact approve: Morpho pulls repaidAssets right after this callback
        (bool ok, bytes memory ret) = loanToken.call(abi.encodeCall(IERC20.approve, (morpho, repaidAssets)));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) revert ApproveFailed(ret);
    }

    /// @dev UniswapV3SwapCallback — pay the pool that is calling us.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (!executing) revert NotExecuting();
        if (msg.sender != currentPool) revert UnexpectedPool();

        bool zf1 = currentZeroForOne;
        // exact-in: we owe the input token (positive delta), receive the other
        if (zf1) {
            if (amount0Delta <= 0 || amount1Delta >= 0) revert WrongDirection();
            _safeTransfer(IUniV3LikePool(msg.sender).token0(), msg.sender, uint256(amount0Delta));
        } else {
            if (amount1Delta <= 0 || amount0Delta >= 0) revert WrongDirection();
            _safeTransfer(IUniV3LikePool(msg.sender).token1(), msg.sender, uint256(amount1Delta));
        }
    }

    /// @notice Sweep accumulated profit (loan token, or anything else) to owner.
    function withdraw(address token) external {
        if (msg.sender != owner) revert NotOwner();
        _safeTransfer(token, owner, IERC20(token).balanceOf(address(this)));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) {
            revert TransferFailed(token, to, amount, ok, ret);
        }
    }
}
