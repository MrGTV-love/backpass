/**
 * Model family + tier resolution.
 *
 * A ladder rung names a *family* and an optional *tier* (`{ family: "gpt", tier: "sol" }`)
 * instead of a generation id. The generation itself is chosen at probe time from the
 * catalog the harness advertises, so a newer model in the same family/tier is picked up
 * without a backpass release. The catalog is authoritative: nothing here guesses what a
 * harness can serve.
 *
 * `parseModelId` splits an advertised id into the same pieces:
 * `provider/family-9.2-tier` -> family `family`, version `[9, 2]`, tier `tier`. A
 * provider prefix and any trailing `:effort` overlay are stripped first, then the
 * first numeric token is the version - tokens before it are the family, non-numeric
 * tokens after it are the tier.
 */

/** A version token: one or more dot-separated numbers (`6`, `6.1`, `5.6.3`). */
const VERSION_TOKEN = /^\d+(?:\.\d+)*$/;
/** A trailing ACP effort overlay such as `:medium`; not part of the model id. */
const EFFORT_SUFFIX = /:[a-z0-9._-]+$/i;

/** Drop a provider prefix (`openrouter/vendor/id`) and any `:effort` overlay. */
function bareId(raw) {
  let id = String(raw ?? "").trim();
  if (!id) return "";
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  return id.replace(EFFORT_SUFFIX, "");
}

/**
 * @param {string} raw an advertised or configured model id
 * @returns {{ family: string, tier: string, version: number[] | null } | null}
 */
export function parseModelId(raw) {
  const id = bareId(raw);
  if (!id) return null;
  const tokens = id.split("-").filter(Boolean);
  const at = tokens.findIndex((token) => VERSION_TOKEN.test(token));
  if (at === -1) {
    return { family: tokens.join("-").toLowerCase(), tier: "", version: null };
  }
  return {
    family: tokens.slice(0, at).join("-").toLowerCase(),
    tier: tokens
      .slice(at + 1)
      .filter((token) => !VERSION_TOKEN.test(token))
      .join("-")
      .toLowerCase(),
    version: tokens[at].split(".").map(Number),
  };
}

/** Compare dotted versions segment by segment; a missing version sorts below any real one. */
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * The newest advertised id in `family` (and `tier`, when named).
 *
 * Returns `null` when the catalog has nothing that fits - a missing family is a
 * model-unavailable verdict, never a guess or a fallback to a sibling tier. Ties on
 * version prefer the un-tiered id, so a `-fast` variant never wins over the base model
 * for a rung that named no tier.
 *
 * @param {string[]} advertised model ids as the harness spells them
 * @param {string} family
 * @param {string} [tier]
 * @returns {string | null}
 */
export function newestInFamily(advertised, family, tier) {
  const wantFamily = String(family ?? "")
    .trim()
    .toLowerCase();
  if (!wantFamily) return null;
  const wantTier = String(tier ?? "")
    .trim()
    .toLowerCase();
  let best = null;
  let bestVersion = null;
  let bestExactTier = false;
  for (const id of advertised || []) {
    const parsed = parseModelId(id);
    if (!parsed || parsed.family !== wantFamily) continue;
    if (wantTier && parsed.tier !== wantTier) continue;
    const exactTier = parsed.tier === "";
    const cmp = compareVersions(parsed.version, bestVersion);
    if (cmp > 0 || (cmp === 0 && exactTier && !bestExactTier)) {
      best = id;
      bestVersion = parsed.version;
      bestExactTier = exactTier;
    }
  }
  return best;
}
