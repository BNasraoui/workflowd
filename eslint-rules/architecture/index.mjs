import noDoubleAssertionThroughUnknown from "./no-double-assertion-through-unknown.mjs"
import noTestContractReplacements from "./no-test-contract-replacements.mjs"
import noUnknownEffectChannels from "./no-unknown-effect-channels.mjs"

const rules = {
  "no-double-assertion-through-unknown": noDoubleAssertionThroughUnknown,
  "no-test-contract-replacements": noTestContractReplacements,
  "no-unknown-effect-channels": noUnknownEffectChannels,
}

export { rules }
export default { rules }
