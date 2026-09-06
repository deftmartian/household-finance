# Contributing

Use synthetic data and follow [AGENTS.md](AGENTS.md). Run `pnpm verify` and the container check before proposing runtime changes. Tests should prove household outcomes, data preservation, failure recovery, or permission boundaries.

Keep private infrastructure and credentials out of this repository. A deployment uses one image tagged by its complete source revision; publishing does not automatically activate it. Changes to Actual's pinned API/server version require a fresh write/readback and conversion rehearsal.
