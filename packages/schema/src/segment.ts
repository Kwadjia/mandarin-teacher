/**
 * Greedy longest-match segmentation against a known vocabulary.
 *
 * Deliberately not a general Chinese segmenter. The question this answers is not
 * "how does this sentence divide" but "can this sentence be built entirely from
 * words I have chosen to teach" — a stricter and more useful test, and the same
 * algorithm the Python pipeline uses to verify generated sentences
 * (docs/design.md §2.11).
 */

const PUNCTUATION = new Set('，。！？、：；“”‘’…—《》（）()【】,.!?:;\'" \n\t\r0123456789');

export interface Segmentation {
  tokens: string[];
  /** Characters not coverable by any known word. Empty means fully verified. */
  unknown: string[];
}

export function segment(text: string, vocabulary: Iterable<string>, maxWordLength = 4): Segmentation {
  const known = vocabulary instanceof Set ? vocabulary : new Set(vocabulary);
  const tokens: string[] = [];
  const unknown: string[] = [];

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (PUNCTUATION.has(ch)) {
      i++;
      continue;
    }
    let matched = false;
    for (let n = Math.min(maxWordLength, text.length - i); n > 0; n--) {
      const candidate = text.slice(i, i + n);
      if (known.has(candidate)) {
        tokens.push(candidate);
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      unknown.push(ch);
      i++;
    }
  }
  return { tokens, unknown };
}
