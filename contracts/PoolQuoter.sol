// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PoolQuoter — execution-exact exit quotes for V3-style pools
/// @notice Used ONLY via eth_call with state overrides (never deployed).
///   The bot injects this runtime code at a scratch address and calls
///   quoteBatch(). Every quote is the same pool.swap() call the liquidator
///   would make, so proceeds are execution-exact — depth models are not:
///   pool.liquidity() x wide-range math overstates V3 books that actually
///   concentrate liquidity in narrow tick bands (measured: cbETH pools hold
///   their "$9.4M depth" inside a ~5-tick band).
///
///   The pool pays output to `recipient` and asks msg.sender for the input
///   via uniswapV3SwapCallback. We hold no tokens, so the callback reverts
///   with this swap's raw deltas; quoteBatch() catches that revert and reads
///   them. Nothing persists — every sub-call reverts inside the eth_call.
///
///   Aerodrome slipstream (CL) pools are Uniswap-V3 forks and quote through
///   the same interface. Aerodrome V2 pairs have no callback and are quoted
///   locally from reserves (constant-product math is exact given reserves).
interface IUniswapV3PoolLike {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract PoolQuoter {
    /// @dev Revert payload carrying the pool's swap deltas (4-byte selector + two words).
    error Deltas(int256 amount0Delta, int256 amount1Delta);
    /// @dev A callback from anything other than the pool being quoted.
    error NotPool();

    struct Quote {
        address pool;
        bool zeroForOne;
        uint256 amountIn;
    }

    /// @dev Uniswap V3 swap callback. Reverts with this swap's deltas so the
    ///   outer try/catch can read them without ever holding tokens. `data`
    ///   carries the pool address we quoted (passed through swap's data arg)
    ///   so a foreign caller cannot spoof deltas here.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external view {
        if (data.length != 20) revert NotPool();
        address pool;
        assembly {
            // Calldata words are left-aligned: the 20-byte address sits in the
            // HIGH bytes followed by padding. An `address` variable is
            // right-aligned, so shift down by 12 bytes before comparing.
            pool := shr(96, calldataload(data.offset))
        }
        if (msg.sender != pool) revert NotPool();
        revert Deltas(amount0Delta, amount1Delta);
    }

    /// @notice Exact-in swap simulation for each quote, in order.
    /// @return consumed Input tokens actually taken (less than amountIn when
    ///   the book ran dry first — the honest capacity cap).
    /// @return received Output tokens this contract would hold afterwards.
    function quoteBatch(Quote[] calldata quotes)
        external
        returns (uint256[] memory consumed, uint256[] memory received)
    {
        uint256 n = quotes.length;
        consumed = new uint256[](n);
        received = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            Quote calldata q = quotes[i];

            // sqrtPriceLimitX96 must sit STRICTLY inside
            // [MIN_SQRT_RATIO=4295128739, MAX_SQRT_RATIO=1461446703485210103287273052203988822378723970342].
            // With the limit at the boundary the pool swaps until the input is
            // exhausted OR liquidity is — exactly how the liquidator swaps.
            try IUniswapV3PoolLike(q.pool).swap(
                address(this),
                q.zeroForOne,
                int256(q.amountIn),
                q.zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
                abi.encodePacked(q.pool)
            ) returns (int256, int256) {
                // Completed with zero deltas (amountIn == 0): nothing traded.
            } catch (bytes memory reason) {
                if (reason.length != 68) continue; // pool reverted pre-callback: no quote
                bytes4 sel;
                int256 a0;
                int256 a1;
                assembly {
                    sel := mload(add(reason, 32))
                    a0 := mload(add(reason, 36))
                    a1 := mload(add(reason, 68))
                }
                if (sel != Deltas.selector) continue;
                // Pool-delta signs: > 0 = owed TO the pool (input), < 0 = owed
                // to us (output). Direction decides which word is which leg.
                if (q.zeroForOne) {
                    if (a0 > 0) consumed[i] = uint256(a0);
                    if (a1 < 0) received[i] = uint256(-a1);
                } else {
                    if (a1 > 0) consumed[i] = uint256(a1);
                    if (a0 < 0) received[i] = uint256(-a0);
                }
            }
        }
    }
}
