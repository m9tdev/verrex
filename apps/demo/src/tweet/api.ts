// TEMP (tweet material) — plumbing for TagSelective.vx, kept out of the
// screenshot on purpose: two tagged errors and a fake fetch that can fail
// with either.
import { Data, Effect } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}

export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfter: number
}> {}

const users: Record<string, string> = {
  "42": "Ada Lovelace",
  "7": "Grace Hopper",
}

export const lookup = (
  id: string,
): Effect.Effect<string, NotFound | RateLimited> =>
  Effect.gen(function* () {
    yield* Effect.sleep("600 millis")
    if (id === "503") return yield* new RateLimited({ retryAfter: 30 })
    const name = users[id]
    if (!name) return yield* new NotFound({ id })
    return name
  })
