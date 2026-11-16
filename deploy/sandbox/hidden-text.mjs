/**
 * The hidden characters of a sealed result's text: one rule for the daemon's check of a sealed
 * result (src/kernel/sealed-result.ts) and for the final message that a runner's harness gives
 * the seal. The seal has the same rule in Python (result.py invisible, without_presentation,
 * final_message); the tests of sealed-text-cases.ts compare the two.
 */

/**
 * The code points that a text shows to no reader but that a program reads: each format character
 * (Cf: the bidi controls, the joiners, the byte order mark and the tags among them) and each
 * default-ignorable code point (the variation selectors, the Hangul fillers and the reserved code
 * points of that property among them), as the body of a regular expression class.
 */
export const invisible = String.raw`\p{Cf}\p{Default_Ignorable_Code_Point}`

/**
 * U+FE0F where it selects the emoji form: directly after a code point with the Emoji property
 * that is not ASCII (so not after a digit, `#` or `*`). A commit message and a final message may
 * hold one there and nowhere else, so U+FE0F after a letter, after another U+FE0F or at the start
 * stays refused as each invisible code point is. A path holds no U+FE0F.
 */
// A capture and not a lookbehind: the engine of Bun 1.3 does not match a code point above
// U+FFFF with a property class in a lookbehind.
const emojiPresentation = new RegExp(String.raw`([\p{Emoji}--\p{ASCII}])️`, "gv")
const emoji = new RegExp(String.raw`^[\p{Emoji}--\p{ASCII}]$`, "v")

/** The text with each U+FE0F that selects the emoji form left out. */
export const withoutPresentation = (value) => value.replace(emojiPresentation, "$1")

/** The most UTF-8 bytes of a final message. */
export const finalMessageBytes = 64 * 1024

const refusedInFinalMessage = new RegExp(String.raw`(?![\n\t])[\p{Cc}${invisible}]`, "u")
const refusedCharacter = new RegExp(String.raw`^(?![\n\t])[\p{Cc}${invisible}]$`, "u")

/**
 * Whether the seal admits `value` as a final message: well formed, at most `finalMessageBytes`,
 * with newlines and tabs and no other control or invisible code point, but for U+FE0F where it
 * selects the emoji form.
 */
export const isFinalMessage = (value) =>
  value.isWellFormed() &&
  Buffer.byteLength(value, "utf8") <= finalMessageBytes &&
  !refusedInFinalMessage.test(withoutPresentation(value))

/**
 * The text that the seal admits as a final message: `text` without each code point that
 * `isFinalMessage` refuses, a lone surrogate as U+FFFD, cut to `finalMessageBytes` at a code
 * point.
 */
export const finalMessageText = (text) => {
  let kept = ""
  let bytes = 0
  let last = ""
  for (const character of text.toWellFormed()) {
    const admitted =
      character === "️" ? emoji.test(last) : !refusedCharacter.test(character)
    if (!admitted) continue
    bytes += Buffer.byteLength(character, "utf8")
    if (bytes > finalMessageBytes) break
    kept += character
    last = character
  }
  return kept
}
