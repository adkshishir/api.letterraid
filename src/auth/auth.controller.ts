import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './auth.guard.js';
import {
  AuthResponseDto,
  PlayerDto,
  RequestOtpDto,
  VerifyOtpDto,
  UpdateProfileDto,
} from './auth.types.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('request-otp')
  @ApiOperation({
    summary: 'Send a login/registration code to an email',
    description:
      'Always succeeds the same way whether or not the email is already ' +
      'registered — `isNewPlayer` in the response is how the client tells ' +
      'login and registration apart before showing an OTP screen. Rate ' +
      'limited to 3 requests per email per 10 minutes.',
  })
  requestOtp(
    @Body() dto: RequestOtpDto,
  ): Promise<{ message: string; isNewPlayer: boolean }> {
    return this.authService.requestOtp(dto.email);
  }

  @Post('verify-otp')
  @ApiOperation({
    summary: 'Verify a code and get a session token',
    description:
      '`displayName` is required only to create a brand-new account — pass ' +
      'it on registration, omit it on login. An existing player’s name is ' +
      'never changed here; that’s a deliberate PUT /auth/profile edit.',
  })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthResponseDto> {
    return this.authService.verifyOtp(dto.email, dto.code, dto.displayName);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'The caller’s own account' })
  getProfile(@Req() req: { player: { id: string } }): Promise<PlayerDto> {
    return this.authService.getProfile(req.player.id);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Rename the caller’s account' })
  updateProfile(
    @Req() req: { player: { id: string } },
    @Body() dto: UpdateProfileDto,
  ): Promise<PlayerDto> {
    return this.authService.updateProfile(req.player.id, dto.displayName);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Invalidate the caller’s current session token' })
  logout(
    @Req() req: { player: { id: string }; headers: { authorization: string } },
  ): Promise<void> {
    const token = req.headers.authorization?.slice(7) ?? '';
    return this.authService.logout(token);
  }
}
