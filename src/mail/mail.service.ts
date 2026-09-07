import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Sends real mail via Gmail SMTP when `MAIL_USERNAME`/`MAIL_PASSWORD` (a Gmail
 * App Password, not the account password) are set. Falls back to logging the
 * code server-side when they aren't — that's what keeps local dev working
 * without every developer needing a real mailbox.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;

  constructor() {
    const user = process.env.MAIL_USERNAME;
    const pass = process.env.MAIL_PASSWORD;

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
      });
    } else {
      this.transporter = null;
      this.logger.warn(
        'MAIL_USERNAME/MAIL_PASSWORD not set — OTP codes will only be logged, not emailed.',
      );
    }
  }

  async sendOtp(email: string, code: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[OTP] ${email} → ${code}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: `"LetterRaid" <${process.env.MAIL_USERNAME}>`,
        to: email,
        subject: `${code} is your LetterRaid code`,
        text: `Your LetterRaid verification code is ${code}. It expires in 5 minutes.`,
        html: `
          <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
            <h2 style="color: #7c3aed;">LetterRaid</h2>
            <p>Your verification code is:</p>
            <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</p>
            <p style="color: #666; font-size: 13px;">This code expires in 5 minutes. If you didn't request it, you can ignore this email.</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error(`Failed to send OTP email to ${email}`, err as Error);
      throw new ServiceUnavailableException(
        'Could not send the verification email. Try again in a moment.',
      );
    }
  }
}
