import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ModerationService } from '../moderation/moderation.service';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JwtService } from '@nestjs/jwt';
import type { MailService } from '../mail/mail.service.js';

/**
 * Covers `validateDisplayName`, added because neither `verifyOtp`'s
 * registration path nor `updateProfile` validated a name at all before this
 * — no global `ValidationPipe` is registered for this app, so the
 * `class-validator` decorators on `VerifyOtpDto`/`UpdateProfileDto` were pure
 * decoration. Same gap `RoomsService.validateDisplayName` already guards
 * against for room names.
 */
describe('AuthService display name validation', () => {
  let prisma: {
    player: { update: jest.Mock; create: jest.Mock; findUnique: jest.Mock };
    otpCode: { findFirst: jest.Mock; update: jest.Mock };
    session: { create: jest.Mock };
  };
  let service: AuthService;

  const PLAYER = { id: 'p1', email: 'ana@example.com', displayName: 'Ana' };

  beforeEach(() => {
    prisma = {
      player: {
        update: jest.fn().mockResolvedValue(PLAYER),
        create: jest.fn().mockResolvedValue(PLAYER),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      otpCode: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'otp1',
          email: PLAYER.email,
          code: '123456',
          used: false,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      session: { create: jest.fn().mockResolvedValue(undefined) },
    };

    const jwt = { sign: jest.fn().mockReturnValue('token') } as unknown as JwtService;
    const mail = {} as unknown as MailService;

    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt,
      mail,
      new ModerationService(),
    );
  });

  describe('updateProfile', () => {
    it('rejects an empty name', async () => {
      await expect(service.updateProfile('p1', '   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.player.update).not.toHaveBeenCalled();
    });

    it('rejects a name over 20 characters', async () => {
      await expect(
        service.updateProfile('p1', 'x'.repeat(21)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a profane name', async () => {
      await expect(service.updateProfile('p1', 'fuck')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('trims and saves a valid name', async () => {
      await service.updateProfile('p1', '  Ben  ');
      expect(prisma.player.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { displayName: 'Ben' },
      });
    });
  });

  describe('verifyOtp registration', () => {
    it('rejects a profane name at registration', async () => {
      await expect(
        service.verifyOtp(PLAYER.email, '123456', 'fuck'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.player.create).not.toHaveBeenCalled();
    });

    it('rejects an over-length name at registration', async () => {
      await expect(
        service.verifyOtp(PLAYER.email, '123456', 'x'.repeat(21)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the player with a trimmed valid name', async () => {
      await service.verifyOtp(PLAYER.email, '123456', '  Ben  ');
      expect(prisma.player.create).toHaveBeenCalledWith({
        data: { email: PLAYER.email, displayName: 'Ben' },
      });
    });

    it('falls back to the email prefix when no name is given (login path)', async () => {
      await service.verifyOtp(PLAYER.email, '123456', undefined);
      expect(prisma.player.create).toHaveBeenCalledWith({
        data: { email: PLAYER.email, displayName: 'ana' },
      });
    });
  });
});
