// What each AI call costs, from the tokens the API reports. Prices are USD per
// million tokens (Anthropic list prices, October 2026). Set AI_PRICES_JSON to
// override or add models, e.g. {"claude-opus-5-5":{"input":4,"output":20,"cacheRead":0.2}}.
// The amounts are an estimate for following spending; Anthropic's invoice is authoritative.

const DEFAULT = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5 costs more once a prompt passes 100K tokens
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, longInput: 0.5, longOutput: 2.5, longAbove: 100000 },
};

let prices = DEFAULT;
try {
  if (process.env.AI_PRICES_JSON) prices = { ...DEFAULT, ...JSON.parse(process.env.AI_PRICES_JSON) };
} catch {
  console.error('AI_PRICES_JSON is not valid JSON; using the built-in prices');
}

const priceFor = (model) => prices[model] || prices[Object.keys(prices).find((k) => model?.startsWith(k))] || null;

function costOfPart(p, u) {
  if (!p) return 0;
  const input = u.input_tokens || 0, output = u.output_tokens || 0;
  const write = u.cache_creation_input_tokens || 0, read = u.cache_read_input_tokens || 0;
  const long = p.longAbove && input + write + read > p.longAbove;
  const inP = long ? p.longInput : p.input, outP = long ? p.longOutput : p.output;
  // 5-minute cache writes cost 1.25x the input price
  return (input * inP + write * inP * 1.25 + read * (p.cacheRead ?? inP * 0.1) + output * outP) / 1e6;
}

/**
 * Cost of one response's usage block. When the API reports per-iteration usage
 * (for example a fallback to another model after a decline), each part is priced
 * at the model that produced it.
 */
export function costOf(usage, model) {
  if (!usage) return { cost: 0, known: true };
  const parts = (usage.iterations || []).filter((it) => it.type === 'message' || it.type === 'fallback_message');
  if (parts.length) {
    const known = parts.every((it) => priceFor(it.model || model));
    return { cost: parts.reduce((a, it) => a + costOfPart(priceFor(it.model || model), it), 0), known };
  }
  return { cost: costOfPart(priceFor(model), usage), known: !!priceFor(model) };
}
