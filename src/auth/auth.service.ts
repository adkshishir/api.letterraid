import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import type { Player } from '@prisma/client';

const OTP_EXPIRY_MINUTES = 5;
const OTP_LENGTH = 6;
const OTP_RATE_LIMIT = 3;
const OTP_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  async requestOtp(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase().trim();

    // Rate limit: max 3 OTP requests per email per 10 minutes
    const recentCount = await this.prisma.otpCode.count({
      where: {
        email: normalized,
        createdAt: { gte: new Date(Date.now() - OTP_RATE_WINDOW_MS) },
      },
    });
    if (recentCount >= OTP_RATE_LIMIT) {
      throw new ConflictException('Too many requests. Try again later.');
    }

    // Generate OTP
    const code = this.generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await this.prisma.otpCode.create({
      data: { email: normalized, code, expiresAt },
    });

    await this.mail.sendOtp(normalized, code);

    return { message: 'OTP sent to your email' };
  }

  async verifyOtp(
    email: string,
    code: string,
    displayName: string,
  ): Promise<{ token: string; player: Player }> {
    const normalized = email.toLowerCase().trim();

    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        email: normalized,
        code,
        used: false,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new UnauthorizedException('Invalid or expired OTP code');
    }

    // Mark OTP as used
    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { used: true },
    });

    // Find or create player
    let player = await this.prisma.player.findUnique({
      where: { email: normalized },
    });

    if (!player) {
      player = await this.prisma.player.create({
        data: {
          email: normalized,
          displayName: displayName.trim() || normalized.split('@')[0],
        },
      });
    } else if (
      displayName.trim() &&
      displayName.trim() !== player.displayName
    ) {
      player = await this.prisma.player.update({
        where: { id: player.id },
        data: { displayName: displayName.trim() },
      });
    }

    // Create session
    const token = this.jwt.sign({ sub: player.id, email: player.email });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.prisma.session.create({
      data: { playerId: player.id, token, expiresAt },
    });

    return { token, player };
  }

  async validateToken(token: string): Promise<Player> {
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      const player = await this.prisma.player.findUnique({
        where: { id: payload.sub },
      });
      if (!player) throw new UnauthorizedException('Player not found');
      return player;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  async getProfile(playerId: string): Promise<Player> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
    });
    if (!player) throw new UnauthorizedException('Player not found');
    return player;
  }

  async updateProfile(playerId: string, displayName: string): Promise<Player> {
    return this.prisma.player.update({
      where: { id: playerId },
      data: { displayName: displayName.trim() },
    });
  }

  async logout(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { token } });
  }

  private generateOtp(): string {
    const digits = '0123456789';
    let code = '';
    for (let i = 0; i < OTP_LENGTH; i++) {
      code += digits[Math.floor(Math.random() * digits.length)];
    }
    return code;
  }
}
