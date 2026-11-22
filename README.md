# warm-cache

A Claude Code mod that keeps the 1-hour prompt cache warm while you take a break, but only when the conversation is big enough for that to pay off. By default that means a context of 40k tokens or more. In smaller conversations rewriting the cache is cheaper than keeping it alive, so the mod stays quiet.

## Credit

warm-cache is a reworked version of [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal. The idea, the ping mechanism and the price table are his work, and the original copyright notice is kept in [LICENSE](LICENSE). This fork is meant to make that idea cheaper to run.

What changed to save money:

- cache-tax keeps the cache warm in every conversation. warm-cache waits until the context reaches a threshold (40k tokens by default), because below that a fresh cache write costs less than the pings needed to avoid it.
- Pings in one break have a cost cap (half of a full rewrite by default). When the cap is reached, the cache is allowed to expire.
- When the context gets large (150k tokens by default), it suggests `/compact` or a new session, since every message pays to read the whole context.

## How it works

- After each turn it checks the thresholds (context size and, optionally, the number of your messages). Once they are met, it opens a keep-warm window, 2 hours after your last message by default.
- Inside the window, 50 minutes after the last request, it sends a cheap ping (a fork of the conversation with a short prompt). The ping reads the context from the cache instead of writing it again.
- Break budget: pings in one break may cost at most half of a full context rewrite (`pingFloor`). After that the cache is allowed to expire.
- When you send a message on a cold cache, it shows the cost (`guard: warn`) or asks first (`guard: ask`).
- From 150k tokens it suggests `/compact` or a new session, once per conversation (`compactHint`).
- After `/compact` the context is small, so pings stop until it grows again. `/clear` resets the message counter.
- Optional (`showLimits`): a second line with your 5-hour and weekly plan usage and time to reset, plus the session cost, and a toast at 80% and 95% of each window (once per window). Subscription only.

## Commands

- `/warm` or `/warm status`: state, thresholds, cost of a cold write and of a ping.
- `/warm off`: no pings in this conversation.
- `/warm on`: ping regardless of thresholds.
- `/warm auto`: back to thresholds.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `minTokens` | 40000 | Context size from which the mod pings and warns. 0 disables the condition. |
| `minMessages` | 0 | Number of your messages required before pinging. 0 disables the condition. |
| `windowHours` | 2 | How long after your last message the cache is kept warm (1–24). |
| `pingFloor` | 2 | Pings per break may cost at most 1/`pingFloor` of a context rewrite. 0 means no limit. |
| `compactHint` | 150000 | Context size that triggers the `/compact` hint. 0 disables it. |
| `guard` | `warn` | `warn`, `ask` or `off` for sending on a cold cache. |
| `display` | `band` | `band` (line above the prompt) or `status` (status line). |
| `showLimits` | `false` | Show plan limits (5h, 7d) with time to reset, session cost, and toasts at 80% / 95%. |

Requires the 1-hour cache, which is the default on a subscription. With an API key, set `promptCacheTtl` to `"1h"`.

## Install

```
/plugin marketplace add maciekr107/warm-cache
/plugin install warm-cache@warm-cache
```

Do not run it together with cache-tax, or both will ping.

## Tests

```
claude plugin test .
```

## License

MIT. The ping mechanism and the price table come from [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT). See [LICENSE](LICENSE).
