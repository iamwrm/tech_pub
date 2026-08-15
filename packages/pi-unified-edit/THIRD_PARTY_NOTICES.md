# Third-party notices

## oh-my-pi hashline format

The `hash` mode's model-facing notation and explicit-line operation vocabulary
(`[path#TAG]`, numbered read rows, `PUT`, `CUT`, `REM`, and `MV`) are adapted
from the hashline tool in [oh-my-pi](https://github.com/can1357/oh-my-pi),
reviewed at commit `ffd53ff92a6f575d499730475a73460dd7cc2eea` (v17.3.4,
2026-08-14). The implementation in this package is an independent Node-native
planner integrated with pi-unified-edit's transaction layer; OMP's Bun-based
engine, tree-sitter `N*` block selection, registers, and stale-snapshot recovery
are not copied or bundled.

oh-my-pi is distributed under the MIT License:

> MIT License
>
> Copyright (c) 2025 Mario Zechner
> Copyright (c) 2025-2026 Can Bölük
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The original vendored `unified-edit.ts` provenance and Apache-2.0 license are
documented in `README.md` and `LICENSE`.
