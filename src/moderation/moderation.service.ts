import { Injectable } from '@nestjs/common';
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

/**
 * Shared text filtering for every game. Display names run through here today;
 * anything else a player types is expected to as well (one implementation, not
 * one per game).
 *
 * Heist is the deliberate exception: its dictionary has flagged words removed
 * at generation time instead, because a warning dialog inside a three-minute
 * race would cost the round it interrupted.
 *
 * Uses `obscenity` rather than a hand-rolled word list because it already
 * handles the obfuscations players actually try (leetspeak, padded characters,
 * unicode confusables). Hand-rolled lists catch the literal spelling only.
 */
@Injectable()
export class ModerationService {
  private readonly matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });

  /** True when the text contains profanity. */
  isProfane(text: string): boolean {
    if (!text) return false;
    return this.matcher.hasMatch(text);
  }

  /** True when every entry is clean. */
  areClean(texts: readonly string[]): boolean {
    return texts.every((text) => !this.isProfane(text));
  }

  /** Returns the first profane entry, or null when all are clean. */
  firstProfane(texts: readonly string[]): string | null {
    return texts.find((text) => this.isProfane(text)) ?? null;
  }
}
