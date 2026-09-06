import { Controller, Post, Get, Put, Body, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './auth.guard.js';
import { RequestOtpDto, VerifyOtpDto, UpdateProfileDto } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('request-otp')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.email);
  }

  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.email, dto.code, dto.displayName);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@Req() req: { player: { id: string } }) {
    return this.authService.getProfile(req.player.id);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(
    @Req() req: { player: { id: string } },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(req.player.id, dto.displayName);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@Req() req: { player: { id: string }; headers: { authorization: string } }) {
    const token = req.headers.authorization?.slice(7) ?? '';
    return this.authService.logout(token);
  }
}
