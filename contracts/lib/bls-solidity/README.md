# Vendored: randa-mu/bls-solidity

- Upstream: https://github.com/randa-mu/bls-solidity
- Commit: `11af179a8287d978659aae07adb66aa60f64b8a6` ("bump EVM version to Osaka (#25)")
- License: MIT (see `LICENSE`, Copyright (c) 2025 Randamu)
- Files copied verbatim: `src/libraries/BLS2.sol`, `src/libraries/Precompiles.sol`

ArcDraw uses `BLS2` to verify drand quicknet (BLS12-381 G1, RFC 9380) signatures
through the EIP-2537 precompiles available on Arc. All credit for the BLS
implementation goes to Randamu. The library is unaudited; treat ArcDraw as experimental.

Do not edit these files. To upgrade, re-copy from a newer upstream commit and update this README.
