import { ModerationService } from './moderation.service';

describe('ModerationService', () => {
  let service: ModerationService;

  beforeEach(() => {
    service = new ModerationService();
  });

  it('passes ordinary game words through', () => {
    // These are the kind of words a real chain is made of — a filter that
    // flags any of them would make the game unplayable.
    expect(
      service.areClean(['cow', 'milk', 'cheese', 'sandwich', 'lunch']),
    ).toBe(true);
  });

  it('treats empty input as clean', () => {
    expect(service.isProfane('')).toBe(false);
  });

  it('flags profanity', () => {
    expect(service.isProfane('fuck')).toBe(true);
  });

  it('flags profanity obfuscated with leetspeak', () => {
    // The main reason for using a matcher over a plain word list.
    expect(service.isProfane('f0ck')).toBe(true);
  });

  it('flags profanity embedded in a longer phrase', () => {
    expect(service.isProfane('what the fuck is this')).toBe(true);
  });

  describe('firstProfane', () => {
    it('returns null when everything is clean', () => {
      expect(service.firstProfane(['cow', 'milk'])).toBeNull();
    });

    it('returns the offending entry so the caller can name it', () => {
      expect(service.firstProfane(['cow', 'shit', 'milk'])).toBe('shit');
    });
  });
});
